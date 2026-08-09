/**
 * Whose turn it is, and what the wind is doing.
 *
 * Both are things a player notices immediately and neither can be tested
 * through a real match without the match interfering: a shot that lands on
 * somebody changes who is alive, which changes the order. So most of this runs
 * on `stalemateGame` — a flat ledge with the tanks spaced so that the one shot
 * every test fires cannot possibly touch anybody. The helper asserts that for
 * itself on the first call, so if the geometry ever stops being harmless these
 * tests fail loudly rather than quietly measuring something else.
 */

import { describe, expect, it } from 'vitest';
import {
  createGame,
  DEFAULT_WORLD,
  fire,
  turnOrder,
  WIND,
  type GameState,
  type PlayerSeed,
  type Tank,
} from '../src/game.ts';
import { emptyTerrain } from '../src/terrain.ts';
import { BABY_MISSILE } from '../src/weapons.ts';

const WIDTH = 1280;
const HEIGHT = 720;
const GROUND = 400;

const players = (count: number): PlayerSeed[] =>
  Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

/**
 * A match nobody can win: flat ground, tanks at x = 100, 300, 500, 700, and the
 * only shot anybody fires is 45 degrees at full power.
 *
 * The gun's flat range is v^2/g = 1040 px and full wind moves a 45-degree shot
 * by an eighth of that, so the shot from x = 100 lands somewhere in 1010..1270
 * and every other tank's leaves the map entirely. The nearest tank to any
 * impact is 310 px away; the widest blast in the game is nothing like that.
 */
function stalemateGame(count: number, seed: string): GameState {
  if (count > 4) throw new Error('the harmless geometry only holds for up to 4 tanks');
  const base = createGame({ seed, totalRounds: 3, width: WIDTH, height: HEIGHT }, players(count));
  const terrain = emptyTerrain(WIDTH, HEIGHT);
  terrain.surface.fill(GROUND);
  return {
    ...base,
    terrain,
    wind: 0,
    tanks: base.tanks.map((tank, index) => ({ ...tank, x: 100 + index * 200, y: GROUND })),
  };
}

const HARMLESS = { angleDeg: 45, power: 100, weapon: BABY_MISSILE } as const;

/**
 * The wind 60 fresh matches open on.
 *
 * Drawn on a smaller world than the game plays on, purely for wall clock: the
 * opening wind comes off its own fork of the seed and does not depend on the
 * map at all, but generating sixty 1280x720 maps to read sixty numbers off them
 * costs several seconds.
 */
const openingWinds = Array.from(
  { length: 60 },
  (_, seed) => createGame({ seed, width: 640, height: 400 }, players(2)).wind,
);

/** Fire the harmless shot for whoever is up, and prove it really was harmless. */
function step(state: GameState): GameState {
  const shooter = state.tanks[state.activeTank] as Tank;
  const result = fire(state, shooter.id, { turnNumber: state.turnNumber, ...HARMLESS });
  expect(
    result.events.filter((event) => event.type === 'damage'),
    'the stalemate fixture stopped being harmless',
  ).toEqual([]);
  return result.state;
}

describe('turn order', () => {
  it('is a permutation of the whole lobby', () => {
    for (let count = 1; count <= 8; count += 1) {
      for (let round = 1; round <= 4; round += 1) {
        const state = { seed: 12345, round, tanks: players(count) as unknown as Tank[] };
        const order = turnOrder(state);
        expect(order).toHaveLength(count);
        expect([...order].sort((a, b) => a - b)).toEqual(
          Array.from({ length: count }, (_, i) => i),
        );
      }
    }
  });

  it('is the same every time for the same seed and round', () => {
    const state = { seed: 99, round: 3, tanks: players(6) as unknown as Tank[] };
    expect(turnOrder(state)).toEqual(turnOrder(state));
  });

  it('does not depend on how much of the match has been played', () => {
    // Derived from (seed, round), never from `rngState` — which advances on
    // every shot. An order that moved mid-round would hand somebody two turns.
    const start = stalemateGame(3, 'stable-order');
    const before = turnOrder(start);
    let state = start;
    for (let i = 0; i < 5; i += 1) state = step(state);
    expect(turnOrder(state)).toEqual(before);
    expect(state.round).toBe(start.round);
  });

  it('reshuffles between rounds instead of letting one player always open', () => {
    // The original randomises who shoots first each round. With a fixed order,
    // player 1 in a two-player match gets the first shot of every round of
    // every match, which over five rounds is five free ranging shots.
    const leaders = new Map<number, number>();
    for (let seed = 0; seed < 60; seed += 1) {
      for (let round = 1; round <= 5; round += 1) {
        const first = turnOrder({
          seed,
          round,
          tanks: players(2) as unknown as Tank[],
        })[0] as number;
        leaders.set(first, (leaders.get(first) ?? 0) + 1);
      }
    }
    expect(leaders.size).toBe(2);
    // 300 draws; a fair coin is nowhere near 40/60. This is a smoke test for
    // "the shuffle is not degenerate", not a statistical claim.
    for (const count of leaders.values()) {
      expect(count).toBeGreaterThan(300 * 0.4);
      expect(count).toBeLessThan(300 * 0.6);
    }
  });

  it('opens the round on the first tank of the order', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const state = createGame({ seed }, players(4));
      expect(state.activeTank).toBe(turnOrder(state)[0]);
    }
  });

  it('gives every living tank exactly one turn per cycle, in order', () => {
    const state = stalemateGame(4, 'cycle');
    const order = turnOrder(state);

    let current = state;
    const seen: number[] = [current.activeTank];
    for (let i = 0; i < 11; i += 1) {
      current = step(current);
      seen.push(current.activeTank);
    }

    // Three full laps of the same four-tank order, starting wherever it started.
    const expected = Array.from({ length: 12 }, (_, i) => order[i % order.length] as number);
    expect(seen).toEqual(expected);
  });

  it('skips the dead', () => {
    let state = stalemateGame(4, 'skip-the-dead');
    const order = turnOrder(state);
    // Kill the two tanks that would have shot second and third this round.
    const doomed = new Set([order[1] as number, order[2] as number]);
    state = {
      ...state,
      tanks: state.tanks.map((tank, index) =>
        doomed.has(index) ? { ...tank, alive: false, health: 0 } : tank,
      ),
    };

    const living = order.filter((index) => !doomed.has(index));
    const seen: number[] = [state.activeTank];
    for (let i = 0; i < 5; i += 1) {
      state = step(state);
      seen.push(state.activeTank);
    }

    for (const index of seen) expect(doomed.has(index)).toBe(false);
    expect(seen).toEqual(Array.from({ length: 6 }, (_, i) => living[i % living.length] as number));
  });

  it('announces every handover with a turn event', () => {
    const state = stalemateGame(3, 'events');
    const shooter = state.tanks[state.activeTank] as Tank;
    const { state: after, events } = fire(state, shooter.id, {
      turnNumber: state.turnNumber,
      ...HARMLESS,
    });
    const turns = events.filter((event) => event.type === 'turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({
      type: 'turn',
      activeTank: after.activeTank,
      turnNumber: after.turnNumber,
      wind: after.wind,
    });
  });
});

describe('wind', () => {
  /**
   * Every wind value a dozen long stalemates produce, and the step that made
   * each one. Built once — `createGame` generates a whole map, and three tests
   * asking for their own samples is three times the terrain for no more
   * evidence.
   */
  const samples = ((): { values: number[]; steps: number[] } => {
    const values: number[] = [];
    const steps: number[] = [];
    for (let seed = 0; seed < 12; seed += 1) {
      // Start from a real rolled wind rather than the fixture's zero.
      let state = { ...stalemateGame(2, `wind-${seed}`), wind: openingWinds[seed] as number };
      values.push(state.wind);
      for (let i = 0; i < 30 && state.phase === 'aiming'; i += 1) {
        const previous = state.wind;
        state = step(state);
        values.push(state.wind);
        steps.push(state.wind - previous);
      }
    }
    return { values, steps };
  })();

  it('stays on the dial, changes every turn, and never lurches', () => {
    const { values, steps } = samples;
    expect(steps.length).toBeGreaterThan(300);

    // The largest step the model can take is `drift` plus what mean reversion
    // pulls off a full-scale wind: 2.5 + 10 * (1 - 0.9). Rounding to one
    // decimal place can add half a tenth at each end.
    const largest = WIND.drift + DEFAULT_WORLD.maxWind * (1 - WIND.retention) + 0.1;

    for (const value of values) {
      expect(Math.abs(value)).toBeLessThanOrEqual(DEFAULT_WORLD.maxWind);
      // One decimal place, exactly as the HUD shows it.
      expect(Math.round(value * 10) / 10).toBe(value);
    }
    for (const step of steps) {
      expect(Math.abs(step)).toBeLessThanOrEqual(largest);
    }

    // It really does move. A wind that only changed occasionally would let a
    // player range in once and then own the round.
    const moved = steps.filter((value) => value !== 0).length;
    expect(moved).toBeGreaterThan(steps.length * 0.95);
  });

  it('does not camp at the ends of the dial', () => {
    // This is what the mean reversion buys. A plain random walk against a hard
    // clamp piles up at the walls, and a wind stuck at -10 for six turns reads
    // as the game holding a grudge.
    const { values } = samples;
    const pinned = values.filter((value) => Math.abs(value) >= DEFAULT_WORLD.maxWind - 0.05).length;
    expect(pinned / values.length).toBeLessThan(0.02);

    // And it is not timid either: it reaches past half scale in both
    // directions, so the dial is used rather than decorative.
    expect(Math.max(...values)).toBeGreaterThan(DEFAULT_WORLD.maxWind / 2);
    expect(Math.min(...values)).toBeLessThan(-DEFAULT_WORLD.maxWind / 2);
  });

  it('is drawn fresh at the start of every match', () => {
    for (const wind of openingWinds) {
      expect(Math.abs(wind)).toBeLessThanOrEqual(DEFAULT_WORLD.maxWind);
      expect(Math.round(wind * 10) / 10).toBe(wind);
    }
    // 60 draws over the 201 values the one-decimal dial can hold: a constant or
    // near-constant opening wind would collapse this.
    expect(new Set(openingWinds).size).toBeGreaterThan(40);
  });
});
