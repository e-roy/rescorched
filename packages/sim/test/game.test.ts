import { describe, expect, it } from 'vitest';
import {
  ammoFor,
  createGame,
  fire,
  hashGameState,
  IllegalMoveError,
  MAX_PLAYERS,
  startNextRound,
  type GameState,
  type Tank,
} from '../src/game.ts';
import { buy, leaveShop } from '../src/economy.ts';
import { BABY_MISSILE } from '../src/weapons.ts';
import { fromPersisted, toPersisted, toSnapshot } from '../src/serialize.ts';

const PLAYERS = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
];

function newGame(seed: number | string = 'ABCD:1'): GameState {
  return createGame({ seed, totalRounds: 2 }, PLAYERS);
}

/** Whose turn it is. Turn order is shuffled per round, so nothing may assume 0. */
function activeId(state: GameState): string {
  return (state.tanks[state.activeTank] as Tank).id;
}

function otherId(state: GameState): string {
  return (state.tanks.find((tank) => tank.id !== activeId(state)) as Tank).id;
}

/**
 * Everything about a state that could possibly have moved.
 *
 * The hash alone is a 32-bit summary and deliberately ignores player names; the
 * JSON is the whole persisted record. A rejected move has to leave both
 * identical, which is a stronger claim than either on its own.
 */
function fingerprint(state: GameState): string {
  return `${hashGameState(state)}\n${JSON.stringify(toPersisted(state))}`;
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

  it('points each gun at the field rather than off the edge', () => {
    const state = createGame({ seed: 'aim', width: 1280, height: 720 }, PLAYERS);
    for (const tank of state.tanks) {
      expect(tank.angleDeg).toBe(tank.x < 640 ? 45 : 135);
    }
  });

  it('starts in the aiming phase on turn 1', () => {
    const state = newGame();
    expect(state.phase).toBe('aiming');
    expect(state.turnNumber).toBe(1);
    expect(state.activeTank).toBeGreaterThanOrEqual(0);
    expect(state.activeTank).toBeLessThan(state.tanks.length);
  });

  it('is fully determined by its seed', () => {
    expect(hashGameState(newGame('same'))).toBe(hashGameState(newGame('same')));
    expect(hashGameState(newGame('a'))).not.toBe(hashGameState(newGame('b')));
  });

  it('rejects a game with no players', () => {
    expect(() => createGame({ seed: 1 }, [])).toThrow(IllegalMoveError);
  });

  it('rejects a lobby larger than the wire can carry', () => {
    const many = Array.from({ length: MAX_PLAYERS + 1 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
    }));
    expect(() => createGame({ seed: 1 }, many)).toThrow(/at most 16/i);
    // And the largest legal lobby really does work.
    expect(createGame({ seed: 1 }, many.slice(0, MAX_PLAYERS)).tanks).toHaveLength(MAX_PLAYERS);
  });

  it('rejects two players sharing an id', () => {
    // Every rule in this file addresses a player by id. Two tanks answering to
    // the same one makes "is it your turn" and "who won" unanswerable.
    expect(() =>
      createGame({ seed: 1 }, [
        { id: 'p1', name: 'Alice' },
        { id: 'p1', name: 'Mallory' },
      ]),
    ).toThrow(/duplicate/i);
  });

  it('rejects a nonsense round count', () => {
    for (const totalRounds of [0, -1, 2.5, Number.NaN]) {
      expect(() => createGame({ seed: 1, totalRounds }, PLAYERS)).toThrow(IllegalMoveError);
    }
  });
});

describe('firing', () => {
  it('advances the turn and hands over to the other player', () => {
    const state = newGame();
    const shooter = activeId(state);
    const result = fire(state, shooter, {
      turnNumber: 1,
      angleDeg: 45,
      power: 60,
      weapon: BABY_MISSILE,
    });

    expect(result.state.turnNumber).toBe(2);
    expect(activeId(result.state)).not.toBe(shooter);
    expect(result.events.some((event) => event.type === 'shot')).toBe(true);
  });

  it('leaves the original state untouched', () => {
    const state = newGame();
    const before = fingerprint(state);
    fire(state, activeId(state), {
      turnNumber: 1,
      angleDeg: 45,
      power: 60,
      weapon: BABY_MISSILE,
    });
    expect(fingerprint(state)).toBe(before);
  });

  it('never runs out of Baby Missiles', () => {
    let state = newGame();
    for (let i = 0; i < 12 && state.phase === 'aiming'; i += 1) {
      const shooter = state.tanks[state.activeTank] as Tank;
      expect(ammoFor(shooter, BABY_MISSILE)).toBe(Number.POSITIVE_INFINITY);
      state = fire(state, shooter.id, {
        turnNumber: state.turnNumber,
        angleDeg: 30 + i,
        power: 55,
        weapon: BABY_MISSILE,
      }).state;
    }
  });

  it('spends a round of a bought weapon and falls back when it runs out', () => {
    let state: GameState = { ...newGame(), phase: 'shopping' };
    const buyer = state.tanks[0] as Tank;
    state = buy(state, buyer.id, 'missile', 1).state;
    // One round left, so firing it should empty the slot entirely.
    state = {
      ...state,
      phase: 'aiming',
      activeTank: 0,
      tanks: state.tanks.map((tank, index) =>
        index === 0 ? { ...tank, inventory: { missile: 1 } } : tank,
      ),
    };

    const after = fire(state, buyer.id, {
      turnNumber: state.turnNumber,
      angleDeg: 45,
      power: 60,
      weapon: 'missile',
    }).state;

    const shooter = after.tanks[0] as Tank;
    expect(shooter.inventory['missile']).toBeUndefined();
    expect(shooter.selectedWeapon).toBe(BABY_MISSILE);
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
      const shooter = state.tanks[state.activeTank] as Tank;
      state = fire(state, shooter.id, {
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

describe('an illegal move changes nothing at all', () => {
  /**
   * Each case builds a state, names the move that must bounce off it, and the
   * `code` the caller is entitled to see. The assertion is the same every time
   * and it is the point of the whole block: the state before and the state
   * after are byte-identical, so a rejected shot cannot leak a spent round, a
   * moved gun, or an advanced RNG.
   */
  const cases: {
    label: string;
    code: string;
    build: () => { state: GameState; playerId: string; input: Parameters<typeof fire>[2] };
  }[] = [
    {
      label: 'a shot from the wrong player',
      code: 'not_your_turn',
      build: () => {
        const state = newGame('wrong-player');
        return {
          state,
          playerId: otherId(state),
          input: { turnNumber: state.turnNumber, angleDeg: 45, power: 60, weapon: BABY_MISSILE },
        };
      },
    },
    {
      label: 'a shot from a player who is not in the game',
      code: 'not_your_turn',
      build: () => {
        const state = newGame('stranger');
        return {
          state,
          playerId: 'mallory',
          input: { turnNumber: state.turnNumber, angleDeg: 45, power: 60, weapon: BABY_MISSILE },
        };
      },
    },
    {
      label: 'a stale turn number',
      code: 'stale_turn',
      build: () => {
        const state = newGame('stale');
        return {
          state,
          playerId: activeId(state),
          input: { turnNumber: 99, angleDeg: 45, power: 60, weapon: BABY_MISSILE },
        };
      },
    },
    {
      label: 'a replay of the turn just played',
      code: 'stale_turn',
      build: () => {
        const first = newGame('replay');
        const state = fire(first, activeId(first), {
          turnNumber: first.turnNumber,
          angleDeg: 40,
          power: 55,
          weapon: BABY_MISSILE,
        }).state;
        return {
          state,
          playerId: activeId(state),
          input: { turnNumber: first.turnNumber, angleDeg: 40, power: 55, weapon: BABY_MISSILE },
        };
      },
    },
    {
      label: 'an angle below the dial',
      code: 'bad_angle',
      build: () => {
        const state = newGame('angle-low');
        return {
          state,
          playerId: activeId(state),
          input: { turnNumber: state.turnNumber, angleDeg: -1, power: 50, weapon: BABY_MISSILE },
        };
      },
    },
    {
      label: 'an angle above the dial',
      code: 'bad_angle',
      build: () => {
        const state = newGame('angle-high');
        return {
          state,
          playerId: activeId(state),
          input: { turnNumber: state.turnNumber, angleDeg: 181, power: 50, weapon: BABY_MISSILE },
        };
      },
    },
    {
      label: 'a NaN angle',
      code: 'bad_angle',
      build: () => {
        const state = newGame('angle-nan');
        return {
          state,
          playerId: activeId(state),
          input: {
            turnNumber: state.turnNumber,
            angleDeg: Number.NaN,
            power: 50,
            weapon: BABY_MISSILE,
          },
        };
      },
    },
    {
      label: 'power below the dial',
      code: 'bad_power',
      build: () => {
        const state = newGame('power-low');
        return {
          state,
          playerId: activeId(state),
          input: { turnNumber: state.turnNumber, angleDeg: 45, power: -1, weapon: BABY_MISSILE },
        };
      },
    },
    {
      label: 'power above the dial',
      code: 'bad_power',
      build: () => {
        const state = newGame('power-high');
        return {
          state,
          playerId: activeId(state),
          input: { turnNumber: state.turnNumber, angleDeg: 45, power: 101, weapon: BABY_MISSILE },
        };
      },
    },
    {
      label: 'infinite power',
      code: 'bad_power',
      build: () => {
        const state = newGame('power-inf');
        return {
          state,
          playerId: activeId(state),
          input: {
            turnNumber: state.turnNumber,
            angleDeg: 45,
            power: Number.POSITIVE_INFINITY,
            weapon: BABY_MISSILE,
          },
        };
      },
    },
    {
      label: 'a weapon that does not exist',
      code: 'unknown_weapon',
      build: () => {
        const state = newGame('no-such-weapon');
        return {
          state,
          playerId: activeId(state),
          input: { turnNumber: state.turnNumber, angleDeg: 45, power: 60, weapon: 'death_star' },
        };
      },
    },
    {
      label: 'a weapon the player does not own',
      code: 'no_ammo',
      build: () => {
        const state = newGame('no-ammo');
        return {
          state,
          playerId: activeId(state),
          input: { turnNumber: state.turnNumber, angleDeg: 45, power: 60, weapon: 'nuke' },
        };
      },
    },
    {
      label: 'a shot fired between rounds',
      code: 'wrong_phase',
      build: () => {
        const state: GameState = { ...newGame('shopping'), phase: 'shopping' };
        return {
          state,
          playerId: activeId(state),
          input: { turnNumber: state.turnNumber, angleDeg: 45, power: 60, weapon: BABY_MISSILE },
        };
      },
    },
    {
      label: 'a shot fired after the match is over',
      code: 'wrong_phase',
      build: () => {
        const state: GameState = { ...newGame('over'), phase: 'gameover' };
        return {
          state,
          playerId: activeId(state),
          input: { turnNumber: state.turnNumber, angleDeg: 45, power: 60, weapon: BABY_MISSILE },
        };
      },
    },
    {
      label: 'a shot from a wreck',
      code: 'tank_destroyed',
      build: () => {
        const base = newGame('wreck');
        const state: GameState = {
          ...base,
          tanks: base.tanks.map((tank, index) =>
            index === base.activeTank ? { ...tank, alive: false, health: 0 } : tank,
          ),
        };
        return {
          state,
          playerId: activeId(state),
          input: { turnNumber: state.turnNumber, angleDeg: 45, power: 60, weapon: BABY_MISSILE },
        };
      },
    },
  ];

  it.each(cases)('rejects $label with $code', ({ code, build }) => {
    const { state, playerId, input } = build();
    const before = fingerprint(state);

    let thrown: unknown;
    try {
      fire(state, playerId, input);
      expect.unreachable('the move should have been rejected');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IllegalMoveError);
    expect((thrown as IllegalMoveError).code).toBe(code);
    expect((thrown as IllegalMoveError).message).not.toBe('');
    expect(fingerprint(state)).toBe(before);
  });

  it('rejects starting a round outside the shop', () => {
    const state = newGame();
    const before = fingerprint(state);
    expect(() => startNextRound(state)).toThrow(/not between rounds/i);
    expect(fingerprint(state)).toBe(before);
  });
});

/**
 * The shop itself is `economy.ts` and is tested in `economy.test.ts` — prices,
 * refunds, affordability and the wallet invariants all live there. What belongs
 * here is only the seam: the turn machine decides WHEN the shop is open, and a
 * mismatch between the two is a bug neither file's own tests would catch.
 */
describe('the seam between the turn machine and the shop', () => {
  it('keeps the shop shut while a round is being played', () => {
    const state = newGame(); // phase: aiming
    expect(() => buy(state, activeId(state), 'missile', 1)).toThrow(/shop is closed/i);
  });

  it('opens it for the intermission the turn machine declares', () => {
    const state: GameState = {
      ...newGame(),
      phase: 'shopping',
      pendingShoppers: ['p1', 'p2'],
    };
    expect(() => buy(state, 'p1', 'missile', 1)).not.toThrow();
    // And leaving is what eventually satisfies `everyoneHasShopped`, which is
    // the server's cue to call `startNextRound`.
    expect(leaveShop(state, 'p1').pendingShoppers).toEqual(['p2']);
  });

  it('hands ammo bought between rounds to the tank that fires next round', () => {
    let state: GameState = { ...newGame(), phase: 'shopping', pendingShoppers: [] };
    state = buy(state, 'p1', 'missile', 1).state;
    const bought = (state.tanks[0] as Tank).inventory['missile'] as number;
    expect(bought).toBeGreaterThan(0);

    const next = startNextRound(state).state;
    expect((next.tanks[0] as Tank).inventory['missile']).toBe(bought);
    expect(ammoFor(next.tanks[0] as Tank, 'missile')).toBe(bought);
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
    const shooter = activeId(state);
    const input = { turnNumber: 1, angleDeg: 55, power: 72, weapon: BABY_MISSILE };
    const direct = fire(state, shooter, input).state;

    const roundTripped = fromPersisted(JSON.parse(JSON.stringify(toPersisted(state))));
    const afterRestore = fire(roundTripped, shooter, input).state;

    expect(hashGameState(afterRestore)).toBe(hashGameState(direct));
  });
});
