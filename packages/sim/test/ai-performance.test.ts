/**
 * What a bot's turn costs.
 *
 * This runs inside a Durable Object while a room full of people waits, so the
 * search has to be bounded and the bound has to be defended by something other
 * than good intentions. A future "smarter" bot must not be able to make turns
 * take seconds without a test going red.
 *
 * ---------------------------------------------------------------------------
 * Measured
 * ---------------------------------------------------------------------------
 *
 * 240 real matches — five terrain styles by {2, 4, 8, 16} players by 12 seeds,
 * every tank stocked with nine rounds of every weapon so the heaviest blast
 * radius is in play — asking every seat for a decision. 1800 decisions per
 * personality, 10800 in all. Times are the MINIMUM of nine runs, which is the
 * honest cost of the work: a single-sample maximum on a machine with other
 * things to do measures the scheduler, not the code. (`game.ts` says the same
 * thing about `createGame`'s timings, and for the same reason.)
 *
 *     personality   flights mean/max   ms mean/max
 *     MORON               0.0 / 0      0.002 / 0.006
 *     SHOOTER             4.9 / 30     0.076 / 1.373
 *     TOSSER              2.7 / 28     0.068 / 1.339
 *     POOLSHARK           2.0 / 3      0.074 / 0.394
 *     CYBORG              5.8 / 40     0.098 / 1.424
 *     ANNIHILATOR         5.8 / 40     0.099 / 1.914
 *
 * Worst single decision anywhere: 1.9 ms and 40 flights. Whole sweep: 10800
 * decisions in 1023 ms, 0.095 ms each. The means are far below the maxima
 * because the search stops the moment a probe lands a direct hit, which on
 * these maps is most of the time.
 *
 * ---------------------------------------------------------------------------
 * Why FLIGHTS is the assertion that matters
 * ---------------------------------------------------------------------------
 *
 * A wall-clock bound on someone else's CI box is a coin toss: too tight and it
 * flakes, loose enough not to flake and it no longer catches a doubling. The
 * flight count has neither problem — it is deterministic, identical on every
 * machine, and it is exactly the quantity a wider search or an extra refinement
 * pass would move. So the sharp bound is on flights, and the timing assertions
 * are stated RELATIVE to the cost of one flight measured in the same process,
 * which makes them machine-independent too.
 */

import { describe, expect, it } from 'vitest';

import { BOT_PERSONALITIES, chooseShotDetailed, type BotPersonality } from '../src/ai.ts';
import { createGame, predictShot, type GameState, type PlayerSeed } from '../src/game.ts';
import { TERRAIN_STYLES } from '../src/terrain.ts';
import { WEAPONS } from '../src/weapons.ts';

const WIDTH = 1280;
const HEIGHT = 720;
const COUNTS = [2, 4, 8, 16];
const SEEDS = 5;
const REPEATS = 5;

/**
 * `performance` is not in the sim's type surface — the package compiles with
 * `types: []` precisely so nothing in `src` can reach for a platform global.
 * A test may, and this is the one place that does.
 */
const clock = (globalThis as unknown as { performance: { now: () => number } }).performance;

const seats = (count: number): PlayerSeed[] =>
  Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

const GAMES: GameState[] = [];
for (const style of TERRAIN_STYLES) {
  for (const count of COUNTS) {
    for (let seed = 0; seed < SEEDS; seed += 1) {
      const base = createGame(
        {
          seed: `perf-${style}-${count}-${seed}`,
          terrainStyle: style,
          width: WIDTH,
          height: HEIGHT,
        },
        seats(count),
      );
      GAMES.push({
        ...base,
        tanks: base.tanks.map((tank) => ({
          ...tank,
          inventory: Object.fromEntries(WEAPONS.map((weapon) => [weapon.id, 9])),
        })),
      });
    }
  }
}

const max = (values: number[]): number => values.reduce((a, b) => Math.max(a, b), -Infinity);
const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

/** Min of `REPEATS` runs — the noise floor is the cost of the work itself. */
function timeOnce(run: () => void): number {
  let best = Infinity;
  for (let attempt = 0; attempt < REPEATS; attempt += 1) {
    const started = clock.now();
    run();
    best = Math.min(best, clock.now() - started);
  }
  return best;
}

interface Sweep {
  flights: number[];
  times: number[];
}

const CACHE = new Map<BotPersonality, Sweep>();

function sweep(personality: BotPersonality): Sweep {
  const cached = CACHE.get(personality);
  if (cached !== undefined) return cached;

  const flights: number[] = [];
  const times: number[] = [];
  for (const state of GAMES) {
    for (let seat = 0; seat < state.tanks.length; seat += 1) {
      flights.push(chooseShotDetailed(state, seat, undefined, personality).flights);
      times.push(timeOnce(() => void chooseShotDetailed(state, seat, undefined, personality)));
    }
  }
  const result = { flights, times };
  CACHE.set(personality, result);
  return result;
}

/** Cost of one `simulateFlight` on THIS machine, measured the same way. */
function flightCostMs(): number {
  const samples: number[] = [];
  for (const state of GAMES) {
    samples.push(timeOnce(() => void predictShot(state, 0, 55, 70)));
  }
  return mean(samples);
}

// Warm the JIT so the first personality measured is not paying for everyone.
for (const personality of BOT_PERSONALITIES) {
  for (const state of GAMES) chooseShotDetailed(state, 0, undefined, personality);
}

describe('a bot decision stays cheap', () => {
  it('never spends more than 44 flights, whoever it is', () => {
    // A LITERAL, not `SEARCH.maxFlights`. Asserting against the ceiling the
    // code enforces with a counter could not fail — it is the definition of the
    // thing under test. 44 is what the ladders can actually produce: eight
    // rungs of four probes plus four refinements of three. Measured worst: 40.
    for (const personality of BOT_PERSONALITIES) {
      const { flights } = sweep(personality);
      expect(max(flights), `${personality} worst=${max(flights)}`).toBeLessThanOrEqual(44);
    }
  }, 600_000);

  it('spends far fewer than that on a typical turn', () => {
    // The ceiling is not the cost. The search abandons the ladder the moment a
    // probe scores a direct hit, so the mean is a small fraction of the worst
    // case — measured 5.8 flights for the Cyborg and the Annihilator against a
    // 40-flight worst case. A change that made every decision pay the ceiling
    // would be a 7x regression that the bound above would not notice.
    for (const personality of BOT_PERSONALITIES) {
      const { flights } = sweep(personality);
      expect(mean(flights), `${personality} mean=${mean(flights).toFixed(1)}`).toBeLessThan(12);
    }
  }, 600_000);

  it('costs no more than the flights it declares, on any machine', () => {
    // The machine-independent timing bound: whatever a `simulateFlight` costs
    // here, a decision may cost the flights it made plus a slack factor for the
    // scoring, the closed-form seed and the shopping-free bookkeeping around
    // it. Measured, the worst decision comes in at about 1.3x its own flights.
    const perFlight = flightCostMs();
    expect(perFlight).toBeGreaterThan(0);

    for (const personality of BOT_PERSONALITIES) {
      const { flights, times } = sweep(personality);
      const worst = max(times);
      const budget = (max(flights) + 4) * perFlight * 4;
      expect(
        worst,
        `${personality}: worst ${worst.toFixed(3)} ms, ${max(flights)} flights, ` +
          `one flight ${perFlight.toFixed(4)} ms, budget ${budget.toFixed(3)} ms`,
      ).toBeLessThan(budget);
    }
  }, 600_000);

  it('keeps a whole turn under a hard millisecond ceiling', () => {
    // The absolute backstop. Deliberately loose — 20x the 1.9 ms measured here
    // — because it exists to catch a catastrophe (an unbounded loop, a search
    // that grew an order of magnitude) on a CI box that may be several times
    // slower than this one, not to police tuning. The two assertions above are
    // the ones with teeth.
    const worst = max(BOT_PERSONALITIES.map((personality) => max(sweep(personality).times)));
    expect(worst, `worst single decision ${worst.toFixed(3)} ms`).toBeLessThan(40);
  }, 600_000);

  it('costs the Moron nothing at all', () => {
    // It does not simulate anything, and that is a design statement rather than
    // an accident: the difficulty floor should also be the cheapest seat at the
    // table, so a lobby full of Morons cannot cost a room anything.
    expect(max(sweep('moron').flights)).toBe(0);
  }, 600_000);
});
