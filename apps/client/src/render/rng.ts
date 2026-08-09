/**
 * Deterministic randomness for the RENDERER.
 *
 * This is not the game's RNG — `packages/sim` owns that, the server drives it,
 * and nothing here may ever influence an outcome. This one exists so that two
 * clients watching the same match draw the *same sky*: the starfield, the
 * per-round terrain palette and the scatter of crater debris are all seeded
 * from `snapshot.seed`, so they agree without a byte crossing the wire.
 *
 * `Math.random` would work for pixels nobody compares, and it is precisely
 * wrong for pixels two players do compare. Everything visual that persists is
 * drawn from here instead.
 */

/** mulberry32 — small, fast, and good enough for scattering stars. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fold several numbers into one 32-bit seed (FNV-1a over the low bytes).
 *
 * Used to derive a *stream* from a match seed: the sky is `mixSeed(seed, 1)`,
 * round three's palette is `mixSeed(seed, 3)`, and a crater's debris scatter is
 * `mixSeed(seed, x, radius)` — so a crater re-drawn ten times keeps the same
 * specks instead of shimmering every repaint.
 */
export function mixSeed(...values: readonly number[]): number {
  let hash = 0x811c9dc5;
  for (const value of values) {
    let bits = Math.trunc(value) >>> 0;
    for (let byte = 0; byte < 4; byte += 1) {
      hash ^= bits & 0xff;
      hash = Math.imul(hash, 0x01000193);
      bits >>>= 8;
    }
  }
  return hash >>> 0;
}

export class VisualRng {
  private readonly next01: () => number;

  constructor(seed: number) {
    this.next01 = mulberry32(seed);
  }

  /** [0, 1) */
  next(): number {
    return this.next01();
  }

  /** [min, max) */
  range(min: number, max: number): number {
    return min + this.next01() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next01() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next01() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next01() * items.length)];
    // `noUncheckedIndexedAccess` is right to complain: an empty array has no
    // element to pick. Callers pass literal tables, so this cannot fire, but a
    // thrown error beats returning `undefined` into a colour slot.
    if (item === undefined) throw new Error('VisualRng.pick called with an empty list');
    return item;
  }
}
