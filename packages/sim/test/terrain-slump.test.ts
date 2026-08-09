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
 * Geometry is always asserted against the documented bound, never against the
 * number the code happens to produce. COST is the exception, and deliberately
 * so: `slumpPasses` is asserted against a fraction of `MAX_SLUMP_PASSES` with
 * the measured worst case written next to it, because a bound like
 * `<= MAX_SLUMP_PASSES` is true by construction (`passes = pass + 1` inside
 * `for (pass = 0; pass < MAX_SLUMP_PASSES)`) and therefore says nothing. The
 * one input that genuinely exhausts the budget is asserted to do exactly that,
 * by equality, in "ground that was already over the limit".
 */

import { describe, expect, it } from 'vitest';
import {
  applyCrater,
  applyMound,
  cloneTerrain,
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
  // Explicit 60 s timeout, because Vitest's default is 5000 ms and this test
  // used to run at 3.9-4.5 s under full-suite load on a 28-core box — 78-91% of
  // a budget it never declared, which is a timeout on any smaller CI runner.
  // Cloning the map instead of regenerating it per radius got it to 0.45-0.51 s
  // over three full-suite runs; the declared budget is what stops it silently
  // creeping back.
  it('a single detonation anywhere never leaves a face over the limit', () => {
    // The case the old comment claimed could not happen and never tested:
    // virgin ground at MAX_TERRAIN_SLOPE with a crater rim of 2 * CRATER_DEPTH
    // laid on top of it composes past the limit, and 15 of these 180 used to
    // finish with a 6 or 7 px face standing.
    //
    // Each (style, seed) map is generated ONCE and cloned per radius. The
    // sixteen radii used to re-generate the same map sixteen times, which is
    // 320 `generateTerrain` calls for 20 distinct maps — and generation is by
    // far the expensive half now that the playability check samples 25 columns
    // and the retry loop runs to 48 attempts. `cloneTerrain` is an exact copy,
    // so every one of the 320 detonations still lands on virgin ground.
    for (const style of TERRAIN_STYLES) {
      for (let seed = 0; seed < 4; seed += 1) {
        const pristine = generateTerrain({ width: WIDTH, height: HEIGHT, style }, makeRng(seed));
        expect(steepestStep(pristine).step).toBeLessThanOrEqual(MAX_TERRAIN_SLOPE);

        for (const radius of WEAPON_RADII) {
          const terrain = cloneTerrain(pristine);
          const result = applyCrater(terrain, 640, surfaceAt(terrain, 640), radius);
          const worst = steepestStep(terrain);
          expect(
            worst.step,
            `${style} seed ${seed} r${radius} at column ${worst.at}`,
          ).toBeLessThanOrEqual(MAX_BLAST_SLOPE);
          // Worst measured over these 320 detonations: 592 passes
          // (canyon seed 3, r120).
          expect(result.slumpPasses, `${style} seed ${seed} r${radius}`).toBeLessThan(
            MAX_SLUMP_PASSES / 4,
          );
        }
      }
    }
  }, 60_000);

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
    // Realistic abuse is cheap: worst measured over these 250 shots is 205
    // passes, a twentieth of the budget.
    expect(worstPasses).toBeLessThan(MAX_SLUMP_PASSES / 8);
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

  // Declared for the same reason as the sweep above: 0.74-0.94 s under
  // full-suite load, a fifth of a default nobody chose. Same clone, so the
  // sixteen radii cost one generation rather than sixteen.
  it('converges for every weapon in the shop, sixty rounds deep', () => {
    // Sixty rounds of one weapon into one column of real generated ground.
    // Worst measured here: 802 passes (r90).
    const pristine = generateTerrain(
      { width: WIDTH, height: HEIGHT, style: 'rolling' },
      makeRng(3),
    );
    for (const radius of WEAPON_RADII) {
      const terrain = cloneTerrain(pristine);
      let worstPasses = 0;
      for (let shot = 0; shot < 60; shot += 1) {
        const result = applyCrater(terrain, 640, surfaceAt(terrain, 640), radius);
        worstPasses = Math.max(worstPasses, result.slumpPasses);
      }
      expect(steepestStep(terrain).step, `r${radius}`).toBeLessThanOrEqual(MAX_BLAST_SLOPE);
      expect(worstPasses, `r${radius} passes`).toBeLessThan(MAX_SLUMP_PASSES / 2);
    }
  }, 60_000);
});

describe('the pass budget has the margin its comment claims', () => {
  it('holds for both digging and piling, at every radius and every depth', () => {
    // The sweep behind MAX_SLUMP_PASSES, re-run — and it is `applyMound` that
    // owns the worst case, which is exactly the path the original sweep never
    // covered even though the same slumpBlast has run for it since mounds
    // started slumping. At 1280x720, every distinct radius in WEAPONS, sixty
    // rounds into one column of flat ground:
    //
    //     applyCrater  peaks at 1251  (r120 on ground 80)
    //     applyMound   peaks at 1530  (r120 on ground 719)
    //                  and at 1322 restricted to the radii the dirt weapons
    //                  really ship with (r70, Ton of Dirt)
    //
    // So the headroom over the worst reachable case is 4096/1530 = 2.7x, not
    // the 3x the comment used to claim off a 1210 that was measured on the
    // cheaper path. Ground 80 and ground 719 are in the list because that is
    // where each path peaks: a crater is worst with the whole world below it to
    // dig into, a mound is worst starting from the floor with the whole world
    // above it to fill.
    //
    // All three peaks are asserted by value at the bottom, not just bounded, so
    // the comment on MAX_SLUMP_PASSES that quotes them cannot go stale without
    // this test saying so.
    const DIRT_RADII = new Set(
      WEAPONS.filter((weapon) => weapon.dirtVolume !== undefined).map((weapon) => weapon.radius),
    );
    let worstCrater = 0;
    let worstMound = 0;
    let worstDirtMound = 0;
    let worstCraterAt = '';
    let worstMoundAt = '';
    let worstDirtMoundAt = '';

    for (const radius of WEAPON_RADII) {
      for (const ground of [80, 360, 719]) {
        const dug = flatTerrain(ground);
        for (let shot = 0; shot < 60; shot += 1) {
          const passes = applyCrater(dug, 640, surfaceAt(dug, 640), radius).slumpPasses;
          if (passes > worstCrater) {
            worstCrater = passes;
            worstCraterAt = `r${radius} on ground ${ground}`;
          }
        }
        expect(steepestStep(dug).step, `crater r${radius} @${ground}`).toBeLessThanOrEqual(
          MAX_BLAST_SLOPE,
        );

        const piled = flatTerrain(ground);
        for (let drop = 0; drop < 60; drop += 1) {
          const passes = applyMound(piled, 640, surfaceAt(piled, 640), radius).slumpPasses;
          if (passes > worstMound) {
            worstMound = passes;
            worstMoundAt = `r${radius} on ground ${ground}`;
          }
          if (DIRT_RADII.has(radius) && passes > worstDirtMound) {
            worstDirtMound = passes;
            worstDirtMoundAt = `r${radius} on ground ${ground}`;
          }
        }
        expect(steepestStep(piled).step, `mound r${radius} @${ground}`).toBeLessThanOrEqual(
          MAX_BLAST_SLOPE,
        );
      }
    }

    // The dirt weapons really do ship the radii this restriction assumes.
    expect([...DIRT_RADII].sort((a, b) => a - b)).toEqual([22, 24, 36, 70]);

    // The margin the comment on MAX_SLUMP_PASSES promises, on BOTH paths. The
    // mound tests used to assert nothing tighter than `< MAX_SLUMP_PASSES`.
    expect(worstCrater, `worst crater ${worstCraterAt}`).toBeLessThan(MAX_SLUMP_PASSES / 2);
    expect(worstMound, `worst mound ${worstMoundAt}`).toBeLessThan(MAX_SLUMP_PASSES / 2);

    // And the sweep really did reach the expensive corner — otherwise the two
    // bounds above would pass on a sweep that had quietly been trimmed to a few
    // cheap radii.
    expect(worstCrater, `worst crater ${worstCraterAt}`).toBeGreaterThan(1000);
    expect(worstMound, `worst mound ${worstMoundAt}`).toBeGreaterThan(1000);

    // The three numbers `MAX_SLUMP_PASSES`' comment quotes, by value and by
    // location. If a rule change moves them, this fails and the comment gets
    // re-measured instead of quietly describing a version of the code that no
    // longer exists.
    expect([worstCrater, worstCraterAt]).toEqual([1251, 'r120 on ground 80']);
    expect([worstMound, worstMoundAt]).toEqual([1530, 'r120 on ground 719']);
    expect([worstDirtMound, worstDirtMoundAt]).toEqual([1322, 'r70 on ground 719']);
  }, 120_000);
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
      // Worst measured over these eight drops: 387 passes.
      expect(result.slumpPasses, `drop ${drop}`).toBeLessThan(MAX_SLUMP_PASSES / 4);
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
  /** Total dirt standing above the bound: the thing a slump has to reduce. */
  function totalExcess(terrain: Terrain): number {
    let sum = 0;
    for (let x = 1; x < terrain.width; x += 1) {
      const step = Math.abs((terrain.surface[x] as number) - (terrain.surface[x - 1] as number));
      sum += Math.max(0, step - MAX_BLAST_SLOPE);
    }
    return sum;
  }

  function ramp(width: number, slope: number): Terrain {
    const terrain = emptyTerrain(width, 6000);
    for (let x = 0; x < width; x += 1) terrain.surface[x] = 3500 - x * slope;
    return terrain;
  }

  it('knowingly runs out of budget on a ramp, and says so', () => {
    // The case `slumpPasses` exists for, asserted as what it is. This input
    // does NOT converge inside the budget: it uses all 4096 passes and comes
    // back still over the limit. Given an unbounded budget the same ramp does
    // reach MAX_BLAST_SLOPE everywhere — measured on `ramp(600, 8)` exactly as
    // built above, with MAX_SLUMP_PASSES temporarily raised to 262144: 26954
    // passes, 6.6x what it is allowed, finishing at a steepest face of 5. So
    // the guard is a cost ceiling, not a claim about the rule.
    //
    // The pass count is a property of this fixture and not of "a 600-column
    // ramp" in general: how much of the ramp starts outside the world, and so
    // how much dirt the top-of-world clamp absorbs, moves it a long way. The
    // 5000-tall/3000-start ramp this file used to build takes 19777 passes on
    // the same rule — which is where the 19777 that used to be quoted here came
    // from, and why it stopped being true when the fixture changed.
    //
    // `toBeLessThanOrEqual(MAX_SLUMP_PASSES)` used to stand here. It cannot
    // fail: `passes = pass + 1` inside `for (pass = 0; pass < MAX_SLUMP_PASSES)`
    // caps the value by construction, so it read as a convergence check while
    // being blind to the one input that does not converge.
    const terrain = ramp(600, 8);

    const started = Date.now();
    const result = applyCrater(terrain, 300, terrain.surface[300] as number, 30);
    const elapsed = Date.now() - started;

    expect(result.slumpPasses).toBe(MAX_SLUMP_PASSES);
    expect(steepestStep(terrain).step).toBeGreaterThan(MAX_BLAST_SLOPE);
    // Bounded work, which is the whole point of the guard. Wall clock is
    // machine-dependent; on the box this was last measured on the call takes
    // 65-69 ms, and 84-112 ms for the same ramp at 1280 wide. The bound is
    // loose enough not to flake on a loaded CI runner and tight enough that a
    // rule change costing an order of magnitude more trips it.
    expect(elapsed).toBeLessThan(2000);
  });

  it('never makes over-steep ground worse, at any width or slope', () => {
    // What is actually true, measured across the family instead of asserted on
    // the single fixture that happened to hold. The old test used one ramp and
    // asserted the steepest face never grows. That is FALSE in general: cut off
    // mid-avalanche, the sweep leaves a kink steeper than it found — it happens
    // on 33 of these 84 cases, and the worst of them gains 3 px.
    //
    // The invariant that does hold everywhere is the global one: the total
    // dirt standing above the bound never grows, so a blast always moves such
    // ground towards the limit even when it cannot get there.
    //
    // Every "goes A -> B" number this comment could carry is in `documented`
    // below and asserted, so it fails instead of rotting. That is not
    // hypothetical: the sentence that stood here said 600 at 8 was "one of the
    // few that does not" grow. True of the 5000-tall/3000-start ramp this file
    // used to build (8 -> 8 there), false of the 6000-tall/3500-start one it
    // builds now, where 600 at 8 gains two and 500 at 8 gains three. A comment
    // nobody re-runs is a comment describing a fixture that no longer exists.
    const observed = new Map<string, [number, number]>();
    let steeper = 0;
    let checked = 0;

    for (const width of [120, 200, 300, 400, 500, 600, 900]) {
      for (const slope of [6, 7, 8, 10, 12, 20]) {
        for (const kind of ['crater', 'mound'] as const) {
          const terrain = ramp(width, slope);
          const beforeExcess = totalExcess(terrain);
          const beforeStep = steepestStep(terrain).step;
          const beforeMass = totalSurface(terrain);
          const centre = Math.floor(width / 2);
          const surface = terrain.surface[centre] as number;

          const result =
            kind === 'crater'
              ? applyCrater(terrain, centre, surface, 30)
              : applyMound(terrain, centre, surface - 5, 30);

          checked += 1;
          expect(totalExcess(terrain), `${kind} w${width} slope${slope}`).toBeLessThanOrEqual(
            beforeExcess,
          );
          expect(totalSurface(terrain) - beforeMass, `${kind} w${width} slope${slope}`).toBe(
            result.removed,
          );
          let outside = 0;
          for (let x = 0; x < width; x += 1) {
            const y = terrain.surface[x] as number;
            if (y < 0 || y > 6000) outside += 1;
          }
          expect(outside, `${kind} w${width} slope${slope} columns outside the world`).toBe(0);

          const afterStep = steepestStep(terrain).step;
          observed.set(`${kind} w${width} s${slope}`, [beforeStep, afterStep]);
          if (afterStep > beforeStep) steeper += 1;
        }
      }
    }

    expect(checked).toBe(7 * 6 * 2);

    // The measured face-steepness of this family, pinned. Includes both ends:
    // ramps the budget does reach (120 wide converges to the bound), ramps it
    // does not (300-600 wide gain 1-3 px), and one that comes out unchanged
    // (900 at 8) so "it always gets worse" cannot pass either.
    const documented: Record<string, [number, number]> = {
      'crater w120 s8': [8, 5],
      'crater w200 s8': [8, 6],
      'crater w300 s8': [8, 9],
      'crater w400 s8': [8, 10],
      'mound w400 s8': [8, 11],
      'crater w500 s8': [8, 11],
      'crater w600 s6': [6, 7],
      'crater w600 s8': [8, 10],
      'crater w900 s8': [8, 8],
    };
    for (const [where, expected] of Object.entries(documented)) {
      expect(observed.get(where), `${where} steepest face before/after`).toEqual(expected);
    }

    // And the reason this test is phrased on the total and not the maximum: the
    // maximum really does grow on some of these. Asserted as the exact count so
    // a rule change that fixed it fails loudly here and the prose above gets
    // rewritten rather than silently kept.
    expect(steeper, 'cases where the steepest face grew').toBe(33);
  }, 60_000);

  it('pulls an over-steep map right under the bound when the budget reaches', () => {
    // The other half, and the one that shows the guard is about cost rather
    // than capability: a 100-column ramp at the same 8 px/column converges in
    // 1057 passes and finishes inside MAX_BLAST_SLOPE everywhere. The claim
    // this file used to carry — that no local mass-conserving rule could ever
    // fix such a map — was true of the Jacobi sweep it described and is not
    // true of the ordered sweep the code runs now.
    const terrain = ramp(100, 8);
    const result = applyCrater(terrain, 50, terrain.surface[50] as number, 30);

    expect(result.slumpPasses).toBeLessThan(MAX_SLUMP_PASSES);
    expect(steepestStep(terrain).step).toBeLessThanOrEqual(MAX_BLAST_SLOPE);
  });
});
