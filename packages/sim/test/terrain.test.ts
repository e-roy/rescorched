import { describe, expect, it } from 'vitest';
import {
  applyCrater,
  applyMound,
  cloneTerrain,
  emptyTerrain,
  generateTerrain,
  hashTerrain,
  isSolid,
  MAX_BLAST_SLOPE,
  serializeTerrain,
  deserializeTerrain,
  surfaceAt,
  TERRAIN_STYLES,
  type Terrain,
} from '../src/terrain.ts';
import { makeRng } from '../src/rng.ts';

const WIDTH = 320;
const HEIGHT = 200;

function flatTerrain(surfaceY: number, width = WIDTH, height = HEIGHT): Terrain {
  const terrain = emptyTerrain(width, height);
  terrain.surface.fill(surfaceY);
  return terrain;
}

describe('terrain generation', () => {
  it('is deterministic for a given seed', () => {
    const a = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(42));
    const b = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(42));
    expect(Array.from(a.surface)).toEqual(Array.from(b.surface));
    expect(hashTerrain(a)).toBe(hashTerrain(b));
  });

  it('differs between seeds', () => {
    const a = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(1));
    const b = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(2));
    expect(hashTerrain(a)).not.toBe(hashTerrain(b));
  });

  // Generation is not cheap — the playability check samples 25 columns and the
  // retry loop runs to 48 attempts — so every test below that generates maps in
  // a loop declares its own timeout instead of running against Vitest's
  // undeclared 5000 ms default. Measured over three full-suite runs: 0.50 s for
  // the 32-seed test, 0.39-0.66 s per style for the one below it. The point of
  // declaring is that neither can creep into the default without somebody
  // choosing to.
  it('gives 32 consecutive seeds 32 different maps', () => {
    const hashes = new Set<number>();
    for (let seed = 0; seed < 32; seed += 1) {
      hashes.add(hashTerrain(generateTerrain({ width: 1280, height: 720 }, makeRng(seed))));
    }
    expect(hashes.size).toBe(32);
  }, 60_000);

  it.each(TERRAIN_STYLES)(
    'keeps every column on screen for style "%s"',
    (style) => {
      // 24 seeds, not one: the retry loop means a single seed exercises only one
      // of the shapes a style can produce.
      for (let seed = 0; seed < 24; seed += 1) {
        const terrain = generateTerrain({ width: WIDTH, height: HEIGHT, style }, makeRng(seed));
        for (let x = 0; x < WIDTH; x += 1) {
          const y = terrain.surface[x] as number;
          expect(Number.isInteger(y)).toBe(true);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(HEIGHT);
        }
      }
    },
    60_000,
  );

  it('leaves both sky above and ground below', () => {
    const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(11));
    const surfaces = Array.from(terrain.surface);
    expect(Math.min(...surfaces)).toBeGreaterThan(0);
    expect(Math.max(...surfaces)).toBeLessThan(HEIGHT);
  });

  it('honours a custom ground band', () => {
    const terrain = generateTerrain(
      { width: WIDTH, height: HEIGHT, minGround: 0.3, maxGround: 0.5 },
      makeRng(9),
    );
    for (let x = 0; x < WIDTH; x += 1) {
      const y = terrain.surface[x] as number;
      // groundFraction in [0.3, 0.5] → surface Y in [0.5h, 0.7h].
      expect(y).toBeGreaterThanOrEqual(Math.round(HEIGHT * 0.5) - 1);
      expect(y).toBeLessThanOrEqual(Math.round(HEIGHT * 0.7) + 1);
    }
  });
});

describe('solidity', () => {
  it('reports solid below the surface and sky above it', () => {
    const terrain = flatTerrain(120);
    expect(isSolid(terrain, 50, 119)).toBe(false);
    expect(isSolid(terrain, 50, 120)).toBe(true);
    expect(isSolid(terrain, 50, 199)).toBe(true);
  });

  it('treats off-map columns as empty and below-world as solid', () => {
    const terrain = flatTerrain(120);
    expect(isSolid(terrain, -1, 150)).toBe(false);
    expect(isSolid(terrain, WIDTH, 150)).toBe(false);
    expect(isSolid(terrain, 50, HEIGHT + 10)).toBe(true);
  });
});

describe('craters', () => {
  it('removes dirt and lowers the surface', () => {
    const terrain = flatTerrain(120);
    const before = surfaceAt(terrain, 160);
    const result = applyCrater(terrain, 160, 130, 20);

    expect(result.removed).toBeGreaterThan(0);
    expect(surfaceAt(terrain, 160)).toBeGreaterThan(before);
    expect(result.minX).toBeLessThanOrEqual(160);
    expect(result.maxX).toBeGreaterThanOrEqual(160);
  });

  it('is a no-op when the blast is entirely in the sky', () => {
    const terrain = flatTerrain(120);
    const before = hashTerrain(terrain);
    const result = applyCrater(terrain, 160, 40, 15);
    expect(result.removed).toBe(0);
    expect(hashTerrain(terrain)).toBe(before);
  });

  it('never pushes a column past the bottom of the world', () => {
    const terrain = flatTerrain(HEIGHT - 4);
    applyCrater(terrain, 160, HEIGHT - 2, 80);
    for (let x = 0; x < WIDTH; x += 1) {
      expect(terrain.surface[x]).toBeLessThanOrEqual(HEIGHT);
      expect(terrain.surface[x]).toBeGreaterThanOrEqual(0);
    }
  });

  it('is symmetric about its centre on flat ground', () => {
    const terrain = flatTerrain(120);
    applyCrater(terrain, 160, 125, 24);
    for (let offset = 1; offset < 20; offset += 1) {
      expect(terrain.surface[160 - offset]).toBe(terrain.surface[159 + offset]);
    }
  });

  it('digs deeper in the middle than at the rim', () => {
    const terrain = flatTerrain(120);
    applyCrater(terrain, 160, 125, 30);
    const middle = terrain.surface[160] as number;
    const rim = terrain.surface[186] as number;
    expect(middle).toBeGreaterThan(rim);
  });

  it('ignores a zero or negative radius', () => {
    const terrain = flatTerrain(120);
    const before = hashTerrain(terrain);
    expect(applyCrater(terrain, 160, 125, 0).removed).toBe(0);
    expect(applyCrater(terrain, 160, 125, -5).removed).toBe(0);
    expect(hashTerrain(terrain)).toBe(before);
  });

  it('leaves a bite the player can actually see', () => {
    // The complaint this replaced: a Baby Missile took a nick nobody noticed.
    // A surface hit now removes CRATER_DEPTH (1.5) radii of ground at its
    // centre and is a full 2 radii wide, at every weapon size in the table.
    for (const radius of [18, 28, 55, 90]) {
      const terrain = flatTerrain(400, 600, 900);
      applyCrater(terrain, 300, 400, radius);

      const depth = (terrain.surface[300] as number) - 400;
      expect(depth).toBeGreaterThanOrEqual(Math.round(radius * 1.45));
      expect(depth).toBeLessThanOrEqual(Math.round(radius * 1.55));

      let lowered = 0;
      for (let x = 0; x < 600; x += 1) {
        if ((terrain.surface[x] as number) > 400) lowered += 1;
      }
      expect(lowered).toBe(radius * 2);
    }
  });

  it('converges instead of drilling when shot into the same spot', () => {
    // Twelve Baby Missiles down one column, each detonating on the new surface.
    // Blast-loosened walls slump, so the hole gets wider and each shot buys
    // less depth than the last — the alternative is a one-column shaft nobody
    // can climb out of. `terrain-slump.test.ts` takes this to forty shots and
    // every weapon in the shop; this is the short version that lives next to
    // the rest of the crater behaviour.
    const terrain = flatTerrain(200, 600, 900);
    const depths: number[] = [];
    const widths: number[] = [];

    for (let shot = 0; shot < 12; shot += 1) {
      applyCrater(terrain, 300, terrain.surface[300] as number, 18);
      depths.push((terrain.surface[300] as number) - 200);
      let wide = 0;
      for (let x = 0; x < 600; x += 1) {
        if ((terrain.surface[x] as number) >= 240) wide += 1;
      }
      widths.push(wide);
    }

    const first = depths[0] as number;
    const last = (depths[11] as number) - (depths[10] as number);
    expect(last).toBeLessThan(first * 0.75); // returns are diminishing
    expect(depths[11] as number).toBeLessThan(first * 12); // and never linear

    // The hole spreads sideways as it deepens rather than staying a slot.
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i] as number).toBeGreaterThanOrEqual(widths[i - 1] as number);
    }
    expect(widths[11] as number).toBeGreaterThan(3 * 18);

    // The documented bound, not the number the code happens to reach: dirt
    // holds MAX_BLAST_SLOPE and no more, anywhere on the map.
    for (let x = 1; x < 600; x += 1) {
      const step = Math.abs((terrain.surface[x] as number) - (terrain.surface[x - 1] as number));
      expect(step, `column ${x}`).toBeLessThanOrEqual(MAX_BLAST_SLOPE);
    }
  });

  it('is idempotent when the identical blast lands twice', () => {
    const terrain = flatTerrain(300, 600, 900);
    applyCrater(terrain, 300, 300, 40);
    const after = hashTerrain(terrain);
    const second = applyCrater(terrain, 300, 300, 40);
    expect(second.removed).toBe(0);
    expect(hashTerrain(terrain)).toBe(after);
  });

  it('survives a bombardment without leaving the world', () => {
    const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(4));
    const rng = makeRng('bombardment');
    for (let shot = 0; shot < 200; shot += 1) {
      applyCrater(
        terrain,
        rng.range(-40, WIDTH + 40),
        rng.range(-40, HEIGHT + 40),
        rng.range(1, 60),
      );
    }
    for (let x = 0; x < WIDTH; x += 1) {
      const y = terrain.surface[x] as number;
      expect(Number.isInteger(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(HEIGHT);
    }
  });
});

describe('mounds', () => {
  it('raises the surface', () => {
    const terrain = flatTerrain(120);
    const before = surfaceAt(terrain, 160);
    applyMound(terrain, 160, 120, 25);
    expect(surfaceAt(terrain, 160)).toBeLessThan(before);
  });

  it('is a dome: highest in the middle, tapering to nothing at the rim', () => {
    for (const radius of [10, 20, 36, 70]) {
      const terrain = flatTerrain(400, 600, 900);
      applyMound(terrain, 300, 400, radius);

      // Peak height is the radius, and the dome is a full 2 radii wide.
      expect(400 - (terrain.surface[300] as number)).toBe(radius);
      let raised = 0;
      for (let x = 0; x < 600; x += 1) if ((terrain.surface[x] as number) < 400) raised += 1;
      expect(raised).toBe(radius * 2);

      // Monotone from the peak outward, and symmetric about it.
      for (let offset = 1; offset < radius; offset += 1) {
        expect(terrain.surface[300 - offset], `r${radius} offset ${offset}`).toBe(
          terrain.surface[299 + offset],
        );
        expect(terrain.surface[300 + offset] as number).toBeGreaterThanOrEqual(
          terrain.surface[300 + offset - 1] as number,
        );
      }
    }
  });

  it('never rises above the top of the world', () => {
    const terrain = flatTerrain(30);
    applyMound(terrain, 160, 10, 60);
    for (let x = 0; x < WIDTH; x += 1) {
      expect(terrain.surface[x]).toBeGreaterThanOrEqual(0);
    }
  });

  it('is a no-op when the dirt lands below the surface', () => {
    const terrain = flatTerrain(80);
    const before = hashTerrain(terrain);
    expect(applyMound(terrain, 160, 190, 5).removed).toBe(0);
    expect(hashTerrain(terrain)).toBe(before);
  });

  it('reports the dirt it added as a negative removal', () => {
    const terrain = flatTerrain(120);
    const result = applyMound(terrain, 160, 110, 20);
    expect(result.removed).toBeLessThan(0);
    let added = 0;
    for (let x = 0; x < WIDTH; x += 1) added += 120 - (terrain.surface[x] as number);
    expect(result.removed).toBe(-added);
  });
});

describe('cloning and serialisation', () => {
  it('clones without aliasing', () => {
    const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(3));
    const copy = cloneTerrain(terrain);
    applyCrater(copy, 100, 150, 30);
    expect(hashTerrain(copy)).not.toBe(hashTerrain(terrain));
  });

  it('round-trips through JSON', () => {
    const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(5));
    const restored = deserializeTerrain(JSON.parse(JSON.stringify(serializeTerrain(terrain))));
    expect(hashTerrain(restored)).toBe(hashTerrain(terrain));
  });

  it('round-trips every column exactly, craters and all', () => {
    const terrain = generateTerrain({ width: 1280, height: 720, style: 'canyon' }, makeRng(77));
    applyCrater(terrain, 400, surfaceAt(terrain, 400), 55);
    applyMound(terrain, 900, surfaceAt(terrain, 900) - 20, 40);

    const restored = deserializeTerrain(JSON.parse(JSON.stringify(serializeTerrain(terrain))));
    expect(restored.width).toBe(terrain.width);
    expect(restored.height).toBe(terrain.height);
    expect(Array.from(restored.surface)).toEqual(Array.from(terrain.surface));
  });
});
