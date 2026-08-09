/**
 * POOLSHARK converges. That is the entire personality, and it is the one claim
 * in `ai.ts` that a single-shot measurement cannot make.
 *
 * ---------------------------------------------------------------------------
 * What is measured
 * ---------------------------------------------------------------------------
 *
 * 80 duels — five terrain styles by 16 seeds — each played for ten turns
 * through the REAL `fire()`, so the terrain gets cratered, the tanks settle
 * into their holes and the wind drifts exactly as it does in a match. The
 * target is made immortal and the turn is handed straight back, which is the
 * only doctoring: it makes the opponent stationary, which is what "converges
 * against a stationary target" needs, and it stops the round ending the moment
 * the bracket starts working.
 *
 * The miss recorded for a turn is where that turn's chosen shot would land,
 * flown through `predictShot` — the same `simulateFlight` the server is about
 * to resolve with.
 *
 *     turn            1     2     3     4     5     6     7     8     9    10
 *     POOLSHARK mean 197   158   128   107    79    73    68    61    60    56
 *               med  121    74    53    42    31    27    26    28    30    28
 *               hit%   8    14    19    27    31    41    39    32    29    34
 *     SHOOTER   mean  75    74    81    63    59    59    62    63    68    63
 *               med   36    36    46    37    38    42    42    42    45    42
 *               hit%  27    32    31    31    27    29    28    29    26    25
 *     CYBORG    mean  32    22    26    24    28    25    31    37    37    45
 *               hit%  66    68    64    59    55    55    42    50    48    41
 *
 * ---------------------------------------------------------------------------
 * Why the SHOOTER column is here
 * ---------------------------------------------------------------------------
 *
 * It is the control, and without it this file would prove nothing. "Misses less
 * on turn 10 than on turn 1" is also what you would see if ten turns of
 * shelling simply flattened the map into an easier problem. SHOOTER plays the
 * identical maps with the identical turn loop and does NOT improve — and the
 * CYBORG row shows the effect running the other way, getting worse as the
 * target settles into the crater its own shots dug. So the improvement below is
 * the bracket, not the battlefield.
 */

import { describe, expect, it } from 'vitest';

import { chooseShot, chooseShotDetailed, type BotPersonality } from '../src/ai.ts';
import {
  createGame,
  DEFAULT_WORLD,
  fire,
  predictShot,
  type GameState,
  type Tank,
} from '../src/game.ts';
import { hypot2 } from '../src/math.ts';
import { TERRAIN_STYLES } from '../src/terrain.ts';

const WIDTH = 1280;
const HEIGHT = 720;
const SEEDS = 16;
const TURNS = 10;

/** Immortal target, and the bot always gets the turn back. Nothing else moves. */
function handBack(state: GameState): GameState {
  return {
    ...state,
    phase: 'aiming',
    activeTank: 0,
    tanks: state.tanks.map((tank, index) =>
      index === 1 ? { ...tank, health: 1e9, alive: true } : tank,
    ),
  };
}

function missOf(state: GameState, decision: ReturnType<typeof chooseShot>): number {
  const trajectory = predictShot(state, 0, decision.angleDeg, decision.power);
  if (trajectory.impact.kind === 'tank' && trajectory.impact.tankIndex === 1) return 0;
  const target = state.tanks[1] as Tank;
  return hypot2(
    trajectory.impact.x - target.x,
    trajectory.impact.y - (target.y - DEFAULT_WORLD.tankRadius / 2),
  );
}

/** Turn-by-turn miss for one personality over one duel. */
function duel(seed: string, personality: BotPersonality): number[] {
  let state = handBack(
    createGame({ seed, width: WIDTH, height: HEIGHT }, [
      { id: 'a', name: 'A', bot: personality },
      { id: 'b', name: 'B' },
    ]),
  );

  const misses: number[] = [];
  for (let turn = 0; turn < TURNS; turn += 1) {
    const decision = chooseShot(state, 0);
    misses.push(missOf(state, decision));
    state = handBack(
      fire(state, 'a', {
        turnNumber: state.turnNumber,
        angleDeg: decision.angleDeg,
        power: decision.power,
        weapon: decision.weapon,
      }).state,
    );
  }
  return misses;
}

const CACHE = new Map<BotPersonality, number[][]>();

/** `byTurn(p)[k]` is every duel's miss on turn k+1. */
function byTurn(personality: BotPersonality): number[][] {
  const cached = CACHE.get(personality);
  if (cached !== undefined) return cached;

  const perTurn: number[][] = Array.from({ length: TURNS }, () => []);
  for (const style of TERRAIN_STYLES) {
    for (let seed = 0; seed < SEEDS; seed += 1) {
      duel(`walk-${style}-${seed}`, personality).forEach((miss, turn) =>
        (perTurn[turn] as number[]).push(miss),
      );
    }
  }
  CACHE.set(personality, perTurn);
  return perTurn;
}

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const meanOverTurns = (personality: BotPersonality, from: number, to: number): number =>
  mean(byTurn(personality).slice(from, to).flat());
const report = (personality: BotPersonality): string =>
  `${personality}: ` +
  byTurn(personality)
    .map((t) => mean(t).toFixed(0))
    .join(' ');

describe('the Poolshark walks its aim in', () => {
  it('misses by less every turn for the first five turns', () => {
    // The strongest form of the claim, and the one a player would recognise:
    // not "better by the end" but visibly closing, turn after turn. Measured
    // means over the 80 duels: 195, 155, 128, 107, 84.
    const means = byTurn('poolshark').map(mean);
    for (let turn = 1; turn < 5; turn += 1) {
      expect(means[turn] as number, report('poolshark')).toBeLessThan(means[turn - 1] as number);
    }
  }, 300_000);

  it('ends up missing by a third of what it opened with', () => {
    const early = meanOverTurns('poolshark', 0, 2);
    const late = meanOverTurns('poolshark', 7, 10);
    // Measured 178 px opening against 59 px closing, a ratio of 0.33.
    expect(late / early, report('poolshark')).toBeLessThan(0.5);
  }, 300_000);

  it('lands three times as many shots by turn ten as on turn one', () => {
    const hitRate = (turn: number): number => {
      const misses = byTurn('poolshark')[turn] as number[];
      return misses.filter((miss) => miss <= 18).length / misses.length;
    };
    // 18 px is the Baby Missile's blast radius — the weapon every one of these
    // shots is actually fired with, not a threshold invented for the test.
    expect(mean([hitRate(7), hitRate(8), hitRate(9)])).toBeGreaterThan(2 * hitRate(0));
  }, 300_000);

  /**
   * The control. If this ever starts passing the same assertions the Poolshark
   * does, the tests above have stopped measuring the bracket.
   */
  it('is the only one that improves — a bot that does not learn does not', () => {
    const poolshark = meanOverTurns('poolshark', 7, 10) / meanOverTurns('poolshark', 0, 2);
    const shooter = meanOverTurns('shooter', 7, 10) / meanOverTurns('shooter', 0, 2);
    const cyborg = meanOverTurns('cyborg', 7, 10) / meanOverTurns('cyborg', 0, 2);
    const summary = `${report('poolshark')}\n${report('shooter')}\n${report('cyborg')}`;

    // Measured: Poolshark 0.33, Shooter 0.87, Cyborg 1.44 — the Cyborg actually
    // gets WORSE as the target settles into the crater it dug for it.
    expect(poolshark, summary).toBeLessThan(0.5);
    expect(shooter, summary).toBeGreaterThan(0.6);
    expect(cyborg, summary).toBeGreaterThan(0.6);
  }, 300_000);

  it('does its bracketing on two or three flights, not by searching', () => {
    // The bracket is cheap by construction — it re-flies one remembered aim,
    // checks the correction, and has one way out of a trap. If it ever starts
    // costing what the solver costs, it has stopped being a bracket.
    const state = createGame({ seed: 'cost', width: WIDTH, height: HEIGHT }, [
      { id: 'a', name: 'A', bot: 'poolshark' },
      { id: 'b', name: 'B' },
    ]);
    for (let turn = 1; turn <= 12; turn += 1) {
      const { flights } = chooseShotDetailed({ ...state, turnNumber: turn }, 0);
      expect(flights).toBeGreaterThan(0);
      expect(flights).toBeLessThanOrEqual(3);
    }
  });
});

describe('the memory is derived, not stored', () => {
  /**
   * The bracket's whole "nothing new gets stored" argument rests on the aim
   * that `fire()` wrote back onto the tank. Move it, and the next decision has
   * to move with it — otherwise the bot is remembering something else and the
   * claim in `ai.ts` is false.
   */
  it('brackets from the aim the tank is carrying', () => {
    const base = createGame({ seed: 'derived', width: WIDTH, height: HEIGHT }, [
      { id: 'a', name: 'A', bot: 'poolshark' },
      { id: 'b', name: 'B' },
    ]);
    const withAim = (angleDeg: number, power: number): GameState => ({
      ...base,
      tanks: base.tanks.map((tank, index) => (index === 0 ? { ...tank, angleDeg, power } : tank)),
    });

    const low = chooseShot(withAim(45, 25), 0);
    const high = chooseShot(withAim(45, 95), 0);
    const steep = chooseShot(withAim(70, 60), 0);

    // Three different remembered aims, three different corrections.
    expect(low.power).not.toBe(high.power);
    expect(steep.angleDeg).not.toBe(low.angleDeg);
    // And it corrects TOWARDS the answer rather than jumping to it: a shot
    // remembered at power 25 does not come back at 95.
    expect(Math.abs(low.power - 25)).toBeLessThan(Math.abs(low.power - 95));
  });

  it('survives being handed an aim pointing the wrong way down the map', () => {
    // After a kill the next target can be on the other side, so the remembered
    // aim is mirrored. The bracket has to fold it onto the right side rather
    // than spend a turn shooting off the edge of the world.
    const base = createGame({ seed: 'mirrored', width: WIDTH, height: HEIGHT }, [
      { id: 'a', name: 'A', bot: 'poolshark' },
      { id: 'b', name: 'B' },
    ]);
    const left = base.tanks[0] as Tank;
    const right = base.tanks[1] as Tank;
    expect(left.x).toBeLessThan(right.x);

    const backwards: GameState = {
      ...base,
      tanks: base.tanks.map((tank, index) =>
        index === 0 ? { ...tank, angleDeg: 140, power: 60 } : tank,
      ),
    };
    // The target is to the right, so the shot must be too.
    expect(chooseShot(backwards, 0).angleDeg).toBeLessThan(90);
  });
});
