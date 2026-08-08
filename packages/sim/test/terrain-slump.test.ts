/**
 * The slope invariant of destroyed ground.
 *
 * One claim, checked from every side that can break it:
 *
 *     terrain within MAX_BLAST_SLOPE + any craters and mounds
 *       => terrain still within MAX_BLAST_SLOPE
 *
 * It is what stops a player drilling a one-column well by firing into the same
 * spot, and what stops a Dirt Ball stacking into a vertical tower. Both of
 * those were real: before this suite existed the slump left 7 px/column
 * standing after twelve Baby Missiles and 12 px/column after forty, and
 * `applyMound` had no bound, no slump and no geometric test at all.
 *
 * Every test here asserts the documented bound, never the number the code
 * happens to produce.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCrater,
  applyMound,
  emptyTerrain,
  generateTerrain,
  MAX_BLAST_SLOPE,
  MAX_SLUMP_PASSES,
  MAX_TERRAIN_SLOPE,
  surfaceAt,
  TERRAIN_STYLES,
  type Terrain,
} from '../src/terrain.ts';
import { makeRng } from '../src/rng.ts';
import { WEAPONS } from '../src/weapons.ts';

const WIDTH = 1280;
const HEIGHT = 720;

/** Every blast radius the shop can actually produce, smallest first. */
const WEAPON_RADII = [...new Set(WEAPONS.map((weapon) => weapon.radius))].sort((a, b) => a - b);

function flatTerrain(surfaceY: number, width = WIDTH, height = HEIGHT): Terrain {
  const terrain = emptyTerrain(width, height);
  terrain.surface.fill(surfaceY);
  return terrain;
}

function steepestStep(terrain: Terrain): { step: number; at: number } {
  let step = 0;
  let at = 0;
  for (let x = 1; x < terrain.width; x += 1) {
    const d = Math.abs((terrain.surface[x] as number) - (terrain.surface[x - 1] as number));
    if (d > step) {
      step = d;
      at = x;
    }
  }
  return { step, at };
}

function totalSurface(terrain: Terrain): number {
  let sum = 0;
  for (let x = 0; x < terrain.width; x += 1) sum += terrain.surface[x] as number;
  return sum;
}

describe('the bound holds on ground the generator made', () => {
  it('a single detonation anywhere never leaves a face over the limit', () => {
    // The case the old comment claimed could not happen and never tested:
    // virgin ground at MAX_TERRAIN_SLOPE with a crater rim of 2 * CRATER_DEPTH
    // laid on top of it composes past the limit, and 15 of these 180 used to
    // finish with a 6 or 7 px face standing.
    for (const style of TERRAIN_STYLES) {
      for (let seed = 0; seed < 4; seed += 1) {
        for (const radius of WEAPON_RADII) {
          const terrain = generateTerrain({ width: WIDTH, height: HEIGHT, style }, makeRng(seed));
          expect(steepestStep(terrain).step).toBeLessThanOrEqual(MAX_TERRAIN_SLOPE);

          const result = applyCrater(terrain, 640, surfaceAt(terrain, 640), radius);
          const worst = steepestStep(terrain);
          expect(
            worst.step,
            `${style} seed ${seed} r${radius} at column ${worst.at}`,
          ).toBeLessThanOrEqual(MAX_BLAST_SLOPE);
          expect(result.slumpPasses).toBeLessThan(MAX_SLUMP_PASSES);
        }
      }
    }
  });

  it('survives a whole match of scattered fire', () => {
    const terrain = generateTerrain(
      { width: WIDTH, height: HEIGHT, style: 'mountains' },
      makeRng(9),
    );
    const rng = makeRng('bombardment');
    let worstPasses = 0;

    for (let shot = 0; shot < 250; shot += 1) {
      const x = rng.range(-40, WIDTH + 40);
      const radius = rng.pick(WEAPON_RADII);
      const result = rng.chance(0.2)
        ? applyMound(terrain, x, surfaceAt(terrain, x), radius)
        : applyCrater(terrain, x, surfaceAt(terrain, x) + rng.range(-radius, radius), radius);
      worstPasses = Math.max(worstPasses, result.slumpPasses);
      expect(steepestStep(terrain).step, `after shot ${shot}`).toBeLessThanOrEqual(MAX_BLAST_SLOPE);
    }
    expect(worstPasses).toBeLessThan(MAX_SLUMP_PASSES);
  });
});

describe('firing into the same column', () => {
  it('converges instead of drilling, and stays inside the bound throughout', () => {
    // Forty Baby Missiles down one column, each detonating on the new surface.
    const terrain = flatTerrain(200, 600, 900);
    const depths: number[] = [];
    const widths: number[] = [];
    let worstPasses = 0;

    for (let shot = 0; shot < 40; shot += 1) {
      const result = applyCrater(terrain, 300, terrain.surface[300] as number, 18);
      worstPasses = Math.max(worstPasses, result.slumpPasses);
      depths.push((terrain.surface[300] as number) - 200);

      let wide = 0;
      for (let x = 0; x < 600; x += 1) if ((terrain.surface[x] as number) >= 240) wide += 1;
      widths.push(wide);

      expect(steepestStep(terrain).step, `after shot ${shot}`).toBeLessThanOrEqual(MAX_BLAST_SLOPE);
    }

    const first = depths[0] as number;
    expect((depths[11] as number) - (depths[10] as number)).toBeLessThan(first * 0.75);
    expect(depths[11] as number).toBeLessThan(first * 12);

    // The hole spreads sideways as it deepens rather than staying a slot.
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i] as number).toBeGreaterThanOrEqual(widths[i - 1] as number);
    }
    expect(widths[39] as number).toBeGreaterThan(3 * 18);

    // And the loop stops because the dirt stopped moving, not because it ran
    // out of budget. Measured worst here: 218 passes of the 4096 available.
    expect(worstPasses).toBeLessThan(MAX_SLUMP_PASSES / 4);
  });

  it('converges for every weapon in the shop, sixty rounds deep', () => {
    // The pass budget's worst case. A blast digs 1.5 radii per shot, so sixty
    // Death's Heads into one column is the deepest, widest pit a 720 px world
    // can hold — the most relaxation the sim can ever be asked for in one call.
    // The margin below is the point: half the budget spare, not "it fit".
    for (const radius of WEAPON_RADII) {
      const terrain = generateTerrain(
        { width: WIDTH, height: HEIGHT, style: 'rolling' },
        makeRng(3),
      );
      let worstPasses = 0;
      for (let shot = 0; shot < 60; shot += 1) {
        const result = applyCrater(terrain, 640, surfaceAt(terrain, 640), radius);
        worstPasses = Math.max(worstPasses, result.slumpPasses);
      }
      expect(steepestStep(terrain).step, `r${radius}`).toBeLessThanOrEqual(MAX_BLAST_SLOPE);
      expect(worstPasses, `r${radius} passes`).toBeLessThan(MAX_SLUMP_PASSES / 2);
    }
  });
});

describe('mounds are dirt, not scaffolding', () => {
  it('a fresh mound on flat ground is inside the bound at every radius', () => {
    // The circular cap this replaced was vertical at its rim: 3 px/column at
    // radius 10, 6 at 40, 8 at 70 — over the terrain cap at every size.
    for (const radius of WEAPON_RADII) {
      const terrain = flatTerrain(400);
      applyMound(terrain, 640, 400, radius);
      expect(steepestStep(terrain).step, `r${radius}`).toBeLessThanOrEqual(MAX_BLAST_SLOPE);
      expect(surfaceAt(terrain, 640)).toBeLessThan(400); // it really did pile up
    }
  });

  it('eight Dirt Balls on one column build a hill, not a tower', () => {
    const dirtBall = WEAPONS.find((weapon) => weapon.id === 'dirt_ball');
    expect(dirtBall).toBeDefined();
    const radius = (dirtBall as { radius: number }).radius;

    const terrain = generateTerrain({ width: WIDTH, height: HEIGHT, style: 'rolling' }, makeRng(5));
    const before = surfaceAt(terrain, 640);
    for (let drop = 0; drop < 8; drop += 1) {
      const result = applyMound(terrain, 640, surfaceAt(terrain, 640), radius);
      expect(result.slumpPasses).toBeLessThan(MAX_SLUMP_PASSES);
      expect(steepestStep(terrain).step, `after drop ${drop}`).toBeLessThanOrEqual(MAX_BLAST_SLOPE);
    }

    const peak = surfaceAt(terrain, 640);
    expect(peak).toBeLessThan(before); // there is a hill

    // A pile of height h with sides at the limit is at least 2h/limit columns
    // wide. That is the whole difference between a hill and the 461 px vertical
    // column this used to build.
    const height = before - peak;
    let wider = 0;
    for (let x = 0; x < WIDTH; x += 1) if ((terrain.surface[x] as number) < before) wider += 1;
    expect(wider).toBeGreaterThanOrEqual((2 * height) / MAX_BLAST_SLOPE);
  });

  it('never rises above the top of the world, however much is dumped', () => {
    const terrain = flatTerrain(60);
    for (let drop = 0; drop < 12; drop += 1) applyMound(terrain, 640, surfaceAt(terrain, 640), 70);
    for (let x = 0; x < WIDTH; x += 1) {
      expect(terrain.surface[x]).toBeGreaterThanOrEqual(0);
      expect(terrain.surface[x]).toBeLessThanOrEqual(HEIGHT);
    }
    expect(steepestStep(terrain).step).toBeLessThanOrEqual(MAX_BLAST_SLOPE);
  });
});

describe('what the slump does to the dirt it moves', () => {
  it('is symmetric about a symmetric blast', () => {
    // Two hits so the slump actually fires: one crater on flat ground is inside
    // the bound on its own.
    const terrain = flatTerrain(300, 600, 900);
    applyCrater(terrain, 300, 300, 40);
    applyCrater(terrain, 300, terrain.surface[300] as number, 40);
    expect(steepestStep(terrain).step).toBeLessThanOrEqual(MAX_BLAST_SLOPE);
    for (let offset = 1; offset < 290; offset += 1) {
      expect(terrain.surface[300 - offset], `offset ${offset}`).toBe(terrain.surface[299 + offset]);
    }
  });

  it('conserves dirt, and reports exactly the change it made', () => {
    // `removed` is the net change in solid ground, slump included. Transfers
    // conserve mass, so away from the edges of the world the slump contributes
    // nothing and `removed` is purely what the blast cut out.
    const terrain = flatTerrain(300, 600, 900);
    applyCrater(terrain, 300, 300, 40);

    const before = totalSurface(terrain);
    const carved = applyCrater(terrain, 300, terrain.surface[300] as number, 40);
    expect(totalSurface(terrain) - before).toBe(carved.removed);
    expect(carved.slumpPasses).toBeGreaterThan(0);

    const beforeMound = totalSurface(terrain);
    const piled = applyMound(terrain, 300, terrain.surface[300] as number, 40);
    expect(totalSurface(terrain) - beforeMound).toBe(piled.removed);
    expect(piled.removed).toBeLessThan(0);
  });

  it('reports a range wide enough to repaint', () => {
    const terrain = flatTerrain(300, 600, 900);
    applyCrater(terrain, 300, 300, 40);
    const result = applyCrater(terrain, 300, terrain.surface[300] as number, 40);

    for (let x = 0; x < 600; x += 1) {
      const changed = (terrain.surface[x] as number) !== 300;
      if (changed) {
        expect(x).toBeGreaterThanOrEqual(result.minX);
        expect(x).toBeLessThanOrEqual(result.maxX);
      }
    }
  });
});

describe('ground that was already over the limit', () => {
  it('is not made worse, and does not hang', () => {
    // The precondition in MAX_BLAST_SLOPE's comment, stated as a test. A
    // uniformly over-steep ramp cannot be pulled under the bound by any local
    // mass-conserving rule — every interior column receives exactly what it
    // sheds — so the promise here is only that a blast leaves it no steeper and
    // returns.
    const terrain = emptyTerrain(600, 5000);
    for (let x = 0; x < 600; x += 1) terrain.surface[x] = 3000 - x * 8;

    const before = steepestStep(terrain).step;
    const result = applyCrater(terrain, 300, terrain.surface[300] as number, 30);
    expect(steepestStep(terrain).step).toBeLessThanOrEqual(before);
    expect(result.slumpPasses).toBeLessThanOrEqual(MAX_SLUMP_PASSES);
    for (let x = 0; x < 600; x += 1) {
      expect(terrain.surface[x]).toBeGreaterThanOrEqual(0);
      expect(terrain.surface[x]).toBeLessThanOrEqual(5000);
    }
  });
});
