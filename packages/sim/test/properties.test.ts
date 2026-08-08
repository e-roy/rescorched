/**
 * Property-based invariants (TECH_STACK.md: "Property-based | fast-check").
 *
 * These are the four claims the whole architecture rests on:
 *   1. same seed → identical outcome
 *   2. shots never tunnel through terrain
 *   3. health never goes negative
 *   4. the sim never throws for any valid input
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createGame, fire, hashGameState, IllegalMoveError, type GameState } from '../src/game.ts';
import { generateTerrain, hashTerrain, isSolid, emptyTerrain } from '../src/terrain.ts';
import { simulateFlight, trajectoryPoint } from '../src/physics.ts';
import { makeRng } from '../src/rng.ts';
import { BABY_MISSILE, WEAPONS } from '../src/weapons.ts';

const WIDTH = 640;
const HEIGHT = 400;

const seedArb = fc.integer({ min: 0, max: 2 ** 31 - 1 });
const angleArb = fc.double({ min: 0, max: 180, noNaN: true, noDefaultInfinity: true });
const powerArb = fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });
const windArb = fc.double({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true });

const PLAYERS = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
  { id: 'p3', name: 'Cleo' },
];

describe('property: same seed → identical outcome', () => {
  it('terrain generation is reproducible', () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        const a = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(seed));
        const b = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(seed));
        expect(hashTerrain(a)).toBe(hashTerrain(b));
      }),
      { numRuns: 60 },
    );
  });

  it('a whole match replays to the same state hash', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.array(fc.record({ angle: angleArb, power: powerArb }), { minLength: 1, maxLength: 12 }),
        (seed, shots) => {
          const play = (): GameState => {
            let state = createGame({ seed, totalRounds: 3 }, PLAYERS);
            for (const shot of shots) {
              if (state.phase !== 'aiming') break;
              const shooter = state.tanks[state.activeTank];
              if (shooter === undefined) break;
              state = fire(state, shooter.id, {
                turnNumber: state.turnNumber,
                angleDeg: shot.angle,
                power: shot.power,
                weapon: BABY_MISSILE,
              }).state;
            }
            return state;
          };

          expect(hashGameState(play())).toBe(hashGameState(play()));
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('property: shots never tunnel through terrain', () => {
  it('the point before an impact is always sky', () => {
    fc.assert(
      fc.property(seedArb, angleArb, powerArb, windArb, (seed, angle, power, wind) => {
        const terrain = generateTerrain({ width: WIDTH, height: HEIGHT }, makeRng(seed));
        const result = simulateFlight(
          { x: WIDTH / 2, y: 30, angleDeg: angle, power },
          { terrain, wind },
        );
        if (result.impact.kind !== 'terrain') return;

        const previous = trajectoryPoint(result, result.length - 2);
        if (previous === undefined) return;
        expect(isSolid(terrain, previous.x, previous.y)).toBe(false);
      }),
      { numRuns: 250 },
    );
  });

  it('never lands beyond a one-pixel wall it was fired at', () => {
    fc.assert(
      fc.property(fc.integer({ min: 60, max: WIDTH - 60 }), powerArb, (wallX, power) => {
        // An otherwise empty world with a single solid column. The floor of
        // the world is solid too, so a weak shot legitimately falls short —
        // what must never happen is a shot appearing on the far SIDE.
        const terrain = emptyTerrain(WIDTH, HEIGHT);
        terrain.surface.fill(HEIGHT);
        terrain.surface[wallX] = 0;

        const result = simulateFlight(
          { x: 5, y: HEIGHT / 2, angleDeg: 0, power },
          { terrain, wind: 0 },
        );

        // The tunnelling invariant: nothing gets past the wall. `+2` allows
        // for the sub-pixel sample that first registers the hit.
        expect(result.impact.x).toBeLessThanOrEqual(wallX + 2);
      }),
      { numRuns: 150 },
    );
  });

  it('stops exactly at the wall whenever it has the range to reach it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 60, max: 260 }), (wallX) => {
        const terrain = emptyTerrain(WIDTH, HEIGHT);
        terrain.surface.fill(HEIGHT);
        terrain.surface[wallX] = 0;

        // Full power, flat, fired from just left of the wall: the shell cannot
        // fall out of the world before it arrives, so it MUST hit the column.
        const result = simulateFlight(
          { x: 5, y: 20, angleDeg: 0, power: 100 },
          { terrain, wind: 0 },
        );

        expect(result.impact.kind).toBe('terrain');
        expect(result.impact.x).toBeGreaterThanOrEqual(wallX - 1);
        expect(result.impact.x).toBeLessThanOrEqual(wallX + 2);
      }),
      { numRuns: 80 },
    );
  });
});

describe('property: health never goes negative', () => {
  it('holds across long random matches with every weapon', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.array(
          fc.record({
            angle: angleArb,
            power: powerArb,
            weapon: fc.constantFrom(...WEAPONS.map((weapon) => weapon.id)),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (seed, shots) => {
          let state = createGame({ seed, totalRounds: 3 }, PLAYERS);
          // Give everyone one of everything so all detonation kinds get exercised.
          state = {
            ...state,
            tanks: state.tanks.map((tank) => ({
              ...tank,
              inventory: Object.fromEntries(WEAPONS.map((weapon) => [weapon.id, 99])),
            })),
          };

          for (const shot of shots) {
            if (state.phase !== 'aiming') break;
            const shooter = state.tanks[state.activeTank];
            if (shooter === undefined) break;
            state = fire(state, shooter.id, {
              turnNumber: state.turnNumber,
              angleDeg: shot.angle,
              power: shot.power,
              weapon: shot.weapon,
            }).state;

            for (const tank of state.tanks) {
              expect(tank.health).toBeGreaterThanOrEqual(0);
              expect(tank.health).toBeLessThanOrEqual(100);
              expect(Number.isFinite(tank.health)).toBe(true);
              expect(tank.money).toBeGreaterThanOrEqual(0);
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('property: the sim never throws on valid input', () => {
  it('accepts every in-range angle/power/weapon combination', () => {
    fc.assert(
      fc.property(
        seedArb,
        angleArb,
        powerArb,
        fc.constantFrom(...WEAPONS.map((weapon) => weapon.id)),
        (seed, angle, power, weapon) => {
          let state = createGame({ seed, totalRounds: 3 }, PLAYERS);
          state = {
            ...state,
            tanks: state.tanks.map((tank) => ({
              ...tank,
              inventory: Object.fromEntries(WEAPONS.map((w) => [w.id, 5])),
            })),
          };
          const shooter = state.tanks[state.activeTank];
          expect(shooter).toBeDefined();
          expect(() =>
            fire(state, shooter!.id, {
              turnNumber: state.turnNumber,
              angleDeg: angle,
              power,
              weapon,
            }),
          ).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('rejects out-of-range input with IllegalMoveError, never a crash', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.double({ noNaN: false }),
        fc.double({ noNaN: false }),
        (seed, angle, power) => {
          const state = createGame({ seed, totalRounds: 3 }, PLAYERS);
          const shooter = state.tanks[state.activeTank];
          const inRange =
            Number.isFinite(angle) &&
            Number.isFinite(power) &&
            angle >= 0 &&
            angle <= 180 &&
            power >= 0 &&
            power <= 100;

          try {
            fire(state, shooter!.id, {
              turnNumber: state.turnNumber,
              angleDeg: angle,
              power,
              weapon: BABY_MISSILE,
            });
            expect(inRange).toBe(true);
          } catch (error) {
            // The only acceptable failure mode is a typed, explained rejection.
            expect(error).toBeInstanceOf(IllegalMoveError);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('survives hostile-looking player ids and turn numbers', () => {
    fc.assert(
      fc.property(seedArb, fc.string(), fc.integer(), (seed, playerId, turnNumber) => {
        const state = createGame({ seed, totalRounds: 3 }, PLAYERS);
        try {
          fire(state, playerId, {
            turnNumber,
            angleDeg: 45,
            power: 50,
            weapon: BABY_MISSILE,
          });
        } catch (error) {
          expect(error).toBeInstanceOf(IllegalMoveError);
        }
      }),
      { numRuns: 150 },
    );
  });
});

describe('property: terrain stays well-formed', () => {
  it('every column stays within the world after any bombardment', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.array(
          fc.record({
            angle: angleArb,
            power: powerArb,
            weapon: fc.constantFrom(...WEAPONS.map((weapon) => weapon.id)),
          }),
          { minLength: 1, maxLength: 15 },
        ),
        (seed, shots) => {
          let state = createGame({ seed, totalRounds: 3 }, PLAYERS);
          state = {
            ...state,
            tanks: state.tanks.map((tank) => ({
              ...tank,
              inventory: Object.fromEntries(WEAPONS.map((w) => [w.id, 99])),
            })),
          };

          for (const shot of shots) {
            if (state.phase !== 'aiming') break;
            const shooter = state.tanks[state.activeTank];
            if (shooter === undefined) break;
            state = fire(state, shooter.id, {
              turnNumber: state.turnNumber,
              angleDeg: shot.angle,
              power: shot.power,
              weapon: shot.weapon,
            }).state;
          }

          const { surface, height, width } = state.terrain;
          expect(surface.length).toBe(width);
          for (let x = 0; x < width; x += 1) {
            const y = surface[x] as number;
            expect(Number.isInteger(y)).toBe(true);
            expect(y).toBeGreaterThanOrEqual(0);
            expect(y).toBeLessThanOrEqual(height);
          }
          // Tanks always end up sitting on the ground, never floating or buried.
          for (const tank of state.tanks) {
            if (!tank.alive) continue;
            expect(tank.y).toBe(surface[tank.x]);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
