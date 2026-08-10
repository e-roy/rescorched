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
import { makeRng } from '../src/rng.ts';
import { BABY_MISSILE } from '../src/weapons.ts';
import { openedGame } from './opening.ts';

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
  const base = openedGame({ seed, totalRounds: 3, width: WIDTH, height: HEIGHT }, players(count));
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

  it('is pulled back towards calm rather than wandering', () => {
    // This is what `WIND.retention` buys, and it has to be stated as a pull
    // rather than as "it never reaches the ends". Counting pinned values does
    // not distinguish the two models at all — the reflection below keeps a
    // plain random walk off the walls just as well — so a test that only looked
    // there passed with the mean reversion deleted.
    //
    // Nor can it be stated as a decay from a full-scale wind: the reflection
    // pushes away from the wall on its own, so both models come back from +10
    // and the measurement says nothing about the pull.
    //
    // What the pull actually controls is how far the wind gets from calm when
    // it starts there. Release it from zero and let it run: mean reversion
    // holds it in a band around calm, an unpulled walk spreads out over the
    // whole dial.
    //
    // The chains vary only `rngState`, off one map — the wind model never reads
    // the terrain, so this buys 120 independent chains without paying for 120
    // more `generateTerrain` calls. It needs to be that many: a dozen chains
    // moved the mean by half a point between seeds, which is most of the
    // distance being measured.
    const base = stalemateGame(2, 'calm');
    const values: number[] = [];
    for (let chain = 0; chain < 120; chain += 1) {
      let state: GameState = { ...base, wind: 0, rngState: makeRng(`calm-${chain}`).save() };
      for (let i = 0; i < 25 && state.phase === 'aiming'; i += 1) {
        state = step(state);
        values.push(state.wind);
      }
    }

    const meanAbs = values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;
    const strong = values.filter((value) => Math.abs(value) > DEFAULT_WORLD.maxWind / 2).length;
    const report = `n=${values.length} meanAbs=${meanAbs.toFixed(2)} strong=${strong}`;

    expect(values.length).toBe(120 * 25);
    // Measured over these 3000 turns: mean |wind| 2.46, with 10.5% of turns
    // past half scale. Raising `retention` towards a pure random walk takes it
    // to 3.01 / 19.4% at 0.95, 3.61 / 28.6% at 0.99 and 3.78 / 31.0% at 1.
    // A wind as likely to be 8 as 1 is a wind nobody can plan around.
    expect(meanAbs, report).toBeLessThan(2.8);
    expect(strong / values.length, report).toBeLessThan(0.15);
    // Bounded from below too, so that "calm" cannot quietly become "no wind at
    // all": the same run measures 1.39 at retention 0.5 and 1.24 at 0.1, and a
    // dial that never leaves the middle is a dial worth deleting.
    expect(meanAbs, report).toBeGreaterThan(1.5);
  });

  it('uses the whole dial without ever leaving it', () => {
    const { values } = samples;
    // Not timid: it reaches past half scale in both directions.
    expect(Math.max(...values)).toBeGreaterThan(DEFAULT_WORLD.maxWind / 2);
    expect(Math.min(...values)).toBeLessThan(-DEFAULT_WORLD.maxWind / 2);
    // And never pinned to an end. Measured at zero of these samples.
    expect(values.filter((value) => Math.abs(value) >= DEFAULT_WORLD.maxWind - 0.05).length).toBe(
      0,
    );
  });

  it('bounces off the ends of the dial instead of sticking to them', () => {
    // The other half of the model, and the only part of it that can be seen
    // from a wind already at full scale — which is why this test puts one
    // there rather than waiting for a long run to wander over.
    //
    // From wind = +10 the next value is 9 plus a drift of up to 2.5, so about
    // 30% of draws overshoot the dial. A clamp lands every one of those exactly
    // on the wall; folding them back does not. Measured over 300 draws: 7 land
    // on the wall here, 120 with the fold replaced by a clamp. The 7 are the
    // draws that genuinely round to 10.0, not draws that were pushed there.
    const base = stalemateGame(2, 'reflect');
    let onTheWall = 0;
    const draws = 300;
    for (let seed = 0; seed < draws; seed += 1) {
      const after = step({
        ...base,
        wind: DEFAULT_WORLD.maxWind,
        rngState: makeRng(`reflect-${seed}`).save(),
      });
      expect(Math.abs(after.wind)).toBeLessThanOrEqual(DEFAULT_WORLD.maxWind);
      if (Math.abs(after.wind) >= DEFAULT_WORLD.maxWind) onTheWall += 1;
    }
    expect(onTheWall / draws, `onTheWall=${onTheWall}/${draws}`).toBeLessThan(0.1);
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
