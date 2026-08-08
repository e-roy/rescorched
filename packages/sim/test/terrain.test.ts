import { describe, expect, it } from 'vitest';
import {
  applyCrater,
  applyMound,
  cloneTerrain,
  emptyTerrain,
  generateTerrain,
  hashTerrain,
  isSolid,
  serializeTerrain,
  deserializeTerrain,
  surfaceAt,
  TERRAIN_STYLES,
} from '../src/terrain.ts';
import { makeRng } from '../src/rng.ts';

const WIDTH = 320;
const HEIGHT = 200;

function flatTerrain(surfaceY: number) {
  const terrain = emptyTerrain(WIDTH, HEIGHT);
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

  it.each(TERRAIN_STYLES)('keeps every column on screen for style "%s"', (style) => {
    const terrain = generateTerrain({ width: WIDTH, height: HEIGHT, style }, makeRng(7));
    for (let x = 0; x < WIDTH; x += 1) {
      const y = terrain.surface[x] as number;
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(HEIGHT);
    }
  });

  it('leaves both sky above and ground below', () => {
    const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(11));
    const surfaces = Array.from(terrain.surface);
    expect(Math.min(...surfaces)).toBeGreaterThan(0);
    expect(Math.max(...surfaces)).toBeLessThan(HEIGHT);
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
});

describe('mounds', () => {
  it('raises the surface', () => {
    const terrain = flatTerrain(120);
    const before = surfaceAt(terrain, 160);
    applyMound(terrain, 160, 120, 25);
    expect(surfaceAt(terrain, 160)).toBeLessThan(before);
  });

  it('never rises above the top of the world', () => {
    const terrain = flatTerrain(30);
    applyMound(terrain, 160, 10, 60);
    for (let x = 0; x < WIDTH; x += 1) {
      expect(terrain.surface[x]).toBeGreaterThanOrEqual(0);
    }
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
});
