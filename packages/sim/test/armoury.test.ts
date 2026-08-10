/**
 * The armoury that opens before round one.
 *
 * The original opens with the armoury: you spend your starting money BEFORE the
 * first shell flies. This game dropped straight into `aiming`, so round one was
 * always fought with the free Baby Missile while 10000 sat idle in every bank —
 * which is most of why a round felt like a grind, because the free weapon takes
 * four direct hits and nobody had anything else.
 *
 * The rule is small and it lives in two functions: `createGame` hands back a
 * `shopping` phase with everybody pending, and `startNextRound` opens round one
 * in place rather than advancing the round and re-rolling the map. What holds
 * it up is that the shop between rounds and the shop before round one are the
 * SAME shop, so almost none of `economy.ts` had to know — the tests below are
 * mostly about the seams where something did.
 */

import { describe, expect, it } from 'vitest';

import {
  applyBotShopping,
  BABY_MISSILE,
  buy,
  choosePurchases,
  createGame,
  DEFAULT_WORLD,
  everyoneHasShopped,
  fire,
  hashGameState,
  hashTerrain,
  IllegalMoveError,
  isArmouryBeforeRoundOne,
  leaveShop,
  requireWeapon,
  roundsFought,
  roundStartTurn,
  startNextRound,
  type GameState,
} from '../src/index.ts';

const PLAYERS = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
];

function armoury(seed: string | number = 'ARM:1'): GameState {
  return createGame({ seed, totalRounds: 3 }, PLAYERS);
}

describe('a match begins in the armoury', () => {
  it('opens the shop for everybody before anybody can fire', () => {
    const state = armoury();

    expect(state.phase).toBe('shopping');
    expect([...state.pendingShoppers].sort()).toEqual(['p1', 'p2']);
    expect(isArmouryBeforeRoundOne(state)).toBe(true);
    // Round one, not round zero: the round about to be fought is the round the
    // state names, which is what lets `startNextRound` leave the counter alone.
    expect(state.round).toBe(1);

    // And the guns are cold. This is the assertion the whole change is for: a
    // player cannot skip the shop by firing out of it.
    expect(() =>
      fire(state, 'p1', {
        turnNumber: state.turnNumber,
        angleDeg: 45,
        power: 60,
        weapon: BABY_MISSILE,
      }),
    ).toThrow(IllegalMoveError);
  });

  it('counts nothing as fought yet, so the arms level is at its opening notch', () => {
    // The between-rounds shop reports `round` rounds fought; the armoury has to
    // report zero, or a match would start one notch up the arms level.
    expect(roundsFought(armoury())).toBe(0);

    const afterRoundOne: GameState = {
      ...armoury(),
      turnNumber: roundStartTurn({ round: 1, tanks: armoury().tanks }),
    };
    expect(isArmouryBeforeRoundOne(afterRoundOne)).toBe(false);
    expect(roundsFought(afterRoundOne)).toBe(1);
  });

  it('lets a player spend the opening bank on something worth firing', () => {
    const missile = requireWeapon('missile');
    const bought = buy(armoury(), 'p1', missile.id, 1);

    expect(bought.moneyAfter).toBe(DEFAULT_WORLD.startingMoney - missile.price);
    expect(bought.ownedAfter).toBe(missile.packSize);

    // …and it is still there once the round starts, which is the point of
    // buying it. Everyone out of the shop, then look.
    let state = bought.state;
    for (const id of ['p1', 'p2']) state = leaveShop(state, id);
    expect(everyoneHasShopped(state)).toBe(true);

    const opened = startNextRound(state).state;
    expect(opened.phase).toBe('aiming');
    expect((opened.tanks[0] as GameState['tanks'][number]).inventory[missile.id]).toBe(
      missile.packSize,
    );
  });
});

describe('leaving the armoury opens round one', () => {
  it('starts the round it was already on, on the board it was already showing', () => {
    /*
     * The between-rounds path advances the round, re-rolls the terrain and
     * re-seats everybody. Doing any of that here would be wrong in three
     * separate ways: round one would be round two, the player would have shopped
     * while looking at a map they never fight on, and a five-round match would
     * be four.
     */
    const before = armoury();
    let state = before;
    for (const id of ['p1', 'p2']) state = leaveShop(state, id);
    const opened = startNextRound(state).state;

    expect(opened.phase).toBe('aiming');
    expect(opened.round).toBe(1);
    expect(opened.turnNumber).toBe(roundStartTurn(opened));
    expect(hashTerrain(opened.terrain)).toBe(hashTerrain(before.terrain));
    expect(opened.tanks.map((tank) => [tank.x, tank.y])).toEqual(
      before.tanks.map((tank) => [tank.x, tank.y]),
    );
  });

  it('announces the first turn like any other', () => {
    let state = armoury();
    for (const id of ['p1', 'p2']) state = leaveShop(state, id);
    const { state: opened, events } = startNextRound(state);

    expect(events).toEqual([
      {
        type: 'turn',
        activeTank: opened.activeTank,
        turnNumber: opened.turnNumber,
        wind: opened.wind,
      },
    ]);
  });

  it('costs the match nothing in randomness, however much shopping happened', () => {
    /*
     * Determinism, at the one seam the armoury introduced. Two matches on the
     * same seed that shop differently must still fight the same round one — so
     * opening the round may not draw from the rng, or a player who bought a
     * Missile would change the wind for everybody.
     */
    const spent = buy(armoury(), 'p1', 'missile', 2).state;
    const thrifty = armoury();

    const open = (from: GameState): GameState => {
      let state = from;
      for (const id of ['p1', 'p2']) state = leaveShop(state, id);
      return startNextRound(state).state;
    };

    const a = open(spent);
    const b = open(thrifty);

    expect(a.rngState).toEqual(b.rngState);
    expect(a.wind).toBe(b.wind);
    expect(a.activeTank).toBe(b.activeTank);
    expect(hashTerrain(a.terrain)).toBe(hashTerrain(b.terrain));
    // Not the same game, though: one of them owns Missiles.
    expect(hashGameState(a)).not.toBe(hashGameState(b));
  });

  it('still refuses to start a round from anywhere but the shop', () => {
    let state = armoury();
    for (const id of ['p1', 'p2']) state = leaveShop(state, id);
    const opened = startNextRound(state).state;
    expect(() => startNextRound(opened)).toThrow(IllegalMoveError);
  });
});

describe('computer players shop before round one too', () => {
  it('walks every personality out of the armoury holding something', () => {
    /*
     * A bot that did not shop here would fight round one with the free weapon
     * while a human who did shop had a Missile — the exact asymmetry the
     * armoury was opened to remove. Measured per personality rather than
     * asserted once, because the shopping list is part of the personality.
     *
     * The Moron is the honest exception and it is named: its list is a Dirt
     * Clod, and its `weaponTierCap` is 0, so it buys cover and still fires Baby
     * Missiles. That is the joke, not a bug — so the assertion is that it
     * SPENT, not that it armed.
     */
    for (const personality of [
      'moron',
      'shooter',
      'tosser',
      'poolshark',
      'cyborg',
      'annihilator',
    ] as const) {
      const state = createGame({ seed: `bot-shop-${personality}`, totalRounds: 3 }, [
        { id: 'bot', name: 'Bot', bot: personality },
        { id: 'human', name: 'Human' },
      ]);
      expect(isArmouryBeforeRoundOne(state)).toBe(true);

      const wanted = choosePurchases(state, 0);
      expect(wanted.length, `${personality} bought nothing at the armoury`).toBeGreaterThan(0);

      const after = applyBotShopping(state, 0);
      const bot = after.tanks[0] as GameState['tanks'][number];
      expect(bot.money).toBeLessThan(DEFAULT_WORLD.startingMoney);
      expect(Object.keys(bot.inventory).length).toBeGreaterThan(0);
      // It spent its own money and nobody else's.
      expect((after.tanks[1] as GameState['tanks'][number]).money).toBe(
        DEFAULT_WORLD.startingMoney,
      );
    }
  });

  it('gives the aiming personalities a gun to open round one with', () => {
    // Stronger than "bought something": what it holds has to be something it
    // will actually pull the trigger on, which is the tier cap's business.
    for (const personality of [
      'shooter',
      'tosser',
      'poolshark',
      'cyborg',
      'annihilator',
    ] as const) {
      const state = applyBotShopping(
        createGame({ seed: `bot-arm-${personality}`, totalRounds: 3 }, [
          { id: 'bot', name: 'Bot', bot: personality },
          { id: 'human', name: 'Human' },
        ]),
        0,
      );
      const bot = state.tanks[0] as GameState['tanks'][number];
      const armed = Object.keys(bot.inventory).some((id) => requireWeapon(id).damage > 0);
      expect(armed, `${personality} left the armoury with nothing that hurts`).toBe(true);
    }
  });
});
