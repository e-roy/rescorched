/**
 * The arsenal table, the damage curve, and whether the shop is a real decision.
 *
 * Three jobs here. First: every row of the table is well-formed, because a
 * malformed weapon does not fail loudly — it produces a shop entry nobody can
 * buy or a blast that quietly does nothing. Second: `damageAtDistance` is the
 * function every blast in the game funnels through, so its edges (ground zero,
 * the blast rim, and anything hostile) are pinned down here rather than
 * discovered in a match.
 *
 * Third, and the reason this file is longer than it looks like it should be:
 * the balance rules below are measured, never declared. Every one of them fires
 * a real detonation at a real tank and counts the damage that actually landed.
 * Comparing struct fields instead is how a Leapfrog whose four blasts all
 * stacked on one pixel — a strictly worse Heavy Roller at the same price —
 * passed an anti-domination test for having `rollBlasts: 4`.
 */

import { describe, expect, it } from 'vitest';

import { detonate, type DetonationRules, type DetonationTarget } from '../src/detonation.ts';
import { makeRng } from '../src/rng.ts';
import { emptyTerrain, type Terrain } from '../src/terrain.ts';
import {
  BABY_MISSILE,
  damageAtDistance,
  getWeapon,
  isValidWeaponId,
  pricePerShot,
  requireWeapon,
  WEAPONS,
  type DetonationKind,
  type WeaponDef,
} from '../src/weapons.ts';

const KNOWN_KINDS: readonly DetonationKind[] = [
  'explode',
  'cluster',
  'roller',
  'leapfrog',
  'napalm',
  'dirt',
  'liquid_dirt',
  'riot',
  'digger',
];

/** Mirrors `WeaponIdSchema` in @scorched/protocol — ids travel on the wire. */
const WIRE_LEGAL_ID = /^[a-z0-9_]+$/;

const DAMAGING = WEAPONS.filter((weapon) => weapon.damage > 0);
const HARMLESS = WEAPONS.filter((weapon) => weapon.damage === 0);

describe('the arsenal table', () => {
  it('gives every weapon a unique, wire-legal id', () => {
    const ids = WEAPONS.map((weapon) => weapon.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(WIRE_LEGAL_ID);
      expect(id.length).toBeLessThanOrEqual(32);
    }
  });

  it.each(WEAPONS)('$id is well-formed', (weapon: WeaponDef) => {
    expect(weapon.name.trim().length).toBeGreaterThan(0);
    expect(weapon.description.trim().length).toBeGreaterThan(0);

    expect(weapon.radius).toBeGreaterThan(0);
    expect(Number.isFinite(weapon.radius)).toBe(true);

    expect(weapon.price).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(weapon.price)).toBe(true);

    expect(weapon.damage).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(weapon.damage)).toBe(true);

    // A pack is a whole number of rounds, or infinite for the free weapon.
    if (weapon.packSize === Number.POSITIVE_INFINITY) {
      expect(weapon.id).toBe(BABY_MISSILE);
      expect(weapon.price).toBe(0);
    } else {
      expect(Number.isInteger(weapon.packSize)).toBe(true);
      expect(weapon.packSize).toBeGreaterThan(0);
    }

    expect(Number.isInteger(weapon.tier)).toBe(true);
    expect(weapon.tier).toBeGreaterThanOrEqual(0);
    expect(KNOWN_KINDS).toContain(weapon.detonation);
  });

  it('sells exactly one free, unlimited weapon and it is the Baby Missile', () => {
    const free = WEAPONS.filter((weapon) => weapon.price === 0);
    expect(free.map((weapon) => weapon.id)).toEqual([BABY_MISSILE]);
    expect(requireWeapon(BABY_MISSILE).packSize).toBe(Number.POSITIVE_INFINITY);
    expect(pricePerShot(requireWeapon(BABY_MISSILE))).toBe(0);
  });

  it.each(WEAPONS)('$id carries the parameters its detonation kind needs', (weapon: WeaponDef) => {
    switch (weapon.detonation) {
      case 'cluster':
        expect(weapon.clusterCount ?? 0).toBeGreaterThan(1);
        expect(weapon.clusterSpacing ?? -1).toBeGreaterThan(0);
        break;
      case 'roller':
        expect(weapon.rollDistance ?? 0).toBeGreaterThan(weapon.radius);
        break;
      case 'leapfrog':
        expect(weapon.hops ?? 0).toBeGreaterThan(1);
        // A hop shorter than the blast radius is a smear, not a march. At 0.6
        // the Leapfrog's four blasts spanned 54 px — identically, on every
        // terrain style and every seed, min = median = max over 150 shots — for
        // a 114 px footprint against a Baby Nuke's 110. That is a wobbly Baby
        // Nuke, not a weapon that "explodes, hops, explodes again". The bar is
        // 1.5 so the table has design room; what the shipped value has to earn
        // is the measured rule in `detonation.test.ts`, 'leaves four craters a
        // player can count, not one smear'.
        expect(weapon.hopSpacing ?? 0).toBeGreaterThanOrEqual(1.5);
        break;
      case 'napalm':
        expect(weapon.burnSteps ?? 0).toBeGreaterThan(0);
        expect(weapon.rollDistance ?? 0).toBeGreaterThan(0);
        break;
      case 'liquid_dirt':
        expect(weapon.flowSteps ?? 0).toBeGreaterThan(0);
        expect(weapon.dirtVolume ?? 0).toBeGreaterThan(0);
        break;
      case 'dirt':
        expect(weapon.dirtVolume ?? 0).toBeGreaterThan(0);
        break;
      case 'digger':
        expect(weapon.digDepth ?? 0).toBeGreaterThan(weapon.radius);
        break;
      case 'riot':
        expect(weapon.trenchWidth ?? 0).toBeGreaterThan(1);
        break;
      default:
        break;
    }
  });

  it('looks weapons up by id and refuses unknown ones', () => {
    expect(getWeapon(BABY_MISSILE)?.id).toBe(BABY_MISSILE);
    expect(getWeapon('trebuchet')).toBeUndefined();
    expect(isValidWeaponId('nuke')).toBe(true);
    expect(isValidWeaponId('nuke ')).toBe(false);
    expect(isValidWeaponId('')).toBe(false);
    expect(() => requireWeapon('trebuchet')).toThrow(/Unknown weapon/);
  });
});

// ---------------------------------------------------------------------------
// Realised performance — every balance rule below is measured, not declared
// ---------------------------------------------------------------------------

const WIDTH = 1280;
const HEIGHT = 720;
const GROUND = 400;
const RULES: DetonationRules = { damageBounty: 20, killBounty: 5000 };
/** Far past anything in the table, so nothing is cut short by a target dying. */
const INDESTRUCTIBLE = 1_000_000;

function flatField(): Terrain {
  const terrain = emptyTerrain(WIDTH, HEIGHT);
  terrain.surface.fill(GROUND);
  return terrain;
}

function dummy(x: number) {
  return { x, y: GROUND, health: INDESTRUCTIBLE, alive: true, money: 0, score: 0 };
}

function totalDamage(target: DetonationTarget, weapon: WeaponDef): number {
  const events = detonate(target, weapon, WIDTH / 2, GROUND, null, makeRng(4242), RULES);
  return events.reduce((sum, event) => (event.type === 'damage' ? sum + event.amount : sum), 0);
}

interface Realised {
  weapon: WeaponDef;
  perShot: number;
  /** Damage to one tank standing exactly where the shell landed. */
  punch: number;
  /** Damage to a rank of tanks every 16 px across the whole map. */
  spread: number;
  /** Square pixels of ground moved, added or removed. */
  ground: number;
}

const REALISED: readonly Realised[] = WEAPONS.map((weapon) => {
  const punchField = flatField();
  const punch = totalDamage({ terrain: punchField, tanks: [dummy(WIDTH / 2)] }, weapon);

  const rank = [];
  for (let x = 40; x < WIDTH - 40; x += 16) rank.push(dummy(x));
  const spread = totalDamage({ terrain: flatField(), tanks: rank }, weapon);

  const groundField = flatField();
  detonate(
    { terrain: groundField, tanks: [] },
    weapon,
    WIDTH / 2,
    GROUND,
    null,
    makeRng(4242),
    RULES,
  );
  let ground = 0;
  for (let x = 0; x < WIDTH; x += 1)
    ground += Math.abs((groundField.surface[x] as number) - GROUND);

  return { weapon, perShot: pricePerShot(weapon), punch, spread, ground };
}).sort((a, b) => a.perShot - b.perShot);

const found = (id: string): Realised => REALISED.find((row) => row.weapon.id === id) as Realised;

describe('shop progression', () => {
  // The shop has to be interesting at every point on the money curve, not just
  // at the top. A budget with one option is not a decision.
  it.each([2500, 5000, 10000, 20000, 30000])('offers a real choice at $%i', (budget) => {
    const affordable = WEAPONS.filter((weapon) => weapon.price > 0 && weapon.price <= budget);
    expect(affordable.length).toBeGreaterThanOrEqual(3);
    expect(new Set(affordable.map((weapon) => weapon.detonation)).size).toBeGreaterThanOrEqual(2);
  });

  it('spans four price tiers with at least two weapons each above the freebie', () => {
    const byTier = new Map<number, WeaponDef[]>();
    for (const weapon of WEAPONS) {
      if (weapon.price === 0) continue;
      byTier.set(weapon.tier, [...(byTier.get(weapon.tier) ?? []), weapon]);
    }
    expect(byTier.size).toBeGreaterThanOrEqual(4);
    for (const [tier, group] of byTier) {
      if (tier === 4) continue; // the top tier is deliberately a single splurge
      expect(group.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('measures a direct hit as the weapon table intends', () => {
    // Guards the harness itself: if `punch` ever stopped measuring a direct hit
    // the balance rules below would still pass while measuring nothing.
    const missile = found('missile');
    expect(missile.punch).toBeGreaterThan(missile.weapon.damage * 0.9);
    expect(missile.punch).toBeLessThanOrEqual(missile.weapon.damage);
    expect(found('nuke').punch).toBeGreaterThan(found('baby_nuke').punch);
    expect(found('funky_bomb').spread).toBeGreaterThan(found('missile').spread * 3);
  });

  it('never lets three times the price buy a softer hit', () => {
    // The rule blocker 9 is about: a Missile costs $180 a shot and takes 42 off
    // a direct hit, so a $3000-a-shot MIRV that took 31 off was not a purchase,
    // it was a tax on wanting the fancy weapon. Free ammo is excluded — there
    // is no ratio against zero — and covered by its own case below.
    const paid = REALISED.filter((row) => row.weapon.damage > 0 && row.perShot > 0);
    const inversions: string[] = [];
    for (const dear of paid) {
      for (const cheap of paid) {
        if (dear.perShot > cheap.perShot * 3 && dear.punch < cheap.punch) {
          inversions.push(
            `${dear.weapon.id} ($${dear.perShot}/shot, ${dear.punch} dmg) is beaten by ` +
              `${cheap.weapon.id} ($${cheap.perShot}/shot, ${cheap.punch} dmg)`,
          );
        }
      }
    }
    expect(inversions).toEqual([]);
  });

  it('never lets three times the price move less ground, for the same job', () => {
    // Grouped by what the weapon does to the ground, because you cannot dig a
    // hole with a Dirt Ball or build cover with a Riot Charge.
    const groups = [
      new Set<DetonationKind>(['dirt', 'liquid_dirt']),
      new Set<DetonationKind>(['riot']),
    ];
    const inversions: string[] = [];
    for (const group of groups) {
      const movers = REALISED.filter((row) => group.has(row.weapon.detonation));
      for (const dear of movers) {
        for (const cheap of movers) {
          if (dear.perShot > cheap.perShot * 3 && dear.ground < cheap.ground) {
            inversions.push(`${dear.weapon.id} moves less ground than ${cheap.weapon.id}`);
          }
        }
      }
    }
    expect(inversions).toEqual([]);
  });

  it('makes every purchase beat the free weapon at something', () => {
    const free = found(BABY_MISSILE);
    for (const row of REALISED) {
      if (row.perShot === 0) continue;
      const better = row.punch > free.punch || row.ground > free.ground;
      expect(
        better,
        `${row.weapon.id}: punch ${row.punch} vs ${free.punch}, ground ${row.ground} vs ${free.ground}`,
      ).toBe(true);
    }
  });

  it('never sells a weapon another of the same kind beats on every measure', () => {
    // Same kind only: a Riot Charge and a Dirt Ball are not substitutes at any
    // price, so comparing them says nothing. Within a kind the comparison is
    // exactly what a player faces in the shop, and all three numbers are
    // measured from real detonations.
    const dominated: string[] = [];
    for (const mine of REALISED) {
      for (const rival of REALISED) {
        if (rival === mine || rival.weapon.detonation !== mine.weapon.detonation) continue;
        if (rival.perShot > mine.perShot) continue;

        const weaklyBetter =
          rival.punch >= mine.punch && rival.spread >= mine.spread && rival.ground >= mine.ground;
        const strictlyBetter =
          rival.perShot < mine.perShot ||
          rival.punch > mine.punch ||
          rival.spread > mine.spread ||
          rival.ground > mine.ground;

        if (weaklyBetter && strictlyBetter) {
          dominated.push(`${rival.weapon.id} dominates ${mine.weapon.id}`);
        }
      }
    }
    expect(dominated).toEqual([]);
  });

  it('keeps the free weapon the weakest thing that explodes', () => {
    const baby = requireWeapon(BABY_MISSILE);
    for (const weapon of WEAPONS) {
      if (weapon.id === BABY_MISSILE || weapon.detonation !== 'explode') continue;
      expect(weapon.radius).toBeGreaterThan(baby.radius);
      expect(weapon.damage).toBeGreaterThan(baby.damage);
    }
  });

  it('charges for a shot, not for a box: the priciest round hits hardest', () => {
    const hardest = [...REALISED].sort((a, b) => b.punch - a.punch)[0] as Realised;
    const dearest = REALISED[REALISED.length - 1] as Realised;
    expect(hardest.weapon.id).toBe(dearest.weapon.id);
  });
});

describe('damageAtDistance', () => {
  it('deals full damage at ground zero', () => {
    for (const weapon of WEAPONS) {
      expect(damageAtDistance(weapon, 0)).toBe(weapon.damage);
    }
  });

  it('deals exactly zero at and beyond the blast radius', () => {
    for (const weapon of WEAPONS) {
      expect(damageAtDistance(weapon, weapon.radius)).toBe(0);
      expect(damageAtDistance(weapon, weapon.radius + 0.0001)).toBe(0);
      expect(damageAtDistance(weapon, weapon.radius * 2)).toBe(0);
      expect(damageAtDistance(weapon, 10_000)).toBe(0);
    }
  });

  it.each(DAMAGING)('$id falls off monotonically across its blast', (weapon: WeaponDef) => {
    let previous = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= 40; i += 1) {
      const value = damageAtDistance(weapon, (i / 40) * weapon.radius);
      expect(value).toBeLessThan(previous);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(value)).toBe(false);
      previous = value;
    }
    expect(previous).toBe(0);
  });

  it.each(HARMLESS)('$id never deals damage at any range', (weapon: WeaponDef) => {
    for (let i = 0; i <= 20; i += 1) {
      expect(damageAtDistance(weapon, (i / 10) * weapon.radius)).toBe(0);
    }
  });

  it('is never negative and never NaN, even for hostile distances', () => {
    const hostile = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      -1e9,
      0,
      1e-12,
      Number.MIN_VALUE,
    ];
    for (const weapon of WEAPONS) {
      for (const distance of hostile) {
        const value = damageAtDistance(weapon, distance);
        expect(Number.isNaN(value)).toBe(false);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(weapon.damage);
      }
    }
  });

  it('never rounds a near miss up past full damage, or a graze down to nothing', () => {
    // `damageAtDistance` clamps `t` and then trusts that `t*t*(3-2t)` cannot
    // leave [0, 1]. That claim is what stands in for a second clamp, so it gets
    // swept rather than asserted — but only over distances where rounding
    // actually decides something.
    //
    // Sweeping the doubles just above ZERO, which is what this used to do, is
    // not one of them: `distance / radius` underflows to zero, so `t` is
    // exactly 1 from the first iteration and 4000 of them produced one distinct
    // result. The loop could not fail against any implementation.
    const over: string[] = [];
    const vanished: string[] = [];

    for (const weapon of DAMAGING) {
      // Just inside the rim: `t` a few ulps above 0, which is where the guard
      // decides between "grazed" and "missed" and where the polynomial is all
      // leading term. A graze is worth almost nothing, but it is not zero and
      // it is not negative.
      let distance = weapon.radius;
      for (let i = 0; i < 4000; i += 1) {
        distance = nextDown(distance);
        const value = damageAtDistance(weapon, distance);
        if (value > weapon.damage) over.push(`${weapon.id} @ rim -${i} ulp: ${value}`);
        if (!(value > 0)) vanished.push(`${weapon.id} @ rim -${i} ulp: ${value}`);
      }

      // Just inside ground zero, reached through `t` rather than through the
      // distance: the doubles immediately below 1, i.e. full damage minus an
      // ulp. This is the only place `t*t*(3-2t)` can round ABOVE one, and it
      // catches reassociations of the expression that are algebraically
      // identical and numerically are not — folding `weapon.damage` into the
      // product instead of multiplying by the finished polynomial overshoots
      // here for about a third of these doubles.
      let t = 1;
      for (let i = 0; i < 4000; i += 1) {
        t = nextDown(t);
        const value = damageAtDistance(weapon, weapon.radius * (1 - t));
        if (value > weapon.damage) over.push(`${weapon.id} @ t = 1 - ${i} ulp: ${value}`);
      }

      // And the whole radius at fine steps.
      for (let i = 0; i <= 20_000; i += 1) {
        const d = (i / 20_000) * weapon.radius;
        if (damageAtDistance(weapon, d) > weapon.damage) over.push(`${weapon.id} @ ${d}`);
      }
    }

    expect(over).toEqual([]);
    expect(vanished).toEqual([]);
  });

  it('survives a malformed weapon rather than returning NaN', () => {
    const broken = {
      ...requireWeapon('missile'),
      radius: 0,
    } as WeaponDef;
    expect(damageAtDistance(broken, 0)).toBe(0);
    expect(damageAtDistance({ ...broken, radius: Number.NaN }, 1)).toBe(0);
    expect(damageAtDistance({ ...broken, radius: -10 }, 1)).toBe(0);
  });

  it('rewards precision: a hit is decisive, a far miss is not worth the shell', () => {
    for (const weapon of DAMAGING) {
      const quarter = damageAtDistance(weapon, weapon.radius * 0.25) / weapon.damage;
      const half = damageAtDistance(weapon, weapon.radius * 0.5) / weapon.damage;
      const threeQuarters = damageAtDistance(weapon, weapon.radius * 0.75) / weapon.damage;
      const edge = damageAtDistance(weapon, weapon.radius * 0.9) / weapon.damage;

      expect(quarter).toBeGreaterThan(0.7); // a near hit still hurts badly
      expect(half).toBeCloseTo(0.5, 5); // half the radius, half the damage
      expect(threeQuarters).toBeLessThan(0.25); // a sloppy shot is a poor trade
      expect(edge).toBeLessThan(0.05); // and a spray is worthless
    }
  });
});

/** The largest double strictly below `value`, for positive finite values. */
function nextDown(value: number): number {
  const buffer = new ArrayBuffer(8);
  new Float64Array(buffer)[0] = value;
  const bits = new BigUint64Array(buffer);
  bits[0] = (bits[0] as bigint) - 1n;
  return new Float64Array(buffer)[0] as number;
}
