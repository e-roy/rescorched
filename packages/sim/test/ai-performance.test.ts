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
 * every tank stocked with nine rounds of every weapon and sitting on an uneven
 * spread of health — asking every seat for a decision. 1800 decisions per
 * personality, 10800 in all. Times are the MINIMUM of five runs, which is the
 * honest cost of the work: a single-sample maximum on a machine with other
 * things to do measures the scheduler, not the code. (`game.ts` says the same
 * thing about `createGame`'s timings, and for the same reason.)
 *
 * The health spread is not decoration. At uniform health "shoot whoever is
 * closest to dead" is the same rule as "shoot whoever is nearest", so a
 * full-health sweep measures the Annihilator's target selection without ever
 * running it — which is what this file did until a reviewer pointed it out. On
 * this corpus `picksTheKill` picks a different tank from `nearest` on 1479 of
 * the 1800 seats, so the worst case below is measured with it working.
 *
 *     personality   flights mean/max   ms mean/max    flights mean by lobby
 *                                                     2p    4p    8p   16p
 *     MORON               0.0 / 0      0.001 / 0.002   0.0   0.0   0.0   0.0
 *     SHOOTER             4.8 / 30     0.026 / 0.334   7.5   6.6   5.6   3.6
 *     TOSSER              2.7 / 28     0.024 / 0.339   5.5   3.8   3.0   1.9
 *     POOLSHARK           2.0 / 3      0.027 / 0.159   2.2   2.1   2.1   2.0
 *     CYBORG             19.0 / 44     0.143 / 0.725   9.9   8.5  11.9  26.3
 *     ANNIHILATOR         9.5 / 41     0.175 / 2.207   9.9   9.1   9.2   9.7
 *
 * Worst single decision anywhere: 2.2 ms and 44 flights — and the two are not
 * the same decision. The 2.2 ms one is an Annihilator spending 37 flights on a
 * crowded mountain map, where every probe is a long high lob and so each flight
 * costs about three times the sweep's average flight. That ratio reproduced
 * across three isolated runs, so it is the work rather than the scheduler.
 *
 * The whole-sweep means are dominated by the 16-player lobbies, which are 960
 * of the 1800 seats; the per-lobby columns are the honest read, and the duel
 * column is the case this feature exists for.
 *
 * The Cyborg's crowded-lobby number is the price of `avoidsSelfHarm` and is
 * explained where it is asserted below. Everyone else is far below the ceiling
 * because the search stops the moment a probe lands a clean direct hit.
 *
 * Those are isolated-run figures. With the rest of the suite competing for the
 * same cores the same worst case measures roughly twice that, which is the
 * number to hold in your head for a Durable Object sharing a machine — and it
 * is still an order of magnitude under the 40 ms backstop below.
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
const SEEDS = 12;
const REPEATS = 5;

/**
 * `performance` is not in the sim's type surface — the package compiles with
 * `types: []` precisely so nothing in `src` can reach for a platform global.
 * A test may, and this is the one place that does.
 */
const clock = (globalThis as unknown as { performance: { now: () => number } }).performance;

const seats = (count: number): PlayerSeed[] =>
  Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

/** A match in the sweep, tagged with its lobby size so tests can slice by it. */
interface Match {
  state: GameState;
  count: number;
}

const GAMES: Match[] = [];
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
        count,
        state: {
          ...base,
          /*
           * Full armoury, and deliberately UNEVEN health.
           *
           * The armoury is so the heaviest blast radius is in play. The health
           * is so `picksTheKill` and `economical` are too: at uniform health
           * "shoot whoever is closest to dead" degenerates into "shoot whoever
           * is nearest", so a sweep of full-health tanks measures the
           * Annihilator's target selection without ever running it. Worth
           * saying because it was true here for a while and nobody could tell
           * from the numbers.
           */
          tanks: base.tanks.map((tank, index) => ({
            ...tank,
            health: 4 + ((index * 37 + seed * 13) % 97),
            inventory: Object.fromEntries(WEAPONS.map((weapon) => [weapon.id, 9])),
          })),
        },
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
  /** Lobby size each entry came from, parallel to `flights`. */
  counts: number[];
}

const CACHE = new Map<BotPersonality, Sweep>();

function sweep(personality: BotPersonality): Sweep {
  const cached = CACHE.get(personality);
  if (cached !== undefined) return cached;

  const flights: number[] = [];
  const times: number[] = [];
  const counts: number[] = [];
  for (const match of GAMES) {
    for (let seat = 0; seat < match.state.tanks.length; seat += 1) {
      flights.push(chooseShotDetailed(match.state, seat, { personality }).flights);
      times.push(timeOnce(() => void chooseShotDetailed(match.state, seat, { personality })));
      counts.push(match.count);
    }
  }
  const result = { flights, times, counts };
  CACHE.set(personality, result);
  return result;
}

/** The flight counts from lobbies of exactly `count` players. */
function flightsAt(personality: BotPersonality, count: number): number[] {
  const { flights, counts } = sweep(personality);
  return flights.filter((_, index) => counts[index] === count);
}

/**
 * Cost of one `simulateFlight` on THIS machine, measured the same way.
 *
 * Over a SPREAD of arcs rather than one shot, because flight cost is dominated
 * by time of flight: a flat 45/70 costs about half what an 80-degree lob at
 * full power does, and the decisions that take the longest are precisely the
 * ones made of long lobs. A single flat reference shot made the ratio below
 * read 3x when the honest number is nearer 1x.
 */
function flightCostMs(): number {
  const samples: number[] = [];
  for (const match of GAMES) {
    for (const [angleDeg, power] of [
      [25, 40],
      [45, 70],
      [65, 95],
      [80, 100],
    ] as [number, number][]) {
      samples.push(timeOnce(() => void predictShot(match.state, 0, angleDeg, power)));
    }
  }
  return mean(samples);
}

// Warm the JIT so the first personality measured is not paying for everyone.
for (const personality of BOT_PERSONALITIES) {
  for (const match of GAMES) chooseShotDetailed(match.state, 0, { personality });
}

describe('a bot decision stays cheap', () => {
  it('never spends more than 44 flights, whoever it is', () => {
    // A LITERAL, not `SEARCH.maxFlights`. Asserting against the ceiling the
    // code enforces with a counter could not fail — it is the definition of the
    // thing under test. 44 is what the ladders can actually produce: eight
    // rungs of four probes plus four refinements of three, which is the number
    // that would move if a band were widened or a pass added.
    for (const personality of BOT_PERSONALITIES) {
      const { flights } = sweep(personality);
      expect(max(flights), `${personality} worst=${max(flights)}`).toBeLessThanOrEqual(44);
    }
  }, 600_000);

  it('spends a fraction of that in a duel, which is the case that matters', () => {
    // The ceiling is not the cost. The search abandons the ladder the moment a
    // probe scores a clean direct hit, and in a two-player game — the lobby this
    // whole feature exists to fill — that is most of the time: measured 9.9
    // flights for the Cyborg and the Annihilator against a 44-flight worst case.
    // A change that made every decision pay the ceiling would be a 4x regression
    // that the bound above could not notice.
    for (const personality of BOT_PERSONALITIES) {
      const flights = flightsAt(personality, 2);
      expect(mean(flights), `${personality} duel mean=${mean(flights).toFixed(1)}`).toBeLessThan(
        12,
      );
    }
  }, 600_000);

  it('pays for self-preservation only where self-preservation is hard', () => {
    /*
     * The one place the search really works is a crowded map, and it is worth
     * saying why rather than just bounding it. Sixteen tanks on a 1280 px field
     * sit about 80 px apart; the Cyborg's gun of choice with a full armoury is
     * a Nuke, whose blast is 90. So almost every shot that hits its neighbour
     * also lands on the Cyborg, `scoreOf` charges it for that, and the search
     * declines to stop early and goes hunting for a shot that does not — often
     * all the way to the structural ceiling.
     *
     * Measured mean flights, Cyborg: 9.9 at two players, 8.5 at four, 11.9 at
     * eight, 26.3 at sixteen. The Annihilator stays at 9.7 even in the crowd
     * because `economical` drops it to a smaller round against a wounded
     * target, and a smaller blast mostly fits between two tanks.
     *
     * The bound is set below the 44-flight ceiling so that "the search now
     * always runs to the end" still fails here, which is the regression this
     * catches — but above the measured 26.3, because paying for the ladder when
     * the alternative is nuking yourself is the intended behaviour, not a bug.
     */
    for (const personality of BOT_PERSONALITIES) {
      const flights = flightsAt(personality, 16);
      expect(
        mean(flights),
        `${personality} 16-player mean=${mean(flights).toFixed(1)}`,
      ).toBeLessThan(34);
    }
  }, 600_000);

  it('costs no more than the flights it declares, on any machine', () => {
    /*
     * The machine-independent timing bound: whatever a `simulateFlight` costs
     * here, a decision may cost the flights it made plus a slack factor.
     *
     * The slack is real work, not padding, and it is worth naming what it pays
     * for. A decision's flights are not average flights. The most expensive
     * Annihilator decision in the sweep — 2.2 ms over 37 flights — is one where
     * every probe is a long high lob on a crowded mountain map, and each of
     * those costs about 3x the mean flight in `flightCostMs` even after that
     * reference was widened to include an 80-degree lob at full power. So the
     * factor of 4 is roughly "the worst flights are three times the average
     * one, plus a little", and it leaves about 60% headroom on this machine.
     */
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
    // The absolute backstop. Deliberately loose — 18x the 2.2 ms measured in
    // isolation and around 9x what a loaded suite shows — because it exists to
    // catch a catastrophe (an unbounded loop, a search that grew an order of
    // magnitude) on a CI box that may be several times slower than this one,
    // not to police tuning. The flight-count assertions above are the ones with
    // teeth.
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
