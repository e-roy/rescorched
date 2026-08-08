import { describe, expect, it } from 'vitest';
import {
  DEG_TO_RAD,
  clamp,
  detAtan,
  detAtan2,
  detCos,
  detCosDeg,
  detSin,
  detSinDeg,
  hypot2,
  lerp,
  wrapDegrees,
} from '../src/math.ts';

/**
 * The deterministic trig replacements must track the engine's own `Math` closely
 * enough that nobody can feel the difference, while being built only from
 * exactly-specified operations. The bar is 1e-9 rad: a shot fired at 1000 px
 * range with that much angular error lands 1e-6 px off, which no pixel can show.
 *
 * These tests compare against the engine deliberately — `packages/sim/src` may
 * not call `Math.sin`, but a test proving the replacement is right must.
 */
const TOLERANCE = 1e-9;

function worstError(f: (x: number) => number, g: (x: number) => number, samples: number[]): number {
  let worst = 0;
  for (const x of samples) {
    const error = Math.abs(f(x) - g(x));
    if (error > worst) worst = error;
  }
  return worst;
}

/** Every quarter degree across four full turns, in radians. */
const FULL_CIRCLE: number[] = [];
for (let degrees = -720; degrees <= 720; degrees += 0.25) {
  FULL_CIRCLE.push((degrees * Math.PI) / 180);
}

describe('deterministic trig', () => {
  it('matches Math.sin across the full circle', () => {
    expect(worstError(detSin, Math.sin, FULL_CIRCLE)).toBeLessThan(TOLERANCE);
  });

  it('matches Math.cos across the full circle', () => {
    expect(worstError(detCos, Math.cos, FULL_CIRCLE)).toBeLessThan(TOLERANCE);
  });

  it('still tracks Math far outside the first turn', () => {
    // Argument reduction is the part that decays with magnitude. The sim never
    // sees an angle bigger than a few turns, but terrain generation sums sine
    // waves with phases well past 2*PI.
    const far: number[] = [];
    for (let i = -400; i <= 400; i += 1) far.push(i * 0.37);
    expect(worstError(detSin, Math.sin, far)).toBeLessThan(TOLERANCE);
    expect(worstError(detCos, Math.cos, far)).toBeLessThan(TOLERANCE);
  });

  /**
   * The accuracy claim in the math.ts header, measured — and bounded to the
   * domain it is claimed over.
   *
   * Every detSin/detCos call in this repo arrives through detSinDeg/detCosDeg
   * with a degrees value, so |x| stays within a few turns. Over |x| <= 4*PI the
   * error is under 1e-12. Well past that it decays, because the first argument
   * fold in `reduceQuadrant` multiplies a single-double 2*PI by the turn count.
   * The second half of this test asserts that decay is REAL — a lower bound, so
   * nobody can read the header as an unqualified promise — while staying inside
   * the numbers the header quotes.
   */
  it('is accurate to 1e-12 over the domain the sim uses, and no further', () => {
    const band = (lo: number, hi: number, count: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i <= count; i += 1) out.push(lo + ((hi - lo) * i) / count);
      return out;
    };

    const inDomain = band(-4 * Math.PI, 4 * Math.PI, 40000);
    expect(worstError(detSin, Math.sin, inDomain)).toBeLessThan(1e-12);
    expect(worstError(detCos, Math.cos, inDomain)).toBeLessThan(1e-12);

    // Beyond the domain: still bit-identical across engines, but no longer
    // accurate. These bracket the header's quoted figures from both sides.
    const at1e6 = band(999999, 1000001, 40000);
    expect(worstError(detSin, Math.sin, at1e6)).toBeGreaterThan(1e-11);
    expect(worstError(detSin, Math.sin, at1e6)).toBeLessThan(1e-9);

    const at1e12 = band(999999999999, 1000000000001, 40000);
    expect(worstError(detSin, Math.sin, at1e12)).toBeGreaterThan(1e-6);
    expect(worstError(detSin, Math.sin, at1e12)).toBeLessThan(1e-3);
  });

  it('hits the exact quadrant values', () => {
    expect(detSin(0)).toBe(0);
    expect(detCos(0)).toBe(1);
    expect(detSin(Math.PI / 2)).toBeCloseTo(1, 12);
    expect(detCos(Math.PI / 2)).toBeCloseTo(0, 12);
    expect(detSin(Math.PI)).toBeCloseTo(0, 9);
    expect(detCos(Math.PI)).toBeCloseTo(-1, 12);
  });

  it('obeys the Pythagorean identity', () => {
    for (const x of FULL_CIRCLE) {
      const s = detSin(x);
      const c = detCos(x);
      expect(Math.abs(s * s + c * c - 1)).toBeLessThan(1e-12);
    }
  });

  it('degree wrappers agree with the radian versions', () => {
    for (let degrees = 0; degrees <= 180; degrees += 0.5) {
      expect(detSinDeg(degrees)).toBe(detSin(degrees * DEG_TO_RAD));
      expect(detCosDeg(degrees)).toBe(detCos(degrees * DEG_TO_RAD));
      expect(Math.abs(detSinDeg(degrees) - Math.sin((degrees * Math.PI) / 180))).toBeLessThan(
        TOLERANCE,
      );
      expect(Math.abs(detCosDeg(degrees) - Math.cos((degrees * Math.PI) / 180))).toBeLessThan(
        TOLERANCE,
      );
    }
  });

  it('matches Math.atan over ten decades', () => {
    const samples: number[] = [];
    for (let i = -2000; i <= 2000; i += 1) samples.push(i / 137);
    for (const magnitude of [1e-8, 1e-4, 0.5, 1, 2, 1e4, 1e8]) {
      samples.push(magnitude, -magnitude);
    }
    expect(worstError(detAtan, Math.atan, samples)).toBeLessThan(TOLERANCE);
  });

  it('matches Math.atan2 across the full circle at every scale', () => {
    let worst = 0;
    for (let deciDegrees = 0; deciDegrees < 3600; deciDegrees += 1) {
      const radians = (deciDegrees * Math.PI) / 1800;
      for (const magnitude of [1e-6, 0.001, 1, 1000, 1e6]) {
        const y = Math.sin(radians) * magnitude;
        const x = Math.cos(radians) * magnitude;
        const error = Math.abs(detAtan2(y, x) - Math.atan2(y, x));
        if (error > worst) worst = error;
      }
    }
    expect(worst).toBeLessThan(TOLERANCE);
  });

  it('reproduces Math.atan2 exactly on signed zeros and infinities', () => {
    // These decide which side of the branch cut a direction falls on, and
    // getting one wrong flips an angle by a whole PI. Nothing in the sim calls
    // detAtan2 yet — see its doc comment — so this test is the only thing
    // holding it to the engine's contract until something does.
    const cases: Array<[number, number]> = [
      [0, 0],
      [0, -0],
      [-0, 0],
      [-0, -0],
      [0, 1],
      [0, -1],
      [-0, 1],
      [-0, -1],
      [1, 0],
      [1, -0],
      [-1, 0],
      [-1, -0],
      [Infinity, Infinity],
      [Infinity, -Infinity],
      [-Infinity, Infinity],
      [-Infinity, -Infinity],
      [Infinity, 3],
      [-Infinity, 3],
      [3, Infinity],
      [3, -Infinity],
      [-3, Infinity],
      [-3, -Infinity],
    ];
    for (const [y, x] of cases) {
      expect(`atan2(${y}, ${x}) = ${detAtan2(y, x)}`).toBe(
        `atan2(${y}, ${x}) = ${Math.atan2(y, x)}`,
      );
      // toBe() would treat 0 and -0 as equal; Object.is does not.
      expect(Object.is(detAtan2(y, x), Math.atan2(y, x))).toBe(true);
    }
  });

  it('returns NaN for NaN, like the engine does', () => {
    expect(detSin(Number.NaN)).toBeNaN();
    expect(detCos(Number.NaN)).toBeNaN();
    expect(detAtan(Number.NaN)).toBeNaN();
    expect(detAtan2(Number.NaN, 1)).toBeNaN();
    expect(detAtan2(1, Number.NaN)).toBeNaN();
    expect(detSin(Infinity)).toBeNaN();
    expect(detCos(-Infinity)).toBeNaN();
  });

  it('is bit-identical when called twice', () => {
    for (let i = 0; i < 1000; i += 1) {
      const value = i * 0.017;
      expect(detSin(value)).toBe(detSin(value));
      expect(detCos(value)).toBe(detCos(value));
      expect(detAtan(value - 8)).toBe(detAtan(value - 8));
      expect(detAtan2(value - 8, 3 - value)).toBe(detAtan2(value - 8, 3 - value));
    }
  });
});

describe('helpers', () => {
  it('wraps degrees into [0, 360)', () => {
    expect(wrapDegrees(0)).toBe(0);
    expect(wrapDegrees(360)).toBe(0);
    expect(wrapDegrees(370)).toBe(10);
    expect(wrapDegrees(-10)).toBe(350);
    expect(wrapDegrees(-730)).toBe(350);
  });

  it('clamps', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('lerps', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(lerp(-4, 4, 0.5)).toBe(0);
  });

  it('computes vector length, matching Math.hypot at game magnitudes', () => {
    expect(hypot2(3, 4)).toBe(5);
    expect(hypot2(0, 0)).toBe(0);
    for (let i = -60; i <= 60; i += 1) {
      for (let j = -60; j <= 60; j += 7) {
        const x = i * 21.3;
        const y = j * 17.9;
        expect(Math.abs(hypot2(x, y) - Math.hypot(x, y))).toBeLessThan(1e-9);
      }
    }
  });
});
