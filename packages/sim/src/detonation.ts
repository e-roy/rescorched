/**
 * What a weapon does when it stops flying.
 *
 * Split out from `game.ts` on purpose: the turn state machine cares about
 * whose turn it is and when a round ends, while this file cares about craters,
 * blast falloff and how a roller picks its direction. They change for
 * completely different reasons and are worked on by different people.
 *
 * `game.ts` calls `detonate()` and does not otherwise know how any individual
 * weapon behaves.
 */

import { clamp, hypot2 } from './math.ts';
import { applyCrater, applyMound, surfaceAt, type Terrain } from './terrain.ts';
import type { Rng } from './rng.ts';
import { damageAtDistance, type WeaponDef } from './weapons.ts';

/**
 * The slice of game state a detonation is allowed to touch.
 *
 * Deliberately narrow: a weapon can reshape the terrain and hurt tanks. It
 * cannot end a round, change whose turn it is, or hand out money — those are
 * the turn machine's job, driven by the events returned here.
 */
export interface DetonationTarget {
  terrain: Terrain;
  tanks: {
    x: number;
    y: number;
    health: number;
    alive: boolean;
    money: number;
    score: number;
  }[];
}

export type DetonationEvent =
  | { type: 'explosion'; x: number; y: number; radius: number; weapon: string }
  | { type: 'dirt'; x: number; y: number; radius: number }
  | { type: 'damage'; tankIndex: number; amount: number; healthAfter: number }
  | { type: 'death'; tankIndex: number; byTankIndex: number | null };

/** Vertical offset from a tank's feet to the point blasts are measured against. */
export const TANK_DAMAGE_OFFSET = 4.5;

export interface DetonationRules {
  /** Cash awarded per point of damage dealt to someone else. */
  damageBounty: number;
  /** Cash awarded for landing a killing blow. */
  killBounty: number;
}

/**
 * Resolve a weapon's impact. Mutates `target` and returns the events that
 * describe what happened, in order.
 */
export function detonate(
  target: DetonationTarget,
  weapon: WeaponDef,
  x: number,
  y: number,
  shooterIndex: number | null,
  rng: Rng,
  rules: DetonationRules,
): DetonationEvent[] {
  const events: DetonationEvent[] = [];

  switch (weapon.detonation) {
    case 'dirt': {
      applyMound(target.terrain, x, y, weapon.radius);
      events.push({ type: 'dirt', x, y, radius: weapon.radius });
      return events;
    }

    case 'roller': {
      // Lands, then rolls downhill until it runs out of momentum, exploding
      // where it stops. This is what makes a Roller worth buying: it finds
      // people who thought a ridge was cover.
      const distance = weapon.rollDistance ?? 100;
      const direction = downhillDirection(target.terrain, x);
      let cursorX = x;
      const stepSize = Math.max(8, Math.floor(weapon.radius / 2));

      for (let travelled = 0; travelled <= distance; travelled += stepSize) {
        blast(
          target,
          weapon,
          cursorX,
          surfaceAt(target.terrain, cursorX),
          shooterIndex,
          rules,
          events,
        );
        cursorX = clamp(cursorX + direction * stepSize, 0, target.terrain.width - 1);
      }
      return events;
    }

    case 'cluster': {
      blast(target, weapon, x, y, shooterIndex, rules, events);
      const count = weapon.clusterCount ?? 4;
      const spread = weapon.clusterSpread ?? 0.4;
      for (let i = 0; i < count; i += 1) {
        const offsetX = rng.range(-1, 1) * weapon.radius * (2 + spread * 6);
        const childX = clamp(x + offsetX, 0, target.terrain.width - 1);
        blast(
          target,
          weapon,
          childX,
          surfaceAt(target.terrain, childX),
          shooterIndex,
          rules,
          events,
        );
      }
      return events;
    }

    case 'napalm': {
      // Pools and flows downhill, burning what it touches with reduced bite.
      blast(target, weapon, x, y, shooterIndex, rules, events);
      const direction = downhillDirection(target.terrain, x);
      let cursorX = x;
      for (let i = 0; i < 6; i += 1) {
        cursorX = clamp(cursorX + direction * weapon.radius * 0.6, 0, target.terrain.width - 1);
        blast(
          target,
          weapon,
          cursorX,
          surfaceAt(target.terrain, cursorX),
          shooterIndex,
          rules,
          events,
          0.5,
        );
      }
      return events;
    }

    case 'explode':
    default: {
      blast(target, weapon, x, y, shooterIndex, rules, events);
      return events;
    }
  }
}

/** Which way is downhill from `x`? Ties roll right. */
function downhillDirection(terrain: Terrain, x: number): -1 | 1 {
  return surfaceAt(terrain, x + 8) < surfaceAt(terrain, x - 8) ? -1 : 1;
}

/** One explosion: carve the terrain, hurt everyone in range. */
export function blast(
  target: DetonationTarget,
  weapon: WeaponDef,
  x: number,
  y: number,
  shooterIndex: number | null,
  rules: DetonationRules,
  events: DetonationEvent[],
  damageScale = 1,
): void {
  applyCrater(target.terrain, x, y, weapon.radius);
  events.push({ type: 'explosion', x, y, radius: weapon.radius, weapon: weapon.id });

  for (let index = 0; index < target.tanks.length; index += 1) {
    const tank = target.tanks[index];
    if (tank === undefined || !tank.alive) continue;

    const distance = hypot2(tank.x - x, tank.y - TANK_DAMAGE_OFFSET - y);
    const damage = damageAtDistance(weapon, distance) * damageScale;
    if (damage <= 0) continue;

    applyDamage(target, index, Math.round(damage), shooterIndex, rules, events);
  }
}

/**
 * Hurt a tank.
 *
 * Health is clamped at zero. The property suite asserts it can never go
 * negative for any weapon, at any range, ever — so this is the only place
 * allowed to write `tank.health`.
 */
export function applyDamage(
  target: DetonationTarget,
  tankIndex: number,
  amount: number,
  byTankIndex: number | null,
  rules: DetonationRules,
  events: DetonationEvent[],
): void {
  const tank = target.tanks[tankIndex];
  if (tank === undefined || !tank.alive || amount <= 0) return;

  // Credit only the damage that actually landed, so overkill does not pay.
  const applied = Math.min(tank.health, amount);
  tank.health = Math.max(0, tank.health - amount);
  events.push({ type: 'damage', tankIndex, amount: applied, healthAfter: tank.health });

  const shooter =
    byTankIndex !== null && byTankIndex !== tankIndex ? target.tanks[byTankIndex] : undefined;

  if (shooter !== undefined) {
    shooter.money += applied * rules.damageBounty;
    shooter.score += applied;
  }

  if (tank.health <= 0) {
    tank.alive = false;
    events.push({ type: 'death', tankIndex, byTankIndex });
    if (shooter !== undefined) shooter.money += rules.killBounty;
  }
}
