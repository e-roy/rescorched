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
import { applyCrater, surfaceAt, type Terrain } from './terrain.ts';
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

/** Per-blast modifiers. Every one of these defaults to "a plain explosion". */
export interface BlastOptions {
  /** Scales the damage. Napalm's later pools burn weaker than the splash. */
  damageScale?: number;
  /** Scales the crater. Napalm burns without excavating; a digger's shaft does not. */
  craterScale?: number;
  /** Scales the radius reported to the client for drawing. Never reaches zero. */
  visualScale?: number;
}

/**
 * Napalm loses this fraction of its bite with every pool it lays down.
 *
 * Exported because the only way to test a decay is against the number itself:
 * a pool further from the target also does less damage, so a merely decreasing
 * sequence proves nothing.
 */
export const NAPALM_DECAY = 0.85;
/** Fire burns; it does not dig. Napalm's craters are a scorch mark. */
const NAPALM_CRATER_SCALE = 0.3;
/** A pool of burning fuel spreads wider than it damages, but not by much. */
const NAPALM_VISUAL_SCALE = 0.85;

/**
 * Angle of repose for dropped dirt, in pixels per column.
 *
 * Two numbers because the two dirt families behave differently in the hand. A
 * Dirt Ball is a heap of soil and stands at the same 2 px/column the terrain
 * generator allows virgin ground, so a dropped hill is exactly as climbable as
 * a natural one. Liquid Dirt is a liquid — a quarter of a pixel per column is
 * near enough level that it floods a crater instead of capping it, and it is
 * why the same code produces a compact mound for one and a wide flat pool for
 * the other.
 *
 * Both sit under `MAX_BLAST_SLOPE` in terrain.ts, so no dirt weapon can leave
 * the steepest face on the map behind it.
 */
const DIRT_REPOSE = 2;
const LIQUID_REPOSE = 0.25;

/**
 * Slope the outer rim of a pool falls away at, once it is past the reach its
 * volume can cover.
 *
 * A near-level profile has no natural edge on sloping ground: it runs downhill
 * for as long as the hill falls faster than the profile rises, which on a
 * constant grade is forever, and the level that would hold the right volume
 * then does not exist. Past its reach the pool stops behaving like a liquid and
 * piles like soil, which both bounds it and — being under `MAX_BLAST_SLOPE` —
 * leaves no step behind when it does.
 */
const POOL_RIM = DIRT_REPOSE;

/**
 * How far ahead the downhill test looks, in columns.
 *
 * Sampling one column either side is useless on an integer heightmap: virgin
 * ground is capped at 2 px per column, so over a short span the two sides tie
 * constantly, and a tie used to stop a roll dead. It also has to be wide enough
 * to see past the noise — generated terrain carries detail down to ~13 px, and
 * a roller that stops at every 13 px ripple never reaches the valley. Measured
 * over 30 maps in each of the five styles, widening this from 16 to 96 columns
 * took a Heavy Roller's mean travel from 55 px to 134 px.
 */
const SLOPE_WINDOW = 96;

/** A digger stage centred `r` below the surface drops the column by about this many r. */
const DIG_STAGE_DROP = 2.5;
/** Hard stop on digger stages. Only bedrock or a bad `digDepth` gets near it. */
const MAX_DIG_STAGES = 40;

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

  // A non-finite impact point can only come from a bug upstream, and every
  // downstream consumer (crater maths, the wire protocol) would silently
  // produce garbage from it. Refuse it here instead.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return events;

  const width = target.terrain.width;
  const originX = clamp(x, 0, width - 1);

  switch (weapon.detonation) {
    case 'dirt': {
      const volume = dirtVolume(weapon);
      const level = pourDirt(
        target.terrain,
        originX,
        volume,
        DIRT_REPOSE,
        poolReach(volume, DIRT_REPOSE),
      );
      events.push({ type: 'dirt', x: originX, y: level, radius: weapon.radius });
      return events;
    }

    case 'liquid_dirt': {
      // Runs downhill, then settles nearly level. Each deposit is poured onto
      // the CURRENT surface, so successive drops stack into a fill rather than
      // all sinking to the original ground line — and because a pour is
      // slope-limited by construction, stacking them cannot build a spire.
      const step = clamp(Math.round(weapon.radius / 3), 4, 12);
      // Climb budget 0: a liquid runs down, it does not roll over anything.
      const path = flowPath(
        target.terrain,
        originX,
        weapon.rollDistance ?? weapon.radius * 6,
        step,
        0,
      );
      const drops = Math.max(1, Math.floor(weapon.flowSteps ?? 6));
      const volume = dirtVolume(weapon);
      const share = volume / drops;
      // Reach comes from the WHOLE shot, not one drop's share: eight drops that
      // each spread as far as an eighth of the dirt would go stack into a pile
      // an eighth as wide and much taller than the same dirt poured at once.
      const reach = poolReach(volume, LIQUID_REPOSE);

      for (let i = 0; i < drops; i += 1) {
        const spotX = path[Math.min(i, path.length - 1)] as number;
        const level = pourDirt(target.terrain, spotX, share, LIQUID_REPOSE, reach);
        events.push({
          type: 'dirt',
          x: spotX,
          y: level,
          radius: Math.max(1, weapon.radius * 0.7),
        });
      }
      return events;
    }

    case 'riot': {
      // A riot charge throws dirt sideways rather than down: a wide shallow
      // trench, not a bowl. Riot weapons carry damage 0, so this is pure
      // excavation — but it still routes through blast() so that a future
      // "riot bomb" with real damage works without a special case.
      const halfWidth = weapon.radius * Math.max(0.5, weapon.trenchWidth ?? 2);
      const cuts = Math.max(2, Math.round(halfWidth / (weapon.radius * 0.5)));

      for (let i = 0; i < cuts; i += 1) {
        const t = (i / (cuts - 1)) * 2 - 1;
        const cutX = clamp(originX + t * halfWidth, 0, width - 1);
        // Bite just below the local surface so the cut lands on ground rather
        // than in the sky when the trench crosses a slope.
        const cutY = surfaceAt(target.terrain, cutX) + weapon.radius * 0.3;
        blast(target, weapon, cutX, cutY, shooterIndex, rules, events, {
          craterScale: 0.75,
          visualScale: 0.75,
        });
      }
      return events;
    }

    case 'digger': {
      // Goes off on contact, then keeps burrowing. On a heightmap a shaft means
      // the whole column collapses, which is the point: the ground goes out
      // from under whoever was standing on it and the fall finishes the job.
      const startSurface = surfaceAt(target.terrain, originX);
      blast(target, weapon, originX, y, shooterIndex, rules, events);

      const floor = startSurface + Math.max(weapon.radius, weapon.digDepth ?? weapon.radius * 4);

      for (let stage = 0; stage < MAX_DIG_STAGES; stage += 1) {
        const surface = surfaceAt(target.terrain, originX);
        const remaining = floor - surface;
        if (remaining <= 0 || surface >= target.terrain.height) break;

        // Size the stage to what is LEFT, and re-measure after every one.
        // Assuming a fixed bite does not work: applyCrater cuts a parabola
        // `CRATER_DEPTH` deep rather than a circle, so a full stage drops the
        // column by ~2.5r, and the shaft walls then slump back in by an amount
        // that depends on the surrounding ground. Measuring the surface is the
        // only way `digDepth` can be a promise instead of a lower bound.
        const scale = clamp(remaining / (weapon.radius * DIG_STAGE_DROP), 0.2, 1);
        blast(
          target,
          weapon,
          originX,
          surface + weapon.radius * scale,
          shooterIndex,
          rules,
          events,
          {
            damageScale: 0,
            craterScale: scale,
            visualScale: scale * 0.7,
          },
        );

        if (surfaceAt(target.terrain, originX) <= surface) break; // hit bedrock
      }
      return events;
    }

    case 'roller': {
      // Lands, then rolls downhill until it settles in a dip, exploding where
      // it stops. This is what makes a Roller worth buying: it finds people who
      // thought a ridge was cover.
      //
      // The client animates the roll by tweening from the shot's impact point
      // to the explosion here — the sim only reports where it went off.
      const step = clamp(Math.round(weapon.radius / 3), 4, 12);
      // A roller may climb a lip about its own size — so a Heavy Roller shrugs
      // off ground that stops a Baby Roller, which is part of what it is for.
      const path = flowPath(
        target.terrain,
        originX,
        weapon.rollDistance ?? 160,
        step,
        weapon.radius,
      );
      const restX = path[path.length - 1] as number;
      blast(target, weapon, restX, surfaceAt(target.terrain, restX), shooterIndex, rules, events);
      return events;
    }

    case 'leapfrog': {
      // Hops a FIXED distance per bounce rather than following the ground the
      // way a roller does. That is the whole weapon: spacing the blasts by path
      // position instead put all four on one pixel wherever the ground happened
      // to be level, which is both invisible and worthless.
      const hops = Math.max(2, Math.floor(weapon.hops ?? 4));
      const gap = Math.max(4, Math.round(weapon.radius * (weapon.hopSpacing ?? 0.7)));

      // Which way it bounces: downhill if the ground has an opinion, otherwise
      // the impact throws it one way or the other and only the seed knows which.
      let heading = downhillDirection(target.terrain, originX, Math.max(gap, SLOPE_WINDOW));
      if (heading === 0) heading = rng.chance(0.5) ? 1 : -1;

      let cursor = originX;
      for (let i = 0; i < hops; i += 1) {
        blast(
          target,
          weapon,
          cursor,
          surfaceAt(target.terrain, cursor),
          shooterIndex,
          rules,
          events,
        );

        let next = cursor + heading * gap;
        if (next < 0 || next > width - 1) {
          heading = -heading; // bounced off the edge of the world
          next = cursor + heading * gap;
        }
        cursor = clamp(next, 0, width - 1);
      }
      return events;
    }

    case 'cluster': {
      const count = Math.max(1, Math.floor(weapon.clusterCount ?? 4));
      const gap = Math.max(1, weapon.radius * (weapon.clusterSpacing ?? 1.5));
      const halfWidth = (gap * (count - 1)) / 2;

      // Aim every warhead at the ground as it is NOW, then fire the salvo.
      // Doing it one at a time instead meant each blast dropped the ground out
      // from under the next, so overlapping sub-munitions detonated a crater's
      // depth below the target and a MIRV landing on a tank did less damage
      // than a single Missile.
      const salvo: { x: number; y: number }[] = [];
      for (let i = 0; i < count; i += 1) {
        // Evenly spaced, then jittered by less than a third of the gap: a MIRV
        // should read as a line of warheads walking across the hill, never as a
        // ruler and never as a clump.
        const offset = i * gap - halfWidth + rng.range(-0.3, 0.3) * gap;
        const childX = clamp(originX + offset, 0, width - 1);
        salvo.push({ x: childX, y: surfaceAt(target.terrain, childX) });
      }

      blast(target, weapon, originX, y, shooterIndex, rules, events);
      for (const child of salvo) {
        blast(target, weapon, child.x, child.y, shooterIndex, rules, events);
      }
      return events;
    }

    case 'napalm': {
      // Splashes on impact, then the burning fuel runs downhill. Once the front
      // settles it spreads sideways instead of stacking on one spot — a puddle,
      // not a pillar — and every pool burns weaker than the one before it.
      const step = Math.max(3, Math.round(weapon.radius * 0.6));
      // Climb budget 0: burning fuel obeys gravity and nothing else.
      const path = flowPath(
        target.terrain,
        originX,
        weapon.rollDistance ?? weapon.radius * 5,
        step,
        0,
      );
      const pools = Math.max(1, Math.floor(weapon.burnSteps ?? 6));

      blast(target, weapon, originX, y, shooterIndex, rules, events, {
        craterScale: NAPALM_CRATER_SCALE,
        visualScale: NAPALM_VISUAL_SCALE,
      });

      let scale = 1;
      for (let i = 1; i <= pools; i += 1) {
        scale *= NAPALM_DECAY;
        const front = path[Math.min(i, path.length - 1)] as number;
        const overflow = i - (path.length - 1);
        const lateral =
          overflow > 0 ? (overflow % 2 === 1 ? 1 : -1) * Math.ceil(overflow / 2) * step : 0;
        const spotX = clamp(front + lateral, 0, width - 1);

        blast(
          target,
          weapon,
          spotX,
          surfaceAt(target.terrain, spotX),
          shooterIndex,
          rules,
          events,
          {
            damageScale: scale,
            craterScale: NAPALM_CRATER_SCALE,
            visualScale: NAPALM_VISUAL_SCALE,
          },
        );
      }
      return events;
    }

    case 'explode':
    default: {
      blast(target, weapon, originX, y, shooterIndex, rules, events);
      return events;
    }
  }
}

// ---------------------------------------------------------------------------
// Downhill
// ---------------------------------------------------------------------------

interface Downhill {
  /**
   * Total drop over the window, summed column by column. Positive means the
   * ground on that side is lower on average. Screen Y grows downward, so a
   * LARGER surface value is lower ground.
   *
   * Summed rather than sampled at one point, because the heightmap is integers.
   * `surface[x - step]` and `surface[x + step]` tie all over a real generated
   * map and a tie used to stop a roller dead: measured over 30 maps, half of
   * all Heavy Roller shots went nowhere. An integral ties only where the two
   * sides are near mirror images, which is what a dip actually is.
   */
  fall: number;
  /** Lowest ground found anywhere in the window — how much descent is left. */
  lowest: number;
}

function lookDownhill(terrain: Terrain, from: number, direction: number, window: number): Downhill {
  const here = surfaceAt(terrain, from);
  let fall = 0;
  let lowest = here;
  for (let k = 1; k <= window; k += 1) {
    const y = surfaceAt(terrain, from + direction * k);
    fall += y - here;
    if (y > lowest) lowest = y;
  }
  return { fall, lowest };
}

/** Which way is downhill: 1 right, -1 left, 0 if the ground is level or symmetric. */
function downhillDirection(terrain: Terrain, x: number, window: number): number {
  const right = lookDownhill(terrain, x, 1, window).fall;
  const left = lookDownhill(terrain, x, -1, window).fall;
  return right > left ? 1 : left > right ? -1 : 0;
}

/**
 * Walk downhill from `startX`, following the surface, and return every position
 * visited including the start.
 *
 * Three rules, and each one exists because leaving it out visibly breaks the
 * weapon on maps the generator actually produces:
 *
 *  - Momentum. Once it is moving it carries on across flat and symmetric ground
 *    in the direction it was already going, and it never turns round — turning
 *    round means it has already passed the low point. The path is therefore
 *    monotone in x, which is also what lets the client animate one clean roll.
 *  - It settles only where there is nothing lower to reach. Stopping at the
 *    first rise instead parks it on the near lip of every ripple.
 *  - It may climb a lip on the way, up to `climb` px above the lowest ground it
 *    has reached, but not a hill. That is what a heavy thing rolling does, and
 *    it is the difference between "crosses the ridge into the next valley" and
 *    "stops on the ridge".
 */
function flowPath(
  terrain: Terrain,
  startX: number,
  distance: number,
  stepSize: number,
  climb: number,
): number[] {
  const step = Math.max(1, Math.round(stepSize));
  const window = Math.max(step, SLOPE_WINDOW);
  const start = clamp(Math.round(startX), 0, terrain.width - 1);
  const path: number[] = [start];

  let cursor = start;
  let travelled = 0;
  let heading = 0;
  let lowest = surfaceAt(terrain, start);

  while (travelled + step <= distance) {
    const here = surfaceAt(terrain, cursor);
    const right = lookDownhill(terrain, cursor, 1, window);
    const left = lookDownhill(terrain, cursor, -1, window);

    const direction = right.fall > left.fall ? 1 : left.fall > right.fall ? -1 : heading;
    if (direction === 0) break; // dropped onto dead level ground
    if (heading !== 0 && direction === -heading) break; // rolled past the bottom

    const ahead = direction === 1 ? right : left;
    if (ahead.lowest <= here) break; // nothing lower within reach: settled

    const next = clamp(cursor + direction * step, 0, terrain.width - 1);
    if (next === cursor) break; // pinned against the edge of the map
    if (lowest - surfaceAt(terrain, next) > climb) break; // that is a hill, not a lip

    heading = direction;
    cursor = next;
    travelled += step;
    const y = surfaceAt(terrain, cursor);
    if (y > lowest) lowest = y;
    path.push(cursor);
  }

  return path;
}

// ---------------------------------------------------------------------------
// Dirt
// ---------------------------------------------------------------------------

function dirtVolume(weapon: WeaponDef): number {
  // A dome of loose soil the size of the blast, if the table does not say.
  return Math.max(0, weapon.dirtVolume ?? weapon.radius * weapon.radius);
}

interface PoolShape {
  /** Fill level at the pour column. */
  level: number;
  /** Pixels per column the fill profile rises across the body of the pool. */
  repose: number;
  /** How far the body extends before the rim takes over, in columns. */
  reach: number;
}

/**
 * Walk the pool a fill profile would form, calling `fill` for every column it
 * actually covers.
 *
 * Connected, not global: each side stops where ground pokes up through the
 * waterline. Dirt piles against a wall; it does not teleport over one into the
 * next hole.
 *
 * Note which line the containment is tested against. The barrier test is
 * `surface <= level` — the flat waterline — while the depth comes from the
 * sloped profile. Testing containment against the slope instead reads any
 * ground the profile happens to catch up with as a wall, and on a gentle
 * downhill grade that is every few columns: a shot of Liquid Dirt fired at a
 * hillside deposited six square pixels and evaporated.
 */
function walkPool(
  terrain: Terrain,
  center: number,
  shape: PoolShape,
  fill: (x: number, cap: number, depth: number) => void,
): void {
  for (const direction of [1, -1]) {
    for (let k = direction === 1 ? 0 : 1; ; k += 1) {
      const x = center + direction * k;
      if (x < 0 || x >= terrain.width) break;

      const spread =
        k <= shape.reach
          ? shape.repose * k
          : shape.repose * shape.reach + POOL_RIM * (k - shape.reach);
      // Rounded, so the heightmap stays integral for the determinism hash —
      // and so a repose below 1 px/column is expressible at all.
      const cap = Math.max(0, Math.round(shape.level + spread));
      const surface = terrain.surface[x] as number;

      if (surface > cap) fill(x, cap, surface - cap);
      if (k === 0) continue;
      if (surface <= shape.level) break; // ground stands above the waterline
      if (k > shape.reach && surface <= cap) break; // the rim has run out into the ground
    }
  }
}

/**
 * Pour `volume` square pixels of dirt onto a column and let it settle.
 *
 * The settled profile is `min(surface, level + repose * |x - centre|)` over the
 * connected pool: a heap at the angle of repose, clipped by any ground already
 * standing higher. At the Dirt Ball's 2 px/column that is a compact mound; at
 * Liquid Dirt's quarter pixel it is a wide flat pool that floods a crater
 * rather than capping it. Three properties follow from the shape, and each one
 * is a defect this replaced:
 *
 *  - It cannot build a spire. Stacking circular mounds on one column could, and
 *    did: a 136 px tower 35 px wide with a 127 px step down its side.
 *  - It cannot create a cliff that was not already there. Inside the pool the
 *    step is at most `ceil(repose)`; at the boundary the filled column rises
 *    toward the blocking ground, so that step only ever shrinks.
 *  - It cannot overfill a hole it is smaller than, because the level is solved
 *    from the volume rather than assumed.
 *
 * The level is found by bisection: the volume held is non-increasing in it, and
 * at `level = height` it is zero, so the search always lands on a real level.
 * Returns the level the pool settled at, which is where the client draws it.
 */
function pourDirt(
  terrain: Terrain,
  centerX: number,
  volume: number,
  repose: number,
  reach: number,
): number {
  const center = clamp(Math.round(centerX), 0, terrain.width - 1);
  const rise = Math.max(0, repose);
  if (!(volume > 0)) return surfaceAt(terrain, center);

  const held = (level: number): number => {
    let total = 0;
    walkPool(terrain, center, { level, repose: rise, reach }, (_x, _cap, depth) => {
      total += depth;
    });
    return total;
  };

  let lo = 0;
  let hi = terrain.height;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (held(mid) <= volume) hi = mid;
    else lo = mid + 1;
  }

  let level = lo;
  let share = 1;

  // On ground that falls away steadily there may be no level that holds
  // anything like the right volume: one pixel higher and the pool is empty,
  // one lower and it runs half way down the hill. When that happens, drop to
  // the level that holds too much and lay down the fraction actually poured.
  // Scaling every depth by the same factor is a convex blend of the ground and
  // the fill profile, so it cannot steepen anything either.
  const fits = held(level);
  if (fits < volume * 0.75 && level > 0) {
    const deeper = held(level - 1);
    if (deeper > volume) {
      level -= 1;
      share = volume / deeper;
    }
  }

  walkPool(terrain, center, { level, repose: rise, reach }, (x, _cap, depth) => {
    const poured = share < 1 ? Math.round(depth * share) : depth;
    if (poured > 0) terrain.surface[x] = (terrain.surface[x] as number) - poured;
  });

  return level;
}

/**
 * How wide a pool of this volume spreads before its rim takes over.
 *
 * A cone of volume V standing at slope s is `sqrt(V / s)` columns wide either
 * side of its apex, so this is the reach the dirt would find on level ground —
 * which makes the rim a no-op there and a boundary everywhere else.
 */
function poolReach(volume: number, repose: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(0, volume) / Math.max(repose, 0.05))));
}

// ---------------------------------------------------------------------------
// Blast and damage
// ---------------------------------------------------------------------------

/** One explosion: carve the terrain, hurt everyone in range. */
export function blast(
  target: DetonationTarget,
  weapon: WeaponDef,
  x: number,
  y: number,
  shooterIndex: number | null,
  rules: DetonationRules,
  events: DetonationEvent[],
  options: BlastOptions = {},
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  const craterRadius = weapon.radius * (options.craterScale ?? 1);
  // The wire protocol requires a positive radius, and a client cannot draw a
  // zero-width explosion anyway, so never report one.
  const visualRadius = Math.max(1, weapon.radius * (options.visualScale ?? 1));
  const damageScale = options.damageScale ?? 1;

  if (craterRadius > 0) applyCrater(target.terrain, x, y, craterRadius);
  events.push({ type: 'explosion', x, y, radius: visualRadius, weapon: weapon.id });

  if (!(damageScale > 0)) return;

  for (let index = 0; index < target.tanks.length; index += 1) {
    const tank = target.tanks[index];
    if (tank === undefined || !tank.alive) continue;

    const distance = hypot2(tank.x - x, tank.y - TANK_DAMAGE_OFFSET - y);
    const damage = damageAtDistance(weapon, distance) * damageScale;
    if (!(damage > 0)) continue;

    applyDamage(target, index, damage, shooterIndex, rules, events);
  }
}

/**
 * Hurt a tank.
 *
 * The single choke point for writing `tank.health`, which is what lets the
 * property suite assert — once — that health can never go negative for any
 * weapon at any range, and that overkill never pays a bounty for damage that
 * had nowhere to land. Fall damage from `game.ts` comes through here too.
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
  if (tank === undefined || !tank.alive) return;

  // Health is integral game state that gets hashed for the determinism tests,
  // so rounding happens here rather than at each of the half-dozen call sites.
  const dealt = Math.round(amount);
  if (!Number.isFinite(dealt) || dealt <= 0) return;

  // A tank arriving here already below zero is a bug somewhere upstream, but it
  // must not be able to pay the shooter a bounty for damage that was never
  // there, so the ledger starts from zero rather than from the negative number.
  const health = Math.max(0, tank.health);
  // Credit only the damage that actually landed, so overkill does not pay.
  const applied = Math.min(health, dealt);
  tank.health = health - applied;
  events.push({ type: 'damage', tankIndex, amount: applied, healthAfter: tank.health });

  const shooter =
    byTankIndex !== null && byTankIndex !== tankIndex ? target.tanks[byTankIndex] : undefined;

  if (shooter !== undefined) {
    shooter.money += applied * rules.damageBounty;
    shooter.score += applied;
  }

  if (tank.health <= 0) {
    // `alive` flips before the event, so a second blast in the same volley
    // returns at the guard above: one death event, one kill bounty, ever.
    tank.alive = false;
    events.push({ type: 'death', tankIndex, byTankIndex });
    if (shooter !== undefined) shooter.money += rules.killBounty;
  }
}
