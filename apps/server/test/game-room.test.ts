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
import type { GameSnapshot, PersistedGame } from '@scorched/sim';

import worker from '../src/index.ts';
import { MAX_PLAYERS, MAX_SPECTATORS } from '../src/game-room.ts';

const BASE = 'http://example.com';
const MAX_SOCKETS = MAX_PLAYERS + MAX_SPECTATORS;

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
  close(): void;
}

/** Open a real WebSocket into a room and collect frames as they arrive. */
async function openSocket(roomCode: string): Promise<Client> {
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

  return {
    socket,
    all: () => received,
    mark: () => received.length,
    close: () => {
      // Abandon anything still waiting BEFORE closing. A pending waiter whose
      // timer fires after the test has finished shows up as an unhandled
      // rejection during teardown, which buries real failures in noise.
      while (waiters.length > 0) waiters.pop()?.abandon();
      socket.close();
    },
    next(predicate = () => true, from = 0) {
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
  players: number;
  spectators: number;
  inProgress: boolean;
  phase: string;
}> {
  const response = await stub(roomCode).fetch(new Request(`${BASE}/info`));
  expect(response.status).toBe(200);
  return (await response.json()) as {
    players: number;
    spectators: number;
    inProgress: boolean;
    phase: string;
  };
}

/** Say hello and wait to be seated. Returns the id the server gave us. */
async function join(
  roomCode: string,
  name: string,
  options: { sessionId?: string; role?: 'player' | 'spectator' } = {},
): Promise<{ client: Client; id: string; role: string }> {
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
  return { client, id: welcome.you, role: welcome.role ?? 'player' };
}

/** Start a two-player match and hand back whichever client shoots first. */
async function twoPlayerMatch(roomCode: string): Promise<{
  alice: { client: Client; id: string };
  bob: { client: Client; id: string };
  shooter: { client: Client; id: string };
  waiter: { client: Client; id: string };
  snapshot: GameSnapshot;
}> {
  const alice = await join(roomCode, 'Alice');
  const bob = await join(roomCode, 'Bob');

  send(alice.client.socket, { t: 'start' });
  const started = await bob.client.next((m) => m.t === 'state');
  if (started.t !== 'state') throw new Error('unreachable');
  await alice.client.next((m) => m.t === 'state');

  // The sim picks the turn order from the seed. Ask it, never assume.
  const activeId = started.snapshot.tanks[started.snapshot.activeTank]?.id;
  const shooter = activeId === alice.id ? alice : bob;
  const waiter = activeId === alice.id ? bob : alice;
  return { alice, bob, shooter, waiter, snapshot: started.snapshot };
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

  it('only hands out a room code nobody is sitting in', async () => {
    // The guarantee is per-code, not statistical: whatever code comes back, the
    // room behind it is empty. Squatting in one room first makes sure the check
    // is actually consulting rooms rather than trusting the dice.
    const squatter = await join('KKKA', 'Squatter');
    expect((await info('KKKA')).players).toBe(1);

    for (let i = 0; i < 8; i += 1) {
      const response = await worker.fetch(
        new Request(`${BASE}/api/rooms`, { method: 'POST' }),
        env,
      );
      const body = (await response.json()) as { roomCode: string };
      const summary = await info(body.roomCode);
      expect(summary.players, `${body.roomCode} was handed out occupied`).toBe(0);
      expect(summary.inProgress).toBe(false);
    }

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
      alice.client.all().some((m) => m.t === 'events'),
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

    // Bob's socket claims Alice's session id. One socket, one identity.
    send(bob.client.socket, {
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      name: 'Bob',
      sessionId: alice.id,
    });
    const error = await bob.client.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('bad_protocol');

    alice.client.close();
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

    const back = await join(room, 'Alice', { sessionId: alice.id });
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

    const back = await join(room, 'Shooter', { sessionId: shooter.id });
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
    const twin = await join(room, 'Alice', { sessionId: alice.id });
    expect(twin.id).toBe(alice.id);
    expect((await info(room)).players).toBe(1);

    alice.client.close();
    twin.client.close();
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
    const aliceId = alice.id;

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
    const returning = await join(room, 'Alice', { sessionId: aliceId });
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
    const beforeRematch = bob.client.mark();
    send(alice.client.socket, { t: 'start' });
    const rematch = await bob.client.next(
      (m) => m.t === 'state' && m.snapshot.phase === 'aiming',
      beforeRematch,
    );
    expect(rematch.t).toBe('state');
    if (rematch.t === 'state') {
      expect(rematch.snapshot.seed).not.toBe(snapshot.seed);
      expect(rematch.snapshot.tanks.every((tank) => tank.health > 0)).toBe(true);
    }

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

  it('publishes a final scoreboard when the sim declares the match over', async () => {
    const room = 'HHHC';
    const { alice, bob, shooter, snapshot } = await twoPlayerMatch(room);

    // One turn away from the end: it is the final round and the player about to
    // shoot is the last tank standing, so resolving this turn ends the match.
    await editPersistedGame(room, (game) => ({
      ...game,
      round: game.totalRounds,
      tanks: game.tanks.map((tank, index) => ({
        ...tank,
        alive: index === game.activeTank,
        health: index === game.activeTank ? tank.health : 0,
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
    }

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

  it('caps the replay log', async () => {
    const room = 'JJJB';
    const { alice, bob } = await twoPlayerMatch(room);

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

    const shooterSnapshot = await alice.client.next((m) => m.t === 'state');
    const turnNumber = shooterSnapshot.t === 'state' ? shooterSnapshot.snapshot.turnNumber : 1;
    const activeId =
      shooterSnapshot.t === 'state'
        ? shooterSnapshot.snapshot.tanks[shooterSnapshot.snapshot.activeTank]?.id
        : undefined;
    const shooter = activeId === alice.id ? alice : bob;

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
