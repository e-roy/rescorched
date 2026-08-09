/**
 * What happens to a tank when the ground moves, and who gets paid for it.
 *
 * Falling, burial and multi-kill credit are the three places where the turn
 * machine writes health rather than the weapon doing it, so they are the three
 * places where a bounty can go to the wrong player or a death can go
 * unattributed.
 */

import { describe, expect, it } from 'vitest';
import {
  BURIAL,
  burialDamage,
  createGame,
  DEFAULT_WORLD,
  FALL,
  fallDamage,
  fire,
  settleTanks,
  type GameEvent,
  type GameState,
  type PlayerSeed,
  type Tank,
} from '../src/game.ts';
import { emptyTerrain, surfaceAt } from '../src/terrain.ts';
import { simulateFlight } from '../src/physics.ts';
import { requireWeapon } from '../src/weapons.ts';

const WIDTH = 1280;
const HEIGHT = 720;
const GROUND = 500;

const players = (count: number): PlayerSeed[] =>
  Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

/** A match on dead-flat ground with no wind — every coordinate here is chosen. */
function flatGame(count: number, seed = 'flat'): GameState {
  const base = createGame({ seed, totalRounds: 3, width: WIDTH, height: HEIGHT }, players(count));
  const terrain = emptyTerrain(WIDTH, HEIGHT);
  terrain.surface.fill(GROUND);
  return {
    ...base,
    terrain,
    wind: 0,
    tanks: base.tanks.map((tank, index) => ({ ...tank, x: 100 + index * 200, y: GROUND })),
  };
}

/** Move one tank without touching anything else. */
function place(state: GameState, index: number, patch: Partial<Tank>): GameState {
  return {
    ...state,
    tanks: state.tanks.map((tank, i) => (i === index ? { ...tank, ...patch } : tank)),
  };
}

const damageOf = (events: readonly GameEvent[], tankIndex: number): number =>
  events
    .filter(
      (event): event is Extract<GameEvent, { type: 'damage' }> =>
        event.type === 'damage' && event.tankIndex === tankIndex,
    )
    .reduce((sum, event) => sum + event.amount, 0);

describe('the fall damage curve', () => {
  it('is free up to the safe drop and then climbs', () => {
    expect(fallDamage(0)).toBe(0);
    expect(fallDamage(FALL.safeDrop)).toBe(0);
    expect(fallDamage(FALL.safeDrop + 4)).toBe(Math.floor(4 * FALL.damagePerPixel));
    expect(fallDamage(FALL.safeDrop + 100)).toBe(Math.floor(100 * FALL.damagePerPixel));
  });

  it('is monotonic and capped', () => {
    let previous = 0;
    for (let drop = 0; drop <= 2000; drop += 7) {
      const damage = fallDamage(drop);
      expect(damage).toBeGreaterThanOrEqual(previous);
      expect(damage).toBeLessThanOrEqual(FALL.maxDamage);
      previous = damage;
    }
    expect(fallDamage(4000)).toBe(FALL.maxDamage);
  });

  it('cannot destroy a healthy tank on its own', () => {
    // A tank at full health that has the whole map pulled out from under it
    // survives the landing. Dying to terrain you cannot see move is the kind of
    // thing a player reads as a bug.
    expect(FALL.maxDamage).toBeLessThan(DEFAULT_WORLD.maxHealth);
  });
});

describe('the burial curve', () => {
  it('treats dirt up to the top of the hull as cover', () => {
    expect(burialDamage(0)).toBe(0);
    expect(burialDamage(BURIAL.freeDepth)).toBe(0);
  });

  it('climbs past that and is capped short of lethal', () => {
    expect(burialDamage(BURIAL.freeDepth + 10)).toBe(Math.floor(10 * BURIAL.damagePerPixel));
    expect(burialDamage(10_000)).toBe(BURIAL.maxDamage);
    expect(BURIAL.maxDamage).toBeLessThan(DEFAULT_WORLD.maxHealth);
  });
});

describe('settling a tank the ground moved under', () => {
  it('leaves a tank that is already on the ground completely alone', () => {
    const state = flatGame(2);
    const events = settleTanks(state, 0);
    expect(events).toEqual([]);
    expect((state.tanks[1] as Tank).health).toBe(DEFAULT_WORLD.maxHealth);
  });

  it('drops a floating tank onto the ground and charges it for the landing', () => {
    const drop = 140;
    const state = place(flatGame(2), 1, { y: GROUND - drop });
    const events = settleTanks(state, 0);

    const victim = state.tanks[1] as Tank;
    expect(victim.y).toBe(GROUND);
    expect(victim.health).toBe(DEFAULT_WORLD.maxHealth - fallDamage(drop));
    expect(damageOf(events, 1)).toBe(fallDamage(drop));
  });

  it('credits the fall to whoever blew the hill away', () => {
    // Before this, dropping somebody down a cliff paid nothing at all: the
    // damage happened with no shooter attached and the bounty went nowhere.
    const drop = 300;
    const state = place(flatGame(2), 1, { y: GROUND - drop });
    const shooter = state.tanks[0] as Tank;
    const moneyBefore = shooter.money;

    settleTanks(state, 0);

    const dealt = fallDamage(drop);
    expect(shooter.score).toBe(dealt);
    expect(shooter.money).toBe(moneyBefore + dealt * DEFAULT_WORLD.damageBounty);
  });

  it('pays a kill bounty when the fall finishes the job', () => {
    const state = place(place(flatGame(2), 1, { y: GROUND - 400, health: 10 }), 0, {});
    const shooter = state.tanks[0] as Tank;
    const moneyBefore = shooter.money;

    const events = settleTanks(state, 0);

    expect((state.tanks[1] as Tank).alive).toBe(false);
    expect(events).toContainEqual({ type: 'death', tankIndex: 1, byTankIndex: 0 });
    expect(shooter.money).toBe(
      moneyBefore + 10 * DEFAULT_WORLD.damageBounty + DEFAULT_WORLD.killBounty,
    );
  });

  it('pays nobody when a tank drops itself', () => {
    const state = place(flatGame(2), 0, { y: GROUND - 300 });
    const faller = state.tanks[0] as Tank;
    const moneyBefore = faller.money;

    settleTanks(state, 0);

    expect(faller.health).toBeLessThan(DEFAULT_WORLD.maxHealth);
    expect(faller.money).toBe(moneyBefore);
    expect(faller.score).toBe(0);
  });

  it('digs a buried tank out onto the new surface and charges for the dig', () => {
    // Y grows downwards, so a tank below the heightmap is one that had dirt
    // dropped on top of it.
    const depth = 60;
    const state = place(flatGame(2), 1, { y: GROUND + depth });
    const events = settleTanks(state, 0);

    const victim = state.tanks[1] as Tank;
    // The invariant the whole sim holds to: a living tank is exactly on the
    // surface. A tank left under the heightmap is unrenderable and unhittable.
    expect(victim.y).toBe(surfaceAt(state.terrain, victim.x));
    expect(victim.health).toBe(DEFAULT_WORLD.maxHealth - burialDamage(depth));
    expect(damageOf(events, 1)).toBe(burialDamage(depth));
  });

  it('does not charge for dirt banked up around the tracks', () => {
    const state = place(flatGame(2), 1, { y: GROUND + BURIAL.freeDepth });
    const events = settleTanks(state, 0);
    expect((state.tanks[1] as Tank).health).toBe(DEFAULT_WORLD.maxHealth);
    expect(events).toEqual([]);
  });

  it('can bury a wounded tank to death, credited to the digger', () => {
    const state = place(flatGame(2), 1, { y: GROUND + 500, health: 5 });
    const events = settleTanks(state, 0);
    expect((state.tanks[1] as Tank).alive).toBe(false);
    expect(events).toContainEqual({ type: 'death', tankIndex: 1, byTankIndex: 0 });
  });

  it('leaves the dead where they lie', () => {
    const state = place(flatGame(2), 1, { y: GROUND - 400, alive: false, health: 0 });
    const events = settleTanks(state, 0);
    expect(events).toEqual([]);
    expect((state.tanks[1] as Tank).y).toBe(GROUND - 400);
  });
});

describe('one blast, several kills', () => {
  /**
   * Set up a shot that is guaranteed to go off between two tanks.
   *
   * The trajectory is flown first with nobody in the way, and the victims are
   * then parked either side of where the shell really lands — so the test does
   * not depend on a hand-computed range, and it cannot silently stop hitting
   * anybody if the ballistics are retuned.
   */
  function crossfire(weaponId: string): {
    state: GameState;
    input: { turnNumber: number; angleDeg: number; power: number; weapon: string };
  } {
    const angleDeg = 45;
    const power = 70;
    // Four tanks: the shooter, two victims, and a bystander far enough away to
    // keep the round from ending on the first shot.
    let state = flatGame(4, 'crossfire');
    state = place(state, 0, { x: 100, y: GROUND });
    state = place(state, 3, { x: 1270, y: GROUND });

    const muzzle = { x: 100, y: GROUND - DEFAULT_WORLD.tankRadius - 2 };
    const solo = simulateFlight(
      { ...muzzle, angleDeg, power },
      { terrain: state.terrain, wind: 0 },
    );
    expect(solo.impact.kind).toBe('terrain');
    const landing = Math.round(solo.impact.x);
    expect(landing).toBeGreaterThan(300);
    expect(landing).toBeLessThan(1100);

    state = place(state, 1, { x: landing - 4, y: GROUND, health: 8 });
    state = place(state, 2, { x: landing + 4, y: GROUND, health: 8 });
    state = { ...state, activeTank: 0 };

    return {
      state,
      input: { turnNumber: state.turnNumber, angleDeg, power, weapon: weaponId },
    };
  }

  it('credits every death in the volley to the tank that fired it', () => {
    const { state, input } = crossfire('missile');
    const armed = place(state, 0, { inventory: { missile: 5 } });
    const before = armed.tanks[0] as Tank;

    const { state: after, events } = fire(armed, before.id, input);

    const deaths = events.filter(
      (event): event is Extract<GameEvent, { type: 'death' }> => event.type === 'death',
    );
    expect(deaths.map((death) => death.tankIndex).sort()).toEqual([1, 2]);
    for (const death of deaths) expect(death.byTankIndex).toBe(0);

    expect((after.tanks[1] as Tank).alive).toBe(false);
    expect((after.tanks[2] as Tank).alive).toBe(false);
    // The bystander is still up, so the round has not ended and no survival
    // bonus has muddied the ledger.
    expect((after.tanks[3] as Tank).alive).toBe(true);
    expect(after.phase).toBe('aiming');

    const shooter = after.tanks[0] as Tank;
    // Eight health each, and overkill pays nothing — the shooter is credited
    // for the damage that landed, not the damage the weapon could have done.
    expect(shooter.score).toBe(16);
    expect(shooter.money).toBe(
      before.money + 16 * DEFAULT_WORLD.damageBounty + 2 * DEFAULT_WORLD.killBounty,
    );
  });

  it('reports one death per tank however big the blast', () => {
    // A Nuke covers both victims many times over. `alive` flips before the
    // event is pushed, so a second pass over the same tank returns at the
    // guard — one death, one bounty, ever.
    const { state, input } = crossfire('nuke');
    const armed = place(state, 0, { inventory: { nuke: 2 } });
    const { events } = fire(armed, (armed.tanks[0] as Tank).id, input);

    const deaths = events.filter((event) => event.type === 'death');
    expect(deaths).toHaveLength(
      new Set(deaths.map((d) => (d as { tankIndex: number }).tankIndex)).size,
    );
    expect(requireWeapon('nuke').radius).toBeGreaterThan(requireWeapon('missile').radius);
  });

  it('does not pay the shooter for blowing itself up', () => {
    const state = flatGame(2, 'self-harm');
    const shooter = state.tanks[0] as Tank;
    const armed = { ...place(state, 0, {}), activeTank: 0 };
    const moneyBefore = shooter.money;

    // Straight up at a crawl: the shell comes back down onto its own feet.
    const { state: after } = fire(armed, shooter.id, {
      turnNumber: armed.turnNumber,
      angleDeg: 90,
      power: 1,
      weapon: 'baby_missile',
    });

    const hurt = after.tanks[0] as Tank;
    expect(hurt.health).toBeLessThan(DEFAULT_WORLD.maxHealth);
    expect(hurt.money).toBe(moneyBefore);
    expect(hurt.score).toBe(0);
  });
});
