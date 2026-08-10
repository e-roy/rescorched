/**
 * Weapon definitions.
 *
 * Names and pack sizes follow the original Scorched Earth arsenal. The table is
 * data, not code: adding a weapon should never require touching the ballistics
 * or damage code — only `detonation.ts`, and only if the weapon needs a
 * behaviour that does not exist yet.
 *
 * Pricing intent, so future edits stay coherent. A kill pays 5000 plus 20 per
 * point of damage and a round survived pays 2000, so a good round nets roughly
 * 10k — which is also what a player starts with. Prices are therefore set PER
 * SHOT, not per pack:
 *
 *   tier 1   ~120-250 / shot   spam ammo, ten to a pack
 *   tier 2   ~600-1200 / shot  a considered purchase, four to six a pack
 *   tier 3   ~2000-5000 / shot this is your play for the match
 *   tier 4   30000 / shot      three rounds of winning, spent in one go
 *
 * The rule that keeps that honest is in `weapons.test.ts` and is measured, not
 * declared: a weapon that costs three times another must not hit softer than
 * it, where "hit" means damage actually dealt to a tank by a real detonation.
 * A pack price alone hides that — a $10000 pack of three looks expensive and is
 * in fact cheaper per shot than a $6000 pack of one.
 *
 * ---------------------------------------------------------------------------
 * What `damage` buys, in shots to destroy a tank
 * ---------------------------------------------------------------------------
 *
 * `damage` is peak damage at ground zero, and since `damageToTankAt` measures
 * from the hull's skin it is also, exactly, what a shell caught on the hull
 * does. Against `DEFAULT_WORLD.maxHealth` = 100 the table is therefore readable
 * as a promise about direct hits, and that promise is the ladder:
 *
 *   tier 0   4 direct hits    the free weapon. Winnable with, tedious with.
 *   tier 1   2-4              a pack of these is a round's worth of pressure.
 *   tier 2   1-2              a considered purchase decides a duel.
 *   tier 3+  1                you paid for an ending; you get one.
 *
 * Those counts are not a comment, they are `test/balance.test.ts` › "a direct
 * hit hurts", which flies real shots through the real physics to find where a
 * shell actually stops on a hull, detonates there, and counts. Changing a
 * `damage` cell moves that test.
 *
 * The area weapons (napalm, clusters) exceed their tier's count on flat ground
 * because several of their blasts land on the same tank; the test asserts an
 * upper bound on shots, so beating it is allowed and beating it by a mile is
 * what a MIRV is for.
 */

import { clamp } from './math.ts';

export type WeaponId = string;

/** How a projectile behaves when it stops. */
export type DetonationKind =
  /** Single explosion at the impact point. */
  | 'explode'
  /** Explodes, then scatters sub-munitions across a spread (MIRV, Funky Bomb). */
  | 'cluster'
  /** Rolls downhill until it settles in a dip, then goes off where it stopped. */
  | 'roller'
  /** Bounces a fixed distance and explodes again, several times over. */
  | 'leapfrog'
  /** Splashes, runs downhill, and keeps burning with fading bite. */
  | 'napalm'
  /** Dumps a heap of dirt instead of taking one away. */
  | 'dirt'
  /** Dirt that lies nearly level: it fills a hole before it piles up. */
  | 'liquid_dirt'
  /** Blows dirt sideways into a wide shallow trench. Excavation, not damage. */
  | 'riot'
  /** Burrows straight down, taking the ground out from under whoever is on it. */
  | 'digger';

export interface WeaponDef {
  readonly id: WeaponId;
  readonly name: string;
  /** Shop price for one pack. Free weapons (Baby Missile) have price 0. */
  readonly price: number;
  /** How many rounds one purchase grants. Infinity only for the free weapon. */
  readonly packSize: number;
  /** Blast radius in pixels — the distance at which damage reaches zero. */
  readonly radius: number;
  /** Peak damage at ground zero. Falls off to 0 at the blast edge. */
  readonly damage: number;
  readonly detonation: DetonationKind;
  /** 'cluster': how many sub-munitions. */
  readonly clusterCount?: number;
  /**
   * 'cluster': gap between neighbouring sub-munitions, as a multiple of
   * `radius`. Below 1 they overlap and a target in the middle takes several;
   * above 1 they cover ground instead. That one number is the whole difference
   * between a MIRV and a Funky Bomb.
   */
  readonly clusterSpacing?: number;
  /** 'roller' | 'napalm' | 'liquid_dirt': travel budget downhill, in pixels. */
  readonly rollDistance?: number;
  /** 'leapfrog': how many times it goes off. */
  readonly hops?: number;
  /**
   * 'leapfrog': gap between hops, as a multiple of `radius`.
   *
   * At or above 2 the blasts are tangent or clear of each other, so the weapon
   * marches — four craters a player can count, covering ground no single shell
   * reaches. Below 1 they overlap into one smear: at 0.6 the Leapfrog moved 54
   * px in total on every terrain and every seed, a 114 px footprint against a
   * Baby Nuke's 110, which is a wobbly Baby Nuke and not a weapon.
   */
  readonly hopSpacing?: number;
  /** 'napalm': burning pools laid down after the initial splash. */
  readonly burnSteps?: number;
  /** 'liquid_dirt': how many deposits the stream pours out along its run. */
  readonly flowSteps?: number;
  /** 'dirt' | 'liquid_dirt': ground it adds, in square pixels. */
  readonly dirtVolume?: number;
  /** 'digger': how far the column drops in total, in pixels. */
  readonly digDepth?: number;
  /** 'riot': trench half-width, as a multiple of `radius`. */
  readonly trenchWidth?: number;
  /** Ordering in the shop / weapon selector. */
  readonly tier: number;
  readonly description: string;
}

/** The free, unlimited default weapon — you can never run out. */
export const BABY_MISSILE: WeaponId = 'baby_missile';

export const WEAPONS: readonly WeaponDef[] = [
  // -------------------------------------------------------------- tier 0
  {
    id: BABY_MISSILE,
    name: 'Baby Missile',
    price: 0,
    packSize: Number.POSITIVE_INFINITY,
    radius: 18,
    damage: 30,
    detonation: 'explode',
    tier: 0,
    description: 'Free and unlimited. Small blast, small damage, no excuses.',
  },

  // -------------------------------------------------------------- tier 1
  {
    id: 'dirt_clod',
    name: 'Dirt Clod',
    price: 1200,
    packSize: 10,
    radius: 22,
    damage: 0,
    detonation: 'dirt',
    dirtVolume: 900,
    tier: 1,
    description: 'A shovelful of cover, thrown wherever you need it.',
  },
  {
    id: 'baby_roller',
    name: 'Baby Roller',
    price: 1500,
    packSize: 10,
    radius: 20,
    damage: 34,
    detonation: 'roller',
    rollDistance: 260,
    tier: 1,
    description: 'Cheaper than a Missile and softer than one, but it comes to you.',
  },
  {
    id: 'funky_bomb',
    name: 'Funky Bomb',
    price: 1700,
    packSize: 10,
    radius: 22,
    damage: 26,
    detonation: 'cluster',
    clusterCount: 8,
    clusterSpacing: 1.7,
    tier: 1,
    description: 'Eight sub-munitions across half a hillside. Cheap chaos; aim is optional.',
  },
  {
    id: 'missile',
    name: 'Missile',
    price: 1800,
    packSize: 10,
    radius: 28,
    damage: 60,
    detonation: 'explode',
    tier: 1,
    description: 'The workhorse. Twice the bite of a Baby Missile, and cheap by the pack.',
  },
  {
    id: 'riot_charge',
    name: 'Riot Charge',
    price: 2000,
    packSize: 10,
    radius: 26,
    damage: 0,
    detonation: 'riot',
    trenchWidth: 2,
    tier: 1,
    description: 'Sweeps dirt sideways. Hurts nobody; takes a ridge away for good.',
  },
  {
    id: 'baby_digger',
    name: 'Baby Digger',
    price: 2400,
    packSize: 10,
    radius: 16,
    damage: 26,
    detonation: 'digger',
    digDepth: 70,
    tier: 1,
    description: 'Burrows in and drops the floor. The fall does the real work.',
  },

  // -------------------------------------------------------------- tier 2
  {
    id: 'dirt_ball',
    name: 'Dirt Ball',
    price: 3000,
    packSize: 5,
    radius: 36,
    damage: 0,
    detonation: 'dirt',
    dirtVolume: 1550,
    tier: 2,
    description: 'Bury a tank, or rebuild the hill you just lost.',
  },
  {
    id: 'riot_blast',
    name: 'Riot Blast',
    price: 3500,
    packSize: 5,
    radius: 44,
    damage: 0,
    detonation: 'riot',
    trenchWidth: 2.4,
    tier: 2,
    description: 'Clears a trench wide enough to shoot through. Still hurts nobody.',
  },
  {
    id: 'napalm',
    name: 'Napalm',
    price: 4500,
    packSize: 6,
    radius: 26,
    damage: 46,
    detonation: 'napalm',
    burnSteps: 6,
    rollDistance: 150,
    tier: 2,
    description: 'Splashes, runs downhill, keeps burning. Terrain is no protection.',
  },
  {
    id: 'liquid_dirt',
    name: 'Liquid Dirt',
    price: 4000,
    packSize: 5,
    radius: 24,
    damage: 0,
    detonation: 'liquid_dirt',
    flowSteps: 8,
    rollDistance: 220,
    dirtVolume: 3200,
    tier: 2,
    description: 'Runs downhill and lies flat. Floods a crater level instead of capping it.',
  },
  {
    id: 'roller',
    name: 'Roller',
    price: 4000,
    packSize: 5,
    radius: 30,
    damage: 66,
    detonation: 'roller',
    rollDistance: 340,
    tier: 2,
    description: 'Heavier, angrier, and it will follow you a long way down.',
  },
  {
    id: 'leapfrog',
    name: 'Leapfrog',
    price: 3600,
    packSize: 4,
    radius: 30,
    damage: 62,
    detonation: 'leapfrog',
    hops: 4,
    hopSpacing: 2,
    tier: 2,
    description: 'Explodes, hops sixty pixels, explodes again. Four times, walking off downhill.',
  },
  {
    id: 'sandhog',
    name: 'Sandhog',
    price: 5000,
    packSize: 5,
    radius: 24,
    damage: 64,
    detonation: 'digger',
    digDepth: 150,
    tier: 2,
    description: 'Goes off, then keeps tunnelling. Whatever was standing there is not now.',
  },
  {
    id: 'baby_nuke',
    name: 'Baby Nuke',
    price: 6000,
    packSize: 5,
    radius: 55,
    // Two direct hits, not one. At 105 it destroyed a full-health tank outright
    // and the measured effect was a worse game, not a better one: a Cyborg duel
    // (66% hit rate, one Baby Nuke pack from the armoury) decided its rounds in
    // a mean of 1.9 turns, so whoever the turn order picked first usually won
    // before the other tank had fired. 80 puts it back at two hits and the same
    // duel at ~5 turns. Tier 3 is where one shot ends the argument.
    damage: 80,
    detonation: 'explode',
    tier: 2,
    description: 'A crater you can park a tank in.',
  },

  // -------------------------------------------------------------- tier 3
  {
    id: 'ton_of_dirt',
    name: 'Ton of Dirt',
    price: 8000,
    packSize: 4,
    radius: 70,
    damage: 0,
    detonation: 'dirt',
    dirtVolume: 4100,
    tier: 3,
    description: 'Drops a hill. Bury someone alive, or wall yourself in.',
  },
  {
    id: 'hot_napalm',
    name: 'Hot Napalm',
    price: 8000,
    packSize: 3,
    radius: 32,
    damage: 58,
    detonation: 'napalm',
    burnSteps: 10,
    rollDistance: 220,
    tier: 3,
    description: 'Ten pools of it, and it runs a long way before it stops running.',
  },
  {
    id: 'mirv',
    name: 'MIRV',
    price: 9000,
    packSize: 3,
    radius: 30,
    damage: 44,
    detonation: 'cluster',
    clusterCount: 5,
    clusterSpacing: 0.6,
    tier: 3,
    description: 'Five warheads on overlapping aimpoints. Whatever is under the middle dies.',
  },
  {
    id: 'heavy_roller',
    name: 'Heavy Roller',
    price: 9000,
    packSize: 2,
    radius: 48,
    damage: 135,
    detonation: 'roller',
    rollDistance: 460,
    tier: 3,
    description: 'Shrugs off ridges a Baby Roller stops on, and takes the valley with it.',
  },
  {
    id: 'nuke',
    name: 'Nuke',
    price: 12000,
    packSize: 1,
    radius: 90,
    damage: 190,
    detonation: 'explode',
    tier: 3,
    description: 'Removes the argument, and most of the hill it was standing on.',
  },

  // -------------------------------------------------------------- tier 4
  {
    id: 'deaths_head',
    name: "Death's Head",
    price: 30000,
    packSize: 1,
    radius: 120,
    damage: 280,
    detonation: 'explode',
    tier: 4,
    description: 'Three rounds of winnings for one shot. It ends whatever it lands near.',
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

/** What one round of this weapon costs. Infinite pack size means free forever. */
export function pricePerShot(weapon: WeaponDef): number {
  return weapon.packSize > 0 && Number.isFinite(weapon.packSize)
    ? weapon.price / weapon.packSize
    : 0;
}

/**
 * Damage falloff: full damage at ground zero, exactly zero at the blast edge.
 *
 * Smoothstep rather than the quadratic this used to be. The shape is what makes
 * aiming worth doing: 84% at a quarter of the radius (a hit is a hit), 50% at
 * half, 16% at three quarters, ~3% at nine tenths. So a direct hit is decisive,
 * a near miss still hurts enough to matter, and lobbing shells vaguely in
 * someone's direction is a waste of ammunition.
 *
 * `distance` is measured from the SKIN of the target's hull, not from its
 * centre — see `damageToTankAt` in `detonation.ts`, which is the only thing in
 * the game that calls this with a real target's distance. The curve was never
 * the reason a direct hit felt weak; the reason was that the impact point of a
 * shell caught on the hull sits a full hull radius from the tank's centre, so
 * "direct hit" was being fed the distance of a near miss. This function is
 * unchanged apart from this paragraph.
 *
 * Written so hostile inputs fall out rather than propagate: `!(distance <
 * radius)` returns 0 for NaN as well as for anything at or past the edge. That
 * guard plus the clamp on `t` is the whole of the input hardening — with
 * `t` in [0, 1] the polynomial `t*t*(3-2t)` is also in [0, 1], so the result
 * can never exceed `weapon.damage` and needs no second clamp.
 *
 * The parentheses in the return are load-bearing, not style. `damage * (poly)`
 * scales a value that is provably in [0, 1]; `damage * t * t * (3 - 2 * t)`
 * multiplies the damage in first and rounds at every step, and for about a
 * third of the doubles immediately below `t = 1` it lands above `weapon.damage`
 * — which is exactly the second clamp this claims not to need. `weapons.test.ts`
 * sweeps those doubles.
 */
export function damageAtDistance(weapon: WeaponDef, distance: number): number {
  if (!(weapon.radius > 0) || !(distance < weapon.radius)) return 0;
  if (!(weapon.damage > 0)) return 0;
  const t = clamp(1 - distance / weapon.radius, 0, 1);
  return weapon.damage * (t * t * (3 - 2 * t));
}
