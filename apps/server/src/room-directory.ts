/**
 * RoomDirectory — the one list of public rooms.
 *
 * A single Durable Object (`idFromName(DIRECTORY_NAME)`) that the room browser
 * reads and every public `GameRoom` writes to. It owns no game and no sockets;
 * it is a small SQLite table of "room ABCD, hosted by Alice, 3 of 8 seats, still
 * in the lobby".
 *
 * Two ways a row gets written, and the listing is only trustworthy because it
 * has both:
 *
 *  - PUSH. A room reports whenever its listing changes — somebody sat down, the
 *    host flipped the switch, the match started. That is what makes a new room
 *    appear in the browser at once. Reports carry a `version` the room bumps on
 *    every change, and an older version never overwrites a newer one: two
 *    reports that left a room a moment apart can arrive in either order, and
 *    "last to arrive wins" would leave a room listed that had just closed.
 *
 *  - PULL. A push can be lost — the room is evicted mid-request, a deploy
 *    restarts it without delivering a single `webSocketClose` — and a lost
 *    "nobody is here any more" is a stranger clicking Join on a room that is
 *    not there. So a row that has not been confirmed for `LISTING_RECHECK_MS` is
 *    re-asked from the room itself before it is served. The room answers from
 *    the sockets it is actually holding, which is the one thing a crash cannot
 *    leave stale.
 *
 * Nothing here runs on a clock. The re-check happens when somebody opens the
 * browser, so a directory nobody is reading costs nothing — the same property
 * hibernation buys the rooms.
 *
 * A room that leaves the list becomes a tombstone (entry NULL, version kept)
 * rather than a deleted row, because the version is the only thing that can
 * refuse a late report of the room's previous state.
 */

import {
  MAX_PUBLIC_ROOMS_LISTED,
  PublicRoomSchema,
  RoomCodeSchema,
  type PublicRoom,
  type PublicRoomList,
} from '@scorched/protocol';
import { z } from 'zod';

export const DIRECTORY_NAME = 'public-rooms';

/** How long a listed room is believed without asking it again. */
export const LISTING_RECHECK_MS = 30_000;

/**
 * How long a room that will not answer stays on the list.
 *
 * A failed re-check does NOT delist a room, and that is deliberate: the room's
 * own record says it is listed, so a room the directory dropped over one
 * transient failure would never report itself again — nothing, as far as the
 * room could tell, had changed. Instead the row stays and is simply not SERVED
 * once it has gone this long unconfirmed; the next successful re-check brings
 * it straight back.
 */
export const MAX_UNCONFIRMED_MS = 2 * 60_000;

/**
 * Rooms re-asked per listing request. Bounds the fan-out one page load can
 * cause; anything left over is re-asked by the next request, oldest first.
 */
export const MAX_RECHECKS_PER_LIST = 16;

/**
 * Rooms the directory will hold at once.
 *
 * Creating a room is unauthenticated, so without a cap the table is as large as
 * somebody with a script wants it to be. Each listing already costs its author
 * a live socket — a room with nobody connected is never listed — which is what
 * makes a cap this generous safe. Past it, new rooms are simply not listed;
 * they still work by code.
 */
export const MAX_LISTED_ROOMS = 500;

/** How long a delisted room's version is remembered, to refuse its late reports. */
const TOMBSTONE_TTL_MS = 10 * 60_000;

/** What a room says about itself: its listing, and which change of it this is. */
export const ListingSchema = z.object({
  version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  entry: PublicRoomSchema.nullable(),
});
export type Listing = z.infer<typeof ListingSchema>;

const ReportSchema = ListingSchema.extend({ roomCode: RoomCodeSchema }).refine(
  (report) => report.entry === null || report.entry.roomCode === report.roomCode,
  'A room may only report its own listing',
);
export type ListingReport = z.infer<typeof ReportSchema>;

export function directoryStub(env: Env): DurableObjectStub {
  return env.ROOM_DIRECTORY.get(
    env.ROOM_DIRECTORY.idFromName(DIRECTORY_NAME),
  ) as unknown as DurableObjectStub;
}

export class RoomDirectory implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly env: Env;
  /**
   * The listing being built right now, shared with everybody who asks while it
   * runs. In memory on purpose, like the rooms' rate-limit buckets: losing it to
   * an eviction costs one extra read, and an eviction can only happen when
   * nobody is asking.
   */
  private inFlight: Promise<PublicRoom[]> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.sql = ctx.storage.sql;
    this.env = env;
    // `checked_at` is the last time anybody ASKED; `confirmed_at` the last time
    // the room ANSWERED. Re-checks are scheduled by the first and served by the
    // second, so a room that keeps failing cannot hog the re-check budget and
    // cannot stay on screen either.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        code TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        entry TEXT,
        checked_at INTEGER NOT NULL,
        confirmed_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * Not reachable from the outside except through the Worker's
   * `GET /api/rooms/public`, which forwards `/list` only. `/report` is called by
   * `GameRoom` alone.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/report' && request.method === 'POST') {
      const parsed = ReportSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return new Response('Bad listing report', { status: 400 });
      const { roomCode, version, entry } = parsed.data;
      return Response.json({ applied: this.apply(roomCode, { version, entry }, Date.now()) });
    }

    if (url.pathname === '/list' && request.method === 'GET') {
      const body: PublicRoomList = { rooms: await this.list() };
      return Response.json(body);
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Record a listing unless a newer one is already here. Returns whether it was.
   *
   * `>=` rather than `>`: the pull path re-reads a version the room already
   * pushed, and confirming it is exactly what should refresh the timestamps.
   */
  private apply(roomCode: string, listing: Listing, now: number): boolean {
    if (
      listing.entry !== null &&
      !this.isListed(roomCode) &&
      this.countListed() >= MAX_LISTED_ROOMS
    ) {
      return false;
    }
    const cursor = this.sql.exec(
      `INSERT INTO listings (code, version, entry, checked_at, confirmed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         version = excluded.version,
         entry = excluded.entry,
         checked_at = excluded.checked_at,
         confirmed_at = excluded.confirmed_at
       WHERE excluded.version >= listings.version`,
      roomCode,
      listing.version,
      listing.entry === null ? null : JSON.stringify(listing.entry),
      now,
      now,
    );
    return cursor.rowsWritten > 0;
  }

  /**
   * One listing at a time.
   *
   * Every title screen polls this, so several reads arrive together — and a read
   * is not a quick lookup: it runs SQL, asks rooms it has stopped trusting, then
   * runs more SQL. Sharing one answer means one re-check fan-out instead of one
   * per reader, and it keeps two reads from interleaving their queries around
   * those awaits. The answer they share is at most seconds old, which is all any
   * of them was going to get anyway.
   */
  private list(): Promise<PublicRoom[]> {
    if (this.inFlight !== null) return this.inFlight;
    const running = this.readAndRecheck().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = running;
    return running;
  }

  private async readAndRecheck(): Promise<PublicRoom[]> {
    const now = Date.now();
    // Consumed immediately, here and everywhere below: an unread cursor is a
    // query still in flight, and the next statement can find the database locked.
    this.sql
      .exec('DELETE FROM listings WHERE entry IS NULL AND checked_at < ?', now - TOMBSTONE_TTL_MS)
      .toArray();

    const stale = this.sql
      .exec<{ code: string }>(
        `SELECT code FROM listings
         WHERE entry IS NOT NULL AND checked_at < ?
         ORDER BY checked_at LIMIT ?`,
        now - LISTING_RECHECK_MS,
        MAX_RECHECKS_PER_LIST,
      )
      .toArray();
    await Promise.all(stale.map(({ code }) => this.recheck(code, now)));

    const rooms: PublicRoom[] = [];
    const rows = this.sql
      .exec<{ entry: string }>(
        'SELECT entry FROM listings WHERE entry IS NOT NULL AND confirmed_at >= ?',
        now - MAX_UNCONFIRMED_MS,
      )
      .toArray();
    for (const row of rows) {
      const parsed = PublicRoomSchema.safeParse(parseJson(row.entry));
      if (parsed.success) rooms.push(parsed.data);
    }
    return rooms.sort(byJoinability).slice(0, MAX_PUBLIC_ROOMS_LISTED);
  }

  /** Ask a room what it is, and believe the answer. */
  private async recheck(roomCode: string, now: number): Promise<void> {
    let listing: Listing | null = null;
    try {
      const room = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(roomCode));
      const response = await room.fetch(new Request(`https://room/listing?room=${roomCode}`));
      const parsed = ListingSchema.safeParse(await response.json());
      if (response.ok && parsed.success) listing = parsed.data;
    } catch (error) {
      console.error('RoomDirectory could not re-check a room', roomCode, error);
    }

    // Asked, not answered. See `MAX_UNCONFIRMED_MS` for why the row stays.
    //
    // The same line covers a room whose answer was refused as stale: either way
    // it HAS been asked, and without saying so the row keeps its old
    // `checked_at` and is re-asked by every single poll from then on.
    if (listing === null || !this.apply(roomCode, listing, now)) {
      this.sql.exec('UPDATE listings SET checked_at = ? WHERE code = ?', now, roomCode).toArray();
    }
  }

  private isListed(roomCode: string): boolean {
    return (
      this.sql
        .exec('SELECT 1 FROM listings WHERE code = ? AND entry IS NOT NULL', roomCode)
        .toArray().length > 0
    );
  }

  private countListed(): number {
    const row = this.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM listings WHERE entry IS NOT NULL')
      .toArray()[0];
    return row?.n ?? 0;
  }
}

/**
 * The order a browser shows rooms in: somewhere you can sit down first, then
 * the ones with the most people in them, then matches already under way that
 * you can only watch. Room code last, so two refreshes of an unchanged list do
 * not shuffle it.
 */
export function byJoinability(a: PublicRoom, b: PublicRoom): number {
  const rank = (room: PublicRoom): number =>
    room.status === 'lobby' ? (room.players < room.maxPlayers ? 0 : 1) : 2;
  return (
    rank(a) - rank(b) ||
    b.players - b.bots - (a.players - a.bots) ||
    b.players - a.players ||
    a.roomCode.localeCompare(b.roomCode)
  );
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
