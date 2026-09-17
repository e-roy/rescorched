/**
 * Public rooms: the directory, and every way a room gets on and off it.
 *
 * In-workerd like the rest of the server suite. The directory is ONE Durable
 * Object shared by every test in this file, so no assertion here is about the
 * whole list — each test creates its own rooms and looks only for their codes.
 *
 * Rooms report to the directory after they have answered the socket, so
 * nothing a test reads from the list is in step with the frame it just
 * received. `eventually` polls; a listing that never arrives fails by name.
 */

import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  parseServerMessage,
  PROTOCOL_VERSION,
  PublicRoomListSchema,
  type PublicRoom,
  type ServerMessage,
} from '@scorched/protocol';

import worker from '../src/index.ts';
import {
  byJoinability,
  DIRECTORY_NAME,
  LISTING_RECHECK_MS,
  MAX_UNCONFIRMED_MS,
} from '../src/room-directory.ts';

const BASE = 'http://example.com';

interface Connection {
  frames: ServerMessage[];
  send(message: unknown): void;
  next(predicate: (message: ServerMessage) => boolean, from?: number): Promise<ServerMessage>;
  close(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function directory(): DurableObjectStub {
  return env.ROOM_DIRECTORY.get(
    env.ROOM_DIRECTORY.idFromName(DIRECTORY_NAME),
  ) as unknown as DurableObjectStub;
}

function roomStub(roomCode: string): DurableObjectStub {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomCode)) as unknown as DurableObjectStub;
}

async function postRoom(body?: string): Promise<Response> {
  return worker.fetch(
    new Request(`${BASE}/api/rooms`, { method: 'POST', ...(body === undefined ? {} : { body }) }),
    env,
  );
}

async function createRoom(visibility: 'public' | 'private'): Promise<string> {
  const response = await postRoom(JSON.stringify({ visibility }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { roomCode: string }).roomCode;
}

async function roomInfo(roomCode: string): Promise<{ visibility: string; players: number }> {
  const response = await worker.fetch(new Request(`${BASE}/api/rooms/${roomCode}/info`), env);
  return (await response.json()) as { visibility: string; players: number };
}

/** Open a socket, say hello, and wait to be welcomed. */
async function connect(roomCode: string, name: string): Promise<Connection> {
  const response = await worker.fetch(
    new Request(`${BASE}/api/rooms/${roomCode}/ws`, { headers: { Upgrade: 'websocket' } }),
    env,
  );
  const socket = response.webSocket;
  if (!socket) throw new Error('Server did not return a WebSocket');
  socket.accept();

  const frames: ServerMessage[] = [];
  socket.addEventListener('message', (event) => {
    const parsed = parseServerMessage(typeof event.data === 'string' ? event.data : '');
    expect(parsed.ok, 'server sent an invalid frame').toBe(true);
    if (parsed.ok) frames.push(parsed.value);
  });

  const connection: Connection = {
    frames,
    send: (message) => socket.send(JSON.stringify(message)),
    async next(predicate, from = 0) {
      for (let attempt = 0; attempt < 250; attempt += 1) {
        const found = frames.slice(from).find(predicate);
        if (found !== undefined) return found;
        await sleep(20);
      }
      throw new Error('Timed out waiting for a frame');
    },
    close: () => socket.close(),
  };

  connection.send({ t: 'hello', protocol: PROTOCOL_VERSION, name });
  const welcome = await connection.next((m) => m.t === 'welcome' || m.t === 'error');
  expect(welcome.t).toBe('welcome');
  return connection;
}

async function listPublic(): Promise<PublicRoom[]> {
  const response = await worker.fetch(new Request(`${BASE}/api/rooms/public`), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return PublicRoomListSchema.parse(await response.json()).rooms;
}

async function listed(roomCode: string): Promise<PublicRoom | undefined> {
  return (await listPublic()).find((room) => room.roomCode === roomCode);
}

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  what: string,
): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    last = await read();
    if (accept(last)) return last;
    await sleep(20);
  }
  throw new Error(`Never saw ${what}; last read ${JSON.stringify(last)}`);
}

/** Make the directory's row for a room look `ageMs` old, as if nobody had asked in that long. */
async function ageRow(roomCode: string, ageMs: number, patch: string = ''): Promise<void> {
  await runInDurableObject(directory(), (_instance, state) => {
    const then = Date.now() - ageMs;
    state.storage.sql.exec(
      `UPDATE listings SET checked_at = ?, confirmed_at = ? ${patch} WHERE code = ?`,
      then,
      then,
      roomCode,
    );
  });
}

async function report(body: unknown): Promise<Response> {
  return directory().fetch(
    new Request('https://directory/report', { method: 'POST', body: JSON.stringify(body) }),
  );
}

describe('creating a room', () => {
  it('makes a private room from no body at all, and a public one when asked', async () => {
    // No body is what every client before the browser sent. It must still work.
    const plain = await postRoom();
    expect(plain.status).toBe(200);
    const { roomCode } = (await plain.json()) as { roomCode: string };
    expect((await roomInfo(roomCode)).visibility).toBe('private');

    expect((await roomInfo(await createRoom('public'))).visibility).toBe('public');
  });

  it('refuses a body it does not understand rather than guessing', async () => {
    expect((await postRoom('{"visibility":"everyone"}')).status).toBe(400);
    expect((await postRoom('not json')).status).toBe(400);
    expect(
      (await postRoom(JSON.stringify({ visibility: 'public', pad: 'x'.repeat(4096) }))).status,
    ).toBe(413);
  });
});

describe('the public room list', () => {
  it('lists a public room once a person is in it, and never a private one', async () => {
    const hidden = await createRoom('private');
    const shown = await createRoom('public');

    // Created but empty: nothing to walk into, so nothing to list.
    expect(await listed(shown)).toBeUndefined();

    const carol = await connect(hidden, 'Carol');
    const alice = await connect(shown, 'Alice');

    const entry = await eventually(
      () => listed(shown),
      (room) => room !== undefined,
      'the public room listed',
    );
    expect(entry).toMatchObject({
      roomCode: shown,
      hostName: 'Alice',
      players: 1,
      bots: 0,
      status: 'lobby',
    });
    expect(await listed(hidden)).toBeUndefined();

    carol.close();
    alice.close();
  });

  it('follows the room: seats, computer players, and a match starting', async () => {
    const code = await createRoom('public');
    const host = await connect(code, 'Host');
    const guest = await connect(code, 'Guest');
    await eventually(
      () => listed(code),
      (room) => room?.players === 2,
      'two seats listed',
    );

    host.send({ t: 'addBot', personality: 'moron' });
    await eventually(
      () => listed(code),
      (room) => room?.players === 3 && room.bots === 1,
      'the computer player counted',
    );

    host.send({ t: 'start' });
    await eventually(
      () => listed(code),
      (room) => room?.status === 'playing',
      'the room marked as in play',
    );

    host.close();
    guest.close();
  });

  it('takes a room off the list when its last person leaves', async () => {
    const code = await createRoom('public');
    const alice = await connect(code, 'Alice');
    await eventually(
      () => listed(code),
      (room) => room !== undefined,
      'the room listed',
    );

    alice.close();
    await eventually(
      () => listed(code),
      (room) => room === undefined,
      'the room delisted',
    );
  });

  it('hands the listing to whoever is left when the host walks out', async () => {
    const code = await createRoom('public');
    const host = await connect(code, 'Host');
    const guest = await connect(code, 'Guest');
    await eventually(
      () => listed(code),
      (room) => room?.players === 2,
      'both seats listed',
    );

    host.close();
    const after = await eventually(
      () => listed(code),
      (room) => room?.players === 1,
      'the room listed under its new host',
    );
    expect(after?.hostName).toBe('Guest');

    guest.close();
  });
});

describe('who can change it', () => {
  it('lets only the host flip a room between public and private', async () => {
    const code = await createRoom('public');
    const host = await connect(code, 'Host');
    const guest = await connect(code, 'Guest');
    await eventually(
      () => listed(code),
      (room) => room?.players === 2,
      'both seats listed',
    );

    // Everybody in the room is told what it is.
    const lobby = await guest.next((m) => m.t === 'lobby' && m.players.length === 2);
    expect(lobby.t === 'lobby' && lobby.visibility).toBe('public');

    const guestMark = guest.frames.length;
    guest.send({ t: 'setVisibility', visibility: 'private' });
    const refusal = await guest.next((m) => m.t === 'error', guestMark);
    expect(refusal.t === 'error' && refusal.code).toBe('not_host');
    expect((await roomInfo(code)).visibility).toBe('public');

    const hostMark = host.frames.length;
    host.send({ t: 'setVisibility', visibility: 'private' });
    await host.next((m) => m.t === 'lobby' && m.visibility === 'private', hostMark);
    await eventually(
      () => listed(code),
      (room) => room === undefined,
      'the room delisted',
    );

    host.send({ t: 'setVisibility', visibility: 'public' });
    await eventually(
      () => listed(code),
      (room) => room !== undefined,
      'the room relisted',
    );

    host.close();
    guest.close();
  });
});

describe('the directory does not believe a room forever', () => {
  it('asks a room it has not heard from, and believes the room over its own row', async () => {
    /*
     * The failure this exists for: the push that said "nobody is here any more"
     * never arrived — a deploy restarted the room, an eviction ate the request.
     * Staged by letting the departure land and then putting the row back the
     * way it looked before, a version behind and just old enough to be doubted.
     */
    const code = await createRoom('public');
    const alice = await connect(code, 'Alice');
    const before = await eventually(
      () => listed(code),
      (room) => room !== undefined,
      'listed',
    );
    alice.close();
    await eventually(
      () => listed(code),
      (room) => room === undefined,
      'delisted',
    );

    await runInDurableObject(directory(), (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE listings SET entry = ?, version = version - 1 WHERE code = ?',
        JSON.stringify(before),
        code,
      );
    });
    // Still inside `MAX_UNCONFIRMED_MS`, so only the re-check can take it away.
    await ageRow(code, LISTING_RECHECK_MS + 1_000);

    expect(await listed(code)).toBeUndefined();
  });

  it('keeps a live room listed through a re-check', async () => {
    const code = await createRoom('public');
    const alice = await connect(code, 'Alice');
    await eventually(
      () => listed(code),
      (room) => room !== undefined,
      'listed',
    );

    await ageRow(code, LISTING_RECHECK_MS + 1_000);
    expect(await listed(code)).toMatchObject({ roomCode: code, hostName: 'Alice' });

    // …and the re-check counted as hearing from it, so it is not re-asked at once.
    const checkedAt = await runInDurableObject(directory(), (_instance, state) => {
      const row = state.storage.sql
        .exec<{ checked_at: number }>('SELECT checked_at FROM listings WHERE code = ?', code)
        .toArray()[0];
      return row?.checked_at ?? 0;
    });
    expect(Date.now() - checkedAt).toBeLessThan(LISTING_RECHECK_MS);

    alice.close();
  });

  it('stops serving a row nobody has confirmed in too long', async () => {
    // A room that answered nothing for minutes is not a room to send people to,
    // whatever its row says. Aged past the re-check window too, so this is the
    // served-rows filter being tested and not the re-check.
    const code = await createRoom('public');
    const alice = await connect(code, 'Alice');
    await eventually(
      () => listed(code),
      (room) => room !== undefined,
      'listed',
    );
    alice.close();
    await eventually(
      () => listed(code),
      (room) => room === undefined,
      'delisted',
    );

    // A forged row for a room code nobody holds, pinned so a re-check cannot run:
    // checked just now, confirmed long ago.
    const ghost = 'ZQZQ';
    expect(
      (
        await report({
          roomCode: ghost,
          version: 1,
          entry: {
            roomCode: ghost,
            hostName: 'Ghost',
            players: 1,
            bots: 0,
            maxPlayers: 8,
            status: 'lobby',
          },
        })
      ).status,
    ).toBe(200);
    expect(await listed(ghost)).toBeDefined();

    await runInDurableObject(directory(), (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE listings SET checked_at = ?, confirmed_at = ? WHERE code = ?',
        Date.now(),
        Date.now() - MAX_UNCONFIRMED_MS - 1_000,
        ghost,
      );
    });
    expect(await listed(ghost)).toBeUndefined();
  });
});

describe('reports', () => {
  it('refuses a report older than the one it already holds', async () => {
    /*
     * Two reports from one room can cross in flight. If "last to arrive wins",
     * a room that filled up and then emptied can end on "full" forever.
     */
    const code = 'ZQZR';
    const entry = {
      roomCode: code,
      hostName: 'Late',
      players: 2,
      bots: 0,
      maxPlayers: 8,
      status: 'lobby',
    };

    const newer = await report({ roomCode: code, version: 5, entry });
    expect(await newer.json()).toEqual({ applied: true });
    const older = await report({ roomCode: code, version: 4, entry: null });
    expect(await older.json()).toEqual({ applied: false });
    expect(await listed(code)).toMatchObject({ hostName: 'Late' });

    const newest = await report({ roomCode: code, version: 6, entry: null });
    expect(await newest.json()).toEqual({ applied: true });
    expect(await listed(code)).toBeUndefined();
  });

  it('will not let one room report another room', async () => {
    const response = await report({
      roomCode: 'ZQZS',
      version: 1,
      entry: {
        roomCode: 'ZQZT',
        hostName: 'Imp',
        players: 1,
        bots: 0,
        maxPlayers: 8,
        status: 'lobby',
      },
    });
    expect(response.status).toBe(400);
  });
});

describe('the order a browser shows rooms in', () => {
  it('puts a seat you can take first and a match you can only watch last', () => {
    const room = (overrides: Partial<PublicRoom>): PublicRoom => ({
      roomCode: 'AAAA',
      hostName: 'Host',
      players: 1,
      bots: 0,
      maxPlayers: 8,
      status: 'lobby',
      ...overrides,
    });
    const playing = room({ roomCode: 'PLAY', status: 'playing', players: 2 });
    const full = room({ roomCode: 'FULL', players: 8 });
    const quiet = room({ roomCode: 'QUIE', players: 2, bots: 1 });
    const busy = room({ roomCode: 'BUSY', players: 3 });

    expect([playing, full, quiet, busy].sort(byJoinability).map((r) => r.roomCode)).toEqual([
      'BUSY',
      'QUIE',
      'FULL',
      'PLAY',
    ]);
  });
});

describe('many rooms, many readers', () => {
  it('keeps every live room listed when one listing re-checks them all at once', async () => {
    /*
     * The failure this exists for: five people hosting, five rooms listed, and a
     * minute later the card said "1 live". Re-checking several rooms in one
     * listing means several awaits with SQL either side of them, and two title
     * screens polling means two of those interleaved.
     */
    const codes: string[] = [];
    const hosts: Connection[] = [];
    for (let index = 0; index < 5; index += 1) {
      const code = await createRoom('public');
      codes.push(code);
      hosts.push(await connect(code, `Host ${index}`));
    }
    const ours = (rooms: PublicRoom[]): string[] =>
      rooms
        .map((room) => room.roomCode)
        .filter((code) => codes.includes(code))
        .sort();

    await eventually(listPublic, (rooms) => ours(rooms).length === codes.length, 'all five listed');

    // Every row old enough to be re-asked, so one listing re-checks all five.
    for (const code of codes) await ageRow(code, LISTING_RECHECK_MS + 1_000);
    expect(ours(await listPublic())).toEqual([...codes].sort());

    // …and two readers at once, which is two title screens polling.
    for (const code of codes) await ageRow(code, LISTING_RECHECK_MS + 1_000);
    const [first, second] = await Promise.all([listPublic(), listPublic()]);
    expect(ours(first)).toEqual([...codes].sort());
    expect(ours(second)).toEqual([...codes].sort());

    for (const host of hosts) host.close();
  });
});

describe('a room that has been asleep', () => {
  it('is still listed after the object was evicted and re-checked', async () => {
    /*
     * A lobby waiting for players does nothing, so its object is evicted — and
     * the re-check is a plain fetch, which wakes it up cold. If a woken room
     * cannot see the sockets it is holding it reports an empty room, and five
     * live lobbies quietly become none.
     */
    const code = await createRoom('public');
    const alice = await connect(code, 'Alice');
    await eventually(
      () => listed(code),
      (room) => room !== undefined,
      'listed',
    );

    await evictDurableObject(roomStub(code));

    await ageRow(code, LISTING_RECHECK_MS + 1_000);
    expect(await listed(code)).toMatchObject({ roomCode: code, hostName: 'Alice' });

    // And it stays listed: a second re-check of the woken object agrees.
    await ageRow(code, LISTING_RECHECK_MS + 1_000);
    expect(await listed(code)).toBeDefined();

    alice.close();
  });
});
