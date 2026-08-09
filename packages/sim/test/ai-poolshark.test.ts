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
 *     POOLSHARK mean 203   168   142   126    92    82    69    67    70    62
 *               med  106    69    54    45    32    24    26    27    31    30
 *               hit%   9     6    14    28    33    41    40    33    23    31
 *     SHOOTER   mean  74    74    68    56    54    57    64    58    73    56
 *               med   35    44    44    39    36    40    48    47    41    42
 *               hit%  25    28    31    28    25    29    26    28    21    24
 *     CYBORG    mean  24    27    29    29    25    24    29    46    47    56
 *               med    0    12    12    15    17    15    25    18    22    22
 *               hit%  65    61    63    56    54    60    44    50    43    40
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
    // means over the 80 duels: 203, 168, 142, 126, 92.
    const means = byTurn('poolshark').map(mean);
    for (let turn = 1; turn < 5; turn += 1) {
      expect(means[turn] as number, report('poolshark')).toBeLessThan(means[turn - 1] as number);
    }
  }, 300_000);

  it('ends up missing by a third of what it opened with', () => {
    const early = meanOverTurns('poolshark', 0, 2);
    const late = meanOverTurns('poolshark', 7, 10);
    // Measured 185 px opening against 66 px closing, a ratio of 0.36.
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

    // Measured: Poolshark 0.36, Shooter 0.85, Cyborg 1.93 — the Cyborg actually
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

  it('refuses to walk its aim onto a shot that sails off the map', () => {
    /*
     * The bracket accepts a correction on one comparison — `scoreOf(corrected)
     * < scoreOf(held)` — which makes it the one aiming style where a shot that
     * leaves the world can win outright. A shell that crosses the edge stops
     * being simulated at the margin and reports its impact THERE, so when the
     * target is itself jammed against that edge the reported impact sits within
     * a few pixels of it and scores like a bullseye. The solver never falls for
     * it because `walkPower` drives on the range error rather than the score;
     * the bracket has no such second opinion, and `OFF_MAP_PENALTY` is what
     * stops it walking its aim out of the world and staying there.
     *
     * Measured over the 1800 edge-hugging situations built below — 60 maps x 6
     * shooter/target placements with the target on or beside the boundary x 5
     * winds — the Poolshark's shots leave the map on 0.28% of turns. With
     * `OFF_MAP_PENALTY` set to 0 that rises to 1.33%, a factor of nearly five.
     *
     * It is also the ONLY personality the constant moves: swept separately over
     * the same geometry, the four solving personalities produce byte-identical
     * off-map rates with the penalty and without it, because `walkPower` steers
     * on the range error rather than on the score and the penalty never reaches
     * their argmax. So this test lives here, with the bracket, and not in the
     * personalities file.
     */
    const states: GameState[] = [];
    for (const style of TERRAIN_STYLES) {
      for (let seed = 0; seed < 12; seed += 1) {
        const base = createGame({ seed: `edge-${style}-${seed}`, width: WIDTH, height: HEIGHT }, [
          { id: 'a', name: 'A', bot: 'poolshark' },
          { id: 'b', name: 'B' },
        ]);
        for (const [shooterX, targetX] of [
          [60, 1275],
          [1275, 60],
          [5, 1270],
          [640, 1279],
          [640, 0],
          [200, 1279],
        ] as [number, number][]) {
          for (const wind of [-10, -5, 0, 5, 10]) {
            states.push({
              ...base,
              wind,
              tanks: base.tanks.map((tank, index) => ({
                ...tank,
                x: index === 0 ? shooterX : targetX,
              })),
            });
          }
        }
      }
    }

    let offMap = 0;
    for (const state of states) {
      const decision = chooseShot(state, 0);
      const trajectory = predictShot(state, 0, decision.angleDeg, decision.power);
      if (trajectory.impact.kind === 'wall' || trajectory.impact.kind === 'expired') offMap += 1;
    }
    const rate = offMap / states.length;
    // A rate, not a count, and a threshold placed between the two measured
    // values rather than at either of them: 0.28% as shipped, 1.33% with the
    // penalty gone. 0.8% leaves the shipped bracket nearly 3x of headroom while
    // still sitting well under what removing the penalty produces.
    expect(
      rate,
      `poolshark left the map on ${(100 * rate).toFixed(2)}% of ${states.length}`,
    ).toBeLessThan(0.008);
  }, 300_000);

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
