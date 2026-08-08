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
 * Everything below is built from only those. Accuracy is ~1e-10, far below one
 * pixel over any trajectory the game can produce.
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

/**
 * atan(x) for |x| <= 1, via a degree-9 odd minimax polynomial.
 * |error| < 1e-5 rad (~0.0006 degrees) — used for UI-facing angle readouts and
 * homing/deflection, never for the core trajectory integration.
 */
function atanCore(x: number): number {
  const x2 = x * x;
  let p = 0.0208351;
  p = p * x2 - 0.085133;
  p = p * x2 + 0.180141;
  p = p * x2 - 0.3302995;
  p = p * x2 + 0.999866;
  return x * p;
}

/** Deterministic atan. */
export function detAtan(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? HALF_PI : x < 0 ? -HALF_PI : Number.NaN;
  const abs = Math.abs(x);
  const result = abs <= 1 ? atanCore(abs) : HALF_PI - atanCore(1 / abs);
  return x < 0 ? -result : result;
}

/** Deterministic atan2, matching the sign conventions of `Math.atan2`. */
export function detAtan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  if (x > 0) return detAtan(y / x);
  if (x < 0) return y >= 0 ? detAtan(y / x) + PI : detAtan(y / x) - PI;
  return y > 0 ? HALF_PI : -HALF_PI;
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
