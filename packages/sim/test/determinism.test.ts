/**
 * Golden-file determinism tests (TECH_STACK.md: "Determinism | Vitest
 * golden-file tests").
 *
 * A recorded input sequence is replayed and the final state hash is snapshotted.
 * If anyone accidentally introduces nondeterminism — an unseeded random, a
 * clock read, a `Math.sin` — these snapshots change and the build goes red.
 *
 * If a snapshot changes because of an INTENTIONAL rules change, update it with
 * `pnpm --filter @scorched/sim test -- -u` and say so in the PR description.
 */

import { describe, expect, it } from 'vitest';

import { fire, hashGameState, type GameState } from '../src/game.ts';
import { generateTerrain, hashTerrain, TERRAIN_STYLES } from '../src/terrain.ts';
import { simulateFlight } from '../src/physics.ts';
import { makeRng } from '../src/rng.ts';
import { WEAPONS } from '../src/weapons.ts';
import { openedGame } from './opening.ts';

interface RecordedShot {
  angleDeg: number;
  power: number;
  weapon: string;
}

/** A fixed, hand-written script of shots. Never generate this randomly. */
const RECORDED_MATCH: readonly RecordedShot[] = [
  { angleDeg: 45, power: 60, weapon: 'baby_missile' },
  { angleDeg: 132, power: 71, weapon: 'missile' },
  { angleDeg: 38, power: 88, weapon: 'baby_nuke' },
  { angleDeg: 140, power: 55, weapon: 'mirv' },
  { angleDeg: 62, power: 93, weapon: 'napalm' },
  { angleDeg: 118, power: 40, weapon: 'dirt_ball' },
  { angleDeg: 75, power: 66, weapon: 'baby_roller' },
  { angleDeg: 101, power: 79, weapon: 'funky_bomb' },
];

function replay(seed: string): GameState {
  // `openedGame`, because `createGame` now hands back the pre-match armoury and
  // the loop below would break on the first iteration. See `fired` below: that
  // is not a hypothetical, it is what happened.
  let state = openedGame({ seed, totalRounds: 3, width: 1280, height: 720 }, [
    { id: 'p1', name: 'Alice' },
    { id: 'p2', name: 'Bob' },
    { id: 'p3', name: 'Cleo' },
  ]);

  // Stock the armoury so every weapon in the script is actually firable.
  state = {
    ...state,
    tanks: state.tanks.map((tank) => ({
      ...tank,
      inventory: Object.fromEntries(WEAPONS.map((weapon) => [weapon.id, 25])),
    })),
  };

  for (const shot of RECORDED_MATCH) {
    if (state.phase !== 'aiming') break;
    const shooter = state.tanks[state.activeTank];
    if (shooter === undefined) break;
    state = fire(state, shooter.id, {
      turnNumber: state.turnNumber,
      angleDeg: shot.angleDeg,
      power: shot.power,
      weapon: shot.weapon,
    }).state;
    fired += 1;
  }

  return state;
}

/**
 * Shots the last `replay()` actually got through.
 *
 * A golden snapshot is a change detector, and the failure mode of a change
 * detector is that it quietly stops detecting: the loop above bails the moment
 * the phase is not `aiming`, so a state machine change that puts a fresh game
 * in any other phase turns the whole "full match replay" into a snapshot of a
 * board nobody shot at — still stable, still green after one `-u`, and
 * measuring nothing. That is exactly what opening in the armoury did.
 */
let fired = 0;

describe('golden: rng', () => {
  it('sfc32 output is stable', () => {
    const rng = makeRng('scorched-earth');
    const values = Array.from({ length: 12 }, () => rng.nextU32());
    expect(values).toMatchSnapshot();
  });
});

describe('golden: terrain', () => {
  it.each(TERRAIN_STYLES)('style "%s" hashes stably', (style) => {
    const terrain = generateTerrain({ width: 1280, height: 720, style }, makeRng('golden-terrain'));
    expect(hashTerrain(terrain).toString(16)).toMatchSnapshot();
  });

  it('a fixed profile of columns is stable', () => {
    const terrain = generateTerrain({ width: 1280, height: 720 }, makeRng('golden-profile'));
    const samples = [0, 128, 256, 384, 512, 640, 768, 896, 1024, 1152, 1279].map(
      (x) => terrain.surface[x],
    );
    expect(samples).toMatchSnapshot();
  });
});

describe('golden: ballistics', () => {
  it('a fixed shot follows a stable path', () => {
    const terrain = generateTerrain({ width: 1280, height: 720 }, makeRng('golden-ballistics'));
    const result = simulateFlight(
      { x: 200, y: 300, angleDeg: 47, power: 78 },
      { terrain, wind: 3.4 },
    );

    expect({
      steps: result.steps,
      impactKind: result.impact.kind,
      impactX: Math.round(result.impact.x * 1000) / 1000,
      impactY: Math.round(result.impact.y * 1000) / 1000,
    }).toMatchSnapshot();
  });
});

describe('golden: full match replay', () => {
  it('actually fires the whole recorded script', () => {
    fired = 0;
    replay('golden-match');
    expect(fired).toBe(RECORDED_MATCH.length);
  });

  it('produces a stable final state hash', () => {
    expect(replay('golden-match')).toBeDefined();
    expect(hashGameState(replay('golden-match'))).toMatchSnapshot();
  });

  it('is identical when replayed twice in the same process', () => {
    expect(hashGameState(replay('golden-match'))).toBe(hashGameState(replay('golden-match')));
  });

  it('records stable per-tank outcomes', () => {
    const state = replay('golden-match');
    expect(
      state.tanks.map((tank) => ({
        id: tank.id,
        health: tank.health,
        alive: tank.alive,
        score: tank.score,
        x: tank.x,
        y: tank.y,
      })),
    ).toMatchSnapshot();
  });
});
