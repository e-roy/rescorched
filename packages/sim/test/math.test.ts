import { describe, expect, it } from 'vitest';
import { detAtan2, detCos, detSin, wrapDegrees, clamp, hypot2 } from '../src/math.ts';

/**
 * The deterministic trig replacements must track the engine's own `Math`
 * closely enough that nobody can feel the difference, while being built only
 * from exactly-specified operations.
 */
describe('deterministic trig', () => {
  it('matches Math.sin across the full circle', () => {
    for (let degrees = -720; degrees <= 720; degrees += 0.25) {
      const radians = (degrees * Math.PI) / 180;
      expect(detSin(radians)).toBeCloseTo(Math.sin(radians), 9);
    }
  });

  it('matches Math.cos across the full circle', () => {
    for (let degrees = -720; degrees <= 720; degrees += 0.25) {
      const radians = (degrees * Math.PI) / 180;
      expect(detCos(radians)).toBeCloseTo(Math.cos(radians), 9);
    }
  });

  it('hits the exact quadrant values', () => {
    expect(detSin(0)).toBeCloseTo(0, 12);
    expect(detCos(0)).toBeCloseTo(1, 12);
    expect(detSin(Math.PI / 2)).toBeCloseTo(1, 12);
    expect(detCos(Math.PI / 2)).toBeCloseTo(0, 12);
    expect(detSin(Math.PI)).toBeCloseTo(0, 9);
    expect(detCos(Math.PI)).toBeCloseTo(-1, 12);
  });

  it('matches Math.atan2 well within a pixel', () => {
    const samples = [-8, -3, -1, -0.25, 0, 0.25, 1, 3, 8];
    for (const y of samples) {
      for (const x of samples) {
        if (x === 0 && y === 0) continue;
        expect(detAtan2(y, x)).toBeCloseTo(Math.atan2(y, x), 4);
      }
    }
  });

  it('is bit-identical when called twice', () => {
    for (let i = 0; i < 1000; i += 1) {
      const value = i * 0.017;
      expect(detSin(value)).toBe(detSin(value));
      expect(detCos(value)).toBe(detCos(value));
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

  it('computes vector length', () => {
    expect(hypot2(3, 4)).toBe(5);
    expect(hypot2(0, 0)).toBe(0);
  });
});
