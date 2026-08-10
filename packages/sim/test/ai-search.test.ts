/**
 * Every stage of the solver has to earn its place, measured.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists
 * ---------------------------------------------------------------------------
 *
 * A reviewer took the shipped search apart one stage at a time and watched the
 * whole suite stay green through all of it: deleting the refinement pass, and
 * turning Newton off by dropping the coarse probes from four to one. Neither is
 * cosmetic — the first costs the Annihilator four and a half points of hit rate
 * and doubles its mean miss, the second costs it five points — and neither had
 * a test that could see it, because the only absolute accuracy anchor anywhere
 * was "the Annihilator hits more than half the time" against a measured 92%.
 *
 * The fix is not a tighter number. It is that the search plan is now a
 * PARAMETER (`SearchPlan` in `ai.ts`), so a test can run the identical corpus
 * with a stage and without it and compare the two directly. Deleting a stage
 * from `DEFAULT_SEARCH_PLAN` makes the default identical to its own ablation,
 * and every strict inequality below fails.
 *
 * ---------------------------------------------------------------------------
 * Measured — 100 real duels (5 terrain styles x 20 seeds) x both seats,
 * opening shot, free Baby Missile, scored through the real `predictShot`
 * ---------------------------------------------------------------------------
 *
 *     plan                     ANNIHILATOR        CYBORG          TOSSER
 *                             hit%  meanMiss   hit%  meanMiss   hit%  meanMiss
 *     as shipped              92.0     6.5     73.0    23.8     35.5    42.6
 *     refinement pass gone    87.5    12.7     69.0    30.2     36.5    44.6
 *     coarse probes 4 -> 1    87.0    12.2     68.5    35.7     31.5    46.8
 *     coarse step 10 -> 20    87.5     9.7     68.5    23.8     36.0    45.7
 *
 * The Tosser is in the table rather than in the assertions on purpose: its band
 * is narrow enough that the coarse ladder alone usually finds the answer, so
 * refinement is worth nothing to it and occasionally costs it a point. A stage
 * that pays for the two bots at the top of the ladder and not for the one
 * halfway down is a true statement about the stage, and pretending otherwise by
 * asserting it everywhere would be the kind of test that gets weakened later.
 */

import { describe, expect, it } from 'vitest';

import {
  BOT_PERSONALITIES,
  botProfile,
  chooseShot,
  chooseShotDetailed,
  DEFAULT_SEARCH_PLAN,
  elevationLadder,
  type BotPersonality,
  type SearchPlan,
} from '../src/ai.ts';
import { DEFAULT_WORLD, predictShot, type GameState, type Tank } from '../src/game.ts';
import { hypot2 } from '../src/math.ts';
import { TERRAIN_STYLES } from '../src/terrain.ts';
import { requireWeapon, WEAPONS } from '../src/weapons.ts';
import { openedGame } from './opening.ts';

const WIDTH = 1280;
const HEIGHT = 720;

const DUELS: GameState[] = [];
for (const style of TERRAIN_STYLES) {
  for (let seed = 0; seed < 20; seed += 1) {
    DUELS.push(
      openedGame(
        { seed: `spread-${style}-${seed}`, terrainStyle: style, width: WIDTH, height: HEIGHT },
        [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
        ],
      ),
    );
  }
}

/**
 * Three sixteen-tank boards with one of everything in the rack.
 *
 * The only situation where the search regularly runs long: neighbours 80 px
 * apart and a 90 px blast, so a self-preserving bot keeps declining shots that
 * would land on its own hull and walks the whole ladder. Needed here because a
 * duel decision costs about nine flights, and a ceiling nothing ever reaches
 * cannot be shown to be connected to anything.
 */
const CROWDS: GameState[] = [0, 1, 2].map((seed) => {
  const base = openedGame(
    { seed: `crowd-${seed}`, width: WIDTH, height: HEIGHT },
    Array.from({ length: 16 }, (_, index) => ({ id: `c${index}`, name: `C${index}` })),
  );
  return {
    ...base,
    tanks: base.tanks.map((tank) => ({
      ...tank,
      inventory: Object.fromEntries(WEAPONS.map((weapon) => [weapon.id, 9])),
    })),
  };
});

interface Accuracy {
  hitRate: number;
  meanMiss: number;
}

/** Opening shot from both seats of every duel, flown through the real physics. */
function accuracy(personality: BotPersonality, search: SearchPlan): Accuracy {
  let hits = 0;
  let total = 0;
  let missSum = 0;

  for (const state of DUELS) {
    for (const shooter of [0, 1]) {
      const target = 1 - shooter;
      const decision = chooseShot(state, shooter, { personality, search });
      const trajectory = predictShot(state, shooter, decision.angleDeg, decision.power);
      const tank = state.tanks[target] as Tank;
      const direct = trajectory.impact.kind === 'tank' && trajectory.impact.tankIndex === target;
      const miss = direct
        ? 0
        : hypot2(
            trajectory.impact.x - tank.x,
            trajectory.impact.y - (tank.y - DEFAULT_WORLD.tankRadius / 2),
          );
      if (direct || miss <= requireWeapon(decision.weapon).radius) hits += 1;
      missSum += miss;
      total += 1;
    }
  }
  return { hitRate: hits / total, meanMiss: missSum / total };
}

const show = (label: string, a: Accuracy): string =>
  `${label} hit ${(100 * a.hitRate).toFixed(1)}% meanMiss ${a.meanMiss.toFixed(1)}px`;

/** Compare the shipped plan against one with a single stage removed. */
function ablate(
  personality: BotPersonality,
  label: string,
  plan: SearchPlan,
): { full: Accuracy; without: Accuracy; report: string } {
  const full = accuracy(personality, DEFAULT_SEARCH_PLAN);
  const without = accuracy(personality, plan);
  return {
    full,
    without,
    report: `${personality}: ${show('shipped', full)} | ${show(label, without)}`,
  };
}

describe('the search plan the tests ablate is the one production runs', () => {
  it('decides identically with the default plan named explicitly and left out', () => {
    // Without this the whole file could be measuring a plan nobody ships.
    for (const personality of BOT_PERSONALITIES) {
      for (const state of DUELS.slice(0, 10)) {
        expect(chooseShot(state, 0, { personality, search: DEFAULT_SEARCH_PLAN })).toEqual(
          chooseShot(state, 0, { personality }),
        );
      }
    }
  }, 120_000);
});

describe('the refinement pass earns its flights', () => {
  it('lands shots the coarse ladder alone does not, for the bots at the top', () => {
    // Measured: Annihilator 92.0% -> 87.5% and 6.5px -> 12.7px of mean miss;
    // Cyborg 73.0% -> 69.0% and 23.8px -> 30.2px. Asserted as a gap rather than
    // as those numbers, so a retune that moves both keeps saying the same thing:
    // the second pass is worth more than a couple of shots' worth of luck.
    for (const personality of ['annihilator', 'cyborg'] as BotPersonality[]) {
      const { full, without, report } = ablate(personality, 'no refinement', {
        ...DEFAULT_SEARCH_PLAN,
        refineOffsets: [],
      });
      expect(full.hitRate, report).toBeGreaterThan(without.hitRate + 0.02);
      expect(full.meanMiss, report).toBeLessThan(without.meanMiss);
    }
  }, 300_000);

  it('costs flights, which is what makes it a trade rather than free', () => {
    // If the refinement pass were free it would not need defending. It is not:
    // measured 9.5 flights a decision against 8.4 with it gone.
    const flightsWith = meanFlights('annihilator', DEFAULT_SEARCH_PLAN);
    const flightsWithout = meanFlights('annihilator', {
      ...DEFAULT_SEARCH_PLAN,
      refineOffsets: [],
    });
    expect(
      flightsWith,
      `flights ${flightsWith.toFixed(2)} with, ${flightsWithout.toFixed(2)} without`,
    ).toBeGreaterThan(flightsWithout);
  }, 300_000);
});

describe("Newton's method earns its probes", () => {
  it('beats firing the closed-form seed and stopping', () => {
    // `coarseProbes: 1` is the closed form with no correction at all: one flight
    // per rung, no root find. Measured: Annihilator 92.0% -> 87.0%, Cyborg
    // 73.0% -> 68.5% with mean miss half as good again (23.8 -> 35.7).
    for (const personality of ['annihilator', 'cyborg'] as BotPersonality[]) {
      const { full, without, report } = ablate(personality, 'no Newton', {
        ...DEFAULT_SEARCH_PLAN,
        coarseProbes: 1,
      });
      expect(full.hitRate, report).toBeGreaterThan(without.hitRate + 0.02);
      expect(full.meanMiss, report).toBeLessThan(without.meanMiss);
    }
  }, 300_000);

  it('is worth the fourth probe, not just the second', () => {
    // The honest weak form of the same claim, and the one that would catch
    // somebody trimming the budget to save flights: at two probes the
    // Annihilator lands 87.5% against 92.0%.
    const { full, without, report } = ablate('annihilator', 'two probes', {
      ...DEFAULT_SEARCH_PLAN,
      coarseProbes: 2,
    });
    expect(full.hitRate, report).toBeGreaterThan(without.hitRate);
  }, 300_000);
});

describe('the coarse ladder is fine enough', () => {
  it('beats a ladder with half the rungs', () => {
    // Measured: at a 20 degree step the Annihilator drops to 87.5% and the
    // Cyborg to 68.5%. Cheaper — 6.5 flights against 9.5 — and worse, which is
    // the trade this constant is making.
    for (const personality of ['annihilator', 'cyborg'] as BotPersonality[]) {
      const { full, without, report } = ablate(personality, 'coarse step 20', {
        ...DEFAULT_SEARCH_PLAN,
        coarseStep: 20,
      });
      expect(full.hitRate, report).toBeGreaterThan(without.hitRate + 0.02);
    }
  }, 300_000);
});

describe('the flight ceiling is wired up, not decorative', () => {
  it('stops the search dead at whatever ceiling it is given', () => {
    /*
     * `maxFlights` is a backstop for a band nobody has widened yet: the widest
     * ladder any personality has today costs 44 flights against a ceiling of
     * 64, so on the shipped plan the counter never fires and no sweep can tell
     * whether it is connected to anything. Deleting either check — the one in
     * the coarse ladder or the one in the refinement pass — left the whole
     * suite green.
     *
     * Handing the search a tight ceiling is the only way to find out. The
     * ceilings are DERIVED from what the search actually costs on this corpus
     * rather than written down, for two reasons: a hardcoded 34 stops binding
     * the moment somebody makes the search cheaper, which would fail a test
     * about the ceiling for a change that has nothing to do with it; and a
     * ceiling that binds is the whole point, since "it stayed under the bound"
     * is free for a search that was never going to reach it.
     */
    const seats: { state: GameState; seat: number; personality: BotPersonality }[] = [];
    for (const personality of ['cyborg', 'annihilator', 'shooter'] as BotPersonality[]) {
      for (const state of [...DUELS.slice(0, 20), ...CROWDS]) {
        for (const seat of [0, 1]) seats.push({ state, seat, personality });
      }
    }

    const uncapped = seats.map(
      (entry) =>
        chooseShotDetailed(entry.state, entry.seat, { personality: entry.personality }).flights,
    );
    const worst = Math.max(...uncapped);
    // A corpus where nothing costs much cannot test a ceiling at all.
    expect(worst, 'no decision in this corpus costs enough to test a ceiling').toBeGreaterThan(8);

    // One ceiling inside the coarse ladder, one that lets the ladder finish and
    // bites in the refinement pass — the two places the counter is checked.
    for (const ceiling of [4, Math.floor(worst / 2), worst - 1]) {
      let bound = 0;
      seats.forEach((entry, index) => {
        const flights = chooseShotDetailed(entry.state, entry.seat, {
          personality: entry.personality,
          search: { ...DEFAULT_SEARCH_PLAN, maxFlights: ceiling },
        }).flights;
        expect(flights, `${entry.personality} at a ceiling of ${ceiling}`).toBeLessThanOrEqual(
          ceiling,
        );
        if ((uncapped[index] as number) > ceiling) bound += 1;
      });
      // …and the ceiling really was in the way of something.
      expect(
        bound,
        `ceiling ${ceiling} never bound anything (worst uncapped ${worst})`,
      ).toBeGreaterThan(0);
    }
  }, 300_000);
});

function meanFlights(personality: BotPersonality, search: SearchPlan): number {
  let total = 0;
  let count = 0;
  for (const state of DUELS) {
    for (const shooter of [0, 1]) {
      total += chooseShotDetailed(state, shooter, { personality, search }).flights;
      count += 1;
    }
  }
  return total / count;
}

// ---------------------------------------------------------------------------
// The ladder itself
// ---------------------------------------------------------------------------

describe('the elevation ladder covers the band it is given', () => {
  /*
   * These two are contracts rather than statistics, and they are here because
   * the same reviewer deleted the explicit top rung — the line that makes a
   * ladder end on `hi` — and nothing failed.
   *
   * Note what is NOT claimed. Dropping the top rung is not catastrophic: the
   * refinement pass reaches +6 degrees from the winning rung, so the Tosser can
   * still get to 84 when 78 wins the coarse pass. It is a narrowing, and a
   * narrowing is exactly the sort of thing that should be a contract on a pure
   * function rather than a hoped-for wobble in a hit rate.
   */
  it('starts on the low end and finishes exactly on the high end', () => {
    for (const personality of BOT_PERSONALITIES) {
      const { elevationLo, elevationHi } = botProfile(personality);
      const rungs = elevationLadder(elevationLo, elevationHi, DEFAULT_SEARCH_PLAN.coarseStep);
      expect(rungs[0], personality).toBe(elevationLo);
      expect(rungs[rungs.length - 1], personality).toBe(elevationHi);
    }
  });

  it('never repeats a rung, which would be flights spent on the same shot twice', () => {
    // The Cyborg's 15..85 is a whole number of 10 degree steps, so appending the
    // top unconditionally would fire it twice — four wasted flights on every
    // decision. Asserted over every band, in case somebody widens one.
    for (const personality of BOT_PERSONALITIES) {
      const { elevationLo, elevationHi } = botProfile(personality);
      const rungs = elevationLadder(elevationLo, elevationHi, DEFAULT_SEARCH_PLAN.coarseStep);
      for (let index = 1; index < rungs.length; index += 1) {
        expect(rungs[index] as number, `${personality} ${JSON.stringify(rungs)}`).toBeGreaterThan(
          rungs[index - 1] as number,
        );
      }
    }
  });

  it('leaves no gap wider than the step it was asked for', () => {
    // The other half of "covers": a ladder that jumped straight from the bottom
    // to the top would satisfy both assertions above.
    for (const personality of BOT_PERSONALITIES) {
      const { elevationLo, elevationHi } = botProfile(personality);
      const step = DEFAULT_SEARCH_PLAN.coarseStep;
      const rungs = elevationLadder(elevationLo, elevationHi, step);
      for (let index = 1; index < rungs.length; index += 1) {
        expect(
          (rungs[index] as number) - (rungs[index - 1] as number),
          `${personality} ${JSON.stringify(rungs)}`,
        ).toBeLessThanOrEqual(step);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Self-preservation
// ---------------------------------------------------------------------------

/**
 * Point-blank corpus: 60 real maps (5 styles x 12 seeds), the two tanks moved
 * to 30/50/70/100 px apart, three winds, both holding nothing but Nukes. 720
 * states. A Nuke's blast is 90 px, so at every one of those separations a
 * direct hit lands on the shooter too — which is the only situation in which
 * `avoidsSelfHarm` can be observed at all.
 */
const POINT_BLANK: GameState[] = [];
for (const style of TERRAIN_STYLES) {
  for (let seed = 0; seed < 12; seed += 1) {
    const base = openedGame(
      { seed: `pb-${style}-${seed}`, terrainStyle: style, width: WIDTH, height: HEIGHT },
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
    );
    const middle = ((base.tanks[0] as Tank).x + (base.tanks[1] as Tank).x) / 2;
    for (const gap of [30, 50, 70, 100]) {
      for (const wind of [-6, 0, 6]) {
        POINT_BLANK.push({
          ...base,
          wind,
          tanks: base.tanks.map((tank, index) => ({
            ...tank,
            x: Math.round(index === 0 ? middle - gap / 2 : middle + gap / 2),
            inventory: { nuke: 9 },
          })),
        });
      }
    }
  }
}

/** Share of the corpus where the chosen shot lands inside the shooter's own blast. */
function selfClipRate(personality: BotPersonality, search: SearchPlan): number {
  let clipped = 0;
  for (const state of POINT_BLANK) {
    const decision = chooseShot(state, 0, { personality, search });
    const trajectory = predictShot(state, 0, decision.angleDeg, decision.power);
    const me = state.tanks[0] as Tank;
    const toSelf = hypot2(
      trajectory.impact.x - me.x,
      trajectory.impact.y - (me.y - DEFAULT_WORLD.tankRadius - 2),
    );
    if (toSelf < requireWeapon(decision.weapon).radius) clipped += 1;
  }
  return clipped / POINT_BLANK.length;
}

describe('paying for self-preservation buys self-preservation', () => {
  it('keeps the careful bots out of their own crater at point-blank range', () => {
    /*
     * The claim `scoreOf` used to make in a comment, with two percentages that
     * did not reproduce for the reviewer who tried, because the comment named
     * no corpus. Now it is a measurement over the corpus defined above, in the
     * file that owns it.
     *
     * Measured over the 720 states: the Cyborg lands its own Nuke on itself
     * 48.1% of the time as shipped and 72.8% with the weight switched off; the
     * Annihilator 50.3% against 74.7%. Both figures are high in absolute terms
     * and should be — these bots are jammed 30 to 100 px from a target and are
     * holding a 90 px blast, so the choice is often "hit them and take some of
     * it" or "miss". The weight is what makes them decline the worst of those,
     * and a quarter of the corpus is a lot of declining.
     */
    for (const personality of ['cyborg', 'annihilator'] as BotPersonality[]) {
      const careful = selfClipRate(personality, DEFAULT_SEARCH_PLAN);
      const reckless = selfClipRate(personality, { ...DEFAULT_SEARCH_PLAN, selfHarmWeight: 0 });
      const report =
        `${personality}: self-clip ${(100 * careful).toFixed(1)}% as shipped, ` +
        `${(100 * reckless).toFixed(1)}% with the weight off`;
      expect(careful, report).toBeLessThan(reckless - 0.1);
    }
  }, 300_000);

  it('does nothing at all to a bot that does not care, whatever the weight', () => {
    // The control. `avoidsSelfHarm` is false for these three, so the weight is
    // multiplied by a term they never compute: byte-identical decisions.
    for (const personality of ['moron', 'shooter', 'tosser'] as BotPersonality[]) {
      expect(
        selfClipRate(personality, { ...DEFAULT_SEARCH_PLAN, selfHarmWeight: 0 }),
        personality,
      ).toBe(selfClipRate(personality, DEFAULT_SEARCH_PLAN));
      expect(
        selfClipRate(personality, { ...DEFAULT_SEARCH_PLAN, selfHarmWeight: 50 }),
        personality,
      ).toBe(selfClipRate(personality, DEFAULT_SEARCH_PLAN));
    }
  }, 300_000);
});
