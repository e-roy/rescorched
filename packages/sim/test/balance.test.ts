/**
 * Is a hit decisive, and does a match end because somebody won?
 *
 * A player reported three things about this game: hits were not decisive,
 * round one was fought with nothing but the free weapon, and matches dragged.
 * The first and the third were reproduced against the sim before anything was
 * changed, and this file is the measurement that reproduced them, kept.
 *
 * Everything here is a SWEEP with an assertion on the outcome. Nothing asserts
 * a number out of `WEAPONS` or `DEFAULT_WORLD`; the counts come from firing
 * real shots through the real physics and counting what happened, which is the
 * only way a balance claim can be a test rather than a restatement. The bounds
 * are deliberately slack against what is measured today — the point is to catch
 * the balance falling back off the cliff it was on, not to freeze it.
 *
 * ---------------------------------------------------------------------------
 * What was measured, before and after
 * ---------------------------------------------------------------------------
 *
 * Bot-vs-bot duels, 20 seeds per personality, five rounds a match, every shot
 * through the real `fire()`. "Damage per connecting hit" counts health taken
 * off the OPPONENT by a turn, excluding turns in sudden death; "by kill" counts
 * rounds that ended because a tank died rather than because the clock ran out.
 * Reproduce with `duelSweep` below.
 *
 * Both columns are the same 120 matches on the same seeds; the "before" column
 * was re-measured by reverting the three rules changes listed below in place,
 * so nothing in it is a remembered figure.
 *
 *     personality   match turns          round turns        dmg / hit      rounds by kill
 *                   before   after     before   after    before  after    before   after
 *     moron          214.1   204.3      42.8    40.9       9.1   20.2       0%      8%
 *     shooter        138.2    47.9      27.6     9.6      19.3   37.6      66%     99%
 *     tosser         191.8    84.6      38.4    16.9      12.7   28.2      21%     92%
 *     poolshark      114.7    53.3      22.9    10.7      18.0   32.1      82%    100%
 *     cyborg          56.6    20.1      11.3     4.0      29.7   56.0      92%     99%
 *     annihilator     45.0    16.6       9.0     3.3      34.6   62.0      95%    100%
 *
 * Overall, rounds ended by a kill rather than by the clock went from 59.3% (356
 * of 600) to 83.0% (498 of 600), and 92 of the 102 that still end on the clock
 * are Moron-vs-Moron. That is not a hole in the balance, it is what a Moron is:
 * it draws an angle and a power out of the air and connects with 2.6% of its
 * shots, so two of them cannot finish each other however hard a shell hits, and
 * the safety net is doing exactly the job it was put there for. Every
 * personality that aims lands above 90%.
 *
 * The number the player actually felt is the "dmg / hit" column: against 100
 * health it was 9 to 20 a connecting hit for the personalities that aim, which
 * is five to eleven hits for a kill. It is now 28 to 62.
 *
 * Three changes produced that, and each is measured on its own below:
 *
 *  1. A blast is measured from the SKIN of the hull (`damageToTankAt`). A shell
 *     caught on a tank stops one hull radius from the point damage was measured
 *     against, so a direct hit was being charged a near miss's falloff — on the
 *     free Baby Missile, exactly the 50% mark, which is where "nine hits to
 *     kill" came from.
 *  2. The peak damage column was re-tuned around that, so the number in the
 *     table is what a direct hit does and the tier ladder is a promise about
 *     how many of them a kill takes.
 *  3. A Roller that hits a tank goes off on the tank instead of rolling off it.
 *
 * The turn budget and sudden death are untouched. They are a safety net and the
 * measurement above is the argument that they are back to being one.
 */

import { describe, expect, it } from 'vitest';

import {
  applyBotShopping,
  BOT_PERSONALITIES,
  chooseShot,
  createGame,
  DEFAULT_WORLD,
  detonate,
  everyoneHasShopped,
  fire,
  leaveShop,
  overtimeIndex,
  predictShot,
  requireWeapon,
  roundTurnBudget,
  startNextRound,
  WEAPONS,
  type BotPersonality,
  type DetonationRules,
  type DetonationTarget,
  type GameState,
  type WeaponDef,
} from '../src/index.ts';
import { makeRng } from '../src/rng.ts';
import { emptyTerrain, type Terrain } from '../src/terrain.ts';

const WIDTH = 1280;
const HEIGHT = 720;
const GROUND = 400;
const RULES: DetonationRules = {
  damageBounty: DEFAULT_WORLD.damageBounty,
  killBounty: DEFAULT_WORLD.killBounty,
};

// ---------------------------------------------------------------------------
// A direct hit
// ---------------------------------------------------------------------------

function flatField(): Terrain {
  const terrain = emptyTerrain(WIDTH, HEIGHT);
  terrain.surface.fill(GROUND);
  return terrain;
}

/**
 * Where a real shell actually comes to rest against a real tank.
 *
 * Found by flying shots through `predictShot` — the same function `fire()`
 * resolves with — until one reports a tank impact, then taking the offset of
 * that impact point from the tank. NOT computed from `tankRadius`: the whole
 * defect this file exists to police was a mismatch between where a shell stops
 * and where damage is measured from, and a test that derived the first from the
 * second could not see it.
 */
function realHullImpact(): { dx: number; dy: number } {
  const state = createGame({ seed: 'direct-hit-probe', width: WIDTH, height: HEIGHT }, [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ]);
  const calm: GameState = { ...state, wind: 0 };
  const target = calm.tanks[1] as GameState['tanks'][number];

  for (let angle = 5; angle <= 175; angle += 1) {
    for (let power = 20; power <= 100; power += 1) {
      const flight = predictShot(calm, 0, angle, power);
      if (flight.impact.kind !== 'tank' || flight.impact.tankIndex !== 1) continue;
      return {
        dx: flight.impact.x - target.x,
        dy: flight.impact.y - (target.y - DEFAULT_WORLD.tankRadius / 2),
      };
    }
  }
  throw new Error('no shot in the sweep hit the other tank');
}

const HULL_IMPACT = realHullImpact();

/** How many direct hits from this weapon destroy a full-health tank. */
function directHitsToKill(weapon: WeaponDef): number {
  let health: number = DEFAULT_WORLD.maxHealth;
  for (let shot = 1; shot <= 40; shot += 1) {
    const tanks = [{ x: WIDTH / 2, y: GROUND, health, alive: true, money: 0, score: 0 }];
    const field: DetonationTarget = { terrain: flatField(), tanks };
    detonate(
      field,
      weapon,
      WIDTH / 2 + HULL_IMPACT.dx,
      GROUND - DEFAULT_WORLD.tankRadius / 2 + HULL_IMPACT.dy,
      null,
      makeRng(`kill:${weapon.id}:${shot}`),
      RULES,
      { onTank: true },
    );
    const after = (tanks[0] as { health: number }).health;
    if (after >= health) return Infinity; // this shot did nothing; it never will
    health = after;
    if (health <= 0) return shot;
  }
  return Infinity;
}

const ARMED = WEAPONS.filter((weapon) => weapon.damage > 0);

describe('a direct hit hurts', () => {
  it('destroys a full-health tank in the number of hits its tier promises', () => {
    // `weapons.ts` states the ladder: tier 0 in four, tier 1 in two to four,
    // tier 2 in one or two, tier 3 and up in one. That is the whole balance
    // claim, and this is it under measurement rather than in a comment.
    const ceiling: Record<number, number> = { 0: 4, 1: 4, 2: 2, 3: 1, 4: 1 };

    const report = ARMED.map((weapon) => {
      const hits = directHitsToKill(weapon);
      const allowed = ceiling[weapon.tier] ?? 1;
      return { weapon, hits, allowed, ok: hits <= allowed };
    });

    expect(
      report.filter((row) => !row.ok).map((row) => `${row.weapon.id}: ${row.hits} hits`),
      report
        .map((row) => `${row.weapon.id} t${row.weapon.tier} ${row.hits}/${row.allowed}`)
        .join('\n'),
    ).toEqual([]);
  });

  /*
   * There is deliberately no "a dearer weapon never needs more direct hits"
   * test here. It was written, it failed, and it was wrong rather than the
   * arsenal: shots-to-kill is a coarse integer and it is not what several
   * weapons are sold for. A Baby Digger takes four because its damage is not
   * the point — it drops the floor out from under the tank and the fall
   * finishes the job — and Napalm needs one only because on the flat test
   * ground all six of its pools land on the same spot. A rule with that many
   * honest exceptions is not a rule, and softening it until they all passed
   * would have left a test that could not fail.
   *
   * The price-versus-punch rule that DOES hold is in `weapons.test.ts` ("never
   * lets three times the price buy a softer hit"), measured on damage rather
   * than on a rounded hit count, which is the resolution the question needs.
   */

  it('makes a near miss sting and a wide one not', () => {
    /*
     * The other half of "a hit is decisive": if everything within the blast
     * radius hurt the same, aiming would not be worth doing.
     *
     * Measured on the free weapon at three offsets from the hull, through the
     * same `detonate` a real shot goes through. A shell that lands a blast
     * radius past the hull does nothing at all — which is the property that
     * makes lobbing shells in someone's general direction a waste.
     */
    const weapon = requireWeapon('missile');
    const damageAt = (gap: number): number => {
      const tanks = [{ x: WIDTH / 2, y: GROUND, health: 1e6, alive: true, money: 0, score: 0 }];
      detonate(
        { terrain: flatField(), tanks },
        weapon,
        WIDTH / 2 + DEFAULT_WORLD.tankRadius + gap,
        GROUND - DEFAULT_WORLD.tankRadius / 2,
        null,
        makeRng('sting'),
        RULES,
      );
      return 1e6 - (tanks[0] as { health: number }).health;
    };

    const direct = damageAt(0);
    const graze = damageAt(weapon.radius * 0.4);
    const wide = damageAt(weapon.radius * 0.9);
    const clean = damageAt(weapon.radius + 1);

    expect(direct).toBeGreaterThan(graze);
    expect(graze).toBeGreaterThan(wide);
    expect(clean).toBe(0);
    // A graze at under half the blast radius still takes a real bite: more than
    // a third of a direct hit, so being nearly hit is being hurt.
    expect(graze).toBeGreaterThan(direct / 3);
    // …and being nearly missed is nearly nothing.
    expect(wide).toBeLessThan(direct / 4);

    // What this does and does not pin down, established by mutation rather than
    // claimed: a FLAT curve (full damage anywhere inside the radius) fails the
    // first comparison and a much steeper one (`t^4`) fails the graze bound, so
    // the band is real. Swapping the shipped smoothstep for a plain linear
    // falloff passes — the two are close enough through this range that no
    // honest assertion here separates them, and pretending otherwise would mean
    // writing down the polynomial and calling it a test.
  });

  it('goes off on a tank a Roller struck rather than rolling off it', () => {
    /*
     * A Roller detonates where it comes to REST, so on sloping ground a shell
     * that hit a hull squarely used to carry on down the hill and explode
     * somewhere else. Same shot, same slope, both ways — the difference is the
     * `onTank` flag `fire()` sets from the trajectory's impact kind.
     */
    const weapon = requireWeapon('roller');
    const slope = emptyTerrain(WIDTH, HEIGHT);
    for (let x = 0; x < WIDTH; x += 1) slope.surface[x] = 200 + Math.floor(x / 3);

    const shoot = (onTank: boolean): number => {
      const x = WIDTH / 2;
      const y = slope.surface[x] as number;
      const tanks = [{ x, y, health: DEFAULT_WORLD.maxHealth, alive: true, money: 0, score: 0 }];
      detonate(
        { terrain: cloneOf(slope), tanks },
        weapon,
        x,
        y - DEFAULT_WORLD.tankRadius / 2,
        null,
        makeRng('roller'),
        RULES,
        { onTank },
      );
      return DEFAULT_WORLD.maxHealth - (tanks[0] as { health: number }).health;
    };

    expect(shoot(true)).toBe(weapon.damage);
    expect(shoot(false)).toBeLessThan(weapon.damage);
  });
});

function cloneOf(terrain: Terrain): Terrain {
  return { ...terrain, surface: Int32Array.from(terrain.surface) };
}

// ---------------------------------------------------------------------------
// Whole matches
// ---------------------------------------------------------------------------

interface DuelResult {
  /** Did the match reach `gameover` at all? */
  finished: boolean;
  turns: number;
  roundsByKill: number;
  roundsByClock: number;
  /** Health taken off the opponent, per turn that took any off. */
  damagePerConnectingHit: number;
}

/**
 * Play one bot-vs-bot match to its end, driving it the way the room does.
 *
 * Shopping is settled exactly as `GameRoom.settleBotShopping` settles it, so
 * this exercises the pre-match armoury too: round one is fought with whatever
 * the personalities chose to buy, which is the whole point of opening it.
 */
export function playDuel(personality: BotPersonality, seed: string, totalRounds = 5): DuelResult {
  let state = createGame({ seed, totalRounds }, [
    { id: 'a', name: 'A', bot: personality },
    { id: 'b', name: 'B', bot: personality },
  ]);

  let turns = 0;
  let roundsByKill = 0;
  let roundsByClock = 0;
  let connectingHits = 0;
  let damage = 0;
  // Far above anything measured (the worst is a Moron at ~205) and far below a
  // hang. A duel that reaches it is a bug, and the assertions treat it as one.
  const guard = 2_000;

  while (state.phase !== 'gameover' && turns < guard) {
    if (state.phase === 'shopping') {
      let shopped = state;
      for (let index = 0; index < shopped.tanks.length; index += 1) {
        const tank = shopped.tanks[index] as GameState['tanks'][number];
        if (tank.bot === null || !shopped.pendingShoppers.includes(tank.id)) continue;
        shopped = applyBotShopping(shopped, index);
        shopped = leaveShop(shopped, tank.id);
      }
      state = everyoneHasShopped(shopped) ? startNextRound(shopped).state : shopped;
      continue;
    }

    const shooterIndex = state.activeTank;
    const shooter = state.tanks[shooterIndex] as GameState['tanks'][number];
    // Sudden death lands in the same `fire()` call, so a turn that the clock
    // damaged cannot be counted as a shot connecting.
    const inOvertime = overtimeIndex(state) >= 0;
    const healthBefore = state.tanks.map((tank) => tank.health);

    const decision = chooseShot(state, shooterIndex);
    const result = fire(state, shooter.id, {
      turnNumber: state.turnNumber,
      angleDeg: decision.angleDeg,
      power: decision.power,
      weapon: decision.weapon,
    });
    turns += 1;

    if (!inOvertime) {
      let dealt = 0;
      for (let index = 0; index < result.state.tanks.length; index += 1) {
        if (index === shooterIndex) continue;
        dealt +=
          (healthBefore[index] as number) -
          (result.state.tanks[index] as { health: number }).health;
      }
      if (dealt > 0) {
        connectingHits += 1;
        damage += dealt;
      }
    }

    if (result.events.some((event) => event.type === 'roundEnd')) {
      if (inOvertime) roundsByClock += 1;
      else roundsByKill += 1;
    }
    state = result.state;
  }

  return {
    finished: state.phase === 'gameover',
    turns,
    roundsByKill,
    roundsByClock,
    damagePerConnectingHit: connectingHits === 0 ? 0 : damage / connectingHits,
  };
}

/** Every personality, `seeds` matches each. The sweep the header quotes. */
function duelSweep(seeds: number, totalRounds: number): Map<BotPersonality, DuelResult[]> {
  const byPersonality = new Map<BotPersonality, DuelResult[]>();
  for (const personality of BOT_PERSONALITIES) {
    const results: DuelResult[] = [];
    for (let seed = 0; seed < seeds; seed += 1) {
      results.push(playDuel(personality, `duel-${personality}-${seed}`, totalRounds));
    }
    byPersonality.set(personality, results);
  }
  return byPersonality;
}

/**
 * Eight seeds of four rounds each: 32 rounds per personality, 192 in all.
 *
 * Big enough that the thresholds below are not measuring one unlucky map, small
 * enough to run in a couple of seconds — the whole sweep is the `import` cost
 * of this file, not a test that anybody waits on.
 */
const SWEEP = duelSweep(8, 4);
const SWEEP_TIMEOUT_MS = 300_000;

function totals(results: readonly DuelResult[]): {
  byKill: number;
  byClock: number;
  killShare: number;
} {
  const byKill = results.reduce((sum, row) => sum + row.roundsByKill, 0);
  const byClock = results.reduce((sum, row) => sum + row.roundsByClock, 0);
  return { byKill, byClock, killShare: byKill / Math.max(1, byKill + byClock) };
}

describe('matches end by combat, not by the clock', () => {
  it(
    'ends every match it starts',
    () => {
      for (const [personality, results] of SWEEP) {
        for (const result of results) {
          expect(result.finished, `${personality} did not finish`).toBe(true);
        }
      }
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'settles most rounds with a kill rather than with the safety net',
    () => {
      /*
       * 0.80 against 0.833 measured (160 rounds by kill, 32 by clock), and the
       * margin is deliberate rather than generous: the figure this replaces was
       * 0.60, and 30 of the 32 that still end on the clock are Moron-vs-Moron.
       *
       * Proved by mutation, not by argument. Deleting the hull credit from
       * `damageToTankAt` drops this sweep to 0.755; deleting the Roller's
       * `onTank` branch drops it to 0.781. Either one turns this red.
       */
      const all = [...SWEEP.values()].flat();
      const { byKill, byClock, killShare } = totals(all);
      expect(
        killShare,
        `${byKill} rounds by kill, ${byClock} by clock across the whole roster`,
      ).toBeGreaterThan(0.8);
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'lets every personality that actually aims finish its own rounds',
    () => {
      /*
       * The Moron is excluded BY NAME and on purpose. It draws an angle and a
       * power out of the air — that is the personality, written down in
       * `ai.ts` — so two of them connect with a couple of percent of their
       * shots and cannot finish each other however hard a shell hits. The
       * clock ending those rounds is the net doing its job, not the balance
       * failing, and a threshold low enough to include it would be a threshold
       * that measures nothing about anyone else.
       */
      const failures: string[] = [];
      for (const [personality, results] of SWEEP) {
        if (personality === 'moron') continue;
        const { byKill, byClock, killShare } = totals(results);
        // 0.90 against a measured minimum of 0.94 (the Tosser; everyone else
        // is at 1.00). Deleting the hull credit takes the Tosser to 0.66,
        // deleting the Roller's `onTank` branch takes it to 0.63.
        if (killShare < 0.9) {
          failures.push(
            `${personality}: ${byKill} by kill, ${byClock} by clock (${killShare.toFixed(2)})`,
          );
        }
      }
      expect(failures).toEqual([]);
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'takes a handful of turns to settle a round, not most of the budget',
    () => {
      /*
       * The complaint this whole file is about was a round that ran 43 turns
       * against a 40-turn budget: the clock killed them, not a shot. So the bar
       * is stated against the BUDGET rather than as a turn count — a round that
       * routinely eats most of what it is allowed is a round the net is holding
       * up, whatever the numbers happen to be.
       */
      const budget = roundTurnBudget(2);
      const failures: string[] = [];
      for (const [personality, results] of SWEEP) {
        if (personality === 'moron') continue;
        const rounds = results.reduce((sum, row) => sum + row.roundsByKill + row.roundsByClock, 0);
        const turns = results.reduce((sum, row) => sum + row.turns, 0);
        const perRound = turns / Math.max(1, rounds);
        if (perRound > budget / 2)
          failures.push(`${personality}: ${perRound.toFixed(1)} turns/round`);
      }
      expect(failures).toEqual([]);
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'connects hard enough that a few hits decide it',
    () => {
      /*
       * The number the player actually felt: ~11 damage a connecting hit
       * against 100 health, so nine hits to kill. Asserted as a fraction of
       * `maxHealth` rather than as a damage figure, and only for the
       * personalities that aim — a Moron's connecting hits are point-blank
       * accidents and say nothing about the damage curve.
       */
      const weak: string[] = [];
      for (const [personality, results] of SWEEP) {
        if (personality === 'moron') continue;
        const perHit =
          results.reduce((sum, row) => sum + row.damagePerConnectingHit, 0) / results.length;
        if (perHit < DEFAULT_WORLD.maxHealth / 4) {
          weak.push(`${personality}: ${perHit.toFixed(1)} per connecting hit`);
        }
      }
      expect(weak).toEqual([]);
    },
    SWEEP_TIMEOUT_MS,
  );
});
