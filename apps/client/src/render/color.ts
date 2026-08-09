/**
 * Colour arithmetic for the renderer.
 *
 * Packed 24-bit integers everywhere, because that is what Phaser's `fillStyle`
 * and `lineStyle` take. The only reason a string appears is the 2D canvas
 * context, which wants CSS — hence `toCss`.
 *
 * Nothing here knows a game rule. It is arithmetic on colours.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export function toRgb(color: number): Rgb {
  return { r: (color >> 16) & 0xff, g: (color >> 8) & 0xff, b: color & 0xff };
}

export function fromRgb(r: number, g: number, b: number): number {
  const clampByte = (value: number): number =>
    value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
  return (clampByte(r) << 16) | (clampByte(g) << 8) | clampByte(b);
}

/** Linear blend. `t = 0` is `a`, `t = 1` is `b`. */
export function mix(a: number, b: number, t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const from = toRgb(a);
  const to = toRgb(b);
  return fromRgb(
    from.r + (to.r - from.r) * clamped,
    from.g + (to.g - from.g) * clamped,
    from.b + (to.b - from.b) * clamped,
  );
}

/** Scale every channel. `factor < 1` darkens. */
export function scale(color: number, factor: number): number {
  const { r, g, b } = toRgb(color);
  return fromRgb(r * factor, g * factor, b * factor);
}

/** Blend toward white. */
export function lighten(color: number, t: number): number {
  return mix(color, 0xffffff, t);
}

/** Blend toward black. */
export function darken(color: number, t: number): number {
  return mix(color, 0x000000, t);
}

/**
 * Push a colour away from grey.
 *
 * The original's terrain reads as a poster colour, not as a photograph, and the
 * cheapest way to get there is to stretch each channel away from its own
 * luminance rather than to hand-pick a second palette.
 */
export function saturate(color: number, amount: number): number {
  const { r, g, b } = toRgb(color);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return fromRgb(
    luma + (r - luma) * amount,
    luma + (g - luma) * amount,
    luma + (b - luma) * amount,
  );
}

export function toCss(color: number, alpha = 1): string {
  if (alpha >= 1) return `#${(color >>> 0).toString(16).padStart(6, '0')}`;
  const { r, g, b } = toRgb(color);
  return `rgba(${r},${g},${b},${alpha})`;
}
