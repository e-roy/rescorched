/**
 * Explosions with weight.
 *
 * The reference is explicit: "filled circles of saturated red and orange,
 * stacked, with hard edges. No soft glow, no blur." So a blast here is a stack
 * of concentric FILLED circles at full alpha, drawn white-hot in the middle and
 * dark red at the shell, expanding fast and then burning down. Nothing fades
 * from the edge inwards; the edge stays an edge until the whole thing goes.
 *
 * The other half of the job is that the arsenal spans a Baby Missile at 18 px
 * and a Death's Head at 120, and those must not look like the same event at two
 * sizes. Duration, ring, debris count, camera shake and the screen flash are all
 * functions of radius, and three of them do not switch on at all below the
 * middle of the range — so a Baby Missile is a firecracker and a Nuke moves the
 * camera.
 *
 * `radius` comes from the server's `explosion` event. This file never decides
 * how big anything is.
 */

import type Phaser from 'phaser';
import { mix } from './color.ts';
import type { RoundPalette } from './palette.ts';

/** One filled circle in the stack, as a fraction of the current fireball. */
interface BlastRing {
  readonly scale: number;
  readonly color: number;
  /**
   * Core rings collapse as the fireball burns down; shell rings do not. That
   * difference is what makes the fire look like it is being consumed rather
   * than simply scaled up and switched off.
   */
  readonly core: boolean;
}

export interface BlastStyle {
  readonly rings: readonly BlastRing[];
  readonly durationMs: number;
  /** Expanding stroked shockwave. Big weapons only. */
  readonly shockwave: boolean;
  readonly shockwaveColor: number;
  readonly debris: number;
  readonly sparks: number;
  readonly flame: number;
  readonly debrisColors: readonly number[];
  /** Camera shake amplitude, as a fraction of the viewport. 0 = none. */
  readonly shake: number;
  readonly shakeMs: number;
  /** Whole-screen white flash alpha. 0 = none. */
  readonly flash: number;
}

const FIRE_RINGS: readonly BlastRing[] = [
  { scale: 1.0, color: 0x8c1400, core: false },
  { scale: 0.84, color: 0xd93b00, core: false },
  { scale: 0.62, color: 0xff7a00, core: true },
  { scale: 0.4, color: 0xffcc00, core: true },
  { scale: 0.19, color: 0xfff6d0, core: true },
];

const NAPALM_RINGS: readonly BlastRing[] = [
  { scale: 1.0, color: 0xb43000, core: false },
  { scale: 0.85, color: 0xff6a00, core: false },
  { scale: 0.64, color: 0xffa020, core: true },
  { scale: 0.42, color: 0xffe066, core: true },
  { scale: 0.2, color: 0xfffbe0, core: true },
];

/**
 * How a weapon's detonation kind changes the look.
 *
 * This is cosmetic classification, not a rule: the sim decides what a weapon
 * does, and the string arrives on the event. The renderer only decides whether
 * to draw it orange or brown.
 */
export type BlastKind = 'fire' | 'napalm' | 'dirt' | 'death';

export function blastStyle(kind: BlastKind, radius: number, palette: RoundPalette): BlastStyle {
  // Where this blast sits in the arsenal's range — a Baby Missile is ~0, a
  // Death's Head is 1. Everything that should only happen for the big ones is
  // scaled off this rather than off raw pixels.
  const heft = clamp((radius - 18) / 82, 0, 1);

  if (kind === 'dirt') {
    return {
      rings: [
        { scale: 1.0, color: mix(palette.dirt, 0x000000, 0.35), core: false },
        { scale: 0.7, color: palette.dirt, core: true },
        { scale: 0.36, color: mix(palette.dirt, 0xffffff, 0.3), core: true },
      ],
      durationMs: 190 + radius * 1.6,
      shockwave: false,
      shockwaveColor: palette.dirt,
      debris: 0,
      sparks: 0,
      flame: 0,
      debrisColors: [palette.dirt, palette.debris],
      shake: heft * 0.004,
      shakeMs: 140 + radius,
      flash: 0,
    };
  }

  if (kind === 'napalm') {
    return {
      rings: NAPALM_RINGS,
      durationMs: 220 + radius * 3,
      shockwave: false,
      shockwaveColor: 0xffb84a,
      debris: Math.round(6 + radius * 0.2),
      sparks: Math.round(8 + radius * 0.4),
      flame: Math.round(14 + radius * 0.9),
      debrisColors: [0xff8c1a, 0xffc247, 0x7a2a06],
      shake: heft * 0.006,
      shakeMs: 160 + radius * 2,
      flash: 0,
    };
  }

  if (kind === 'death') {
    return {
      rings: FIRE_RINGS,
      durationMs: 420,
      shockwave: true,
      shockwaveColor: 0xffd9a0,
      debris: 46,
      sparks: 34,
      flame: 0,
      debrisColors: [0x3a3330, 0x6b5b4a, 0xff7a00, 0x151314],
      shake: 0.008,
      shakeMs: 320,
      flash: 0.18,
    };
  }

  return {
    rings: FIRE_RINGS,
    durationMs: 200 + radius * 3.4,
    // A shockwave ring on a Baby Missile is noise; on a Nuke it is the point.
    shockwave: radius >= 40,
    shockwaveColor: 0xffe6b0,
    debris: Math.round(8 + radius * 0.62),
    sparks: Math.round(6 + radius * 0.5),
    flame: 0,
    debrisColors: [palette.debris, palette.ground, 0xff8c1a, 0x2a211a],
    // No shake at all below a Missile. The floor matters more than the ceiling:
    // if every shot shakes the camera, none of them do.
    shake: radius < 26 ? 0 : clamp((radius - 26) * 0.00028, 0, 0.02),
    shakeMs: 120 + radius * 4,
    flash: radius >= 55 ? clamp((radius - 55) * 0.004, 0, 0.28) : 0,
  };
}

/**
 * Draw one frame of a blast. `t` runs 0 → 1 over `style.durationMs`.
 *
 * Called from a tween's `onUpdate`, so it must be cheap and must fully repaint:
 * it clears and redraws every ring each frame.
 */
export function drawBlast(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  radius: number,
  t: number,
  style: BlastStyle,
): void {
  graphics.clear();

  // Out fast, then hold: an explosion reaches most of its size almost at once.
  const grow = 1 - (1 - t) * (1 - t) * (1 - t);
  const outer = radius * (0.3 + 0.78 * grow);

  // The core burns down through the back half while the shell stays put.
  const burn = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
  // Alpha is held at 1 until the very end. Fading a fireball out over its whole
  // life is what makes soft explosions soft.
  const alpha = t < 0.86 ? 1 : Math.max(0, 1 - (t - 0.86) / 0.14);

  for (const ring of style.rings) {
    const r = outer * ring.scale * (ring.core ? burn : 1);
    if (r < 0.6) continue;
    graphics.fillStyle(ring.color, alpha);
    graphics.fillCircle(x, y, r);
  }

  if (style.shockwave) {
    // Two strokes and a square-law fade. A single thin stroke at a linear fade
    // hangs around for the whole blast and reads as a drawn circle — a compass
    // arc over the battlefield rather than a pressure front leaving it.
    const waveRadius = radius * (0.7 + 1.4 * grow);
    const fade = (1 - t) * (1 - t);
    graphics.lineStyle(Math.max(3, radius * 0.09), style.shockwaveColor, fade * 0.45);
    graphics.strokeCircle(x, y, waveRadius);
    graphics.lineStyle(Math.max(1, radius * 0.03), 0xffffff, fade * 0.9);
    graphics.strokeCircle(x, y, waveRadius);
  }
}

/** The muzzle flare when a shell leaves the barrel. Small, bright, brief. */
export function drawMuzzleFlash(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  t: number,
): void {
  graphics.clear();
  const r = 9 * (1 - t) + 3;
  graphics.fillStyle(0xffb02a, 1 - t);
  graphics.fillCircle(x, y, r);
  graphics.fillStyle(0xfff4c0, 1 - t);
  graphics.fillCircle(x, y, r * 0.5);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
