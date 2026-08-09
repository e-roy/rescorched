/**
 * The six computer players have to be visibly different, and "visibly" has to
 * mean measurable.
 *
 * ---------------------------------------------------------------------------
 * What is measured
 * ---------------------------------------------------------------------------
 *
 * `sweep()` builds 100 real two-player matches — the five terrain styles by 20
 * seeds, through the real `createGame`, so the maps and the spawns are the ones
 * a player actually gets — and asks each personality for the OPENING shot from
 * both seats. 200 decisions each. Every tank owns nothing but the free Baby
 * Missile, so what is compared is aim and only aim: same map, same distance,
 * same blast radius, different brain.
 *
 * Each decision is then flown through `predictShot`, which is the same
 * `simulateFlight` the server resolves with, under the REAL wind — so a
 * personality that aims with the wrong model (SHOOTER) is scored on what
 * actually happens rather than on what it believed.
 *
 *     personality   hit %   mean miss   median miss   median apex   median loft
 *     MORON           3.0     405 px       414 px         59 px       51.4 deg
 *     SHOOTER        30.5      91 px        37 px        127 px       37.9 deg
 *     TOSSER         35.5      43 px        26 px        259 px       58.6 deg
 *     POOLSHARK       6.5     220 px       156 px        113 px       45.0 deg
 *     CYBORG         73.0      24 px         0 px        141 px       36.0 deg
 *     ANNIHILATOR    92.0       7 px         0 px        145 px       35.2 deg
 *
 * A "hit" is a direct hit on the target's hit circle or an impact inside the
 * weapon's blast radius. "Apex" is how far above its own hull the shell climbs.
 *
 * Two of the six are deliberately not in the difficulty ranking, and the table
 * is why: TOSSER trades reach for loft, so it is a different weapon rather than
 * a better shot, and POOLSHARK's whole design is that its FIRST shot is bad —
 * `ai-poolshark.test.ts` measures it over ten turns, where it belongs.
 *
 * ---------------------------------------------------------------------------
 * What is asserted
 * ---------------------------------------------------------------------------
 *
 * The ORDERING, with a floor under each gap, rather than the numbers above.
 * Pinning 73.0% would go red every time the terrain generator was retuned and
 * would say nothing about whether a Cyborg still outshoots a Shooter. The gap
 * floors are what stop the ordering degenerating into three personalities that
 * differ by a rounding error.
 *
 * The sweep is deliberately small enough to stay a couple of seconds of CPU.
 * The whole Vitest suite runs in parallel, and a file that hogs a core makes
 * somebody else's five-second timeout flaky — which is not a hypothetical, it
 * is what happened the first time this file swept 400 matches.
 */

import { describe, expect, it } from 'vitest';

import {
  applyBotShopping,
  BOT_PERSONALITIES,
  choosePurchases,
  chooseShot,
  chooseTarget,
  chooseWeapon,
  type BotPersonality,
} from '../src/ai.ts';
import { createGame, DEFAULT_WORLD, predictShot, type GameState, type Tank } from '../src/game.ts';
import { hypot2 } from '../src/math.ts';
import { TERRAIN_STYLES } from '../src/terrain.ts';
import { requireWeapon, WEAPONS } from '../src/weapons.ts';

const WIDTH = 1280;
const HEIGHT = 720;
const SEEDS = 20;

const GAMES: GameState[] = [];
for (const style of TERRAIN_STYLES) {
  for (let seed = 0; seed < SEEDS; seed += 1) {
    GAMES.push(
      createGame(
        { seed: `spread-${style}-${seed}`, terrainStyle: style, width: WIDTH, height: HEIGHT },
        [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
        ],
      ),
    );
  }
}

interface Sample {
  hit: boolean;
  miss: number;
  /** Degrees above horizontal, folded onto one side. */
  loft: number;
  /** Pixels the shell climbs above the muzzle before it comes down. */
  apex: number;
  /** The power dial it settled on, 0..100. */
  power: number;
  /** Horizontal distance to the target it was shooting at. */
  range: number;
}

const CACHE = new Map<BotPersonality, Sample[]>();

function sweep(personality: BotPersonality): Sample[] {
  const cached = CACHE.get(personality);
  if (cached !== undefined) return cached;

  const samples: Sample[] = [];
  for (const state of GAMES) {
    for (const shooter of [0, 1]) {
      const target = 1 - shooter;
      const decision = chooseShot(state, shooter, undefined, personality);
      const trajectory = predictShot(state, shooter, decision.angleDeg, decision.power);
      const tank = state.tanks[target] as Tank;

      const direct = trajectory.impact.kind === 'tank' && trajectory.impact.tankIndex === target;
      const miss = direct
        ? 0
        : hypot2(
            trajectory.impact.x - tank.x,
            trajectory.impact.y - (tank.y - DEFAULT_WORLD.tankRadius / 2),
          );

      let top = Infinity;
      for (let point = 0; point < trajectory.length; point += 1) {
        top = Math.min(top, trajectory.points[point * 2 + 1] as number);
      }

      samples.push({
        hit: direct || miss <= requireWeapon(decision.weapon).radius,
        miss,
        loft: decision.angleDeg <= 90 ? decision.angleDeg : 180 - decision.angleDeg,
        apex: (state.tanks[shooter] as Tank).y - top,
        power: decision.power,
        range: Math.abs(tank.x - (state.tanks[shooter] as Tank).x),
      });
    }
  }

  CACHE.set(personality, samples);
  return samples;
}

const hitRate = (p: BotPersonality): number =>
  sweep(p).filter((s) => s.hit).length / sweep(p).length;
const meanMiss = (p: BotPersonality): number =>
  sweep(p).reduce((sum, s) => sum + s.miss, 0) / sweep(p).length;
const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
const medianOf = (p: BotPersonality, pick: (s: Sample) => number): number =>
  median(sweep(p).map(pick));

/** Human-readable table, attached to every failure so a red build is diagnosable. */
function table(): string {
  return BOT_PERSONALITIES.map(
    (p) =>
      `${p.padEnd(12)} hit ${(100 * hitRate(p)).toFixed(1).padStart(5)}%  ` +
      `meanMiss ${meanMiss(p).toFixed(0).padStart(4)}  ` +
      `medMiss ${medianOf(p, (s) => s.miss)
        .toFixed(0)
        .padStart(4)}  ` +
      `medApex ${medianOf(p, (s) => s.apex)
        .toFixed(0)
        .padStart(4)}  ` +
      `medLoft ${medianOf(p, (s) => s.loft)
        .toFixed(1)
        .padStart(5)}`,
  ).join('\n');
}

/**
 * Smallest gap in hit rate the difficulty ladder must keep between neighbours.
 *
 * Measured gaps along the chain are 27.5, 42.5 and 19.0 percentage points, so
 * this leaves room to spare — and it is what turns "the ordering holds" into a
 * claim about a player being able to TELL. Two bots four points apart are the
 * same bot.
 */
const MIN_HIT_GAP = 0.15;

describe('the difficulty ladder is real and in the right order', () => {
  it('out-hits, rung by rung, by a margin a player would notice', () => {
    const ladder: BotPersonality[] = ['moron', 'shooter', 'cyborg', 'annihilator'];
    for (let rung = 1; rung < ladder.length; rung += 1) {
      const better = ladder[rung] as BotPersonality;
      const worse = ladder[rung - 1] as BotPersonality;
      expect(hitRate(better), `${better} vs ${worse}\n${table()}`).toBeGreaterThan(
        hitRate(worse) + MIN_HIT_GAP,
      );
    }
  }, 300_000);

  it('misses by less, rung by rung, on the same chain', () => {
    // Hit rate is a threshold and can be gamed by a bot that is either perfect
    // or wild; mean miss is the continuous version of the same claim, and the
    // two agreeing is what makes the ranking a ranking rather than an artefact
    // of where the blast radius happens to fall.
    const ladder: BotPersonality[] = ['moron', 'shooter', 'cyborg', 'annihilator'];
    for (let rung = 1; rung < ladder.length; rung += 1) {
      const better = ladder[rung] as BotPersonality;
      const worse = ladder[rung - 1] as BotPersonality;
      expect(meanMiss(better), `${better} vs ${worse}\n${table()}`).toBeLessThan(meanMiss(worse));
    }
  }, 300_000);

  it('leaves the bottom of the ladder beatable and the top nearly not', () => {
    // Stated as a ratio rather than as two absolute rates, so it survives the
    // terrain generator being retuned underneath it. Measured: the Moron lands
    // 3.0% of its opening shots against the Annihilator's 92.0%, a factor of 31.
    expect(hitRate('moron'), table()).toBeLessThan(hitRate('annihilator') / 10);
    // And the Annihilator is genuinely near-perfect rather than merely best of
    // a bad bunch: it puts more than half its opening shots on target.
    expect(hitRate('annihilator'), table()).toBeGreaterThan(0.5);
  }, 300_000);

  it("has the Moron's aim carry no information about the target at all", () => {
    /*
     * The mechanism behind the hit rates, measured separately so a regression
     * says which half broke — and measured as INFORMATION rather than as
     * spread, because spread alone is misleading here. A solver facing a
     * hundred different geometries also produces a wide range of angles; what
     * makes it a solver is that the range tracks the problem.
     *
     * So: the correlation between the power it chose and how far away the
     * target is. Further away needs more power, and a bot that is aiming shows
     * it. Measured over the 200 situations — Moron 0.00, Shooter 0.66, Tosser
     * 0.78, Poolshark 0.45, Cyborg 0.61, Annihilator 0.62. The Moron's is not
     * merely low, it is nil: its power comes out of the RNG and the target
     * could be anywhere.
     */
    const correlation = (p: BotPersonality): number => {
      const samples = sweep(p);
      const xs = samples.map((s) => s.range);
      const ys = samples.map((s) => s.power);
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let covariance = 0;
      let varX = 0;
      let varY = 0;
      for (let k = 0; k < xs.length; k += 1) {
        const dx = (xs[k] as number) - mx;
        const dy = (ys[k] as number) - my;
        covariance += dx * dy;
        varX += dx * dx;
        varY += dy * dy;
      }
      return covariance / Math.sqrt(varX * varY);
    };
    const report = BOT_PERSONALITIES.map((p) => `${p} ${correlation(p).toFixed(2)}`).join(', ');

    expect(Math.abs(correlation('moron')), report).toBeLessThan(0.2);
    for (const solver of ['shooter', 'tosser', 'cyborg', 'annihilator'] as BotPersonality[]) {
      expect(correlation(solver), report).toBeGreaterThan(0.4);
    }
    // And the consequence, which is the thing a player experiences.
    expect(meanMiss('moron'), table()).toBeGreaterThan(20 * meanMiss('annihilator'));
  }, 300_000);
});

describe('the Tosser lobs, and that is the whole of its character', () => {
  it('throws its shells higher than the flat shooters, situation by situation', () => {
    /*
     * The apex above its own hull, not the angle it chose — the angle would
     * just be restating `elevationLo`, and the apex is what a player watching
     * actually sees clear the ridge.
     *
     * Paired, because the alternative is not robust. Every personality is asked
     * about the SAME situations in the same order, so `sweep(a)[k]` and
     * `sweep(b)[k]` are the same map, the same seat and the same target — and a
     * per-situation comparison neither cares how the sample happened to fall
     * nor gets dragged around by a handful of long shots. An unpaired median
     * ratio does: the Tosser's median apex is 2.0x the Shooter's on this sample
     * and 1.8x the Cyborg's, so a "more than twice as high" written against the
     * median would have been a coin toss between sample sizes.
     *
     * Not 100%, and it should not be. A flat shooter facing a target it has to
     * clear a mountain to reach picks a steep arc too — the Shooter's band runs
     * to 80 degrees. What the Tosser does is take that arc EVERY time, and the
     * shot-for-shot win rate is the honest measure of it. Measured: 81.5%
     * against the Shooter, 83.0% against the Cyborg, 83.5% against the
     * Annihilator.
     */
    const higherThan = (other: BotPersonality): number => {
      const lobs = sweep('tosser');
      const flats = sweep(other);
      return lobs.filter((lob, k) => lob.apex > (flats[k] as Sample).apex).length / lobs.length;
    };
    const rates = (['shooter', 'cyborg', 'annihilator'] as BotPersonality[]).map(
      (other) => `${other} ${(100 * higherThan(other)).toFixed(1)}%`,
    );
    for (const other of ['shooter', 'cyborg', 'annihilator'] as BotPersonality[]) {
      expect(higherThan(other), `${other}\n${rates.join(', ')}\n${table()}`).toBeGreaterThan(0.75);
    }
    // And by a wide margin in the aggregate, not just more often.
    expect(
      medianOf('tosser', (s) => s.apex),
      table(),
    ).toBeGreaterThan(1.5 * medianOf('shooter', (s) => s.apex));
  }, 300_000);

  it('lobs on every single shot rather than on average', () => {
    // "Always" is the claim, so it is asserted over the whole sweep and not
    // over a summary statistic. The flattest shot the Tosser took anywhere in
    // 200 opening shots is 56.0 degrees; the Shooter's median is 37.9 and its
    // flattest is 15.5.
    const flattest = Math.min(...sweep('tosser').map((s) => s.loft));
    expect(flattest, table()).toBeGreaterThan(medianOf('shooter', (s) => s.loft));
    expect(flattest, table()).toBeGreaterThan(
      Math.min(...sweep('shooter').map((s) => s.loft)) + 20,
    );
  }, 300_000);

  it('is still a real threat despite the handicap', () => {
    // A personality nobody should pick is not a personality. The Tosser gives
    // up the flat trajectory and gets the ridge in exchange, and it lands its
    // opening shot about as often as the Shooter does (35.5% against 30.5%).
    expect(hitRate('tosser'), table()).toBeGreaterThan(hitRate('moron') + MIN_HIT_GAP);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

/** A between-rounds shop with a given bankroll, one round already fought. */
function shopping(personality: BotPersonality, money: number, round = 1): GameState {
  const base = createGame({ seed: 'shop', width: WIDTH, height: HEIGHT }, [
    { id: 'a', name: 'A', bot: personality },
    { id: 'b', name: 'B' },
  ]);
  return {
    ...base,
    phase: 'shopping',
    round,
    pendingShoppers: ['a', 'b'],
    tanks: base.tanks.map((tank) => ({ ...tank, money })),
  };
}

/** The hardest-hitting single round in stock. Zero for an arsenal of dirt. */
function heaviestRound(tank: Tank): number {
  return WEAPONS.reduce(
    (worst, weapon) =>
      (tank.inventory[weapon.id] ?? 0) > 0 ? Math.max(worst, weapon.damage) : worst,
    0,
  );
}

describe('a bot with money buys for its personality', () => {
  const BANK = 19000; // what winning the opening round of a duel actually pays

  it('ends up holding heavier ordnance the better it is', () => {
    const heaviest = Object.fromEntries(
      BOT_PERSONALITIES.map((p) => [
        p,
        heaviestRound(applyBotShopping(shopping(p, BANK), 0).tanks[0] as Tank),
      ]),
    ) as Record<BotPersonality, number>;
    const report = JSON.stringify(heaviest);

    // Measured at this bankroll: Moron 0 (dirt), Shooter 45 (Missile), Tosser
    // 52 (Roller), Poolshark and Cyborg 90 (Baby Nuke), Annihilator 150 (Nuke).
    expect(heaviest.annihilator, report).toBeGreaterThan(heaviest.cyborg);
    expect(heaviest.cyborg, report).toBeGreaterThan(heaviest.tosser);
    expect(heaviest.tosser, report).toBeGreaterThan(heaviest.shooter);
    expect(heaviest.shooter, report).toBeGreaterThan(heaviest.moron);
  });

  it('leaves the Moron with an armoury that cannot hurt anybody', () => {
    const after = applyBotShopping(shopping('moron', BANK), 0);
    const tank = after.tanks[0] as Tank;
    // It shopped — this is not "the Moron buys nothing".
    expect(tank.money).toBeLessThan(BANK);
    expect(Object.keys(tank.inventory).length).toBeGreaterThan(0);
    // And every round of it does zero damage to a tank.
    for (const [weaponId, rounds] of Object.entries(tank.inventory)) {
      expect(rounds).toBeGreaterThan(0);
      expect(requireWeapon(weaponId).damage, weaponId).toBe(0);
    }
  });

  it('has the Annihilator commit almost the whole bankroll and the Moron a quarter', () => {
    const spent = (p: BotPersonality): number =>
      BANK - ((applyBotShopping(shopping(p, BANK), 0).tanks[0] as Tank).money as number);
    // Measured: Annihilator 18000 of 19000, Moron 4800.
    expect(spent('annihilator')).toBeGreaterThan(3 * spent('moron'));
    expect(spent('annihilator')).toBeGreaterThan(BANK * 0.8);
  });

  it('never asks the shop for something the shop would refuse', () => {
    // `choosePurchases` re-implements the shelf and affordability rules that
    // `economy.buy` enforces, so the two can drift. This runs every
    // personality over a wide range of bankrolls and arms levels and demands
    // that every single purchase completes — `buy` throws if any does not.
    let bought = 0;
    for (const personality of BOT_PERSONALITIES) {
      for (const money of [0, 1, 999, 5000, 12000, 19000, 33000, 250000]) {
        for (const round of [1, 2, 3, 5]) {
          const state = shopping(personality, money, round);
          const purchases = choosePurchases(state, 0);
          const after = applyBotShopping(state, 0);
          const tank = after.tanks[0] as Tank;
          expect(tank.money).toBeGreaterThanOrEqual(0);
          bought += purchases.length;
        }
      }
    }
    // A floor, so a `choosePurchases` that quietly started returning nothing
    // would fail here rather than passing vacuously.
    expect(bought).toBeGreaterThan(50);
  });

  it('buys nothing at all when the shop is shut', () => {
    for (const personality of BOT_PERSONALITIES) {
      const aiming = { ...shopping(personality, 50000), phase: 'aiming' as const };
      expect(choosePurchases(aiming, 0)).toEqual([]);
      expect(applyBotShopping(aiming, 0)).toBe(aiming);
    }
  });

  it('buys nothing for a human seat', () => {
    const state = shopping('annihilator', 50000);
    const human: GameState = {
      ...state,
      tanks: state.tanks.map((tank) => ({ ...tank, bot: null })),
    };
    expect(choosePurchases(human, 0)).toEqual([]);
    expect((applyBotShopping(human, 0).tanks[0] as Tank).money).toBe(50000);
  });
});

describe('a bot with a full armoury picks the right gun', () => {
  function armed(personality: BotPersonality, targetHealth: number): GameState {
    const base = createGame({ seed: 'armoury', width: WIDTH, height: HEIGHT }, [
      { id: 'a', name: 'A', bot: personality },
      { id: 'b', name: 'B' },
    ]);
    return {
      ...base,
      tanks: base.tanks.map((tank, index) => ({
        ...tank,
        health: index === 1 ? targetHealth : tank.health,
        inventory: Object.fromEntries(WEAPONS.map((weapon) => [weapon.id, 9])),
      })),
    };
  }

  it('gives the better bots access to heavier weapons', () => {
    const damage = (p: BotPersonality): number =>
      requireWeapon(chooseWeapon(armed(p, 100), 0)).damage;
    // Measured against a full-health target with one of everything in stock:
    // Moron 25 (Baby Missile), Shooter 45 (Missile), Tosser and Poolshark 90
    // (Baby Nuke), Cyborg 150 (Nuke), Annihilator 115 (Heavy Roller — see the
    // next test for why the Annihilator is the one that does NOT reach for the
    // biggest thing it owns).
    expect(damage('shooter')).toBeGreaterThan(damage('moron'));
    expect(damage('tosser')).toBeGreaterThan(damage('shooter'));
    expect(damage('cyborg')).toBeGreaterThan(damage('tosser'));
    expect(damage('annihilator')).toBeGreaterThanOrEqual(DEFAULT_WORLD.maxHealth);
  });

  it('has the Annihilator refuse to spend a Nuke on a tank a free round would kill', () => {
    // The in-play half of "spends its money well". Against a target on 20
    // health the Annihilator drops to the free Baby Missile, which still kills
    // it; the Cyborg fires the same Nuke it would have used at full health.
    const wounded = requireWeapon(chooseWeapon(armed('annihilator', 20), 0));
    const healthy = requireWeapon(chooseWeapon(armed('annihilator', 100), 0));
    expect(wounded.damage).toBeGreaterThanOrEqual(20);
    expect(wounded.price).toBeLessThan(healthy.price);
    expect(wounded.id).toBe('baby_missile');

    const cyborgWounded = requireWeapon(chooseWeapon(armed('cyborg', 20), 0));
    const cyborgHealthy = requireWeapon(chooseWeapon(armed('cyborg', 100), 0));
    expect(cyborgWounded.id).toBe(cyborgHealthy.id);
  });

  it('has the Annihilator shoot at whoever it can finish, not whoever is closest', () => {
    const wounded = (personality: BotPersonality): GameState => {
      const base = createGame({ seed: 'finish-them', width: WIDTH, height: HEIGHT }, [
        { id: 'a', name: 'A', bot: personality },
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' },
      ]);
      return {
        ...base,
        tanks: base.tanks.map((tank, index) => ({ ...tank, health: index === 2 ? 4 : 100 })),
      };
    };

    const board = wounded('cyborg');
    const gap = (index: number): number =>
      Math.abs((board.tanks[index] as Tank).x - (board.tanks[0] as Tank).x);
    // Seat 1 is the nearest to seat 0; seat 2 is the furthest away and nearly
    // dead. The two rules therefore disagree, which is the only situation in
    // which either can be observed at all.
    expect(gap(1)).toBeLessThan(gap(2));
    expect((board.tanks[2] as Tank).health).toBeLessThan((board.tanks[1] as Tank).health);

    expect(chooseTarget(wounded('cyborg'), 0)).toBe(1);
    expect(chooseTarget(wounded('annihilator'), 0)).toBe(2);
    // And it is not merely a different target on paper: the shot itself differs.
    expect(chooseShot(wounded('cyborg'), 0)).not.toEqual(chooseShot(wounded('annihilator'), 0));
  });
});
