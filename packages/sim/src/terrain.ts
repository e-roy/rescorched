/**
 * Destructible terrain.
 *
 * Representation: one integer per pixel column giving the Y of the topmost solid
 * pixel (screen coordinates, Y grows downward). A column is solid for every
 * `y >= surface[x]`. This mirrors the original Scorched Earth, where terrain is
 * a heightmap and dirt above a blast collapses straight down — there are no
 * persistent overhangs.
 *
 * Integers, not floats: the heightmap is part of the authoritative game state
 * and gets hashed for golden-file determinism tests.
 */

import { clamp, detSin, TWO_PI } from './math.ts';
import type { Rng } from './rng.ts';

export interface Terrain {
  readonly width: number;
  readonly height: number;
  /** surface[x] = Y of the topmost solid pixel in column x. `height` means empty. */
  readonly surface: Int32Array;
}

export type TerrainStyle = 'rolling' | 'mountains' | 'plateaus' | 'valley' | 'canyon';

export const TERRAIN_STYLES: readonly TerrainStyle[] = [
  'rolling',
  'mountains',
  'plateaus',
  'valley',
  'canyon',
];

export interface TerrainOptions {
  width: number;
  height: number;
  style?: TerrainStyle;
  /** Fraction of the screen height the terrain may occupy, 0..1. */
  minGround?: number;
  maxGround?: number;
}

/** Allocate an empty terrain (all sky). */
export function emptyTerrain(width: number, height: number): Terrain {
  const surface = new Int32Array(width);
  surface.fill(height);
  return { width, height, surface };
}

/** Deep copy — the sim never mutates a caller's terrain in place by accident. */
export function cloneTerrain(terrain: Terrain): Terrain {
  return {
    width: terrain.width,
    height: terrain.height,
    surface: Int32Array.from(terrain.surface),
  };
}

/**
 * Generate terrain by summing a handful of sine waves with seeded random
 * amplitude, wavelength and phase — the classic "fractal ridge" look of the
 * original, and cheap enough to run inside a Durable Object.
 */
export function generateTerrain(options: TerrainOptions, rng: Rng): Terrain {
  const { width, height } = options;
  const style: TerrainStyle = options.style ?? 'rolling';
  const minGround = options.minGround ?? 0.12;
  const maxGround = options.maxGround ?? 0.72;

  const profile = STYLE_PROFILES[style];
  const octaves = profile.octaves;

  const raw = new Float64Array(width);

  // Integer-exponent powers by repeated multiplication: `Math.pow` is
  // engine-defined and therefore banned in this package (see math.ts).
  let waves = profile.baseWaves;
  let amplitude = profile.baseAmplitude;

  for (let octave = 0; octave < octaves; octave += 1) {
    if (octave > 0) {
      // Longer wavelengths carry more amplitude — 1/f-ish, like real hills.
      waves *= 2;
      amplitude /= profile.falloff;
    }
    const phase = rng.range(0, TWO_PI);
    const jitter = rng.range(0.85, 1.15);

    for (let x = 0; x < width; x += 1) {
      const t = (x / width) * TWO_PI * waves * jitter + phase;
      raw[x] = (raw[x] as number) + detSin(t) * amplitude;
    }
  }

  // Normalise to [0, 1].
  let lo = Infinity;
  let hi = -Infinity;
  for (let x = 0; x < width; x += 1) {
    const v = raw[x] as number;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;

  const surface = new Int32Array(width);
  const groundBand = maxGround - minGround;

  for (let x = 0; x < width; x += 1) {
    let normalized = ((raw[x] as number) - lo) / span;
    normalized = applyStyleShaping(normalized, x / (width - 1 || 1), style);
    // `normalized` is "how tall is the ground here" — convert to a surface Y.
    const groundFraction = minGround + normalized * groundBand;
    surface[x] = Math.round(height * (1 - groundFraction));
  }

  return { width, height, surface };
}

interface StyleProfile {
  octaves: number;
  baseWaves: number;
  baseAmplitude: number;
  falloff: number;
}

const STYLE_PROFILES: Record<TerrainStyle, StyleProfile> = {
  rolling: { octaves: 4, baseWaves: 1.1, baseAmplitude: 1, falloff: 2.0 },
  mountains: { octaves: 6, baseWaves: 0.8, baseAmplitude: 1, falloff: 1.7 },
  plateaus: { octaves: 3, baseWaves: 0.9, baseAmplitude: 1, falloff: 2.4 },
  valley: { octaves: 4, baseWaves: 1.0, baseAmplitude: 1, falloff: 2.1 },
  canyon: { octaves: 5, baseWaves: 1.4, baseAmplitude: 1, falloff: 1.9 },
};

/** Per-style reshaping of the normalised height curve. */
function applyStyleShaping(normalized: number, u: number, style: TerrainStyle): number {
  switch (style) {
    case 'plateaus': {
      // Quantise into terraces, then soften the steps slightly.
      const steps = 5;
      const stepped = Math.round(normalized * steps) / steps;
      return clamp(stepped * 0.75 + normalized * 0.25, 0, 1);
    }
    case 'valley': {
      // Push the middle of the map down.
      const dip = 1 - 4 * (u - 0.5) * (u - 0.5);
      return clamp(normalized * (1 - 0.55 * dip), 0, 1);
    }
    case 'canyon': {
      // Raise the edges, carve the centre.
      const centre = 1 - Math.abs(u - 0.5) * 2;
      return clamp(normalized * 0.6 + (1 - centre) * 0.4, 0, 1);
    }
    case 'mountains':
      // Emphasise peaks.
      return clamp(normalized * normalized * (3 - 2 * normalized), 0, 1);
    case 'rolling':
    default:
      return clamp(normalized, 0, 1);
  }
}

/** Is the pixel (x, y) inside solid ground? */
export function isSolid(terrain: Terrain, x: number, y: number): boolean {
  const column = Math.floor(x);
  if (column < 0 || column >= terrain.width) return false;
  if (y < 0) return false;
  if (y >= terrain.height) return true; // the floor of the world is solid
  return y >= (terrain.surface[column] as number);
}

/** Surface Y at a column, clamped to the map. */
export function surfaceAt(terrain: Terrain, x: number): number {
  const column = clamp(Math.floor(x), 0, terrain.width - 1);
  return terrain.surface[column] as number;
}

export interface CraterResult {
  /** Number of solid pixels removed — drives dirt/score effects. */
  removed: number;
  /** Inclusive column range actually touched, for partial redraws. */
  minX: number;
  maxX: number;
}

/**
 * Carve a circular crater and let the dirt above it collapse straight down.
 *
 * Mutates `terrain.surface` in place — callers that need the old terrain should
 * `cloneTerrain` first. Returns the affected range so the renderer can repaint
 * only the damaged strip.
 */
export function applyCrater(
  terrain: Terrain,
  centerX: number,
  centerY: number,
  radius: number,
): CraterResult {
  if (!(radius > 0)) return { removed: 0, minX: 0, maxX: -1 };

  const startX = Math.max(0, Math.ceil(centerX - radius));
  const endX = Math.min(terrain.width - 1, Math.floor(centerX + radius));
  if (startX > endX) return { removed: 0, minX: 0, maxX: -1 };

  let removed = 0;
  let minX = terrain.width;
  let maxX = -1;

  for (let x = startX; x <= endX; x += 1) {
    const dx = x + 0.5 - centerX;
    const halfSpanSquared = radius * radius - dx * dx;
    if (halfSpanSquared <= 0) continue;

    const halfSpan = Math.sqrt(halfSpanSquared);
    const holeTop = Math.round(centerY - halfSpan);
    const holeBottom = Math.round(centerY + halfSpan);
    if (holeBottom <= holeTop) continue;

    const surface = terrain.surface[x] as number;

    // Nothing solid inside this slice of the circle.
    if (holeBottom <= surface) continue;

    const solidStart = Math.max(surface, holeTop);
    const carved = holeBottom - solidStart;
    if (carved <= 0) continue;

    // Dirt sitting above the hole falls by exactly the amount carved out,
    // so the column's surface drops by `carved`. Clamp to the world floor.
    const newSurface = Math.min(terrain.height, surface + carved);
    const actuallyRemoved = newSurface - surface;
    if (actuallyRemoved <= 0) continue;

    terrain.surface[x] = newSurface;
    removed += actuallyRemoved;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }

  return maxX < minX ? { removed: 0, minX: 0, maxX: -1 } : { removed, minX, maxX };
}

/**
 * Raise terrain in a circular mound — used by dirt-adding weapons
 * (Dirt Ball, Dirt Clod) which the original game sells in the shop.
 */
export function applyMound(
  terrain: Terrain,
  centerX: number,
  centerY: number,
  radius: number,
): CraterResult {
  if (!(radius > 0)) return { removed: 0, minX: 0, maxX: -1 };

  const startX = Math.max(0, Math.ceil(centerX - radius));
  const endX = Math.min(terrain.width - 1, Math.floor(centerX + radius));
  if (startX > endX) return { removed: 0, minX: 0, maxX: -1 };

  let added = 0;
  let minX = terrain.width;
  let maxX = -1;

  for (let x = startX; x <= endX; x += 1) {
    const dx = x + 0.5 - centerX;
    const halfSpanSquared = radius * radius - dx * dx;
    if (halfSpanSquared <= 0) continue;

    const halfSpan = Math.sqrt(halfSpanSquared);
    const moundTop = Math.round(centerY - halfSpan);
    const surface = terrain.surface[x] as number;
    if (moundTop >= surface) continue;

    const newSurface = Math.max(0, moundTop);
    added += surface - newSurface;
    terrain.surface[x] = newSurface;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }

  return maxX < minX ? { removed: 0, minX: 0, maxX: -1 } : { removed: -added, minX, maxX };
}

/** Stable 32-bit hash of the terrain, for golden-file determinism tests. */
export function hashTerrain(terrain: Terrain): number {
  let hash = 0x811c9dc5;
  hash ^= terrain.width;
  hash = Math.imul(hash, 0x01000193);
  hash ^= terrain.height;
  hash = Math.imul(hash, 0x01000193);
  for (let x = 0; x < terrain.width; x += 1) {
    hash ^= terrain.surface[x] as number;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Serialise for storage / transport: plain array of numbers. */
export function serializeTerrain(terrain: Terrain): {
  width: number;
  height: number;
  surface: number[];
} {
  return {
    width: terrain.width,
    height: terrain.height,
    surface: Array.from(terrain.surface),
  };
}

export function deserializeTerrain(data: {
  width: number;
  height: number;
  surface: readonly number[];
}): Terrain {
  return {
    width: data.width,
    height: data.height,
    surface: Int32Array.from(data.surface),
  };
}
