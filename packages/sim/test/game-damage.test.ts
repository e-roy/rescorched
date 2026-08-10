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
  DEFAULT_WORLD,
  FALL,
  fallDamage,
  fire,
  predictShot,
  settleTanks,
  type GameEvent,
  type GameState,
  type PlayerSeed,
  type Tank,
} from '../src/game.ts';
import { emptyTerrain, surfaceAt } from '../src/terrain.ts';
import { simulateFlight } from '../src/physics.ts';
import { requireWeapon } from '../src/weapons.ts';
import { openedGame } from './opening.ts';

const WIDTH = 1280;
const HEIGHT = 720;
const GROUND = 500;

const players = (count: number): PlayerSeed[] =>
  Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

/** A match on dead-flat ground with no wind — every coordinate here is chosen. */
function flatGame(count: number, seed = 'flat'): GameState {
  const base = openedGame({ seed, totalRounds: 3, width: WIDTH, height: HEIGHT }, players(count));
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

/**
 * The same credit rule, exercised through `fire()` instead of by calling
 * `settleTanks` directly.
 *
 * Everything above this point calls `settleTanks(state, 0)` itself, which means
 * it tests the function and not the wiring: `fire()` could stop passing the
 * shooter along — the one line that makes falls and burials pay — and every one
 * of those tests would still be green. Only the golden hash would notice, and a
 * golden hash is a change detector, not a specification.
 *
 * The trick that makes this measurable is a weapon whose `damage` is zero. A
 * Ton of Dirt and a Riot Blast move a great deal of ground and hurt nobody
 * directly, so every point the shooter is credited with here provably arrived
 * through the settle step. Each test asserts that `damage === 0` rather than
 * trusting the arsenal to stay that way.
 */
/**
 * A shell that hits a hull.
 *
 * This is the whole "a direct hit should hurt" claim, driven through `fire()`
 * end to end — the aim is solved against the real physics, the shot is resolved
 * by the real turn machine, and the damage is read off the real events.
 *
 * It is here rather than in `balance.test.ts` because it is the one place the
 * two halves of the geometry meet: `physics.ts` decides where a shell STOPS
 * against a tank's hit circle, and `detonation.ts` decides how far that point
 * is from the tank. Those are two constants in two files (`tankRadius` and
 * `TANK_HULL_RADIUS`) and nothing but a real shot can tell you they agree.
 */
describe('a shell caught on the hull', () => {
  /** Aim tank 0 at tank 1 until a shot really lands on the other hull. */
  function hullShot(weaponId: string): { events: GameEvent[]; victimIndex: number } {
    const weapon = requireWeapon(weaponId);
    const base = flatGame(2, `hull-${weaponId}`);
    const armed: GameState = {
      ...base,
      activeTank: 0,
      tanks: base.tanks.map((tank, index) => ({
        ...tank,
        inventory: index === 0 ? { [weapon.id]: 9 } : {},
      })),
    };

    for (let angleDeg = 10; angleDeg <= 80; angleDeg += 1) {
      for (let power = 20; power <= 100; power += 1) {
        const flight = predictShot(armed, 0, angleDeg, power);
        if (flight.impact.kind !== 'tank' || flight.impact.tankIndex !== 1) continue;
        const result = fire(armed, (armed.tanks[0] as Tank).id, {
          turnNumber: armed.turnNumber,
          angleDeg,
          power,
          weapon: weapon.id,
        });
        return { events: result.events, victimIndex: 1 };
      }
    }
    throw new Error(`no shot with ${weaponId} landed on the other tank`);
  }

  it("does the weapon's full damage, not a near miss's", () => {
    /*
     * The defect this pins: `physics.ts` stops a shell the moment it touches
     * the target's hit circle, so the impact point of a direct hit sits a full
     * hull radius from the point damage is measured against. Measuring the
     * blast from the hull's CENTRE therefore charged every direct hit a near
     * miss's falloff — on a Baby Missile (radius 18) exactly the 50% mark, so
     * the free weapon did 13 a hit and needed eight hits for a kill.
     *
     * Asserted against the weapon's own `damage` cell, which is the promise
     * the table makes, so it fails in BOTH directions: measure from the centre
     * again and it halves, and let the hull credit grow past a hull and the
     * rounding stops matching.
     */
    for (const weaponId of ['baby_missile', 'missile', 'baby_nuke']) {
      const weapon = requireWeapon(weaponId);
      const { events, victimIndex } = hullShot(weaponId);
      // The FIRST damage event, which is the blast itself. A crater under a
      // tank drops it, and `settleTanks` charges for the fall in a second event
      // — real, deserved, and not what this test is measuring.
      const blastDamage = events.find(
        (event): event is Extract<GameEvent, { type: 'damage' }> =>
          event.type === 'damage' && event.tankIndex === victimIndex,
      )?.amount;
      expect(blastDamage, `${weaponId} on the hull`).toBe(
        Math.min(Math.round(weapon.damage), DEFAULT_WORLD.maxHealth),
      );
      // …and the fall is on top, never instead.
      expect(damageOf(events, victimIndex)).toBeGreaterThanOrEqual(blastDamage as number);
    }
  });

  it('takes a full-health tank most of the way down with one Missile', () => {
    // The same measurement said as a player would say it. A Missile is the
    // cheap workhorse and it has to feel like one.
    const { events, victimIndex } = hullShot('missile');
    const healthAfter = events
      .filter(
        (event): event is Extract<GameEvent, { type: 'damage' }> =>
          event.type === 'damage' && event.tankIndex === victimIndex,
      )
      .map((event) => event.healthAfter)
      .pop();
    expect(healthAfter).toBeDefined();
    expect(healthAfter as number).toBeLessThan(DEFAULT_WORLD.maxHealth / 2);
  });
});

describe('moving the ground out from under someone, through the real fire path', () => {
  /**
   * Fire `weaponId` from x = 100 at whatever it hits, with the victim parked
   * where the shell really lands.
   *
   * The landing point is found by flying the shot with nobody in the way, so
   * nothing here depends on a hand-computed range: retune the ballistics and
   * the fixture follows.
   */
  function groundShot(
    weaponId: string,
    victimPatch: Partial<Tank> = {},
  ): {
    before: GameState;
    after: GameState;
    events: GameEvent[];
    victimIndex: number;
    groundMoved: number;
  } {
    const angleDeg = 45;
    const power = 70;
    const base = flatGame(3, `ground-${weaponId}`);
    const solo = simulateFlight(
      { x: 100, y: GROUND - DEFAULT_WORLD.tankRadius - 2, angleDeg, power },
      { terrain: base.terrain, wind: 0 },
    );
    expect(solo.impact.kind).toBe('terrain');
    const landing = Math.round(solo.impact.x);

    // Shooter at 100, victim under the shell, bystander parked at the far edge
    // so the round cannot end on this shot and nothing settles under it.
    let state = place(base, 0, { x: 100, y: GROUND, inventory: { [weaponId]: 3 } });
    state = place(state, 1, { x: landing, y: GROUND, ...victimPatch });
    state = place(state, 2, { x: 1270, y: GROUND });
    state = { ...state, activeTank: 0 };

    const { state: after, events } = fire(state, (state.tanks[0] as Tank).id, {
      turnNumber: state.turnNumber,
      angleDeg,
      power,
      weapon: weaponId,
    });

    return {
      before: state,
      after,
      events,
      victimIndex: 1,
      groundMoved: surfaceAt(after.terrain, landing) - GROUND,
    };
  }

  it('credits a burial to the tank that dropped the dirt', () => {
    // Zero direct damage by definition, so the whole ledger below came from the
    // dig-out. If `fire()` stopped naming the shooter, this reads zero.
    expect(requireWeapon('ton_of_dirt').damage).toBe(0);

    const { before, after, events, groundMoved } = groundShot('ton_of_dirt');
    // Negative: the surface rose, which is dirt stacked over the tank.
    expect(groundMoved).toBeLessThan(-BURIAL.freeDepth);

    const buried = burialDamage(-groundMoved);
    expect(buried).toBeGreaterThan(0);

    const victim = after.tanks[1] as Tank;
    expect(victim.y).toBe(surfaceAt(after.terrain, victim.x));
    expect(victim.health).toBe(DEFAULT_WORLD.maxHealth - buried);
    expect(damageOf(events, 1)).toBe(buried);

    const shooterBefore = before.tanks[0] as Tank;
    const shooter = after.tanks[0] as Tank;
    expect(shooter.score).toBe(shooterBefore.score + buried);
    expect(shooter.money).toBe(shooterBefore.money + buried * DEFAULT_WORLD.damageBounty);
  });

  it('credits a fall to the tank that dug the ground away', () => {
    expect(requireWeapon('riot_blast').damage).toBe(0);

    const { before, after, events, groundMoved } = groundShot('riot_blast');
    // Positive: y grows downwards, so the surface dropped away.
    expect(groundMoved).toBeGreaterThan(FALL.safeDrop);

    const fell = fallDamage(groundMoved);
    expect(fell).toBeGreaterThan(0);

    const victim = after.tanks[1] as Tank;
    expect(victim.y).toBe(surfaceAt(after.terrain, victim.x));
    expect(victim.health).toBe(DEFAULT_WORLD.maxHealth - fell);
    expect(damageOf(events, 1)).toBe(fell);

    const shooterBefore = before.tanks[0] as Tank;
    const shooter = after.tanks[0] as Tank;
    expect(shooter.score).toBe(shooterBefore.score + fell);
    expect(shooter.money).toBe(shooterBefore.money + fell * DEFAULT_WORLD.damageBounty);
  });

  it('pays the kill bounty when the ground finishes a wounded tank', () => {
    // The whole point of the change: dropping somebody down a hole you dug is a
    // kill you earned. A weapon that does no damage at all can still get one.
    const { before, after, events } = groundShot('riot_blast', { health: 3 });

    const victim = after.tanks[1] as Tank;
    expect(victim.alive).toBe(false);
    expect(events).toContainEqual({ type: 'death', tankIndex: 1, byTankIndex: 0 });

    const shooterBefore = before.tanks[0] as Tank;
    const shooter = after.tanks[0] as Tank;
    expect(shooter.score).toBe(shooterBefore.score + 3);
    expect(shooter.money).toBe(
      shooterBefore.money + 3 * DEFAULT_WORLD.damageBounty + DEFAULT_WORLD.killBounty,
    );
    // The bystander is still standing, so the round is live and no survival
    // bonus has been added to the ledger this assertion is reading.
    expect(after.phase).toBe('aiming');
  });

  it('still charges a tank that digs its own hole, and pays nobody for it', () => {
    // The mirror image, and the reason the credit is `byTankIndex` rather than
    // "the active tank": `applyDamage` drops the bounty when victim and shooter
    // are the same tank.
    const base = flatGame(3, 'self-dig');
    let state = place(base, 0, { x: 400, y: GROUND, inventory: { riot_blast: 3 } });
    state = place(state, 1, { x: 100, y: GROUND });
    state = place(state, 2, { x: 1270, y: GROUND });
    state = { ...state, activeTank: 0 };
    const moneyBefore = (state.tanks[0] as Tank).money;

    // Straight up at a crawl: it comes down on its own feet.
    const { state: after } = fire(state, (state.tanks[0] as Tank).id, {
      turnNumber: state.turnNumber,
      angleDeg: 90,
      power: 1,
      weapon: 'riot_blast',
    });

    const digger = after.tanks[0] as Tank;
    expect(surfaceAt(after.terrain, digger.x)).toBeGreaterThan(GROUND + FALL.safeDrop);
    expect(digger.y).toBe(surfaceAt(after.terrain, digger.x));
    expect(digger.health).toBeLessThan(DEFAULT_WORLD.maxHealth);
    expect(digger.money).toBe(moneyBefore);
    expect(digger.score).toBe(0);
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
