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
import {
  applyCrater,
  MAX_BLAST_SLOPE,
  MAX_TERRAIN_SLOPE,
  surfaceAt,
  type Terrain,
} from './terrain.ts';
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

/**
 * What a detonation reports to the outside world.
 *
 * `shot` is the odd one out and is here on purpose. `e2e/reference/README.md`,
 * written from the 1991 screenshots, names as a defining look: "Trajectory arcs
 * are thin blue/violet lines and several are visible at once (a Funky Bomb
 * splitting into multiple sub-munitions, each drawing its own arc)." A weapon
 * that teleports its warheads to a ground position and detonates them cannot be
 * drawn that way at all — the player sees one arc and then eight instantaneous
 * circles — and the vocabulary, not the client, is what forecloses it. So a
 * sub-munition that travels emits its flight, and the client draws it with the
 * same code that draws the parent shell's.
 *
 * It reuses `shot` rather than introducing a `submunition` type deliberately.
 * A shell in flight is a shell in flight: `shot` already carries exactly
 * (weapon, path) and nothing else a warhead needs, `game.ts` already forwards
 * detonation events onto the wire unchanged, and `@scorched/protocol` already
 * accepts it — a new member would be rejected by `encodeServerMessage` the
 * moment a Funky Bomb went off. The one thing `shot` requires that a detonation
 * does not always have is a tank to attribute it to, so an arc is emitted only
 * when there is a shooter; a detonation with no shooter (a test fixture, fall
 * damage) still resolves identically, it just has no flight to draw.
 */
export type DetonationEvent =
  | { type: 'explosion'; x: number; y: number; radius: number; weapon: string }
  | { type: 'dirt'; x: number; y: number; radius: number }
  | { type: 'damage'; tankIndex: number; amount: number; healthAfter: number }
  | { type: 'death'; tankIndex: number; byTankIndex: number | null }
  | { type: 'shot'; tankIndex: number; weapon: string; path: number[]; impactKind: string };

/**
 * A tank's hull, as the blast maths sees it.
 *
 * `TANK_HULL_RADIUS` mirrors `DEFAULT_WORLD.tankRadius` in `game.ts` — the same
 * circle `physics.ts` sweeps a shell against — and is written here rather than
 * imported because `game.ts` imports this file and a value import back would
 * close a runtime cycle. Nothing pins the two together by inspection, so they
 * are pinned by measurement, from both sides:
 *
 *  - From BELOW by `test/game-damage.test.ts` › "a shell caught on the hull does
 *    the weapon's full damage". Shrink the hull and a direct hit starts being
 *    charged a near miss's falloff.
 *  - From ABOVE by `test/detonation.test.ts` › "a blast reaches exactly one hull
 *    past its own radius". Grow the hull and every weapon in the arsenal quietly
 *    gains reach, which is a balance change nothing else would notice.
 *
 * That second half did not exist, and the comment here claimed it did. Measured
 * before writing it: moving this constant to 8 or to 10 left the entire sim
 * suite green apart from the golden hash in `determinism.test.ts` — and a golden
 * hash is a change detector, not a specification. Both mutations are red now.
 *
 * `TANK_DAMAGE_OFFSET` is half of it: the centre of the hull above the tank's
 * ground contact point, which is also where `game.ts` puts the hit circle.
 */
export const TANK_HULL_RADIUS = 9;
/** Vertical offset from a tank's feet to the point blasts are measured against. */
export const TANK_DAMAGE_OFFSET = TANK_HULL_RADIUS / 2;

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
 * Dirt Ball is a heap of soil and stands at `MAX_TERRAIN_SLOPE` — as steep as
 * the generator's own hillsides, and no steeper. Liquid Dirt is a liquid: a
 * quarter of a pixel per column is near enough level that it floods a crater
 * instead of capping it, and it is why the same code produces a compact mound
 * for one and a wide flat pool for the other.
 *
 * Tied to the generator's cap rather than written as a number, because a heap
 * laid SHALLOWER than the ground it lands on does not stand up at all: it runs
 * away downhill for as long as the hill falls faster than the profile rises. At
 * 2 px/column against a generator that allows 3, a Dirt Clod — "a shovelful of
 * cover" — spread 900 square pixels of soil over 115 columns of a 2 px/column
 * grade and stood 8 px tall, and on generated maps its shallowest pile over 200
 * shots was 11 px. It is a shovelful of cover; it has to be a pile.
 *
 * Measured against the same 200 shots, raising it from 2 to 3 takes the Dirt
 * Clod's median pile from 41 px to 51 and the Ton of Dirt's from 88 to 109.
 *
 * Both sit under `MAX_BLAST_SLOPE`, so no dirt weapon can leave a face steeper
 * than the destruction path is allowed to hold.
 */
const DIRT_REPOSE = MAX_TERRAIN_SLOPE;
const LIQUID_REPOSE = 0.25;

/**
 * Slope the outer rim of a pool falls away at, once it is past the reach its
 * volume can cover.
 *
 * A near-level profile has no natural edge on sloping ground: it runs downhill
 * for as long as the hill falls faster than the profile rises, which on a
 * constant grade is forever, and the level that would hold the right volume
 * then does not exist. Past its reach the pool stops behaving like a liquid and
 * piles like soil.
 *
 * `MAX_BLAST_SLOPE` and not `DIRT_REPOSE`, which is what it used to be: at
 * `DIRT_REPOSE` the rim continues the body at exactly the body's own slope, so
 * for every weapon in the `dirt` family it was a strict no-op and bounded
 * nothing. The steepest face blast-loosened dirt will hold is the steepest edge
 * a heap of it can end on, so it is also the tightest bound available that
 * still leaves no step the rest of the file would have to slump away.
 */
const POOL_RIM = MAX_BLAST_SLOPE;

/**
 * How far ahead the downhill test looks, in columns.
 *
 * Sampling one column either side is useless on an integer heightmap: virgin
 * ground is capped at `MAX_TERRAIN_SLOPE` px per column, so over a short span
 * the two sides tie constantly, and a tie stops a roll dead. It also has to be
 * wide enough to see past the noise — generated terrain carries detail down to
 * ~13 px, and a roller that stops at every 13 px ripple never reaches the
 * valley. Re-measured over 1050 Heavy Roller shots (30 maps in each of the five
 * styles, seven landing columns each) against the code as it now stands: mean
 * travel is 52 px at a 1-column window, 59 px at 16 and 110 px at 96.
 *
 * It decides direction and how much descent is left. It deliberately does NOT
 * decide whether a roller starts moving at all — see `flowPath`'s fourth rule.
 * When it did, a window this wide behaved as a 96-column gravity well: on a
 * dead-flat plateau ending in a cliff, a Heavy Roller dropped 100 px back from
 * the edge sat where it landed and one dropped 60 px back rolled off, with
 * nothing on screen to tell a player which they were about to get.
 */
const SLOPE_WINDOW = 96;

/** A digger stage centred `r` below the surface drops the column by about this many r. */
const DIG_STAGE_DROP = 2.5;
/** Hard stop on digger stages. Only bedrock or a bad `digDepth` gets near it. */
const MAX_DIG_STAGES = 40;

/** What the shell stopped against. Only a hull changes any weapon's behaviour. */
export interface ImpactContext {
  /**
   * The shell was caught on a tank rather than on the ground.
   *
   * One weapon family cares, and it is the reason this exists: a Roller
   * detonates where it comes to REST, so a Roller that hit a tank squarely used
   * to roll off it and go off somewhere down the hill. Measured over 8 seeds of
   * Tosser-vs-Tosser duels (the personality whose whole arsenal is rollers),
   * that was a 14.8% connect rate and rounds running 27 turns against a 40-turn
   * budget, with the clock rather than a shot ending 42% of them. With this,
   * the same sweep connects on 33.9% and 95% of its rounds end with a kill.
   *
   * Optional and defaulting to "ground", because every other caller in the
   * game — a fall, a test fixture, a sub-munition — is genuinely detonating
   * against terrain, and a required parameter would make them all assert
   * something they do not know.
   */
  onTank?: boolean;
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
  impact: ImpactContext = {},
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

      // Unless it hit a tank, in which case it has already found somebody and
      // goes off against the hull. A shell that rolls off the target it just
      // struck is not "it finds people", it is a direct hit that misses — and
      // it is the one way a weapon in this file could still take the decisive
      // hit away after `damageToTankAt` gave it back.
      if (impact.onTank === true) {
        blast(target, weapon, originX, y, shooterIndex, rules, events);
        return events;
      }

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
      const gap = Math.max(4, Math.round(weapon.radius * (weapon.hopSpacing ?? 2)));

      // Which way it bounces: downhill if the ground has an opinion, otherwise
      // the impact throws it one way or the other and only the seed knows which.
      let heading = downhillDirection(target.terrain, originX, Math.max(gap, SLOPE_WINDOW));
      if (heading === 0) heading = rng.chance(0.5) ? 1 : -1;

      // Every landing point is measured against the ground as it is NOW, before
      // any hop has carved anything — the same rule, and for the same reason, as
      // the salvo in the `cluster` case below. Measuring each hop after the
      // previous blast dropped hops two onward 30 to 60 px into the crater the
      // hop before them had just dug, and a tank standing at the impact point
      // took damage from the first bang and nothing from the other three.
      const stops: { x: number; y: number }[] = [{ x: originX, y }];
      let cursor = originX;
      for (let i = 1; i < hops; i += 1) {
        let next = cursor + heading * gap;
        if (next < 0 || next > width - 1) {
          heading = -heading; // bounced off the edge of the world
          next = cursor + heading * gap;
        }
        cursor = clamp(next, 0, width - 1);
        stops.push({ x: cursor, y: surfaceAt(target.terrain, cursor) });
      }

      for (let i = 0; i < stops.length; i += 1) {
        const stop = stops[i] as { x: number; y: number };
        // Interleaved, unlike the cluster salvo: a leapfrog really is
        // sequential — bang, hop, bang — so the arc belongs between the two
        // explosions it connects.
        if (i > 0) {
          const from = stops[i - 1] as { x: number; y: number };
          pushArc(events, weapon, shooterIndex, from.x, from.y, stop.x, stop.y);
        }
        blast(target, weapon, stop.x, stop.y, shooterIndex, rules, events);
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

      // Every warhead's flight, as a contiguous run, before any of them lands.
      // Contiguous on purpose: the look the reference singles out is several
      // arcs in the air AT ONCE, and a client can only draw that if the events
      // it is meant to play together arrive together. Arc `i` pairs with the
      // i-th explosion that follows the run.
      for (const child of salvo) {
        pushArc(events, weapon, shooterIndex, originX, y, child.x, child.y);
      }
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
// Sub-munition flight
// ---------------------------------------------------------------------------

/**
 * Pixels of ground per point of a sub-munition's arc.
 *
 * A drawing resolution, not a physics timestep: the client walks the path point
 * to point and draws straight lines between them, and a parabola sags below its
 * own chord by `apex * (segment / span)^2`. At one point per 24 px a Funky
 * Bomb's longest throw is five points and that error is about a pixel, so the
 * polyline reads as a curve. Sampling finer buys nothing visible and costs real
 * bytes — every event in a volley shares one frame, and `@scorched/protocol`
 * refuses to parse one over 16 KB.
 */
const ARC_SAMPLE_SPACING = 24;
const ARC_MIN_POINTS = 4;
const ARC_MAX_POINTS = 10;
/**
 * Apex of a sub-munition's arc, as a fraction of how far it is thrown.
 *
 * The arc is cosmetic — where the warhead lands was decided before it was
 * thrown — so this is chosen to read, not to integrate: a fifth of the throw
 * gives a Funky Bomb's outermost warheads a lob a player can follow and its
 * innermost a short skip, which is the difference between "eight arcs" and
 * "eight lines".
 */
const ARC_LIFT = 0.2;

/**
 * Sample the parabola a thrown sub-munition follows, as a flat
 * `[x0, y0, x1, y1, …]` path. Built from `+ - *` only, so it is bit-identical
 * everywhere, and it starts and ends exactly on the two points it connects.
 *
 * The points in between are rounded to whole pixels — they are positions to
 * draw a shell at, and `189` costs four bytes on the wire where
 * `189.33333333333334` costs eighteen. The two ends are not rounded: they have
 * to line up exactly with the explosions they run between, and a client that
 * drew the trail to a pixel other than the one the blast is centred on would
 * show the shell jumping at the moment it went off.
 */
function arcPath(fromX: number, fromY: number, toX: number, toY: number): number[] {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const span = hypot2(dx, dy);
  const points = clamp(Math.round(span / ARC_SAMPLE_SPACING), ARC_MIN_POINTS, ARC_MAX_POINTS);
  const lift = span * ARC_LIFT;

  const path: number[] = [fromX, fromY];
  for (let i = 1; i < points - 1; i += 1) {
    const t = i / (points - 1);
    // Zero at both ends, one in the middle. Screen Y grows down, so up is minus.
    const hump = 4 * t * (1 - t);
    path.push(Math.round(fromX + dx * t), Math.round(fromY + dy * t - lift * hump));
  }
  path.push(toX, toY);
  return path;
}

/** Record one sub-munition's flight, if there is a shooter to attribute it to. */
function pushArc(
  events: DetonationEvent[],
  weapon: WeaponDef,
  shooterIndex: number | null,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): void {
  if (shooterIndex === null || !Number.isInteger(shooterIndex) || shooterIndex < 0) return;
  if (!Number.isFinite(fromX) || !Number.isFinite(fromY)) return;
  if (!Number.isFinite(toX) || !Number.isFinite(toY)) return;

  events.push({
    type: 'shot',
    tankIndex: shooterIndex,
    weapon: weapon.id,
    path: arcPath(fromX, fromY, toX, toY),
    impactKind: 'terrain',
  });
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
   * Summed rather than sampled at one point, because the heightmap is integers:
   * `surface[x - step]` and `surface[x + step]` tie all over a real generated
   * map, and a tie stops a roller dead. An integral ties only where the two
   * sides are near mirror images, which is what a dip actually is. The size of
   * the effect is measured on `SLOPE_WINDOW` — collapsing the window to a
   * single column takes a Heavy Roller's mean travel from 110 px to 52.
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
 *  - Nothing at rest starts moving unless the ground falls away UNDER it, within
 *    one stride. `SLOPE_WINDOW` is 96 columns wide, and without this rule that
 *    width applied to a stationary shell as well as a moving one: level ground
 *    with a drop anywhere in the window read as downhill, so a Heavy Roller
 *    dropped 100 px back from a cliff on a dead-flat plateau stayed put while
 *    one dropped 60 px back rolled off — two shots on ground that looks
 *    identical, and no way to tell them apart before firing. With the rule the
 *    only place the behaviour changes is within one stride of the visible edge,
 *    which is exactly where a player expects "it was right on the lip" to
 *    matter. Momentum is unaffected: once it is moving, the wide window carries
 *    it across flats and ripples as before.
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

    // Standing start: the ground it is sitting on has to go down, not merely
    // lead somewhere that does. One stride, because that is the shell's own
    // size — the smallest window that cannot be fooled by the heightmap's
    // integer rounding, and small enough that "the ground under it is level"
    // means what a player would say it means.
    if (heading === 0 && lookDownhill(terrain, cursor, direction, step).lowest <= here) break;

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
 * The settled profile is `min(surface, level + repose * |x - centre|)` inside
 * the pool's reach and `POOL_RIM` per column beyond it, over the connected
 * pool, clipped by any ground already standing higher. At solid dirt's
 * `DIRT_REPOSE` that is a compact mound — measured on generated ground, a Dirt
 * Clod's pile is 0.66 columns wide per pixel of height; at Liquid Dirt's
 * quarter pixel it is a wide flat pool, 3.5 columns per pixel, that floods a
 * crater rather than capping it. Three properties follow from the shape, and
 * each one is a defect this replaced:
 *
 *  - It cannot build a spire. Stacking circular mounds on one column could, and
 *    did: a 136 px tower 35 px wide with a 127 px step down its side.
 *  - It cannot create a cliff that was not already there. Inside the pool the
 *    step is at most `ceil(repose)` and past its reach at most `POOL_RIM`,
 *    which is `MAX_BLAST_SLOPE` — the limit the whole destruction path is held
 *    to. At the boundary the filled column rises toward the blocking ground, so
 *    that step only ever shrinks.
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

/**
 * What one blast centred on `(x, y)` does to a tank standing at
 * `(tankX, tankY)`, before any per-pool scaling.
 *
 * The single definition of how far a blast is from a tank, and the reason it is
 * a function rather than two lines inside `blast()`: the answer is measured
 * from the SKIN of the hull, not from its centre, and a second copy of that
 * rule anywhere — in a test, in a bot's scoring, in a future weapon — would be
 * a copy that could disagree.
 *
 * Why the skin. A tank is a `TANK_HULL_RADIUS` circle and `physics.ts` stops a
 * shell the instant it touches that circle, so a shell caught square on the
 * hull reports an impact point a full hull radius away from the point the
 * damage is measured against. Charging it that radius of falloff is what made a
 * direct hit do roughly half damage: on a Baby Missile (radius 18) the impact
 * sat at exactly the 50% mark, so the free weapon dealt 13 a hit and took EIGHT
 * hits to destroy a full-health tank, from a table row that says 25. Measured,
 * not deduced — `test/game-damage.test.ts` flies real shots and counts.
 *
 * Subtracting the hull is the rule the crater already plays by (a blast that
 * reaches the ground moves it) and it makes the number in the table mean "what
 * a direct hit does". It widens every blast's reach by one hull as a side
 * effect, which is the correct side effect: a blast that touches the tank has
 * touched the tank.
 */
export function damageToTankAt(
  weapon: WeaponDef,
  x: number,
  y: number,
  tankX: number,
  tankY: number,
): number {
  const distance = hypot2(tankX - x, tankY - TANK_DAMAGE_OFFSET - y) - TANK_HULL_RADIUS;
  return damageAtDistance(weapon, distance > 0 ? distance : 0);
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

    const damage = damageToTankAt(weapon, x, y, tank.x, tank.y) * damageScale;
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
