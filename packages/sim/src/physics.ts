/**
 * Projectile integration.
 *
 * Semi-implicit Euler at a fixed timestep, with the terrain sampled along every
 * step so a fast projectile can never tunnel through a thin ridge. That
 * no-tunnelling guarantee is a property test in the suite, not a hope.
 */

import { clamp, detCosDeg, detSinDeg, hypot2 } from './math.ts';
import { isSolid, type Terrain } from './terrain.ts';

/** Global integration constants. Tuned to feel like the original at 1280x720. */
export const PHYSICS = {
  /** Pixels per second squared. */
  gravity: 260,
  /** Wind acceleration per unit of wind, pixels per second squared. */
  windScale: 26,
  /** Fixed integration step, seconds. */
  dt: 1 / 60,
  /** Sub-samples per step used for the swept collision check. */
  maxSubSteps: 64,
  /** Hard cap so a shot fired straight up into low gravity still terminates. */
  maxSteps: 3600,
  /** Muzzle speed at power 100, pixels per second. */
  powerScale: 5.2,
  /** How far off-screen (left/right/top) a projectile may drift before it is lost. */
  offscreenMargin: 400,
} as const;

export interface ProjectileSpawn {
  x: number;
  y: number;
  /** Degrees, 0 = due right, 90 = straight up (matches the original's readout). */
  angleDeg: number;
  /** 0..100, as shown in the UI. */
  power: number;
}

export type ImpactKind = 'terrain' | 'tank' | 'wall' | 'expired';

export interface Impact {
  kind: ImpactKind;
  x: number;
  y: number;
  /** Index into the tank array when `kind === 'tank'`. */
  tankIndex?: number;
}

export interface Trajectory {
  /** Sampled flight path, one point per integration step, including the start. */
  points: Float64Array;
  /** Number of (x, y) pairs in `points`. */
  length: number;
  impact: Impact;
  /** Steps taken — used by the client to time the flight animation. */
  steps: number;
}

/** A circular target the projectile can hit in flight. */
export interface HitCircle {
  x: number;
  y: number;
  radius: number;
  /**
   * Set on the tank that fired the shot. The shell spawns inside its own hit
   * circle, so it stays disarmed against this target until it has physically
   * left the circle — after which it can hit it like anyone else (which is how
   * you manage to drop a shell on your own head, as tradition demands).
   */
  ignore?: boolean;
}

export interface FlightOptions {
  terrain: Terrain;
  /** Wind, roughly -10..10. Positive blows right. */
  wind: number;
  targets?: readonly HitCircle[];
  /** Overrides for weapons that fly differently (heavier, wind-immune, …). */
  gravityScale?: number;
  windImmune?: boolean;
  /** Initial velocity override, bypassing angle/power (used by cluster children). */
  velocity?: { vx: number; vy: number };
}

/** Convert the UI's angle+power into a velocity vector. */
export function launchVelocity(angleDeg: number, power: number): { vx: number; vy: number } {
  const speed = clamp(power, 0, 100) * PHYSICS.powerScale;
  return {
    vx: detCosDeg(angleDeg) * speed,
    // Screen Y grows downward, so "up" is negative.
    vy: -detSinDeg(angleDeg) * speed,
  };
}

/**
 * Fly a projectile until it hits something.
 *
 * Deterministic: no clock, no randomness, fixed timestep. Given identical
 * inputs this returns an identical trajectory on every engine.
 */
export function simulateFlight(spawn: ProjectileSpawn, options: FlightOptions): Trajectory {
  const { terrain, wind } = options;
  const gravity = PHYSICS.gravity * (options.gravityScale ?? 1);
  const windAccel = options.windImmune ? 0 : wind * PHYSICS.windScale;
  const dt = PHYSICS.dt;

  const initial = options.velocity ?? launchVelocity(spawn.angleDeg, spawn.power);
  let x = spawn.x;
  let y = spawn.y;
  let vx = initial.vx;
  let vy = initial.vy;

  // Grow-on-demand path buffer. Two floats per point.
  let capacity = 256;
  let points = new Float64Array(capacity * 2);
  let length = 0;

  const push = (px: number, py: number): void => {
    if (length >= capacity) {
      capacity *= 2;
      const grown = new Float64Array(capacity * 2);
      grown.set(points);
      points = grown;
    }
    points[length * 2] = px;
    points[length * 2 + 1] = py;
    length += 1;
  };

  push(x, y);

  let impact: Impact = { kind: 'expired', x, y };

  // A target flagged `ignore` starts disarmed and arms itself the moment the
  // shell is clear of its circle. Step counting cannot do this correctly: a
  // flat, low-power shot travels only a couple of pixels per step and would
  // still be inside its own tank when the grace period expired.
  const targets = options.targets;
  const armed = targets === undefined ? undefined : targets.map((target) => target.ignore !== true);

  for (let step = 0; step < PHYSICS.maxSteps; step += 1) {
    // Semi-implicit Euler: update velocity first, then position.
    vx += windAccel * dt;
    vy += gravity * dt;

    const nextX = x + vx * dt;
    const nextY = y + vy * dt;

    const hit = sweep(x, y, nextX, nextY, terrain, targets, armed);
    if (hit !== null) {
      push(hit.x, hit.y);
      impact = hit;
      break;
    }

    x = nextX;
    y = nextY;
    push(x, y);

    // Off the sides or below the world: gone. Above the world is legal —
    // lobbing a shot off the top of the screen is a real Scorched Earth move.
    if (
      x < -PHYSICS.offscreenMargin ||
      x > terrain.width + PHYSICS.offscreenMargin ||
      y > terrain.height + PHYSICS.offscreenMargin
    ) {
      impact = { kind: 'wall', x, y };
      break;
    }
  }

  return { points, length, impact, steps: length - 1 };
}

/**
 * Swept collision along one integration step.
 *
 * Samples at no more than one pixel apart, which is what makes tunnelling
 * impossible regardless of projectile speed.
 */
function sweep(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  terrain: Terrain,
  targets: readonly HitCircle[] | undefined,
  armed: boolean[] | undefined,
): Impact | null {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = hypot2(dx, dy);
  const samples = clamp(Math.ceil(distance), 1, PHYSICS.maxSubSteps);

  for (let i = 1; i <= samples; i += 1) {
    const t = i / samples;
    const px = fromX + dx * t;
    const py = fromY + dy * t;

    if (targets !== undefined && armed !== undefined) {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index] as HitCircle;
        const ddx = px - target.x;
        const ddy = py - target.y;
        const inside = ddx * ddx + ddy * ddy <= target.radius * target.radius;

        if (armed[index] !== true) {
          // Disarmed against this target (it is the shooter). Arm as soon as
          // the shell is genuinely clear of the circle.
          if (!inside) armed[index] = true;
          continue;
        }

        if (inside) {
          return { kind: 'tank', x: px, y: py, tankIndex: index };
        }
      }
    }

    if (isSolid(terrain, px, py)) {
      return { kind: 'terrain', x: px, y: py };
    }
  }

  return null;
}

/** Read point `index` out of a trajectory. */
export function trajectoryPoint(
  trajectory: Trajectory,
  index: number,
): { x: number; y: number } | undefined {
  if (index < 0 || index >= trajectory.length) return undefined;
  return {
    x: trajectory.points[index * 2] as number,
    y: trajectory.points[index * 2 + 1] as number,
  };
}

/** Compact the path to a plain array for transport / snapshotting. */
export function trajectoryToArray(trajectory: Trajectory): number[] {
  return Array.from(trajectory.points.subarray(0, trajectory.length * 2));
}
