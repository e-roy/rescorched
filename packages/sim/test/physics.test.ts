import { describe, expect, it } from 'vitest';
import { emptyTerrain, generateTerrain, isSolid } from '../src/terrain.ts';
import {
  launchVelocity,
  PHYSICS,
  simulateFlight,
  trajectoryPoint,
  trajectoryToArray,
  type FlightOptions,
  type HitCircle,
  type Trajectory,
} from '../src/physics.ts';
import { DEFAULT_WORLD } from '../src/game.ts';
import { makeRng } from '../src/rng.ts';

const WIDTH = 640;
const HEIGHT = 400;

/** The real playfield, for anything that reasons about game-feel distances. */
const FIELD_WIDTH = 1280;
const FIELD_HEIGHT = 720;
const GROUND_Y = 600;
/** Where `game.ts` puts the muzzle: tankRadius + 2 above the tank's foot. */
const MUZZLE_Y = GROUND_Y - 11;
const MUZZLE_X = 200;

function flat(surfaceY: number, width = WIDTH, height = HEIGHT) {
  const terrain = emptyTerrain(width, height);
  terrain.surface.fill(surfaceY);
  return terrain;
}

function field() {
  return flat(GROUND_Y, FIELD_WIDTH, FIELD_HEIGHT);
}

/** Fire from the standard muzzle across the standard field. */
function shoot(angleDeg: number, power: number, wind: number, extra?: Partial<FlightOptions>) {
  return simulateFlight(
    { x: MUZZLE_X, y: MUZZLE_Y, angleDeg, power },
    { terrain: field(), wind, ...extra },
  );
}

function pathXs(trajectory: Trajectory): number[] {
  const out: number[] = [];
  for (let i = 0; i < trajectory.length; i += 1) out.push(trajectory.points[i * 2] as number);
  return out;
}

/** Longest gap between consecutive path points — the sweep's tunnelling budget. */
function longestGap(trajectory: Trajectory): number {
  let worst = 0;
  for (let i = 1; i < trajectory.length; i += 1) {
    const dx = (trajectory.points[i * 2] as number) - (trajectory.points[(i - 1) * 2] as number);
    const dy =
      (trajectory.points[i * 2 + 1] as number) - (trajectory.points[(i - 1) * 2 + 1] as number);
    worst = Math.max(worst, Math.sqrt(dx * dx + dy * dy));
  }
  return worst;
}

/** All sky except one single-column wall at x = 320. */
function oneColumnWall() {
  const terrain = emptyTerrain(WIDTH, HEIGHT);
  terrain.surface.fill(HEIGHT);
  terrain.surface[320] = 0;
  return terrain;
}

/** Bytes this path costs in a broadcast — the thing the path budget exists for. */
function wireBytes(trajectory: Trajectory): number {
  return JSON.stringify(trajectoryToArray(trajectory)).length;
}

describe('launch velocity', () => {
  it('fires right at 0 degrees and left at 180', () => {
    expect(launchVelocity(0, 100).vx).toBeGreaterThan(0);
    expect(launchVelocity(180, 100).vx).toBeLessThan(0);
    // Horizontal in both cases, and mirror images of each other.
    expect(Math.abs(launchVelocity(0, 100).vy)).toBeLessThan(1e-9);
    expect(Math.abs(launchVelocity(180, 100).vy)).toBeLessThan(1e-9);
    expect(launchVelocity(180, 100).vx).toBeCloseTo(-launchVelocity(0, 100).vx, 9);
  });

  it('fires straight up at 90 degrees', () => {
    const velocity = launchVelocity(90, 100);
    expect(Math.abs(velocity.vx)).toBeLessThan(1e-9);
    expect(velocity.vy).toBeLessThan(0); // screen Y grows downward
    expect(velocity.vy).toBeCloseTo(-100 * PHYSICS.powerScale, 9);
  });

  it('scales linearly with power', () => {
    const half = launchVelocity(45, 50);
    const full = launchVelocity(45, 100);
    expect(full.vx).toBeCloseTo(half.vx * 2, 9);
    expect(full.vy).toBeCloseTo(half.vy * 2, 9);

    // Linear at every step, not just at the ends: speed = power * powerScale.
    for (let power = 0; power <= 100; power += 5) {
      const { vx, vy } = launchVelocity(37, power);
      expect(Math.sqrt(vx * vx + vy * vy)).toBeCloseTo(power * PHYSICS.powerScale, 9);
    }
  });

  it('stands still at power 0 and clamps beyond 100', () => {
    const still = launchVelocity(45, 0);
    expect(Math.abs(still.vx)).toBe(0);
    expect(Math.abs(still.vy)).toBe(0);
    expect(launchVelocity(45, 1000)).toEqual(launchVelocity(45, 100));
  });
});

describe('flight', () => {
  it('always lands on terrain when fired at it', () => {
    const terrain = flat(300);
    const result = simulateFlight(
      { x: 100, y: 290, angleDeg: 45, power: 70 },
      { terrain, wind: 0 },
    );
    expect(result.impact.kind).toBe('terrain');
    expect(result.length).toBeGreaterThan(2);
  });

  it('never reports an impact point inside solid rock', () => {
    const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(17));
    for (let angle = 10; angle <= 170; angle += 5) {
      const result = simulateFlight(
        { x: 60, y: 40, angleDeg: angle, power: 85 },
        { terrain, wind: 3 },
      );
      if (result.impact.kind !== 'terrain') continue;
      // The impact is the FIRST solid sample, so the point just before it
      // along the path must still be sky.
      const previous = trajectoryPoint(result, result.length - 2);
      expect(previous).toBeDefined();
      expect(isSolid(terrain, previous!.x, previous!.y)).toBe(false);
    }
  });

  it('never leaves a solid path point behind, on any generated map', () => {
    for (const seed of [3, 11, 29, 61]) {
      const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(seed));
      for (let angle = 5; angle <= 175; angle += 7) {
        const result = simulateFlight(
          { x: 40, y: 30, angleDeg: angle, power: 95 },
          { terrain, wind: -6 },
        );
        // Every point except the final impact must be clear air: the impact is
        // by definition the first solid sample the sweep found.
        for (let i = 0; i < result.length - 1; i += 1) {
          const point = trajectoryPoint(result, i)!;
          expect(isSolid(terrain, point.x, point.y)).toBe(false);
        }
      }
    }
  });

  it('does not tunnel through a thin ridge at extreme power', () => {
    const result = simulateFlight(
      { x: 10, y: 200, angleDeg: 0, power: 100 },
      { terrain: oneColumnWall(), wind: 0 },
    );

    expect(result.impact.kind).toBe('terrain');
    expect(result.impact.x).toBeGreaterThanOrEqual(319);
    expect(result.impact.x).toBeLessThanOrEqual(322);
  });

  /**
   * The sweep samples `ceil(distance)` points, capped at `maxSubSteps`. That cap
   * would be a tunnelling hole if a step could ever cover more than
   * `maxSubSteps` pixels — so `PHYSICS.maxSpeed` bounds the step at 60 px and
   * the cap becomes unreachable.
   *
   * The speeds past 1.3407807929942596e154 = sqrt(Number.MAX_VALUE) are the
   * whole point of the list. That is where `vx*vx + vy*vy` overflows to
   * Infinity, and a clamp written as `maxSpeed / Math.sqrt(vx*vx + vy*vy)`
   * scales the velocity by 3600/Infinity = 0 there — it ZEROES the shell
   * instead of capping it. That failure is safe (nothing tunnels) but it is not
   * a ceiling, and a test that only checks "did not overshoot the wall" cannot
   * see it: the shell parks at the muzzle, x = 10, which is comfortably under
   * 322. Asserting that the shell REACHES the wall, at the ceiling speed, is
   * what catches it.
   *
   * Measured against the pre-fix code, over exactly the speeds below: 1e4
   * through 1.34e154 all still reach the wall, every one of them in 6 steps of
   * 60 px, landing at x = 320.82 (1e4, 1.34e154) or x = 321.00 (1e7, 1e12).
   * Those two columns are the same flight sampled differently, not two
   * behaviours: the last step's swept distance comes out one ulp above 60 px
   * for the first pair and at-or-below it for the second, so `ceil` hands the
   * sweep 61 samples or 60 and the first sample to land in column 320 shifts by
   * 0.18 px. That is why the assertions bracket the column rather than pin it —
   * a `toBe` there would be pinning a rounding mode.
   *
   * 1.35e154 through MAX_VALUE are the ones that matter: they land at x = 10.00
   * after 75 steps of 5.34 px, which is the shell dropping straight out of the
   * barrel under gravity alone. That is the failure this test exists for.
   */
  it('clamps rather than zeroes at any finite velocity, up to Number.MAX_VALUE', () => {
    for (const speed of [1e4, 1e7, 1e12, 1.34e154, 1.35e154, 1e200, 1e308, Number.MAX_VALUE]) {
      const result = simulateFlight(
        { x: 10, y: 200, angleDeg: 0, power: 0 },
        { terrain: oneColumnWall(), wind: 0, velocity: { vx: speed, vy: 0 } },
      );

      expect(result.impact.kind).toBe('terrain');
      // It flew to the wall …
      expect(result.impact.x).toBeGreaterThanOrEqual(319);
      expect(result.impact.x).toBeLessThanOrEqual(322);
      // … and it got there at the ceiling: 3600 px/s at 1/60 s is 60 px a step.
      // Absolute numbers, not `maxSpeed * dt` — that would restate the code.
      expect(longestGap(result)).toBeGreaterThan(59.999);
      expect(longestGap(result)).toBeLessThan(60.001);
      expect(result.steps).toBe(6);
    }
  });

  it('never advances more than maxSubSteps pixels in one step', () => {
    const terrain = flat(HEIGHT);
    for (const velocity of [
      { vx: 1e9, vy: 0 },
      { vx: 0, vy: 1e9 },
      { vx: -1e12, vy: 1e12 },
      // Past the overflow cliff, and with both components at the maximum so the
      // clamp has to handle a diagonal it cannot square.
      { vx: 1e308, vy: -1e308 },
      { vx: -Number.MAX_VALUE, vy: Number.MAX_VALUE },
      // The diagonal that only a diagonal-aware test catches: neither component
      // reaches the 3600 px/s ceiling, but together they make 4243 px/s — a
      // 70.7 px step, past the 64 samples the sweep has to spend on it. A clamp
      // that triggers on `max(|vx|, |vy|) > maxSpeed` would wave this through.
      { vx: 3000, vy: -3000 },
    ]) {
      const result = simulateFlight(
        { x: 320, y: 200, angleDeg: 0, power: 0 },
        { terrain, wind: 10, velocity },
      );
      // Only meaningful while the path is one point per step; a decimated path
      // deliberately skips steps. Short escapes like these never decimate.
      expect(result.length).toBe(result.steps + 1);
      expect(longestGap(result)).toBeLessThanOrEqual(PHYSICS.maxSubSteps);
      // The real bound is tighter than the sweep cap, and that gap is the
      // safety margin: 60 px a step against 64 samples available.
      expect(longestGap(result)).toBeLessThan(60.001);
    }
  });
});

describe('wind', () => {
  it('derives its strength from gravity', () => {
    expect(PHYSICS.windScale).toBe(PHYSICS.gravity / (PHYSICS.maxWind * PHYSICS.windAuthority));
  });

  /**
   * `PHYSICS.maxWind` is doubly load-bearing and self-consistent, so nothing
   * else in this file can catch it drifting: it is the clamp applied to every
   * caller's wind AND the denominator of `windScale`. `game.ts` rolls wind from
   * `DEFAULT_WORLD.maxWind` at three sites. If that number were raised to 15,
   * every shot would be silently clamped back to 10 here, the HUD would report
   * a wind the shell does not feel, and the "full wind costs an eighth of range"
   * contract would quietly break — while every other wind test above still
   * passed, because they are all stated in terms of `PHYSICS.maxWind` itself.
   * physics.ts cannot import the constant (game.ts imports physics.ts), so this
   * line is the mirror.
   */
  it('clamps at exactly the wind the game rolls', () => {
    expect(PHYSICS.maxWind).toBe(DEFAULT_WORLD.maxWind);
  });

  it('blows the shell downwind', () => {
    const terrain = flat(300);
    const still = simulateFlight({ x: 100, y: 290, angleDeg: 60, power: 80 }, { terrain, wind: 0 });
    const windy = simulateFlight({ x: 100, y: 290, angleDeg: 60, power: 80 }, { terrain, wind: 8 });
    const against = simulateFlight(
      { x: 100, y: 290, angleDeg: 60, power: 80 },
      { terrain, wind: -8 },
    );
    expect(windy.impact.x).toBeGreaterThan(still.impact.x);
    expect(against.impact.x).toBeLessThan(still.impact.x);
  });

  it('honours windImmune', () => {
    const terrain = flat(300);
    const still = simulateFlight({ x: 100, y: 290, angleDeg: 60, power: 80 }, { terrain, wind: 0 });
    const immune = simulateFlight(
      { x: 100, y: 290, angleDeg: 60, power: 80 },
      { terrain, wind: 9, windImmune: true },
    );
    expect(immune.impact.x).toBeCloseTo(still.impact.x, 9);
  });

  /**
   * The number that decides whether wind feels like weather or like a slot
   * machine. A power-60 shot at 45 degrees carries 382 px — roughly a third of
   * the 1280 px field, the everyday mid-range shot. At maximum wind it lands
   * 49 px further downwind.
   *
   * Why 49 px is the right answer: a tank is 18 px across and the standard
   * blast radius is around 30, so full wind moves the shell by rather more than
   * a tank but less than two blast radii. You cannot ignore it — aim dead on and
   * you miss — but one notch of angle or a few points of power corrects it, and
   * a well-judged shot still lands. Before this was tuned the same shot drifted
   * 559 px, three times further than a mid-power shot travels, which is not
   * "wind matters", it is "the wind is playing, not you".
   */
  it('moves a mid-power shot about 49 px at full wind', () => {
    const still = shoot(45, 60, 0);
    const windy = shoot(45, 60, PHYSICS.maxWind);
    const range = still.impact.x - MUZZLE_X;
    const drift = windy.impact.x - still.impact.x;

    expect(range).toBeCloseTo(381.79, 1);
    expect(drift).toBeCloseTo(49.25, 1);
    // Under a seventh of the range: real compensation, never a lottery.
    expect(drift / range).toBeLessThan(1 / 7);
  });

  it('costs the same fraction of range at every power', () => {
    // Constant sideways acceleration a gives drift D = a*T^2/2 and range
    // R = v^2*sin(2t)/g with T = 2*v*sin(t)/g, so D/R = (a/g)*tan(t) — no v in
    // it. That power-independence is the reason wind stays learnable: whatever
    // you fire at 45 degrees, full wind costs about an eighth of the distance.
    const expected = 1 / PHYSICS.windAuthority;
    for (const power of [30, 40, 50, 60, 70, 80]) {
      const still = shoot(45, power, 0);
      const windy = shoot(45, power, PHYSICS.maxWind);
      const ratio = (windy.impact.x - still.impact.x) / (still.impact.x - MUZZLE_X);
      // The muzzle sits 11 px above the ground, which stretches the flight a
      // little past the flat-fire ideal; 10% either side covers that.
      expect(ratio).toBeGreaterThan(expected * 0.9);
      expect(ratio).toBeLessThan(expected * 1.2);
    }
  });

  it('punishes high lobs more than flat shots', () => {
    // …and by the predicted factor: D/R scales with tan(angle).
    const ratios = [30, 45, 60, 75].map((angle) => {
      const still = shoot(angle, 60, 0);
      const windy = shoot(angle, 60, PHYSICS.maxWind);
      return (windy.impact.x - still.impact.x) / (still.impact.x - MUZZLE_X);
    });
    for (let i = 1; i < ratios.length; i += 1) {
      expect(ratios[i] as number).toBeGreaterThan(ratios[i - 1] as number);
    }
    expect(ratios[1] as number).toBeCloseTo(1 / PHYSICS.windAuthority, 1);
  });

  it('barely nudges a shot that barely leaves the barrel', () => {
    // The old tuning's signature embarrassment: a power-5 shot fired straight up
    // rose one pixel and landed 22 px downwind. A shell that goes nowhere must
    // land where it was fired from.
    const still = shoot(90, 5, 0);
    const windy = shoot(90, 5, PHYSICS.maxWind);
    expect(Math.abs(windy.impact.x - still.impact.x)).toBeLessThan(4);
  });

  it('is symmetric: upwind loses what downwind gains', () => {
    const still = shoot(45, 60, 0);
    const down = shoot(45, 60, PHYSICS.maxWind);
    const up = shoot(45, 60, -PHYSICS.maxWind);
    expect(down.impact.x - still.impact.x).toBeCloseTo(still.impact.x - up.impact.x, 0);
  });

  it('clamps a hurricane down to maxWind', () => {
    // The turn machine only ever produces |wind| <= 10; a caller (or a message
    // that got past the schema) handing over 1000 must not get 100x the tuning.
    const capped = shoot(45, 60, PHYSICS.maxWind);
    const absurd = shoot(45, 60, 5000);
    expect(absurd.impact.x).toBe(capped.impact.x);
  });
});

describe('trajectory data', () => {
  it('samples one point per step for an ordinary shot', () => {
    const result = shoot(55, 70, 3);
    expect(result.steps).toBeGreaterThan(60);
    expect(result.length).toBe(result.steps + 1);
  });

  it('ends the path exactly at the impact point', () => {
    const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(5));
    for (let angle = 10; angle <= 170; angle += 11) {
      for (const power of [0, 20, 55, 100]) {
        const result = simulateFlight(
          { x: 300, y: 50, angleDeg: angle, power },
          { terrain, wind: 6 },
        );
        const last = trajectoryPoint(result, result.length - 1)!;
        expect(last.x).toBe(result.impact.x);
        expect(last.y).toBe(result.impact.y);
      }
    }
  });

  /**
   * Every bound here is an absolute number, deliberately. Asserting
   * `length <= PHYSICS.maxPathPoints + 1` would be a tautology: it holds for any
   * value of the constant, including one large enough to switch decimation off
   * entirely, which is the exact regression this budget exists to prevent.
   * Raise `maxPathPoints` to 100000 and this shot returns 3057 points and
   * 70 KB of JSON; these literals fail, as they should.
   */
  it('keeps even a pathological flight inside the path budget', () => {
    // A low-gravity mortar lobbed off the top of the screen: 3056 steps.
    const long = simulateFlight(
      { x: 640, y: 100, angleDeg: 90, power: 100 },
      { terrain: field(), wind: 0, gravityScale: 0.08 },
    );
    expect(long.steps).toBeGreaterThan(2000);
    expect(long.length).toBeLessThan(600);
    expect(trajectoryToArray(long).length).toBeLessThan(1300);
    // The promise in the `maxPathPoints` doc comment is about the wire, so
    // measure the wire: under 12 KB of JSON per broadcast shot, not 70.
    expect(wireBytes(long)).toBeLessThan(12000);
    // Still dense enough to animate: hundreds of points, not a dozen.
    expect(long.length).toBeGreaterThan(200);
  });

  /**
   * Decimation must drop points, never move, average or invent them.
   *
   * This re-integrates the same shot with the same arithmetic the sim uses. The
   * duplication is deliberate: it is the only way to prove the surviving points
   * are exact samples of the flight, and it doubles as a check that the
   * integrator really is semi-implicit Euler at a fixed step. Bit equality, not
   * a tolerance — anything else would let an interpolated midpoint through.
   */
  it('returns exact integration samples, evenly spaced in step index', () => {
    const gravityScale = 0.08;
    const spawn = { x: 640, y: 100, angleDeg: 90, power: 100 };
    const long = simulateFlight(spawn, { terrain: field(), wind: 0, gravityScale });
    // It really did decimate; otherwise the rest of this proves nothing.
    expect(long.length).toBeLessThan(long.steps / 4);

    const gravity = PHYSICS.gravity * gravityScale;
    const dt = PHYSICS.dt;
    const start = launchVelocity(spawn.angleDeg, spawn.power);
    const vx = start.vx; // no wind, so horizontal velocity never changes
    let vy = start.vy;
    let x = spawn.x;
    let y = spawn.y;
    const sampleX = [x];
    const sampleY = [y];
    for (let n = 0; n < long.steps; n += 1) {
      vy += gravity * dt;
      x = x + vx * dt;
      y = y + vy * dt;
      sampleX.push(x);
      sampleY.push(y);
    }

    // Point 1 fixes the stride; every later point must then follow from it.
    let stride = 0;
    for (let n = 1; n < sampleX.length; n += 1) {
      if (sampleX[n] === long.points[2] && sampleY[n] === long.points[3]) {
        stride = n;
        break;
      }
    }
    expect(stride).toBe(8);

    // Every point except the appended impact is the sample at step i * stride.
    for (let i = 0; i < long.length - 1; i += 1) {
      expect(long.points[i * 2]).toBe(sampleX[i * stride]);
      expect(long.points[i * 2 + 1]).toBe(sampleY[i * stride]);
    }
    // The path covers the whole flight, not just its first eighth: the last
    // strided point is within one stride of the final step.
    expect((long.length - 2) * stride).toBeGreaterThanOrEqual(long.steps - stride);
  });

  /**
   * `maxPathPoints` must be EVEN, and the emit site says so out loud.
   *
   * `length` grows exactly one point per emit, so it reaches the budget exactly,
   * at step `length * stride`. The halving there doubles the stride, and that
   * same step has to remain a multiple of the doubled stride or the point
   * emitted immediately after it lands off-rhythm — which would break the
   * "point `i` is the sample at step `i * stride`" contract the test above
   * proves. `length * stride` divides by `2 * stride` iff `length` is even, and
   * `length` at that moment IS `maxPathPoints`.
   *
   * The parity argument is the whole proof, so assert the parity and the
   * consequence rather than quoting a replay count. An earlier version of this
   * comment cited a measurement ("every odd budget produces between 8 and 16
   * off-rhythm steps") that was taken against an emission rule since deleted,
   * and it survived here long after it stopped being true — which is precisely
   * the failure mode the surrounding tests exist to prevent.
   */
  it('uses an even path budget, which is what keeps a halving on-rhythm', () => {
    expect(PHYSICS.maxPathPoints % 2).toBe(0);

    // The property the parity buys: at the moment a halving fires, the step the
    // last kept point sits on must still be a multiple of the doubled stride.
    // With an even budget that holds for every stride the decimator can reach.
    for (let stride = 1; stride <= 1024; stride *= 2) {
      expect((PHYSICS.maxPathPoints * stride) % (2 * stride)).toBe(0);
    }
  });

  it('keeps a long non-vertical arc ordered and evenly spaced', () => {
    // Wide empty ground so a shallow low-gravity arc runs its full 1693 steps
    // without leaving the world. With no wind vx is constant, so a path that
    // preserved order and rhythm must advance x by the same amount at every
    // point. Reordering, duplicating or resampling would all show up here — and
    // unlike the vertical shot above, "monotone in x" actually means something.
    const arc = simulateFlight(
      { x: 100, y: 690, angleDeg: 70, power: 60 },
      { terrain: flat(700, 3200, 720), wind: 0, gravityScale: 0.08 },
    );
    expect(arc.impact.kind).toBe('terrain');
    expect(arc.steps).toBeGreaterThan(1000);
    expect(arc.length).toBeLessThan(600);

    const xs = pathXs(arc);
    let smallest = Infinity;
    let largest = -Infinity;
    for (let i = 1; i < xs.length; i += 1) {
      const step = (xs[i] as number) - (xs[i - 1] as number);
      expect(step).toBeGreaterThan(0);
      // The final gap is the appended impact point, which lands wherever the
      // shell hit rather than on a stride boundary.
      if (i < xs.length - 1) {
        smallest = Math.min(smallest, step);
        largest = Math.max(largest, step);
      }
    }
    expect(largest - smallest).toBeLessThan(1e-9);
    expect(smallest).toBeCloseTo(7.114, 3); // 4 steps of 106.7 px/s at 1/60 s
  });

  it('bounds the path for every shot the game can produce', () => {
    const generated = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(41));
    let longest = 0;
    let heaviest = 0;
    let worstSteps = 0;
    for (const terrain of [generated, field()]) {
      for (let angle = 0; angle <= 180; angle += 6) {
        for (const power of [0, 33, 100]) {
          for (const wind of [-10, 0, 10]) {
            // Low gravity is where the budget earns its keep: a full-power lob
            // at 0.1 g is thousands of steps.
            for (const gravityScale of [1, 0.1]) {
              const result = simulateFlight(
                { x: 320, y: 60, angleDeg: angle, power },
                { terrain, wind, gravityScale },
              );
              expect(result.length).toBeGreaterThanOrEqual(2);
              longest = Math.max(longest, result.length);
              heaviest = Math.max(heaviest, wireBytes(result));
              worstSteps = Math.max(worstSteps, result.steps);
            }
          }
        }
      }
    }
    // Absolute, for the same reason as above.
    expect(longest).toBeLessThan(600);
    expect(heaviest).toBeLessThan(25000);

    /*
     * The saving, asserted rather than quoted.
     *
     * A comment claiming "without decimation this would be N points" rots the
     * moment terrain generation changes the worst shot in the grid — which is
     * exactly what happened to the number that used to sit here. So derive it:
     * an undecimated path carries one point per step plus the start, and
     * `steps` is recorded on every trajectory, so the counterfactual is
     * measurable in the same run rather than remembered from an old one.
     */
    expect(longest).toBeLessThanOrEqual(PHYSICS.maxPathPoints + 1);
    expect(worstSteps + 1).toBeGreaterThan(longest * 4);
  });
});

describe('termination', () => {
  it('terminates for every angle and power', () => {
    const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(23));
    for (let angle = 0; angle <= 180; angle += 3) {
      for (const power of [0, 1, 25, 50, 99, 100]) {
        const result = simulateFlight(
          { x: 320, y: 60, angleDeg: angle, power },
          { terrain, wind: -7 },
        );
        expect(result.steps).toBeLessThanOrEqual(PHYSICS.maxSteps);
        expect(Number.isFinite(result.impact.x)).toBe(true);
        expect(Number.isFinite(result.impact.y)).toBe(true);
      }
    }
  });

  it('terminates at every angle, power and wind, with finite coordinates', () => {
    const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(88));
    for (let angle = 0; angle <= 180; angle += 1) {
      for (const power of [0, 7, 50, 100]) {
        for (const wind of [-10, 0, 10]) {
          const result = simulateFlight(
            { x: 320, y: 200, angleDeg: angle, power },
            { terrain, wind },
          );
          expect(result.steps).toBeLessThanOrEqual(PHYSICS.maxSteps);
          expect(Number.isFinite(result.impact.x)).toBe(true);
          expect(Number.isFinite(result.impact.y)).toBe(true);
          for (let i = 0; i < result.length * 2; i += 1) {
            expect(Number.isFinite(result.points[i] as number)).toBe(true);
          }
        }
      }
    }
  });

  it('handles the degenerate shots', () => {
    const terrain = flat(300);

    // Power 0: the shell drops out of the barrel onto the ground.
    const dropped = simulateFlight(
      { x: 100, y: 200, angleDeg: 45, power: 0 },
      { terrain, wind: 0 },
    );
    expect(dropped.impact.kind).toBe('terrain');
    expect(dropped.impact.x).toBeCloseTo(100, 0);

    // Straight up, full power: comes back down where it started.
    const vertical = simulateFlight(
      { x: 320, y: 290, angleDeg: 90, power: 100 },
      { terrain, wind: 0 },
    );
    expect(vertical.impact.kind).toBe('terrain');
    expect(vertical.impact.x).toBeCloseTo(320, 3);

    // Straight into a wall at point-blank range.
    const wall = emptyTerrain(WIDTH, HEIGHT);
    wall.surface.fill(HEIGHT);
    wall.surface[101] = 0;
    const pointBlank = simulateFlight(
      { x: 100, y: 200, angleDeg: 0, power: 100 },
      { terrain: wall, wind: 0 },
    );
    expect(pointBlank.impact.kind).toBe('terrain');
    expect(pointBlank.steps).toBeLessThan(5);

    // No gravity, no wind, no speed: nothing can ever happen, so it expires
    // rather than looping forever.
    const inert = simulateFlight(
      { x: 320, y: 100, angleDeg: 90, power: 0 },
      { terrain, wind: 0, gravityScale: 0, velocity: { vx: 0, vy: 0 } },
    );
    expect(inert.impact.kind).toBe('expired');
    expect(inert.steps).toBe(PHYSICS.maxSteps);
    expect(inert.length).toBeLessThan(600);
  });

  it('reports where an expired shell actually got to', () => {
    const terrain = flat(300);
    const escaped = simulateFlight(
      { x: 320, y: 290, angleDeg: 90, power: 100 },
      { terrain, wind: 0, gravityScale: 0 },
    );
    expect(escaped.impact.kind).toBe('expired');
    // Straight up forever: it must report a point far above the muzzle, not the
    // muzzle itself.
    expect(escaped.impact.y).toBeLessThan(-1000);
  });

  it('fails closed on non-finite input instead of grinding out NaN', () => {
    const terrain = flat(300);
    for (const spawn of [
      { x: 100, y: 200, angleDeg: Number.NaN, power: 50 },
      { x: 100, y: 200, angleDeg: 45, power: Number.NaN },
      { x: Number.NaN, y: 200, angleDeg: 45, power: 50 },
      { x: 100, y: Infinity, angleDeg: 45, power: 50 },
    ]) {
      const result = simulateFlight(spawn, { terrain, wind: 0 });
      expect(result.impact.kind).toBe('expired');
      expect(Number.isFinite(result.impact.x)).toBe(true);
      expect(Number.isFinite(result.impact.y)).toBe(true);
      expect(result.steps).toBe(0);
    }
    const badWind = simulateFlight(
      { x: 100, y: 200, angleDeg: 45, power: 50 },
      { terrain, wind: Number.NaN },
    );
    expect(badWind.impact.kind).toBe('expired');
    expect(Number.isFinite(badWind.impact.x)).toBe(true);
  });
});

describe('hitting tanks', () => {
  const SHOOTER: HitCircle = { x: 320, y: 295.5, radius: 9, ignore: true };
  const SHOOTER_MUZZLE = { x: 320, y: 289 };

  /** Fire from the shooter's own muzzle with the shooter as the only target. */
  function selfShot(terrain: ReturnType<typeof flat>, angleDeg: number, power: number) {
    return simulateFlight(
      { ...SHOOTER_MUZZLE, angleDeg, power },
      { terrain, wind: 0, targets: [{ ...SHOOTER }] },
    );
  }

  const isSelfHit = (result: Trajectory): boolean =>
    result.impact.kind === 'tank' && result.impact.tankIndex === 0;

  it('detects a direct hit on a tank', () => {
    const terrain = flat(300);
    const result = simulateFlight(
      { x: 100, y: 290, angleDeg: 45, power: 70 },
      {
        terrain,
        wind: 0,
        targets: [
          { x: 100, y: 290, radius: 9, ignore: true },
          { x: 400, y: 299, radius: 200 },
        ],
      },
    );
    expect(result.impact.kind).toBe('tank');
    expect(result.impact.tankIndex).toBe(1);
  });

  it('does not detonate on the tank that fired it', () => {
    const terrain = flat(300);
    const result = simulateFlight(
      { x: 100, y: 289, angleDeg: 90, power: 5 },
      { terrain, wind: 0, targets: [{ x: 100, y: 295, radius: 9, ignore: true }] },
    );
    // Straight up at low power comes right back down onto the shooter's column,
    // but the grace period means the FIRST few steps cannot register a hit.
    expect(result.length).toBeGreaterThan(3);
    expect(result.impact.kind).toBe('terrain');
  });

  /**
   * The regression this exists for: with no arming margin the shell leaves its
   * own hit circle through the side, falls a pixel, crosses back over the rim
   * and detonates on the shooter. A shot that goes nowhere must never blow up
   * its owner in mid-air — it should fall and crater the ground at his feet,
   * which hurts quite enough.
   *
   * Power 11 is the top of the range on purpose: 12 is the shortest lob that
   * genuinely clears the hull and can legitimately come back down on it (pinned
   * exactly in the next test). Drop `armFactor` to 1.3 and power 11 starts
   * self-detonating, which fails here.
   */
  it('never self-detonates on a flat or low-power shot, at any angle', () => {
    const terrain = flat(300);
    const offenders: string[] = [];
    for (let angle = 0; angle <= 180; angle += 1) {
      for (let power = 0; power <= 11; power += 1) {
        if (isSelfHit(selfShot(terrain, angle, power))) {
          offenders.push(`angle ${angle}, power ${power}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The whole 181 x 101 grid, and the numbers that pin `armFactor` from both
   * sides. There is no knee in the data to appeal to — self-hits fall off
   * smoothly as the margin grows — so this states exactly where the boundary
   * sits and fails if it moves either way.
   *
   * The exact self-hit count is the assertion that does the pinning, and it is
   * asserted exactly for that reason: it is the only quantity here that
   * separates neighbouring values of `armFactor`. Measured over this grid it is
   * 346 for armFactor in [1.4998, 1.5002] and different everywhere else —
   * 348 at 1.4997, 369 from 1.37 to 1.497, 344 at 1.5003, 338 at 1.503. The
   * shortest self-hit flight, 27 steps, is 26 below 1.4995 and 28 above 1.5002,
   * so it brackets the same band independently.
   *
   * The coarser landmarks are the ones a reader can feel. At `armFactor` 1 (no
   * margin at all, the pre-fix behaviour) this grid gives 595 self-hits, a band
   * of angles 49..131, a lowest self-detonating power of 8 and a shortest
   * self-hit of 12 steps: every assertion below fails. Raise the margin instead
   * and the lowest power climbs — 13 at 1.503, 16 at 2, 21 at 3 — so the
   * `toBe(12)` catches a margin grown large enough to delete legitimate lobs.
   */
  it('only ever drops a shell on its owner after a real lob', () => {
    const terrain = flat(300);
    let lowestPower = Infinity;
    let lowestAngle = Infinity;
    let highestAngle = -Infinity;
    let shortestFlight = Infinity;
    let selfHits = 0;

    for (let angle = 0; angle <= 180; angle += 1) {
      for (let power = 0; power <= 100; power += 1) {
        const result = selfShot(terrain, angle, power);
        if (!isSelfHit(result)) continue;
        selfHits += 1;
        lowestPower = Math.min(lowestPower, power);
        lowestAngle = Math.min(lowestAngle, angle);
        highestAngle = Math.max(highestAngle, angle);
        shortestFlight = Math.min(shortestFlight, result.steps);
      }
    }

    // Landing on your own head is Scorched Earth tradition; it must still
    // happen — and exactly this often. This is the line that pins `armFactor`
    // from below; a bound like `> 100` would pass for anything from 1.37 up.
    expect(selfHits).toBe(346);
    // Aim more than 15 degrees off vertical and no power setting can bring the
    // shell back onto you on flat ground.
    expect(lowestAngle).toBe(75);
    expect(highestAngle).toBe(105);
    // The shortest lob that can do it: power 12 rises ~7.5 px above the muzzle,
    // clear of the hull, then falls back.
    expect(lowestPower).toBe(12);
    // And every self-hit is a flight, not a graze: 27 steps, just under half a
    // second. Exact for the same reason as the count — 26 below the band, 28
    // above it.
    expect(shortestFlight).toBe(27);
  });

  it('holds on real terrain, with wind, wherever the tank is standing', () => {
    for (const seed of [1, 7, 23, 99]) {
      const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(seed));
      for (const tankX of [80, 200, 320, 470, 600]) {
        const groundY = terrain.surface[tankX] as number;
        for (let angle = 0; angle <= 60; angle += 4) {
          for (const power of [0, 3, 6, 9, 12, 20, 45, 100]) {
            for (const wind of [-10, 10]) {
              const result = simulateFlight(
                { x: tankX, y: groundY - 11, angleDeg: angle, power },
                {
                  terrain,
                  wind,
                  targets: [{ x: tankX, y: groundY - 4.5, radius: 9, ignore: true }],
                },
              );
              expect(result.impact.kind === 'tank' && result.impact.tankIndex === 0).toBe(false);
            }
          }
        }
      }
    }
  });

  it('still lets a lob land on your own head', () => {
    const lob = selfShot(flat(300), 90, 40);
    expect(lob.impact.kind).toBe('tank');
    expect(lob.impact.tankIndex).toBe(0);
    // It genuinely left first — the arc rose 88 px, five tank-widths, above the
    // hull before coming back. Stated absolutely: comparing the rise against
    // the arming margin would be circular, since the margin is what let it arm.
    let highest = SHOOTER.y;
    for (let i = 0; i < lob.length; i += 1) {
      highest = Math.min(highest, lob.points[i * 2 + 1] as number);
    }
    expect(SHOOTER.y - highest).toBeGreaterThan(40);
    expect(lob.steps).toBeGreaterThan(60);
  });

  it('arms only after clearing the circle by a real margin', () => {
    // Angle 49 at power 8 is the shape of the old bug: the shell reaches 12.47 px
    // from the tank's centre — outside the 9 px hit circle, so a bare
    // "left the circle" rule arms it — then falls back across the rim and kills
    // its owner. The 1.5x margin (13.5 px here) is what makes those 3.47 px
    // "still leaving" rather than "left".
    const result = selfShot(flat(300), 49, 8);

    let furthest = 0;
    for (let i = 0; i < result.length; i += 1) {
      const dx = (result.points[i * 2] as number) - SHOOTER.x;
      const dy = (result.points[i * 2 + 1] as number) - SHOOTER.y;
      furthest = Math.max(furthest, Math.sqrt(dx * dx + dy * dy));
    }
    expect(furthest).toBeCloseTo(12.47, 2);
    expect(result.impact.kind).toBe('terrain');
  });
});

describe('determinism', () => {
  it('is bit-identical across repeated runs', () => {
    const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(31));
    const shot = { x: 120, y: 80, angleDeg: 52, power: 77 };
    const a = simulateFlight(shot, { terrain, wind: 4.2 });
    const b = simulateFlight(shot, { terrain, wind: 4.2 });
    expect(Array.from(a.points.subarray(0, a.length * 2))).toEqual(
      Array.from(b.points.subarray(0, b.length * 2)),
    );
  });

  it('is bit-identical across the whole input space, including long flights', () => {
    const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(64));
    for (let angle = 0; angle <= 180; angle += 17) {
      for (const power of [0, 13, 62, 100]) {
        for (const wind of [-9.7, 0, 9.7]) {
          const spawn = { x: 200, y: 90, angleDeg: angle, power };
          const options = { terrain, wind, gravityScale: 0.3 };
          const a = simulateFlight(spawn, options);
          const b = simulateFlight(spawn, options);
          expect(a.length).toBe(b.length);
          expect(a.steps).toBe(b.steps);
          expect(a.impact).toEqual(b.impact);
          expect(Array.from(a.points.subarray(0, a.length * 2))).toEqual(
            Array.from(b.points.subarray(0, b.length * 2)),
          );
        }
      }
    }
  });

  it('does not let the arming state of one shot leak into the next', () => {
    // `armed` is derived per call. If it were ever hoisted, the second identical
    // shot would arm instantly and detonate on its own tank.
    const terrain = flat(300);
    const targets = [{ x: 100, y: 295, radius: 9, ignore: true }];
    const first = simulateFlight(
      { x: 100, y: 289, angleDeg: 90, power: 5 },
      { terrain, wind: 0, targets },
    );
    const second = simulateFlight(
      { x: 100, y: 289, angleDeg: 90, power: 5 },
      { terrain, wind: 0, targets },
    );
    expect(second.impact).toEqual(first.impact);
    expect(second.impact.kind).toBe('terrain');
  });
});
