/**
 * Presentation-only formatting. Nothing here decides anything about the game —
 * it turns numbers the server sent into the strings a player reads.
 */

import { getWeapon } from '@scorched/sim';
import { TANK_COLORS } from '../scenes/battle.ts';

/**
 * The DOM swatch for a tank colour.
 *
 * Deliberately reads the SAME table the Phaser scene draws tanks from. A second
 * palette in the overlay would drift, and then the swatch next to a player's
 * name would name a different tank than the one that is about to fire.
 */
export function colorCss(index: number): string {
  const color = TANK_COLORS[index % TANK_COLORS.length] ?? 0xffffff;
  return `#${color.toString(16).padStart(6, '0')}`;
}

export function money(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

/** Ammo count, with the free weapon's unlimited supply shown as an infinity. */
export function ammo(count: number): string {
  return Number.isFinite(count) ? String(count) : '∞';
}

export function weaponName(id: string): string {
  return getWeapon(id)?.name ?? id;
}

/** Health as a percentage bucket, so colour and label agree everywhere. */
export function hurtLevel(health: number): 'fine' | 'some' | 'bad' {
  if (health <= 25) return 'bad';
  if (health <= 60) return 'some';
  return 'fine';
}

const WIND_LEFT = '←';
const WIND_RIGHT = '→';
const WIND_CALM = '·';

/** Below this the wind is not worth aiming off for, and the gauge says so. */
export const WIND_CALM_THRESHOLD = 0.05;

export interface WindReadout {
  arrow: string;
  magnitude: string;
  calm: boolean;
  direction: 'left' | 'right';
}

export function readWind(wind: number): WindReadout {
  const calm = Math.abs(wind) < WIND_CALM_THRESHOLD;
  return {
    arrow: calm ? WIND_CALM : wind > 0 ? WIND_RIGHT : WIND_LEFT,
    magnitude: Math.abs(wind).toFixed(1),
    calm,
    direction: wind < 0 ? 'left' : 'right',
  };
}

/** `m:ss`, for the turn clock. */
export function clock(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** "Alice", "Alice and Bob", "Alice, Bob and Carol" — for waiting-on messages. */
export function listNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] ?? '';
  const head = names.slice(0, -1).join(', ');
  return `${head} and ${names[names.length - 1] ?? ''}`;
}
