/**
 * Drawing a tank.
 *
 * Three plain rectangles was the old version, and it was legible without being
 * worth looking at. This one has a hull, a turret, a barrel that points exactly
 * where the snapshot says the player is aiming, a health bar, and — the thing a
 * turn-based game actually needs — an unmissable marker over whoever is up.
 *
 * Sizes are deliberately close to the original's: the tanks are small against
 * the field, because the field is the picture.
 *
 * Reads a `TankSnapshot` and draws it. Decides nothing.
 */

import type Phaser from 'phaser';
import type { TankSnapshot } from '@scorched/protocol';
import { darken, lighten, mix } from './color.ts';

/** Tank colours, in the saturated EGA spirit of the original. */
export const TANK_COLORS: readonly number[] = [
  0x4fc3f7, // cyan
  0xef5350, // red
  0x66bb6a, // green
  0xffee58, // yellow
  0xab47bc, // magenta
  0xff9800, // orange
  0x26c6da, // teal
  0xe0e0e0, // white
];

export function tankColor(colorIndex: number): number {
  return TANK_COLORS[colorIndex % TANK_COLORS.length] ?? 0xffffff;
}

const HULL_HALF_WIDTH = 11;
const BARREL_LENGTH = 16;
/** Where the barrel is hinged, relative to the tank's ground point. */
const PIVOT_Y = -10;

/**
 * The vertical stack above a tank, measured from its ground point.
 *
 * Written down as constants because the first version collided with itself in
 * three places at once: the barrel at 90 degrees ran through the health bar,
 * the turn chevron was drawn underneath the name, and the corner ticks cut the
 * turret in half. At this size everything is within a few pixels of everything
 * else, so the layout has to be stated rather than guessed at each call site.
 *
 * Reading upward: hull, then health, then the chevron slot, then the name.
 * `BARREL_TOP` is how far the barrel reaches at 90 degrees, and is what the
 * health bar has to clear.
 */
/** How high the barrel reaches at 90 degrees. Everything else clears this. */
const BARREL_TOP = PIVOT_Y - BARREL_LENGTH;
const HEALTH_TOP = BARREL_TOP - 4;
const HEALTH_HEIGHT = 4;
const HEALTH_WIDTH = 26;
const CHEVRON_TOP = HEALTH_TOP - 11;
const CHEVRON_HEIGHT = 6;
/** Where the scene puts the name label's baseline. Exported so it stays in sync. */
export const TANK_NAME_OFFSET_Y = CHEVRON_TOP - 2;

export interface TankDrawOptions {
  readonly isActive: boolean;
  /** True while the active player is still choosing — drives the turn marker. */
  readonly isAiming: boolean;
}

/** Muzzle position for the given aim — the effect layer spawns a flash there. */
export function muzzlePoint(tank: TankSnapshot): { x: number; y: number } {
  const radians = (tank.angleDeg * Math.PI) / 180;
  return {
    x: tank.x + Math.cos(radians) * BARREL_LENGTH,
    y: tank.y + PIVOT_Y - Math.sin(radians) * BARREL_LENGTH,
  };
}

export function drawTank(
  graphics: Phaser.GameObjects.Graphics,
  tank: TankSnapshot,
  options: TankDrawOptions,
): void {
  if (!tank.alive) {
    drawWreck(graphics, tank);
    return;
  }

  const color = tankColor(tank.colorIndex);
  const shade = darken(color, 0.45);
  const highlight = lighten(color, 0.45);

  // ------------------------------------------------------------------ tracks
  graphics.fillStyle(0x15161c, 1);
  graphics.fillRect(tank.x - HULL_HALF_WIDTH, tank.y - 5, HULL_HALF_WIDTH * 2, 5);
  graphics.fillStyle(0x2c2f3a, 1);
  for (let i = 0; i < 4; i += 1) {
    graphics.fillRect(tank.x - HULL_HALF_WIDTH + 2 + i * 5, tank.y - 4, 3, 3);
  }

  // -------------------------------------------------------------------- hull
  // Slightly trapezoidal: the sloped front is most of what makes a block of
  // colour read as a vehicle at this size.
  const hull = [
    { x: tank.x - HULL_HALF_WIDTH, y: tank.y - 5 },
    { x: tank.x + HULL_HALF_WIDTH, y: tank.y - 5 },
    { x: tank.x + HULL_HALF_WIDTH - 3, y: tank.y - 11 },
    { x: tank.x - HULL_HALF_WIDTH + 3, y: tank.y - 11 },
  ];
  graphics.fillStyle(color, 1);
  graphics.fillPoints(hull, true, true);
  // A dark outline, because the terrain palette is rerolled every round and
  // sooner or later it comes up the same blue as a player. Without this the
  // tank simply disappears into the hillside on those rounds.
  graphics.lineStyle(1, 0x0e0f14, 1);
  graphics.strokePoints(hull, true, true);
  graphics.fillStyle(highlight, 1);
  graphics.fillRect(tank.x - HULL_HALF_WIDTH + 3, tank.y - 11, HULL_HALF_WIDTH * 2 - 6, 1);

  // ------------------------------------------------------------------ turret
  graphics.fillStyle(0x0e0f14, 1);
  graphics.fillRect(tank.x - 7, tank.y - 16, 14, 7);
  graphics.fillStyle(shade, 1);
  graphics.fillRect(tank.x - 6, tank.y - 15, 12, 5);
  graphics.fillStyle(color, 1);
  graphics.fillRect(tank.x - 4, tank.y - 15, 8, 2);

  // ------------------------------------------------------------------ health
  drawHealthBar(graphics, tank);

  // ------------------------------------------------------------- turn marker
  if (options.isActive) drawTurnMarker(graphics, tank, options.isAiming);

  // ------------------------------------------------------------------ barrel
  // Drawn LAST so that at a steep elevation it sweeps in front of the health
  // bar rather than being clipped by it. Draw it earlier and a tank aiming
  // near-vertically appears to have a stub.
  const radians = (tank.angleDeg * Math.PI) / 180;
  const tipX = tank.x + Math.cos(radians) * BARREL_LENGTH;
  const tipY = tank.y + PIVOT_Y - Math.sin(radians) * BARREL_LENGTH;

  // Dark backing stroke first, colour on top: a two-tone barrel stays visible
  // against both the black sky and a bright hillside.
  graphics.lineStyle(5, 0x15161c, 1);
  graphics.beginPath();
  graphics.moveTo(tank.x, tank.y + PIVOT_Y);
  graphics.lineTo(tipX, tipY);
  graphics.strokePath();

  graphics.lineStyle(3, lighten(color, 0.2), 1);
  graphics.beginPath();
  graphics.moveTo(tank.x, tank.y + PIVOT_Y);
  graphics.lineTo(tipX, tipY);
  graphics.strokePath();

  graphics.fillStyle(highlight, 1);
  graphics.fillCircle(tipX, tipY, 2);
}

function drawHealthBar(graphics: Phaser.GameObjects.Graphics, tank: TankSnapshot): void {
  const left = tank.x - HEALTH_WIDTH / 2;
  const top = tank.y + HEALTH_TOP;
  const fraction = Math.max(0, Math.min(1, tank.health / 100));

  // A grey frame rather than a black one: over a black sky, a black outline is
  // no outline, and the bar floats as a bare coloured stripe.
  graphics.fillStyle(0x585f70, 1);
  graphics.fillRect(left - 1, top - 1, HEALTH_WIDTH + 2, HEALTH_HEIGHT + 2);
  graphics.fillStyle(0x14161d, 1);
  graphics.fillRect(left, top, HEALTH_WIDTH, HEALTH_HEIGHT);
  graphics.fillStyle(healthColor(tank.health), 1);
  graphics.fillRect(left, top, HEALTH_WIDTH * fraction, HEALTH_HEIGHT);
}

/**
 * Whose turn it is.
 *
 * A chevron above the tank plus corner ticks around it. Static on purpose: a
 * pulsing marker looks better in motion and makes every captured screenshot
 * differ from the last, and screenshots are how this game is reviewed.
 *
 * The original draws a white ring around a *shielded* tank, so a ring is
 * deliberately not used here — it would mean something else to anyone who
 * played it.
 */
function drawTurnMarker(
  graphics: Phaser.GameObjects.Graphics,
  tank: TankSnapshot,
  isAiming: boolean,
): void {
  const marker = isAiming ? 0xffd24a : 0xffffff;

  graphics.fillStyle(marker, 1);
  graphics.fillTriangle(
    tank.x - 6,
    tank.y + CHEVRON_TOP,
    tank.x + 6,
    tank.y + CHEVRON_TOP,
    tank.x,
    tank.y + CHEVRON_TOP + CHEVRON_HEIGHT,
  );

  graphics.lineStyle(2, marker, 0.95);
  const left = tank.x - 17;
  const right = tank.x + 17;
  const top = tank.y - 19;
  const bottom = tank.y + 2;
  const tick = 5;
  for (const [cx, cy, dx, dy] of [
    [left, top, 1, 1],
    [right, top, -1, 1],
    [left, bottom, 1, -1],
    [right, bottom, -1, -1],
  ] as const) {
    graphics.beginPath();
    graphics.moveTo(cx + dx * tick, cy);
    graphics.lineTo(cx, cy);
    graphics.lineTo(cx, cy + dy * tick);
    graphics.strokePath();
  }
}

function drawWreck(graphics: Phaser.GameObjects.Graphics, tank: TankSnapshot): void {
  const charred = mix(darken(tankColor(tank.colorIndex), 0.82), 0x201a16, 0.6);

  graphics.fillStyle(0x0d0b0a, 1);
  graphics.fillRect(tank.x - 13, tank.y - 4, 26, 4);
  graphics.fillStyle(charred, 1);
  // Tipped over, broken-backed: a wreck should not look like a tank with the
  // colour turned down.
  graphics.fillPoints(
    [
      { x: tank.x - 11, y: tank.y - 4 },
      { x: tank.x + 12, y: tank.y - 4 },
      { x: tank.x + 7, y: tank.y - 9 },
      { x: tank.x - 6, y: tank.y - 7 },
    ],
    true,
    true,
  );
  graphics.lineStyle(2, 0x3a3330, 1);
  graphics.beginPath();
  graphics.moveTo(tank.x + 2, tank.y - 8);
  graphics.lineTo(tank.x + 13, tank.y - 15);
  graphics.strokePath();
}

export function healthColor(health: number): number {
  if (health > 60) return 0x44d15c;
  if (health > 30) return 0xffb020;
  return 0xe8402c;
}
