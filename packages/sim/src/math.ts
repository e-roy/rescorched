/**
 * Deterministic math primitives.
 *
 * ECMAScript does NOT specify the exact results of `Math.sin`, `Math.cos`,
 * `Math.tan`, `Math.atan2`, `Math.pow` or `Math.exp` — engines are free to
 * differ in the last bits. Since a shot fired on the server must land in exactly
 * the same pixel on every client, the sim cannot use them.
 *
 * What IS exactly specified by IEEE-754 and safe to use: `+ - * /`,
 * `Math.sqrt`, `Math.abs`, `Math.floor`, `Math.ceil`, `Math.round`,
 * `Math.trunc`, `Math.min`, `Math.max`, and `Math.imul`.
 *
 * Everything below is built from only those, so every result here is
 * bit-identical on every engine — which is the property the game actually needs.
 *
 * Accuracy is a separate question, and it has a domain. Every `detSin`/`detCos`
 * call in this repo goes through `detSinDeg`/`detCosDeg` with an angle in
 * degrees, so the argument is small; over |x| <= 4*PI the worst deviation from
 * the engine's own `Math.sin`/`Math.cos` is below 1e-12 (measured 3.9e-13), and
 * `detAtan`/`detAtan2` are good to ~1e-15 at any magnitude.
 *
 * That last bound is nearly tight, which means the figure moves with how hard
 * you look — so each number here names the sweep that produced it, and a bare
 * "measured N" would say nothing at all. Over 200001 points of [-1, 1], where
 * `atanCore` runs alone, `detAtan` is worst by 7.8e-16; over 200001 points of
 * [1, 1.2], where it switches to the reciprocal branch and differences PI/2, by
 * 8.9e-16 — the branch, not the series, is what sets this bound. `detAtan2` is
 * worst by 8.9e-16 over the angle grid in its own test. Those three sweeps are
 * the ones `test/math.test.ts` runs, each bounded from both sides. Searching
 * harder finds a little more: t = 1 + i/4e6 for i = 0..4e6 holds exactly one
 * sample at 9.99e-16, nine ulps, and that is the largest deviation found
 * anywhere — nothing tried reaches 1e-15.
 *
 * Inside that domain the binding constraint is `cosCore`'s truncation, at
 * 3.8e-13 — NOT argument reduction, which contributes nothing measurable there.
 * Outside it the two swap places and `detSin`/`detCos` decay, because the first
 * fold in `reduceQuadrant` uses a single-double 2*PI: worst error is about
 * 8.3e-11 at |x| = 1e6, 1.0e-8 at 1e8 and 3.2e-5 at 1e12. `test/math.test.ts`
 * measures all of those — both cores separately, the decay, and the three atan
 * sweeps above — so the numbers in this header are tested facts rather than
 * footnotes. The single exception is the 9.99e-16 outlier: four million samples
 * is too slow for a unit test, so the recipe is written out instead and can be
 * rerun in a second. Determinism is unaffected either way, at every magnitude
 * and in every direction. If a caller ever needs a large argument, split TWO_PI
 * into hi/lo doubles the way HALF_PI is split below — do not just widen the
 * claim.
 */

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
export const DEG_TO_RAD = 0.017453292519943295;
export const RAD_TO_DEG = 57.29577951308232;

/**
 * PI/2 split into two doubles that sum to it exactly.
 *
 * `HALF_PI_HI` has its low mantissa bits cleared, so `k * HALF_PI_HI` is exact
 * for the small integer k that argument reduction produces, and the second
 * subtraction puts the cleared bits back without a rounding step in the middle.
 *
 * Be clear about how little this buys, because the obvious reading is wrong.
 * `HALF_PI_HI + HALF_PI_LO === HALF_PI` exactly, so what is reconstructed is
 * the DOUBLE nearest PI/2, not a wider one — the split cannot recover the
 * 6.1e-17 by which that double already misses the true PI/2. And the first fold
 * in `reduceQuadrant` leaves |k| <= 5 for every |x| up to 1e17 (measured), a
 * range over which `k * HALF_PI` barely rounds anyway.
 *
 * Measured over |x| <= 4*PI: the split changes the reduced remainder for about
 * 75% of arguments, by at most 1.25e-16 — one ulp of the remainder (it reaches
 * 3.1e-16 only out at |x| ~ 1e17, where |k| gets to 5) — and it moves the worst
 * error of `detSin` over that domain not at all (3.891e-13 split, 3.890e-13
 * single), because `cosCore`'s 3.8e-13 truncation swamps it three orders of
 * magnitude up. It is kept because it is free and correct, NOT because it is
 * what holds the accuracy claim up. That is `cosCore`'s polynomial degree.
 *
 * Concretely: substituting a single-double `HALF_PI` here leaves every test in
 * `test/math.test.ts` green. Nothing below this line is evidence that the split
 * works — do not read it as such. (Substituting a single-double is still not
 * worth doing: it changes 75% of reduced remainders, so it would move every
 * trajectory in the game by an ulp and churn the golden snapshot, for nothing.)
 */
const HALF_PI_HI = 1.5707963267341256;
const HALF_PI_LO = 6.077100506506192e-11;

/**
 * sin(x) for |x| <= PI/4. Taylor through x^13 in Horner form.
 * |error| < 3e-14 on that interval (measured worst 2.01e-14) — comfortably
 * below double rounding noise at the magnitudes this game deals in.
 */
function sinCore(x: number): number {
  const u = x * x;
  // x * (1 - u/6 + u^2/120 - u^3/5040 + u^4/362880 - u^5/39916800 + u^6/6227020800)
  let p = 1 / 6227020800;
  p = p * u - 1 / 39916800;
  p = p * u + 1 / 362880;
  p = p * u - 1 / 5040;
  p = p * u + 1 / 120;
  p = p * u - 1 / 6;
  p = p * u + 1;
  return x * p;
}

/**
 * cos(x) for |x| <= PI/4. Taylor through x^12.
 *
 * |error| < 4e-13 on that interval (measured worst 3.83e-13 near the ends).
 * This is the largest error anywhere in this file over the domain the sim uses,
 * and it is truncation, not rounding: the first omitted term is x^14/14!, which
 * is 3.90e-13 at x = PI/4 and 3.84e-13 at 0.999*PI/4 — the endpoint of the
 * sweep that measured the 3.83e-13 above, and the two agree to 0.24%. That
 * agreement is the actual evidence for "truncation, not rounding"; a figure
 * that missed by a factor would be evidence against it. `sinCore` runs two
 * orders further in x for the same six multiply-adds, which is why it lands at
 * 2e-14 instead.
 *
 * If a caller ever needs better than 1e-12 here, add the x^14 term — do not
 * restate the bound. Note that `detSin` routes through this function in
 * quadrants 1 and 3, so this is the error of sin(45 degrees) too, not some
 * corner case: `test/math.test.ts` measures both cores separately.
 */
function cosCore(x: number): number {
  const u = x * x;
  // 1 - u/2 + u^2/24 - u^3/720 + u^4/40320 - u^5/3628800 + u^6/479001600
  let p = 1 / 479001600;
  p = p * u - 1 / 3628800;
  p = p * u + 1 / 40320;
  p = p * u - 1 / 720;
  p = p * u + 1 / 24;
  p = p * u - 1 / 2;
  p = p * u + 1;
  return p;
}

/**
 * Reduce `x` to a remainder in [-PI/4, PI/4] plus a quadrant index 0..3.
 * Only `+ - * /` and `Math.round`, all exactly specified, so the result is
 * bit-identical on every engine.
 *
 * The first fold is what limits this file at LARGE arguments: `TWO_PI` is one
 * double, so `Math.round(x / TWO_PI) * TWO_PI` carries the ~1e-16 relative
 * error of that constant scaled by the turn count. That is invisible for the
 * angles the sim uses (under a handful of turns), where `cosCore`'s 3.8e-13
 * truncation is three orders of magnitude larger and sets the file's real
 * bound; it overtakes `cosCore` somewhere past |x| ~ 1e5 and dominates from
 * there. See the file header for the measured figures at both ends.
 */
function reduceQuadrant(x: number): { r: number; quadrant: number } {
  // First fold into [-PI, PI] so the second reduction only ever sees small k.
  const folded = x - Math.round(x / TWO_PI) * TWO_PI;
  const k = Math.round(folded / HALF_PI);
  const r = folded - k * HALF_PI_HI - k * HALF_PI_LO;
  return { r, quadrant: ((k % 4) + 4) % 4 };
}

/** Deterministic sine. Bit-identical on every JS engine. */
export function detSin(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  const { r, quadrant } = reduceQuadrant(x);
  switch (quadrant) {
    case 0:
      return sinCore(r);
    case 1:
      return cosCore(r);
    case 2:
      return -sinCore(r);
    default:
      return -cosCore(r);
  }
}

/** Deterministic cosine. */
export function detCos(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  const { r, quadrant } = reduceQuadrant(x);
  switch (quadrant) {
    case 0:
      return cosCore(r);
    case 1:
      return -sinCore(r);
    case 2:
      return -cosCore(r);
    default:
      return sinCore(r);
  }
}

/** Deterministic sine of an angle given in degrees. */
export function detSinDeg(degrees: number): number {
  return detSin(degrees * DEG_TO_RAD);
}

/** Deterministic cosine of an angle given in degrees. */
export function detCosDeg(degrees: number): number {
  return detCos(degrees * DEG_TO_RAD);
}

/** PI/4 and 3*PI/4. Dividing a double by a power of two is exact. */
const QUARTER_PI = PI / 4;
const THREE_QUARTER_PI = PI - QUARTER_PI;

/**
 * atan(x) for 0 <= x <= 1.
 *
 * Three applications of the half-angle identity
 *
 *     atan(t) = 2 * atan( t / (1 + sqrt(1 + t*t)) )
 *
 * shrink the argument from tan(PI/4) = 1 down to tan(PI/32) = 0.09849140335716425
 * exactly, where the odd Taylor series through t^13 has a truncation error of
 * 5.55e-17 (measured against `Math.atan` at that exact t).
 *
 * Do not read that 5.55e-17 as the accuracy of the result. Undoing the three
 * halvings multiplies it by 8, so the series alone puts about 4.4e-16 into the
 * returned angle, and rounding through the reduction adds the rest — which is
 * why `detAtan` measures around 1e-15 rather than 1e-17. Measured directly:
 * extending the series by a t^15 term drops the worst error on |x| <= 1 from
 * 7.8e-16 to 4.4e-16 and no further, so roughly half of what is left is
 * truncation and the other half is rounding. (Do not make that change casually
 * — `test/math.test.ts` bounds these from both sides precisely so it cannot
 * happen silently, and it would churn the golden snapshot.)
 *
 * The comparison that makes the case for the halvings is against the same
 * series without them, since that is the one-line simplification someone will
 * be tempted to make: straight on [0,1] it is worst by 3.55e-2 at t = 1,
 * against the ~1e-15 `detAtan` actually achieves. Three square roots buy about
 * thirteen decimal digits, which is cheap at the rate this is called.
 *
 * Every operation here is exactly specified: `Math.sqrt` is correctly rounded by
 * IEEE-754, and the rest is + - * /.
 */
function atanCore(x: number): number {
  let t = x;
  t = t / (1 + Math.sqrt(1 + t * t));
  t = t / (1 + Math.sqrt(1 + t * t));
  t = t / (1 + Math.sqrt(1 + t * t));

  // t - t^3/3 + t^5/5 - t^7/7 + t^9/9 - t^11/11 + t^13/13, Horner form.
  const u = t * t;
  let p = 1 / 13;
  p = p * u - 1 / 11;
  p = p * u + 1 / 9;
  p = p * u - 1 / 7;
  p = p * u + 1 / 5;
  p = p * u - 1 / 3;
  p = p * u + 1;

  // Undo the three halvings. 8 is a power of two, so this multiply is exact.
  return 8 * (t * p);
}

/** Deterministic atan. Accurate to ~1e-15 rad; bit-identical on every engine. */
export function detAtan(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Infinity) return HALF_PI;
  if (x === -Infinity) return -HALF_PI;
  const abs = Math.abs(x);
  // For |x| > 1 flip into the interval the core is built for. The subtraction
  // loses nothing: atan(1/abs) is at most PI/4, so there is no cancellation.
  const result = abs <= 1 ? atanCore(abs) : HALF_PI - atanCore(1 / abs);
  return x < 0 || Object.is(x, -0) ? -result : result;
}

/**
 * Deterministic atan2, matching `Math.atan2` including its signed-zero and
 * infinity conventions.
 *
 * Nothing in the sim computes an angle from a vector today, so this and
 * `detAtan` have no call sites — they exist because `Math.atan2` is banned in
 * this package and the first feature that needs a heading (a guided weapon, a
 * turret readout) must not have to invent one under deadline. The signed-zero
 * and infinity cases are the fiddly part and are pinned against the engine in
 * `test/math.test.ts`; they decide which side of the branch cut a direction
 * falls on, and getting one wrong flips an angle by a whole PI.
 */
export function detAtan2(y: number, x: number): number {
  if (Number.isNaN(y) || Number.isNaN(x)) return Number.NaN;

  const yNegative = y < 0 || Object.is(y, -0);
  const sign = yNegative ? -1 : 1;
  const yInfinite = y === Infinity || y === -Infinity;
  const xInfinite = x === Infinity || x === -Infinity;

  if (yInfinite || xInfinite) {
    if (yInfinite && xInfinite) return sign * (x > 0 ? QUARTER_PI : THREE_QUARTER_PI);
    if (yInfinite) return sign * HALF_PI;
    return x > 0 ? sign * 0 : sign * PI;
  }

  if (y === 0) {
    // atan2(+0, -0) is +PI, atan2(+0, +0) is +0: the sign of a zero x is the
    // only thing distinguishing "due right" from "due left" here.
    const xNegative = x < 0 || Object.is(x, -0);
    return xNegative ? sign * PI : sign * 0;
  }
  if (x === 0) return sign * HALF_PI;

  if (x > 0) return detAtan(y / x);
  return y > 0 ? detAtan(y / x) + PI : detAtan(y / x) - PI;
}

/** Length of a 2D vector. `Math.sqrt` is exactly rounded, so this is portable. */
export function hypot2(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wrap an angle in degrees into [0, 360). */
export function wrapDegrees(degrees: number): number {
  const wrapped = degrees - Math.floor(degrees / 360) * 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}
