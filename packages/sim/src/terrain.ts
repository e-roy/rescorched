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

import { clamp, detAtan2, detCosDeg, detSinDeg, hypot2, RAD_TO_DEG } from './math.ts';
import { makeRng, type Rng } from './rng.ts';

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
  /** Tuning for the fightability check run during generation. */
  playability?: PlayabilityOptions;
  /**
   * Set false to get the raw shaped map without the playability retry loop.
   * Only tests and tooling should do this — a live match must never be handed
   * a map nobody can fight on.
   */
  ensurePlayable?: boolean;
}

const DEFAULT_MIN_GROUND = 0.12;
const DEFAULT_MAX_GROUND = 0.72;

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

// ---------------------------------------------------------------------------
// Deterministic value noise
// ---------------------------------------------------------------------------

/**
 * Quintic smoothstep. Both the first and second derivative vanish at the ends,
 * so stacked octaves show no trace of the lattice — the tell-tale of cheap
 * noise. Built from `+ - *` only, so it is bit-identical on every engine.
 */
function smootherStep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Cubic smoothstep, for places that want a harder S than `smootherStep`. */
function smoothStep(t: number): number {
  return t * t * (3 - 2 * t);
}

function sampleLattice(lattice: Float64Array, cells: number, u: number): number {
  const t = u * cells;
  const cell = clamp(Math.floor(t), 0, cells - 1);
  const f = smootherStep(t - cell);
  const a = lattice[cell] as number;
  const b = lattice[cell + 1] as number;
  return a + (b - a) * f;
}

interface NoiseSpec {
  octaves: number;
  /** Lattice cells across the whole map at the lowest frequency. */
  baseCells: number;
  /** Amplitude multiplier per octave. Below 0.5 is smooth, above is busy. */
  persistence: number;
  /**
   * Crease the noise into ridges instead of hills. `1 - |2v-1|` has a sharp
   * maximum where v crosses a half, and that crease is what a mountain
   * silhouette is made of. Summed sines can never produce one.
   */
  ridged: boolean;
  /** Ridged only: how hard fine detail concentrates on already-high ground. */
  ridgeGain: number;
}

/**
 * Fractal (multi-octave) value noise, normalised to [0, 1].
 *
 * The ridged branch is Musgrave's ridged multifractal with the engine-defined
 * `pow()` removed: each octave is scaled by a weight derived from the previous
 * one, so peaks grow detail and valleys stay smooth.
 */
function fractalField(rng: Rng, width: number, spec: NoiseSpec): Float64Array {
  const field = new Float64Array(width);
  const weight = new Float64Array(width).fill(1);
  const span = width - 1 || 1;
  // Octaves finer than this are sub-pixel mush at any map size we ship.
  const finestCells = Math.max(spec.baseCells, Math.floor(width / 6));

  let cells = spec.baseCells;
  let amplitude = 1;

  for (let octave = 0; octave < spec.octaves; octave += 1) {
    const lattice = new Float64Array(cells + 1);
    for (let i = 0; i <= cells; i += 1) lattice[i] = rng.next();

    for (let x = 0; x < width; x += 1) {
      let v = sampleLattice(lattice, cells, x / span);
      if (spec.ridged) {
        const ridge = 1 - Math.abs(v + v - 1);
        v = ridge * (weight[x] as number);
        weight[x] = clamp(ridge * spec.ridgeGain, 0, 1);
      }
      field[x] = (field[x] as number) + v * amplitude;
    }

    amplitude *= spec.persistence;
    cells *= 2;
    if (cells > finestCells) break;
  }

  return normalizeField(field);
}

function normalizeField(field: Float64Array): Float64Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < field.length; i += 1) {
    const v = field[i] as number;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  for (let i = 0; i < field.length; i += 1) {
    field[i] = ((field[i] as number) - lo) / span;
  }
  return field;
}

// ---------------------------------------------------------------------------
// Style shaping
// ---------------------------------------------------------------------------

interface StyleProfile {
  noise: NoiseSpec;
  /** Steepest face this style's silhouette may hold, in pixels per column. */
  maxSlope: number;
}

/**
 * Steepest face any generated silhouette may hold: 3 px per column, ~72°.
 *
 * `e2e/reference/README.md` on the original: "Mountains are steep and dramatic,
 * with narrow peaks and deep valleys — much more vertical than gentle rolling
 * hills." This is the number that decides whether that is true of our maps, so
 * it wants to be as steep as the rest of the file can stand:
 *
 *  - It bans un-standable knife edges and one-column crevices outright, so
 *    every spawn has somewhere to sit no matter where placement drops it.
 *  - It stays under `MAX_BLAST_SLOPE`, so nothing generated is over the limit
 *    the destruction path holds the map to.
 *  - Steeper ground hides more tanks. That cost is paid by the retry loop, and
 *    it has to be paid in seeds, not in unfightable rounds: measured over 200
 *    raw seeds per style, 3 px/column has the playability check reject 33% of
 *    mountains, 8% of plateaus, 7% of rolling, 5% of valleys, 4% of canyons.
 *    Eight attempts turn even the mountain figure into a 1-in-7000 chance of
 *    falling back to the tame map. At 4 px/column mountains reject 70%, which
 *    is the point where the fallback starts showing up in real matches.
 *
 * This used to be 2, on the strength of a measurement that said 3 rejected 60%
 * of maps. That number was an artifact: the probe of the day sampled six powers
 * and called reachable pairs blocked five times out of six. The check it is
 * derived from now fires only shots a player could dial and agrees with
 * `simulateFlight` — see `test/terrain-playability.test.ts`, which measures both
 * directions of that agreement rather than asserting it.
 *
 * A 300 px ridge is 100 columns wide at this cap, and mountains average 1.7 px
 * of slope per column across the whole map.
 */
export const MAX_TERRAIN_SLOPE = 3;

const STYLE_PROFILES: Record<TerrainStyle, StyleProfile> = {
  rolling: {
    noise: { octaves: 5, baseCells: 3, persistence: 0.5, ridged: false, ridgeGain: 0 },
    maxSlope: MAX_TERRAIN_SLOPE,
  },
  mountains: {
    noise: { octaves: 6, baseCells: 3, persistence: 0.58, ridged: true, ridgeGain: 1.9 },
    maxSlope: MAX_TERRAIN_SLOPE,
  },
  plateaus: {
    noise: { octaves: 4, baseCells: 2, persistence: 0.46, ridged: false, ridgeGain: 0 },
    maxSlope: MAX_TERRAIN_SLOPE,
  },
  valley: {
    noise: { octaves: 5, baseCells: 3, persistence: 0.5, ridged: false, ridgeGain: 0 },
    maxSlope: MAX_TERRAIN_SLOPE,
  },
  canyon: {
    noise: { octaves: 5, baseCells: 4, persistence: 0.46, ridged: false, ridgeGain: 0 },
    maxSlope: MAX_TERRAIN_SLOPE,
  },
};

/** Per-map shaping dice. Always the same count of draws, whatever the style. */
interface ShapeParams {
  terraceSteps: number;
  terraceRiser: number;
  slotU: number;
  slotHalf: number;
  tilt: number;
}

function drawShapeParams(rng: Rng): ShapeParams {
  return {
    terraceSteps: rng.int(4, 7),
    terraceRiser: rng.range(0.3, 0.45),
    slotU: rng.range(0.4, 0.6),
    slotHalf: rng.range(0.11, 0.16),
    tilt: rng.range(-0.12, 0.12),
  };
}

/**
 * Quantise into terraces with flat treads and short, steep risers.
 * Rounding alone gives soft steps; the riser window is what makes a plateau
 * read as a plateau.
 */
function terrace(n: number, steps: number, riser: number): number {
  const scaled = n * steps;
  const level = Math.floor(scaled);
  const f = scaled - level;
  const t = clamp((f - (1 - riser)) / riser, 0, 1);
  return clamp((level + smoothStep(t)) / steps, 0, 1);
}

/** Map normalised noise to "how tall is the ground here", 0..1, per style. */
function shapeColumn(n: number, u: number, style: TerrainStyle, params: ShapeParams): number {
  switch (style) {
    case 'plateaus':
      return terrace(n, params.terraceSteps, params.terraceRiser);

    case 'valley': {
      // Quadratic bowl: low and open in the middle, shouldered at both ends.
      const d = Math.abs(u + u - 1);
      const bowl = d * d;
      return clamp(0.05 + n * (0.18 + 0.6 * bowl) + 0.16 * bowl, 0, 1);
    }

    case 'canyon': {
      // A mesa with one deep slot cut through it. The quintic wall gives a flat
      // floor and a flat rim with the drop concentrated in between.
      const d = clamp(Math.abs(u - params.slotU) / params.slotHalf, 0, 1);
      const wall = smootherStep(d);
      const mesa = 0.55 + 0.45 * n;
      return clamp(0.08 + (mesa - 0.08) * wall, 0, 1);
    }

    case 'mountains':
      // The ridged multifractal already did the work; a mild convex push keeps
      // the peaks tall while dropping the shoulders away from them.
      return clamp(n * n * 0.35 + n * 0.65, 0, 1);

    case 'rolling':
    default:
      return clamp(n, 0, 1);
  }
}

/**
 * Clip the silhouette to a maximum slope, in place.
 *
 * Two linear passes compute `min over j of (surface[j] + slope * |x - j|)` —
 * the classic grayscale erosion by a cone — so the result is independent of
 * scan order and therefore symmetric. Only lowers ground, never raises it, so
 * nothing can escape the band the caller asked for.
 */
function limitSlope(terrain: Terrain, maxSlope: number): void {
  const { surface, width } = terrain;
  for (let x = 1; x < width; x += 1) {
    const limit = (surface[x - 1] as number) - maxSlope;
    if ((surface[x] as number) < limit) surface[x] = limit;
  }
  for (let x = width - 2; x >= 0; x -= 1) {
    const limit = (surface[x + 1] as number) - maxSlope;
    if ((surface[x] as number) < limit) surface[x] = limit;
  }
}

function shapeTerrain(options: TerrainOptions, style: TerrainStyle, rng: Rng): Terrain {
  const { width, height } = options;
  const minGround = options.minGround ?? DEFAULT_MIN_GROUND;
  const maxGround = options.maxGround ?? DEFAULT_MAX_GROUND;
  const profile = STYLE_PROFILES[style];

  const params = drawShapeParams(rng);
  const field = fractalField(rng, width, profile.noise);

  const span = width - 1 || 1;
  for (let x = 0; x < width; x += 1) {
    const u = x / span;
    const shaped = shapeColumn(field[x] as number, u, style, params);
    field[x] = clamp(shaped + params.tilt * (u - 0.5), 0, 1);
  }

  // Renormalise AFTER shaping, not before. Shaping can land a style's noise
  // peak somewhere its own profile squashes — a valley whose tallest noise sits
  // dead centre used to come out nearly flat — and stretching the finished
  // curve is what makes every map fill the whole ground band.
  normalizeField(field);

  const surface = new Int32Array(width);
  const band = maxGround - minGround;

  for (let x = 0; x < width; x += 1) {
    surface[x] = Math.round(height * (1 - (minGround + (field[x] as number) * band)));
  }

  const terrain: Terrain = { width, height, surface };
  limitSlope(terrain, profile.maxSlope);
  return terrain;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** How many reshuffles a seed gets before the safe fallback map is used. */
export const MAX_TERRAIN_ATTEMPTS = 8;

/**
 * Derive attempt N's seed from the map's base seed.
 *
 * splitmix32's finaliser: cheap, well-mixed, and — crucially — a pure function
 * of (seed, attempt), so a retry is as reproducible as the first try.
 */
function deriveSeed(seed: number, attempt: number): number {
  let x = (seed + Math.imul(attempt + 1, 0x9e3779b9)) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return (x ^ (x >>> 15)) >>> 0;
}

/**
 * Generate terrain: fractal value noise, shaped per style, then checked to be
 * fightable.
 *
 * A seed that produces a map somebody would be sealed inside — or one where no
 * shot can connect two spawns — is rejected and reshuffled with a seed derived
 * from the original. After `MAX_TERRAIN_ATTEMPTS` failures the round falls back
 * to a deliberately tame map rather than shipping an unplayable one.
 *
 * Exactly one number is drawn from `rng` regardless of how many attempts are
 * needed, so adding or removing a retry can never shift anything downstream.
 */
export function generateTerrain(options: TerrainOptions, rng: Rng): Terrain {
  const style: TerrainStyle = options.style ?? 'rolling';
  const baseSeed = rng.nextU32();

  if (options.ensurePlayable === false) {
    return shapeTerrain(options, style, makeRng(deriveSeed(baseSeed, 0)));
  }

  const probeOptions: PlayabilityOptions = { ...options.playability, stopEarly: true };

  for (let attempt = 0; attempt < MAX_TERRAIN_ATTEMPTS; attempt += 1) {
    const terrain = shapeTerrain(options, style, makeRng(deriveSeed(baseSeed, attempt)));
    if (checkPlayability(terrain, probeOptions).ok) return terrain;
  }

  return generateSafeTerrain(options, makeRng(deriveSeed(baseSeed, 0x5afe)));
}

/**
 * The fallback map: low-frequency hills inside a compressed band with a gentle
 * slope cap. It cannot contain a pit or a wall tall enough to block a lob, so
 * it is always fightable — it is just not very interesting, which is why it is
 * a last resort rather than the default.
 */
export function generateSafeTerrain(options: TerrainOptions, rng: Rng): Terrain {
  const { width, height } = options;
  const minGround = options.minGround ?? DEFAULT_MIN_GROUND;
  const maxGround = options.maxGround ?? DEFAULT_MAX_GROUND;

  const field = fractalField(rng, width, {
    octaves: 3,
    baseCells: 2,
    persistence: 0.42,
    ridged: false,
    ridgeGain: 0,
  });

  const surface = new Int32Array(width);
  const band = (maxGround - minGround) * 0.45;

  for (let x = 0; x < width; x += 1) {
    surface[x] = Math.round(height * (1 - (minGround + (field[x] as number) * band)));
  }

  const terrain: Terrain = { width, height, surface };
  limitSlope(terrain, MAX_TERRAIN_SLOPE);
  return terrain;
}

// ---------------------------------------------------------------------------
// Playability
// ---------------------------------------------------------------------------

/**
 * Ballistic constants, duplicated from `physics.ts` on purpose.
 *
 * `physics.ts` imports this module, so importing it back would create a cycle
 * whose evaluation order depends on the bundler — exactly the kind of thing
 * that works in Vitest and breaks in workerd. The probe only ever needs the
 * windless case, so the numbers live here, and they are exported purely so
 * `test/terrain-playability.test.ts` can assert field by field that they still
 * match `PHYSICS` — a test that compared `PHYSICS` against its own local copies
 * of the literals could not.
 *
 * `maxSteps` is the one deliberate difference: `PHYSICS.maxSteps` is 3600, six
 * seconds of flight, sized for a shot lobbed off the top of the screen in low
 * gravity. The probe fires no such shot — it aims at a point 1280 px away at
 * most, which is under four seconds even on the highest arc power 100 can hold
 * — so 1200 steps is the same budget with the unreachable tail cut off.
 */
export const PROBE = {
  gravity: 260,
  dt: 1 / 60,
  powerScale: 5.2,
  maxSubSteps: 64,
  maxSteps: 1200,
  offscreenMargin: 400,
} as const;

/**
 * Lowest power the probe bothers with.
 *
 * It walks every integer power from 100 down to here, strongest first, because
 * power is one of the two dials a player has and it is an integer. The six-value
 * grid this replaced ([100, 88, 76, 64, 52, 40]) is what made a `blocked`
 * verdict meaningless: at mid range consecutive entries are about nine degrees
 * of launch angle apart, so whole families of arcs fell between them. Six pairs
 * that grid called blocked were every one of them reachable by the real
 * `simulateFlight` — the worst missing by 1.9 px against a Baby Missile's 18 px
 * radius, one of them at angle 65 power 93, a power the grid never tried.
 * Powers too low to reach the target at all cost nothing: `vacuumAim` returns no
 * solutions for them, so the floor here only exists to stop the loop grinding
 * through the last few that never could.
 */
const PROBE_MIN_POWER = 10;

/** Launch angles used by the "can I even shoot out of here?" probe. */
const ESCAPE_ANGLES: readonly number[] = [35, 50, 65, 78];

export interface PlayabilityOptions {
  /** Columns to treat as tank spawns. Default: `defaultSpawnColumns(width)`. */
  spawns?: readonly number[];
  /** Minimum sky above a spawn, in pixels. */
  minHeadroom?: number;
  /** Half-width of the window the footing check looks at, in columns. */
  footprint?: number;
  /** Largest height difference allowed across that window. */
  maxFootingDrop?: number;
  /** How far a shot must be able to travel for a spawn to count as un-sealed. */
  minEscapeDistance?: number;
  /** How close a probe must go off to the target to count as a hit. */
  hitTolerance?: number;
  /** Height of the muzzle above the tank's feet. */
  muzzleHeight?: number;
  /** Stop at the first problem found. Cheaper; used by the generator. */
  stopEarly?: boolean;
}

export const PLAYABILITY_DEFAULTS = {
  minHeadroom: 60,
  footprint: 5,
  maxFootingDrop: 44,
  minEscapeDistance: 150,
  /**
   * The Baby Missile's blast radius, from `weapons.ts`. The cheapest weapon in
   * the game — the one every tank has infinite rounds of — is the right bar:
   * "reachable" has to mean reachable with the gun you always have, not with a
   * Nuke. It is not a fudge factor for probe error either, now that the aim is
   * corrected for the integrator's sag; it is the real damage radius, compared
   * against where the probe's shell really goes off.
   */
  hitTolerance: 18,
  muzzleHeight: 11,
} as const;

export type PlayabilityIssueKind =
  /** No room above the tank to fire at all. */
  | 'headroom'
  /** The ground under the tank is a cliff face, not a place to stand. */
  | 'footing'
  /** Walled in: no shot from here gets anywhere. */
  | 'sealed'
  /** No angle/power connects this spawn to that one. */
  | 'blocked';

export interface PlayabilityIssue {
  kind: PlayabilityIssueKind;
  /** The spawn column the problem was found at. */
  column: number;
  /** The spawn that could not be reached, for `blocked`. */
  target?: number;
}

export interface PlayabilityReport {
  ok: boolean;
  issues: PlayabilityIssue[];
  spawns: readonly number[];
}

/**
 * Widest lobby the game can be handed: `packages/protocol` caps the player
 * array at 16. Mirrored rather than imported — `packages/sim` deliberately
 * depends on nothing — and it matters here because a 16-tank match has the
 * narrowest margins and therefore the widest spawn band.
 */
const MAX_TANKS = 16;

/**
 * The window `game.ts` can drop a tank in at one player count.
 *
 * Replays `placeTanks`: `margin = min(90, floor(width / (count + 2)))`, slots of
 * `(width - 2 * margin) / count`, and jitter uniform in `[0.2, 0.8)` of a slot.
 * So the leftmost tank never starts before `margin + 0.2 * slot` and, by the
 * symmetry of that expression, the rightmost never ends past the mirror of it.
 *
 * A copy, because `game.ts` imports this file. `test/terrain-playability.test.ts`
 * does not trust the copy: it runs `createGame` for every supported player count
 * and checks the real tank positions land inside the band, so a change to
 * placement breaks the test rather than silently un-covering the map.
 */
function placementBand(width: number, count: number): { lo: number; hi: number } {
  const margin = Math.min(90, Math.floor(width / (count + 2)));
  const inset = margin + ((width - margin * 2) / count) * 0.2;
  return { lo: clamp(inset, 4, width - 5), hi: clamp(width - inset, 4, width - 5) };
}

/** The union of every player count's placement band, in whole columns. */
export function spawnBand(width: number): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (let count = 1; count <= MAX_TANKS; count += 1) {
    const band = placementBand(width, count);
    if (band.lo < lo) lo = band.lo;
    if (band.hi > hi) hi = band.hi;
  }
  return {
    lo: clamp(Math.floor(lo), 0, width - 1),
    hi: clamp(Math.ceil(hi), 0, width - 1),
  };
}

/**
 * Columns a tank could plausibly be dropped on.
 *
 * Sampled across the whole span `game.ts` can place a tank in, at any player
 * count from 1 to `MAX_TANKS` — at 1280 wide that is columns 85 to 1195, which
 * is wider than the middle 80% this used to assume and which a 16-player lobby
 * really does reach. Sampling the band is what lets the check make a promise
 * about spawns it does not get to choose; sampling a band the game can place
 * outside of would have made that promise a lie at exactly the edges of the map,
 * where the ground is least reliable.
 */
export function defaultSpawnColumns(width: number, count = 7): number[] {
  const { lo, hi } = spawnBand(width);
  if (count <= 1) return [Math.round((lo + hi) / 2)];
  const step = (hi - lo) / (count - 1);
  const columns: number[] = [];
  for (let i = 0; i < count; i += 1) columns.push(Math.round(lo + step * i));
  return columns;
}

interface ProbeOutcome {
  /** The shell would have gone off close enough to the aim point to matter. */
  reached: boolean;
  /** Horizontal distance covered before the shot stopped. */
  travelled: number;
}

/**
 * Radius inside which a shell detonates on the tank itself rather than flying
 * on. `DEFAULT_WORLD.tankRadius` in `game.ts`; mirrored for the same
 * import-cycle reason as `PROBE`, and asserted against it in the tests.
 */
export const PROBE_TANK_RADIUS = 9;

/**
 * Fly one shell with no wind and report what became of it.
 *
 * Same integrator and same swept collision test as `physics.ts`, so "the check
 * says this shot connects" means the real engine agrees.
 * `tolerance <= 0` disables the target test and turns this into a pure
 * "how far did it get" measurement.
 *
 * Two ways to count as connected, and they are the only two ways a shell hurts
 * anybody in this game: fly into the tank (within `PROBE_TANK_RADIUS` — the
 * real engine's tank hit circle), or go off in the dirt within `tolerance` of
 * where it stands. What this deliberately does NOT count is an arc that merely
 * passes near the tank on its way to landing somewhere else entirely, which is
 * what the old "closest approach along the path" test accepted: on the accepted
 * maps it waved through three pairs in 433 that no angle and power in the
 * player's whole 179x100 grid can actually hit.
 */
function probeShot(
  terrain: Terrain,
  startX: number,
  startY: number,
  vx: number,
  vy0: number,
  targetX: number,
  targetY: number,
  tolerance: number,
): ProbeOutcome {
  let x = startX;
  let y = startY;
  let vy = vy0;
  const testTarget = tolerance > 0;
  const directSquared = PROBE_TANK_RADIUS * PROBE_TANK_RADIUS;
  const tolSquared = tolerance * tolerance;

  for (let step = 0; step < PROBE.maxSteps; step += 1) {
    vy += PROBE.gravity * PROBE.dt;
    const nextX = x + vx * PROBE.dt;
    const nextY = y + vy * PROBE.dt;

    const dx = nextX - x;
    const dy = nextY - y;
    const samples = clamp(Math.ceil(hypot2(dx, dy)), 1, PROBE.maxSubSteps);

    for (let i = 1; i <= samples; i += 1) {
      const t = i / samples;
      const px = x + dx * t;
      const py = y + dy * t;
      const ex = px - targetX;
      const ey = py - targetY;
      const offSquared = ex * ex + ey * ey;

      if (testTarget && offSquared <= directSquared) {
        return { reached: true, travelled: Math.abs(px - startX) };
      }
      if (isSolid(terrain, px, py)) {
        return {
          reached: testTarget && offSquared <= tolSquared,
          travelled: Math.abs(px - startX),
        };
      }
    }

    x = nextX;
    y = nextY;

    if (
      x < -PROBE.offscreenMargin ||
      x > terrain.width + PROBE.offscreenMargin ||
      y > terrain.height + PROBE.offscreenMargin
    ) {
      break;
    }
  }

  return { reached: false, travelled: Math.abs(x - startX) };
}

/**
 * The launch velocities that put a shell on a target `dx, dy` away at a given
 * speed in a vacuum — high arc first, because a high arc clears terrain a flat
 * one cannot.
 */
function vacuumAim(dx: number, dy: number, speed: number): { vx: number; vy: number }[] {
  const range = Math.abs(dx);
  if (range < 1) return [];

  const g = PROBE.gravity;
  const rise = -dy; // screen Y grows downward
  const vSquared = speed * speed;
  const disc = vSquared * vSquared - g * (g * range * range + 2 * rise * vSquared);
  if (disc < 0) return []; // out of range at this speed

  const root = Math.sqrt(disc);
  const direction = dx < 0 ? -1 : 1;
  const solutions: { vx: number; vy: number }[] = [];

  for (const tangent of [(vSquared + root) / (g * range), (vSquared - root) / (g * range)]) {
    // A negative tangent means firing below the horizon, which the UI's
    // 0..180 degree range does not allow.
    if (!(tangent > 0)) continue;
    const vx = (direction * speed) / Math.sqrt(1 + tangent * tangent);
    solutions.push({ vx, vy: -Math.abs(vx) * tangent });
  }
  return solutions;
}

/**
 * The same aim as launch angles in degrees, corrected for the integrator the
 * game actually flies shells with. High arc first.
 *
 * Semi-implicit Euler updates velocity before position, so after n steps the
 * shell has fallen `g·dt²·n(n+1)/2` instead of `g·t²/2` — it sags below the
 * vacuum parabola by `g·dt·t/2`, about 8 px over a 3.6 second flight. Small,
 * and it looked like something a fat hit tolerance could absorb. It is not,
 * because the miss it causes is measured along the ground: aim a shell 8 px low
 * into a descending face and the impact point walks tens of pixels down the
 * slope, or clips the near lip of a ridge the true arc would have cleared. That
 * is how the probe came to call reachable pairs blocked.
 *
 * One correction step is enough — the sag depends on flight time, flight time
 * barely moves when the aim point shifts 8 px, and the residual is under a
 * pixel.
 */
function aimAngles(dx: number, dy: number, speed: number): number[] {
  const first = vacuumAim(dx, dy, speed);
  const angles: number[] = [];

  for (let i = 0; i < first.length; i += 1) {
    const solution = first[i] as { vx: number; vy: number };
    const flight = Math.abs(dx / solution.vx);
    const sag = (PROBE.gravity * PROBE.dt * flight) / 2;
    // Aim that much higher (smaller Y). Same branch index: raising the aim
    // point never reorders high arc and low arc.
    const refined = vacuumAim(dx, dy - sag, speed)[i] ?? solution;
    angles.push(detAtan2(-refined.vy, refined.vx) * RAD_TO_DEG);
  }
  return angles;
}

/**
 * Is there any angle and power that lands a shell on the far tank?
 *
 * Strongest power first, and within a power the high arc first, because that is
 * the arc that clears the most terrain — so a pair that is obviously fine costs
 * one or two probes and only a genuinely walled-off pair pays for the sweep.
 *
 * Every shot fired here is one a player could dial: an integer power, and the
 * whole degree either side of the computed angle. Firing the real-valued ideal
 * angle instead is what let the check bless pairs whose only solution was
 * between two of the player's clicks.
 */
function hasLineOfFire(
  terrain: Terrain,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  tolerance: number,
): boolean {
  const dx = toX - fromX;
  const dy = toY - fromY;

  for (let power = 100; power >= PROBE_MIN_POWER; power -= 1) {
    const speed = power * PROBE.powerScale;
    for (const ideal of aimAngles(dx, dy, speed)) {
      const low = Math.floor(ideal);
      const high = Math.ceil(ideal);
      for (let angle = low; angle <= high; angle += 1) {
        if (angle < 1 || angle > 179) continue;
        const vx = detCosDeg(angle) * speed;
        const vy = -detSinDeg(angle) * speed;
        if (probeShot(terrain, fromX, fromY, vx, vy, toX, toY, tolerance).reached) return true;
      }
    }
  }
  return false;
}

/**
 * Is this pair close enough that failing to connect must be the terrain's
 * fault?
 *
 * Deliberately measured at power 80, not 100. The gun's flat-ground reach is
 * about 1040 px and the map is 1280 wide, so the outermost spawns sit right on
 * the edge of what full power can do — those pairs miss because the shell runs
 * out of energy, not because a hill is in the way, and failing a map for that
 * would reject almost every seed. The ~665 px of headroom this leaves is what
 * keeps the rejection rate low enough for the retry loop to absorb.
 */
const RANGE_GATE_POWER = 80;

function withinBallisticRange(dx: number, dy: number): boolean {
  return vacuumAim(dx, dy, RANGE_GATE_POWER * PROBE.powerScale).length > 0;
}

/** Can a tank here put a shell anywhere at all, or is it walled in? */
function canShootOut(terrain: Terrain, x: number, y: number, minDistance: number): boolean {
  for (const power of [100, 75]) {
    const speed = power * PROBE.powerScale;
    for (const angle of ESCAPE_ANGLES) {
      for (const direction of [1, -1]) {
        const vx = detCosDeg(angle) * speed * direction;
        const vy = -detSinDeg(angle) * speed;
        if (probeShot(terrain, x, y, vx, vy, 0, 0, 0).travelled >= minDistance) return true;
      }
    }
  }
  return false;
}

/**
 * Is this map fightable?
 *
 * Four questions, in increasing order of cost:
 *   1. Is there sky above every spawn?
 *   2. Is the ground under every spawn something a tank can stand on?
 *   3. Can a tank at every spawn get a shell out of its own hole?
 *   4. Can every pair of spawns that is within ballistic range hit each other?
 *
 * Pairs that are simply too far apart for full power are excluded: that is a
 * limit of the gun, not a defect of the map.
 */
export function checkPlayability(
  terrain: Terrain,
  options: PlayabilityOptions = {},
): PlayabilityReport {
  const spawns = options.spawns ?? defaultSpawnColumns(terrain.width);
  const minHeadroom = options.minHeadroom ?? PLAYABILITY_DEFAULTS.minHeadroom;
  const footprint = options.footprint ?? PLAYABILITY_DEFAULTS.footprint;
  const maxFootingDrop = options.maxFootingDrop ?? PLAYABILITY_DEFAULTS.maxFootingDrop;
  const minEscape = options.minEscapeDistance ?? PLAYABILITY_DEFAULTS.minEscapeDistance;
  const tolerance = options.hitTolerance ?? PLAYABILITY_DEFAULTS.hitTolerance;
  const muzzleHeight = options.muzzleHeight ?? PLAYABILITY_DEFAULTS.muzzleHeight;
  const stopEarly = options.stopEarly === true;

  const issues: PlayabilityIssue[] = [];
  const done = (): boolean => stopEarly && issues.length > 0;

  for (const column of spawns) {
    const ground = surfaceAt(terrain, column);

    if (ground < minHeadroom) {
      issues.push({ kind: 'headroom', column });
      if (done()) return { ok: false, issues, spawns };
      continue;
    }

    let lowest = ground;
    let highest = ground;
    for (let offset = -footprint; offset <= footprint; offset += 1) {
      const y = surfaceAt(terrain, column + offset);
      if (y < highest) highest = y;
      if (y > lowest) lowest = y;
    }
    if (lowest - highest > maxFootingDrop) {
      issues.push({ kind: 'footing', column });
      if (done()) return { ok: false, issues, spawns };
      continue;
    }

    if (!canShootOut(terrain, column, ground - muzzleHeight, minEscape)) {
      issues.push({ kind: 'sealed', column });
      if (done()) return { ok: false, issues, spawns };
    }
  }

  for (let i = 0; i < spawns.length; i += 1) {
    for (let j = 0; j < spawns.length; j += 1) {
      if (i === j) continue;
      const from = spawns[i] as number;
      const to = spawns[j] as number;
      const fromY = surfaceAt(terrain, from) - muzzleHeight;
      const toY = surfaceAt(terrain, to);
      if (!withinBallisticRange(to - from, toY - fromY)) continue;

      if (!hasLineOfFire(terrain, from, fromY, to, toY, tolerance)) {
        issues.push({ kind: 'blocked', column: from, target: to });
        if (done()) return { ok: false, issues, spawns };
      }
    }
  }

  return { ok: issues.length === 0, issues, spawns };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Destruction
// ---------------------------------------------------------------------------

export interface CraterResult {
  /**
   * Net solid pixels removed — drives dirt/score effects. Negative when dirt
   * was added. Counts the slump too, so it is the true change in the amount of
   * ground in the world and not just what the blast itself cut out.
   */
  removed: number;
  /** Inclusive column range actually touched, for partial redraws. */
  minX: number;
  maxX: number;
  /**
   * Relaxation passes the slump needed. Zero means nothing was over-steep.
   * Exposed so `test/terrain-slump.test.ts` can assert the loop exits because
   * the dirt stopped moving rather than because it ran out of budget.
   */
  slumpPasses: number;
}

const NO_CHANGE: CraterResult = { removed: 0, minX: 0, maxX: -1, slumpPasses: 0 };

/**
 * How deep a crater bites, as a multiple of the blast radius.
 *
 * A shell stops at the FIRST solid pixel it touches, so a crater cut as a plain
 * circle only ever removes its lower half: a Baby Missile took a nine-pixel
 * nick out of a 720-pixel-tall map, which players genuinely could not see. At
 * 1.5 the same shot leaves a bowl 27 deep and 36 wide — about three tank
 * heights — which reads instantly.
 */
const CRATER_DEPTH = 1.5;

/**
 * Steepest face blast-loosened dirt will hold, in pixels per column (~79°).
 *
 * This is the invariant the whole destruction path is built to preserve:
 *
 *     terrain within the bound + any number of craters and mounds
 *       => terrain still within the bound
 *
 * — which is what stops shell after shell into one column from drilling a
 * one-column well nobody can climb out of. Measured over twelve Baby Missiles
 * into the same spot, the hole goes from 27 px deeper per shot to 13 and widens
 * from 26 columns to 48; over forty, the steepest surviving face is still 5.
 *
 * The precondition is not decoration. No local, mass-conserving rule can pull
 * an arbitrary map under the bound: on a uniformly over-steep ramp every
 * interior column receives exactly as much dirt from above as it sheds below,
 * so only the two ends of the ramp can ever move, and flattening the middle
 * would mean hauling dirt the length of the map — which is not what an
 * explosion does. Generated terrain is capped at `MAX_TERRAIN_SLOPE`, well
 * under this, so the induction starts true and every blast keeps it true.
 * `test/terrain-slump.test.ts` asserts both halves.
 */
export const MAX_BLAST_SLOPE = 5;

/**
 * Half-height of the blast cavity at horizontal offset `dx`.
 *
 * A parabola, not a circle: it tapers to nothing at the rim, so the crater
 * blends into the ground instead of ending in a cliff, and its steepest step is
 * a constant `2 * CRATER_DEPTH` (3) px/column at any radius rather than the
 * vertical wall a circle ends on. That does NOT mean a fresh crater is always
 * left as it was carved: 3 laid on top of `MAX_TERRAIN_SLOPE` (3) plus rounding
 * composes to 7, and 15 of 180 single detonations on generated ground used to
 * leave a 6 or 7 px face standing. They now slump like any other, which is why
 * `applyCrater` runs the slump unconditionally instead of only for repeat hits.
 */
function craterHalfSpan(dx: number, radius: number): number {
  const q = dx / radius;
  const bowl = 1 - q * q;
  return bowl <= 0 ? 0 : radius * CRATER_DEPTH * bowl;
}

/**
 * Carve a crater and let the dirt above it collapse straight down.
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
  if (!(radius > 0)) return NO_CHANGE;

  const startX = Math.max(0, Math.ceil(centerX - radius));
  const endX = Math.min(terrain.width - 1, Math.floor(centerX + radius));
  if (startX > endX) return NO_CHANGE;

  let removed = 0;
  let minX = terrain.width;
  let maxX = -1;

  for (let x = startX; x <= endX; x += 1) {
    const halfSpan = craterHalfSpan(x + 0.5 - centerX, radius);
    if (halfSpan <= 0) continue;

    const holeTop = Math.round(centerY - halfSpan);
    const holeBottom = Math.round(centerY + halfSpan);
    if (holeBottom <= holeTop) continue;

    const surface = terrain.surface[x] as number;

    // Nothing solid inside this slice of the cavity.
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

  if (maxX < minX) return NO_CHANGE;

  const slumped = slumpBlast(terrain, minX, maxX);
  return {
    removed: removed + slumped.netClamp,
    minX: slumped.minX,
    maxX: slumped.maxX,
    slumpPasses: slumped.passes,
  };
}

/**
 * Hard stop on slump iterations — a liveness guard, not a tuning knob.
 *
 * The relaxation below always terminates on its own (every transfer strictly
 * reduces the sum of squared column heights, which is bounded below at fixed
 * mass), so this only decides how bad an input has to be before the sim gives
 * up rather than hangs. Worst case actually measured, sweeping every weapon
 * radius against four ground heights at the world size the game ships: 1210
 * passes, from sixty Death's Heads down one column of ground sitting near the
 * top of a 720 px world — the deepest, widest pit the map can hold. Realistic
 * abuse is far cheaper: forty Baby Missiles into one spot peaks at 218, and a
 * single detonation on generated ground at 592. This leaves 3x headroom over
 * the worst of those, and `test/terrain-slump.test.ts` asserts the margin, so a
 * rule change that quietly stopped converging fails there instead of silently
 * leaving a cliff behind.
 */
export const MAX_SLUMP_PASSES = 4096;

/** How far the slump window jumps outward when dirt reaches its own edge. */
const SLUMP_WINDOW_GROWTH = 8;

interface SlumpResult {
  minX: number;
  maxX: number;
  /**
   * Net surface change forced by the top and bottom of the world. Transfers
   * conserve mass exactly, so this is the only way a slump can change how much
   * ground exists, and `removed` has to account for it.
   */
  netClamp: number;
  passes: number;
}

/** Move a column by `delta`, clamped to the world. Returns what the clamp ate. */
function settleColumn(surface: Int32Array, x: number, delta: number, height: number): number {
  const wanted = (surface[x] as number) + delta;
  const applied = clamp(wanted, 0, height);
  surface[x] = applied;
  return applied - wanted;
}

/**
 * Let over-steep faces around a fresh crater or mound fall in.
 *
 * Mass-conserving: every transfer takes exactly as much dirt off the high
 * column as it puts on the low one, and a face is only ever levelled TO the
 * limit — half the excess off the top, half onto the bottom — so two columns
 * can never swap places and oscillate.
 *
 * Order matters twice, which is why the sweep is shaped the way it is rather
 * than being a plain left-to-right scan or a Jacobi snapshot:
 *
 *  - Faces are relaxed in mirrored pairs about the blast centre, and the two
 *    pairs at the same distance never share a column, so a symmetric hole
 *    slumps to a bit-identically symmetric result. (A Jacobi snapshot is also
 *    symmetric, but it cancels: on any run of equally over-steep faces the
 *    dirt a column receives from above exactly matches what it sheds below, so
 *    only the two ends of the run move and the middle sits there. That is what
 *    left 7 px/column standing after twelve Baby Missiles and burned the whole
 *    pass budget doing it.)
 *  - Each pass sweeps inward first, then outward. Inward is the direction dirt
 *    actually falls, and relaxing the outermost face first lets one sweep carry
 *    a slide the whole way to the bottom instead of one column per pass;
 *    outward is the direction an undercut rim recedes. Forty Baby Missiles into
 *    one column settle in 218 passes this way; the Jacobi rule needed 853 to
 *    reach the same state, which is why a 400-pass budget hid the bug rather
 *    than tripping over it.
 *
 * The window starts at the blast and grows outward whenever dirt reaches its
 * own edge. A fixed window looked cheaper but was wrong: it piled the run-out
 * against the boundary and left a cliff exactly where it was supposed to
 * prevent one.
 */
function slumpBlast(terrain: Terrain, minX: number, maxX: number): SlumpResult {
  const { surface, width, height } = terrain;
  let left = Math.max(0, minX - 1);
  let right = Math.min(width - 1, maxX + 1);
  if (right - left < 1) return { minX, maxX, netClamp: 0, passes: 0 };

  let steepest = 0;
  for (let x = left; x < right; x += 1) {
    const step = Math.abs((surface[x + 1] as number) - (surface[x] as number));
    if (step > steepest) steepest = step;
  }
  if (steepest <= MAX_BLAST_SLOPE) return { minX, maxX, netClamp: 0, passes: 0 };

  // The face the blast is centred on. Mirroring about it is what makes the
  // result symmetric: face `pivot - k` and face `pivot + k` are reflections of
  // each other for the symmetric touched range a crater produces.
  const pivot = clamp(Math.floor((minX + maxX - 1) / 2), 0, width - 2);

  let touchedLo = minX;
  let touchedHi = maxX;
  let netClamp = 0;
  let moved: boolean;
  let passes = 0;

  /** Level face (p, p + 1) to the limit if it is over it. */
  const relax = (p: number): void => {
    if (p < left || p >= right) return;
    // Positive `drop` means column p stands higher than column p + 1.
    const drop = (surface[p + 1] as number) - (surface[p] as number);
    const excess = Math.abs(drop) - MAX_BLAST_SLOPE;
    if (excess <= 0) return;

    // Rounded up, not down: at excess 1 rounding down would move nothing and
    // the face would stand for ever.
    const transfer = Math.ceil(excess / 2);
    const step = drop > 0 ? transfer : -transfer;
    netClamp += settleColumn(surface, p, step, height);
    netClamp += settleColumn(surface, p + 1, -step, height);

    moved = true;
    if (p < touchedLo) touchedLo = p;
    if (p + 1 > touchedHi) touchedHi = p + 1;
    if (p === left) left = Math.max(0, left - SLUMP_WINDOW_GROWTH);
    if (p + 1 === right) right = Math.min(width - 1, right + SLUMP_WINDOW_GROWTH);
  };

  for (let pass = 0; pass < MAX_SLUMP_PASSES; pass += 1) {
    passes = pass + 1;
    moved = false;

    for (let k = Math.max(pivot - left, right - pivot); k >= 1; k -= 1) {
      relax(pivot - k);
      relax(pivot + k);
    }
    relax(pivot);
    // Recomputed each step, so a window that grew mid-sweep is swept this pass.
    for (let k = 1; k <= Math.max(pivot - left, right - pivot); k += 1) {
      relax(pivot - k);
      relax(pivot + k);
    }

    if (!moved) break;
  }

  return { minX: touchedLo, maxX: touchedHi, netClamp, passes };
}

/**
 * How tall a mound stands above its base, as a multiple of the blast radius.
 *
 * The dome is a parabola for the same reason the crater is: its steepest step
 * is a constant `2 * MOUND_HEIGHT` px/column at any radius. A circular cap —
 * what this used to be — is vertical at the rim, and measured on flat ground it
 * built a lip of 3 px/column at radius 10 rising to 8 at radius 70. Nothing in
 * the file bounded that, nothing slumped it, and `weapons.ts` ships Ton of Dirt
 * at radius 70.
 */
const MOUND_HEIGHT = 1;

function moundHalfSpan(dx: number, radius: number): number {
  const q = dx / radius;
  const dome = 1 - q * q;
  return dome <= 0 ? 0 : radius * MOUND_HEIGHT * dome;
}

/**
 * Raise terrain in a mound — used by the dirt-adding weapons (Dirt Clod, Dirt
 * Ball, Ton of Dirt) the original game sells in the shop.
 *
 * Slumped exactly like a crater, so a player who drops eight Dirt Balls on one
 * column gets a hill with `MAX_BLAST_SLOPE` sides rather than a 461 px vertical
 * tower — which is both what dirt does and what keeps the rest of the map's
 * invariants true after someone has been landscaping.
 */
export function applyMound(
  terrain: Terrain,
  centerX: number,
  centerY: number,
  radius: number,
): CraterResult {
  if (!(radius > 0)) return NO_CHANGE;

  const startX = Math.max(0, Math.ceil(centerX - radius));
  const endX = Math.min(terrain.width - 1, Math.floor(centerX + radius));
  if (startX > endX) return NO_CHANGE;

  let added = 0;
  let minX = terrain.width;
  let maxX = -1;

  for (let x = startX; x <= endX; x += 1) {
    const halfSpan = moundHalfSpan(x + 0.5 - centerX, radius);
    if (halfSpan <= 0) continue;

    const moundTop = Math.round(centerY - halfSpan);
    const surface = terrain.surface[x] as number;
    if (moundTop >= surface) continue;

    const newSurface = Math.max(0, moundTop);
    added += surface - newSurface;
    terrain.surface[x] = newSurface;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }

  if (maxX < minX) return NO_CHANGE;

  const slumped = slumpBlast(terrain, minX, maxX);
  return {
    removed: -added + slumped.netClamp,
    minX: slumped.minX,
    maxX: slumped.maxX,
    slumpPasses: slumped.passes,
  };
}

// ---------------------------------------------------------------------------
// Hashing and serialisation
// ---------------------------------------------------------------------------

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
