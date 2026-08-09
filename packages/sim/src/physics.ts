/**
 * Projectile integration.
 *
 * Semi-implicit Euler at a fixed timestep, with the terrain sampled along every
 * step so a fast projectile can never tunnel through a thin ridge. That
 * no-tunnelling guarantee is a property test in the suite, not a hope.
 *
 * Three things here are load-bearing and each has its reasoning written down
 * next to the constant that encodes it: how hard wind pushes (`windAuthority`),
 * why a step can never outrun the collision sweep (`maxSpeed`), and how a long
 * flight stays a small array (`maxPathPoints`).
 */

import { clamp, detCosDeg, detSinDeg, hypot2 } from './math.ts';
import { isSolid, type Terrain } from './terrain.ts';

/** Global integration constants. Tuned to feel like the original at 1280x720. */
export const PHYSICS = {
  /** Pixels per second squared. */
  gravity: 260,
  /** Fixed integration step, seconds. */
  dt: 1 / 60,
  /** Muzzle speed at power 100, pixels per second. */
  powerScale: 5.2,

  /**
   * Largest |wind| the game ever produces.
   *
   * This must equal `DEFAULT_WORLD.maxWind` in `game.ts`, which is where wind is
   * actually rolled. It cannot import it — `game.ts` imports this file — so the
   * mirror is asserted in `test/physics.test.ts` instead. It matters twice over:
   * it is the clamp applied to every caller's wind, so a larger world maxWind
   * would be silently truncated here and the HUD would lie about what the shell
   * feels; and it is the denominator of `windScale`, so the "full wind costs an
   * eighth of range" contract below is stated relative to it.
   */
  maxWind: 10,
  /**
   * Wind authority — the one knob that decides how much wind matters.
   *
   * Wind stays a constant horizontal acceleration, exactly as in the original:
   * the arc remains a parabola, so "more power goes further, 45 degrees goes
   * furthest" still holds and the gun stays learnable. What was wrong was the
   * magnitude. At the old `windScale: 26`, full wind pushed sideways at
   * 260 px/s^2 — precisely as hard as gravity pulls down — and the results were
   * farce: a power-5 shot fired straight up rose 1 pixel and landed 22 pixels
   * downwind; a power-60 lob drifted 559 px across a 382 px range. Correct
   * integration of a badly chosen constant.
   *
   * Expressing the constant as a fraction of gravity makes the feel provable.
   * Firing at angle t with speed v, flight time is T = 2*v*sin(t)/g and range is
   * R = v^2*sin(2t)/g, so a constant sideways acceleration a gives
   *
   *     drift D = a*T^2/2   =>   D / R = (a / g) * tan(t)
   *
   * — independent of power. With a_max = g / windAuthority, full wind costs a
   * flat shot at 45 degrees an eighth of its range whatever the power setting,
   * and punishes high lobs harder (tan(75 deg) is 3.7x tan(45 deg)), which is
   * exactly the tactical texture the original had. `test/physics.test.ts` pins
   * the resulting distance.
   */
  windAuthority: 8,
  /** Wind acceleration per unit of wind: gravity / (maxWind * windAuthority). */
  windScale: 3.25,

  /** Sub-samples per step used for the swept collision check. */
  maxSubSteps: 64,
  /**
   * Hard speed ceiling, pixels per second.
   *
   * Nothing the game fires comes near it — the fastest muzzle is 520 px/s and a
   * shell falling the full height of the world reaches about 770. The ceiling
   * exists to turn "the sweep samples at most one pixel apart" from a property
   * of the current tuning into a property of the code: at 3600 px/s a step
   * covers 60 px, so `ceil(distance)` can never reach `maxSubSteps` and the
   * clamp there can never silently coarsen the sampling. Without it, a caller
   * passing a large `velocity` override could tunnel.
   *
   * It is a real clamp at every finite velocity, up to and including
   * `Number.MAX_VALUE` — see the overflow note at the clamp site, and the test
   * that fires at 1e308 and measures the step length.
   */
  maxSpeed: 3600,
  /** Hard cap so a shot fired straight up into low gravity still terminates. */
  maxSteps: 3600,
  /**
   * Most path points returned to the client, excluding the impact point.
   *
   * A normal shot emits one point per step — a two-second arc is 120 points,
   * which the client animates smoothly. Pathological flights are the problem: a
   * low-gravity mortar lobbed off the top of the screen runs 3056 steps, and
   * every point of it crosses the wire as JSON in a broadcast (3057 points,
   * 70 KB). Past this budget the path halves its own resolution and keeps
   * going: the same shot comes back as 383 points and 8.9 KB.
   *
   * The retained points are exact integration samples — nothing is interpolated
   * or averaged. Emission is `step % stride === 0`, so after any number of
   * halvings path point `i` is precisely the position after step `i * stride`:
   * evenly spaced in time, in order, never a point out of rhythm. The drawn arc
   * is the same curve, just sampled more coarsely the longer the flight lasts.
   * (The appended impact point is the one exception — it lands wherever the
   * shell actually hit.)
   *
   * MUST BE EVEN. That is what keeps the step a halving fires on a multiple of
   * the doubled stride — see the emit site — and it is asserted in
   * `test/physics.test.ts`, because an odd budget would silently put one point
   * per halving off-rhythm.
   *
   * `test/physics.test.ts` pins the resulting point count and JSON size as
   * absolute numbers, not as a restatement of this constant.
   */
  maxPathPoints: 512,
  /**
   * How far clear of a hit circle the shell must get before it arms against it,
   * as a multiple of that circle's own radius.
   *
   * Zero clearance is not enough. A flat, low-power shot leaves its own tank's
   * circle through the side, then falls back across the rim a pixel later and
   * detonates on the shooter: at factor 1 (rim-touching arms the shell) 226 of
   * the 2172 angle/power combinations below power 12 did exactly that, some of
   * them "flights" of twelve steps. The shell must reach real separation before
   * "outside the circle" means "gone".
   *
   * A multiple of the radius rather than a pixel count, for two reasons: it
   * scales with whatever is being shot at (a shield bubble is not a tank), and
   * it does not silently depend on `DEFAULT_WORLD.tankRadius` living in another
   * file. 1.5 is half a radius of clear air past the rim — 4.5 px for the
   * standard 9 px tank, a quarter of the hull's width.
   *
   * There is no knee in the data to appeal to — self-hits fall off smoothly as
   * the margin grows — so the value is pinned from both sides by measurement
   * instead. `test/physics.test.ts` runs the whole 181 x 101 angle/power grid
   * and asserts the EXACT self-hit count, 346, plus the exact shortest self-hit
   * flight, 27 steps. Measured over that grid, those two numbers hold on
   * armFactor in [1.4998, 1.5002] and nowhere else: 1.4997 gives 348 self-hits,
   * 1.5003 gives 344 and a 28-step shortest. The coarser landmarks either side
   * are the ones that matter for feel — the lowest self-detonating power is 12
   * from 1.37 to 1.502, drops to 11 at 1.36 and below (and to 8 with no margin
   * at all), and climbs to 13 at 1.503, 16 at 2 and 21 at 3.
   */
  armFactor: 1.5,
  /** How far off-screen (left/right/top) a projectile may drift before it is lost. */
  offscreenMargin: 400,
} as const;

/**
 * Cheap pre-filter for the speed clamp: |v| <= sqrt(2) * max(|vx|, |vy|), so no
 * velocity whose largest component is under this can possibly exceed
 * `maxSpeed`. Below it the per-step work is two `abs`, a `max` and a compare.
 */
const CLAMP_TRIGGER = PHYSICS.maxSpeed / Math.sqrt(2);

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
  /**
   * Sampled flight path. One point per integration step for any normal shot;
   * for a very long flight, every `stride`-th step, evenly spaced (see
   * `PHYSICS.maxPathPoints`). Points are exact integration samples, never
   * interpolated. The final point is always the impact point.
   */
  points: Float64Array;
  /** Number of (x, y) pairs in `points`. */
  length: number;
  impact: Impact;
  /**
   * Integration steps taken. Equals `length - 1` unless the path was thinned,
   * so it stays a true measure of how long the shell was in the air.
   */
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
  const { terrain } = options;
  const gravity = PHYSICS.gravity * (options.gravityScale ?? 1);
  // Clamp the wind the same way the turn machine does, so no caller — or
  // hand-crafted message that got past the schema — can hand the shell a
  // hurricane the tuning above was never balanced for.
  const wind = clamp(options.wind, -PHYSICS.maxWind, PHYSICS.maxWind);
  const windAccel = options.windImmune === true ? 0 : wind * PHYSICS.windScale;
  const dt = PHYSICS.dt;

  const initial = options.velocity ?? launchVelocity(spawn.angleDeg, spawn.power);
  let x = spawn.x;
  let y = spawn.y;
  let vx = initial.vx;
  let vy = initial.vy;

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(vx) ||
    !Number.isFinite(vy) ||
    !Number.isFinite(gravity) ||
    !Number.isFinite(windAccel)
  ) {
    // A NaN anywhere in the initial conditions would otherwise run the full step
    // budget doing NaN arithmetic and hand back a trajectory nothing can draw.
    // Fail closed instead: a shell that never existed, at a finite position.
    const safeX = Number.isFinite(spawn.x) ? spawn.x : 0;
    const safeY = Number.isFinite(spawn.y) ? spawn.y : 0;
    return {
      points: Float64Array.of(safeX, safeY),
      length: 1,
      impact: { kind: 'expired', x: safeX, y: safeY },
      steps: 0,
    };
  }

  // Grow-on-demand path buffer. Two floats per point. Bounded above by the
  // decimation below, so this doubles at most a handful of times.
  let capacity = 128;
  let points = new Float64Array(capacity * 2);
  let length = 0;

  const emit = (px: number, py: number): void => {
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

  // Emit every `stride`-th step, keyed off the absolute step number rather than
  // a countdown since the last emit. That is what makes the retained samples
  // stay exactly `stride` apart across a halving: the survivors of a halving are
  // the even-indexed points, i.e. steps 0, 2*stride, 4*stride, …, which are
  // precisely the multiples of the new stride.
  let stride = 1;
  /** Throw away every other point and emit half as often from here on. */
  const halveResolution = (): void => {
    let write = 0;
    for (let read = 0; read < length; read += 2) {
      points[write * 2] = points[read * 2] as number;
      points[write * 2 + 1] = points[read * 2 + 1] as number;
      write += 1;
    }
    length = write;
    stride *= 2;
  };

  emit(x, y);

  // A target flagged `ignore` starts disarmed and arms itself the moment the
  // shell is clear of its circle. Step counting cannot do this correctly: a
  // flat, low-power shot travels only a couple of pixels per step and would
  // still be inside its own tank when the grace period expired.
  const targets = options.targets;
  const armed = targets === undefined ? undefined : targets.map((target) => target.ignore !== true);

  let impact: Impact | null = null;
  let steps = 0;

  for (let step = 0; step < PHYSICS.maxSteps; step += 1) {
    steps = step + 1;

    // Semi-implicit Euler: update velocity first, then position.
    vx += windAccel * dt;
    vy += gravity * dt;

    // Clamp to `maxSpeed`, scaling by the LARGEST COMPONENT rather than by the
    // speed itself. `vx*vx + vy*vy` overflows to Infinity once |v| passes
    // sqrt(Number.MAX_VALUE) = 1.3407807929942596e154, and `maxSpeed / Infinity`
    // is 0 — the clamp would then zero the velocity outright instead of capping
    // it. That was measurable: with `velocity: {vx: 1e160, vy: 0}` the shell
    // dropped at the muzzle instead of flying at the ceiling. Both ratios below
    // are in [-1, 1], so nothing here can overflow for any finite input, and
    // `maxSpeed / unit` is between maxSpeed/sqrt(2) and maxSpeed.
    const largest = Math.max(Math.abs(vx), Math.abs(vy));
    if (largest > CLAMP_TRIGGER) {
      const unit = hypot2(vx / largest, vy / largest); // 1 <= unit <= sqrt(2)
      if (largest > PHYSICS.maxSpeed / unit) {
        const scale = PHYSICS.maxSpeed / unit / largest;
        vx *= scale;
        vy *= scale;
      }
    }

    const nextX = x + vx * dt;
    const nextY = y + vy * dt;

    const hit = sweep(x, y, nextX, nextY, terrain, targets, armed);
    if (hit !== null) {
      impact = hit;
      break;
    }

    x = nextX;
    y = nextY;

    if (steps % stride === 0) {
      // The halving doubles the stride, and this very step must still be a
      // multiple of the doubled one or the emit below would land off-rhythm.
      // It always is, and that follows from `maxPathPoints` being EVEN: `length`
      // only ever grows one point per emit, so it arrives at the budget exactly,
      // at step `length * stride`; with length = maxPathPoints even, that step
      // divides by the doubled stride too (quotient maxPathPoints/2). Replaying
      // the whole schedule confirms it — halvings fire at steps 512, 1024, 2048
      // with quotient 256 every time, and there is no off-rhythm step for any
      // even budget or any step budget. `test/physics.test.ts` pins the parity.
      if (length >= PHYSICS.maxPathPoints) halveResolution();
      emit(x, y);
    }

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

  // Ran the whole step budget without hitting anything: report where it got to,
  // not where it started.
  impact ??= { kind: 'expired', x, y };

  // The impact point is always the last point of the path, whatever the
  // decimation did — the client draws the trail straight to the explosion.
  if (points[(length - 1) * 2] !== impact.x || points[(length - 1) * 2 + 1] !== impact.y) {
    emit(impact.x, impact.y);
  }

  return { points, length, impact, steps };
}

/**
 * Swept collision along one integration step.
 *
 * Samples at no more than one pixel apart, which is what makes tunnelling
 * impossible regardless of projectile speed. `PHYSICS.maxSpeed` bounds a step at
 * 60 px, so the `maxSubSteps` clamp below is a backstop that never fires.
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
        const distanceSquared = ddx * ddx + ddy * ddy;

        if (armed[index] !== true) {
          // Disarmed against this target (it is the shooter). Arm only once the
          // shell is clear of the circle by a real margin — see
          // `PHYSICS.armFactor`.
          const clearance = target.radius * PHYSICS.armFactor;
          if (distanceSquared > clearance * clearance) armed[index] = true;
          continue;
        }

        if (distanceSquared <= target.radius * target.radius) {
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
