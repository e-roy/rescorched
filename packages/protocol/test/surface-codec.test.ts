/**
 * The heightmap codec.
 *
 * This is the one place in the protocol where bytes are reinterpreted rather
 * than merely validated, so it gets its own suite. The bar is not "usually
 * round-trips": if `unpackSurface(packSurface(h))` differs from `h` in one
 * column, two clients disagree about where the ground is, which is the same
 * class of failure as a determinism bug in the sim.
 *
 * fast-check is not a dependency of this repo (minimal dependency count is a
 * stated feature in TECH_STACK.md), so the property tests below drive a seeded
 * generator instead. Seeded, not random: a failure here must reproduce.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_PACKED_SURFACE_CHARS,
  MAX_TERRAIN_WIDTH,
  MAX_WORLD_COORD,
  packSurface,
  PACKED_SURFACE_PATTERN,
  SurfaceColumnSchema,
  unpackSurface,
} from '../src/index.ts';

/**
 * This package compiles against the ES2022 lib alone — no DOM, no Node — so
 * `console` is not in scope. The size test below prints what it measured, so
 * the figures quoted in the comments are re-taken on every run.
 */
declare const console: { log(message: string): void };

/**
 * The same encoding as `packSurface`, with none of its range checks.
 *
 * This is what a hostile or simply older peer puts on the wire, and it is the
 * only way to build the input that matters here: our own packer refuses to emit
 * a column outside the schema's range, so without this helper the decoder's
 * range check is untestable and the suite cannot tell a bounded decoder from an
 * unbounded one. That was exactly the gap that let an unbounded decoder ship.
 */
export function hostilePackSurface(surface: readonly number[]): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  let previous = 0;
  for (const value of surface) {
    const delta = value - previous;
    previous = value;
    let remaining = delta >= 0 ? delta * 2 : delta * -2 - 1;
    for (;;) {
      const digit = remaining % 32;
      remaining = (remaining - digit) / 32;
      out += alphabet.charAt(remaining > 0 ? digit + 32 : digit);
      if (remaining === 0) break;
    }
  }
  return out;
}

/** mulberry32 — small, seeded, and good enough to generate test inputs. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

describe('packSurface / unpackSurface', () => {
  it.each([
    ['empty', []],
    ['one column', [0]],
    ['flat', new Array(64).fill(300) as number[]],
    ['a staircase', Array.from({ length: 64 }, (_, i) => i)],
    ['a cliff', [0, 4096, 0, 4096]],
    ['negatives', [-5, -4, 0, 3, -900]],
    ['the extremes of the schema range', [-16384, 16384, 0, -16384]],
    ['a full board', Array.from({ length: 1280 }, (_, i) => 300 + (i % 17))],
  ])('round-trips %s exactly', (_label, surface) => {
    const packed = packSurface(surface);
    expect(PACKED_SURFACE_PATTERN.test(packed)).toBe(true);
    expect(unpackSurface(packed)).toEqual(surface);
  });

  it('round-trips 500 seeded heightmaps exactly', () => {
    const random = makeRandom(0x5eed);
    for (let trial = 0; trial < 500; trial += 1) {
      const length = randomInt(random, 0, 300);
      const surface: number[] = [];
      let height = randomInt(random, 0, 720);
      for (let column = 0; column < length; column += 1) {
        // Mostly gentle drift with the occasional cliff, like real terrain.
        height += random() < 0.05 ? randomInt(random, -600, 600) : randomInt(random, -3, 3);
        surface.push(height);
      }
      const packed = packSurface(surface);
      const unpacked = unpackSurface(packed);
      expect(unpacked, `seeded trial ${trial}`).toEqual(surface);
    }
  });

  it('is materially smaller than JSON for terrain-shaped data', () => {
    const columns = 1280;
    const random = makeRandom(7);
    let height = 400;
    const surface = Array.from({ length: columns }, () => {
      height += randomInt(random, -3, 3);
      return height;
    });
    const asJson = JSON.stringify(surface).length;
    const packedChars = packSurface(surface).length;
    const asPacked = packedChars + 2; // + the JSON quotes

    console.log(
      `[surface-codec] ${columns} synthetic columns: ${packedChars} packed chars ` +
        `(${(packedChars / columns).toFixed(3)}/col), ${asJson} as JSON ` +
        `(${(asJson / columns).toFixed(3)}/col), ${(asJson / asPacked).toFixed(2)}x`,
    );

    // The bands below are what keeps the figures in the line above, and the
    // ones in the header of `src/index.ts`, from rotting into fiction. A gentle
    // map costs almost exactly one character per column packed, because nearly
    // every delta is in [-3, 3] and fits a single base-32 digit; as JSON each
    // column costs three or four digits plus a comma.
    expect(packedChars / columns).toBeGreaterThan(1);
    expect(packedChars / columns).toBeLessThan(1.01);
    expect(asJson / columns).toBeGreaterThan(3.9);
    expect(asJson / columns).toBeLessThan(4.1);
    expect(asPacked).toBeLessThan(asJson / 3);
    expect(unpackSurface(packSurface(surface))).toEqual(surface);
  });

  it('never throws and returns null for malformed input', () => {
    const alphabet = 'ABCyz09-_!*, "\\\n\u0000\ud800é';
    const random = makeRandom(99);

    for (let trial = 0; trial < 2000; trial += 1) {
      let candidate = '';
      const length = randomInt(random, 0, 40);
      for (let index = 0; index < length; index += 1) {
        candidate += alphabet.charAt(randomInt(random, 0, alphabet.length - 1));
      }

      let result: number[] | null = null;
      expect(
        () => {
          result = unpackSurface(candidate);
        },
        `input ${JSON.stringify(candidate)}`,
      ).not.toThrow();

      // Whatever comes back must itself be a valid heightmap.
      if (result !== null) {
        for (const value of result as number[]) expect(Number.isInteger(value)).toBe(true);
        expect((result as number[]).length).toBeLessThanOrEqual(MAX_TERRAIN_WIDTH);
      }
    }
  });

  it.each([
    ['an unknown character', 'AB!CD'],
    ['a truncated final value', 'ggg'],
    ['whitespace', 'AB CD'],
    ['a lone surrogate', 'AB\ud800CD'],
  ])('rejects %s', (_label, packed) => {
    expect(unpackSurface(packed)).toBeNull();
  });

  it('refuses to decode more columns than a board can have', () => {
    // Every 'A' is one zero-delta column, so this asks for one column too many.
    expect(unpackSurface('A'.repeat(MAX_TERRAIN_WIDTH))).not.toBeNull();
    expect(unpackSurface('A'.repeat(MAX_TERRAIN_WIDTH + 1))).toBeNull();
  });

  it('refuses to encode what the schema would have rejected', () => {
    expect(() => packSurface([1.5])).toThrow(RangeError);
    expect(() => packSurface([Number.NaN])).toThrow(RangeError);
    expect(() => packSurface([Number.POSITIVE_INFINITY])).toThrow(RangeError);
    expect(() => packSurface(new Array(MAX_TERRAIN_WIDTH + 1).fill(0) as number[])).toThrow(
      RangeError,
    );
  });
});

/**
 * The decoder is the second door into `SurfaceColumnSchema`.
 *
 * `TerrainSnapshotSchema` bounds the plain `surface` array with Zod, then hands
 * the decoder's output through untouched. So whatever the decoder is willing to
 * return is the real bound on a terrain column, and if the two numbers drift
 * apart the packed branch is a hole straight through the documented limit.
 *
 * This block is the pin. Every case below is built with `hostilePackSurface`,
 * because `packSurface` cannot express the inputs that matter — which is the
 * whole reason the earlier version of this suite could not see the hole.
 */
describe('the decoder cannot return a column the schema would reject', () => {
  it('accepts exactly the schema range and nothing wider', () => {
    for (const value of [0, 1, -1, MAX_WORLD_COORD, -MAX_WORLD_COORD]) {
      expect(SurfaceColumnSchema.safeParse(value).success, `schema ${value}`).toBe(true);
      expect(unpackSurface(hostilePackSurface([value])), `codec ${value}`).toEqual([value]);
    }

    for (const value of [
      MAX_WORLD_COORD + 1,
      -MAX_WORLD_COORD - 1,
      100_000,
      -100_000,
      10_000_000, // the value from the frame that got past the old decoder
      1 << 28, // the old SURFACE_MAX_MAGNITUDE, which was 16,384x too generous
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(SurfaceColumnSchema.safeParse(value).success, `schema ${value}`).toBe(false);
      expect(unpackSurface(hostilePackSurface([value])), `codec ${value}`).toBeNull();
    }
  });

  it('rejects a column that only goes out of range partway along the map', () => {
    // The first columns are perfectly ordinary. Rejection must not depend on
    // the bad value being first, which a naive "check the head" guard would.
    const surface = [300, 301, 302, 10_000_000, 303];
    expect(unpackSurface(hostilePackSurface(surface))).toBeNull();
  });

  it('rejects a walk that leaves the range one small step at a time', () => {
    // Every individual delta here is 8 pixels — the sort of step real terrain
    // takes. Only the running total is illegal. A guard on the delta rather
    // than on the accumulated column would wave this straight through.
    //
    // The step has to be 8 rather than 1 so the walk reaches the edge of the
    // range inside a legal board: at one pixel per column it would need 16,385
    // columns and be refused for being too wide, which would prove nothing.
    const step = 8;
    const climb = (limit: number): number[] => {
      const surface: number[] = [];
      for (let value = 0; value <= limit; value += step) surface.push(value);
      return surface;
    };

    const overshoot = climb(MAX_WORLD_COORD + step * 4);
    expect(overshoot.length).toBeLessThanOrEqual(MAX_TERRAIN_WIDTH);
    expect(overshoot[overshoot.length - 1]).toBeGreaterThan(MAX_WORLD_COORD);
    expect(unpackSurface(hostilePackSurface(overshoot))).toBeNull();

    // …and the same walk stopped exactly at the edge is fine.
    const legal = climb(MAX_WORLD_COORD);
    expect(legal[legal.length - 1]).toBe(MAX_WORLD_COORD);
    expect(unpackSurface(hostilePackSurface(legal))).toEqual(legal);
  });

  it('returns integers, never NaN, for a padded continuation run', () => {
    // `scale` multiplies by 32 per continuation digit, so ~205 of them reach
    // Infinity, and `0 * Infinity` is NaN. NaN fails every `>` and `<` test, so
    // it slipped past the range guards and landed in the surface array as a NaN
    // column. Measured on the build before the fix:
    //   unpackSurface('g'.repeat(205) + 'A')  ->  [NaN]
    for (const padding of [100, 204, 205, 206, 300, 1000]) {
      const result = unpackSurface('g'.repeat(padding) + 'A');
      expect(result, `padding ${padding}`).toBeNull();
    }

    // Any column that does come back is a legal one.
    for (const candidate of ['gggA', 'ggA', 'gA', 'A', '__f', 'gggC']) {
      const result = unpackSurface(candidate);
      if (result === null) continue;
      for (const value of result) {
        expect(Number.isInteger(value), `${candidate} -> ${String(value)}`).toBe(true);
        expect(SurfaceColumnSchema.safeParse(value).success, candidate).toBe(true);
      }
    }
  });

  it('bounds the packed string to what a legal board can actually need', () => {
    // The worst legal board alternates between the extremes of the range: the
    // largest possible delta, every column. That is what the character cap is
    // sized for, so this is the case that proves the cap is not too tight.
    const worst = Array.from({ length: MAX_TERRAIN_WIDTH }, (_, index) =>
      index % 2 === 0 ? MAX_WORLD_COORD : -MAX_WORLD_COORD,
    );
    const packed = packSurface(worst);
    console.log(
      `[surface-codec] worst legal board: ${MAX_TERRAIN_WIDTH} columns -> ${packed.length} packed chars, cap ${MAX_PACKED_SURFACE_CHARS}`,
    );
    expect(packed.length).toBeLessThanOrEqual(MAX_PACKED_SURFACE_CHARS);
    expect(unpackSurface(packed)).toEqual(worst);

    // And one character more than the cap is refused without being decoded.
    expect(unpackSurface('A'.repeat(MAX_PACKED_SURFACE_CHARS + 1))).toBeNull();
  });
});
