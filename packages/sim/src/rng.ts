/**
 * Seeded pseudo-random number generator.
 *
 * Implemented in-repo on purpose (TECH_STACK.md: "Minimal dependency count is a
 * feature"). This is the ONLY source of randomness in the entire simulation —
 * `Math.random` is banned by ESLint in this package.
 *
 * Algorithm: sfc32 (Small Fast Counting, 32-bit) seeded through splitmix32.
 * Every operation is 32-bit integer arithmetic, so results are bit-identical on
 * every JavaScript engine — which is what makes "same seed → same game" true
 * across the server (workerd) and every client browser.
 */

/** Serialisable RNG state — four 32-bit words. Persisted in DO SQLite storage. */
export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface Rng {
  /** Next raw 32-bit unsigned integer. */
  nextU32(): number;
  /** Next float in [0, 1). 32 bits of entropy. */
  next(): number;
  /** Uniform integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** True with the given probability in [0, 1]. */
  chance(probability: number): boolean;
  /** Snapshot the current state so it can be stored and resumed exactly. */
  save(): RngState;
  /**
   * Derive an independent stream from this one, labelled by `label`.
   * Used so that (say) terrain generation and wind never consume each other's
   * numbers — adding a call in one subsystem must not shift another.
   */
  fork(label: string): Rng;
}

/** splitmix32 — used to expand a single seed word into well-mixed state. */
function splitmix32(seed: number): () => number {
  let x = seed | 0;
  return () => {
    x = (x + 0x9e3779b9) | 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

/**
 * FNV-1a over UTF-16 code units. Deterministic string → 32-bit seed.
 * Room codes and fork labels are hashed with this.
 */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Normalise any seed input to a 32-bit unsigned word. */
export function normalizeSeed(seed: number | string): number {
  return typeof seed === 'number' ? seed >>> 0 : hashString(seed);
}

function makeRngFromState(state: RngState): Rng {
  let { a, b, c, d } = state;

  const nextU32 = (): number => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };

  const rng: Rng = {
    nextU32,
    next: () => nextU32() / 4294967296,
    int: (minInclusive, maxExclusive) => {
      const span = maxExclusive - minInclusive;
      if (span <= 0) return minInclusive;
      // Rejection-free: 32 bits scaled down. Bias is < 2^-32 for any span we use.
      return minInclusive + Math.floor((nextU32() / 4294967296) * span);
    },
    range: (min, max) => min + (nextU32() / 4294967296) * (max - min),
    pick: <T>(items: readonly T[]): T => {
      const index = Math.floor((nextU32() / 4294967296) * items.length);
      // `noUncheckedIndexedAccess` is on; the caller contract is a non-empty array.
      return items[index] as T;
    },
    chance: (probability) => nextU32() / 4294967296 < probability,
    save: () => ({ a: a | 0, b: b | 0, c: c | 0, d: d | 0 }),
    fork: (label) => {
      // Mix the label into a snapshot of the current state. Deterministic, and
      // independent of how many numbers the parent draws afterwards.
      const salt = hashString(label);
      return makeRng((a ^ salt) >>> 0, {
        extra: [(b ^ Math.imul(salt, 0x9e3779b9)) >>> 0, c >>> 0, d >>> 0],
      });
    },
  };

  return rng;
}

/** Create a fresh RNG from a numeric or string seed. */
export function makeRng(seed: number | string, options?: { extra?: readonly number[] }): Rng {
  const mix = splitmix32(normalizeSeed(seed));
  const state: RngState = { a: mix(), b: mix(), c: mix(), d: mix() };

  for (const word of options?.extra ?? []) {
    state.a = (state.a ^ word) | 0;
    state.b = (state.b + Math.imul(word, 0x85ebca6b)) | 0;
    state.c = (state.c ^ Math.imul(word, 0xc2b2ae35)) | 0;
    state.d = (state.d + word) | 0;
  }

  const rng = makeRngFromState(state);
  // Discard the first few outputs so low-entropy seeds (0, 1, 2 …) are well mixed.
  for (let i = 0; i < 12; i += 1) rng.nextU32();
  return rng;
}

/** Resume an RNG from a previously saved state. Bit-exact continuation. */
export function restoreRng(state: RngState): Rng {
  return makeRngFromState(state);
}
