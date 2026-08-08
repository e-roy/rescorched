/**
 * The fightability guarantee.
 *
 * The bug this exists to kill: rounds where a tank spawned in a pit it could
 * not shoot out of, or behind a mountain that made its opponent unreachable at
 * every angle and power. `checkPlayability` is the machine-checkable statement
 * of "this map is worth playing on", and `generateTerrain` refuses to hand back
 * a map that fails it.
 *
 * A check like this is only worth what its verdicts are worth, so two of the
 * tests below do not test the check against itself: they brute-force the real
 * `simulateFlight` over the player's entire 179 x 100 grid of angles and powers
 * and compare. One measures how often a `blocked` verdict is wrong, the other
 * how often a pass is. Both used to be unmeasured, and `blocked` was wrong five
 * times out of six.
 */

import { describe, expect, it } from 'vitest';
import {
  checkPlayability,
  defaultSpawnColumns,
  emptyTerrain,
  generateSafeTerrain,
  generateTerrain,
  hashTerrain,
  PLAYABILITY_DEFAULTS,
  PROBE,
  PROBE_TANK_RADIUS,
  spawnBand,
  surfaceAt,
  TERRAIN_STYLES,
  type Terrain,
  type TerrainStyle,
} from '../src/terrain.ts';
import { PHYSICS, simulateFlight } from '../src/physics.ts';
import { createGame, DEFAULT_WORLD, type PlayerSeed } from '../src/game.ts';
import { makeRng } from '../src/rng.ts';
import { requireWeapon } from '../src/weapons.ts';

const WIDTH = 1280;
const HEIGHT = 720;
const MUZZLE = PLAYABILITY_DEFAULTS.muzzleHeight;

/**
 * How many of the player's own (angle, power) combinations put a Baby Missile
 * on the tank at `to`, and how close the best of them gets.
 *
 * Fired exactly as a match fires them: integer angle, integer power, no wind,
 * both tanks present as hit circles so a shell that flies into the target goes
 * off on it rather than sailing through where a tank is standing.
 */
function connections(terrain: Terrain, from: number, to: number): { hits: number; best: number } {
  const fromY = surfaceAt(terrain, from) - MUZZLE;
  const toY = surfaceAt(terrain, to);
  const radius = DEFAULT_WORLD.tankRadius;
  const targets = [
    { x: from, y: fromY, radius, ignore: true },
    { x: to, y: toY - radius, radius },
  ];
  const blast = requireWeapon('baby_missile').radius;

  let hits = 0;
  let best = Infinity;
  for (let angle = 1; angle <= 179; angle += 1) {
    for (let power = 1; power <= 100; power += 1) {
      const shot = simulateFlight(
        { x: from, y: fromY, angleDeg: angle, power },
        { terrain, wind: 0, targets },
      );
      const miss =
        shot.impact.kind === 'tank' && shot.impact.tankIndex === 1
          ? 0
          : Math.hypot(shot.impact.x - to, shot.impact.y - toY);
      if (miss < best) best = miss;
      if (miss <= blast) hits += 1;
    }
  }
  return { hits, best };
}

/** Every pair the check judges — the ones it skips as out of range are excluded. */
function judgedPairs(terrain: Terrain, spawns: readonly number[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < spawns.length; i += 1) {
    for (let j = 0; j < spawns.length; j += 1) {
      if (i === j) continue;
      const from = spawns[i] as number;
      const to = spawns[j] as number;
      // `withinBallisticRange` is private; it gates on whether power 80 can
      // reach, which is what this reproduces.
      const dy = surfaceAt(terrain, to) - (surfaceAt(terrain, from) - MUZZLE);
      const speed = 80 * PROBE.powerScale;
      const v2 = speed * speed;
      const range = Math.abs(to - from);
      const disc = v2 * v2 - PROBE.gravity * (PROBE.gravity * range * range - 2 * dy * v2);
      if (disc >= 0) pairs.push([from, to]);
    }
  }
  return pairs;
}

function firstRejectedSeed(style: TerrainStyle): number {
  for (let seed = 0; seed < 200; seed += 1) {
    const raw = generateTerrain(
      { width: WIDTH, height: HEIGHT, style, ensurePlayable: false },
      makeRng(seed),
    );
    if (!checkPlayability(raw).ok) return seed;
  }
  throw new Error(`no seed under 200 produces a rejected ${style} map`);
}

describe('the probe agrees with the real engine', () => {
  it('uses exactly the ballistic constants physics.ts uses', () => {
    // terrain.ts cannot import physics.ts (physics imports terrain, and the
    // cycle's evaluation order is bundler-dependent), so the probe carries its
    // own copy. Asserted field against field, not against local literals
    // restating the same numbers twice: this has to fail if someone retunes the
    // gun and forgets the check, and a test comparing PHYSICS to its own copy
    // of PHYSICS cannot.
    expect(PROBE.gravity).toBe(PHYSICS.gravity);
    expect(PROBE.dt).toBe(PHYSICS.dt);
    expect(PROBE.powerScale).toBe(PHYSICS.powerScale);
    expect(PROBE.maxSubSteps).toBe(PHYSICS.maxSubSteps);
    expect(PROBE.offscreenMargin).toBe(PHYSICS.offscreenMargin);
    expect(PROBE_TANK_RADIUS).toBe(DEFAULT_WORLD.tankRadius);

    // The one field that deliberately differs, and the reason: PHYSICS.maxSteps
    // sizes a shot lobbed off the top of the screen, the probe only ever aims
    // at a point on this map. Shorter is fine; longer would be wasted work.
    expect(PROBE.maxSteps).toBeLessThan(PHYSICS.maxSteps);
    // A high arc at power 100 across the full map is about 4 s of flight.
    expect(PROBE.maxSteps * PROBE.dt).toBeGreaterThan(8);
  });

  it('measures reachability with the weapon every tank always has', () => {
    expect(PLAYABILITY_DEFAULTS.hitTolerance).toBe(requireWeapon('baby_missile').radius);
  });

  it('a pair the check calls blocked really is a needle at best', () => {
    // The verdict that matters, because it is the one that throws a seed
    // away. Brute-forced against the real engine over all 17,900 shots a
    // player can fire. Measured over twenty such verdicts, one per style per
    // seed: seventeen had no connecting shot at all and the other three had
    // one, one and three — arcs nobody finds by aiming.
    const cases: { style: TerrainStyle; seed: number; from: number; to: number }[] = [];
    for (const style of TERRAIN_STYLES) {
      for (let seed = 0; seed < 200 && cases.length < TERRAIN_STYLES.length; seed += 1) {
        const terrain = generateTerrain(
          { width: WIDTH, height: HEIGHT, style, ensurePlayable: false },
          makeRng(seed),
        );
        const issue = checkPlayability(terrain).issues.find(
          (candidate) => candidate.kind === 'blocked' && candidate.target !== undefined,
        );
        if (issue === undefined) continue;
        cases.push({ style, seed, from: issue.column, to: issue.target as number });
        break;
      }
    }
    expect(cases.length).toBeGreaterThanOrEqual(3);

    for (const probe of cases) {
      const terrain = generateTerrain(
        { width: WIDTH, height: HEIGHT, style: probe.style, ensurePlayable: false },
        makeRng(probe.seed),
      );
      const found = connections(terrain, probe.from, probe.to);
      expect(
        found.hits,
        `${probe.style} seed ${probe.seed} ${probe.from}->${probe.to} has ${found.hits} connecting shots (best miss ${found.best.toFixed(1)})`,
      ).toBeLessThanOrEqual(8);
    }
  }, 120_000);

  it('every pair on an accepted map really can be hit', () => {
    // The other direction, and the more important one: a map that passes must
    // not contain a pair the real engine cannot connect. Sampled over 60
    // judged pairs; the full sweep of 433 pairs across every style also finds
    // none, it just takes several minutes.
    const babyMissile = requireWeapon('baby_missile');
    let checked = 0;

    for (const style of TERRAIN_STYLES) {
      const terrain = generateTerrain({ width: WIDTH, height: HEIGHT, style }, makeRng(5));
      expect(checkPlayability(terrain).ok).toBe(true);

      const pairs = judgedPairs(terrain, defaultSpawnColumns(WIDTH));
      for (const [from, to] of pairs.slice(0, 12)) {
        const found = connections(terrain, from, to);
        checked += 1;
        expect(
          found.hits,
          `${style} ${from}->${to}: best miss ${found.best.toFixed(1)} vs blast ${babyMissile.radius}`,
        ).toBeGreaterThan(0);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(50);
  }, 300_000);
});

describe('generated maps are always fightable', () => {
  it.each(TERRAIN_STYLES)('style "%s" passes the check for 40 consecutive seeds', (style) => {
    for (let seed = 0; seed < 40; seed += 1) {
      const terrain = generateTerrain({ width: WIDTH, height: HEIGHT, style }, makeRng(seed));
      const report = checkPlayability(terrain);
      expect(
        report.ok,
        `${style} seed ${seed}: ${report.issues.map((i) => `${i.kind}@${i.column}`).join(', ')}`,
      ).toBe(true);
    }
  });

  it('holds at the smaller sizes the tests use', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const terrain = generateTerrain({ width: 640, height: 400 }, makeRng(seed));
      expect(checkPlayability(terrain).ok).toBe(true);
    }
  });

  it('the fallback map is fightable too', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const terrain = generateSafeTerrain({ width: WIDTH, height: HEIGHT }, makeRng(seed));
      expect(checkPlayability(terrain).ok).toBe(true);
    }
  });
});

describe('retrying and falling back', () => {
  it('draws exactly one number from the caller rng however many retries it takes', () => {
    // Downstream systems (wind, tank placement) share the caller's stream. If
    // a retry consumed extra numbers, adding a rejection rule would silently
    // reseed the rest of the game.
    const withRetries = makeRng(1234);
    generateTerrain({ width: WIDTH, height: HEIGHT, style: 'mountains' }, withRetries);

    const counted = makeRng(1234);
    counted.nextU32();

    expect(withRetries.save()).toEqual(counted.save());
  });

  it('retries deterministically: same seed, same map, every time', () => {
    for (const style of TERRAIN_STYLES) {
      for (let seed = 0; seed < 8; seed += 1) {
        const a = generateTerrain({ width: WIDTH, height: HEIGHT, style }, makeRng(seed));
        const b = generateTerrain({ width: WIDTH, height: HEIGHT, style }, makeRng(seed));
        expect(hashTerrain(a)).toBe(hashTerrain(b));
      }
    }
  });

  it('falls back to a safe map rather than shipping one that fails', () => {
    // A demand no shaped map can satisfy — every attempt is rejected, so the
    // fallback path is what returns.
    const impossible = { minEscapeDistance: HEIGHT * 4 };

    const produced = generateTerrain(
      { width: WIDTH, height: HEIGHT, style: 'canyon', playability: impossible },
      makeRng(3),
    );
    const expected = generateSafeTerrain({ width: WIDTH, height: HEIGHT }, makeRng(0));

    // Same shape of map, not necessarily the same seed: what matters is that a
    // caller always gets a well-formed heightmap back.
    expect(produced.width).toBe(expected.width);
    expect(produced.height).toBe(expected.height);
    for (let x = 0; x < WIDTH; x += 1) {
      const y = produced.surface[x] as number;
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(HEIGHT);
    }
    // And it really is the tame map: the safe generator squeezes the ground
    // into 45% of the band, so its relief is well under the floor the
    // silhouette test holds the styled generators to.
    const columns = Array.from(produced.surface);
    expect(Math.max(...columns) - Math.min(...columns)).toBeLessThanOrEqual(210);
  });

  it('skips the whole guarantee when asked to', () => {
    // A seed the check is known to reject, so "skipped" and "not skipped" are
    // distinguishable states. Asserting only that a heightmap comes back would
    // pass just as happily if the flag were ignored outright.
    const style: TerrainStyle = 'mountains';
    const seed = firstRejectedSeed(style);

    const raw = generateTerrain(
      { width: WIDTH, height: HEIGHT, style, ensurePlayable: false },
      makeRng(seed),
    );
    const ensured = generateTerrain({ width: WIDTH, height: HEIGHT, style }, makeRng(seed));

    expect(raw.surface.length).toBe(WIDTH);
    expect(checkPlayability(raw).ok).toBe(false);
    expect(checkPlayability(ensured).ok).toBe(true);
    expect(hashTerrain(raw)).not.toBe(hashTerrain(ensured));
  });
});

describe('the check catches what it claims to', () => {
  function terrainFrom(surface: number[], height = HEIGHT): Terrain {
    return { width: surface.length, height, surface: Int32Array.from(surface) };
  }

  it('flags a tank sealed inside a narrow shaft', () => {
    const surface = new Array<number>(WIDTH).fill(300);
    // A 30 px wide slot down to just above bedrock, centred on a spawn column.
    const spawn = 400;
    for (let x = spawn - 15; x <= spawn + 15; x += 1) surface[x] = HEIGHT - 20;
    const terrain = terrainFrom(surface);

    const report = checkPlayability(terrain, { spawns: [spawn, 900] });
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.kind === 'sealed')).toBe(true);
  });

  it('flags a wall that nothing can be lobbed over', () => {
    const surface = new Array<number>(WIDTH).fill(600);
    for (let x = 600; x <= 700; x += 1) surface[x] = 0; // floor-to-ceiling
    const terrain = terrainFrom(surface);

    const report = checkPlayability(terrain, { spawns: [500, 800] });
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.kind === 'blocked')).toBe(true);
  });

  it('flags a spawn buried at the top of the world', () => {
    const surface = new Array<number>(WIDTH).fill(600);
    for (let x = 380; x <= 420; x += 1) surface[x] = 4;
    const terrain = terrainFrom(surface);

    const report = checkPlayability(terrain, { spawns: [400, 900] });
    expect(report.issues.some((issue) => issue.kind === 'headroom')).toBe(true);
  });

  it('flags a spawn balanced on a cliff face', () => {
    const surface = new Array<number>(WIDTH).fill(600);
    for (let x = 400; x < WIDTH; x += 1) surface[x] = 200;
    const terrain = terrainFrom(surface);

    const report = checkPlayability(terrain, { spawns: [400] });
    expect(report.issues.some((issue) => issue.kind === 'footing')).toBe(true);
  });

  it('passes an open field', () => {
    const terrain = emptyTerrain(WIDTH, HEIGHT);
    terrain.surface.fill(500);
    const report = checkPlayability(terrain);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('blames the gun, not the map, for pairs beyond ballistic range', () => {
    // Flat ground, spawns a whole map apart. Full power reaches about 1040 px,
    // so this pair cannot connect — and that must not condemn the terrain.
    const terrain = emptyTerrain(4000, HEIGHT);
    terrain.surface.fill(500);
    const report = checkPlayability(terrain, { spawns: [100, 3900] });
    expect(report.ok).toBe(true);
  });

  it('stops at the first problem when asked, and finds them all when not', () => {
    const surface = new Array<number>(WIDTH).fill(600);
    for (let x = 600; x <= 700; x += 1) surface[x] = 0;
    const terrain = terrainFrom(surface);
    const spawns = [200, 400, 900, 1100];

    const early = checkPlayability(terrain, { spawns, stopEarly: true });
    const full = checkPlayability(terrain, { spawns });

    expect(early.issues).toHaveLength(1);
    expect(full.issues.length).toBeGreaterThan(1);
    expect(early.ok).toBe(false);
    expect(full.ok).toBe(false);
  });
});

describe('default spawn columns', () => {
  const players = (count: number): PlayerSeed[] =>
    Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

  it('covers the band game.ts actually places tanks in', () => {
    // Derived from the real placement code, not from restating the two literals
    // `defaultSpawnColumns` is built out of. `game.ts` narrows its margins as
    // the lobby grows, so a 16-player match reaches columns a 2-player match
    // never does; the check has to look where the tanks can actually land.
    const band = spawnBand(WIDTH);
    let lowest = Infinity;
    let highest = -Infinity;

    for (let count = 1; count <= 16; count += 1) {
      for (let seed = 0; seed < 12; seed += 1) {
        const state = createGame(
          { seed: `band-${count}-${seed}`, width: WIDTH, height: HEIGHT },
          players(count),
        );
        for (const tank of state.tanks) {
          lowest = Math.min(lowest, tank.x);
          highest = Math.max(highest, tank.x);
          expect(tank.x, `${count} players seed ${seed}`).toBeGreaterThanOrEqual(band.lo);
          expect(tank.x, `${count} players seed ${seed}`).toBeLessThanOrEqual(band.hi);
        }
      }
    }

    // The sampling really did reach the ends of the band, so the bound above is
    // tight rather than vacuously wide.
    expect(lowest).toBeLessThan(band.lo + 12);
    expect(highest).toBeGreaterThan(band.hi - 12);

    // And the band is wider than the middle 80% this used to assume — that
    // assumption left a 16-player lobby's outermost slots unchecked.
    expect(band.lo).toBeLessThan(Math.round(WIDTH * 0.1));
    expect(band.hi).toBeGreaterThan(Math.round(WIDTH * 0.9));

    const columns = defaultSpawnColumns(WIDTH);
    expect(columns).toHaveLength(7);
    expect(columns[0]).toBe(band.lo);
    expect(columns[6]).toBe(band.hi);
    for (let i = 1; i < columns.length; i += 1) {
      expect(columns[i] as number).toBeGreaterThan(columns[i - 1] as number);
    }
  }, 120_000);

  it('degenerates sanely for one spawn', () => {
    const band = spawnBand(WIDTH);
    expect(defaultSpawnColumns(WIDTH, 1)).toEqual([Math.round((band.lo + band.hi) / 2)]);
  });
});
