/**
 * Durable Object tests that run INSIDE workerd via @cloudflare/vitest-pool-workers.
 *
 * Not mocks: this is the real runtime, the real DO storage, the real WebSocket
 * Hibernation API, the real alarm scheduler. If it passes here it passes in
 * production.
 *
 * Two habits worth keeping when adding to this file:
 *
 *  - Every test gets its OWN four-letter room. A room caps its seats, holds
 *    them for reconnects and remembers a finished match, so sharing one across
 *    cases makes the later ones fail for reasons that have nothing to do with
 *    what they are testing.
 *  - Never assume who shoots first. The sim decides the turn order from the
 *    seed; asking the snapshot costs one line and survives the sim changing
 *    its mind.
 */

import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, parseServerMessage, type ServerMessage } from '@scorched/protocol';
import {
  BABY_MISSILE,
  BOT_PERSONALITIES,
  chooseShot,
  fire,
  fromPersisted,
  roundTurnBudget,
  SUDDEN_DEATH_TURNS,
  type GameSnapshot,
  type PersistedGame,
} from '@scorched/sim';

import worker from '../src/index.ts';
import { allocateRoomCode } from '../src/room-code.ts';
import {
  BOT_TURN_DELAY_MS,
  botTurnDelayMs,
  MAX_PLAYERS,
  MAX_SPECTATORS,
  SHOP_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from '../src/game-room.ts';
import { estimatePlaybackMs } from '../src/playback.ts';

const BASE = 'http://example.com';
const MAX_SOCKETS = MAX_PLAYERS + MAX_SPECTATORS;
/**
 * How far a deadline read from outside the Durable Object may sit from the one
 * written inside it. The two `Date.now()` calls are on either side of a real
 * round trip, so they differ by however long that took — single-digit
 * milliseconds in practice. Wide enough that the suite is not a stopwatch,
 * narrow enough that the 60s and 120s clocks can never be confused.
 */
const SLACK_MS = 5_000;

interface Client {
  socket: WebSocket;
  /**
   * Wait for a frame. `from` is a cursor from `mark()`: without it `next`
   * happily matches something that arrived ten assertions ago, which is how a
   * test ends up proving that the frame it already had is still there.
   */
  next(predicate?: (message: ServerMessage) => boolean, from?: number): Promise<ServerMessage>;
  all(): ServerMessage[];
  mark(): number;
  /**
   * Draw a line under everything received so far: it was setup, not the thing
   * under test. `next` searches forward from here unless given an explicit
   * cursor, and `since()` reads the tail.
   *
   * It exists because starting a match now delivers a real turn — the armoury
   * closing and round one opening — before any test has done anything. Without
   * a baseline, every `next(m => m.t === 'events')` in this file would match
   * that opener instead of the frame the test was waiting for, and the
   * assertions would be about the wrong turn while still looking right.
   */
  settle(): void;
  /** Everything received since `settle()`. */
  since(): ServerMessage[];
  close(): void;
}

/**
 * Bring a room into existence, the way `POST /api/rooms` does.
 *
 * A room that nobody was ever given the code to refuses `hello` — see
 * `roomExists` — so a test that skipped this would be testing the refusal
 * rather than whatever it came to test. Every socket in the real product is
 * preceded by either a Create (which claims the code) or a Join to a room
 * somebody already created, so opening the room here is what makes these tests
 * start where a player does.
 */
async function openRoom(roomCode: string): Promise<void> {
  const response = await stub(roomCode).fetch(
    new Request(`${BASE}/claim?room=${roomCode}`, { method: 'POST' }),
  );
  expect(response.status).toBe(200);
  // Drain it. A Durable Object response whose body is never read leaves the
  // request in flight, and an object with a request in flight cannot be
  // evicted — which is how four eviction tests in this file started timing out
  // the moment room creation grew a round trip.
  await response.json();
}

/**
 * Open a real WebSocket into a room and collect frames as they arrive.
 *
 * `open: false` skips the claim above, which is how a test reaches a code that
 * is not a room.
 */
async function openSocket(roomCode: string, options: { open?: boolean } = {}): Promise<Client> {
  if (options.open !== false) await openRoom(roomCode);

  const response = await worker.fetch(
    new Request(`${BASE}/api/rooms/${roomCode}/ws`, { headers: { Upgrade: 'websocket' } }),
    env,
  );
  expect(response.status).toBe(101);

  const socket = response.webSocket;
  if (!socket) throw new Error('Server did not return a WebSocket');
  socket.accept();

  const received: ServerMessage[] = [];
  interface Waiter {
    predicate: (m: ServerMessage) => boolean;
    settle: (m: ServerMessage) => void;
    abandon: () => void;
  }
  const waiters: Waiter[] = [];

  socket.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : '';
    const parsed = parseServerMessage(raw);
    // Every frame the server sends must satisfy its own schema.
    expect(parsed.ok, `server sent an invalid frame: ${raw.slice(0, 200)}`).toBe(true);
    if (!parsed.ok) return;

    received.push(parsed.value);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter !== undefined && waiter.predicate(parsed.value)) {
        waiters.splice(i, 1);
        waiter.settle(parsed.value);
      }
    }
  });

  let baseline = 0;

  return {
    socket,
    all: () => received,
    mark: () => received.length,
    settle: () => {
      baseline = received.length;
    },
    since: () => received.slice(baseline),
    close: () => {
      // Abandon anything still waiting BEFORE closing. A pending waiter whose
      // timer fires after the test has finished shows up as an unhandled
      // rejection during teardown, which buries real failures in noise.
      while (waiters.length > 0) waiters.pop()?.abandon();
      socket.close();
    },
    next(predicate = () => true, from = baseline) {
      const existing = received.slice(from).find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<ServerMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((candidate) => candidate.settle === settle);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for a frame'));
        }, 5000);

        const settle = (message: ServerMessage): void => {
          clearTimeout(timer);
          resolve(message);
        };
        const abandon = (): void => {
          clearTimeout(timer);
          // Never resolves and never rejects — the test is already over.
        };

        waiters.push({ predicate, settle, abandon });
      });
    },
  };
}

function send(socket: WebSocket, message: unknown): void {
  socket.send(JSON.stringify(message));
}

function stub(roomCode: string): DurableObjectStub {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomCode)) as unknown as DurableObjectStub;
}

async function info(roomCode: string): Promise<{
  exists: boolean;
  players: number;
  spectators: number;
  inProgress: boolean;
  phase: string;
}> {
  const response = await stub(roomCode).fetch(new Request(`${BASE}/info`));
  expect(response.status).toBe(200);
  return (await response.json()) as {
    exists: boolean;
    players: number;
    spectators: number;
    inProgress: boolean;
    phase: string;
  };
}

/**
 * A seated connection.
 *
 * `id` and `secret` are deliberately separate, because the server keeps them
 * separate: `id` is public — it is in every `lobby` frame and every tank of
 * every snapshot, so everybody in the room has everybody's — while `secret` is
 * the seat's credential and arrives only in that player's own `welcome`. A test
 * that reconnects must use `secret`; a test that impersonates uses `id` and
 * must be refused.
 */
interface Seat {
  client: Client;
  id: string;
  secret: string;
  role: string;
}

/** Say hello and wait to be seated. */
async function join(
  roomCode: string,
  name: string,
  options: { sessionId?: string; role?: 'player' | 'spectator' } = {},
): Promise<Seat> {
  const client = await openSocket(roomCode);
  send(client.socket, {
    t: 'hello',
    protocol: PROTOCOL_VERSION,
    name,
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(options.role !== undefined ? { role: options.role } : {}),
  });
  const welcome = await client.next((m) => m.t === 'welcome');
  if (welcome.t !== 'welcome') throw new Error('unreachable');
  return {
    client,
    id: welcome.you,
    secret: welcome.sessionId,
    role: welcome.role ?? 'player',
  };
}

/**
 * Seat everyone, then have the first one start the match.
 *
 * Stops in the ARMOURY. A match opens in `shopping` with everybody pending, so
 * this is where a player spends their starting money — the room broadcasts the
 * shop, not a battlefield, and nobody can fire yet.
 */
async function startArmoury(
  roomCode: string,
  names: readonly string[],
): Promise<{ seats: Seat[]; snapshot: GameSnapshot }> {
  const seats: Seat[] = [];
  for (const name of names) seats.push(await join(roomCode, name));

  const host = seats[0] as Seat;
  const last = seats[seats.length - 1] as Seat;
  send(host.client.socket, { t: 'start' });
  const started = await last.client.next((m) => m.t === 'state');
  if (started.t !== 'state') throw new Error('unreachable');
  for (const seat of seats) await seat.client.next((m) => m.t === 'state');
  return { seats, snapshot: started.snapshot };
}

/**
 * Everyone presses Ready in the armoury, which opens round one.
 *
 * The last `shopDone` is the one that rolls the round, and it arrives as an
 * `events` frame rather than a `state` frame — the same frame that carries
 * every other turn.
 */
async function leaveArmoury(seats: readonly Seat[]): Promise<GameSnapshot> {
  // Cursors first. A rematch runs this a second time, and by then every client
  // is holding the `events` frames of the match that just finished — without a
  // cursor the wait below matches one of those and hands back a `gameover`
  // snapshot as though it were round one.
  const cursors = seats.map((seat) => seat.client.mark());
  for (const seat of seats) send(seat.client.socket, { t: 'shopDone' });

  let opened: GameSnapshot | undefined;
  for (let i = 0; i < seats.length; i += 1) {
    const seat = seats[i] as Seat;
    const frame = await seat.client.next((m) => m.t === 'events', cursors[i]);
    if (frame.t !== 'events') throw new Error('unreachable');
    opened = frame.snapshot;
  }
  if (opened === undefined) throw new Error('nobody was in the armoury');
  // Round one opening is setup for almost every test in this file.
  for (const seat of seats) seat.client.settle();
  return opened;
}

/**
 * Run the match back and come out the other side aiming.
 *
 * A rematch is a fresh match, so it opens in the armoury exactly as the first
 * one did — which is the assertion in the middle rather than a step to be got
 * past quietly.
 */
async function rematch(host: Seat, seats: readonly Seat[]): Promise<GameSnapshot> {
  const cursors = seats.map((seat) => seat.client.mark());
  send(host.client.socket, { t: 'start' });
  for (let i = 0; i < seats.length; i += 1) {
    const seat = seats[i] as Seat;
    const armoury = await seat.client.next(
      (m) => m.t === 'state' && m.snapshot.phase === 'shopping',
      cursors[i],
    );
    if (armoury.t !== 'state') throw new Error('unreachable');
  }
  return leaveArmoury(seats);
}

/** Seat everyone, start, shop nothing, and come out the other side aiming. */
async function startMatch(
  roomCode: string,
  names: readonly string[],
): Promise<{ seats: Seat[]; snapshot: GameSnapshot }> {
  const { seats } = await startArmoury(roomCode, names);
  return { seats, snapshot: await leaveArmoury(seats) };
}

/** Start a two-player match and hand back whichever client shoots first. */
async function twoPlayerMatch(roomCode: string): Promise<{
  alice: Seat;
  bob: Seat;
  shooter: Seat;
  waiter: Seat;
  snapshot: GameSnapshot;
}> {
  const { seats, snapshot } = await startMatch(roomCode, ['Alice', 'Bob']);
  const alice = seats[0] as Seat;
  const bob = seats[1] as Seat;

  // The sim picks the turn order from the seed. Ask it, never assume.
  const activeId = snapshot.tanks[snapshot.activeTank]?.id;
  const shooter = activeId === alice.id ? alice : bob;
  const waiter = activeId === alice.id ? bob : alice;
  return { alice, bob, shooter, waiter, snapshot };
}

/**
 * The events of the last turn this client was sent.
 *
 * The pacing tests need the frame the room broadcast, not just the snapshot it
 * carried: what the next computer player waits for is how long that frame takes
 * to ANIMATE.
 */
function lastEventsFrame(seat: Seat): Extract<ServerMessage, { t: 'events' }>['events'] {
  for (let index = seat.client.all().length - 1; index >= 0; index -= 1) {
    const frame = seat.client.all()[index];
    if (frame?.t === 'events') return frame.events;
  }
  throw new Error('this client has never been sent a turn');
}

/** Whichever seat the snapshot says is up. */
function activeSeat(seats: readonly Seat[], snapshot: GameSnapshot): Seat {
  const activeId = snapshot.tanks[snapshot.activeTank]?.id;
  const seat = seats.find((candidate) => candidate.id === activeId);
  if (seat === undefined) throw new Error('no seat holds the active tank');
  return seat;
}

/** Poll until the Durable Object itself agrees the socket count settled. */
async function waitForSocketCount(roomCode: string, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const count = await runInDurableObject(
      stub(roomCode),
      (_instance, state) => state.getWebSockets().length,
    );
    if (count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Room ${roomCode} never settled at ${expected} sockets`);
}

/**
 * Read the room's persisted game and write back a modified one.
 *
 * White-box on purpose. Reaching the shop or a decided match honestly means
 * playing five rounds of artillery, which is not a Durable Object test — but
 * what the ROOM does at those moments (close the shop when the clock runs out,
 * refuse moves after the final round, allow a rematch) very much is.
 */
async function editPersistedGame(
  roomCode: string,
  edit: (game: PersistedGame) => PersistedGame,
): Promise<void> {
  await runInDurableObject(stub(roomCode), (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', 'game')
      .toArray();
    const raw = rows[0]?.v;
    if (raw === undefined) throw new Error('no game to edit');
    const next = edit(JSON.parse(raw) as PersistedGame);
    state.storage.sql.exec(
      'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      'game',
      JSON.stringify(next),
    );

    const turnRows = state.storage.sql
      .exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', 'turn')
      .toArray();
    const turn = JSON.parse(turnRows[0]?.v ?? '{}') as Record<string, unknown>;
    turn['phase'] = next.phase;
    turn['turnNumber'] = next.turnNumber;
    turn['activeId'] = next.phase === 'aiming' ? (next.tanks[next.activeTank]?.id ?? null) : null;
    state.storage.sql.exec(
      'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      'turn',
      JSON.stringify(turn),
    );
  });
}

/** The room's own persisted game, exactly as it will read it back. */
async function readPersistedGame(roomCode: string): Promise<PersistedGame> {
  const raw = await runInDurableObject(stub(roomCode), (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', 'game')
      .toArray();
    return rows[0]?.v;
  });
  if (raw === undefined) throw new Error('no game persisted');
  return JSON.parse(raw) as PersistedGame;
}

/**
 * The small `turn` row — the clock's own bookkeeping.
 *
 * Read directly because the timeout streak and the deadline are not on the
 * wire: `turnTimer` carries a duration, not a policy, so the only way to assert
 * which clock a phase was given is to look at what the room wrote down.
 */
async function readTurnRow(roomCode: string): Promise<{
  phase: string;
  turnNumber: number;
  timeoutStreak: number;
  deadlineAt: number | null;
}> {
  const raw = await runInDurableObject(stub(roomCode), (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', 'turn')
      .toArray();
    return rows[0]?.v;
  });
  if (raw === undefined) throw new Error('no turn row');
  return JSON.parse(raw) as {
    phase: string;
    turnNumber: number;
    timeoutStreak: number;
    deadlineAt: number | null;
  };
}

async function countKvRows(roomCode: string, key: string): Promise<number> {
  return runInDurableObject(stub(roomCode), (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM kv WHERE k = ?', key)
      .toArray();
    return rows[0]?.n ?? 0;
  });
}

async function readReplay(
  roomCode: string,
): Promise<{ match: number; turn: number; events: string }[]> {
  return runInDurableObject(stub(roomCode), (_instance, state) =>
    state.storage.sql
      .exec<{ match: number; turn: number; events: string }>(
        'SELECT match, turn, events FROM replay_v2 ORDER BY seq',
      )
      .toArray(),
  );
}

describe('worker routes', () => {
  it('serves a health check', async () => {
    const response = await worker.fetch(new Request(`${BASE}/api/health`), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('mints a valid room code', async () => {
    const response = await worker.fetch(new Request(`${BASE}/api/rooms`, { method: 'POST' }), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { roomCode: string };
    expect(body.roomCode).toMatch(/^[A-Z]{4}$/);
  });

  it('skips a room code somebody is already sitting in', async () => {
    // The collision is FORCED, not hoped for. The previous version of this test
    // squatted in one room, minted eight random codes and checked they came
    // back empty — with 24^4 = 331,776 codes that is a 0.0024% chance of ever
    // touching the probe, and deleting the probe entirely left the suite green.
    // Handing `allocateRoomCode` its own generator makes the occupied code come
    // up first every single run.
    const squatter = await join('KKKA', 'Squatter');
    expect((await info('KKKA')).players).toBe(1);

    const candidates = ['KKKA', 'KKKB'];
    const minted = await allocateRoomCode(env, () => candidates.shift() ?? 'ZZZZ');
    expect(minted).toBe('KKKB');
    expect((await info('KKKB')).players).toBe(0);

    squatter.client.close();
  });

  it('will not hand out a room with a match running in it', async () => {
    const running = await twoPlayerMatch('KKKD');
    expect((await info('KKKD')).inProgress).toBe(true);

    const candidates = ['KKKD', 'KKKE'];
    const minted = await allocateRoomCode(env, () => candidates.shift() ?? 'ZZZZ');
    expect(minted).toBe('KKKE');

    running.alice.client.close();
    running.bob.client.close();
  });

  it('hands out the last candidate rather than failing when every probe is taken', async () => {
    // Documented fallback: sharing a room is recoverable, "could not create a
    // room" is not. Pinned so the fallback is a decision rather than an
    // accident of loop structure.
    const squatter = await join('KKKC', 'Squatter');
    const minted = await allocateRoomCode(env, () => 'KKKC');
    expect(minted).toBe('KKKC');
    squatter.client.close();
  });

  it('404s unknown api routes', async () => {
    const response = await worker.fetch(new Request(`${BASE}/api/nope`), env);
    expect(response.status).toBe(404);
  });

  it('rejects a non-upgrade request to the ws endpoint', async () => {
    const response = await worker.fetch(new Request(`${BASE}/api/rooms/AAAA/ws`), env);
    expect(response.status).toBe(426);
  });

  it('rejects malformed room codes', async () => {
    for (const code of ['AB', 'ABCDE', '1234']) {
      const response = await worker.fetch(new Request(`${BASE}/api/rooms/${code}/ws`), env);
      expect(response.status).toBe(404);
    }
  });
});

describe('a room code that is not a room', () => {
  /** Say hello on a socket and hand back the first frame the room answers with. */
  async function helloOn(client: Client, name: string): Promise<ServerMessage> {
    send(client.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name });
    return client.next((m) => m.t === 'welcome' || m.t === 'error');
  }

  it('refuses a code nobody was ever given, and does not create it by refusing', async () => {
    /*
     * The defect: a typo dropped the player into an empty room that looked
     * exactly like the one their friend was waiting in. `idFromName` resolves
     * every well-formed code to a Durable Object, so "does not exist" is a
     * decision the room has to make out loud rather than a routing failure it
     * can discover.
     */
    const client = await openSocket('QZQZ', { open: false });
    const answer = await helloOn(client, 'Lost');

    expect(answer.t).toBe('error');
    if (answer.t !== 'error') throw new Error('unreachable');
    expect(answer.code).toBe('room_not_found');
    // Worth reading: a code is a thing you were given by somebody.
    expect(answer.message).toMatch(/code/i);

    // Nobody was seated, and the refusal did not quietly bring the room into
    // being for the next person to walk into either.
    const summary = await info('QZQZ');
    expect(summary.players).toBe(0);
    expect(summary.exists).toBe(false);

    const second = await openSocket('QZQZ', { open: false });
    expect((await helloOn(second, 'AlsoLost')).t).toBe('error');

    client.close();
    second.close();
  });

  it('seats a player in a room the server handed out', async () => {
    // The other half: creating a room still works, and it is the POST that
    // makes the room rather than the socket that follows it.
    const response = await worker.fetch(new Request(`${BASE}/api/rooms`, { method: 'POST' }), env);
    const { roomCode } = (await response.json()) as { roomCode: string };
    expect((await info(roomCode)).exists).toBe(true);

    const client = await openSocket(roomCode, { open: false });
    const answer = await helloOn(client, 'Host');
    expect(answer.t).toBe('welcome');
    expect((await info(roomCode)).players).toBe(1);

    client.close();
  });

  it('is still a room after everyone leaves the lobby', async () => {
    /*
     * The regression this fix could easily have caused, so it is pinned.
     *
     * A departure before the match starts frees the seat, and a lobby with
     * nobody human left in it is emptied entirely — so "has players" is not a
     * durable answer to "is this a room". Somebody who steps out of their own
     * lobby for a minute must not come back to "no room with that code", and
     * neither must the friend they invited.
     */
    const room = 'QZQY';
    const response = await worker.fetch(new Request(`${BASE}/api/rooms`, { method: 'POST' }), env);
    void response;
    await openRoom(room);

    const alice = await openSocket(room, { open: false });
    expect((await helloOn(alice, 'Alice')).t).toBe('welcome');
    alice.close();
    await waitForSocketCount(room, 0);
    expect((await info(room)).players).toBe(0);

    const bob = await openSocket(room, { open: false });
    expect((await helloOn(bob, 'Bob')).t).toBe('welcome');
    bob.close();
  });
});

describe('durable object lifecycle', () => {
  it('accepts a websocket and welcomes a player', async () => {
    const client = await openSocket('AAAB');
    send(client.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });

    const welcome = await client.next((m) => m.t === 'welcome');
    expect(welcome.t).toBe('welcome');
    if (welcome.t === 'welcome') {
      expect(welcome.roomCode).toBe('AAAB');
      expect(welcome.sessionId).toBeTruthy();
      expect(welcome.role ?? 'player').toBe('player');
    }

    const lobby = await client.next((m) => m.t === 'lobby');
    if (lobby.t === 'lobby') {
      expect(lobby.players).toHaveLength(1);
      expect(lobby.players[0]?.name).toBe('Alice');
      expect(lobby.hostId).toBe(welcome.t === 'welcome' ? welcome.you : null);
    }
    client.close();
  });

  it('uses the hibernation API, not the legacy accept()', async () => {
    const client = await openSocket('AAAC');
    send(client.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await client.next((m) => m.t === 'welcome');

    await runInDurableObject(stub('AAAC'), (_instance, state) => {
      // getWebSockets() only returns sockets accepted via ctx.acceptWebSocket().
      expect(state.getWebSockets().length).toBeGreaterThan(0);
    });
    client.close();
  });

  it('survives a real eviction with sockets, attachments and the match intact', async () => {
    const room = 'AAAD';
    const { alice, bob, shooter, snapshot } = await twoPlayerMatch(room);

    // Tear the instance down exactly as eviction after hibernation does: every
    // in-memory field is destroyed, storage and hibernatable sockets survive.
    await evictDurableObject(stub(room));

    const after = await runInDurableObject(stub(room), (_instance, state) => {
      const sockets = state.getWebSockets();
      return sockets.map(
        (socket) => (socket.deserializeAttachment() as { playerId?: string } | null)?.playerId,
      );
    });
    expect(after).toHaveLength(2);
    // The attachments came back with the object — this is the only reason a
    // frame arriving after a wake-up can still be attributed to a player.
    expect(after.filter((id) => id === alice.id)).toHaveLength(1);
    expect(after.filter((id) => id === bob.id)).toHaveLength(1);

    const summary = await info(room);
    expect(summary.inProgress).toBe(true);
    expect(summary.players).toBe(2);

    // And the woken room is not merely alive, it is still adjudicating: the
    // player whose turn it was can take it.
    send(shooter.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    const events = await shooter.client.next((m) => m.t === 'events');
    expect(events.t === 'events' && events.snapshot.turnNumber).toBe(snapshot.turnNumber + 1);

    alice.client.close();
    bob.client.close();
  });

  it('re-attributes a frame to the right player after a wake-up', async () => {
    const { client, id } = await join('AAAE', 'Alice');

    await evictDurableObject(stub('AAAE'));

    await runInDurableObject(stub('AAAE'), (_instance, state) => {
      const sockets = state.getWebSockets();
      expect(sockets.length).toBe(1);
      const attachment = sockets[0]?.deserializeAttachment() as { playerId?: string } | null;
      expect(attachment?.playerId).toBe(id);
    });

    send(client.socket, { t: 'ping', nonce: 42 });
    const pong = await client.next((m) => m.t === 'pong');
    expect(pong.t === 'pong' && pong.nonce).toBe(42);

    client.close();
  });

  it('rebuilds the rate-limit buckets after eviction rather than persisting them', async () => {
    // The buckets are the one deliberate exception to "nothing lives only in
    // memory" — persisting them would mean a storage write per frame. This
    // test pins the consequence: they reset on eviction, and that is fine.
    const { client } = await join('AAAF', 'Alice');
    for (let i = 0; i < 120; i += 1) send(client.socket, { t: 'chat', text: `spam ${i}` });
    await client.next((m) => m.t === 'error' && m.code === 'rate_limited');

    await evictDurableObject(stub('AAAF'));

    send(client.socket, { t: 'ping', nonce: 7 });
    const pong = await client.next((m) => m.t === 'pong' && m.nonce === 7);
    expect(pong.t).toBe('pong');
    client.close();
  });

  it('refuses connections past the socket cap instead of growing without bound', async () => {
    const room = 'AAAG';
    const clients: Client[] = [];
    for (let i = 0; i < MAX_SOCKETS; i += 1) clients.push(await openSocket(room));

    const overflow = await worker.fetch(
      new Request(`${BASE}/api/rooms/${room}/ws`, { headers: { Upgrade: 'websocket' } }),
      env,
    );
    expect(overflow.status).toBe(503);

    for (const client of clients) client.close();
  });
});

describe('gameplay over the wire', () => {
  it('plays a full turn and broadcasts the same result to both players', async () => {
    const { alice, bob, shooter, snapshot } = await twoPlayerMatch('BBBA');
    expect(snapshot.tanks.map((tank) => tank.id).sort()).toEqual([alice.id, bob.id].sort());

    send(shooter.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });

    const aliceEvents = await alice.client.next((m) => m.t === 'events');
    const bobEvents = await bob.client.next((m) => m.t === 'events');

    expect(aliceEvents).toEqual(bobEvents);
    if (aliceEvents.t === 'events') {
      expect(aliceEvents.events.some((event) => event.type === 'shot')).toBe(true);
      // Both clients agree on the terrain after the crater, column for column.
      expect(aliceEvents.snapshot.terrain).toEqual(
        bobEvents.t === 'events' ? bobEvents.snapshot.terrain : null,
      );
      expect(aliceEvents.snapshot.turnNumber).toBe(snapshot.turnNumber + 1);
    }

    alice.client.close();
    bob.client.close();
  });

  it('sends a turn timer so a client can show the clock', async () => {
    const { alice, bob, snapshot } = await twoPlayerMatch('BBBF');
    const timer = await alice.client.next((m) => m.t === 'turnTimer');
    expect(timer.t).toBe('turnTimer');
    if (timer.t === 'turnTimer') {
      expect(timer.turnNumber).toBe(snapshot.turnNumber);
      expect(timer.activeTank).toBe(snapshot.activeTank);
      expect(timer.remainingMs).toBeGreaterThan(0);
      expect(timer.remainingMs).toBeLessThanOrEqual(timer.durationMs);
    }
    alice.client.close();
    bob.client.close();
  });

  it("relays the active player's aim and drops everyone else's", async () => {
    const { alice, bob, shooter, waiter } = await twoPlayerMatch('BBBK');

    // Someone whose turn it is not has no barrel worth watching. Their aim
    // frames are chatter, so they are dropped in silence — no broadcast to the
    // room, and no error back to them either.
    const cursor = shooter.client.mark();
    send(waiter.client.socket, { t: 'aim', angleDeg: 10, power: 10, weapon: 'baby_missile' });
    send(shooter.client.socket, { t: 'aim', angleDeg: 77, power: 33, weapon: 'baby_missile' });

    const relayed = await waiter.client.next((m) => m.t === 'aim');
    expect(relayed.t === 'aim' && relayed.playerId).toBe(shooter.id);
    expect(relayed.t === 'aim' && relayed.angleDeg).toBe(77);

    expect(
      shooter.client
        .all()
        .slice(cursor)
        .some((m) => m.t === 'aim'),
    ).toBe(false);
    expect(waiter.client.all().some((m) => m.t === 'error')).toBe(false);

    alice.client.close();
    bob.client.close();
  });

  it('does not spend a storage write on a ready flag that did not change', async () => {
    const room = 'BBBL';
    const alice = await join(room, 'Alice');
    const bob = await join(room, 'Bob');

    send(alice.client.socket, { t: 'ready', ready: true });
    await bob.client.next((m) => m.t === 'lobby' && m.players.some((p) => p.ready));

    const cursor = bob.client.mark();
    for (let i = 0; i < 5; i += 1) send(alice.client.socket, { t: 'ready', ready: true });
    send(alice.client.socket, { t: 'ping', nonce: 11 });
    await alice.client.next((m) => m.t === 'pong' && m.nonce === 11, cursor);

    expect(
      bob.client
        .all()
        .slice(cursor)
        .filter((m) => m.t === 'lobby'),
    ).toHaveLength(0);

    alice.client.close();
    bob.client.close();
  });

  it('refuses a barrage of illegal moves and leaves the state byte-identical', async () => {
    const room = 'BBBB';
    const { alice, bob, waiter, shooter, snapshot } = await twoPlayerMatch(room);

    const illegal: [string, unknown][] = [
      // Not this player's turn.
      [
        'not_your_turn',
        {
          t: 'fire',
          turnNumber: snapshot.turnNumber,
          angleDeg: 45,
          power: 70,
          weapon: 'baby_missile',
        },
      ],
      // Right player, wrong turn.
      [
        'stale_turn',
        { t: 'fire', turnNumber: 9999, angleDeg: 45, power: 70, weapon: 'baby_missile' },
      ],
      // Right player, right turn, weapon they never bought.
      [
        'no_ammo',
        { t: 'fire', turnNumber: snapshot.turnNumber, angleDeg: 45, power: 70, weapon: 'nuke' },
      ],
      // The shop is not open mid-turn.
      ['wrong_phase', { t: 'buy', weapon: 'nuke', quantity: 1 }],
    ];

    // The first goes to the player it is NOT the turn of; the rest to the one it
    // is, so each rejection is the one being named rather than a turn check.
    for (const [expectedCode, message] of illegal) {
      const client = expectedCode === 'not_your_turn' ? waiter.client : shooter.client;
      const cursor = client.mark();
      send(client.socket, message);
      const error = await client.next((m) => m.t === 'error', cursor);
      expect(error.t === 'error' && error.code, `for ${JSON.stringify(message)}`).toBe(
        expectedCode,
      );
    }

    // And the host cannot restart a match that is already running.
    const hostCursor = alice.client.mark();
    send(alice.client.socket, { t: 'start' });
    const restart = await alice.client.next((m) => m.t === 'error', hostCursor);
    expect(restart.t === 'error' && restart.code).toBe('wrong_phase');

    expect(
      alice.client.since().some((m) => m.t === 'events'),
      'a rejected move must never produce events',
    ).toBe(false);

    // Ask the room for its state fresh, through a socket that saw none of this.
    const observer = await join(room, 'Observer');
    const state = await observer.client.next((m) => m.t === 'state');
    expect(state.t === 'state' && state.snapshot).toEqual(snapshot);
    expect((await info(room)).phase).toBe('aiming');

    alice.client.close();
    bob.client.close();
    observer.client.close();
  });

  it('refuses a stale turn number', async () => {
    const { alice, bob, shooter } = await twoPlayerMatch('BBBC');

    send(shooter.client.socket, {
      t: 'fire',
      turnNumber: 9999,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    const error = await shooter.client.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('stale_turn');

    alice.client.close();
    bob.client.close();
  });

  it('refuses to fire a weapon the player does not own', async () => {
    const { alice, bob, shooter, snapshot } = await twoPlayerMatch('BBBD');

    send(shooter.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'nuke',
    });
    const error = await shooter.client.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('no_ammo');

    alice.client.close();
    bob.client.close();
  });

  it('will not start a match with one player', async () => {
    const { client } = await join('BBBE', 'Alice');
    send(client.socket, { t: 'start' });

    const error = await client.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('no_players');
    client.close();
  });

  it('lets only the host start, and refuses a second start', async () => {
    const alice = await join('BBBG', 'Alice');
    const bob = await join('BBBG', 'Bob');

    send(bob.client.socket, { t: 'start' });
    const refused = await bob.client.next((m) => m.t === 'error');
    expect(refused.t === 'error' && refused.code).toBe('not_host');
    expect((await info('BBBG')).inProgress).toBe(false);

    send(alice.client.socket, { t: 'start' });
    await alice.client.next((m) => m.t === 'state');

    send(alice.client.socket, { t: 'start' });
    const again = await alice.client.next((m) => m.t === 'error');
    expect(again.t === 'error' && again.code).toBe('wrong_phase');

    alice.client.close();
    bob.client.close();
  });

  it('refuses shop traffic while the shop is shut', async () => {
    const { alice, bob } = await twoPlayerMatch('BBBH');

    send(alice.client.socket, { t: 'buy', weapon: 'nuke', quantity: 1 });
    const buyError = await alice.client.next((m) => m.t === 'error');
    expect(buyError.t === 'error' && buyError.code).toBe('wrong_phase');

    send(alice.client.socket, { t: 'shopDone' });
    const doneError = await alice.client.next(
      (m) => m.t === 'error' && m.message.includes('shop is not open'),
    );
    expect(doneError.t === 'error' && doneError.code).toBe('wrong_phase');

    alice.client.close();
    bob.client.close();
  });

  it('refuses gameplay before a match exists', async () => {
    const alice = await join('BBBJ', 'Alice');
    send(alice.client.socket, {
      t: 'fire',
      turnNumber: 1,
      angleDeg: 45,
      power: 50,
      weapon: 'baby_missile',
    });
    const error = await alice.client.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('wrong_phase');
    alice.client.close();
  });
});

describe('hostile input', () => {
  // Each case gets its OWN room: a room caps at MAX_PLAYERS, and sharing one
  // across cases would make the last few fail for an unrelated reason.
  it.each([
    ['not JSON', 'garbage', 'HAAA'],
    ['unknown type', '{"t":"drop_tables"}', 'HAAB'],
    ['missing fields', '{"t":"fire"}', 'HAAC'],
    [
      'angle out of range',
      '{"t":"fire","turnNumber":1,"angleDeg":1e308,"power":50,"weapon":"m"}',
      'HAAD',
    ],
    [
      'sql injection in weapon',
      '{"t":"buy","weapon":"\'; DROP TABLE kv; --","quantity":1}',
      'HAAE',
    ],
    ['huge frame', `{"t":"chat","text":"${'x'.repeat(20000)}"}`, 'HAAF'],
    ['null', 'null', 'HAAG'],
    ['array', '[1,2,3]', 'HAAH'],
    ['deeply nested', `{"t":"chat","text":${'['.repeat(200)}${']'.repeat(200)}}`, 'HAAJ'],
    ['nested object bomb', `${'{"a":'.repeat(300)}1${'}'.repeat(300)}`, 'HAAK'],
    ['unicode noise', '{"t":"hello","protocol":1,"name":"\\ud800\\udc00\\u0000"}', 'HAAL'],
    [
      'wrong types throughout',
      '{"t":"fire","turnNumber":"1","angleDeg":[],"power":{},"weapon":7}',
      'HAAM',
    ],
    [
      'negative turn number',
      '{"t":"fire","turnNumber":-5,"angleDeg":45,"power":50,"weapon":"baby_missile"}',
      'HAAN',
    ],
    [
      'nan angle',
      '{"t":"fire","turnNumber":1,"angleDeg":null,"power":50,"weapon":"baby_missile"}',
      'HAAP',
    ],
    [
      'weapon id with path traversal',
      '{"t":"buy","weapon":"../../etc/passwd","quantity":1}',
      'HAAQ',
    ],
    ['empty object', '{}', 'HAAR'],
    ['t is an object', '{"t":{"toString":"nope"}}', 'HAAS'],
  ])('answers %s with an error and stays up', async (_label, raw, room) => {
    const client = await openSocket(room);
    send(client.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await client.next((m) => m.t === 'welcome');

    client.socket.send(raw);
    const error = await client.next((m) => m.t === 'error');
    expect(error.t).toBe('error');

    // The room is still alive and answering afterwards.
    send(client.socket, { t: 'ping', nonce: 1 });
    const pong = await client.next((m) => m.t === 'pong');
    expect(pong.t).toBe('pong');

    client.close();
  });

  it('requires hello before anything else', async () => {
    const client = await openSocket('CCCB');
    send(client.socket, { t: 'ping', nonce: 1 });
    const error = await client.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('bad_protocol');
    client.close();
  });

  it('rejects a mismatched protocol version', async () => {
    const client = await openSocket('CCCC');
    send(client.socket, { t: 'hello', protocol: 999, name: 'Alice' });
    const error = await client.next((m) => m.t === 'error');
    expect(error.t).toBe('error');
    client.close();
  });

  it('rejects binary frames', async () => {
    const client = await openSocket('CCCD');
    send(client.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await client.next((m) => m.t === 'welcome');

    client.socket.send(new Uint8Array([1, 2, 3, 4]).buffer);
    const error = await client.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('bad_message');
    client.close();
  });

  it('does not let a SQL-injection-shaped weapon id destroy storage', async () => {
    const client = await openSocket('CCCE');
    send(client.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await client.next((m) => m.t === 'welcome');

    client.socket.send(JSON.stringify({ t: 'buy', weapon: "x'; DROP TABLE kv; --", quantity: 1 }));
    await client.next((m) => m.t === 'error');

    const summary = await info('CCCE');
    expect(summary.players).toBe(1); // storage intact

    client.close();
  });

  it('shrugs off prototype pollution attempts', async () => {
    const client = await openSocket('CCCF');
    send(client.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await client.next((m) => m.t === 'welcome');

    const payloads = [
      '{"t":"chat","text":"hi","__proto__":{"pollutedByChat":true}}',
      '{"t":"ready","ready":true,"constructor":{"prototype":{"pollutedByCtor":true}}}',
      '{"t":"buy","weapon":"__proto__","quantity":1}',
      '{"t":"hello","protocol":1,"name":"Eve","sessionId":"__proto__"}',
    ];
    for (const payload of payloads) client.socket.send(payload);

    send(client.socket, { t: 'ping', nonce: 99 });
    await client.next((m) => m.t === 'pong' && m.nonce === 99);

    const probe = {} as Record<string, unknown>;
    expect(probe['pollutedByChat']).toBeUndefined();
    expect(probe['pollutedByCtor']).toBeUndefined();
    // …and nothing above conjured a second seat.
    expect((await info('CCCF')).players).toBe(1);

    client.close();
  });

  it('sends no room traffic at all to a socket that never said hello', async () => {
    const room = 'CCCJ';
    const lurker = await openSocket(room);
    const alice = await join(room, 'Alice');
    const bob = await join(room, 'Bob');

    // Plenty for the lurker to overhear if the room let it: two joins, a chat
    // line and a lobby update.
    send(alice.client.socket, { t: 'chat', text: 'anyone there' });
    await bob.client.next((m) => m.t === 'chat');
    send(alice.client.socket, { t: 'ready', ready: true });
    await bob.client.next((m) => m.t === 'lobby' && m.players.some((player) => player.ready));

    // The lurker gets an answer to its own frame and nothing else. An
    // unidentified socket is not a member of the room.
    send(lurker.socket, { t: 'ping', nonce: 4 });
    await lurker.next((m) => m.t === 'error' && m.code === 'bad_protocol');
    expect(lurker.all().every((m) => m.t === 'error')).toBe(true);

    lurker.close();
    alice.client.close();
    bob.client.close();
  });

  it('never lets one socket claim more than one seat', async () => {
    const client = await openSocket('CCCG');
    for (let i = 0; i < 5; i += 1) {
      send(client.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: `Alice${i}` });
    }
    await client.next((m) => m.t === 'welcome');
    send(client.socket, { t: 'ping', nonce: 3 });
    await client.next((m) => m.t === 'pong' && m.nonce === 3);

    expect((await info('CCCG')).players).toBe(1);
    client.close();
  });

  it('refuses to let one socket switch identity mid-connection', async () => {
    const alice = await join('CCCH', 'Alice');
    const bob = await join('CCCH', 'Bob');

    // Bob's socket claims Alice's credential. One socket, one identity.
    send(bob.client.socket, {
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      name: 'Bob',
      sessionId: alice.secret,
    });
    const error = await bob.client.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('bad_protocol');

    alice.client.close();
    bob.client.close();
  });
});

/**
 * Seat ownership.
 *
 * The room hands each client two identifiers and they do different jobs.
 * `welcome.you` is public: it is in every `lobby` frame and on every tank of
 * every snapshot, so every client in the room holds every other player's.
 * `welcome.sessionId` is the seat's credential and is sent to exactly one
 * socket. Reconnect matches on the credential.
 *
 * These tests exist because it did not. `hello` used to match on the public id,
 * so any client could re-hello as the player whose turn it was, be welcomed as
 * them, and fire their shot or spend their money in the shop — with the
 * victim's own socket still open and nothing on the wire to tell them.
 */
describe('seat ownership', () => {
  it('gives a player a credential that is not their public id', async () => {
    const seat = await join('SSSA', 'Alice');
    expect(seat.secret).not.toBe(seat.id);
    expect(seat.secret.length).toBeGreaterThan(0);
    seat.client.close();
  });

  it('refuses a hello that claims a seat with the victim public id', async () => {
    const room = 'SSSB';
    const { alice, bob, shooter, waiter, snapshot } = await twoPlayerMatch(room);

    // Mallory knows the victim's public id the same way every client does: the
    // room broadcast it. Claiming it must not hand over the seat.
    const mallory = await join(room, 'Mallory', { sessionId: shooter.id });
    expect(mallory.id).not.toBe(shooter.id);
    expect(mallory.role).toBe('spectator');

    send(mallory.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    const refused = await mallory.client.next((m) => m.t === 'error');
    expect(refused.t === 'error' && refused.code).toBe('spectator_only');

    // Nothing moved, and the real owner still has their turn.
    expect((await readPersistedGame(room)).turnNumber).toBe(snapshot.turnNumber);
    send(shooter.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    const events = await shooter.client.next((m) => m.t === 'events');
    expect(events.t === 'events' && events.snapshot.turnNumber).toBe(snapshot.turnNumber + 1);

    alice.client.close();
    bob.client.close();
    mallory.client.close();
    void waiter;
  });

  it('does not let a lobby impostor take over a seat with its public id', async () => {
    const room = 'SSSC';
    const alice = await join(room, 'Alice');

    // Before the match there is a free chair, so the impostor gets one — but a
    // NEW one. What must never happen is landing in Alice's.
    const mallory = await join(room, 'Mallory', { sessionId: alice.id });
    expect(mallory.id).not.toBe(alice.id);
    expect(mallory.role).toBe('player');
    expect((await info(room)).players).toBe(2);

    alice.client.close();
    mallory.client.close();
  });

  it('never puts one player credential on a frame another player receives', async () => {
    const room = 'SSSD';
    const { alice, bob, shooter, snapshot } = await twoPlayerMatch(room);

    send(alice.client.socket, { t: 'chat', text: 'nice terrain' });
    await bob.client.next((m) => m.t === 'chat');
    send(shooter.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    await bob.client.next((m) => m.t === 'events');

    // Everything Bob has ever been sent, searched for Alice's credential, and
    // the other way round. A leak anywhere — lobby, snapshot, chat, host
    // migration — turns impersonation back into copy and paste.
    expect(JSON.stringify(bob.client.all())).not.toContain(alice.secret);
    expect(JSON.stringify(alice.client.all())).not.toContain(bob.secret);
    // …and the credential is genuinely absent, not merely equal to nothing.
    expect(JSON.stringify(alice.client.all())).toContain(alice.secret);

    alice.client.close();
    bob.client.close();
  });

  it('hands the seat to the newest socket with the credential and evicts the old one', async () => {
    const room = 'SSSE';
    const alice = await join(room, 'Alice');
    const bob = await join(room, 'Bob');

    const again = await join(room, 'Alice', { sessionId: alice.secret });
    expect(again.id).toBe(alice.id);

    // The displaced socket is told why, and the seat is neither duplicated nor
    // freed by its close: a takeover is not the owner walking out.
    const notice = await alice.client.next((m) => m.t === 'error' && m.code === 'room_closed');
    expect(notice.t).toBe('error');
    await waitForSocketCount(room, 2);
    expect((await info(room)).players).toBe(2);

    // And the surviving socket is the live one.
    send(again.client.socket, { t: 'ready', ready: true });
    const lobby = await bob.client.next(
      (m) => m.t === 'lobby' && m.players.some((p) => p.id === alice.id && p.ready),
    );
    expect(lobby.t).toBe('lobby');

    again.client.close();
    bob.client.close();
  });
});

describe('rate limiting', () => {
  it('a flood of aim frames never starves the player of their shot', async () => {
    // Regression: aim and fire once shared a budget, so a player who nudged the
    // angle key a few dozen times had their FIRE silently rejected and simply
    // lost the turn. Cosmetic chatter must never cost a player a move.
    const { alice, bob, shooter, snapshot } = await twoPlayerMatch('RATE');

    // Two hundred aim frames — far more than any old shared budget allowed.
    for (let i = 0; i < 200; i += 1) {
      send(shooter.client.socket, {
        t: 'aim',
        angleDeg: 20 + (i % 120),
        power: 50,
        weapon: 'baby_missile',
      });
    }

    send(shooter.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });

    const events = await shooter.client.next((m) => m.t === 'events');
    expect(events.t).toBe('events');
    if (events.t === 'events') {
      expect(events.snapshot.turnNumber).toBe(snapshot.turnNumber + 1);
    }
    expect(shooter.client.all().some((m) => m.t === 'error')).toBe(false);

    alice.client.close();
    bob.client.close();
  });

  it('still refuses a genuine flood of real moves', async () => {
    const { client } = await join('RATF', 'Alice');

    // Chat is a real message, not chatter. Enough of it must be refused.
    for (let i = 0; i < 120; i += 1) {
      send(client.socket, { t: 'chat', text: `spam ${i}` });
    }

    const error = await client.next((m) => m.t === 'error' && m.code === 'rate_limited');
    expect(error.t === 'error' && error.code).toBe('rate_limited');
    client.close();
  });

  it('drops excess chatter silently rather than erroring', async () => {
    const { client } = await join('RATG', 'Alice');

    for (let i = 0; i < 600; i += 1) {
      send(client.socket, { t: 'aim', angleDeg: 45, power: 50, weapon: 'baby_missile' });
    }

    // A real action still goes through on its own untouched budget, and the
    // aim flood never produced a single `rate_limited` error — over-budget
    // chatter is simply ignored rather than complained about.
    send(client.socket, { t: 'ready', ready: true });
    const lobby = await client.next((m) => m.t === 'lobby' && m.players[0]?.ready === true);
    expect(lobby.t).toBe('lobby');

    expect(client.all().some((m) => m.t === 'error' && m.code === 'rate_limited')).toBe(false);
    client.close();
  });

  it('rate limits a socket that never said hello', async () => {
    const client = await openSocket('RATH');
    for (let i = 0; i < 120; i += 1) send(client.socket, { t: 'chat', text: 'anonymous spam' });
    const error = await client.next((m) => m.t === 'error' && m.code === 'rate_limited');
    expect(error.t === 'error' && error.code).toBe('rate_limited');
    client.close();
  });
});

describe('reconnect', () => {
  it('gives a returning player their seat, their money and the live state back', async () => {
    const room = 'DDDA';
    const { alice, bob, snapshot } = await twoPlayerMatch(room);
    const before = snapshot.tanks.find((tank) => tank.id === alice.id);
    expect(before).toBeDefined();

    alice.client.close();
    await waitForSocketCount(room, 1);

    const back = await join(room, 'Alice', { sessionId: alice.secret });
    expect(back.id).toBe(alice.id);
    expect(back.role).toBe('player');

    const state = await back.client.next((m) => m.t === 'state');
    expect(state.t).toBe('state');
    if (state.t === 'state') {
      const tank = state.snapshot.tanks.find((candidate) => candidate.id === alice.id);
      expect(tank?.x).toBe(before?.x);
      expect(tank?.health).toBe(before?.health);
      expect(tank?.money).toBe(before?.money);
      expect(tank?.inventory).toEqual(before?.inventory);
      expect(state.snapshot.turnNumber).toBe(snapshot.turnNumber);
    }

    back.client.close();
    bob.client.close();
  });

  it('lets a player who dropped on their own turn come back and take it', async () => {
    const room = 'DDDC';
    const { alice, bob, shooter, waiter, snapshot } = await twoPlayerMatch(room);

    shooter.client.close();
    await waitForSocketCount(room, 1);

    const back = await join(room, 'Shooter', { sessionId: shooter.secret });
    await back.client.next((m) => m.t === 'state');

    send(back.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 50,
      power: 65,
      weapon: 'baby_missile',
    });
    const events = await back.client.next((m) => m.t === 'events');
    expect(events.t === 'events' && events.snapshot.turnNumber).toBe(snapshot.turnNumber + 1);

    back.client.close();
    waiter.client.close();
    void alice;
    void bob;
  });

  it('seats a brand-new arrival mid-match as a spectator with no tank', async () => {
    const room = 'DDDB';
    const { alice, bob, snapshot } = await twoPlayerMatch(room);

    const eve = await join(room, 'Eve');
    expect(eve.role).toBe('spectator');

    const state = await eve.client.next((m) => m.t === 'state');
    expect(state.t).toBe('state');
    if (state.t === 'state') {
      expect(state.snapshot.tanks.some((tank) => tank.id === eve.id)).toBe(false);
      expect(state.snapshot.tanks).toHaveLength(2);
    }

    // A spectator may watch and chat, and nothing else.
    send(eve.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    const fireError = await eve.client.next((m) => m.t === 'error');
    expect(fireError.t === 'error' && fireError.code).toBe('spectator_only');

    send(eve.client.socket, { t: 'ready', ready: true });
    const readyError = await eve.client.next(
      (m) => m.t === 'error' && m.message.includes('watching'),
    );
    expect(readyError.t === 'error' && readyError.code).toBe('spectator_only');

    const beforeStart = eve.client.mark();
    send(eve.client.socket, { t: 'start' });
    send(eve.client.socket, { t: 'ping', nonce: 5 });
    await eve.client.next((m) => m.t === 'pong' && m.nonce === 5, beforeStart);
    const startError = eve.client.all()[beforeStart];
    expect(startError?.t === 'error' && startError.code).toBe('spectator_only');

    const summary = await info(room);
    expect(summary.players).toBe(2);
    expect(summary.spectators).toBe(1);

    alice.client.close();
    bob.client.close();
    eve.client.close();
  });

  it('announces who is watching', async () => {
    const room = 'DDDD';
    const { alice, bob } = await twoPlayerMatch(room);

    const eve = await join(room, 'Eve');
    const spectators = await alice.client.next((m) => m.t === 'spectators');
    expect(spectators.t).toBe('spectators');
    if (spectators.t === 'spectators') {
      expect(spectators.count).toBe(1);
      expect(spectators.viewers[0]?.name).toBe('Eve');
    }

    eve.client.close();
    await waitForSocketCount(room, 2);
    const gone = await bob.client.next((m) => m.t === 'spectators' && m.count === 0);
    expect(gone.t).toBe('spectators');

    alice.client.close();
    bob.client.close();
  });

  it('honours a client that asks to spectate a lobby it could have joined', async () => {
    const room = 'DDDE';
    const alice = await join(room, 'Alice');
    const watcher = await join(room, 'Watcher', { role: 'spectator' });
    expect(watcher.role).toBe('spectator');

    const summary = await info(room);
    expect(summary.players).toBe(1);
    expect(summary.spectators).toBe(1);

    alice.client.close();
    watcher.client.close();
  });
});

describe('room capacity and seats', () => {
  it('seats an overflowing player as a spectator rather than turning them away', async () => {
    const room = 'EEEA';
    const clients: Client[] = [];
    for (let i = 0; i < MAX_PLAYERS; i += 1) {
      const seated = await join(room, `P${i}`);
      expect(seated.role).toBe('player');
      clients.push(seated.client);
    }

    const overflow = await join(room, 'Late');
    expect(overflow.role).toBe('spectator');
    clients.push(overflow.client);

    const summary = await info(room);
    expect(summary.players).toBe(MAX_PLAYERS);
    expect(summary.spectators).toBe(1);

    for (const client of clients) client.close();
  });

  it('frees a seat when a player leaves the lobby, but holds it during a match', async () => {
    const lobbyRoom = 'EEEB';
    const alice = await join(lobbyRoom, 'Alice');
    const bob = await join(lobbyRoom, 'Bob');
    expect((await info(lobbyRoom)).players).toBe(2);

    bob.client.close();
    await waitForSocketCount(lobbyRoom, 1);
    expect((await info(lobbyRoom)).players).toBe(1);
    alice.client.close();

    const matchRoom = 'EEEC';
    const match = await twoPlayerMatch(matchRoom);
    match.bob.client.close();
    await waitForSocketCount(matchRoom, 1);
    // Mid-match a seat is a tank, not a chair: it is held for the reconnect.
    expect((await info(matchRoom)).players).toBe(2);
    match.alice.client.close();
  });

  it('does not hand a second seat to a duplicate join', async () => {
    const room = 'EEED';
    const alice = await join(room, 'Alice');
    const twin = await join(room, 'Alice', { sessionId: alice.secret });
    expect(twin.id).toBe(alice.id);
    expect((await info(room)).players).toBe(1);

    alice.client.close();
    twin.client.close();
  });

  it('caps the audience once every viewing slot is taken', async () => {
    const room = 'EEEF';
    const clients: Client[] = [];
    const alice = await join(room, 'Alice');
    clients.push(alice.client);

    for (let i = 0; i < MAX_SPECTATORS; i += 1) {
      const viewer = await join(room, `V${i}`, { role: 'spectator' });
      expect(viewer.role).toBe('spectator');
      clients.push(viewer.client);
    }
    expect((await info(room)).spectators).toBe(MAX_SPECTATORS);

    // Spectators cost a copy of every broadcast, so the audience is bounded
    // even though the socket cap has room left (1 + 16 is under MAX_SOCKETS).
    const late = await openSocket(room);
    clients.push(late);
    send(late.socket, {
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      name: 'Late',
      role: 'spectator',
    });
    const error = await late.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('room_full');
    expect((await info(room)).spectators).toBe(MAX_SPECTATORS);

    for (const client of clients) client.close();
  });

  it('gives every player their own colour', async () => {
    const room = 'EEEG';
    const { seats, snapshot } = await startMatch(room, ['Ann', 'Ben', 'Cal']);

    // Eight identically-coloured tanks is a rendering disaster that no amount
    // of protocol validation would have caught: `colorIndex` is a valid index
    // whatever it holds.
    expect(new Set(snapshot.tanks.map((tank) => tank.colorIndex)).size).toBe(3);

    const lobby = (seats[2] as Seat).client
      .all()
      .find((m) => m.t === 'lobby' && m.players.length === 3);
    expect(lobby?.t).toBe('lobby');
    if (lobby?.t === 'lobby') {
      expect(new Set(lobby.players.map((player) => player.colorIndex)).size).toBe(3);
    }

    for (const seat of seats) seat.client.close();
  });

  it('ignores an unknown session id and seats the newcomer normally', async () => {
    const room = 'EEEE';
    const stranger = await join(room, 'Ghost', { sessionId: 'nobody-has-this-id' });
    expect(stranger.role).toBe('player');
    expect(stranger.id).not.toBe('nobody-has-this-id');
    expect((await info(room)).players).toBe(1);
    stranger.client.close();
  });
});

describe('host migration', () => {
  it('promotes a new host when the host leaves the lobby', async () => {
    const room = 'FFFA';
    const alice = await join(room, 'Alice');
    const bob = await join(room, 'Bob');
    const carol = await join(room, 'Carol');

    alice.client.close();
    await waitForSocketCount(room, 2);

    const host = await bob.client.next((m) => m.t === 'host');
    expect(host.t).toBe('host');
    if (host.t === 'host') {
      expect(host.hostId).toBe(bob.id);
      expect(host.reason).toBe('host_left');
    }

    // And the new host can actually do the one thing a host is for.
    send(bob.client.socket, { t: 'start' });
    const started = await carol.client.next((m) => m.t === 'state');
    expect(started.t).toBe('state');

    bob.client.close();
    carol.client.close();
  });

  it('keeps the host seat with the stand-in when the original comes back', async () => {
    const room = 'FFFB';
    const alice = await join(room, 'Alice');
    const bob = await join(room, 'Bob');

    alice.client.close();
    await waitForSocketCount(room, 1);
    await bob.client.next((m) => m.t === 'host' && m.hostId === bob.id);

    const backAgain = await join(room, 'Alice');
    const lobby = await backAgain.client.next((m) => m.t === 'lobby');
    expect(lobby.t === 'lobby' && lobby.hostId).toBe(bob.id);

    bob.client.close();
    backAgain.client.close();
  });
});

describe('the turn clock', () => {
  it("plays an absent player's turn rather than letting the match freeze", async () => {
    const room = 'GGGA';
    const { alice, bob, shooter, waiter, snapshot } = await twoPlayerMatch(room);

    // The player whose turn it is walks away entirely.
    shooter.client.close();
    await waitForSocketCount(room, 1);

    const ran = await runDurableObjectAlarm(stub(room));
    expect(ran, 'a turn should have had a clock running').toBe(true);

    const events = await waiter.client.next((m) => m.t === 'events');
    expect(events.t).toBe('events');
    if (events.t === 'events') {
      expect(events.events[0]).toEqual({
        type: 'timeout',
        tankIndex: snapshot.activeTank,
        turnNumber: snapshot.turnNumber,
      });
      // The match moved on, which is the entire point.
      expect(events.snapshot.turnNumber).toBe(snapshot.turnNumber + 1);
    }

    alice.client.close();
    bob.client.close();
  });

  it('tells a player who fires after the clock took their turn exactly that', async () => {
    const room = 'GGGB';
    const { alice, bob, shooter, snapshot } = await twoPlayerMatch(room);

    await runDurableObjectAlarm(stub(room));
    await shooter.client.next((m) => m.t === 'events');

    // The shot they were composing when time ran out finally arrives.
    send(shooter.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    const error = await shooter.client.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('turn_expired');

    alice.client.close();
    bob.client.close();
  });

  it('does not keep waking an empty room', async () => {
    const room = 'GGGC';
    const { alice, bob } = await twoPlayerMatch(room);
    const before = await info(room);
    const aliceSecret = alice.secret;

    alice.client.close();
    bob.client.close();
    await waitForSocketCount(room, 0);

    const ran = await runDurableObjectAlarm(stub(room));
    expect(ran).toBe(true);

    // Nothing happened, and nothing is scheduled to happen: an abandoned room
    // costs nothing until somebody comes back.
    const after = await info(room);
    expect(after.phase).toBe(before.phase);
    const pending = await runInDurableObject(stub(room), (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(pending).toBeNull();

    // …and the clock restarts for whoever comes back to their seat.
    const returning = await join(room, 'Alice', { sessionId: aliceSecret });
    const rearmed = await runInDurableObject(stub(room), (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(rearmed).not.toBeNull();
    returning.client.close();
  });

  it('abandons a match that only the clock is still playing', async () => {
    const room = 'GGGD';
    const { alice, bob } = await twoPlayerMatch(room);

    // Nobody ever moves again. The clock covers for them a few times and then
    // stops throwing good CPU after bad.
    for (let i = 0; i < 6; i += 1) {
      const ran = await runDurableObjectAlarm(stub(room));
      if (!ran) break;
      if (!(await info(room)).inProgress) break;
    }

    const summary = await info(room);
    expect(summary.inProgress).toBe(false);
    expect(summary.players).toBe(2); // the seats survive; only the match is gone

    // Gone from storage, not merely hidden: a room that kept the abandoned
    // board around would hand it to the next arrival as live state.
    expect(await countKvRows(room, 'game')).toBe(0);
    expect(await countKvRows(room, 'turn')).toBe(0);
    expect(await countKvRows(room, 'players')).toBe(1);

    const notice = await alice.client.next((m) => m.t === 'error' && m.code === 'room_closed');
    expect(notice.t).toBe('error');

    const pending = await runInDurableObject(stub(room), (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(pending).toBeNull();

    // The room is a lobby again and can start a fresh match.
    send(alice.client.socket, { t: 'start' });
    const restarted = await bob.client.next(
      (m) => m.t === 'state' && m.snapshot.round === 1 && m.snapshot.turnNumber <= 2,
    );
    expect(restarted.t).toBe('state');

    alice.client.close();
    bob.client.close();
  });

  it("fires the tank's own stored aim with the free missile, never paid ammunition", async () => {
    const room = 'PPPA';
    const { alice, bob, shooter, waiter, snapshot } = await twoPlayerMatch(room);

    // Point the barrel somewhere distinctive and hand the absent player an
    // arsenal. A clock that used a canned angle, or that reached for the
    // selected weapon, would now produce a visibly different turn.
    await editPersistedGame(room, (game) => ({
      ...game,
      tanks: game.tanks.map((tank, index) =>
        index === game.activeTank
          ? {
              ...tank,
              angleDeg: 123,
              power: 88,
              selectedWeapon: 'nuke',
              inventory: { ...tank.inventory, nuke: 3 },
            }
          : tank,
      ),
    }));

    // Predict the forced shot with the same sim the room runs, from the room's
    // own persisted state. That is the project's central claim — same state,
    // same seed, same result — so the trajectory can be asserted exactly rather
    // than shape-checked.
    const predicted = fire(fromPersisted(await readPersistedGame(room)), shooter.id, {
      turnNumber: snapshot.turnNumber,
      angleDeg: 123,
      power: 88,
      weapon: BABY_MISSILE,
    });
    const predictedShot = predicted.events.find((event) => event.type === 'shot');
    if (predictedShot?.type !== 'shot') throw new Error('the sim produced no shot to compare with');

    shooter.client.close();
    await waitForSocketCount(room, 1);
    expect(await runDurableObjectAlarm(stub(room))).toBe(true);

    const events = await waiter.client.next((m) => m.t === 'events');
    expect(events.t).toBe('events');
    if (events.t === 'events') {
      const shot = events.events.find((event) => event.type === 'shot');
      expect(shot?.type).toBe('shot');
      if (shot?.type === 'shot') {
        // Always the free weapon: the clock may take a turn, never an inventory.
        expect(shot.weapon).toBe(BABY_MISSILE);
        // And the aim is the one on the tank, not one invented here.
        expect(shot.path).toEqual(predictedShot.path);
      }
      const tank = events.snapshot.tanks.find((candidate) => candidate.id === shooter.id);
      expect(tank?.inventory['nuke']).toBe(3);
    }

    alice.client.close();
    bob.client.close();
  });

  it('gives the match its patience back when somebody actually plays', async () => {
    const room = 'PPPB';
    const { alice, bob } = await twoPlayerMatch(room);

    expect(await runDurableObjectAlarm(stub(room))).toBe(true);
    const forced = await alice.client.next((m) => m.t === 'events');
    expect(forced.t).toBe('events');
    expect((await readTurnRow(room)).timeoutStreak).toBe(1);

    if (forced.t !== 'events') throw new Error('unreachable');
    const next = forced.snapshot;
    expect(next.phase, 'this test needs the match still aiming after one timeout').toBe('aiming');

    const up = activeSeat([alice, bob], next);
    const cursor = up.client.mark();
    send(up.client.socket, {
      t: 'fire',
      turnNumber: next.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    await up.client.next((m) => m.t === 'events', cursor);

    // A real move is the room's evidence that somebody is still here, so the
    // three-strikes count that eventually abandons a match starts over.
    expect((await readTurnRow(room)).timeoutStreak).toBe(0);

    alice.client.close();
    bob.client.close();
  });

  it('gives the shop a longer clock than a turn, and points the alarm at it', async () => {
    const room = 'PPPC';
    const { alice, bob, shooter, snapshot } = await twoPlayerMatch(room);

    // Read after the deadline was written, so this can only be shorter than the
    // clock it was given, never longer.
    const aiming = await readTurnRow(room);
    expect(aiming.phase).toBe('aiming');
    expect(aiming.deadlineAt).not.toBeNull();
    const turnLeft = (aiming.deadlineAt as number) - Date.now();
    expect(turnLeft).toBeLessThanOrEqual(TURN_TIMEOUT_MS);
    expect(turnLeft).toBeGreaterThan(TURN_TIMEOUT_MS - SLACK_MS);

    // End the round with rounds still to play: that opens the shop.
    await editPersistedGame(room, (game) => ({
      ...game,
      round: 1,
      tanks: game.tanks.map((tank, index) => ({
        ...tank,
        alive: index === game.activeTank,
        health: index === game.activeTank ? 5000 : 0,
      })),
    }));

    const before = Date.now();
    send(shooter.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    const events = await bob.client.next(
      (m) => m.t === 'events' && m.snapshot.phase === 'shopping',
    );
    expect(events.t).toBe('events');

    const shopping = await readTurnRow(room);
    expect(shopping.phase).toBe('shopping');
    // `before` was read ahead of the deadline being written, so this can only
    // be longer than the clock it was given, never shorter. Reading an arsenal
    // takes longer than picking an angle: the assertion is against the turn
    // clock, not a literal, so a shop quietly handed the 60s clock fails here.
    const remaining = (shopping.deadlineAt as number) - before;
    expect(remaining).toBeGreaterThan(TURN_TIMEOUT_MS);
    expect(remaining).toBeGreaterThanOrEqual(SHOP_TIMEOUT_MS);
    expect(remaining).toBeLessThan(SHOP_TIMEOUT_MS + SLACK_MS);

    // The alarm and the row describe the same deadline, or the countdown the
    // client draws is for a timeout that will not happen when it says.
    const alarm = await runInDurableObject(stub(room), (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBe(shopping.deadlineAt);

    alice.client.close();
    bob.client.close();
  });

  it('closes a shop nobody leaves', async () => {
    const room = 'GGGE';
    const { alice, bob, snapshot } = await twoPlayerMatch(room);

    // Drop the room into the intermission with everybody still browsing.
    await editPersistedGame(room, (game) => ({
      ...game,
      phase: 'shopping',
      pendingShoppers: game.tanks.map((tank) => tank.id),
    }));

    const ran = await runDurableObjectAlarm(stub(room));
    expect(ran).toBe(true);

    const events = await bob.client.next((m) => m.t === 'events');
    expect(events.t).toBe('events');
    if (events.t === 'events') {
      expect(events.snapshot.phase).toBe('aiming');
      expect(events.snapshot.round).toBe(snapshot.round + 1);
    }

    alice.client.close();
    bob.client.close();
  });
});

/**
 * The shop.
 *
 * Reaching an intermission honestly means playing a whole round of artillery,
 * which is a sim test, not a Durable Object test — so the room is dropped into
 * `shopping` directly. What is being tested here is the ROOM's half: that a
 * purchase reaches storage, that the buyer alone is told about it, and that a
 * repeated `shopDone` costs the room nothing.
 *
 * Every one of those was previously unpinned. Injecting `money += 999` into the
 * success branch, broadcasting the buyer's frame to the whole room, and
 * deleting the `pendingShoppers` guard each left the suite green.
 */
describe('the shop', () => {
  const MISSILE_PRICE = 1800;
  const MISSILE_PACK = 10;
  /** `SELL_REFUND_DIVISOR` is 2 — half the pack price back. */
  const MISSILE_REFUND = MISSILE_PRICE / 2;

  async function openShop(room: string): Promise<{
    alice: Seat;
    bob: Seat;
    snapshot: GameSnapshot;
  }> {
    const { alice, bob, snapshot } = await twoPlayerMatch(room);
    await editPersistedGame(room, (game) => ({
      ...game,
      phase: 'shopping',
      pendingShoppers: game.tanks.map((tank) => tank.id),
    }));
    return { alice, bob, snapshot };
  }

  function tankOf(snapshot: GameSnapshot, id: string): GameSnapshot['tanks'][number] {
    const tank = snapshot.tanks.find((candidate) => candidate.id === id);
    if (tank === undefined) throw new Error('no tank for that player');
    return tank;
  }

  /** Round-trip a socket so anything the room already queued has landed. */
  async function settle(seat: Seat, nonce: number): Promise<void> {
    send(seat.client.socket, { t: 'ping', nonce });
    await seat.client.next((m) => m.t === 'pong' && m.nonce === nonce);
  }

  it('completes a purchase, debits the wallet, and tells only the buyer', async () => {
    const room = 'MMMA';
    const { alice, bob, snapshot } = await openShop(room);
    const before = tankOf(snapshot, alice.id).money;

    const bobCursor = bob.client.mark();
    const aliceCursor = alice.client.mark();
    send(alice.client.socket, { t: 'buy', weapon: 'missile', quantity: 1 });

    const frame = await alice.client.next((m) => m.t === 'state', aliceCursor);
    expect(frame.t).toBe('state');
    if (frame.t === 'state') {
      const tank = tankOf(frame.snapshot, alice.id);
      expect(tank.money).toBe(before - MISSILE_PRICE);
      expect(tank.inventory['missile']).toBe(MISSILE_PACK);
      // Bob's wallet is nobody's business but Bob's, and it did not move.
      expect(tankOf(frame.snapshot, bob.id).money).toBe(tankOf(snapshot, bob.id).money);
    }

    // The purchase is in storage, not just in the frame that answered it.
    const persisted = await readPersistedGame(room);
    expect(tankOf(persisted, alice.id).money).toBe(before - MISSILE_PRICE);

    // A transaction nobody else can see is not worth a heightmap each: the
    // buyer's frame is a reply, not a broadcast.
    await settle(bob, 21);
    expect(
      bob.client
        .all()
        .slice(bobCursor)
        .filter((m) => m.t === 'state'),
    ).toHaveLength(0);

    alice.client.close();
    bob.client.close();
  });

  it('sells a pack back at the refund rate', async () => {
    const room = 'MMMB';
    const { alice, bob, snapshot } = await openShop(room);
    const before = tankOf(snapshot, alice.id).money;

    let cursor = alice.client.mark();
    send(alice.client.socket, { t: 'buy', weapon: 'missile', quantity: 2 });
    await alice.client.next((m) => m.t === 'state', cursor);

    cursor = alice.client.mark();
    send(alice.client.socket, { t: 'sell', weapon: 'missile' });
    const sold = await alice.client.next((m) => m.t === 'state', cursor);
    expect(sold.t).toBe('state');
    if (sold.t === 'state') {
      const tank = tankOf(sold.snapshot, alice.id);
      expect(tank.money).toBe(before - MISSILE_PRICE * 2 + MISSILE_REFUND);
      expect(tank.inventory['missile']).toBe(MISSILE_PACK);
    }

    alice.client.close();
    bob.client.close();
  });

  it('refuses a purchase nobody can afford and leaves the wallet alone', async () => {
    const room = 'MMMC';
    const { alice, bob, snapshot } = await openShop(room);
    const before = tankOf(snapshot, alice.id).money;

    send(alice.client.socket, { t: 'buy', weapon: 'nuke', quantity: 99 });
    const error = await alice.client.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('insufficient_funds');
    expect(tankOf(await readPersistedGame(room), alice.id).money).toBe(before);

    alice.client.close();
    bob.client.close();
  });

  it('takes one player out of the shop, ignores the repeat, and rolls over on the last', async () => {
    const room = 'MMMD';
    const { alice, bob, snapshot } = await openShop(room);

    // Leaving the shop IS everyone's business — who the room is still waiting
    // for decides when the next round starts.
    send(alice.client.socket, { t: 'shopDone' });
    const waiting = await bob.client.next(
      (m) => m.t === 'state' && m.snapshot.pendingShoppers.length === 1,
    );
    expect(waiting.t === 'state' && waiting.snapshot.pendingShoppers).toEqual([bob.id]);

    // The repeat is idempotent: Alice gets the state back, and it costs the
    // rest of the room nothing at all.
    const bobCursor = bob.client.mark();
    const aliceCursor = alice.client.mark();
    send(alice.client.socket, { t: 'shopDone' });
    const echo = await alice.client.next((m) => m.t === 'state', aliceCursor);
    expect(echo.t === 'state' && echo.snapshot.pendingShoppers).toEqual([bob.id]);
    await settle(bob, 22);
    expect(
      bob.client
        .all()
        .slice(bobCursor)
        .filter((m) => m.t === 'state'),
    ).toHaveLength(0);

    // And the last one out starts the round for everybody.
    send(bob.client.socket, { t: 'shopDone' });
    const rolled = await alice.client.next((m) => m.t === 'events');
    expect(rolled.t).toBe('events');
    if (rolled.t === 'events') {
      expect(rolled.snapshot.phase).toBe('aiming');
      expect(rolled.snapshot.round).toBe(snapshot.round + 1);
      expect(rolled.snapshot.pendingShoppers).toEqual([]);
    }

    alice.client.close();
    bob.client.close();
  });

  it('will not sell a seat to a spectator', async () => {
    const room = 'MMME';
    const { alice, bob } = await openShop(room);
    const eve = await join(room, 'Eve', { role: 'spectator' });

    send(eve.client.socket, { t: 'buy', weapon: 'missile', quantity: 1 });
    const error = await eve.client.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('spectator_only');

    alice.client.close();
    bob.client.close();
    eve.client.close();
  });
});

// ---------------------------------------------------------------------------
// The armoury, before the first shell
// ---------------------------------------------------------------------------

describe('the pre-round-one armoury', () => {
  it('opens the shop instead of the battlefield, and refuses fire until it closes', async () => {
    const room = 'ARMA';
    const { seats, snapshot } = await startArmoury(room, ['Alice', 'Bob']);
    const [alice, bob] = seats as [Seat, Seat];

    // What every client is looking at is a shop with everybody still in it.
    expect(snapshot.phase).toBe('shopping');
    expect([...snapshot.pendingShoppers].sort()).toEqual([alice.id, bob.id].sort());
    expect(snapshot.round).toBe(1);
    // The room agrees this is a live match, so nobody can take a seat or
    // restart it while the shopping is going on.
    expect((await info(room)).inProgress).toBe(true);

    // And nobody can shoot their way out of the shop.
    const cursor = alice.client.mark();
    send(alice.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 60,
      weapon: 'baby_missile',
    });
    const refusal = await alice.client.next((m) => m.t === 'error', cursor);
    expect(refusal.t === 'error' && refusal.code).toBe('wrong_phase');

    alice.client.close();
    bob.client.close();
  });

  it('lets a human buy and a computer player arm itself, then opens round one', async () => {
    /*
     * The whole feature, end to end over the wire: a match starts, the shop is
     * open, a human buys, a bot has already bought, and round one begins with
     * both of them armed.
     *
     * The bot's half is the part that is easy to get wrong and impossible to
     * see from outside: it has no socket, so a room that did not walk it
     * through the shop would simply fight round one with the free weapon, and
     * the lobby would look completely normal the whole time.
     */
    const room = 'ARMB';
    const alice = await join(room, 'Alice');
    send(alice.client.socket, { t: 'addBot', personality: 'cyborg' });
    const lobby = await alice.client.next((m) => m.t === 'lobby' && m.players.length === 2);
    if (lobby.t !== 'lobby') throw new Error('unreachable');
    const botId = lobby.players.find((player) => player.bot != null)?.id as string;

    send(alice.client.socket, { t: 'start' });
    const opening = await alice.client.next((m) => m.t === 'state');
    if (opening.t !== 'state') throw new Error('unreachable');

    // The computer player shopped on its way through `start` and is already
    // out, so the room is waiting for the person alone.
    expect(opening.snapshot.phase).toBe('shopping');
    expect(opening.snapshot.pendingShoppers).toEqual([alice.id]);
    const botAtShop = opening.snapshot.tanks.find((tank) => tank.id === botId);
    const humanAtStart = opening.snapshot.tanks.find((tank) => tank.id === alice.id);
    expect(Object.keys(botAtShop?.inventory ?? {}).length).toBeGreaterThan(0);
    // It paid for it, out of the same opening bank the human still has whole.
    expect(botAtShop?.money as number).toBeLessThan(humanAtStart?.money as number);

    // The human buys, over the wire, and gets the wallet back.
    const buying = alice.client.mark();
    send(alice.client.socket, { t: 'buy', weapon: 'missile', quantity: 2 });
    const bought = await alice.client.next((m) => m.t === 'state', buying);
    if (bought.t !== 'state') throw new Error('unreachable');
    const humanAtShop = bought.snapshot.tanks.find((tank) => tank.id === alice.id);
    expect(humanAtShop?.inventory['missile']).toBeGreaterThan(0);
    expect(humanAtShop?.money as number).toBeLessThan(humanAtStart?.money as number);
    // Still shopping: buying is not leaving.
    expect(bought.snapshot.phase).toBe('shopping');

    // Ready. Round one opens, and both tanks carry what they bought into it.
    const opened = await leaveArmoury([alice]);
    expect(opened.phase).toBe('aiming');
    expect(opened.round).toBe(1);
    expect(opened.pendingShoppers).toEqual([]);

    for (const tank of opened.tanks) {
      const armed = Object.entries(tank.inventory).filter(([, rounds]) => rounds > 0);
      expect(armed.length, `${tank.name} opened round one with nothing bought`).toBeGreaterThan(0);
    }
    expect(opened.tanks.find((tank) => tank.id === alice.id)?.inventory['missile']).toBe(
      humanAtShop?.inventory['missile'],
    );

    // …and the round is real: the shot goes off, fired from the shop's stock.
    const active = opened.tanks[opened.activeTank];
    if (active?.id === alice.id) {
      const cursor = alice.client.mark();
      send(alice.client.socket, {
        t: 'fire',
        turnNumber: opened.turnNumber,
        angleDeg: 45,
        power: 60,
        weapon: 'missile',
      });
      const frame = await alice.client.next((m) => m.t === 'events', cursor);
      expect(frame.t === 'events' && frame.events.some((event) => event.type === 'shot')).toBe(
        true,
      );
    }

    alice.client.close();
  });

  it('leaves the shop waiting for the person and nobody else', async () => {
    // Two machines and one person. Nothing about the room may depend on a bot
    // pressing a button, because a bot never will.
    const room = 'ARMC';
    const alice = await join(room, 'Alice');
    for (const personality of ['shooter', 'annihilator']) {
      const before = alice.client.mark();
      send(alice.client.socket, { t: 'addBot', personality });
      await alice.client.next((m) => m.t === 'lobby', before);
    }

    send(alice.client.socket, { t: 'start' });
    const opening = await alice.client.next((m) => m.t === 'state');
    if (opening.t !== 'state') throw new Error('unreachable');
    expect(opening.snapshot.tanks).toHaveLength(3);
    expect(opening.snapshot.pendingShoppers).toEqual([alice.id]);
    for (const tank of opening.snapshot.tanks) {
      if (tank.id === alice.id) continue;
      expect(Object.keys(tank.inventory).length, `${tank.name} did not shop`).toBeGreaterThan(0);
    }

    alice.client.close();
  });

  it('closes the armoury on the shop clock, not the turn clock', async () => {
    // A player who walks off in the armoury must not freeze the match, and the
    // clock they are on is the shop's — the longer of the two, because reading
    // an arsenal takes longer than picking an angle.
    const room = 'ARMD';
    const { seats } = await startArmoury(room, ['Alice', 'Bob']);
    const [alice, bob] = seats as [Seat, Seat];

    const row = await readTurnRow(room);
    expect(row.phase).toBe('shopping');
    expect(row.deadlineAt).not.toBeNull();
    const left = (row.deadlineAt as number) - Date.now();
    expect(left).toBeLessThanOrEqual(SHOP_TIMEOUT_MS);
    expect(left).toBeGreaterThan(TURN_TIMEOUT_MS);

    // Nobody presses anything; the clock closes it and round one starts anyway.
    expect(await runDurableObjectAlarm(stub(room))).toBe(true);
    const forced = await bob.client.next((m) => m.t === 'events');
    if (forced.t !== 'events') throw new Error('unreachable');
    expect(forced.snapshot.phase).toBe('aiming');
    expect(forced.snapshot.round).toBe(1);

    alice.client.close();
    bob.client.close();
  });
});

describe('end of match', () => {
  it('refuses moves after the last round and lets the host run it back', async () => {
    const room = 'HHHA';
    const { alice, bob, shooter, snapshot } = await twoPlayerMatch(room);

    await editPersistedGame(room, (game) => ({
      ...game,
      phase: 'gameover',
      winnerId: game.tanks[0]?.id ?? null,
    }));

    // A finished match takes no more input …
    send(shooter.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    const error = await shooter.client.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('wrong_phase');
    expect((await info(room)).inProgress).toBe(false);

    // … but it is not a dead room: the host can start a rematch, and the new
    // match is a different match, not a replay of the old one.
    const again = await rematch(alice, [alice, bob]);
    expect(again.seed).not.toBe(snapshot.seed);
    expect(again.tanks.every((tank) => tank.health > 0)).toBe(true);
    expect(again.phase).toBe('aiming');

    alice.client.close();
    bob.client.close();
  });

  it('lets a newcomer take a seat once the match is over', async () => {
    const room = 'HHHB';
    const { alice, bob } = await twoPlayerMatch(room);
    await editPersistedGame(room, (game) => ({ ...game, phase: 'gameover' }));

    const carol = await join(room, 'Carol');
    expect(carol.role).toBe('player');
    expect((await info(room)).players).toBe(3);

    alice.client.close();
    bob.client.close();
    carol.client.close();
  });

  it('publishes a final scoreboard, and counts the rounds each player won', async () => {
    const room = 'HHHC';
    const { alice, bob, shooter, snapshot } = await twoPlayerMatch(room);

    // One turn away from the end: it is the final round and the player about to
    // shoot is the last tank standing, so resolving this turn ends the match.
    // The survivor's health is set far above anything one shot can take off, so
    // this test is about the scoreboard and never about whether the shooter
    // happened to blow itself up — `roundsWon` needs a survivor to exist.
    await editPersistedGame(room, (game) => ({
      ...game,
      round: game.totalRounds,
      tanks: game.tanks.map((tank, index) => ({
        ...tank,
        alive: index === game.activeTank,
        health: index === game.activeTank ? 5000 : 0,
      })),
    }));

    send(shooter.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });

    const result = await bob.client.next((m) => m.t === 'matchResult');
    expect(result.t).toBe('matchResult');
    if (result.t === 'matchResult') {
      expect(result.standings).toHaveLength(2);
      expect(result.standings[0]?.place).toBe(1);
      expect(result.standings.map((row) => row.playerId).sort()).toEqual([alice.id, bob.id].sort());

      // The last tank standing won the round, and the room counted it. This was
      // unpinned: with the tally made a no-op, `roundsWon` shipped a permanent
      // zero and no test noticed.
      const survivor = result.standings.find((row) => row.playerId === shooter.id);
      const loser = result.standings.find((row) => row.playerId !== shooter.id);
      expect(survivor?.roundsWon).toBe(1);
      expect(loser?.roundsWon).toBe(0);
      expect(survivor?.place).toBe(1);
      expect(result.winnerId).toBe(shooter.id);
    }

    alice.client.close();
    bob.client.close();
  });

  it('gives an equal score an equal place', async () => {
    const room = 'HHHD';
    const { seats, snapshot } = await startMatch('HHHD', ['Ann', 'Ben', 'Cal']);
    const shooter = activeSeat(seats, snapshot);

    // Two tanks out on the same score, one survivor. Standard competition
    // ranking calls that 1, 2, 2 — plain ordinal ranking calls it 1, 2, 3, and
    // tells the player in third that they lost to somebody they tied with.
    await editPersistedGame(room, (game) => ({
      ...game,
      round: game.totalRounds,
      tanks: game.tanks.map((tank, index) => ({
        ...tank,
        alive: index === game.activeTank,
        health: index === game.activeTank ? 5000 : 0,
        score: index === game.activeTank ? tank.score : 0,
      })),
    }));

    send(shooter.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });

    const result = await (seats[1] as Seat).client.next((m) => m.t === 'matchResult');
    expect(result.t).toBe('matchResult');
    if (result.t === 'matchResult') {
      const standings = result.standings;
      expect(standings).toHaveLength(3);
      // There is a genuine tie in here, or this test proves nothing at all.
      expect(new Set(standings.map((row) => row.score)).size).toBeLessThan(standings.length);
      // Competition ranking: your place is the position of the first player on
      // your score, so equal scores share a place and the next one skips.
      for (const row of standings) {
        const firstOnThatScore =
          standings.findIndex((candidate) => candidate.score === row.score) + 1;
        expect(row.place, `place for score ${row.score}`).toBe(firstOnThatScore);
      }
    }

    for (const seat of seats) seat.client.close();
  });
});

// ---------------------------------------------------------------------------
// The ending has to reach everybody
// ---------------------------------------------------------------------------

/**
 * Finish a match by resolving one shot, and hand back the seats.
 *
 * The board is doctored to the last round with one tank standing and enough
 * health on it that no shot can take it out, so resolving ANY turn ends the
 * match with a winner. Scripting a kill instead would make these tests about
 * aiming, which is not what they are for.
 */
async function finishMatch(
  room: string,
  names: readonly string[],
): Promise<{ seats: Seat[]; winnerId: string }> {
  const { seats, snapshot } = await startMatch(room, names);
  const shooter = activeSeat(seats, snapshot);

  await editPersistedGame(room, (game) => ({
    ...game,
    round: game.totalRounds,
    tanks: game.tanks.map((tank, index) => ({
      ...tank,
      alive: index === game.activeTank,
      health: index === game.activeTank ? 5000 : 0,
    })),
  }));

  send(shooter.client.socket, {
    t: 'fire',
    turnNumber: snapshot.turnNumber,
    angleDeg: 45,
    power: 70,
    weapon: 'baby_missile',
  });
  for (const seat of seats) await seat.client.next((m) => m.t === 'matchResult');
  return { seats, winnerId: shooter.id };
}

describe('the ending is visible and final', () => {
  it('tells every client in the room the same result, unprompted', async () => {
    /*
     * Not "the shooter finds out". A match ends for everybody at once, and the
     * losers are the ones who need telling.
     */
    const room = 'ENDA';
    const { seats, winnerId } = await finishMatch(room, ['Alice', 'Bob', 'Carol']);

    const results = seats.map((seat) => {
      const frame = seat.client.since().find((m) => m.t === 'matchResult');
      expect(frame, `${seat.id} was never told the match ended`).toBeDefined();
      return frame as Extract<ServerMessage, { t: 'matchResult' }>;
    });

    for (const result of results) {
      expect(result.winnerId).toBe(winnerId);
      expect(result.standings).toHaveLength(3);
      expect(result.standings[0]?.place).toBe(1);
      expect(result.standings.map((row) => row.playerId).sort()).toEqual(
        seats.map((seat) => seat.id).sort(),
      );
    }
    // Byte-identical, not merely consistent: three clients drawing three
    // different scoreboards for one match is the failure this rules out.
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);

    // And the sim's own verdict, on the wire, agrees with the scoreboard.
    const finalState = seats[0]?.client
      .since()
      .filter((m) => m.t === 'events')
      .pop();
    expect(finalState?.t === 'events' && finalState.snapshot.phase).toBe('gameover');
    expect(finalState?.t === 'events' && finalState.snapshot.winnerId).toBe(winnerId);
    expect(
      finalState?.t === 'events' && finalState.events.some((event) => event.type === 'gameOver'),
    ).toBe(true);

    for (const seat of seats) seat.client.close();
  });

  it('tells somebody who arrives after it is over, too', async () => {
    /*
     * `matchResult` used to be sent exactly once, at the moment the match
     * ended, so anyone who joined, reconnected or was a beat late in
     * handshaking got the final snapshot and no standings. That is not an empty
     * screen — a client can rank the snapshot by score — but the fallback
     * cannot know places or rounds won, so two people looking at the same
     * finished match saw two different scoreboards.
     */
    const room = 'ENDB';
    const { seats, winnerId } = await finishMatch(room, ['Alice', 'Bob']);
    const original = seats[0]?.client.since().find((m) => m.t === 'matchResult');

    const latecomer = await join(room, 'Dave');
    const state = await latecomer.client.next((m) => m.t === 'state');
    expect(state.t === 'state' && state.snapshot.phase).toBe('gameover');

    const told = await latecomer.client.next((m) => m.t === 'matchResult');
    expect(told.t).toBe('matchResult');
    expect(told.t === 'matchResult' && told.winnerId).toBe(winnerId);
    // The same scoreboard the room sent when it happened, not a reconstruction.
    expect(JSON.stringify(told)).toBe(JSON.stringify(original));

    // A returning seat holder gets it as well — the reconnect path and the
    // fresh-arrival path both run through `sendLiveState`.
    const back = await join(room, 'Alice', { sessionId: seats[0]?.secret });
    const again = await back.client.next((m) => m.t === 'matchResult');
    expect(JSON.stringify(again)).toBe(JSON.stringify(original));

    for (const seat of seats) seat.client.close();
    latecomer.client.close();
    back.client.close();
  });

  it('leaves a room that can be played again', async () => {
    // Final, not fatal. The match takes no more moves, and the host can run it
    // back — which is the only "play again" the room can offer.
    const room = 'ENDC';
    const { seats } = await finishMatch(room, ['Alice', 'Bob']);
    const [alice, bob] = seats as [Seat, Seat];

    expect((await info(room)).inProgress).toBe(false);

    const cursor = alice.client.mark();
    send(alice.client.socket, { t: 'buy', weapon: 'missile', quantity: 1 });
    const refusal = await alice.client.next((m) => m.t === 'error', cursor);
    expect(refusal.t === 'error' && refusal.code).toBe('wrong_phase');

    const again = await rematch(alice, [alice, bob]);
    expect(again.phase).toBe('aiming');
    expect(again.round).toBe(1);
    expect(again.tanks.every((tank) => tank.alive && tank.health > 0)).toBe(true);

    alice.client.close();
    bob.client.close();
  });
});

describe('persistence', () => {
  it('keeps a replay log that survives eviction and never grows without bound', async () => {
    const room = 'JJJA';
    const { alice, bob, shooter, snapshot } = await twoPlayerMatch(room);

    send(shooter.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    await shooter.client.next((m) => m.t === 'events');

    await evictDurableObject(stub(room));

    const rows = await runInDurableObject(stub(room), (_instance, state) =>
      state.storage.sql
        .exec<{ turn: number; match: number; events: string }>(
          'SELECT turn, match, events FROM replay_v2 ORDER BY seq',
        )
        .toArray(),
    );
    expect(rows.length).toBeGreaterThan(0);
    const last = rows[rows.length - 1];
    expect(last?.turn).toBe(snapshot.turnNumber);
    expect(last?.match).toBe(1);
    expect(JSON.parse(last?.events ?? '[]')).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'shot' })]),
    );

    alice.client.close();
    bob.client.close();
  });

  it('keeps every match in its own replay lane so a rematch cannot overwrite one', async () => {
    const room = 'JJJC';
    const { alice, bob, shooter, snapshot } = await twoPlayerMatch(room);

    send(shooter.client.socket, {
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    await shooter.client.next((m) => m.t === 'events');

    const first = await readReplay(room);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((row) => row.match === 1)).toBe(true);

    // Run it back. A rematch replays the same turn NUMBERS from the start, so
    // keyed by turn alone the second match overwrites the first row for row —
    // which is the entire reason `replay_v2` carries a match column and the old
    // `replay` table was dropped rather than migrated.
    await editPersistedGame(room, (game) => ({ ...game, phase: 'gameover' }));
    const rerun = await rematch(alice, [alice, bob]);

    const up = activeSeat([alice, bob], rerun);
    const upCursor = up.client.mark();
    send(up.client.socket, {
      t: 'fire',
      turnNumber: rerun.turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    await up.client.next((m) => m.t === 'events', upCursor);

    const rows = await readReplay(room);
    const second = rows.filter((row) => row.match === 2);
    expect(second.length).toBeGreaterThan(0);
    // The collision really happened: one turn number, two matches, both rows
    // still there.
    const collidingTurn = (second[0] as { turn: number }).turn;
    // A SET, not a list: the row that opens a round and the row for the first
    // shot of that round both carry the round's opening turn number, so match 1
    // legitimately has two rows at turn 1. What is being tested is that a
    // rematch did not overwrite them, and that is about which MATCHES are
    // present, not how many rows each contributed.
    expect(
      new Set(rows.filter((row) => row.turn === collidingTurn).map((row) => row.match)),
    ).toEqual(new Set([1, 2]));

    alice.client.close();
    bob.client.close();
  });

  it('caps the replay log', async () => {
    const room = 'JJJB';
    const { alice, bob, snapshot } = await twoPlayerMatch(room);

    // Stuff the log past its cap directly — playing several hundred turns of
    // artillery to prove a DELETE runs would be a slow way to test a DELETE.
    await runInDurableObject(stub(room), (_instance, state) => {
      for (let i = 0; i < 400; i += 1) {
        state.storage.sql.exec(
          'INSERT INTO replay_v2 (match, turn, events) VALUES (?, ?, ?)',
          1,
          i,
          '[]',
        );
      }
    });

    const turnNumber = snapshot.turnNumber;
    const shooter = activeSeat([alice, bob], snapshot);

    send(shooter.client.socket, {
      t: 'fire',
      turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    await shooter.client.next((m) => m.t === 'events');

    const count = await runInDurableObject(stub(room), (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM replay_v2')
        .toArray();
      return rows[0]?.n ?? 0;
    });
    expect(count).toBeLessThanOrEqual(201);

    alice.client.close();
    bob.client.close();
  });
});

// ---------------------------------------------------------------------------
// Computer players
//
// The reason this section exists: `packages/sim` grew a whole AI, with a
// personality table and a measured difficulty ladder, and NOTHING referenced it
// outside its own tests. A bot seat could not be created, nothing called
// `chooseShot` when a turn came round, nothing took a bot through the shop —
// so "a solo human plus one bot is a playable match" was not merely untested,
// it was unconstructible. These tests are the feature, not the polish.
// ---------------------------------------------------------------------------

/** Seat one person plus one computer player and start the match. */
async function soloVersusBot(
  roomCode: string,
  personality?: string,
): Promise<{ alice: Seat; botId: string; snapshot: GameSnapshot }> {
  const alice = await join(roomCode, 'Alice');
  send(
    alice.client.socket,
    personality === undefined ? { t: 'addBot' } : { t: 'addBot', personality },
  );

  const lobby = await alice.client.next((m) => m.t === 'lobby' && m.players.length === 2);
  if (lobby.t !== 'lobby') throw new Error('unreachable');
  const seat = lobby.players.find((player) => player.bot != null);
  if (seat === undefined) throw new Error('no computer player was seated');

  send(alice.client.socket, { t: 'start' });
  const started = await alice.client.next((m) => m.t === 'state');
  if (started.t !== 'state') throw new Error('unreachable');
  // The match opens in the armoury. The computer player shopped and left on the
  // way through `start`; the human has to press Ready, and that is what opens
  // round one.
  expect(started.snapshot.phase).toBe('shopping');
  expect(started.snapshot.pendingShoppers).toEqual([alice.id]);
  const opened = await leaveArmoury([alice]);
  return { alice, botId: seat.id, snapshot: opened };
}

/** The shot the sim says this seat takes, derived from what the room persisted. */
async function predictedBotShot(
  roomCode: string,
): Promise<{ angleDeg: number; power: number; weapon: string; tankIndex: number }> {
  const game = fromPersisted(await readPersistedGame(roomCode));
  return { ...chooseShot(game, game.activeTank), tankIndex: game.activeTank };
}

/** Hand the turn on by firing a throwaway shot. Returns the state it left. */
async function passTurn(seat: Seat, snapshot: GameSnapshot): Promise<GameSnapshot> {
  const cursor = seat.client.mark();
  send(seat.client.socket, {
    t: 'fire',
    turnNumber: snapshot.turnNumber,
    angleDeg: 45,
    power: 55,
    weapon: 'baby_missile',
  });
  const frame = await seat.client.next((m) => m.t === 'events', cursor);
  if (frame.t !== 'events') throw new Error('unreachable');
  return frame.snapshot;
}

/**
 * A match in which every seat is a computer player, watched by a spectator and
 * played by nobody.
 *
 * The last step is white-box and deliberately so. There is no wire message for
 * "hand my chair to a machine" and there should not be — a room is opened by a
 * person and `addBot` fills the other chairs. What the ROOM has to survive is
 * the resulting STATE: a board on which nothing is waiting for a socket. That
 * state is one field away from a lobby anybody can build, and reaching it
 * honestly would mean playing a human seat to death and then keeping it dead
 * across a round boundary, which `startNextRound` correctly refuses to do.
 *
 * `personalities[0]` is the brain the opening seat is handed; the rest arrive
 * through `addBot` like any other. The host's socket is closed on the way out,
 * so what comes back is a room with an audience and no players in it at all.
 */
async function allBotMatch(
  roomCode: string,
  personalities: readonly [string, ...string[]],
): Promise<{ viewer: Seat; botCount: number }> {
  const alice = await join(roomCode, 'Alice');
  const [hostBrain, ...added] = personalities;

  for (let index = 0; index < added.length; index += 1) {
    send(alice.client.socket, { t: 'addBot', personality: added[index] });
    await alice.client.next((m) => m.t === 'lobby' && m.players.length === index + 2);
  }
  send(alice.client.socket, { t: 'start' });
  await alice.client.next((m) => m.t === 'state');
  // Out of the armoury first, and with a human still holding a seat: the shop
  // waits for a socket, and a seat that has just been turned into a machine
  // does not have one.
  await leaveArmoury([alice]);

  await editPersistedGame(roomCode, (game) => ({
    ...game,
    tanks: game.tanks.map((tank) =>
      tank.bot === null
        ? { ...tank, bot: hostBrain as PersistedGame['tanks'][number]['bot'] }
        : tank,
    ),
  }));

  const viewer = await join(roomCode, 'Viewer', { role: 'spectator' });
  alice.client.close();
  await waitForSocketCount(roomCode, 1);
  return { viewer, botCount: personalities.length };
}

/**
 * The room's own seat table.
 *
 * A refusal is only a refusal if the seat is still there afterwards: a `lobby`
 * frame that never arrives proves nothing, and `info` counts seats without
 * saying which of them are machines.
 */
async function readSeats(roomCode: string): Promise<{ id: string; bot: string | null }[]> {
  const raw = await runInDurableObject(stub(roomCode), (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', 'players')
      .toArray();
    return rows[0]?.v ?? '[]';
  });
  return (JSON.parse(raw) as { id: string; bot?: string | null }[]).map((player) => ({
    id: player.id,
    bot: player.bot ?? null,
  }));
}

/** Who the room believes is host. Null until a seated player is connected. */
async function readHostId(roomCode: string): Promise<string | null> {
  const raw = await runInDurableObject(stub(roomCode), (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', 'meta')
      .toArray();
    return rows[0]?.v;
  });
  return raw === undefined ? null : ((JSON.parse(raw) as { hostId: string | null }).hostId ?? null);
}

/** Rewrite the room's small clock row — the only way to move a deadline. */
async function editTurnRow(
  roomCode: string,
  edit: (turn: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await runInDurableObject(stub(roomCode), (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', 'turn')
      .toArray();
    const raw = rows[0]?.v;
    if (raw === undefined) throw new Error('no turn row to edit');
    state.storage.sql.exec(
      'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      'turn',
      JSON.stringify(edit(JSON.parse(raw) as Record<string, unknown>)),
    );
  });
}

describe('computer players', () => {
  it('lets one person start a match, which is the whole point of them', async () => {
    const room = 'BOTA';
    const { alice, botId, snapshot } = await soloVersusBot(room);

    expect(snapshot.tanks).toHaveLength(2);
    expect(snapshot.tanks.map((tank) => tank.id)).toContain(botId);
    // The bot is a seat like any other as far as the room is concerned.
    const room_info = await info(room);
    expect(room_info.players).toBe(2);
    expect(room_info.inProgress).toBe(true);

    // …and the personality reached the sim, which is the part that matters: a
    // seat labelled "Shooter" that the sim believes is a human never takes a
    // turn, and the lobby would look right the whole time.
    const persisted = await readPersistedGame(room);
    expect(persisted.tanks.find((tank) => tank.id === botId)?.bot).toBe('shooter');
    expect(persisted.tanks.find((tank) => tank.id === alice.id)?.bot).toBe(null);

    alice.client.close();
  });

  it('honours the personality the lobby asked for', async () => {
    const room = 'BOTB';
    const { alice, botId } = await soloVersusBot(room, 'annihilator');
    const persisted = await readPersistedGame(room);
    expect(persisted.tanks.find((tank) => tank.id === botId)?.bot).toBe('annihilator');
    alice.client.close();
  });

  it('takes its turn, and fires exactly what the sim decided', async () => {
    const room = 'BOTC';
    const { alice, botId, snapshot } = await soloVersusBot(room, 'cyborg');

    // Whoever the sim put first, get the turn to the bot.
    if (snapshot.tanks[snapshot.activeTank]?.id !== botId) await passTurn(alice, snapshot);

    const before = await readPersistedGame(room);
    expect(before.tanks[before.activeTank]?.id).toBe(botId);
    // Derived from the room's own storage by the same pure function the room is
    // about to call. If the room aimed by any other means, this is where it
    // shows up.
    const expected = await predictedBotShot(room);

    const cursor = alice.client.mark();
    expect(await runDurableObjectAlarm(stub(room)), 'the bot should have an alarm').toBe(true);
    const frame = await alice.client.next((m) => m.t === 'events', cursor);
    if (frame.t !== 'events') throw new Error('unreachable');

    const shot = frame.events.find((event) => event.type === 'shot');
    expect(shot?.type === 'shot' ? shot.tankIndex : null).toBe(expected.tankIndex);
    expect(shot?.type === 'shot' ? shot.weapon : null).toBe(expected.weapon);

    // `fire()` writes the aim it resolved back onto the tank, so the snapshot
    // carries the exact numbers — to the last bit, not to a tolerance.
    const tank = frame.snapshot.tanks[expected.tankIndex];
    expect(tank?.angleDeg).toBe(expected.angleDeg);
    expect(tank?.power).toBe(expected.power);
    // And the match moved on: the turn came back to the human.
    expect(frame.snapshot.turnNumber).toBe(before.turnNumber + 1);
    expect(frame.snapshot.tanks[frame.snapshot.activeTank]?.id).toBe(alice.id);

    alice.client.close();
  });

  it('paces a computer player like an opponent thinking, not like a wait', async () => {
    /*
     * Pacing, measured without waiting for any of it.
     *
     * The pause in front of a bot's shot used to be a flat 1500 ms, which over
     * a bot-only match of dozens of turns is most of the match spent watching
     * nothing. Two things had to be true to shorten it, and both are asserted
     * here rather than argued:
     *
     *  - it is SHORT. Every personality pauses for well under a second and a
     *    half, so the dead air is gone.
     *  - it VARIES, and in an order that means something. A metronome at any
     *    speed reads as a machine waiting; a Moron that snaps off a shot and an
     *    Annihilator that takes a beat over it read as two different opponents.
     *    The Moron does not aim at all — that is its whole personality — so it
     *    is the one that must be quickest.
     *
     * Read off the pure function the room schedules with, so nothing here sits
     * through a real delay, and stated as relationships rather than as the
     * millisecond counts, which a test that repeated them would not be testing.
     */
    const delays = BOT_PERSONALITIES.map((personality) => ({
      personality,
      ms: BOT_TURN_DELAY_MS[personality],
    }));

    for (const { personality, ms } of delays) {
      expect(ms, `${personality} pauses for ${ms}ms`).toBeGreaterThan(0);
      // Comfortably inside a second and a half, which is where this started.
      expect(ms, `${personality} pauses for ${ms}ms`).toBeLessThan(1_200);
      // And nowhere near a human's turn clock: this is pacing, not thinking.
      expect(ms).toBeLessThan(TURN_TIMEOUT_MS / 10);
    }

    // Not a metronome.
    expect(new Set(delays.map((row) => row.ms)).size).toBeGreaterThan(2);
    // The one that does not aim is the one that does not pause.
    const quickest = delays.reduce((a, b) => (b.ms < a.ms ? b : a));
    expect(quickest.personality).toBe('moron');
    expect(BOT_TURN_DELAY_MS.annihilator).toBeGreaterThan(BOT_TURN_DELAY_MS.moron * 2);
  });

  it('gives each seat the pause its own personality asks for', async () => {
    /*
     * The table above is only pacing if the room reads it per seat. A room that
     * scheduled every bot on one number would pass every assertion in the test
     * above and pace nothing, so this one goes through the real alarm: seat two
     * different personalities and compare the gap each of them is given.
     *
     * `botTurnDelayMs` is the function the room schedules with, and it is
     * applied to the room's OWN persisted state — not to a state built here —
     * so the two cannot drift apart.
     *
     * The gap the room actually leaves is this pause PLUS the animation of the
     * turn it just sent — that is the next test — so what is checked here is
     * that the personality half of it is present and is the seat's own.
     */
    const room = 'PACE';
    const alice = await join(room, 'Alice');
    for (const personality of ['moron', 'annihilator']) {
      const before = alice.client.mark();
      send(alice.client.socket, { t: 'addBot', personality });
      await alice.client.next((m) => m.t === 'lobby', before);
    }
    send(alice.client.socket, { t: 'start' });
    await alice.client.next((m) => m.t === 'state');
    let snapshot = await leaveArmoury([alice]);
    let lastEvents = lastEventsFrame(alice);

    const seen = new Map<string, number>();
    // Walk the turn round the table, reading the alarm on every bot turn.
    for (let turn = 0; turn < 6 && seen.size < 2; turn += 1) {
      const game = fromPersisted(await readPersistedGame(room));
      const active = game.tanks[game.activeTank];
      const pause = botTurnDelayMs(game);

      if (pause === null) {
        expect(active?.id).toBe(alice.id);
        snapshot = await passTurn(alice, snapshot);
        lastEvents = lastEventsFrame(alice);
        continue;
      }

      const alarmAt = await runInDurableObject(stub(room), (_instance, state) =>
        state.storage.getAlarm(),
      );
      const deadline = (await readTurnRow(room)).deadlineAt as number;
      expect(alarmAt).not.toBeNull();
      /*
       * The alarm is the gap, not the turn clock. `deadlineAt` was written from
       * the same `Date.now()` that set the alarm, so subtracting the clock's
       * own length recovers the instant the room armed it — no wall-clock
       * reading from out here, and therefore no round trip in the measurement.
       */
      const gap = (alarmAt as number) - (deadline - TURN_TIMEOUT_MS);
      expect(gap).toBe(pause + estimatePlaybackMs(lastEvents));
      seen.set(active?.bot ?? '', pause);

      const cursor = alice.client.mark();
      expect(await runDurableObjectAlarm(stub(room))).toBe(true);
      const frame = await alice.client.next((m) => m.t === 'events', cursor);
      if (frame.t !== 'events') throw new Error('unreachable');
      snapshot = frame.snapshot;
      lastEvents = frame.events;
    }

    expect([...seen.keys()].sort()).toEqual(['annihilator', 'moron']);
    // The two seats really were paced differently, by the room, on real alarms.
    expect(seen.get('moron')).toBeLessThan(seen.get('annihilator') as number);

    alice.client.close();
  });

  it('never lets a computer player outrun the turn the client is still animating', async () => {
    /*
     * The regression this whole pacing split exists for, stated as the property
     * a player would notice.
     *
     * `BOT_TURN_DELAY_MS` is 400–1000 ms per personality and a turn takes
     * roughly 840–1500 ms to animate. `BattleScene` queues turns with a backlog
     * of exactly ONE and drops the older one when overtaken — a sound design,
     * and the reason the board stays correct — so a server that outruns
     * playback does not corrupt anything. It just means the player never sees a
     * share of the shots, and the game reads as skipping. With three computer
     * players in the room that was the normal case, not an edge one.
     *
     * So: walk a real match on real alarms, and for every hand-off from one
     * machine to another require the gap the room scheduled to be at least the
     * animation cost of the frame it just broadcast. Measured, not waited for —
     * the whole point of `estimatePlaybackMs` being a pure function is that this
     * test costs milliseconds.
     */
    const room = 'PACB';
    const alice = await join(room, 'Alice');
    for (const personality of ['shooter', 'cyborg', 'annihilator']) {
      const before = alice.client.mark();
      send(alice.client.socket, { t: 'addBot', personality });
      await alice.client.next((m) => m.t === 'lobby', before);
    }
    send(alice.client.socket, { t: 'start' });
    await alice.client.next((m) => m.t === 'state');
    let snapshot = await leaveArmoury([alice]);

    /** Every bot-to-bot hand-off seen, as (animation, whole gap). */
    const handoffs: { playbackMs: number; gapMs: number; pauseMs: number }[] = [];

    for (let turn = 0; turn < 10 && handoffs.length < 4; turn += 1) {
      const game = fromPersisted(await readPersistedGame(room));
      if (botTurnDelayMs(game) === null) {
        snapshot = await passTurn(alice, snapshot);
        continue;
      }

      // Take the bot's turn and keep the frame the room sent for it.
      const cursor = alice.client.mark();
      expect(await runDurableObjectAlarm(stub(room))).toBe(true);
      const frame = await alice.client.next((m) => m.t === 'events', cursor);
      if (frame.t !== 'events') throw new Error('unreachable');
      snapshot = frame.snapshot;

      // …then look at what the room scheduled for whoever is up next.
      const next = fromPersisted(await readPersistedGame(room));
      const pause = botTurnDelayMs(next);
      if (pause === null) continue; // handed back to the human: a clock, not pacing

      const alarmAt = await runInDurableObject(stub(room), (_instance, state) =>
        state.storage.getAlarm(),
      );
      const deadline = (await readTurnRow(room)).deadlineAt as number;
      expect(alarmAt).not.toBeNull();

      handoffs.push({
        playbackMs: estimatePlaybackMs(frame.events),
        gapMs: (alarmAt as number) - (deadline - TURN_TIMEOUT_MS),
        pauseMs: pause,
      });
    }

    expect(handoffs.length, 'no machine ever handed over to another machine').toBeGreaterThan(0);

    for (const { playbackMs, gapMs, pauseMs } of handoffs) {
      // The turn really does take a visible amount of time to watch, so the
      // assertion below is not being satisfied by an empty frame.
      expect(playbackMs, 'a real turn animated for no time at all').toBeGreaterThan(300);
      // The fix: the animation is paid for, and the personality pause is on top.
      expect(gapMs).toBeGreaterThanOrEqual(playbackMs);
      expect(gapMs).toBe(playbackMs + pauseMs);
    }

    /*
     * …and the defect itself, measured rather than asserted from the report: a
     * real turn outlasts the shortest pause in the table, so a room that paced
     * on the pause alone would be handing the next machine the board while the
     * client was still drawing the last one.
     */
    const longest = Math.max(...handoffs.map((handoff) => handoff.playbackMs));
    const quickest = Math.min(...Object.values(BOT_TURN_DELAY_MS));
    expect(longest, 'no turn here animates for longer than the quickest pause').toBeGreaterThan(
      quickest,
    );

    alice.client.close();
  });

  it('schedules a bot turn long before the clock that would take it away', async () => {
    /*
     * A bot does not need thinking time, so the alarm on its turn is pacing —
     * long enough for a human to see whose turn it is and for the client to
     * finish animating the last shot, and nothing like the 60 seconds a person
     * gets. The pair of assertions is the point: on the bot's turn the alarm is
     * far earlier than the deadline, and on the human's turn it IS the deadline.
     *
     * Stated as a relationship rather than as the constant, because a test that
     * repeated `BOT_TURN_DELAY_MS` would pass whatever the room scheduled.
     */
    const room = 'BOTP';
    const { alice, botId, snapshot } = await soloVersusBot(room, 'shooter');
    if (snapshot.tanks[snapshot.activeTank]?.id !== botId) await passTurn(alice, snapshot);

    const persisted = await readPersistedGame(room);
    expect(persisted.tanks[persisted.activeTank]?.id, 'the bot should be up').toBe(botId);

    const botAlarm = await runInDurableObject(stub(room), (_instance, state) =>
      state.storage.getAlarm(),
    );
    const botTurn = await readTurnRow(room);
    expect(botAlarm).not.toBeNull();
    expect(botTurn.deadlineAt).not.toBeNull();
    // Not merely earlier — most of a turn clock earlier.
    expect((botTurn.deadlineAt as number) - (botAlarm as number)).toBeGreaterThan(
      TURN_TIMEOUT_MS / 2,
    );

    // Now hand the turn back to the human and look again: the alarm is the
    // turn clock itself, exactly as it was before bots existed.
    await runDurableObjectAlarm(stub(room));
    await alice.client.next((m) => m.t === 'events');
    const humanAlarm = await runInDurableObject(stub(room), (_instance, state) =>
      state.storage.getAlarm(),
    );
    const humanTurn = await readTurnRow(room);
    expect(humanAlarm).toBe(humanTurn.deadlineAt);

    alice.client.close();
  });

  it('takes the same turn after the object has been evicted mid-turn', async () => {
    /*
     * The hibernation case, and the reason `chooseShot` is a pure function of
     * persisted state rather than something the room works out and remembers.
     *
     * A bot's turn is a gap between invocations by construction: the room
     * commits the previous turn, arms the alarm, and can be evicted while the
     * delay runs. What wakes up remembers nothing. So the decision is taken
     * from SQLite, and the shot has to be the one predicted from the state as
     * it stood BEFORE the eviction.
     */
    const room = 'BOTD';
    const { alice, botId, snapshot } = await soloVersusBot(room, 'annihilator');

    if (snapshot.tanks[snapshot.activeTank]?.id !== botId) await passTurn(alice, snapshot);

    const expected = await predictedBotShot(room);
    const before = await readPersistedGame(room);

    // Nothing in memory survives this.
    await evictDurableObject(stub(room));

    const cursor = alice.client.mark();
    expect(await runDurableObjectAlarm(stub(room))).toBe(true);
    const frame = await alice.client.next((m) => m.t === 'events', cursor);
    if (frame.t !== 'events') throw new Error('unreachable');

    const tank = frame.snapshot.tanks[expected.tankIndex];
    expect(tank?.angleDeg).toBe(expected.angleDeg);
    expect(tank?.power).toBe(expected.power);
    expect(frame.snapshot.turnNumber).toBe(before.turnNumber + 1);

    alice.client.close();
  });

  it('shops between rounds without anybody driving it', async () => {
    const room = 'BOTE';
    const { alice, botId } = await soloVersusBot(room, 'annihilator');

    /*
     * Put the match one shot away from the end of the round: the human's tank
     * is out, so whatever the bot fires, `fire()` finds one tank standing and
     * closes the round. That is the honest way to reach the shop from here —
     * the alternative is scripting a kill, which makes this a test about aiming.
     */
    await editPersistedGame(room, (game) => {
      const botIndex = game.tanks.findIndex((tank) => tank.id === botId);
      return {
        ...game,
        phase: 'aiming',
        activeTank: botIndex,
        tanks: game.tanks.map((tank) =>
          tank.id === botId ? tank : { ...tank, alive: false, health: 0 },
        ),
      };
    });

    const beforeMoney = (await readPersistedGame(room)).tanks.find((tank) => tank.id === botId)
      ?.money as number;

    const cursor = alice.client.mark();
    expect(await runDurableObjectAlarm(stub(room))).toBe(true);
    await alice.client.next((m) => m.t === 'events', cursor);

    const after = await readPersistedGame(room);
    const bot = after.tanks.find((tank) => tank.id === botId);
    expect(after.phase).toBe('shopping');
    // It bought something, and it paid for it.
    expect(Object.keys(bot?.inventory ?? {}).length).toBeGreaterThan(0);
    expect(bot?.money as number).toBeLessThan(beforeMoney);
    // And it is out of the shop, so the room is waiting for the human alone
    // rather than for a seat that is never going to press a button.
    expect(after.pendingShoppers).not.toContain(botId);
    expect(after.pendingShoppers).toContain(alice.id);

    alice.client.close();
  });

  it('keeps playing the round out once the last human is out of it', async () => {
    // A dead human and two bots: nobody is left to send a frame, and the match
    // still has to finish. It does, on the alarm, one turn at a time.
    const room = 'BOTF';
    const alice = await join(room, 'Alice');
    send(alice.client.socket, { t: 'addBot', personality: 'cyborg' });
    await alice.client.next((m) => m.t === 'lobby' && m.players.length === 2);
    send(alice.client.socket, { t: 'addBot', personality: 'tosser' });
    await alice.client.next((m) => m.t === 'lobby' && m.players.length === 3);
    send(alice.client.socket, { t: 'start' });
    await alice.client.next((m) => m.t === 'state');

    await editPersistedGame(room, (game) => {
      const first = game.tanks.find((tank) => tank.bot != null);
      if (first === undefined) throw new Error('no bots seated');
      return {
        ...game,
        phase: 'aiming',
        activeTank: game.tanks.indexOf(first),
        tanks: game.tanks.map((tank) =>
          tank.id === alice.id ? { ...tank, alive: false, health: 0 } : tank,
        ),
      };
    });

    const start = (await readPersistedGame(room)).turnNumber;
    for (let turn = 0; turn < 3; turn += 1) {
      const cursor = alice.client.mark();
      if (!(await runDurableObjectAlarm(stub(room)))) break;
      await alice.client.next((m) => m.t === 'events' || m.t === 'error', cursor);
      if ((await readPersistedGame(room)).phase !== 'aiming') break;
    }

    const after = await readPersistedGame(room);
    // Turns were played — or the round ended early because one of them landed
    // a hit, which is also the match progressing without a human in it.
    expect(after.turnNumber > start || after.phase !== 'aiming').toBe(true);

    alice.client.close();
  });

  it('refuses a computer player to anyone who is not the host', async () => {
    const room = 'BOTG';
    const alice = await join(room, 'Alice');
    const bob = await join(room, 'Bob');

    send(bob.client.socket, { t: 'addBot' });
    const error = await bob.client.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('not_host');
    expect((await info(room)).players).toBe(2);

    alice.client.close();
    bob.client.close();
  });

  it('refuses a computer player once the match has started', async () => {
    const room = 'BOTH';
    const { alice } = await soloVersusBot(room);
    const cursor = alice.client.mark();
    send(alice.client.socket, { t: 'addBot' });
    const error = await alice.client.next((m) => m.t === 'error', cursor);
    expect(error.t === 'error' && error.code).toBe('wrong_phase');
    alice.client.close();
  });

  it('refuses a computer player when every seat is taken', async () => {
    const room = 'BOTI';
    const alice = await join(room, 'Alice');
    for (let seat = 1; seat < MAX_PLAYERS; seat += 1) {
      send(alice.client.socket, { t: 'addBot' });
      await alice.client.next((m) => m.t === 'lobby' && m.players.length === seat + 1);
    }
    expect((await info(room)).players).toBe(MAX_PLAYERS);

    const cursor = alice.client.mark();
    send(alice.client.socket, { t: 'addBot' });
    const error = await alice.client.next((m) => m.t === 'error', cursor);
    expect(error.t === 'error' && error.code).toBe('room_full');

    alice.client.close();
  });

  it('gives every computer player a name and a colour of its own', async () => {
    const room = 'BOTJ';
    const alice = await join(room, 'Alice');
    for (let seat = 1; seat <= 3; seat += 1) {
      send(alice.client.socket, { t: 'addBot', personality: 'moron' });
      await alice.client.next((m) => m.t === 'lobby' && m.players.length === seat + 1);
    }
    const lobby = await alice.client.next((m) => m.t === 'lobby' && m.players.length === 4);
    if (lobby.t !== 'lobby') throw new Error('unreachable');

    // Three Morons, three different names — a scoreboard with three identical
    // rows is unreadable, and the wire caps a name at 16 characters so the
    // numbering has to fit.
    const names = lobby.players.map((player) => player.name);
    expect(new Set(names).size).toBe(names.length);
    const colors = lobby.players.map((player) => player.colorIndex);
    expect(new Set(colors).size).toBe(colors.length);
    // The lobby says which seats are machines, which is what a UI needs to
    // draw them differently.
    expect(lobby.players.filter((player) => player.bot === 'moron')).toHaveLength(3);
    expect(lobby.players.find((player) => player.id === alice.id)?.bot ?? null).toBe(null);

    alice.client.close();
  });

  it('takes a computer player back out of the lobby', async () => {
    const room = 'BOTK';
    const alice = await join(room, 'Alice');
    send(alice.client.socket, { t: 'addBot' });
    const lobby = await alice.client.next((m) => m.t === 'lobby' && m.players.length === 2);
    if (lobby.t !== 'lobby') throw new Error('unreachable');
    const botId = lobby.players.find((player) => player.bot != null)?.id as string;

    send(alice.client.socket, { t: 'removeBot', playerId: botId });
    await alice.client.next((m) => m.t === 'lobby' && m.players.length === 1);
    expect((await info(room)).players).toBe(1);

    alice.client.close();
  });

  it('will not let removeBot be used to throw a person out', async () => {
    const room = 'BOTL';
    const alice = await join(room, 'Alice');
    const bob = await join(room, 'Bob');

    const cursor = alice.client.mark();
    send(alice.client.socket, { t: 'removeBot', playerId: bob.id });
    const error = await alice.client.next((m) => m.t === 'error', cursor);
    expect(error.t === 'error' && error.code).toBe('unknown_player');
    expect((await info(room)).players).toBe(2);

    alice.client.close();
    bob.client.close();
  });

  it('refuses a personality that does not exist, at the parser', async () => {
    const room = 'BOTM';
    const alice = await join(room, 'Alice');
    send(alice.client.socket, { t: 'addBot', personality: 'grandmaster' });
    const error = await alice.client.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('bad_message');
    expect((await info(room)).players).toBe(1);
    alice.client.close();
  });

  it('clears the computer players out when the last person leaves the lobby', async () => {
    const room = 'BOTN';
    const alice = await join(room, 'Alice');
    send(alice.client.socket, { t: 'addBot' });
    await alice.client.next((m) => m.t === 'lobby' && m.players.length === 2);

    alice.client.close();
    await waitForSocketCount(room, 0);
    // Not "one seat left holding a Shooter": an empty room for whoever walks in
    // next.
    expect((await info(room)).players).toBe(0);
  });

  it('never puts a computer player credential on the wire', async () => {
    // A bot seat carries a secret like any other seat, and it goes nowhere —
    // seeing it is the only thing that would let a client claim the seat. So
    // the whole conversation is searched for it.
    const room = 'BOTO';
    const alice = await join(room, 'Alice');
    send(alice.client.socket, { t: 'addBot' });
    await alice.client.next((m) => m.t === 'lobby' && m.players.length === 2);

    const secrets = await runInDurableObject(stub(room), (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', 'players')
        .toArray();
      const players = JSON.parse(rows[0]?.v ?? '[]') as { secret: string; bot: string | null }[];
      return players.filter((player) => player.bot !== null).map((player) => player.secret);
    });
    expect(secrets).toHaveLength(1);

    const traffic = JSON.stringify(alice.client.all());
    for (const secret of secrets) expect(traffic).not.toContain(secret);

    alice.client.close();
  });

  it('fires with nobody sending anything, and every client sees the same frame', async () => {
    /*
     * The determinism claim, tested where it is actually load-bearing.
     *
     * Every client renders by replaying the authoritative event stream, so two
     * clients that receive different bytes for the same turn will draw
     * different craters and eventually disagree about who died. A bot's turn is
     * the interesting case because nobody TYPED it: the frame is built from a
     * decision the room made on its own, and if that decision were computed
     * per-socket, or re-derived once per send, this is where it would show.
     *
     * So the whole frame is compared, not the shot — the events AND the
     * authoritative snapshot inside them, heightmap column for heightmap
     * column, after both ends have parsed it.
     */
    const room = 'BOTQ';
    const alice = await join(room, 'Alice');
    const bob = await join(room, 'Bob');
    send(alice.client.socket, { t: 'addBot', personality: 'cyborg' });
    await alice.client.next((m) => m.t === 'lobby' && m.players.length === 3);
    send(alice.client.socket, { t: 'start' });
    const started = await bob.client.next((m) => m.t === 'state');
    if (started.t !== 'state') throw new Error('unreachable');
    await alice.client.next((m) => m.t === 'state');
    // Both humans out of the armoury; the Cyborg shopped and left on its own.
    const opened = await leaveArmoury([alice, bob]);

    // Whoever the seed put first, walk the turn round to the machine.
    const humans = [alice, bob];
    let snapshot = opened;
    while (humans.some((seat) => seat.id === snapshot.tanks[snapshot.activeTank]?.id)) {
      snapshot = await passTurn(activeSeat(humans, snapshot), snapshot);
    }

    // Nothing is sent from here on. The only thing that happens is the clock.
    // Both clients are asked for the frame BY TURN NUMBER rather than by a
    // cursor: the two sockets are real and deliver independently, so "the next
    // frame Bob happens to have" is not necessarily the same turn as Alice's.
    const botTurn = snapshot.turnNumber;
    expect(await runDurableObjectAlarm(stub(room))).toBe(true);

    const seen = await alice.client.next((m) => m.t === 'events' && m.turnNumber === botTurn);
    const alsoSeen = await bob.client.next((m) => m.t === 'events' && m.turnNumber === botTurn);
    expect(seen).toEqual(alsoSeen);

    if (seen.t !== 'events') throw new Error('unreachable');
    const shot = seen.events.find((event) => event.type === 'shot');
    expect(shot, 'the bot should have fired').toBeDefined();
    // …and it really was the machine's turn that got played.
    expect(shot?.type === 'shot' ? shot.tankIndex : null).toBe(snapshot.activeTank);

    alice.client.close();
    bob.client.close();
  });

  it('refuses to take a computer player out once the match has started', async () => {
    // The mirror of the `addBot` refusal, and the more dangerous one: the seat
    // already holds a tank, an inventory and a wallet, and the sim indexes
    // tanks by position. Removing one mid-match would not free a chair, it
    // would renumber the board underneath every client's replay.
    const room = 'BOTR';
    const { alice, botId } = await soloVersusBot(room);

    const cursor = alice.client.mark();
    send(alice.client.socket, { t: 'removeBot', playerId: botId });
    const error = await alice.client.next((m) => m.t === 'error', cursor);
    expect(error.t === 'error' && error.code).toBe('wrong_phase');

    expect((await readPersistedGame(room)).tanks.map((tank) => tank.id)).toContain(botId);
    expect((await info(room)).players).toBe(2);

    alice.client.close();
  });

  it('never lets the turn clock take a computer player’s turn away', async () => {
    /*
     * "A bot must never be starved by the turn timer."
     *
     * The turn row still carries the ordinary 60 second deadline on a bot's
     * turn — the bot is simply scheduled to fire long before it — so the
     * failure mode is not hypothetical: get the ordering wrong in `alarm()`
     * and a wake-up that arrives after the deadline fires a canned Baby
     * Missile on the bot's behalf and calls it a timeout. Here the deadline is
     * wound into the past first, so the alarm lands at exactly the moment a
     * human in that seat would have lost the turn.
     */
    const room = 'BOTS';
    const { alice, botId, snapshot } = await soloVersusBot(room, 'annihilator');
    if (snapshot.tanks[snapshot.activeTank]?.id !== botId) await passTurn(alice, snapshot);

    const expected = await predictedBotShot(room);
    await editTurnRow(room, (turn) => ({ ...turn, deadlineAt: Date.now() - 1 }));

    const cursor = alice.client.mark();
    expect(await runDurableObjectAlarm(stub(room))).toBe(true);
    const frame = await alice.client.next((m) => m.t === 'events', cursor);
    if (frame.t !== 'events') throw new Error('unreachable');

    // No timeout was declared, and the shot is the one the AI chose rather than
    // the stored-aim Baby Missile the clock fires for an absent human.
    expect(frame.events.some((event) => event.type === 'timeout')).toBe(false);
    const tank = frame.snapshot.tanks[expected.tankIndex];
    expect(tank?.angleDeg).toBe(expected.angleDeg);
    expect(tank?.power).toBe(expected.power);
    // …and the room is not one turn closer to giving up on the match.
    expect((await readTurnRow(room)).timeoutStreak).toBe(0);

    alice.client.close();
  });

  it('plays a match of nothing but bots through to a winner, and then stops', async () => {
    /*
     * The end state of this feature: a board with no human seat on it at all,
     * nobody connected who could take a turn, and a match that finishes
     * anyway — then stops, rather than waking the room for the rest of time.
     *
     * "Nobody connected who could take a turn" is the honest version of
     * "without a human connected". A spectator is watching, because a match
     * playing to a genuinely empty room is duration nobody asked for and the
     * room deliberately refuses it — the test below this one pins that half.
     *
     * The loop is bounded by the sim's OWN guarantee rather than by a number
     * picked here: a round lasts `roundTurnBudget` turns before sudden death
     * and at most `SUDDEN_DEATH_TURNS` after it, so a whole match cannot need
     * more alarms than that times the rounds. Exceeding it is the "runs
     * forever" failure, and it fails as a timeout in this loop rather than as
     * a hung suite.
     */
    const room = 'BOTV';
    const { viewer } = await allBotMatch(room, ['annihilator', 'annihilator']);

    const opening = await readPersistedGame(room);
    const ceiling =
      opening.totalRounds * (roundTurnBudget(opening.tanks.length) + SUDDEN_DEATH_TURNS);

    let alarms = 0;
    let phase = opening.phase;
    while (phase !== 'gameover' && alarms <= ceiling) {
      if (!(await runDurableObjectAlarm(stub(room)))) break;
      alarms += 1;
      phase = (await readPersistedGame(room)).phase;
    }

    const finished = await readPersistedGame(room);
    expect(finished.phase, `still ${finished.phase} after ${alarms} alarms`).toBe('gameover');
    expect(alarms).toBeLessThanOrEqual(ceiling);
    // A winner, and it is one of the machines that played.
    expect(finished.tanks.map((tank) => tank.id)).toContain(finished.winnerId);
    // The whole match, not one round: it ran the distance it was created for.
    expect(finished.round).toBe(finished.totalRounds);

    // …and now it stops. No alarm left, nothing to wake for.
    expect(
      await runInDurableObject(stub(room), (_instance, state) => state.storage.getAlarm()),
    ).toBeNull();
    expect(await runDurableObjectAlarm(stub(room))).toBe(false);

    // The audience was told how it ended, having sent nothing since `hello`.
    const result = await viewer.client.next((m) => m.t === 'matchResult');
    expect(result.t === 'matchResult' ? result.winnerId : null).toBe(finished.winnerId);
    // …and it saw every turn, one frame each: no turn was resolved silently
    // and none was sent twice.
    expect(viewer.client.all().filter((message) => message.t === 'events').length).toBe(alarms);

    viewer.client.close();
  }, 60_000);

  it('leaves an all-bot match asleep until there is somebody to watch it', async () => {
    /*
     * The other half of "does not run forever", and the one that costs money if
     * it is wrong. A Durable Object with a live alarm is a Durable Object that
     * wakes up; a room of computer players duelling in front of nobody would
     * wake every second and a half until one of them won, for an audience of
     * nobody. So with zero connections the alarm fires once, does nothing, and
     * is not replaced.
     *
     * It has to be resumable by whoever turns up, and here that is not the same
     * thing as "whoever comes back to their seat": in a match whose every seat
     * is a machine there is no seat to come back to. A spectator is the only
     * arrival there can be, so a spectator has to be enough.
     */
    const room = 'BOTW';
    const { viewer } = await allBotMatch(room, ['cyborg', 'cyborg']);
    viewer.client.close();
    await waitForSocketCount(room, 0);

    const before = await readPersistedGame(room);
    expect(await runDurableObjectAlarm(stub(room))).toBe(true);
    const idle = await readPersistedGame(room);
    expect(idle.turnNumber).toBe(before.turnNumber);
    expect(
      await runInDurableObject(stub(room), (_instance, state) => state.storage.getAlarm()),
    ).toBeNull();

    // Somebody arrives to watch. That is enough for the match to pick up again,
    // because the seat that is up needs no socket of its own.
    const audience = await join(room, 'Audience', { role: 'spectator' });
    expect(
      await runInDurableObject(stub(room), (_instance, state) => state.storage.getAlarm()),
    ).not.toBeNull();

    expect(await runDurableObjectAlarm(stub(room))).toBe(true);
    const frame = await audience.client.next((m) => m.t === 'events');
    if (frame.t !== 'events') throw new Error('unreachable');
    expect(frame.snapshot.turnNumber).toBe(before.turnNumber + 1);

    audience.client.close();
  });

  it('does not restart a person’s clock for somebody who is only watching', async () => {
    /*
     * The narrow half of the rule above, and the reason the spectator's clock
     * restart is qualified rather than unconditional.
     *
     * A spectator arriving makes a MACHINE's turn playable, because a machine
     * needs no socket. It makes a PERSON's turn no more playable than it was —
     * so waking the room would only take that person's turn away on the say-so
     * of somebody who cannot play it, and would put the standing cost of an
     * abandoned room back exactly where hibernation removed it.
     */
    const room = 'BOTZ';
    const { alice, bob } = await twoPlayerMatch(room);
    alice.client.close();
    bob.client.close();
    await waitForSocketCount(room, 0);

    expect(await runDurableObjectAlarm(stub(room))).toBe(true);
    expect(
      await runInDurableObject(stub(room), (_instance, state) => state.storage.getAlarm()),
    ).toBeNull();

    const audience = await join(room, 'Audience', { role: 'spectator' });
    expect(
      await runInDurableObject(stub(room), (_instance, state) => state.storage.getAlarm()),
      'an audience cannot take an absent player’s turn, so it must not restart their clock',
    ).toBeNull();

    audience.client.close();
  });

  it('never keeps a lobby waiting on a computer player', async () => {
    /*
     * A seat with no socket behind it has to be shown as one nobody is waiting
     * for, and both halves of that are things the room asserts rather than
     * things that fall out.
     *
     * `ready` is stored: a bot that seats itself un-ready is a lobby with a
     * Start button that looks premature and a machine that will never press
     * anything. `connected` is derived: a bot has no connection, so the honest
     * lookup returns false and the lobby draws it greyed out like a player who
     * has walked away — a lie about a seat that is about to take its turn.
     *
     * There was a version of this file with neither asserted. Both are single
     * lines in the room and neither had anything to lose.
     */
    const room = 'BOTX';
    const alice = await join(room, 'Alice');
    send(alice.client.socket, { t: 'addBot', personality: 'annihilator' });
    send(alice.client.socket, { t: 'addBot', personality: 'moron' });

    const lobby = await alice.client.next((m) => m.t === 'lobby' && m.players.length === 3);
    if (lobby.t !== 'lobby') throw new Error('unreachable');

    const bots = lobby.players.filter((player) => player.bot != null);
    expect(bots).toHaveLength(2);
    for (const bot of bots) {
      expect(bot.ready, `${bot.name} should never be the reason a lobby waits`).toBe(true);
      expect(bot.connected, `${bot.name} has no socket to be disconnected from`).toBe(true);
    }
    // The person is untouched by any of that: a human is ready when they say so.
    expect(lobby.players.find((player) => player.id === alice.id)?.ready).toBe(false);

    alice.client.close();
  });

  it('does not hand a computer player a name a person is already using', async () => {
    // Names are what the lobby and the scoreboard are read by, so a bot that
    // takes a person's name makes both ambiguous — and "Shooter" is exactly the
    // name somebody types on purpose.
    const room = 'BOTY';
    const alice = await join(room, 'Shooter');
    send(alice.client.socket, { t: 'addBot', personality: 'shooter' });

    const lobby = await alice.client.next((m) => m.t === 'lobby' && m.players.length === 2);
    if (lobby.t !== 'lobby') throw new Error('unreachable');
    const bot = lobby.players.find((player) => player.bot != null);
    expect(bot?.name).not.toBe('Shooter');
    expect(new Set(lobby.players.map((player) => player.name)).size).toBe(2);
    // The frame parsed, so the name it chose is a legal one — the numbering has
    // to stay inside `PlayerNameSchema`'s 16 characters, not merely be unique.

    alice.client.close();
  });

  it('does not mistake the shop for a computer player’s turn when a bot ends the round', async () => {
    /*
     * The round-ending bot shot, which is the one moment "whose turn is it"
     * and "which seat is active" stop meaning the same thing.
     *
     * `endRound` does not move `activeTank` — it has no reason to; the next
     * round reseats everyone. So the instant a computer player fires the shot
     * that wins a round, the room is in `shopping` with a MACHINE still sitting
     * in the active slot. Every question the room asks about whether a bot is
     * up therefore has to ask the PHASE as well as the seat, and it is asked
     * twice on this path: once when the clock is armed, once when it fires.
     *
     * Answer it on the seat alone and the room arms the short pause it puts in
     * front of a bot's shot instead of the shop clock, wakes a second later,
     * asks `fire()` to shoot during `shopping`, catches the refusal and
     * abandons the match. What the player sees is being thrown out of a match
     * they have just won a round of, with nothing on screen having gone wrong.
     *
     * Reached the same way as the shopping test above: the human is already
     * out, so whatever the bot fires ends the round. Nothing here scripts a
     * kill — the bot aims for itself, as always.
     */
    const room = 'BOTT';
    const { alice, botId } = await soloVersusBot(room, 'annihilator');

    await editPersistedGame(room, (game) => {
      const botIndex = game.tanks.findIndex((tank) => tank.id === botId);
      return {
        ...game,
        phase: 'aiming',
        activeTank: botIndex,
        tanks: game.tanks.map((tank) =>
          tank.id === botId ? tank : { ...tank, alive: false, health: 0 },
        ),
      };
    });

    const cursor = alice.client.mark();
    expect(await runDurableObjectAlarm(stub(room))).toBe(true);
    const won = await alice.client.next((m) => m.t === 'events', cursor);
    if (won.t !== 'events') throw new Error('unreachable');
    expect(won.events.some((event) => event.type === 'roundEnd')).toBe(true);

    // The setup this test is about: shopping, with a machine still active.
    const shopping = await readPersistedGame(room);
    expect(shopping.phase).toBe('shopping');
    expect(shopping.tanks[shopping.activeTank]?.id, 'the winning shot leaves a bot active').toBe(
      botId,
    );
    expect(shopping.pendingShoppers, 'the room is waiting for the person').toContain(alice.id);

    /*
     * First consequence: which clock the room armed. In a phase no machine is
     * playing, the alarm IS the deadline — the same relationship the human's
     * turn has, and the one a bot's turn deliberately breaks. Stated against
     * the row the room wrote rather than against `SHOP_TIMEOUT_MS`, so it
     * cannot pass by restating a constant.
     */
    const armed = await runInDurableObject(stub(room), (_instance, state) =>
      state.storage.getAlarm(),
    );
    const row = await readTurnRow(room);
    expect(row.phase).toBe('shopping');
    expect(armed, 'the shop gets the shop clock, not the pause before a bot shot').toBe(
      row.deadlineAt,
    );

    /*
     * Second consequence, and the one the player would actually meet: when
     * that alarm arrives it must not try to fire. Whatever it decides to do —
     * here it closes a shop nobody left and rolls the next round — the match
     * is still there afterwards.
     */
    const second = alice.client.mark();
    expect(await runDurableObjectAlarm(stub(room))).toBe(true);
    const reply = await alice.client.next((m) => m.t === 'events' || m.t === 'error', second);
    expect(
      reply.t === 'error' ? `the room sent: ${JSON.stringify(reply)}` : 'the match carried on',
    ).toBe('the match carried on');
    expect((await info(room)).inProgress, 'the match must not have been abandoned').toBe(true);
    expect((await readPersistedGame(room)).tanks.map((tank) => tank.id)).toContain(alice.id);

    alice.client.close();
  });

  it('refuses to let a guest take the host’s computer players out of the lobby', async () => {
    /*
     * The mirror of the `addBot` host check, and untested until now.
     *
     * A lobby's line-up belongs to whoever is setting the match up. Without
     * this, anybody who wanders into the room can strip it — and because a bot
     * is removed by id, they can strip it one seat at a time while the host
     * watches the list shrink.
     */
    const room = 'BOTU';
    const alice = await join(room, 'Alice');
    send(alice.client.socket, { t: 'addBot', personality: 'moron' });
    const lobby = await alice.client.next((m) => m.t === 'lobby' && m.players.length === 2);
    if (lobby.t !== 'lobby') throw new Error('unreachable');
    const botId = lobby.players.find((player) => player.bot != null)?.id as string;

    const bob = await join(room, 'Bob');
    await bob.client.next((m) => m.t === 'lobby' && m.players.length === 3);
    expect(await readHostId(room), 'Alice was here first, so the room is hers').toBe(alice.id);

    const cursor = bob.client.mark();
    send(bob.client.socket, { t: 'removeBot', playerId: botId });
    // Either answer settles it: the refusal, or the lobby losing a seat.
    const reply = await bob.client.next(
      (m) => m.t === 'error' || (m.t === 'lobby' && m.players.length === 2),
      cursor,
    );
    expect(reply.t === 'error' && reply.code).toBe('not_host');
    expect((await readSeats(room)).map((seat) => seat.id)).toContain(botId);

    // …and the request itself was fine. The same frame from the host works, so
    // what was refused was the authority, not the message.
    send(alice.client.socket, { t: 'removeBot', playerId: botId });
    await alice.client.next((m) => m.t === 'lobby' && m.players.length === 2);
    expect((await readSeats(room)).map((seat) => seat.id)).not.toContain(botId);

    alice.client.close();
    bob.client.close();
  });

  it('refuses a computer player to somebody who is only watching an empty room', async () => {
    /*
     * The host check is written as "if there IS a host, it has to be you",
     * because a room has no host until a seated player connects and the first
     * person in must be able to press things. A viewer who arrives before
     * anybody sits down therefore walks straight past it, and the only thing
     * left between them and a line-up of their own choosing in somebody else's
     * room is the spectator check.
     *
     * Both handlers are tried, because both have that same open door behind
     * them.
     */
    const room = 'BOZA';
    const viewer = await join(room, 'Viewer', { role: 'spectator' });
    expect(viewer.role).toBe('spectator');
    expect(await readHostId(room), 'nobody is seated, so nobody is host').toBeNull();

    const cursor = viewer.client.mark();
    send(viewer.client.socket, { t: 'addBot', personality: 'annihilator' });
    const refused = await viewer.client.next((m) => m.t === 'error' || m.t === 'lobby', cursor);
    expect(refused.t === 'error' && refused.code).toBe('spectator_only');
    // The seat table is what matters: an audience must not be able to build a
    // line-up for the players who have not arrived yet.
    expect(await readSeats(room)).toEqual([]);
    expect((await info(room)).players).toBe(0);

    const second = viewer.client.mark();
    send(viewer.client.socket, { t: 'removeBot', playerId: 'not-a-seat' });
    const alsoRefused = await viewer.client.next((m) => m.t === 'error', second);
    expect(alsoRefused.t === 'error' && alsoRefused.code).toBe('spectator_only');

    viewer.client.close();
  });
});
