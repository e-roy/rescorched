/**
 * Frame sizes, measured against the real simulation rather than guessed.
 *
 * This file exists because of a bug that a unit test could never have caught by
 * inspection: `events` frames and `fire` frames shared one 16 KB cap, and the
 * sim outgrew it. A Funky Bomb — one blast plus eight sub-munition arcs, on top
 * of a snapshot carrying the full 1280-column heightmap — measured 18,255 bytes,
 * so `parseServerMessage` rejected it and the client froze mid-turn. It affected
 * roughly 5% of shots, and disproportionately the interesting ones.
 *
 * The lesson worth keeping: the cap on what a hostile client may SEND has
 * nothing to do with the size of what our own server legitimately BROADCASTS.
 *
 * Since then the heightmap gained a packed encoding, so this file also measures
 * that. Be precise about which numbers this file is responsible for, because a
 * previous version of this comment claimed all of them and was wrong:
 *
 * - **Live.** The four heightmap figures in the packing comment in
 *   `src/index.ts` (5,159 / 1,320 characters of terrain; 5,874 / 2,035 for a
 *   bare `state` frame) are re-measured and printed by the tests below on every
 *   run. The assertions are the *ratios* those figures express — a >3x cut on
 *   the terrain, better than half on a `state` frame — not the constants, which
 *   move whenever the sim's terrain generator does.
 * - **Historical.** The 18,255-byte Funky Bomb frame and the "38 of 756" shots
 *   are the original measurement of the bug that split the caps. Nothing
 *   re-takes them and nothing can: they describe a build that no longer exists.
 *   They are there as the reason the code is shaped this way. The sweep below
 *   prints today's equivalent worst frame next to them.
 *
 * One job this file also does by accident of construction: it builds its frames
 * from the real sim with no casts, so it will not compile if the sim's events or
 * snapshot stop fitting the wire type. It used to launder both through
 * `as never`, which silenced a genuine TS2322. `sim-boundary.test.ts` is the
 * deliberate version of that check; this is the incidental one, and both are
 * worth having because this one exercises the path the room actually takes.
 */

import { describe, expect, it } from 'vitest';
import {
  createGame,
  fire,
  toSnapshot,
  WEAPONS,
  type GameEvent,
  type GameSnapshot,
} from '@scorched/sim';

import {
  encodeServerMessage,
  IMPACT_KINDS,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_PACKED_SURFACE_CHARS,
  MAX_SERVER_MESSAGE_BYTES,
  MAX_TRAJECTORY_VALUES,
  packSurface,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type ServerMessage,
} from '../src/index.ts';

/**
 * This package compiles against the ES2022 lib alone — no DOM, no Node — so
 * `console` is not in scope. Printing the measurements is the whole point of
 * this file, so declare exactly the part of it being used.
 */
declare const console: { log(message: string): void };

const PLAYERS = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
  { id: 'p3', name: 'Cleo' },
];

/** Every weapon, at three seeds and three awkward aims: 189 real turns. */
const SEEDS = [0, 7, 11] as const;
const AIMS = [
  [45, 80],
  [80, 100],
  [120, 65],
] as const;

interface Turn {
  label: string;
  message: ServerMessage;
  events: GameEvent[];
  snapshot: GameSnapshot;
}

/** Fire one weapon on a full-size map and return the frame the server would send. */
function turnFor(weaponId: string, seed: number, angleDeg: number, power: number): Turn {
  let state = createGame({ seed, totalRounds: 3, width: 1280, height: 720 }, PLAYERS);
  state = {
    ...state,
    tanks: state.tanks.map((tank) => ({
      ...tank,
      inventory: Object.fromEntries(WEAPONS.map((weapon) => [weapon.id, 99])),
    })),
  };

  const shooter = state.tanks[state.activeTank];
  if (shooter === undefined) throw new Error('no active tank');

  const result = fire(state, shooter.id, {
    turnNumber: state.turnNumber,
    angleDeg,
    power,
    weapon: weaponId,
  });
  const snapshot = toSnapshot(result.state);

  return {
    label: `${weaponId} seed ${seed} ${angleDeg}/${power}`,
    // No casts. `result.events` is the sim's `GameEvent[]` and `snapshot` is the
    // sim's `GameSnapshot`, and both are assigned straight into the wire type —
    // so tsc checks the boundary here every time this file compiles. It used to
    // read `result.events as never` and `snapshot as never`, and the events cast
    // was hiding a real TS2322 (the sim types `impactKind` as `string`; the wire
    // schema had narrowed it to an enum). See `sim-boundary.test.ts` for the
    // deliberate, exhaustive version of this check.
    message: { t: 'events', turnNumber: state.turnNumber, events: result.events, snapshot },
    events: result.events,
    snapshot,
  };
}

function frameFor(weaponId: string, seed: number, angleDeg: number, power: number): string {
  return encodeServerMessage(turnFor(weaponId, seed, angleDeg, power).message);
}

/**
 * What the same frame weighed before the heightmap was packed: the schema's own
 * output, serialised straight to JSON, which is exactly what the old encoder
 * did.
 */
function unpackedFrame(message: ServerMessage): string {
  return JSON.stringify(ServerMessageSchema.parse(message));
}

function everyTurn(): Turn[] {
  const turns: Turn[] = [];
  for (const weapon of WEAPONS) {
    for (const seed of SEEDS) {
      for (const [angleDeg, power] of AIMS) {
        turns.push(turnFor(weapon.id, seed, angleDeg, power));
      }
    }
  }
  return turns;
}

describe('server frames survive the wire', () => {
  it('the worst weapon in the arsenal round-trips', () => {
    // Funky Bomb at high power was the measured worst case: eight sub-munitions,
    // eight arcs, one heightmap.
    const turn = turnFor('funky_bomb', 11, 80, 100);
    const frame = encodeServerMessage(turn.message);

    // It no longer exceeds the client cap — packing the heightmap took ~5 KB off
    // it — but it is still far larger than anything a player may send, which is
    // the reason the two caps are separate in the first place.
    expect(unpackedFrame(turn.message).length).toBeGreaterThan(MAX_CLIENT_MESSAGE_BYTES);
    expect(frame.length).toBeGreaterThan(MAX_CLIENT_MESSAGE_BYTES / 2);

    const parsed = parseServerMessage(frame);
    expect(parsed.ok, parsed.ok ? '' : `rejected: ${parsed.error}`).toBe(true);
  });

  it('every weapon at every awkward angle round-trips, byte for byte', () => {
    let worst = 0;
    let worstLabel = '';
    let worstUnpacked = 0;
    let worstEvents = 0;
    let worstPath = 0;
    // What this sweep actually reaches, recorded rather than assumed. A critic
    // had to instrument this by hand to discover that 189 turns of every weapon
    // in the arsenal produce only two of the four impact kinds and six of the
    // nine event types; that is worth printing on every run so the next reader
    // knows which cases only `sim-boundary.test.ts` covers.
    const kindsSeen = new Set<string>();
    const typesSeen = new Set<string>();

    for (const turn of everyTurn()) {
      const frame = encodeServerMessage(turn.message);
      const parsed = parseServerMessage(frame);
      expect(parsed.ok, parsed.ok ? '' : `${turn.label}: ${parsed.error}`).toBe(true);

      // The whole point of the packed heightmap is that it is lossless. If one
      // column came back different, two clients would disagree about where the
      // ground is — the same class of failure as a determinism bug in the sim.
      if (parsed.ok && parsed.value.t === 'events') {
        expect(parsed.value.snapshot.terrain.surface, turn.label).toEqual(
          turn.snapshot.terrain.surface,
        );
        expect(parsed.value.events, turn.label).toEqual(turn.events);
      }

      worstUnpacked = Math.max(worstUnpacked, unpackedFrame(turn.message).length);
      worstEvents = Math.max(worstEvents, turn.events.length);
      for (const event of turn.events) {
        typesSeen.add(event.type);
        if (event.type === 'shot') {
          worstPath = Math.max(worstPath, event.path.length);
          kindsSeen.add(event.impactKind);
        }
      }
      if (frame.length > worst) {
        worst = frame.length;
        worstLabel = turn.label;
      }
    }

    // A ceiling with real headroom, not a restatement of the constant. If the
    // sim starts emitting frames anywhere near the cap this fails long before
    // players start losing turns.
    expect(worst, `worst frame was ${worstLabel}`).toBeLessThan(MAX_SERVER_MESSAGE_BYTES / 4);

    // The schema's array bounds have to sit above what the sim actually
    // produces, or a legitimate turn gets rejected. These two assertions are
    // what keeps `MAX_TRAJECTORY_VALUES` and `MAX_EVENTS_PER_FRAME` honest.
    expect(worstPath).toBeLessThan(MAX_TRAJECTORY_VALUES);
    expect(worstPath).toBeGreaterThan(0);
    expect(worstEvents).toBeGreaterThan(0);

    // Packing has to be worth its complexity on real data, not on a synthetic
    // best case. The assertion is the ratio, not the constants, because the
    // constants move whenever the arsenal does — the run below prints them.
    expect(worst).toBeLessThan(worstUnpacked * 0.8);

    // Whatever the sweep did reach has to be a kind the wire schema recognises.
    // This is a weaker claim than the compile-time one in `sim-boundary.test.ts`
    // — it can only speak about kinds these 189 turns happen to produce — but it
    // is the one that would catch a sim emitting a kind its own type says it
    // cannot. Asserting *which* kinds appear is deliberately not done: that
    // belongs to the sim's physics and would go red for the wrong reason.
    for (const kind of kindsSeen) expect(IMPACT_KINDS, kind).toContain(kind);
    expect(kindsSeen.size).toBeGreaterThan(0);

    console.log(
      `[frame-size] worst packed ${worst} chars (${worstLabel}); ` +
        `worst unpacked ${worstUnpacked}; max events ${worstEvents}; max path values ${worstPath}. ` +
        `The historical frame that split the caps was 18,255 unpacked; this run is today's figure, not that one.`,
    );
    console.log(
      `[frame-size] this sweep reached impact kinds [${[...kindsSeen].sort().join(', ')}] ` +
        `of [${[...IMPACT_KINDS].sort().join(', ')}], and event types ` +
        `[${[...typesSeen].sort().join(', ')}]. The rest are covered synthetically.`,
    );
  });

  it('the heightmap is the thing that shrank', () => {
    const turn = turnFor('funky_bomb', 11, 80, 100);
    const asJson = JSON.stringify(turn.snapshot.terrain).length;
    const packedTerrain =
      encodeServerMessage(turn.message).length - unpackedFrame(turn.message).length + asJson;
    const columns = turn.snapshot.terrain.surface.length;

    // 1280 columns: 5,159 characters as a JSON array of integers against 1,320
    // packed, on the build this was written against. The assertion is the ratio
    // the comment in `src/index.ts` claims — a cut of more than two thirds —
    // because the constants belong to the sim's terrain generator, not to us.
    expect(columns).toBe(1280);
    expect(packedTerrain).toBeLessThan(asJson / 3);

    // Per column, which is the figure that stays comparable when the board
    // width changes. A delta-coded column of ordinary terrain costs about one
    // character; the same column as JSON costs three or four digits and a comma.
    expect(packedTerrain / columns).toBeLessThan(2);
    expect(asJson / columns).toBeGreaterThan(3);

    console.log(
      `[frame-size] terrain ${asJson} chars as JSON (${(asJson / columns).toFixed(3)}/col), ` +
        `${packedTerrain} packed (${(packedTerrain / columns).toFixed(3)}/col), ` +
        `${(asJson / packedTerrain).toFixed(2)}x`,
    );
  });

  it('is what a fresh snapshot costs, with no shot in it at all', () => {
    const state = createGame({ seed: 3, totalRounds: 3, width: 1280, height: 720 }, PLAYERS);
    // Again no cast: the sim's snapshot is assigned directly into the wire type.
    const message: ServerMessage = { t: 'state', snapshot: toSnapshot(state) };
    const packed = encodeServerMessage(message);
    const unpacked = unpackedFrame(message);

    expect(parseServerMessage(packed).ok).toBe(true);
    // A `state` frame is almost entirely heightmap, so this is where packing
    // pays best: 5,874 characters against 2,035 when this was written.
    expect(packed.length).toBeLessThan(unpacked.length / 2);

    console.log(
      `[frame-size] bare state frame ${unpacked.length} chars unpacked, ${packed.length} packed`,
    );
  });
});

describe('client frames stay tightly capped', () => {
  it('rejects an oversized client frame well below the server limit', () => {
    const huge = `{"t":"chat","text":"${'x'.repeat(MAX_CLIENT_MESSAGE_BYTES)}"}`;
    expect(huge.length).toBeLessThan(MAX_SERVER_MESSAGE_BYTES);

    const parsed = parseClientMessage(huge);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/too large/i);
  });

  it('accepts the largest frame a legitimate player can actually send', () => {
    // The biggest real client message is a hello with a full-length name, or a
    // chat at the schema's 200-character limit. Both are tiny; the point of the
    // assertion is to record how much room the cap leaves.
    const chat = JSON.stringify({ t: 'chat', text: 'x'.repeat(200) });
    const hello = JSON.stringify({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      name: 'x'.repeat(16),
      sessionId: 'x'.repeat(64),
      role: 'spectator',
    });

    expect(parseClientMessage(chat).ok).toBe(true);
    expect(parseClientMessage(hello).ok).toBe(true);
    expect(Math.max(chat.length, hello.length)).toBeLessThan(MAX_CLIENT_MESSAGE_BYTES / 20);
  });

  it('refuses a packed heightmap longer than any legal board needs', () => {
    // The packed string is the one attacker-controlled field whose cost is not
    // obviously bounded by the frame size: it is cheap to send and expands into
    // an array. Two gates matter — the string length cap, and the decoder's own
    // column count — and the frame is well under the server cap either way, so
    // neither can be left to the size check.
    const turn = turnFor('baby_missile', 0, 45, 80);
    const bloat = (packed: string): string =>
      JSON.stringify({
        t: 'state',
        snapshot: { ...turn.snapshot, terrain: { width: 1280, height: 720, packed } },
      });

    const overlong = bloat('A'.repeat(MAX_PACKED_SURFACE_CHARS + 1));
    expect(overlong.length).toBeLessThan(MAX_SERVER_MESSAGE_BYTES);
    expect(parseServerMessage(overlong).ok).toBe(false);

    // The real board packs to a small fraction of the cap, so the cap is not
    // sitting on top of legitimate traffic.
    const real = packSurface(turn.snapshot.terrain.surface);
    expect(real.length).toBeLessThan(MAX_PACKED_SURFACE_CHARS / 4);
    console.log(
      `[frame-size] real 1280-column board packs to ${real.length} chars; cap is ${MAX_PACKED_SURFACE_CHARS}`,
    );
  });

  it('will not let a client push a server frame at the room', () => {
    // A real `events` frame replayed back at the server is exactly the frame an
    // attacker would copy. Worth noting which gate stops it: packing the
    // heightmap brought the worst frame under the 16 KB client cap, so the size
    // check no longer catches this one and the discriminator does. Either
    // refusal is fine; a refusal is not.
    const frame = frameFor('funky_bomb', 11, 80, 100);
    const parsed = parseClientMessage(frame);
    expect(parsed.ok).toBe(false);

    const small = JSON.stringify({ t: 'events', turnNumber: 1, events: [] });
    expect(parseClientMessage(small).ok).toBe(false);

    // Something genuinely oversized is still stopped before it is parsed.
    const oversized = JSON.stringify({ t: 'chat', text: 'x'.repeat(MAX_CLIENT_MESSAGE_BYTES) });
    const rejected = parseClientMessage(oversized);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('too_large');
  });
});
