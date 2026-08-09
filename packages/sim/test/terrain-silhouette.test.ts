/**
 * Characterisation of the silhouette.
 *
 * `e2e/reference/README.md`, written from the original's screenshots: "Mountains
 * are steep and dramatic, with narrow peaks and deep valleys — much more
 * vertical than gentle rolling hills", and the scoring question "Is the terrain
 * silhouette interesting, or is it soft noise?".
 *
 * The measurements this file makes:
 *
 *   relief         max minus min column. How much of the screen the land uses.
 *   meanAbsSlope   average |ΔY| per column. Ruggedness — a flat plain is 0,
 *                  a map that climbs at the generator's cap everywhere is
 *                  MAX_TERRAIN_SLOPE.
 *   localMaxima    hilltops that dominate ±24 columns. How many separate
 *                  features there are to fight over.
 *
 * Every threshold is taken from the worst value measured over 200 seeds of
 * every style, with a little slack. They are floors on the *worst* map the
 * generator can produce, not on the average one — which is the whole point of
 * measuring at all. The summed-sine generator this replaced had a respectable
 * average (mean slope 0.95 for rolling, 1.26 for mountains); what it did not
 * have was a floor. Measured over the same 200 seeds, its "valley" was not
 * lower in the middle 92 times, its "canyon" had no slot 80 times, and 65 of
 * its valleys had less relief than the 280 px asserted here. Consistency, not
 * average ruggedness, is what makes a map worth loading.
 *
 * The numbers below are all from the current cap of 3 px per column, and all
 * re-measured over 200 seeds of every style against the generator as it ships
 * today — which matters, because the playability check now samples 25 columns
 * instead of 7 and therefore accepts a different (slightly tamer) subset of
 * mountain maps. Mountains average 1.69 px of slope per column and never drop
 * below 1.25; at the 2 px/column cap this used to run at they averaged 1.26, so
 * the whole distribution is still steeper than the old generator's best seed.
 */

import { describe, expect, it } from 'vitest';
import {
  generateTerrain,
  MAX_TERRAIN_SLOPE,
  TERRAIN_STYLES,
  type Terrain,
  type TerrainStyle,
} from '../src/terrain.ts';
import { makeRng } from '../src/rng.ts';

const WIDTH = 1280;
const HEIGHT = 720;
const SEEDS = 40;

function relief(terrain: Terrain): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let x = 0; x < terrain.width; x += 1) {
    const y = terrain.surface[x] as number;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return hi - lo;
}

function meanAbsSlope(terrain: Terrain): number {
  let sum = 0;
  for (let x = 1; x < terrain.width; x += 1) {
    sum += Math.abs((terrain.surface[x] as number) - (terrain.surface[x - 1] as number));
  }
  return sum / (terrain.width - 1);
}

/**
 * Hilltops that dominate +/-24 columns.
 *
 * Memoised, and `maps` below is too. Not premature: the generator now runs a
 * 25-column playability check with up to 48 retries behind it, so a map costs
 * ~8 ms (mountains ~17 ms) instead of well under one, and this file used to
 * regenerate the same five sets of 40 for every assertion. Cached, the whole
 * file builds 260 maps once.
 */
const maximaCache = new WeakMap<Terrain, number>();

function localMaxima(terrain: Terrain): number {
  const memo = maximaCache.get(terrain);
  if (memo !== undefined) return memo;

  const window = 24;
  let count = 0;
  for (let x = window; x < terrain.width - window; x += 1) {
    const y = terrain.surface[x] as number;
    let dominant = true;
    for (let offset = -window; offset <= window && dominant; offset += 1) {
      if (offset === 0) continue;
      const other = terrain.surface[x + offset] as number;
      // Screen Y grows downward: smaller is taller. Ties break leftward so a
      // flat top counts once, not once per column.
      if (other < y || (other === y && offset < 0)) dominant = false;
    }
    if (dominant) count += 1;
  }
  maximaCache.set(terrain, count);
  return count;
}

function flatFraction(terrain: Terrain): number {
  let flat = 0;
  for (let x = 1; x < terrain.width; x += 1) {
    if ((terrain.surface[x] as number) === (terrain.surface[x - 1] as number)) flat += 1;
  }
  return flat / (terrain.width - 1);
}

function meanSurface(terrain: Terrain, from: number, to: number): number {
  let sum = 0;
  for (let x = from; x < to; x += 1) sum += terrain.surface[x] as number;
  return sum / (to - from);
}

const mapCache = new Map<string, Terrain[]>();

function maps(style: TerrainStyle, count = SEEDS): Terrain[] {
  const key = `${style}:${count}`;
  const cached = mapCache.get(key);
  if (cached !== undefined) return cached;

  const out: Terrain[] = [];
  for (let seed = 0; seed < count; seed += 1) {
    out.push(generateTerrain({ width: WIDTH, height: HEIGHT, style }, makeRng(seed)));
  }
  mapCache.set(key, out);
  return out;
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

describe('the terrain is rugged, not soft noise', () => {
  // This is the case that fills `mapCache`, so it pays for most of the
  // generation in the file: 0.72-0.93 s for mountains over three full-suite
  // runs. Both cases here that generate maps rather than reading the cache
  // declare a 60 s budget instead of running against Vitest's undeclared
  // 5000 ms default — at the per-map cost noted on `localMaxima` above, the
  // default is not a budget anybody chose.
  it.each(TERRAIN_STYLES)(
    'style "%s" always has real relief and real slope',
    (style) => {
      for (const [seed, terrain] of maps(style).entries()) {
        // Flattest map measured across 200 seeds of every style: 288 px, 40% of
        // the world height. The land climbs and falls across more than a third
        // of the screen even on the tamest seed.
        expect(relief(terrain), `${style} seed ${seed} relief`).toBeGreaterThanOrEqual(280);

        // Flattest measured over the same 200: 0.338 px per column, a
        // wide-terrace plateau map.
        expect(meanAbsSlope(terrain), `${style} seed ${seed} slope`).toBeGreaterThanOrEqual(0.32);
      }
    },
    60_000,
  );

  // `maps(style, 12)` is a second cache key, so this builds 60 more maps of its
  // own: 1.81 s under full-suite load, the second most expensive case in the
  // file and well inside a budget it now declares.
  it('never leaves a face too steep to stand a tank on', () => {
    // The flip side of ruggedness, and the reason the cap is a named constant
    // rather than a literal here: it is the same number the destruction path's
    // induction starts from.
    for (const style of TERRAIN_STYLES) {
      for (const terrain of maps(style, 12)) {
        for (let x = 1; x < WIDTH; x += 1) {
          const step = Math.abs(
            (terrain.surface[x] as number) - (terrain.surface[x - 1] as number),
          );
          expect(step).toBeLessThanOrEqual(MAX_TERRAIN_SLOPE);
        }
      }
    }
  }, 60_000);

  it('gives a match several separate features to fight over', () => {
    // Averaged, not per-seed: a single valley map legitimately has one hill on
    // each side of the bowl, and a terraced map can be a pure staircase.
    for (const style of TERRAIN_STYLES) {
      const peaks = average(maps(style).map((terrain) => localMaxima(terrain)));
      expect(peaks, `${style}`).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('the styles are genuinely different maps', () => {
  it('mountains are jagged, plateaus are flat, rolling is in between', () => {
    const slope = {
      mountains: average(maps('mountains').map(meanAbsSlope)),
      rolling: average(maps('rolling').map(meanAbsSlope)),
      plateaus: average(maps('plateaus').map(meanAbsSlope)),
    };
    expect(slope.mountains).toBeGreaterThan(slope.rolling);
    expect(slope.rolling).toBeGreaterThan(slope.plateaus);

    // Terraces are literally flat: level treads with short risers between.
    const flat = {
      plateaus: average(maps('plateaus').map(flatFraction)),
      mountains: average(maps('mountains').map(flatFraction)),
    };
    expect(flat.plateaus).toBeGreaterThan(2 * flat.mountains);
  });

  it('mountains have narrow peaks, not rolling hills', () => {
    // Worst mountain seed of 200 measures 1.255 px per column, against a
    // rolling average of 1.00: the tamest mountain map is still rougher than a
    // typical rolling one.
    for (const terrain of maps('mountains')) {
      expect(meanAbsSlope(terrain)).toBeGreaterThanOrEqual(1.2);
    }
    expect(average(maps('mountains').map((t) => localMaxima(t)))).toBeGreaterThan(
      average(maps('rolling').map((t) => localMaxima(t))),
    );
  });

  it('a valley is lower in the middle, on every seed', () => {
    const third = Math.floor(WIDTH / 3);
    for (const [seed, terrain] of maps('valley').entries()) {
      const middle = meanSurface(terrain, third, 2 * third);
      const shoulders =
        (meanSurface(terrain, 0, third) + meanSurface(terrain, 2 * third, WIDTH)) / 2;
      // Screen Y grows downward, so "lower ground" is a larger surface Y.
      expect(middle - shoulders, `valley seed ${seed}`).toBeGreaterThan(55);
    }
  });

  it('a canyon cuts a slot most of the way to the floor, on every seed', () => {
    for (const [seed, terrain] of maps('canyon').entries()) {
      let deepestInside = -Infinity;
      for (let x = Math.floor(WIDTH * 0.2); x < Math.floor(WIDTH * 0.8); x += 1) {
        deepestInside = Math.max(deepestInside, terrain.surface[x] as number);
      }
      let highest = Infinity;
      for (let x = 0; x < WIDTH; x += 1) highest = Math.min(highest, terrain.surface[x] as number);

      // 400 px of drop between the mesa top and the canyon floor — more than
      // half the height of the world. Worst canyon seed of 200 measures 413.
      expect(deepestInside - highest, `canyon seed ${seed}`).toBeGreaterThanOrEqual(400);
    }
  });

  it('no two styles produce the same map from the same seed', () => {
    const signatures = new Set<string>();
    for (const style of TERRAIN_STYLES) {
      const terrain = generateTerrain({ width: WIDTH, height: HEIGHT, style }, makeRng(12));
      signatures.add(Array.from(terrain.surface).join(','));
    }
    expect(signatures.size).toBe(TERRAIN_STYLES.length);
  });
});
