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
 * the engine's own `Math.sin`/`Math.cos` is below 1e-12, and `detAtan`/
 * `detAtan2` are good to ~1e-15 at any magnitude. Outside that band `detSin`
 * and `detCos` decay, because the first argument fold in `reduceQuadrant` uses
 * a single-double 2*PI: worst error is about 8e-11 at |x| = 1e6, 6e-9 at 1e8
 * and 3e-5 at 1e12. `test/math.test.ts` measures all of those, including the
 * decay, so the limit is a tested fact rather than a footnote. Determinism is
 * unaffected either way. If a caller ever needs a large argument, split TWO_PI
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
 * for the small integer k that argument reduction produces. Subtracting the two
 * halves separately keeps ~20 extra bits of accuracy that a single subtraction
 * would throw away — which is the difference between cos(0) coming back as 1
 * and coming back as 1.0000000007.
 */
const HALF_PI_HI = 1.5707963267341256;
const HALF_PI_LO = 6.077100506506192e-11;

/**
 * sin(x) for |x| <= PI/4. Taylor through x^13 in Horner form.
 * |error| < 3e-14 on that interval — comfortably below double rounding noise
 * at the magnitudes this game deals in.
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

/** cos(x) for |x| <= PI/4. Taylor through x^12. |error| < 1e-15. */
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
 * The first fold is the accuracy limit of the whole file: `TWO_PI` is one
 * double, so `Math.round(x / TWO_PI) * TWO_PI` carries the ~1e-16 relative
 * error of that constant scaled by the turn count. Harmless for the angles the
 * sim uses (under a handful of turns), visible past |x| ~ 1e5. See the file
 * header.
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
 * shrink the argument from tan(PI/4) = 1 down to tan(PI/32) ~= 0.0985, where the
 * odd Taylor series through t^13 has a truncation error below 1e-16 — so the
 * result is accurate to the last couple of bits rather than the ~1e-5 a bare
 * minimax polynomial on [0,1] manages. Three square roots buy ten decimal
 * digits, which is cheap at the rate this is called.
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
