/**
 * Painting the battlefield.
 *
 * Two ideas, both stolen straight from the 1991 original:
 *
 * 1. **The ground is one flat saturated colour.** No gradient, no texture. A
 *    vertical fade turns a battlefield into an airbrushed hill; the silhouette
 *    is supposed to do all the work, and it can only do that if nothing else is
 *    competing with it.
 * 2. **The crust is a crisp line.** One bright stroke along the top edge, which
 *    is what makes a ridge look like a ridge rather than like a filled polygon.
 *
 * On top of that this file adds the thing the original leaves to the imagination
 * and a remake cannot: craters that read. A blast leaves a *decal* — remembered
 * for the round, repainted with the terrain — that darkens the bowl, burns the
 * crust line away over the rim, and throws debris onto the ground nearby. The
 * heightmap is authoritative about the shape; the decal is what makes the shape
 * legible as damage.
 *
 * The heightmap itself is never invented here. Every column comes from the
 * server's snapshot.
 */

import { toCss } from './color.ts';
import type { RoundPalette } from './palette.ts';
import { mixSeed, VisualRng } from './rng.ts';

/** A remembered blast: enough to repaint its scar on any later redraw. */
export interface ScorchDecal {
  readonly x: number;
  readonly radius: number;
  /** Dirt weapons scar nothing — they leave fresh earth, not a burn. */
  readonly burnt: boolean;
}

/**
 * How many scars one round keeps.
 *
 * A long round with cluster weapons produces hundreds; past a point they merge
 * into a uniform smear that reads as "the map is dark" rather than as damage,
 * and each one costs a repaint. The oldest go first.
 */
const MAX_DECALS = 220;

/**
 * Blasts closer than this fraction of the larger radius are the same scar.
 *
 * Without it a Sandhog — which detonates repeatedly down one column — stacks
 * eight identical decals on one x, and the scorch there goes from "burnt" to
 * "black hole" while costing eight times as much to draw.
 */
const MERGE_FRACTION = 0.45;

/**
 * How far the scorch reaches, as a fraction of the blast that made it.
 *
 * `SCORCH_RIM` is the outer edge of the burn and `SCORCH_FLOOR` the dark bowl
 * inside it. Both are at or inside 1, which is the point: `applyCrater` removes
 * ground out to exactly the blast radius, so anything past 1 is paint on ground
 * that is still there — and a wide band of half-dark paint around a hole is
 * read as a soft glow no matter how hard its edge is. See `paintTerrain`.
 */
const SCORCH_RIM = 1;
const SCORCH_FLOOR = 0.78;

/** Add a scar, merging it into a neighbouring one where they are the same hole. */
export function addDecal(decals: ScorchDecal[], next: ScorchDecal): void {
  for (let i = 0; i < decals.length; i += 1) {
    const existing = decals[i];
    if (existing === undefined) continue;
    if (existing.burnt !== next.burnt) continue;
    const larger = Math.max(existing.radius, next.radius);
    if (Math.abs(existing.x - next.x) <= larger * MERGE_FRACTION) {
      decals[i] = {
        x: (existing.x + next.x) / 2,
        radius: larger,
        burnt: next.burnt,
      };
      return;
    }
  }
  decals.push(next);
  if (decals.length > MAX_DECALS) decals.splice(0, decals.length - MAX_DECALS);
}

export interface TerrainPaintOptions {
  readonly surface: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly palette: RoundPalette;
  readonly decals: readonly ScorchDecal[];
  /** Match seed — debris scatter is derived from it so repaints are stable. */
  readonly seed: number;
}

export function paintTerrain(
  context: CanvasRenderingContext2D,
  options: TerrainPaintOptions,
): void {
  const { surface, width, height, palette, decals, seed } = options;

  context.clearRect(0, 0, width, height);

  // ---------------------------------------------------------------- the fill
  tracePath(context, surface, width, height);
  context.fillStyle = toCss(palette.ground);
  context.fill();

  // ------------------------------------------------------------- the scarring
  // One clip for every decal. Clipping is the expensive part of this function,
  // and doing it per decal on a map with two hundred of them is the difference
  // between a repaint you cannot see and one you can.
  if (decals.length > 0) {
    context.save();
    tracePath(context, surface, width, height);
    context.clip();

    for (const decal of decals) {
      const y = surfaceAt(surface, decal.x, height);
      if (decal.burnt) {
        /*
         * The burn stops where the hole does.
         *
         * `reference/README.md` is explicit that the original has "hard edges,
         * no soft glow, no blur", and these two discs are the only thing on
         * screen that can break it. There is no gradient here and never was —
         * what read as an airbrushed bruise was geometry: an outer disc at
         * 1.25x the blast laid a wide band of darkening over shoulders the
         * heightmap had not touched, and the eye reads a big soft-coloured
         * surround as a halo whatever its edge is doing.
         *
         * At 1.0 the outer disc is a RIM — a couple of pixels of burn around
         * the lip — and everything darker than the ground is inside the hole
         * the crater actually made. It was 1.45 before it was 1.25, and both
         * were moves in this direction; this is the end of that road, because
         * the blast radius is exactly the ground `applyCrater` removes.
         */
        context.fillStyle = toCss(palette.scorchOuter);
        fillDisc(context, decal.x, y, decal.radius * SCORCH_RIM);
        context.fillStyle = toCss(palette.scorchInner);
        fillDisc(context, decal.x, y, decal.radius * SCORCH_FLOOR);
      } else {
        // Fresh earth: a lighter patch, so a Dirt Clod is visibly *added*
        // ground rather than a change in the silhouette nobody notices.
        context.fillStyle = toCss(palette.dirt);
        fillDisc(context, decal.x, y, decal.radius * 1.1);
      }
    }

    for (const decal of decals) {
      paintDebris(context, surface, height, decal, palette, seed);
    }

    context.restore();
  }

  // --------------------------------------------------------------- the crust
  context.lineJoin = 'round';
  context.lineCap = 'round';
  strokeSurface(context, surface, 0, width - 1, palette.crust, 2);

  // Burn the crust away over each crater, wide-and-faint then narrow-and-black.
  // Two strokes per decal is cheap and gives the rim a gradient the eye reads
  // as heat without a single soft edge.
  for (const decal of decals) {
    if (!decal.burnt) {
      strokeSurface(
        context,
        surface,
        decal.x - decal.radius * 1.05,
        decal.x + decal.radius * 1.05,
        palette.dirt,
        2,
      );
      continue;
    }
    // Kept inside the rim for the same reason the discs are: a burnt crust line
    // running a third of a radius out past the hole is a smudge on ground that
    // was never removed.
    strokeSurface(
      context,
      surface,
      decal.x - decal.radius * SCORCH_RIM,
      decal.x + decal.radius * SCORCH_RIM,
      palette.scorchCrust,
      2,
    );
    strokeSurface(
      context,
      surface,
      decal.x - decal.radius * SCORCH_FLOOR,
      decal.x + decal.radius * SCORCH_FLOOR,
      palette.scorchInner,
      3,
    );
  }
}

/** The whole ground silhouette as one closed path, ready to fill or clip. */
function tracePath(
  context: CanvasRenderingContext2D,
  surface: readonly number[],
  width: number,
  height: number,
): void {
  context.beginPath();
  context.moveTo(0, height);
  for (let x = 0; x < width; x += 1) {
    context.lineTo(x, surface[x] ?? height);
  }
  context.lineTo(width - 1, height);
  context.closePath();
}

function strokeSurface(
  context: CanvasRenderingContext2D,
  surface: readonly number[],
  fromX: number,
  toX: number,
  color: number,
  lineWidth: number,
): void {
  const start = Math.max(0, Math.floor(fromX));
  const end = Math.min(surface.length - 1, Math.ceil(toX));
  if (end <= start) return;

  context.beginPath();
  for (let x = start; x <= end; x += 1) {
    const y = surface[x] ?? 0;
    if (x === start) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.strokeStyle = toCss(color);
  context.lineWidth = lineWidth;
  context.stroke();
}

/**
 * Hard-edged disc.
 *
 * `arc` on a 2D context antialiases its edge, which is exactly the soft look
 * this whole file exists to avoid; but inside a clip against a hard-edged
 * polygon the two blend, and the alternative — stepping the disc column by
 * column — costs more than it buys at these radii. The edge stays crisp because
 * the colours either side of it are far apart.
 */
function fillDisc(context: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  context.beginPath();
  context.arc(x, y, Math.max(1, radius), 0, Math.PI * 2);
  context.fill();
}

function surfaceAt(surface: readonly number[], x: number, fallback: number): number {
  const index = Math.round(x);
  if (index < 0) return surface[0] ?? fallback;
  if (index >= surface.length) return surface[surface.length - 1] ?? fallback;
  return surface[index] ?? fallback;
}

/**
 * Earth thrown clear of the blast and left lying on the ground.
 *
 * Seeded from the crater's own position, so the same crater keeps the same
 * specks across every repaint — otherwise the whole map shimmers each time a
 * snapshot lands.
 */
function paintDebris(
  context: CanvasRenderingContext2D,
  surface: readonly number[],
  height: number,
  decal: ScorchDecal,
  palette: RoundPalette,
  seed: number,
): void {
  // Fewer, and thrown less far, than they were. Ejecta scattered out to 2.8
  // radii is the other half of what made a fresh crater read as an airbrushed
  // bruise: a wide stipple of dark specks over untouched ground shades it.
  const count = Math.round(Math.min(24, 6 + decal.radius * 0.34));
  const rng = new VisualRng(mixSeed(seed, Math.round(decal.x), Math.round(decal.radius)));

  // Two tones, alternating.
  //
  // A single mid-dark speck on a flat mid-bright fill is invisible at the
  // distance a player actually looks at the board — the first version of this
  // used `palette.debris` alone and the thrown earth simply did not exist on
  // screen. Pairing near-black with bright ejecta means every speck contrasts
  // against whatever it lands on, burnt ground or clean ground.
  const dark = toCss(palette.scorchInner);
  const light = toCss(decal.burnt ? palette.crust : palette.dirt);

  for (let i = 0; i < count; i += 1) {
    const side = rng.chance(0.5) ? 1 : -1;
    const x = Math.round(decal.x + side * rng.range(decal.radius * 0.95, decal.radius * 1.8));
    if (x < 0 || x >= surface.length) continue;
    const y = Math.round(surfaceAt(surface, x, height) + rng.range(0, 7));
    const size = rng.int(1, 3);
    context.fillStyle = rng.chance(0.45) ? light : dark;
    context.fillRect(x, y, size, size);
  }
}
