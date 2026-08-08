import { describe, expect, it } from 'vitest';
import { makeRng, restoreRng, hashString, normalizeSeed } from '../src/rng.ts';

describe('seeded rng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    const left = Array.from({ length: 64 }, () => a.nextU32());
    const right = Array.from({ length: 64 }, () => b.nextU32());
    expect(left).toEqual(right);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from(
      { length: 32 },
      (
        (rng) => () =>
          rng.nextU32()
      )(makeRng(1)),
    );
    const b = Array.from(
      { length: 32 },
      (
        (rng) => () =>
          rng.nextU32()
      )(makeRng(2)),
    );
    expect(a).not.toEqual(b);
  });

  it('stays inside [0, 1)', () => {
    const rng = makeRng('scorched');
    for (let i = 0; i < 10_000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('resumes exactly from a saved state', () => {
    const rng = makeRng('resume-me');
    for (let i = 0; i < 17; i += 1) rng.nextU32();

    const saved = rng.save();
    const expected = Array.from({ length: 20 }, () => rng.nextU32());
    const resumed = restoreRng(saved);
    const actual = Array.from({ length: 20 }, () => resumed.nextU32());

    expect(actual).toEqual(expected);
  });

  it('forks independent streams that do not disturb the parent', () => {
    const parent = makeRng('room:ABCD');
    const forkA = parent.fork('terrain');
    const forkB = parent.fork('terrain');
    const forkC = parent.fork('wind');

    const a = Array.from({ length: 8 }, () => forkA.nextU32());
    const b = Array.from({ length: 8 }, () => forkB.nextU32());
    const c = Array.from({ length: 8 }, () => forkC.nextU32());

    expect(a).toEqual(b); // same label → same stream
    expect(a).not.toEqual(c); // different label → different stream
  });

  it('hashes strings deterministically', () => {
    expect(hashString('ABCD')).toBe(hashString('ABCD'));
    expect(hashString('ABCD')).not.toBe(hashString('ABCE'));
    expect(normalizeSeed('ABCD')).toBe(hashString('ABCD'));
    expect(normalizeSeed(7)).toBe(7);
  });

  it('int() respects its bounds', () => {
    const rng = makeRng(99);
    for (let i = 0; i < 5_000; i += 1) {
      const value = rng.int(3, 9);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThan(9);
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});
