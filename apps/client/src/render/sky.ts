/**
 * The starfield.
 *
 * `e2e/reference/README.md` calls this "the single most recognisable thing
 * about the battlefield", and its absence "why a modern remake reads as
 * 'generic artillery game'". So: near-black, dense with white stars, no
 * gradient worth the name, nothing soft.
 *
 * Painted once per match into a canvas texture and never touched again — a
 * thousand `Graphics` circles redrawn every frame would be the same picture at
 * a hundred times the cost.
 *
 * Seeded from the match seed, so every client in the room is under the same
 * sky. Deliberately NOT `Math.random`.
 */

import type Phaser from 'phaser';
import { toCss } from './color.ts';
import { mixSeed, VisualRng } from './rng.ts';

/** Base colours. Both are near-black; the difference is barely a hint. */
const SKY_TOP = 0x03030c;
const SKY_BOTTOM = 0x090a18;

/**
 * Stars per 100x100 of sky.
 *
 * Tuned against the reference capture, where the sky is dense enough that the
 * eye reads texture rather than dots. On a 1280x720 board this is ~1150 stars.
 */
const STARS_PER_10K_PX = 12.5;

/** A faint colour cast on the brighter stars. Most stay white. */
const STAR_TINTS: readonly number[] = [
  0xffffff, 0xffffff, 0xffffff, 0xffffff, 0xffffff, 0xd8e4ff, 0xfff0d0, 0xffd8d8, 0xd8fff0,
];

export const SKY_BASE_COLOR = SKY_TOP;

/** The texture key a given sky would have. Callers compare before rebuilding. */
export function starfieldKey(seed: number, width: number, height: number): string {
  return `sky-${seed >>> 0}-${width}x${height}`;
}

/**
 * Ensure a starfield texture exists for this seed and return its key.
 *
 * Keyed by seed so a new match gets a new sky and a re-render of the same match
 * costs nothing. The previous sky is dropped rather than left to accumulate.
 */
export function ensureStarfield(
  scene: Phaser.Scene,
  seed: number,
  width: number,
  height: number,
): string {
  const key = starfieldKey(seed, width, height);
  if (scene.textures.exists(key)) return key;

  // One sky at a time. Textures are megabytes; a long session that rerolled the
  // seed would otherwise leak one per match.
  for (const existing of scene.textures.getTextureKeys()) {
    if (existing.startsWith('sky-')) scene.textures.remove(existing);
  }

  const texture = scene.textures.createCanvas(key, width, height);
  const context = texture?.getContext();
  if (texture == null || context == null) return key;

  paintSky(context, width, height, seed);
  texture.refresh();
  return key;
}

function paintSky(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  seed: number,
): void {
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, toCss(SKY_TOP));
  gradient.addColorStop(1, toCss(SKY_BOTTOM));
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  const rng = new VisualRng(mixSeed(seed, 0x5741d0));
  const count = Math.round((width * height * STARS_PER_10K_PX) / 10_000);

  for (let i = 0; i < count; i += 1) {
    // Whole pixels. A star on a half-pixel is a grey smear, and the original's
    // stars are single lit pixels.
    const x = Math.floor(rng.range(0, width));
    const y = Math.floor(rng.range(0, height));
    const roll = rng.next();

    if (roll < 0.68) {
      // The dim majority — what makes the sky read as depth rather than as dots.
      context.fillStyle = toCss(0xffffff, rng.range(0.18, 0.45));
      context.fillRect(x, y, 1, 1);
      continue;
    }

    if (roll < 0.95) {
      context.fillStyle = toCss(rng.pick(STAR_TINTS), rng.range(0.55, 0.95));
      context.fillRect(x, y, 1, 1);
      continue;
    }

    // The handful of bright ones, with a one-pixel glint so they read as stars
    // rather than as dead pixels.
    const tint = rng.pick(STAR_TINTS);
    context.fillStyle = toCss(tint, 1);
    context.fillRect(x, y, 2, 2);
    context.fillStyle = toCss(tint, 0.4);
    context.fillRect(x - 1, y, 1, 2);
    context.fillRect(x + 2, y, 1, 2);
    context.fillRect(x, y - 1, 2, 1);
    context.fillRect(x, y + 2, 2, 1);
  }
}
