/**
 * Durable Object tests that run INSIDE workerd via @cloudflare/vitest-pool-workers.
 *
 * Not mocks: this is the real runtime, the real DO storage, the real WebSocket
 * Hibernation API. If it passes here it passes in production.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, parseServerMessage, type ServerMessage } from '@scorched/protocol';

import worker from '../src/index.ts';

const BASE = 'http://example.com';

/** Open a real WebSocket into a room and collect frames as they arrive. */
async function openSocket(roomCode: string): Promise<{
  socket: WebSocket;
  next(predicate?: (message: ServerMessage) => boolean): Promise<ServerMessage>;
  all(): ServerMessage[];
  close(): void;
}> {
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
    close: () => {
      // Abandon anything still waiting BEFORE closing. A pending waiter whose
      // timer fires after the test has finished shows up as an unhandled
      // rejection during teardown, which buries real failures in noise.
      while (waiters.length > 0) waiters.pop()?.abandon();
      socket.close();
    },
    next(predicate = () => true) {
      const existing = received.find(predicate);
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
    }

    const lobby = await client.next((m) => m.t === 'lobby');
    if (lobby.t === 'lobby') {
      expect(lobby.players).toHaveLength(1);
      expect(lobby.players[0]?.name).toBe('Alice');
    }
    client.close();
  });

  it('uses the hibernation API, not the legacy accept()', async () => {
    const client = await openSocket('AAAC');
    send(client.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await client.next((m) => m.t === 'welcome');

    const id = env.GAME_ROOM.idFromName('AAAC');
    const stub = env.GAME_ROOM.get(id);
    await runInDurableObject(stub, (_instance, state) => {
      // getWebSockets() only returns sockets accepted via ctx.acceptWebSocket().
      expect(state.getWebSockets().length).toBeGreaterThan(0);
    });
    client.close();
  });

  it('survives a simulated hibernation wake-up with state intact', async () => {
    const alice = await openSocket('AAAD');
    send(alice.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await alice.next((m) => m.t === 'welcome');

    const bob = await openSocket('AAAD');
    send(bob.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Bob' });
    await bob.next((m) => m.t === 'welcome');

    send(alice.socket, { t: 'start' });
    await alice.next((m) => m.t === 'state');

    const id = env.GAME_ROOM.idFromName('AAAD');
    const stub = env.GAME_ROOM.get(id);

    // Abort the object: every in-memory field is destroyed, exactly as
    // eviction after hibernation would do. Sockets and storage survive.
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.getWebSockets().length).toBe(2);
    });
    await stub.fetch(new Request(`${BASE}/info`)); // force a fresh wake-up path

    // The game must still be there after the object came back.
    const info = await stub.fetch(new Request(`${BASE}/info`));
    const body = (await info.json()) as { inProgress: boolean; players: number };
    expect(body.inProgress).toBe(true);
    expect(body.players).toBe(2);

    alice.close();
    bob.close();
  });

  it('restores a socket attachment after the object is re-created', async () => {
    const client = await openSocket('AAAE');
    send(client.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    const welcome = await client.next((m) => m.t === 'welcome');
    const sessionId = welcome.t === 'welcome' ? welcome.sessionId : '';

    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName('AAAE'));
    await runInDurableObject(stub, (_instance, state) => {
      const sockets = state.getWebSockets();
      expect(sockets.length).toBe(1);
      const attachment = sockets[0]?.deserializeAttachment() as { playerId?: string } | null;
      expect(attachment?.playerId).toBe(sessionId);
    });

    // A message sent after "waking" is still attributed to the right player.
    send(client.socket, { t: 'ping', nonce: 42 });
    const pong = await client.next((m) => m.t === 'pong');
    expect(pong.t === 'pong' && pong.nonce).toBe(42);

    client.close();
  });
});

describe('gameplay over the wire', () => {
  it('plays a full turn and broadcasts the same result to both players', async () => {
    const alice = await openSocket('BBBA');
    send(alice.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    const welcome = await alice.next((m) => m.t === 'welcome');
    const aliceId = welcome.t === 'welcome' ? welcome.you : '';

    const bob = await openSocket('BBBA');
    send(bob.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Bob' });
    await bob.next((m) => m.t === 'welcome');

    send(alice.socket, { t: 'start' });
    const started = await alice.next((m) => m.t === 'state');
    const snapshot = started.t === 'state' ? started.snapshot : null;
    expect(snapshot).not.toBeNull();
    expect(snapshot?.tanks.map((tank) => tank.id)).toContain(aliceId);

    send(alice.socket, {
      t: 'fire',
      turnNumber: snapshot?.turnNumber ?? 1,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });

    const aliceEvents = await alice.next((m) => m.t === 'events');
    const bobEvents = await bob.next((m) => m.t === 'events');

    expect(aliceEvents).toEqual(bobEvents);
    if (aliceEvents.t === 'events') {
      expect(aliceEvents.events.some((event) => event.type === 'shot')).toBe(true);
      // Both clients agree on the terrain after the crater, pixel for pixel.
      expect(aliceEvents.snapshot.terrain.surface).toEqual(
        bobEvents.t === 'events' ? bobEvents.snapshot.terrain.surface : null,
      );
      expect(aliceEvents.snapshot.turnNumber).toBe((snapshot?.turnNumber ?? 1) + 1);
    }

    alice.close();
    bob.close();
  });

  it('refuses a shot from the player whose turn it is not', async () => {
    const alice = await openSocket('BBBB');
    send(alice.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await alice.next((m) => m.t === 'welcome');

    const bob = await openSocket('BBBB');
    send(bob.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Bob' });
    await bob.next((m) => m.t === 'welcome');

    send(alice.socket, { t: 'start' });
    const started = await bob.next((m) => m.t === 'state');
    const turnNumber = started.t === 'state' ? started.snapshot.turnNumber : 1;

    // Bob is second; it is Alice's turn.
    send(bob.socket, {
      t: 'fire',
      turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });

    const error = await bob.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('not_your_turn');

    alice.close();
    bob.close();
  });

  it('refuses a stale turn number', async () => {
    const alice = await openSocket('BBBC');
    send(alice.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await alice.next((m) => m.t === 'welcome');
    const bob = await openSocket('BBBC');
    send(bob.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Bob' });
    await bob.next((m) => m.t === 'welcome');

    send(alice.socket, { t: 'start' });
    await alice.next((m) => m.t === 'state');

    send(alice.socket, {
      t: 'fire',
      turnNumber: 9999,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });
    const error = await alice.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('stale_turn');

    alice.close();
    bob.close();
  });

  it('refuses to fire a weapon the player does not own', async () => {
    const alice = await openSocket('BBBD');
    send(alice.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await alice.next((m) => m.t === 'welcome');
    const bob = await openSocket('BBBD');
    send(bob.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Bob' });
    await bob.next((m) => m.t === 'welcome');

    send(alice.socket, { t: 'start' });
    const started = await alice.next((m) => m.t === 'state');
    const turnNumber = started.t === 'state' ? started.snapshot.turnNumber : 1;

    send(alice.socket, { t: 'fire', turnNumber, angleDeg: 45, power: 70, weapon: 'nuke' });
    const error = await alice.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('no_ammo');

    alice.close();
    bob.close();
  });

  it('will not start a match with one player', async () => {
    const alice = await openSocket('BBBE');
    send(alice.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await alice.next((m) => m.t === 'welcome');
    send(alice.socket, { t: 'start' });

    const error = await alice.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('no_players');
    alice.close();
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

    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName('CCCE'));
    const info = await stub.fetch(new Request(`${BASE}/info`));
    expect(info.status).toBe(200);
    const body = (await info.json()) as { players: number };
    expect(body.players).toBe(1); // storage intact

    client.close();
  });
});

describe('rate limiting', () => {
  it('a flood of aim frames never starves the player of their shot', async () => {
    // Regression: aim and fire once shared a budget, so a player who nudged the
    // angle key a few dozen times had their FIRE silently rejected and simply
    // lost the turn. Cosmetic chatter must never cost a player a move.
    const alice = await openSocket('RATE');
    send(alice.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await alice.next((m) => m.t === 'welcome');
    const bob = await openSocket('RATE');
    send(bob.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Bob' });
    await bob.next((m) => m.t === 'welcome');

    send(alice.socket, { t: 'start' });
    const started = await alice.next((m) => m.t === 'state');
    const turnNumber = started.t === 'state' ? started.snapshot.turnNumber : 1;

    // Two hundred aim frames — far more than any old shared budget allowed.
    for (let i = 0; i < 200; i += 1) {
      send(alice.socket, {
        t: 'aim',
        angleDeg: 20 + (i % 120),
        power: 50,
        weapon: 'baby_missile',
      });
    }

    send(alice.socket, {
      t: 'fire',
      turnNumber,
      angleDeg: 45,
      power: 70,
      weapon: 'baby_missile',
    });

    const events = await alice.next((m) => m.t === 'events');
    expect(events.t).toBe('events');
    if (events.t === 'events') {
      expect(events.snapshot.turnNumber).toBe(turnNumber + 1);
    }

    alice.close();
    bob.close();
  });

  it('still refuses a genuine flood of real moves', async () => {
    const alice = await openSocket('RATF');
    send(alice.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await alice.next((m) => m.t === 'welcome');

    // Chat is a real message, not chatter. Enough of it must be refused.
    for (let i = 0; i < 120; i += 1) {
      send(alice.socket, { t: 'chat', text: `spam ${i}` });
    }

    const error = await alice.next((m) => m.t === 'error' && m.code === 'rate_limited');
    expect(error.t === 'error' && error.code).toBe('rate_limited');
    alice.close();
  });

  it('drops excess chatter silently rather than erroring', async () => {
    const alice = await openSocket('RATG');
    send(alice.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await alice.next((m) => m.t === 'welcome');

    for (let i = 0; i < 600; i += 1) {
      send(alice.socket, { t: 'aim', angleDeg: 45, power: 50, weapon: 'baby_missile' });
    }

    // A real action still goes through on its own untouched budget, and the
    // aim flood never produced a single `rate_limited` error — over-budget
    // chatter is simply ignored rather than complained about.
    send(alice.socket, { t: 'ready', ready: true });
    const lobby = await alice.next((m) => m.t === 'lobby' && m.players[0]?.ready === true);
    expect(lobby.t).toBe('lobby');

    expect(alice.all().some((m) => m.t === 'error' && m.code === 'rate_limited')).toBe(false);
    alice.close();
  });
});

describe('reconnect', () => {
  it('gives a returning player their seat and the live state back', async () => {
    const alice = await openSocket('DDDA');
    send(alice.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    const welcome = await alice.next((m) => m.t === 'welcome');
    const sessionId = welcome.t === 'welcome' ? welcome.sessionId : '';

    const bob = await openSocket('DDDA');
    send(bob.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Bob' });
    await bob.next((m) => m.t === 'welcome');

    send(alice.socket, { t: 'start' });
    await alice.next((m) => m.t === 'state');

    // Alice drops.
    alice.close();

    // …and comes back with her session id.
    const aliceAgain = await openSocket('DDDA');
    send(aliceAgain.socket, {
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      name: 'Alice',
      sessionId,
    });

    const welcomeBack = await aliceAgain.next((m) => m.t === 'welcome');
    expect(welcomeBack.t === 'welcome' && welcomeBack.sessionId).toBe(sessionId);

    const state = await aliceAgain.next((m) => m.t === 'state');
    expect(state.t).toBe('state');
    if (state.t === 'state') {
      expect(state.snapshot.tanks.some((tank) => tank.id === sessionId)).toBe(true);
    }

    aliceAgain.close();
    bob.close();
  });

  it('refuses a brand-new player once the match has started', async () => {
    const alice = await openSocket('DDDB');
    send(alice.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    await alice.next((m) => m.t === 'welcome');
    const bob = await openSocket('DDDB');
    send(bob.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Bob' });
    await bob.next((m) => m.t === 'welcome');
    send(alice.socket, { t: 'start' });
    await alice.next((m) => m.t === 'state');

    const latecomer = await openSocket('DDDB');
    send(latecomer.socket, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Eve' });
    const error = await latecomer.next((m) => m.t === 'error');
    expect(error.t === 'error' && error.code).toBe('wrong_phase');

    alice.close();
    bob.close();
    latecomer.close();
  });
});
