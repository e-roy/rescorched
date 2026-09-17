/**
 * A bigger room gets a bigger battlefield, and nothing about the game gets
 * worse for it.
 *
 * `worldWidthFor` widens the map with every tank past the second, and
 * `muzzleSpeedScale` makes the gun keep pace. Four things have to hold for that
 * to be a better game rather than merely a larger one, and each is measured here
 * rather than read off the constants:
 *
 *  - tanks really are further apart, including the closest pair;
 *  - a shot covers the same fraction of the map whatever its width, wind and all;
 *  - the map generator judges which spawns can reach each other with that gun;
 *  - the computer players aim as well, and search as cheaply, on the widest map
 *    as they do in a duel.
 *
 * What each test was seen to catch is written next to it.
 */

import { describe, expect, it } from 'vitest';

import { chooseShotDetailed, type BotPersonality } from '../src/ai.ts';
import {
  createGame,
  predictShot,
  worldWidthFor,
  type GameState,
  type PlayerSeed,
  type Tank,
} from '../src/game.ts';
import { simulateFlight } from '../src/physics.ts';
import { checkPlayability, emptyTerrain, type Terrain } from '../src/terrain.ts';
import { openedGame } from './opening.ts';

const HEIGHT = 720;
const GROUND_Y = 600;

const seats = (count: number): PlayerSeed[] =>
  Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

function plain(width: number): Terrain {
  const terrain = emptyTerrain(width, HEIGHT);
  terrain.surface.fill(GROUND_Y);
  return terrain;
}

describe('a bigger room gets a bigger battlefield', () => {
  /*
   * Measured over these 24 seeds. At the old fixed 1280 an eight-tank match left
   * a mean of 132 px between neighbours and put the closest pair 55 px apart —
   * inside one blast of most of the arsenal, so a shot at one tank was a shot at
   * two. On its own wider map the same match averages 247 and never goes below
   * 103. Setting the per-tank width to zero puts both numbers back and fails
   * both assertions.
   */
  it('spreads an eight-tank match out, closest pair included', () => {
    const gaps: number[] = [];
    for (let seed = 0; seed < 24; seed += 1) {
      const state = createGame({ seed: `gap-8-${seed}` }, seats(8));
      const xs = state.tanks.map((tank) => tank.x).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i += 1) gaps.push((xs[i] as number) - (xs[i - 1] as number));
    }
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    expect(mean).toBeGreaterThan(220);
    expect(Math.min(...gaps)).toBeGreaterThan(90);
  });
});

describe('the gun keeps pace with the map', () => {
  /**
   * How far across its own map a full-power 45-degree shot lands, as a fraction
   * of the map's width.
   */
  function reachFraction(width: number, wind: number): number {
    const x = Math.round(width * 0.05);
    const flight = simulateFlight(
      { x, y: GROUND_Y - 11, angleDeg: 45, power: 100 },
      { terrain: plain(width), wind },
    );
    expect(flight.impact.kind).toBe('terrain');
    return (flight.impact.x - x) / width;
  }

  /*
   * On the duel's map this shot lands about 81% of the way across. Unscaled, the
   * same shot on the sixteen-tank map covers 30% of it and the far side is out of
   * range for everybody; scaled linearly instead of by the square root, it flies
   * clean off the far edge. Both fail here, in every wind.
   */
  it('crosses the same fraction of every map, in any wind', () => {
    for (const wind of [-10, 0, 10]) {
      const duel = reachFraction(worldWidthFor(2), wind);
      for (const count of [4, 8, 16]) {
        const width = worldWidthFor(count);
        expect(
          Math.abs(reachFraction(width, wind) - duel),
          `${width} px map, wind ${wind}`,
        ).toBeLessThan(0.01);
      }
    }
  });
});

describe("the map generator judges a wide map with that map's gun", () => {
  /*
   * The generator rejects a map on which two spawns within reach of each other
   * are walled apart, and "within reach" has to mean the reach of THIS map's gun.
   *
   * On the sixteen-tank map: two spawns 1000 px apart, a floor-to-ceiling wall
   * standing 30 px in front of the second — too close behind for any lob to drop
   * in. The wide map's gun has the pair well within its power-80 range, so the
   * gate looks at the wall and flags it. Judged with the duel's gun (666 px at
   * power 80) the pair is out of range, the wall is never looked at, and the map
   * is waved through: seen by leaving the probe unscaled, which reports this
   * layout — and every other gap from 700 to 1300 px — as fine.
   *
   * (Not the duel's wall test drawn wider. A faster gun lobs higher, and shells
   * may fly above the world, so a wall that stops a duel can be lobbed on a wide
   * map. Wall height does not scale with width; only the pair's reach does.)
   */
  it('flags a blocked pair that only the wide gun can reach', () => {
    const width = worldWidthFor(16);
    const terrain = plain(width);
    const [a, b] = [1000, 2000];
    for (let x = b - 50; x <= b - 30; x += 1) terrain.surface[x] = 0;

    const report = checkPlayability(terrain, { spawns: [a, b] });
    expect(report.issues.some((issue) => issue.kind === 'blocked')).toBe(true);
  });
});

describe('the computer players aim as well on the widest map', () => {
  const AIMING: BotPersonality[] = ['shooter', 'cyborg', 'annihilator', 'tosser'];
  const SEEDS = 12;

  /**
   * The same duel drawn at any width: a flat plain, the bot and its target at
   * the same FRACTIONS of the way across. Reports the search's mean flights and
   * the mean miss as a fraction of the map.
   */
  function scaledDuel(personality: BotPersonality, width: number) {
    let flights = 0;
    let miss = 0;
    for (let seed = 0; seed < SEEDS; seed += 1) {
      const base = openedGame({ seed: `scaled-${seed}`, width, height: HEIGHT }, [
        { id: 'bot', name: 'Bot', bot: personality },
        { id: 'target', name: 'Target' },
      ]);
      const from = 0.15 + (seed % 4) * 0.05;
      const to = 0.6 + (seed % 3) * 0.1;
      const tanks = base.tanks.map((tank, index) => ({
        ...(tank as Tank),
        x: Math.round((index === 0 ? from : to) * width),
        y: GROUND_Y,
      }));
      const state: GameState = { ...base, terrain: plain(width), tanks, wind: 0 };

      const report = chooseShotDetailed(state, 0, { personality });
      flights += report.flights;
      const shot = predictShot(state, 0, report.decision.angleDeg, report.decision.power);
      miss += Math.abs(shot.impact.x - (tanks[1] as Tank).x) / width;
    }
    return { flights: flights / SEEDS, miss: miss / SEEDS };
  }

  /*
   * Measured, duel against the 3520 px map: flights 1.3/1.5 Shooter, 1.8/1.8
   * Cyborg and Annihilator, 1.0/1.0 Tosser; misses within half a percent of the
   * map of each other. With the bots' opening power guess left at the duel's
   * muzzle speed the search still finds the target — it is a search — but pays
   * for it: 2.8 to 2.9 flights on the wide maps, every aiming personality. That
   * is what the flight bound catches. With the gun itself unscaled, the far side
   * is out of range and the miss bound catches it instead.
   */
  it('lands as close, for no extra search', () => {
    for (const personality of AIMING) {
      const duel = scaledDuel(personality, worldWidthFor(2));
      for (const count of [8, 16]) {
        const width = worldWidthFor(count);
        const wide = scaledDuel(personality, width);
        expect(wide.flights, `${personality} flights on ${width} px`).toBeLessThanOrEqual(
          duel.flights + 0.5,
        );
        expect(wide.miss, `${personality} miss on ${width} px`).toBeLessThanOrEqual(
          duel.miss + 0.0075,
        );
      }
    }
  }, 120_000);
});
