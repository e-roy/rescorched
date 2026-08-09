/**
 * The look of one round, derived from the match seed.
 *
 * The original randomises the terrain colour every round and then does nothing
 * else with it: one flat saturated fill, a crisp crust line on top, and the
 * silhouette carries the picture. Copying that is most of the reason a capture
 * of this game reads as Scorched Earth rather than as an airbrushed hill.
 *
 * Everything is a pure function of `(seed, round)`, so two clients in the same
 * match paint the same colour without exchanging a byte.
 */

import { darken, lighten, mix, saturate } from './color.ts';
import { mixSeed, VisualRng } from './rng.ts';

/** Base pairs in the spirit of the EGA arsenal: loud, flat, unmistakable. */
const TERRAIN_BASES: readonly { readonly ground: number; readonly crust: number }[] = [
  { ground: 0x18a018, crust: 0x63f263 }, // the classic green of the reference shot
  { ground: 0xc07c14, crust: 0xffcf63 }, // ochre
  { ground: 0x1f74cc, crust: 0x86d6ff }, // glacier
  { ground: 0xb42424, crust: 0xff8674 }, // red rock
  { ground: 0x8b30c4, crust: 0xdc9dff }, // violet
  { ground: 0x12a493, crust: 0x63ffe2 }, // teal
  { ground: 0xa2a418, crust: 0xf4f47c }, // olive
  { ground: 0x5f6d8c, crust: 0xc6d3ec }, // slate
  { ground: 0xcf5a10, crust: 0xffb066 }, // mars
  { ground: 0x1d8f5e, crust: 0x6cf5b4 }, // jade
];

export interface RoundPalette {
  /** The single flat fill the whole battlefield is painted in. */
  readonly ground: number;
  /** The crisp line along the top of the silhouette. */
  readonly crust: number;
  /** Wide, shallow darkening around a crater. */
  readonly scorchOuter: number;
  /** The burnt floor of the crater itself. */
  readonly scorchInner: number;
  /** The crust line where it has been burnt away. */
  readonly scorchCrust: number;
  /** Thrown earth left lying around a crater. */
  readonly debris: number;
  /** Earth in flight — dirt weapons, crater ejecta. */
  readonly dirt: number;
}

export function roundPalette(seed: number, round: number): RoundPalette {
  const rng = new VisualRng(mixSeed(seed, round, 0x7e44a1));
  const base = rng.pick(TERRAIN_BASES);

  // A little jitter per round so two rounds that draw the same base are still
  // distinguishable, without ever wandering off the saturated end.
  const ground = saturate(
    mix(base.ground, rng.chance(0.5) ? 0xffffff : 0x000000, rng.range(0, 0.1)),
    1.05,
  );
  const crust = saturate(lighten(base.crust, rng.range(0, 0.08)), 1.05);

  return {
    ground,
    crust,
    // Scorch keeps a trace of the ground's hue — burnt jade is not burnt rust —
    // but almost all of its light is gone. That contrast against a flat fill is
    // what makes a crater read as ground torn out rather than as a dark shape.
    scorchOuter: mix(ground, 0x1b1108, 0.52),
    scorchInner: mix(ground, 0x0d0805, 0.88),
    // Not simply "the crust, darker": a burnt rim keeps a low ember glow, and
    // that warm edge is what separates a crater from a shadow.
    scorchCrust: mix(darken(base.crust, 0.74), 0x5a2408, 0.55),
    debris: darken(ground, 0.55),
    dirt: mix(ground, base.crust, 0.25),
  };
}
