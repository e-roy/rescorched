import { describe, expect, it } from 'vitest';
import { emptyTerrain, generateTerrain, isSolid } from '../src/terrain.ts';
import { launchVelocity, PHYSICS, simulateFlight, trajectoryPoint } from '../src/physics.ts';
import { makeRng } from '../src/rng.ts';

const WIDTH = 640;
const HEIGHT = 400;

function flat(surfaceY: number) {
  const terrain = emptyTerrain(WIDTH, HEIGHT);
  terrain.surface.fill(surfaceY);
  return terrain;
}

describe('launch velocity', () => {
  it('fires right at 0 degrees and left at 180', () => {
    expect(launchVelocity(0, 100).vx).toBeGreaterThan(0);
    expect(launchVelocity(180, 100).vx).toBeLessThan(0);
  });

  it('fires straight up at 90 degrees', () => {
    const velocity = launchVelocity(90, 100);
    expect(Math.abs(velocity.vx)).toBeLessThan(1e-9);
    expect(velocity.vy).toBeLessThan(0); // screen Y grows downward
  });

  it('scales linearly with power', () => {
    const half = launchVelocity(45, 50);
    const full = launchVelocity(45, 100);
    expect(full.vx).toBeCloseTo(half.vx * 2, 9);
    expect(full.vy).toBeCloseTo(half.vy * 2, 9);
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

  it('does not tunnel through a thin ridge at extreme power', () => {
    const terrain = emptyTerrain(WIDTH, HEIGHT);
    terrain.surface.fill(HEIGHT); // all sky …
    // … except one single-column wall in the middle.
    terrain.surface[320] = 0;

    const result = simulateFlight({ x: 10, y: 200, angleDeg: 0, power: 100 }, { terrain, wind: 0 });

    expect(result.impact.kind).toBe('terrain');
    expect(result.impact.x).toBeGreaterThanOrEqual(319);
    expect(result.impact.x).toBeLessThanOrEqual(322);
  });

  it('blows the shell downwind', () => {
    const terrain = flat(300);
    const still = simulateFlight({ x: 100, y: 290, angleDeg: 60, power: 80 }, { terrain, wind: 0 });
    const windy = simulateFlight({ x: 100, y: 290, angleDeg: 60, power: 80 }, { terrain, wind: 8 });
    expect(windy.impact.x).toBeGreaterThan(still.impact.x);
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
  });

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

  it('is bit-identical across repeated runs', () => {
    const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(31));
    const shot = { x: 120, y: 80, angleDeg: 52, power: 77 };
    const a = simulateFlight(shot, { terrain, wind: 4.2 });
    const b = simulateFlight(shot, { terrain, wind: 4.2 });
    expect(Array.from(a.points.subarray(0, a.length * 2))).toEqual(
      Array.from(b.points.subarray(0, b.length * 2)),
    );
  });
});
