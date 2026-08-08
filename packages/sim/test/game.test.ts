import { describe, expect, it } from 'vitest';
import {
  ammoFor,
  createGame,
  fire,
  hashGameState,
  IllegalMoveError,
  startNextRound,
  type GameState,
} from '../src/game.ts';
import { buy, leaveShop, sell, shopInventory } from '../src/economy.ts';
import { BABY_MISSILE } from '../src/weapons.ts';
import { fromPersisted, toPersisted, toSnapshot } from '../src/serialize.ts';

const PLAYERS = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
];

function newGame(seed: number | string = 'ABCD:1'): GameState {
  return createGame({ seed, totalRounds: 2 }, PLAYERS);
}

describe('game setup', () => {
  it('places one tank per player, on the ground, at full health', () => {
    const state = newGame();
    expect(state.tanks).toHaveLength(2);
    for (const tank of state.tanks) {
      expect(tank.health).toBe(100);
      expect(tank.alive).toBe(true);
      expect(tank.x).toBeGreaterThanOrEqual(0);
      expect(tank.x).toBeLessThan(state.terrain.width);
      expect(tank.y).toBe(state.terrain.surface[tank.x]);
    }
  });

  it('separates the tanks', () => {
    const state = newGame();
    const [a, b] = state.tanks;
    expect(Math.abs((a?.x ?? 0) - (b?.x ?? 0))).toBeGreaterThan(100);
  });

  it('starts in the aiming phase on turn 1', () => {
    const state = newGame();
    expect(state.phase).toBe('aiming');
    expect(state.turnNumber).toBe(1);
    expect(state.activeTank).toBe(0);
  });

  it('is fully determined by its seed', () => {
    expect(hashGameState(newGame('same'))).toBe(hashGameState(newGame('same')));
    expect(hashGameState(newGame('a'))).not.toBe(hashGameState(newGame('b')));
  });

  it('rejects a game with no players', () => {
    expect(() => createGame({ seed: 1 }, [])).toThrow(IllegalMoveError);
  });
});

describe('firing', () => {
  it('advances the turn and hands over to the other player', () => {
    const state = newGame();
    const result = fire(state, 'p1', {
      turnNumber: 1,
      angleDeg: 45,
      power: 60,
      weapon: BABY_MISSILE,
    });

    expect(result.state.turnNumber).toBe(2);
    expect(result.state.activeTank).toBe(1);
    expect(result.events.some((event) => event.type === 'shot')).toBe(true);
  });

  it('leaves the original state untouched', () => {
    const state = newGame();
    const before = hashGameState(state);
    fire(state, 'p1', { turnNumber: 1, angleDeg: 45, power: 60, weapon: BABY_MISSILE });
    expect(hashGameState(state)).toBe(before);
  });

  it('rejects a shot from the wrong player', () => {
    const state = newGame();
    expect(() =>
      fire(state, 'p2', { turnNumber: 1, angleDeg: 45, power: 60, weapon: BABY_MISSILE }),
    ).toThrow(/not your turn/i);
  });

  it('rejects a stale turn number', () => {
    const state = newGame();
    expect(() =>
      fire(state, 'p1', { turnNumber: 99, angleDeg: 45, power: 60, weapon: BABY_MISSILE }),
    ).toThrow(/already been played/i);
  });

  it.each([
    ['angle below range', { angleDeg: -1, power: 50 }],
    ['angle above range', { angleDeg: 181, power: 50 }],
    ['power below range', { angleDeg: 45, power: -1 }],
    ['power above range', { angleDeg: 45, power: 101 }],
    ['NaN angle', { angleDeg: Number.NaN, power: 50 }],
    ['Infinite power', { angleDeg: 45, power: Number.POSITIVE_INFINITY }],
  ])('rejects %s', (_label, input) => {
    const state = newGame();
    expect(() => fire(state, 'p1', { turnNumber: 1, weapon: BABY_MISSILE, ...input })).toThrow(
      IllegalMoveError,
    );
  });

  it('rejects an unknown weapon', () => {
    const state = newGame();
    expect(() =>
      fire(state, 'p1', { turnNumber: 1, angleDeg: 45, power: 60, weapon: 'death_star' }),
    ).toThrow(/unknown weapon/i);
  });

  it('rejects a weapon the player has no ammo for', () => {
    const state = newGame();
    expect(() =>
      fire(state, 'p1', { turnNumber: 1, angleDeg: 45, power: 60, weapon: 'nuke' }),
    ).toThrow(/out of/i);
  });

  it('never runs out of Baby Missiles', () => {
    let state = newGame();
    for (let i = 0; i < 12 && state.phase === 'aiming'; i += 1) {
      const shooter = state.tanks[state.activeTank];
      expect(ammoFor(shooter!, BABY_MISSILE)).toBe(Number.POSITIVE_INFINITY);
      state = fire(state, shooter!.id, {
        turnNumber: state.turnNumber,
        angleDeg: 30 + i,
        power: 55,
        weapon: BABY_MISSILE,
      }).state;
    }
  });

  it('keeps health at or above zero however hard it is hit', () => {
    let state = newGame();
    // Park both tanks on top of each other and unload.
    state = {
      ...state,
      tanks: state.tanks.map((tank) => ({
        ...tank,
        x: 400,
        y: state.terrain.surface[400] as number,
      })),
    };

    for (let i = 0; i < 30 && state.phase === 'aiming'; i += 1) {
      const shooter = state.tanks[state.activeTank];
      state = fire(state, shooter!.id, {
        turnNumber: state.turnNumber,
        angleDeg: 90,
        power: 1,
        weapon: BABY_MISSILE,
      }).state;
      for (const tank of state.tanks) {
        expect(tank.health).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('economy', () => {
  it('lists everything except the free weapon', () => {
    const state = newGame();
    const items = shopInventory(state.tanks[0]!);
    expect(items.length).toBeGreaterThan(3);
    expect(items.some((item) => item.weapon.id === BABY_MISSILE)).toBe(false);
  });

  it('buys ammo and debits the wallet', () => {
    const state = { ...newGame(), phase: 'shopping' as const };
    const before = state.tanks[0]!.money;
    const result = buy(state, 'p1', 'missile', 1);

    expect(result.spent).toBeGreaterThan(0);
    expect(result.moneyAfter).toBe(before - result.spent);
    expect(result.state.tanks[0]!.inventory['missile']).toBe(10);
  });

  it('refuses a purchase the player cannot afford', () => {
    const state = { ...newGame(), phase: 'shopping' as const };
    expect(() => buy(state, 'p1', 'nuke', 99)).toThrow(/cannot afford/i);
  });

  it('refuses to sell the free weapon', () => {
    const state = { ...newGame(), phase: 'shopping' as const };
    expect(() => buy(state, 'p1', BABY_MISSILE, 1)).toThrow(/free and unlimited/i);
    expect(() => sell(state, 'p1', BABY_MISSILE)).toThrow(/cannot be sold/i);
  });

  it('refunds half on a sale', () => {
    let state: GameState = { ...newGame(), phase: 'shopping' };
    state = buy(state, 'p1', 'missile', 1).state;
    const afterBuy = state.tanks[0]!.money;
    const result = sell(state, 'p1', 'missile');
    expect(result.moneyAfter).toBeGreaterThan(afterBuy);
    expect(result.state.tanks[0]!.inventory['missile']).toBeUndefined();
  });

  it('closes the shop outside the shopping phase', () => {
    const state = newGame(); // phase: aiming
    expect(() => buy(state, 'p1', 'missile', 1)).toThrow(/shop is closed/i);
  });

  it('tracks who is still shopping', () => {
    const state: GameState = {
      ...newGame(),
      phase: 'shopping',
      pendingShoppers: ['p1', 'p2'],
    };
    const after = leaveShop(state, 'p1');
    expect(after.pendingShoppers).toEqual(['p2']);
  });
});

describe('rounds', () => {
  it('rejects starting a round outside the shop', () => {
    expect(() => startNextRound(newGame())).toThrow(/not between rounds/i);
  });

  it('regenerates terrain and revives everyone', () => {
    const state: GameState = {
      ...newGame(),
      phase: 'shopping',
      pendingShoppers: [],
      tanks: newGame().tanks.map((tank) => ({ ...tank, health: 0, alive: false })),
    };
    const result = startNextRound(state);
    expect(result.state.round).toBe(2);
    expect(result.state.phase).toBe('aiming');
    for (const tank of result.state.tanks) {
      expect(tank.alive).toBe(true);
      expect(tank.health).toBe(100);
      expect(tank.y).toBe(result.state.terrain.surface[tank.x]);
    }
  });
});

describe('serialisation', () => {
  it('round-trips a full game through JSON without drift', () => {
    const state = newGame();
    const restored = fromPersisted(JSON.parse(JSON.stringify(toPersisted(state))));
    expect(hashGameState(restored)).toBe(hashGameState(state));
  });

  it('never leaks the RNG state to clients', () => {
    const snapshot = toSnapshot(newGame()) as unknown as Record<string, unknown>;
    expect(snapshot['rngState']).toBeUndefined();
  });

  it('resumes identically after a store/restore cycle mid-match', () => {
    const state = newGame();
    const direct = fire(state, 'p1', {
      turnNumber: 1,
      angleDeg: 55,
      power: 72,
      weapon: BABY_MISSILE,
    }).state;

    const roundTripped = fromPersisted(JSON.parse(JSON.stringify(toPersisted(state))));
    const afterRestore = fire(roundTripped, 'p1', {
      turnNumber: 1,
      angleDeg: 55,
      power: 72,
      weapon: BABY_MISSILE,
    }).state;

    expect(hashGameState(afterRestore)).toBe(hashGameState(direct));
  });
});
