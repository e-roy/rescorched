/**
 * Weapon definitions.
 *
 * Names, prices and pack sizes follow the original Scorched Earth arsenal. The
 * table is data, not code: adding a weapon should never require touching the
 * ballistics or damage code.
 */

export type WeaponId = string;

/** How a projectile behaves when it stops. */
export type DetonationKind =
  /** Single explosion at the impact point. */
  | 'explode'
  /** Explodes, then spawns child projectiles (MIRV-style). */
  | 'cluster'
  /** Adds dirt instead of removing it. */
  | 'dirt'
  /** A row of explosions walking outward from the impact point. */
  | 'roller'
  /** Burns downhill from the impact point, damaging what it touches. */
  | 'napalm';

export interface WeaponDef {
  readonly id: WeaponId;
  readonly name: string;
  /** Shop price for one pack. Free weapons (Baby Missile) have price 0. */
  readonly price: number;
  /** How many rounds one purchase grants. */
  readonly packSize: number;
  /** Blast radius in pixels. */
  readonly radius: number;
  /** Peak damage at ground zero. Falls off to 0 at the blast edge. */
  readonly damage: number;
  readonly detonation: DetonationKind;
  /** For 'cluster': how many children, and how much upward kick they get. */
  readonly clusterCount?: number;
  readonly clusterSpread?: number;
  /** For 'roller': how far the explosion walks. */
  readonly rollDistance?: number;
  /** Ordering in the shop / weapon selector. */
  readonly tier: number;
  readonly description: string;
}

/** The free, unlimited default weapon — you can never run out. */
export const BABY_MISSILE: WeaponId = 'baby_missile';

export const WEAPONS: readonly WeaponDef[] = [
  {
    id: BABY_MISSILE,
    name: 'Baby Missile',
    price: 0,
    packSize: Number.POSITIVE_INFINITY,
    radius: 18,
    damage: 25,
    detonation: 'explode',
    tier: 0,
    description: 'Free and unlimited. Small blast, small damage, no excuses.',
  },
  {
    id: 'missile',
    name: 'Missile',
    price: 1875,
    packSize: 10,
    radius: 28,
    damage: 45,
    detonation: 'explode',
    tier: 1,
    description: 'The workhorse. Twice the bite of a Baby Missile.',
  },
  {
    id: 'baby_nuke',
    name: 'Baby Nuke',
    price: 6000,
    packSize: 3,
    radius: 55,
    damage: 90,
    detonation: 'explode',
    tier: 2,
    description: 'A crater you can park a tank in.',
  },
  {
    id: 'nuke',
    name: 'Nuke',
    price: 12000,
    packSize: 1,
    radius: 90,
    damage: 150,
    detonation: 'explode',
    tier: 3,
    description: 'Removes the argument, and most of the hill it was standing on.',
  },
  {
    id: 'leapfrog',
    name: 'Leapfrog',
    price: 10000,
    packSize: 2,
    radius: 24,
    damage: 35,
    detonation: 'roller',
    rollDistance: 120,
    tier: 2,
    description: 'Explodes, hops, explodes again. Good for flushing out cowards.',
  },
  {
    id: 'baby_roller',
    name: 'Baby Roller',
    price: 5000,
    packSize: 5,
    radius: 20,
    damage: 30,
    detonation: 'roller',
    rollDistance: 200,
    tier: 1,
    description: 'Lands and rolls downhill until it finds someone.',
  },
  {
    id: 'mirv',
    name: 'MIRV',
    price: 10000,
    packSize: 3,
    radius: 22,
    damage: 32,
    detonation: 'cluster',
    clusterCount: 5,
    clusterSpread: 0.35,
    tier: 2,
    description: 'Splits at apex into five warheads. Wide, mean, and hard to dodge.',
  },
  {
    id: 'funky_bomb',
    name: 'Funky Bomb',
    price: 7000,
    packSize: 2,
    radius: 20,
    damage: 28,
    detonation: 'cluster',
    clusterCount: 8,
    clusterSpread: 0.7,
    tier: 2,
    description: 'Scatters bouncing sub-munitions in every direction. Chaos on a budget.',
  },
  {
    id: 'napalm',
    name: 'Napalm',
    price: 4000,
    packSize: 4,
    radius: 30,
    damage: 40,
    detonation: 'napalm',
    tier: 1,
    description: 'Flows downhill and keeps burning. Terrain is no protection.',
  },
  {
    id: 'dirt_ball',
    name: 'Dirt Ball',
    price: 3000,
    packSize: 5,
    radius: 40,
    damage: 0,
    detonation: 'dirt',
    tier: 1,
    description: 'Adds dirt instead of removing it. Bury a tank, or rebuild your cover.',
  },
];

const WEAPONS_BY_ID = new Map<WeaponId, WeaponDef>(WEAPONS.map((weapon) => [weapon.id, weapon]));

export function getWeapon(id: WeaponId): WeaponDef | undefined {
  return WEAPONS_BY_ID.get(id);
}

/** Throws for unknown ids — use where a missing weapon is a programming error. */
export function requireWeapon(id: WeaponId): WeaponDef {
  const weapon = WEAPONS_BY_ID.get(id);
  if (weapon === undefined) throw new Error(`Unknown weapon: ${id}`);
  return weapon;
}

export function isValidWeaponId(id: string): boolean {
  return WEAPONS_BY_ID.has(id);
}

/**
 * Damage falloff: full damage at ground zero, tapering to zero at the blast
 * edge. Quadratic falloff feels closer to the original than linear — near
 * misses sting, far misses barely register.
 */
export function damageAtDistance(weapon: WeaponDef, distance: number): number {
  if (distance >= weapon.radius) return 0;
  const t = 1 - distance / weapon.radius;
  return weapon.damage * t * t;
}
