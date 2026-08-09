/**
 * The seam between `packages/sim` and the wire, checked rather than asserted in
 * prose.
 *
 * The sim cannot import this package — it is dependency-free by design — so
 * `GameEvent` and `GameSnapshot` are hand-mirrored on both sides of the seam.
 * Two comments used to claim that mirror held: the header of `game-room.ts`'s
 * `ServerEventPayload` ("structurally satisfied by sim's GameEvent[]") and the
 * `as never` casts in `frame-size.test.ts`. Neither was true, and neither could
 * have told you: a cast to `never` silences the exact error that proves it.
 *
 * This package is the only one that depends on both, so this file is the only
 * place the mirror CAN be checked. It checks it three ways:
 *
 * 1. **Types, at compile time.** The assignments below carry no casts. If the
 *    sim's event union, snapshot shape, phase set or impact-kind set drifts from
 *    the wire's, this file stops compiling and `pnpm typecheck` goes red — which
 *    is the whole point, because the alternative is finding out when a Durable
 *    Object throws mid-broadcast.
 * 2. **Values, at run time, from the real sim.** A match is played to its end
 *    and every event it emits is pushed through `GameEventSchema`.
 * 3. **The cases the sim does not reach.** 189 turns of the arsenal produce two
 *    of the four impact kinds and six of the nine event types (see the printout
 *    from `frame-size.test.ts`), so the rest are built by hand here — otherwise
 *    "every event round-trips" is a claim about six of nine.
 */

import { describe, expect, it } from 'vitest';
import {
  createGame,
  fire,
  leaveShop,
  startNextRound,
  toSnapshot,
  type GameEvent,
  type GamePhase,
  type GameSnapshot,
  type GameState,
  type ImpactKind as SimImpactKind,
} from '@scorched/sim';

import {
  encodeServerMessage,
  GameEventSchema,
  IMPACT_KINDS,
  isKnownImpactKind,
  parseServerMessage,
  type GamePhase as WireGamePhase,
  type ImpactKind as WireImpactKind,
  type ServerMessage,
  type WireGameEvent,
} from '../src/index.ts';

/**
 * This package compiles against the ES2022 lib alone — no DOM, no Node — so
 * `console` is not in scope. Same declaration as `frame-size.test.ts`.
 */
declare const console: { log(message: string): void };

// ---------------------------------------------------------------------------
// 1. Compile-time. Nothing below runs; if it compiles, the seam holds.
// ---------------------------------------------------------------------------

type Assert<T extends true> = T;
/**
 * `true` when every member of `Narrow` is also in `Wide`; otherwise the members
 * that are NOT — so tsc's diagnostic reads
 * `Type '"expired"' does not satisfy the constraint 'true'` and names the kind
 * that drifted. The obvious `[Narrow] extends [Wide] ? true : false` compiles to
 * the same pass/fail but reports only `false`, which tells whoever hits it
 * nothing about what to add where.
 */
type Fits<Narrow, Wide> = [Exclude<Narrow, Wide>] extends [never] ? true : Exclude<Narrow, Wide>;

/**
 * The impact-kind sets must be EQUAL, and both directions are load-bearing.
 *
 * `sim ⊆ wire` is the one that matters operationally: a fifth kind added to
 * `packages/sim/src/physics.ts` breaks this line, which is the signal that
 * `IMPACT_KINDS` and the client's animation switch need the new case. Without
 * it, the new kind would reach a client that silently drew nothing.
 *
 * `wire ⊆ sim` catches the opposite mistake — a kind invented here that the
 * physics cannot produce, i.e. a client branch that can never run.
 *
 * Note this is checked against the sim's `ImpactKind` union in `physics.ts`, NOT
 * against `GameEvent.impactKind` in `game.ts`, which is typed `string` and
 * therefore pins nothing. That widening is why the wire field is a bounded
 * string rather than a `z.enum` — see `ImpactKindSchema`.
 */
type _SimImpactKindsFitTheWire = Assert<Fits<SimImpactKind, WireImpactKind>>;
type _WireImpactKindsFitTheSim = Assert<Fits<WireImpactKind, SimImpactKind>>;

/** Every phase the sim can be in must be a phase the wire can carry, and vice versa. */
type _SimPhasesFitTheWire = Assert<Fits<GamePhase, WireGamePhase>>;
type _WirePhasesFitTheSim = Assert<Fits<WireGamePhase, GamePhase>>;

/**
 * The assignment the `as never` casts were hiding. `GameEvent[]` and
 * `GameSnapshot` come from the sim; the annotation is the wire's. No cast, so
 * tsc has to agree.
 */
function wireFrameFromSim(
  turnNumber: number,
  events: GameEvent[],
  snapshot: GameSnapshot,
): ServerMessage {
  return { t: 'events', turnNumber, events, snapshot };
}

/** …and the other direction of the same assignment, field by field. */
function wireEventsFromSim(events: GameEvent[]): WireGameEvent[] {
  return events;
}

// ---------------------------------------------------------------------------
// 2. Run time, against the real sim.
// ---------------------------------------------------------------------------

const PLAYERS = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
  { id: 'p3', name: 'Cleo' },
];

/**
 * Play a whole match — every round, the shop between them, the final round —
 * and collect everything the sim said happened.
 *
 * The aims walk a fixed cycle rather than a random one so a failure reproduces
 * on the next run. A narrow board makes tanks easy to hit, which is how the
 * `tank` impact kind and the `death` / `roundEnd` / `gameOver` events get
 * produced at all; the 189-turn sweep in `frame-size.test.ts` fires on a
 * full-width board and reaches none of them.
 */
function playMatch(seed: number): { events: GameEvent[]; states: GameState[] } {
  let state = createGame({ seed, totalRounds: 2, width: 400, height: 300 }, PLAYERS);
  const events: GameEvent[] = [];
  const states: GameState[] = [state];

  const aims = [
    [40, 95],
    [55, 70],
    [140, 88],
    [125, 60],
    [70, 100],
    [110, 45],
  ] as const;

  for (let step = 0; step < 400 && state.phase !== 'gameover'; step += 1) {
    if (state.phase === 'aiming') {
      const shooter = state.tanks[state.activeTank];
      if (shooter === undefined) break;
      const aim = aims[step % aims.length];
      if (aim === undefined) break;
      const result = fire(state, shooter.id, {
        turnNumber: state.turnNumber,
        angleDeg: aim[0],
        power: aim[1],
        weapon: shooter.selectedWeapon,
      });
      state = result.state;
      events.push(...result.events);
    } else if (state.phase === 'shopping') {
      for (const id of [...state.pendingShoppers]) state = leaveShop(state, id);
      const result = startNextRound(state);
      state = result.state;
      events.push(...result.events);
    } else {
      break;
    }
    states.push(state);
  }

  return { events, states };
}

interface Difference {
  path: string;
  before: unknown;
  after: unknown;
}

/**
 * Every leaf where two plain-JSON values differ, by `Object.is` — which, unlike
 * `===`, separates `-0` from `0`, and that separation is the whole reason this
 * exists rather than a `toEqual`.
 */
function differences(before: unknown, after: unknown, path = ''): Difference[] {
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: Difference[] = [];
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      out.push(...differences(before[index], after[index], `${path}[${index}]`));
    }
    return out;
  }

  if (
    typeof before === 'object' &&
    before !== null &&
    typeof after === 'object' &&
    after !== null
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const out: Difference[] = [];
    for (const key of keys) {
      out.push(
        ...differences(
          (before as Record<string, unknown>)[key],
          (after as Record<string, unknown>)[key],
          path === '' ? key : `${path}.${key}`,
        ),
      );
    }
    return out;
  }

  return Object.is(before, after) ? [] : [{ path, before, after }];
}

describe('the sim fits through the wire', () => {
  it('validates every event a whole match produces', () => {
    const { events, states } = playMatch(19);
    expect(events.length).toBeGreaterThan(20);

    const types = new Set<string>();
    const kinds = new Set<string>();

    for (const event of events) {
      const parsed = GameEventSchema.safeParse(event);
      expect(parsed.success, `${JSON.stringify(event).slice(0, 160)}`).toBe(true);
      types.add(event.type);
      if (event.type === 'shot') kinds.add(event.impactKind);
    }

    // Every kind the sim actually emitted must be one the client knows how to
    // animate. This is the runtime half of the compile-time pin above: the type
    // check catches the sim WIDENING its union, this catches the sim emitting a
    // value its own union does not contain — which `game.ts` typing the field as
    // `string` makes possible.
    for (const kind of kinds) {
      expect(isKnownImpactKind(kind), `sim emitted unknown impact kind ${kind}`).toBe(true);
    }

    // The match has to have gone somewhere, or this test is validating an empty
    // list and saying nothing. Not asserted: WHICH events appeared — that is the
    // sim's physics, and pinning it here would go red for the wrong reason when
    // the sim owner tunes damage.
    expect(states.length).toBeGreaterThan(5);
    expect(kinds.size).toBeGreaterThan(0);

    console.log(
      `[sim-boundary] a full match at seed 19 emitted ${events.length} events: ` +
        `types [${[...types].sort().join(', ')}], impact kinds [${[...kinds].sort().join(', ')}]`,
    );
  });

  /**
   * Every snapshot of a whole match, sent and read back, compared value by value
   * rather than with `toEqual` — because `toEqual` found something and the
   * honest thing is to name it rather than loosen the comparison.
   *
   * JSON cannot write a negative zero: `JSON.stringify(-0)` is `"0"`. The sim
   * produces `wind: -0` — this match hits it, which is how it was found — so a
   * snapshot survives the wire identical except for the sign of a zero. That is
   * the ONLY difference permitted here, and the walk below proves it is the only
   * one that occurs, path by path, rather than assuming it. No turn number is
   * quoted because the sim moves; the run prints the paths it actually saw.
   *
   * Why it is allowed rather than fixed: `-0 === 0` is true, and every arithmetic
   * operation the physics performs on wind gives bit-identical results for both
   * (`v + -0` and `v + 0` are the same double for every finite v). Two clients
   * still land the shot in the same pixel, which is the guarantee this package
   * exists to protect. What would NOT be acceptable is a difference in a terrain
   * column or a health value, and this test would catch one.
   */
  it('sends every snapshot of that match down the wire, identical but for -0', () => {
    const { states } = playMatch(19);
    const negativeZeroPaths: string[] = [];

    for (const state of states) {
      // No cast: the sim's snapshot is the wire's snapshot, or this line fails
      // to compile.
      const sent = toSnapshot(state);
      const message: ServerMessage = { t: 'state', snapshot: sent };
      const parsed = parseServerMessage(encodeServerMessage(message));
      expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
      if (!parsed.ok || parsed.value.t !== 'state') continue;

      for (const { path, before, after } of differences(sent, parsed.value.snapshot)) {
        // The one difference JSON is allowed to introduce, and nothing else.
        expect(
          Object.is(before, -0) && Object.is(after, 0),
          `${path}: ${String(before)} became ${String(after)}`,
        ).toBe(true);
        negativeZeroPaths.push(path);
      }
    }

    console.log(
      negativeZeroPaths.length === 0
        ? '[sim-boundary] no snapshot in this match contained a negative zero'
        : `[sim-boundary] JSON flattened -0 to 0 at: ${[...new Set(negativeZeroPaths)].join(', ')}`,
    );
  });

  it('carries a turn built the way the room builds one, with no casts anywhere', () => {
    const state = createGame({ seed: 5, totalRounds: 2, width: 400, height: 300 }, PLAYERS);
    const shooter = state.tanks[state.activeTank];
    expect(shooter).toBeDefined();
    if (shooter === undefined) return;

    const result = fire(state, shooter.id, {
      turnNumber: state.turnNumber,
      angleDeg: 50,
      power: 90,
      weapon: shooter.selectedWeapon,
    });

    // Exactly the shape `commitTurn` broadcasts, assembled from sim values only.
    const frame = wireFrameFromSim(state.turnNumber, result.events, toSnapshot(result.state));
    expect(wireEventsFromSim(result.events)).toEqual(result.events);

    const parsed = parseServerMessage(encodeServerMessage(frame));
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
    if (parsed.ok && parsed.value.t === 'events') {
      expect(parsed.value.events).toEqual(result.events);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The cases the sim does not reach on its own.
// ---------------------------------------------------------------------------

const SNAPSHOT: GameSnapshot = toSnapshot(
  createGame({ seed: 2, totalRounds: 2, width: 400, height: 300 }, PLAYERS),
);

describe('impact kinds the arsenal sweep never reaches', () => {
  it.each([...IMPACT_KINDS])('round-trips a shot that ended in %s', (kind) => {
    const frame: ServerMessage = {
      t: 'events',
      turnNumber: 1,
      snapshot: SNAPSHOT,
      events: [
        {
          type: 'shot',
          tankIndex: 0,
          weapon: 'baby_missile',
          path: [1, 2, 3, 4],
          impactKind: kind,
        },
      ],
    };

    const parsed = parseServerMessage(encodeServerMessage(frame));
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
    if (parsed.ok && parsed.value.t === 'events') {
      const event = parsed.value.events[0];
      expect(event?.type === 'shot' ? event.impactKind : null).toBe(kind);
      expect(isKnownImpactKind(kind)).toBe(true);
    }
  });

  /**
   * A kind nobody has heard of is carried, not thrown on, and this is the whole
   * argument for `impactKind` being a bounded string instead of a `z.enum`.
   *
   * With an enum, a kind the sim gained and the schema had not yet listed makes
   * `encodeServerMessage` throw. The room calls it in `broadcast()` before the
   * send loop and outside its try, so the turn's frame is never built, nobody
   * receives the turn, and every client sits waiting for events that never
   * arrive — a frozen match caused by a cosmetic string. The field decides which
   * particle effect plays. It is not worth a match.
   *
   * The set is still enforced: it is pinned to the sim's own union at compile
   * time at the top of this file, so a real fifth kind fails a typecheck long
   * before it can reach a player.
   */
  it('carries a kind it has never heard of rather than dropping the turn', () => {
    const frame: ServerMessage = {
      t: 'events',
      turnNumber: 1,
      snapshot: SNAPSHOT,
      events: [
        { type: 'shot', tankIndex: 0, weapon: 'baby_missile', path: [], impactKind: 'wormhole' },
      ],
    };

    expect(() => encodeServerMessage(frame)).not.toThrow();
    const parsed = parseServerMessage(encodeServerMessage(frame));
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
    if (parsed.ok && parsed.value.t === 'events') {
      const event = parsed.value.events[0];
      expect(event?.type === 'shot' ? event.impactKind : null).toBe('wormhole');
      // …and a client switching on it still knows this is not one of its four.
      expect(isKnownImpactKind('wormhole')).toBe(false);
    }
  });

  /**
   * "Bounded string" is not "any string". The shape bound is what stops the one
   * thing a cosmetic field could still do — arrive 100 KB long, or full of
   * control characters, or wearing a name that means something as an object key.
   */
  it.each([
    ['empty', ''],
    ['uppercase', 'Terrain'],
    ['with a space', 'hit tank'],
    ['with a NUL', 'ter\u0000rain'],
    ['with a lone surrogate', 'terr\ud800ain'],
    ['leading digit', '1terrain'],
    ['leading underscore', '__proto__'],
    ['hyphenated', 'sub-munition'],
    ['33 characters', 'a'.repeat(33)],
    ['very long', 'a'.repeat(100_000)],
  ])('rejects an impact kind that is %s', (_label, kind) => {
    const raw = JSON.stringify({
      t: 'events',
      turnNumber: 1,
      snapshot: SNAPSHOT,
      events: [{ type: 'shot', tankIndex: 0, weapon: 'baby_missile', path: [], impactKind: kind }],
    });
    expect(parseServerMessage(raw).ok, kind.slice(0, 40)).toBe(false);
  });

  it('rejects an impact kind that is not a string at all', () => {
    for (const kind of [null, 42, true, ['terrain'], { kind: 'terrain' }]) {
      const raw = JSON.stringify({
        t: 'events',
        turnNumber: 1,
        snapshot: SNAPSHOT,
        events: [
          { type: 'shot', tankIndex: 0, weapon: 'baby_missile', path: [], impactKind: kind },
        ],
      });
      expect(parseServerMessage(raw).ok, JSON.stringify(kind)).toBe(false);
    }
  });
});
