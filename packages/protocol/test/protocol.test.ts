import { describe, expect, it } from 'vitest';
import {
  BOT_PERSONALITIES,
  ClientMessageSchema,
  encodeClientMessage,
  encodeServerMessage,
  GameEventSchema,
  IMPACT_KINDS,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_NONCE,
  MAX_PLAYERS_PER_ROOM,
  MAX_SERVER_MESSAGE_BYTES,
  packSurface,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  tryEncodeServerMessage,
  type ClientMessage,
  type ServerMessage,
  type WireGameEvent,
} from '../src/index.ts';

const SNAPSHOT = {
  seed: 1234,
  round: 1,
  totalRounds: 5,
  phase: 'aiming' as const,
  terrain: { width: 4, height: 100, surface: [50, 51, 52, 53] },
  tanks: [
    {
      id: 'p1',
      name: 'Alice',
      x: 10,
      y: 50,
      health: 100,
      money: 10000,
      score: 0,
      alive: true,
      angleDeg: 45,
      power: 60,
      selectedWeapon: 'baby_missile',
      inventory: { missile: 10 },
      colorIndex: 0,
    },
  ],
  activeTank: 0,
  turnNumber: 1,
  wind: -2.5,
  winnerId: null,
  pendingShoppers: [],
};

/**
 * Every event variant, in the order the union declares them. `EVENTS` is reused
 * as the payload of the `events` server frame so that one round-trip covers the
 * whole event union too.
 */
const EVENTS: WireGameEvent[] = [
  // One shot per impact kind, built from the constant rather than typed out, so
  // the `events` frame round-trip below carries all four and a fifth kind cannot
  // be added without appearing here.
  ...IMPACT_KINDS.map((impactKind) => ({
    type: 'shot' as const,
    tankIndex: 0,
    weapon: 'baby_missile',
    path: [1, 2, 3, 4],
    impactKind,
  })),
  { type: 'explosion', x: 10, y: 20, radius: 18, weapon: 'baby_missile' },
  { type: 'dirt', x: 10, y: 20, radius: 40 },
  { type: 'damage', tankIndex: 0, amount: 12, healthAfter: 88 },
  { type: 'death', tankIndex: 0, byTankIndex: 1 },
  { type: 'turn', activeTank: 1, turnNumber: 2, wind: 1.5 },
  { type: 'timeout', tankIndex: 1, turnNumber: 2 },
  { type: 'roundEnd', round: 1, survivors: ['s1'] },
  { type: 'gameOver', winnerId: 's1' },
];

const CLIENT_MESSAGES: ClientMessage[] = [
  { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' },
  { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice', sessionId: 'abc-123' },
  { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Watcher', role: 'spectator' },
  { t: 'ready', ready: true },
  { t: 'start' },
  { t: 'addBot' },
  { t: 'addBot', personality: 'annihilator' },
  { t: 'removeBot', playerId: 'bot-1' },
  { t: 'aim', angleDeg: 45, power: 60, weapon: 'baby_missile' },
  { t: 'fire', turnNumber: 3, angleDeg: 90, power: 100, weapon: 'nuke' },
  { t: 'buy', weapon: 'missile', quantity: 2 },
  { t: 'sell', weapon: 'missile' },
  { t: 'shopDone' },
  { t: 'chat', text: 'good shot' },
  { t: 'ping', nonce: 7 },
];

const SERVER_MESSAGES: ServerMessage[] = [
  { t: 'welcome', protocol: PROTOCOL_VERSION, sessionId: 's1', roomCode: 'ABCD', you: 's1' },
  {
    t: 'welcome',
    protocol: PROTOCOL_VERSION,
    sessionId: 's2',
    roomCode: 'ABCD',
    you: 's2',
    role: 'spectator',
  },
  {
    t: 'lobby',
    roomCode: 'ABCD',
    hostId: 's1',
    players: [
      { id: 's1', name: 'Alice', ready: true, connected: true, colorIndex: 0 },
      // A seated computer player, and a human stated the other way round: the
      // field is optional so an older client still parses the frame, and both
      // spellings of "not a bot" have to survive the round trip.
      {
        id: 'b1',
        name: 'Annihilator',
        ready: true,
        connected: true,
        colorIndex: 1,
        bot: 'annihilator',
      },
      { id: 's2', name: 'Bob', ready: false, connected: true, colorIndex: 2, bot: null },
    ],
  },
  { t: 'state', snapshot: SNAPSHOT },
  { t: 'events', turnNumber: 1, snapshot: SNAPSHOT, events: EVENTS },
  { t: 'aim', playerId: 's1', angleDeg: 30, power: 40, weapon: 'missile' },
  { t: 'chat', playerId: 's1', name: 'Alice', text: 'hi' },
  { t: 'turnTimer', turnNumber: 4, activeTank: 1, remainingMs: 27_500, durationMs: 45_000 },
  {
    t: 'spectators',
    count: 3,
    viewers: [
      { id: 'v1', name: 'Watcher' },
      { id: 'v2', name: 'Lurker' },
    ],
  },
  { t: 'host', hostId: 's2', reason: 'host_disconnected' },
  {
    t: 'matchResult',
    winnerId: 's1',
    roundsPlayed: 5,
    standings: [
      { playerId: 's1', name: 'Alice', place: 1, score: 3, roundsWon: 3 },
      { playerId: 's2', name: 'Bob', place: 2, score: 2, roundsWon: 2 },
    ],
  },
  { t: 'error', code: 'not_your_turn', message: 'It is not your turn' },
  { t: 'pong', nonce: 7 },
];

describe('round trips', () => {
  it.each(CLIENT_MESSAGES.map((m, index) => [`${index} ${m.t}`, m] as const))(
    'client message "%s" survives encode → parse',
    (_label, message) => {
      const parsed = parseClientMessage(encodeClientMessage(message));
      expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
      if (parsed.ok) expect(parsed.value).toEqual(message);
    },
  );

  it.each(SERVER_MESSAGES.map((m, index) => [`${index} ${m.t}`, m] as const))(
    'server message "%s" survives encode → parse',
    (_label, message) => {
      const parsed = parseServerMessage(encodeServerMessage(message));
      expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
      if (parsed.ok) expect(parsed.value).toEqual(message);
    },
  );

  /**
   * These three are the guard rail: add a message or an event to the union
   * without adding a fixture above and the suite goes red, rather than the new
   * shape going out untested.
   */
  it('covers every client message variant', () => {
    const declared = new Set(ClientMessageSchema.options.map((option) => option.shape.t.value));
    const tested = new Set(CLIENT_MESSAGES.map((message) => message.t));
    expect([...declared].sort()).toEqual([...tested].sort());
  });

  it('covers every server message variant', () => {
    const declared = new Set(ServerMessageSchema.options.map((option) => option.shape.t.value));
    const tested = new Set(SERVER_MESSAGES.map((message) => message.t));
    expect([...declared].sort()).toEqual([...tested].sort());
  });

  it('covers every game event variant', () => {
    const declared = new Set(GameEventSchema.options.map((option) => option.shape.type.value));
    const tested = new Set(EVENTS.map((event) => event.type));
    expect([...declared].sort()).toEqual([...tested].sort());
  });

  it('covers every known impact kind', () => {
    const tested = new Set(
      EVENTS.flatMap((event) => (event.type === 'shot' ? [event.impactKind] : [])),
    );
    expect([...IMPACT_KINDS].sort()).toEqual([...tested].sort());
  });

  it('round-trips optional fields as absent, not as undefined keys', () => {
    const encoded = encodeClientMessage({ t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' });
    expect(encoded).not.toMatch(/sessionId|role/);
  });
});

describe('protocol version', () => {
  it('rejects a client handshake from another build with a version-specific code', () => {
    const parsed = parseClientMessage(
      JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION - 1, name: 'Alice' }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe('bad_protocol');
      expect(parsed.error).toMatch(new RegExp(String(PROTOCOL_VERSION)));
      expect(parsed.error).toMatch(/mismatch/i);
    }
  });

  it('rejects a server handshake from another build the same way', () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        t: 'welcome',
        protocol: PROTOCOL_VERSION + 1,
        sessionId: 's1',
        roomCode: 'ABCD',
        you: 's1',
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('bad_protocol');
  });

  it('does not mistake a malformed protocol field for an old build', () => {
    for (const value of ['1', null, 1.5, {}, []]) {
      const parsed = parseClientMessage(
        JSON.stringify({ t: 'hello', protocol: value, name: 'Alice' }),
      );
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe('bad_message');
    }
  });

  it('leaves non-handshake frames alone', () => {
    // A stray `protocol` key on another message is just an unknown field.
    const parsed = parseClientMessage('{"t":"ready","ready":true,"protocol":99}');
    expect(parsed.ok).toBe(true);
  });
});

describe('the heightmap crosses the wire packed', () => {
  it('never ships a raw surface array in a snapshot frame', () => {
    for (const message of SERVER_MESSAGES) {
      if (message.t !== 'state' && message.t !== 'events') continue;
      const wire = encodeServerMessage(message);
      expect(wire).toContain('"packed"');
      expect(wire).not.toContain('"surface"');
    }
  });

  it('still accepts a plain surface array, so an unpacked frame is readable', () => {
    const raw = JSON.stringify({ t: 'state', snapshot: SNAPSHOT });
    const parsed = parseServerMessage(raw);
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
    if (parsed.ok && parsed.value.t === 'state') {
      expect(parsed.value.snapshot.terrain.surface).toEqual([50, 51, 52, 53]);
    }
  });

  it('rejects a heightmap that does not cover the board', () => {
    for (const terrain of [
      { width: 8, height: 100, surface: [1, 2, 3, 4] },
      { width: 8, height: 100, packed: packSurface([1, 2, 3, 4]) },
      { width: 4, height: 100 },
      { width: 4, height: 100, packed: '!!!!' },
      // A trailing continuation digit: the sender was cut off mid-value.
      { width: 4, height: 100, packed: 'ggggg' },
    ]) {
      const parsed = parseServerMessage(
        JSON.stringify({ t: 'state', snapshot: { ...SNAPSHOT, terrain } }),
      );
      expect(parsed.ok, `accepted ${JSON.stringify(terrain)}`).toBe(false);
    }
  });

  /**
   * The packed branch must not be a wider door than the array branch.
   *
   * `surface` is bounded column-by-column by Zod. `packed` is handed to the
   * decoder and its output goes through untouched, so if the decoder is willing
   * to return a bigger number than the schema is, the bound is decorative. It
   * was: a 220-byte frame carrying four columns of 10,000,000 — 610x the
   * documented limit — parsed clean and reached the renderer, and then threw a
   * ZodError when the same value was handed back to `encodeServerMessage`,
   * which on the server happens outside the try in `broadcast()`.
   */
  it('rejects a well-formed packed heightmap whose columns are out of range', () => {
    const frame = (width: number, packed: string): string =>
      JSON.stringify({
        t: 'state',
        snapshot: { ...SNAPSHOT, terrain: { width, height: 100, packed } },
      });

    // The exact frame from the bug report: [10000000, 10000000, 10000000,
    // 10000000] in the packed encoding. Built by hand because `packSurface`
    // now refuses to produce it — see `hostilePackSurface` in
    // surface-codec.test.ts, which pins this string to those four values.
    const reported = frame(4, 'goriTAAA');
    // Nowhere near any size cap: the frame is small, ordinary-looking, and the
    // only thing standing between it and the renderer is this range check.
    expect(reported.length).toBeLessThan(MAX_CLIENT_MESSAGE_BYTES / 10);
    expect(parseServerMessage(reported).ok).toBe(false);

    // A climb of 15 pixels per column: 'e' is a terminating base-32 digit whose
    // zig-zag value is 30. 1,092 columns end at 16,380 and are legal; 1,093 end
    // at 16,395 and are not. Nothing about this frame is malformed — every
    // character is in the alphabet, no value is truncated, the length matches
    // the declared width. Only the heights are outside what a board can hold.
    const legal = parseServerMessage(frame(1092, 'e'.repeat(1092)));
    expect(legal.ok, legal.ok ? '' : legal.error).toBe(true);
    if (legal.ok && legal.value.t === 'state') {
      const { surface } = legal.value.snapshot.terrain;
      expect(surface[surface.length - 1]).toBe(16_380);
    }
    expect(parseServerMessage(frame(1093, 'e'.repeat(1093))).ok).toBe(false);
  });

  it('never hands the renderer a NaN column', () => {
    // A run of continuation digits multiplies the decoder's scale by 32 each
    // time; unbounded, it reaches Infinity and `0 * Infinity` is NaN, which
    // fails every range comparison silently. Measured before the fix:
    // unpackSurface('g'.repeat(205) + 'A') returned [NaN].
    const raw = JSON.stringify({
      t: 'state',
      snapshot: { ...SNAPSHOT, terrain: { width: 1, height: 100, packed: 'g'.repeat(205) + 'A' } },
    });
    const parsed = parseServerMessage(raw);
    if (parsed.ok && parsed.value.t === 'state') {
      for (const value of parsed.value.snapshot.terrain.surface) {
        expect(Number.isFinite(value), `column ${String(value)}`).toBe(true);
      }
    }
    expect(parsed.ok).toBe(false);
  });

  it('prefers the explicit array when a frame carries both forms', () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        t: 'state',
        snapshot: {
          ...SNAPSHOT,
          terrain: { width: 4, height: 100, surface: [7, 7, 7, 7], packed: packSurface([1, 1]) },
        },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.t === 'state') {
      expect(parsed.value.snapshot.terrain.surface).toEqual([7, 7, 7, 7]);
    }
  });
});

describe('hostile and malformed input', () => {
  it.each([
    ['empty string', ''],
    ['not JSON', 'nope'],
    ['JSON but not an object', '"hello"'],
    ['null', 'null'],
    ['array', '[]'],
    ['number', '42'],
    ['unknown discriminator', '{"t":"launch_nukes"}'],
    ['missing discriminator', '{"angleDeg":45}'],
    ['discriminator is an object', '{"t":{"t":"fire"}}'],
    ['angle out of range', '{"t":"fire","turnNumber":1,"angleDeg":999,"power":50,"weapon":"m"}'],
    ['angle negative', '{"t":"fire","turnNumber":1,"angleDeg":-1,"power":50,"weapon":"m"}'],
    ['negative power', '{"t":"fire","turnNumber":1,"angleDeg":45,"power":-5,"weapon":"missile"}'],
    ['null power', '{"t":"fire","turnNumber":1,"angleDeg":45,"power":null,"weapon":"missile"}'],
    ['string power', '{"t":"fire","turnNumber":1,"angleDeg":45,"power":"50","weapon":"missile"}'],
    ['negative turn number', '{"t":"fire","turnNumber":-1,"angleDeg":45,"power":50,"weapon":"m"}'],
    [
      'fractional turn number',
      '{"t":"fire","turnNumber":1.5,"angleDeg":45,"power":5,"weapon":"m"}',
    ],
    ['absurd turn number', '{"t":"fire","turnNumber":1e15,"angleDeg":45,"power":5,"weapon":"m"}'],
    ['weapon id with path traversal', '{"t":"buy","weapon":"../../etc/passwd","quantity":1}'],
    ['weapon id with script', '{"t":"buy","weapon":"<script>","quantity":1}'],
    ['weapon id is __proto__', '{"t":"buy","weapon":"__proto__","quantity":1}'],
    ['weapon id is constructor', '{"t":"buy","weapon":"constructor","quantity":1}'],
    ['weapon id too long', `{"t":"sell","weapon":"${'a'.repeat(33)}"}`],
    ['quantity zero', '{"t":"buy","weapon":"missile","quantity":0}'],
    ['quantity huge', '{"t":"buy","weapon":"missile","quantity":999999}'],
    ['quantity fractional', '{"t":"buy","weapon":"missile","quantity":1.5}'],
    ['empty name', '{"t":"hello","protocol":2,"name":""}'],
    ['name with control chars', '{"t":"hello","protocol":2,"name":"a\\u0000b"}'],
    ['name with lone surrogate', '{"t":"hello","protocol":2,"name":"a\\ud800b"}'],
    ['name too long', `{"t":"hello","protocol":2,"name":"${'a'.repeat(17)}"}`],
    ['session id with spaces', '{"t":"hello","protocol":2,"name":"a","sessionId":"a b"}'],
    [
      'session id too long',
      `{"t":"hello","protocol":2,"name":"a","sessionId":"${'a'.repeat(65)}"}`,
    ],
    ['unknown role', '{"t":"hello","protocol":2,"name":"a","role":"admin"}'],
    ['empty chat', '{"t":"chat","text":"   "}'],
    ['chat with control chars', '{"t":"chat","text":"a\\u0007b"}'],
    ['chat with lone surrogate', '{"t":"chat","text":"a\\udfffb"}'],
    ['chat with bidi override', '{"t":"chat","text":"a\\u202eb"}'],
    ['chat too long', `{"t":"chat","text":"${'x'.repeat(201)}"}`],
    ['negative ping nonce', '{"t":"ping","nonce":-1}'],
    ['ping nonce is a float', '{"t":"ping","nonce":1.5}'],
    ['ping nonce past 32 bits', '{"t":"ping","nonce":4294967296}'],
    ['ping nonce at MAX_SAFE_INTEGER', '{"t":"ping","nonce":9007199254740991}'],
    ['ready is a string', '{"t":"ready","ready":"yes"}'],
    // Seating a computer player. `personality` names a brain the sim has to be
    // able to drive, so it is the one place a lobby string reaches the AI, and
    // the enum is the gate. `sim-boundary.test.ts` pins the list itself against
    // the sim's; these are the shapes that must not get past the parser.
    ['unknown personality', '{"t":"addBot","personality":"grandmaster"}'],
    ['personality with different case', '{"t":"addBot","personality":"Annihilator"}'],
    ['personality is empty', '{"t":"addBot","personality":""}'],
    ['personality is a number', '{"t":"addBot","personality":3}'],
    ['personality is null', '{"t":"addBot","personality":null}'],
    ['personality is an array of real ones', '{"t":"addBot","personality":["moron"]}'],
    ['personality is __proto__', '{"t":"addBot","personality":"__proto__"}'],
    ['removeBot with no target', '{"t":"removeBot"}'],
    ['removeBot with an empty target', '{"t":"removeBot","playerId":""}'],
    ['removeBot with a whitespace target', '{"t":"removeBot","playerId":"a b"}'],
    ['removeBot with a null target', '{"t":"removeBot","playerId":null}'],
    ['removeBot with a numeric target', '{"t":"removeBot","playerId":42}'],
    ['removeBot with an over-long target', `{"t":"removeBot","playerId":"${'a'.repeat(65)}"}`],
    [
      'NaN smuggled as a string',
      '{"t":"fire","turnNumber":1,"angleDeg":"NaN","power":5,"weapon":"m"}',
    ],
  ])('rejects %s', (_label, raw) => {
    const parsed = parseClientMessage(raw);
    expect(parsed.ok).toBe(false);
  });

  it('cannot express NaN or Infinity in JSON, and rejects the tricks that try', () => {
    // JSON has no NaN/Infinity literals, so the only routes in are a bare token
    // (malformed JSON) or a value big enough that the parser rounds it to
    // Infinity. Both must be refused.
    for (const raw of [
      '{"t":"fire","turnNumber":1,"angleDeg":NaN,"power":50,"weapon":"missile"}',
      '{"t":"fire","turnNumber":1,"angleDeg":Infinity,"power":50,"weapon":"missile"}',
      '{"t":"fire","turnNumber":1,"angleDeg":1e400,"power":50,"weapon":"missile"}',
      '{"t":"fire","turnNumber":1e400,"angleDeg":45,"power":50,"weapon":"missile"}',
    ]) {
      expect(parseClientMessage(raw).ok, raw).toBe(false);
    }
    expect(JSON.parse('{"a":1e400}').a).toBe(Infinity);
  });

  it('does not pollute Object.prototype', () => {
    const attacks = [
      '{"t":"ready","ready":true,"__proto__":{"pwned":true}}',
      '{"t":"buy","weapon":"missile","quantity":1,"constructor":{"prototype":{"pwned":true}}}',
      '{"t":"chat","text":"hi","__proto__":{"toString":"nope"}}',
    ];
    for (const raw of attacks) parseClientMessage(raw);

    const probe = {} as Record<string, unknown>;
    expect(probe['pwned']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('pwned');
    expect({}.toString()).toBe('[object Object]');
  });

  it('does not carry a __proto__ key through an inventory record', () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        t: 'state',
        snapshot: {
          ...SNAPSHOT,
          tanks: [
            {
              ...SNAPSHOT.tanks[0],
              inventory: JSON.parse('{"__proto__":{"pwned":true},"missile":2}') as unknown,
            },
          ],
        },
      }),
    );
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
    if (parsed.ok && parsed.value.t === 'state') {
      const inventory = parsed.value.snapshot.tanks[0]?.inventory ?? {};
      expect(Object.keys(inventory)).toEqual(['missile']);
      expect(Object.getPrototypeOf(inventory)).toBe(Object.prototype);
    }
    expect(({} as Record<string, unknown>)['pwned']).toBeUndefined();
  });

  it('bounds an inventory to a sane number of distinct weapons', () => {
    const inventory: Record<string, number> = {};
    for (let index = 0; index < 200; index += 1) inventory[`w${index}`] = 1;
    const parsed = parseServerMessage(
      JSON.stringify({
        t: 'state',
        snapshot: { ...SNAPSHOT, tanks: [{ ...SNAPSHOT.tanks[0], inventory }] },
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  /**
   * `WorldCoordSchema` is documented as "finite and bounded so a renderer cannot
   * be walked off a cliff", and every position on the wire is built from it.
   * Nothing used to test that. Replacing it with a bare `z.number().finite()`
   * was the one schema mutation out of 26 that the whole suite survived, which
   * means the bound was documentation rather than a rule. These cases are what
   * make it a rule.
   */
  it('bounds every world coordinate a server frame can carry', () => {
    const far = 1e9;
    const stateWith = (tank: Record<string, unknown>): string =>
      JSON.stringify({ t: 'state', snapshot: { ...SNAPSHOT, tanks: [tank] } });
    const eventsWith = (events: unknown[]): string =>
      JSON.stringify({ t: 'events', turnNumber: 1, snapshot: SNAPSHOT, events });

    const base = SNAPSHOT.tanks[0];

    // A tank parked a billion pixels away.
    expect(parseServerMessage(stateWith({ ...base, x: far })).ok).toBe(false);
    expect(parseServerMessage(stateWith({ ...base, y: -far })).ok).toBe(false);
    // …and one at the documented edge, which must still be allowed. Rollers and
    // sub-munitions legitimately drift off the board.
    expect(parseServerMessage(stateWith({ ...base, x: 16_384, y: -16_384 })).ok).toBe(true);
    expect(parseServerMessage(stateWith({ ...base, x: 16_385 })).ok).toBe(false);

    // A trajectory that leaves the world. The renderer draws every pair.
    expect(
      parseServerMessage(
        eventsWith([
          {
            type: 'shot',
            tankIndex: 0,
            weapon: 'missile',
            path: [1, 2, far, 4],
            impactKind: 'terrain',
          },
        ]),
      ).ok,
    ).toBe(false);

    // An explosion nowhere near the board.
    expect(
      parseServerMessage(
        eventsWith([{ type: 'explosion', x: far, y: 0, radius: 10, weapon: 'nuke' }]),
      ).ok,
    ).toBe(false);
    expect(parseServerMessage(eventsWith([{ type: 'dirt', x: 0, y: -far, radius: 10 }])).ok).toBe(
      false,
    );

    /*
     * Infinity, which JSON has no literal for and reaches only by overflowing a
     * numeric token. It has to be spliced into the TEXT: writing `x: 1e400` in
     * an object and stringifying it emits `"x":null`, because JSON.stringify
     * turns non-finite numbers into null. That version of this test passed, but
     * for the wrong reason — it was asserting that null is rejected, and never
     * put an Infinity anywhere near the parser.
     */
    const overflowing = (json: string, key: string): string =>
      json.replace(new RegExp(`"${key}":-?[\\d.e+-]+`), `"${key}":1e400`);

    expect(Number(JSON.parse('{"x":1e400}').x)).toBe(Number.POSITIVE_INFINITY);

    expect(parseServerMessage(overflowing(stateWith({ ...base }), 'x')).ok).toBe(false);
    expect(
      parseServerMessage(
        overflowing(
          eventsWith([{ type: 'explosion', x: 1, y: 0, radius: 10, weapon: 'nuke' }]),
          'radius',
        ),
      ).ok,
    ).toBe(false);
  });

  it('bounds the arrays inside a server frame', () => {
    const withEvents = (events: unknown[]): string =>
      JSON.stringify({ t: 'events', turnNumber: 1, snapshot: SNAPSHOT, events });

    // An odd-length trajectory would leave a renderer reading past the end.
    expect(
      parseServerMessage(
        withEvents([
          { type: 'shot', tankIndex: 0, weapon: 'missile', path: [1, 2, 3], impactKind: 'terrain' },
        ]),
      ).ok,
    ).toBe(false);

    // A blast radius nothing in the arsenal can produce.
    expect(
      parseServerMessage(
        withEvents([{ type: 'explosion', x: 0, y: 0, radius: 1e9, weapon: 'nuke' }]),
      ).ok,
    ).toBe(false);

    // A tank index that is not a seat in any room.
    expect(
      parseServerMessage(withEvents([{ type: 'death', tankIndex: 99, byTankIndex: null }])).ok,
    ).toBe(false);

    // An impact kind that is not shaped like one. The full case list — including
    // why a well-formed but unrecognised kind is deliberately ACCEPTED — is in
    // sim-boundary.test.ts, next to the compile-time pin that keeps the known
    // set equal to the sim's.
    expect(
      parseServerMessage(
        withEvents([
          { type: 'shot', tankIndex: 0, weapon: 'missile', path: [], impactKind: 'WORMHOLE' },
        ]),
      ).ok,
    ).toBe(false);
  });

  it('rejects an oversized frame without parsing it', () => {
    const huge = `{"t":"chat","text":"${'x'.repeat(MAX_MESSAGE_BYTES)}"}`;
    const parsed = parseClientMessage(huge);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe('too_large');
      expect(parsed.error).toMatch(/too large/i);
    }
  });

  it('rejects an oversized server frame too', () => {
    const huge = `{"t":"chat","playerId":"s1","name":"A","text":"${'x'.repeat(MAX_SERVER_MESSAGE_BYTES)}"}`;
    const parsed = parseServerMessage(huge);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('too_large');
  });

  it('survives deeply nested JSON in both directions', () => {
    // Deep enough that JSON.parse itself may give up with a RangeError, which
    // must come back as a refusal rather than as a thrown error.
    for (const depth of [64, 1000, 100_000]) {
      const nested = `{"t":"chat","text":${'['.repeat(depth)}${']'.repeat(depth)}}`;
      if (nested.length <= MAX_CLIENT_MESSAGE_BYTES) {
        expect(() => parseClientMessage(nested)).not.toThrow();
        expect(parseClientMessage(nested).ok).toBe(false);
      }
      expect(() => parseServerMessage(nested)).not.toThrow();
      expect(parseServerMessage(nested).ok).toBe(false);
    }
  });

  it('reports a useful reason, not just "invalid"', () => {
    const parsed = parseClientMessage(
      '{"t":"fire","turnNumber":1,"angleDeg":500,"power":50,"weapon":"missile"}',
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.length).toBeGreaterThan(3);
      expect(parsed.error).toMatch(/angleDeg/);
    }
  });
});

/**
 * The file's own Rule 1 is "every number a range", and `nonce` was the one that
 * had only half of one: `z.number().int().min(0)` is bounded below and unbounded
 * above, so `{"t":"ping","nonce":9007199254740991}` parsed clean in BOTH
 * directions. A ping nonce is a correlator with no meaning beyond "this pong
 * answers that ping", so 32 bits is a ceiling nothing legitimate can reach.
 */
describe('the ping/pong nonce is bounded at both ends', () => {
  it('accepts the range a real sender uses, up to the cap', () => {
    for (const nonce of [0, 1, 65_535, MAX_NONCE]) {
      expect(parseClientMessage(JSON.stringify({ t: 'ping', nonce })).ok, `${nonce}`).toBe(true);
      expect(parseServerMessage(JSON.stringify({ t: 'pong', nonce })).ok, `${nonce}`).toBe(true);
    }
  });

  it('refuses anything past it, in both directions', () => {
    for (const nonce of [
      MAX_NONCE + 1,
      Number.MAX_SAFE_INTEGER,
      1e300,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      // JSON.stringify writes NaN and Infinity as `null`, which is also refused;
      // the numeric-overflow route is covered separately below.
      const raw = (t: string): string => JSON.stringify({ t, nonce });
      expect(parseClientMessage(raw('ping')).ok, `ping ${nonce}`).toBe(false);
      expect(parseServerMessage(raw('pong')).ok, `pong ${nonce}`).toBe(false);
    }

    // An Infinity that reaches the parser as a real Infinity, spliced into the
    // text because JSON has no literal for it.
    expect(parseClientMessage('{"t":"ping","nonce":1e400}').ok).toBe(false);
    expect(parseServerMessage('{"t":"pong","nonce":1e400}').ok).toBe(false);
  });

  it('will not encode one past the cap either', () => {
    expect(() => encodeClientMessage({ t: 'ping', nonce: MAX_NONCE + 1 })).toThrow();
    expect(() => encodeServerMessage({ t: 'pong', nonce: MAX_NONCE + 1 })).toThrow();
  });
});

/**
 * `broadcast()` in the Durable Object encodes the turn's frame before the send
 * loop and OUTSIDE the try that guards `socket.send`. A throw there is not a
 * dropped log line — nobody receives the turn and every client sits waiting for
 * events that never arrive. `tryEncodeServerMessage` is the version that hands
 * that caller the choice. `apps/server` belongs to another area and still calls
 * the throwing form; this is the tested door, not a change made on its behalf.
 */
describe('tryEncodeServerMessage', () => {
  it('produces exactly what the throwing encoder produces, when both work', () => {
    for (const message of SERVER_MESSAGES) {
      const safe = tryEncodeServerMessage(message);
      expect(safe.ok, safe.ok ? '' : safe.error).toBe(true);
      if (safe.ok) expect(safe.value).toBe(encodeServerMessage(message));
    }
  });

  it('returns a reason instead of throwing on a frame the schema refuses', () => {
    const bad = { t: 'error', code: 'nope', message: 'x' } as unknown as ServerMessage;
    expect(() => encodeServerMessage(bad)).toThrow();

    const safe = tryEncodeServerMessage(bad);
    expect(safe.ok).toBe(false);
    if (!safe.ok) {
      expect(safe.code).toBe('bad_message');
      expect(safe.error.length).toBeGreaterThan(0);
    }
  });
});

describe('encoding guards', () => {
  it('refuses to encode an invalid outbound message', () => {
    expect(() =>
      encodeServerMessage({ t: 'error', code: 'nope' as never, message: 'x' }),
    ).toThrow();
  });

  it('refuses to encode an invalid outbound client message', () => {
    expect(() => encodeClientMessage({ t: 'chat', text: '' })).toThrow();
  });

  it('trims and validates names', () => {
    const parsed = parseClientMessage(
      `{"t":"hello","protocol":${PROTOCOL_VERSION},"name":"  Alice  "}`,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.t === 'hello') expect(parsed.value.name).toBe('Alice');
  });

  it('rejects room codes that are not four uppercase letters', () => {
    for (const code of ['abcd', 'ABC', 'ABCDE', 'AB1D', '', 'AB D', 'AB\u0000D']) {
      expect(
        ServerMessageSchema.safeParse({
          t: 'welcome',
          protocol: PROTOCOL_VERSION,
          sessionId: 's',
          roomCode: code,
          you: 's',
        }).success,
      ).toBe(false);
    }
  });

  it('accepts the unicode a real player types in chat', () => {
    for (const text of ['gg', 'ça va', '日本語', 'nice shot 😀', 'family 👨‍👩‍👧']) {
      const parsed = parseClientMessage(JSON.stringify({ t: 'chat', text }));
      expect(parsed.ok, `${text}: ${parsed.ok ? '' : parsed.error}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Computer players on the wire
//
// The row-per-shape table above covers the parser refusals. What is left is the
// three things about these two messages that are decisions rather than syntax:
// how many bots a frame can ask for, whether a personality can arrive by a door
// other than `addBot`, and what `bot` being optional actually buys.
// ---------------------------------------------------------------------------

describe('computer players on the wire', () => {
  /** A lobby frame with `count` seats in it. */
  function lobbyOf(count: number): unknown {
    return {
      t: 'lobby',
      roomCode: 'ABCD',
      hostId: 's0',
      players: Array.from({ length: count }, (_, index) => ({
        id: `s${index}`,
        name: `P${index}`,
        ready: true,
        connected: true,
        colorIndex: index % 64,
        bot: index === 0 ? null : 'moron',
      })),
    };
  }

  it('will not describe a lobby with more seats than a room can have', () => {
    /*
     * The count that matters is the one on the WIRE, and a bot is the cheap way
     * to reach it: seating a person needs a person, while `addBot` is a
     * four-byte frame. A room that let one of them run would hand every client
     * an array to allocate and render, so the ceiling is asserted as a step —
     * the largest legal lobby parses, one more does not — rather than by
     * repeating the bound.
     */
    const largest = MAX_PLAYERS_PER_ROOM;
    expect(parseServerMessage(JSON.stringify(lobbyOf(largest))).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify(lobbyOf(largest + 1))).ok).toBe(false);
    // Nor an absurd one, which is the shape a hostile or broken server sends.
    expect(parseServerMessage(JSON.stringify(lobbyOf(5000))).ok).toBe(false);
  });

  it('carries every personality on the roster in both directions', () => {
    /*
     * Both directions matter and they are different problems. `addBot` is the
     * one a lobby SENDS, so a personality missing from the enum is a button the
     * server refuses; `LobbyPlayer.bot` is the one it RECEIVES, so a
     * personality missing there is a seat the UI cannot label — "Bob
     * (Annihilator)" with no way to know it is an Annihilator.
     */
    for (const personality of BOT_PERSONALITIES) {
      const request = parseClientMessage(JSON.stringify({ t: 'addBot', personality }));
      expect(request.ok, personality).toBe(true);
      if (request.ok && request.value.t === 'addBot') {
        expect(request.value.personality).toBe(personality);
      }

      const lobby = parseServerMessage(
        encodeServerMessage({
          t: 'lobby',
          roomCode: 'ABCD',
          hostId: 's0',
          players: [
            {
              id: 's0',
              name: 'Bot',
              ready: true,
              connected: true,
              colorIndex: 0,
              bot: personality,
            },
          ],
        }),
      );
      expect(lobby.ok, personality).toBe(true);
      if (lobby.ok && lobby.value.t === 'lobby') {
        expect(lobby.value.players[0]?.bot).toBe(personality);
      }
    }
  });

  it('refuses a lobby seat whose personality is not one the sim has', () => {
    const frame = lobbyOf(2) as { players: { bot: unknown }[] };
    (frame.players[1] as { bot: unknown }).bot = 'grandmaster';
    expect(parseServerMessage(JSON.stringify(frame)).ok).toBe(false);
  });

  it('keeps "not a bot" expressible two ways, which is what optional buys', () => {
    /*
     * `bot` is optional so a client built before computer players existed still
     * parses a lobby frame from a server that has them — and that only holds if
     * BOTH spellings survive: absent (an old server, or a frame built without
     * the field) and explicitly null (this server, saying "a person sits here").
     * An absent field must also stay absent through the round trip rather than
     * becoming an `undefined` key, because `JSON.stringify` drops one and the
     * other is a key a strict consumer can trip over.
     */
    const absent = { id: 's1', name: 'Alice', ready: true, connected: true, colorIndex: 0 };
    const explicit = { ...absent, id: 's2', bot: null };

    const encoded = encodeServerMessage({
      t: 'lobby',
      roomCode: 'ABCD',
      hostId: 's1',
      players: [absent, explicit],
    });
    expect(encoded).not.toMatch(/"bot":undefined/);

    const parsed = parseServerMessage(encoded);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.t === 'lobby') {
      expect(Object.hasOwn(parsed.value.players[0] as object, 'bot')).toBe(false);
      expect(parsed.value.players[1]?.bot).toBeNull();
    }
  });

  it('does not let a client assert which seats are machines', () => {
    // `bot` is a SERVER-frame field. There is no client message carrying it, so
    // the only way a seat becomes a bot is `addBot`, which the room adjudicates.
    // A client that decorates its own frames with it changes nothing.
    const parsed = parseClientMessage('{"t":"ready","ready":true,"bot":"annihilator"}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.hasOwn(parsed.value, 'bot')).toBe(false);
  });
});
