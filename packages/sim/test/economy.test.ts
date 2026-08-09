/**
 * The shop, and the economy it sits in.
 *
 * Three kinds of test live here.
 *
 * **Rules.** A purchase debits exactly what it should, a bad one is refused
 * rather than clamped, and no sequence of trades can conjure money out of
 * rounding.
 *
 * **Vocabulary.** Every refusal is asserted by CODE, not only by message. The
 * code is the half that reaches the player: `apps/server` maps a sim code onto
 * the wire enum by safe-parsing it and falling back to `internal`, so a code
 * that drifts out of that enum silently turns "You cannot afford 3x Baby Nuke"
 * into "Something went wrong handling that message" — with a message-only
 * assertion still green. `describe('the wire vocabulary')` closes that hole
 * from both ends: it checks the codes the shop really throws against the real
 * `ServerErrorCodeSchema`.
 *
 * **Balance.** The header comment in `economy.ts` makes numeric claims about
 * what a round's income buys. They are computed here from `DEFAULT_WORLD` and
 * the live `WEAPONS` table, never copied, so moving a price or a bounty makes
 * the test fail rather than making the comment wrong in silence.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createGame,
  DEFAULT_WORLD,
  fire,
  hashGameState,
  IllegalMoveError,
  type GamePhase,
  type GameState,
  type Tank,
} from '../src/game.ts';
import {
  buy,
  everyoneHasShopped,
  isOnTheShelf,
  leaveShop,
  MAX_PURCHASE_QUANTITY,
  refundForPack,
  roundsFought,
  sell,
  shopInventory,
  SHOP_ERROR_CODES,
  unlockRoundFor,
  type ShopErrorCode,
} from '../src/economy.ts';
import { BABY_MISSILE, getWeapon, requireWeapon, WEAPONS, type WeaponDef } from '../src/weapons.ts';
import { makeRng } from '../src/rng.ts';

const PLAYERS = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
  { id: 'p3', name: 'Carol' },
];

/** Everything the shop will actually trade. */
const FOR_SALE: readonly WeaponDef[] = WEAPONS.filter((weapon) => weapon.id !== BABY_MISSILE);

/**
 * `@scorched/protocol`, reached at runtime instead of imported.
 *
 * The sim deliberately does not depend on the protocol package: it is not in
 * `packages/sim/package.json`, and `rootDir` in its tsconfig rejects a static
 * import across the boundary outright. But the error codes in `economy.ts` ARE
 * protocol — the server hands them straight to `ServerErrorCodeSchema` — so one
 * test has to be able to hold the two lists against each other.
 *
 * A runtime specifier does that without putting protocol in the package graph
 * or in the sim's compiled surface. Vite resolves a leading `/` against the
 * project root, which for this package is `packages/sim`, hence the `..`. If
 * the file ever moves this throws, which is the correct outcome: the pin is
 * gone and someone needs to know.
 */
const PROTOCOL_MODULE: string = '/../protocol/src/index.ts';

interface ParsesLikeZod {
  safeParse(value: unknown): { success: boolean };
}

async function loadProtocol(): Promise<{
  ServerErrorCodeSchema: ParsesLikeZod;
  ClientMessageSchema: ParsesLikeZod;
}> {
  return (await import(PROTOCOL_MODULE)) as {
    ServerErrorCodeSchema: ParsesLikeZod;
    ClientMessageSchema: ParsesLikeZod;
  };
}

/**
 * A game parked in the intermission after `round` rounds.
 *
 * `state.round` is the round just finished while the phase is `shopping`, which
 * is exactly what the arms level counts, so `round` here IS "rounds fought".
 * The underlying game is built once and only ever spread from: `createGame`
 * generates a 1280-column terrain, and the property tests below ask for
 * thousands of these.
 */
let sharedBase: GameState | undefined;
function shoppingState(round = 5, money = 100000): GameState {
  sharedBase ??= createGame({ seed: 'SHOP:1', totalRounds: 9 }, PLAYERS);
  const base = sharedBase;
  return {
    ...base,
    round,
    phase: 'shopping',
    pendingShoppers: base.tanks.map((tank) => tank.id),
    tanks: base.tanks.map((tank) => ({ ...tank, money, inventory: {} })),
  };
}

function tankOf(state: GameState, id: string): Tank {
  const tank = state.tanks.find((candidate) => candidate.id === id);
  if (tank === undefined) throw new Error(`no tank ${id}`);
  return tank;
}

/**
 * Money plus stock at cost price. The quantity no sequence of trades may grow.
 *
 * Inventory only ever arrives in whole packs, so `rounds / packSize` is an
 * integer and this is exact integer arithmetic — which is what lets the tests
 * below assert an equality rather than an approximation.
 */
function netWorth(tank: Tank): number {
  let stock = 0;
  for (const [id, rounds] of Object.entries(tank.inventory)) {
    const weapon = requireWeapon(id);
    stock += (rounds / weapon.packSize) * weapon.price;
  }
  return tank.money + stock;
}

/** Run something that must be refused, and hand back the refusal. */
function rejection(run: () => unknown): IllegalMoveError {
  let thrown: unknown;
  let threw = false;
  try {
    run();
  } catch (error) {
    thrown = error;
    threw = true;
  }
  if (!threw) throw new Error('the shop allowed something it should have refused');
  expect(thrown).toBeInstanceOf(IllegalMoveError);
  return thrown as IllegalMoveError;
}

/**
 * Assert a refusal by code AND by message.
 *
 * The code first, always: it is what the wire carries and what decides whether
 * the player gets a sentence about their wallet or a shrug about an internal
 * error. The message matters too — an empty or wrong one is a bad shop — but a
 * test that only checks the message cannot tell a working shop from one whose
 * codes have all been renamed to gibberish.
 */
function expectRefusal(run: () => unknown, code: ShopErrorCode, message: RegExp): IllegalMoveError {
  const error = rejection(run);
  expect(error.code).toBe(code);
  expect(error.message).toMatch(message);
  return error;
}

/**
 * The documented rejection cascade of `buy`, re-derived from the spec.
 *
 * Deliberately a second implementation rather than a call into `economy.ts`:
 * the property test below uses it to assert not just THAT a purchase was
 * refused but WHICH answer the player got, across thousands of generated
 * states. Reordering the checks in `buy` — availability against affordability,
 * say — makes this disagree.
 */
function predictBuy(
  state: GameState,
  playerId: string,
  weaponId: string,
  quantity: number,
): ShopErrorCode | null {
  if (state.phase !== 'shopping' && state.phase !== 'lobby') return 'wrong_phase';
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PURCHASE_QUANTITY) {
    return 'bad_quantity';
  }
  const weapon = getWeapon(weaponId);
  if (weapon === undefined) return 'unknown_weapon';
  if (!(weapon.price > 0) || !Number.isFinite(weapon.packSize)) return 'not_for_sale';
  if (roundsFought(state) < unlockRoundFor(weapon)) return 'not_for_sale';
  const tank = state.tanks.find((candidate) => candidate.id === playerId);
  if (tank === undefined) return 'unknown_player';
  if (tank.money < weapon.price * quantity) return 'insufficient_funds';
  return null;
}

/** Round 5 is past every arms-level gate, so these three are freely tradeable. */
const CHEAP = requireWeapon('missile');
const MID = requireWeapon('baby_nuke');
const TOP = requireWeapon('deaths_head');

// ---------------------------------------------------------------------------
// The wire vocabulary
// ---------------------------------------------------------------------------

/**
 * One scenario per rejection the shop can produce, with the code it owes the
 * player. Every other block in this file leans on these codes; this table is
 * where they are enumerated so that "did we cover them all?" is answerable.
 */
const REFUSALS: ReadonlyArray<{
  what: string;
  code: ShopErrorCode;
  message: RegExp;
  run: () => unknown;
}> = [
  {
    what: 'buying with the shop shut',
    code: 'wrong_phase',
    message: /shop is closed/i,
    run: () => buy({ ...shoppingState(), phase: 'aiming' }, 'p1', CHEAP.id, 1),
  },
  {
    what: 'selling with the shop shut',
    code: 'wrong_phase',
    message: /shop is closed/i,
    run: () => sell({ ...shoppingState(), phase: 'aiming' }, 'p1', CHEAP.id, 1),
  },
  {
    what: 'pressing Done with the shop shut',
    code: 'wrong_phase',
    message: /shop is closed/i,
    run: () => leaveShop({ ...shoppingState(), phase: 'resolving' }, 'p1'),
  },
  {
    what: 'buying zero packs',
    code: 'bad_quantity',
    message: /whole number/i,
    run: () => buy(shoppingState(), 'p1', CHEAP.id, 0),
  },
  {
    what: 'selling a fractional pack count',
    code: 'bad_quantity',
    message: /whole number/i,
    run: () => sell(shoppingState(), 'p1', CHEAP.id, 1.5),
  },
  {
    what: 'buying a weapon that does not exist',
    code: 'unknown_weapon',
    message: /unknown weapon/i,
    run: () => buy(shoppingState(), 'p1', 'death_star', 1),
  },
  {
    what: 'buying the free weapon',
    code: 'not_for_sale',
    message: /free and unlimited/i,
    run: () => buy(shoppingState(), 'p1', BABY_MISSILE, 1),
  },
  {
    what: 'selling the free weapon',
    code: 'not_for_sale',
    message: /cannot be sold/i,
    run: () => sell(shoppingState(), 'p1', BABY_MISSILE, 1),
  },
  {
    what: 'buying a weapon the arms level has not reached',
    code: 'not_for_sale',
    message: /not in the armoury/i,
    run: () => buy(shoppingState(1, 100000), 'p1', TOP.id, 1),
  },
  {
    what: 'buying something the player cannot pay for',
    code: 'insufficient_funds',
    message: /cannot afford/i,
    run: () => buy(shoppingState(5, MID.price - 1), 'p1', MID.id, 1),
  },
  {
    what: 'selling something the player does not own',
    code: 'nothing_to_sell',
    message: /do not have/i,
    run: () => sell(shoppingState(), 'p1', TOP.id, 1),
  },
  {
    what: 'trading as somebody who is not in this game',
    code: 'unknown_player',
    message: /no such player/i,
    run: () => buy(shoppingState(), 'nobody', CHEAP.id, 1),
  },
  {
    what: 'pressing Done as somebody who is not in this game',
    code: 'unknown_player',
    message: /no such player/i,
    run: () => leaveShop(shoppingState(), 'nobody'),
  },
];

describe('the wire vocabulary', () => {
  it.each(REFUSALS)('answers $what with $code', ({ run, code, message }) => {
    expectRefusal(run, code, message);
  });

  it('every refusal the shop actually produces is a code the server can forward', async () => {
    // The failure this defends against is silent and player-facing: `toErrorCode`
    // in apps/server safe-parses the code and falls back to 'internal', so a
    // code the protocol has never heard of does not crash anything — it just
    // replaces a useful sentence with "Something went wrong handling that
    // message" while every message-matching test stays green.
    const { ServerErrorCodeSchema } = await loadProtocol();
    const unknown = REFUSALS.map((scenario) => rejection(scenario.run).code).filter(
      (code) => !ServerErrorCodeSchema.safeParse(code).success,
    );
    expect(unknown).toEqual([]);
  });

  it('declares exactly the codes it throws, and no more', () => {
    const thrown = new Set(REFUSALS.map((scenario) => rejection(scenario.run).code));
    expect(thrown).toEqual(new Set(SHOP_ERROR_CODES));
  });

  it('lists no code the protocol enum does not carry', async () => {
    const { ServerErrorCodeSchema } = await loadProtocol();
    const unknown = SHOP_ERROR_CODES.filter(
      (code) => !ServerErrorCodeSchema.safeParse(code).success,
    );
    expect(unknown).toEqual([]);
    // …and the guard is real, not vacuous: the schema does reject nonsense.
    expect(ServerErrorCodeSchema.safeParse('skint').success).toBe(false);
  });

  it('caps a purchase at the same 99 the wire schema does', async () => {
    // `MAX_PURCHASE_QUANTITY` claims to duplicate the protocol's cap on purpose.
    // Duplicated numbers rot; this is the test that stops it.
    const { ClientMessageSchema } = await loadProtocol();
    const message = (quantity: number) => ({ t: 'buy', weapon: CHEAP.id, quantity });
    expect(ClientMessageSchema.safeParse(message(MAX_PURCHASE_QUANTITY)).success).toBe(true);
    expect(ClientMessageSchema.safeParse(message(MAX_PURCHASE_QUANTITY + 1)).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------

describe('buying', () => {
  it('debits exactly the price and credits exactly the pack', () => {
    const state = shoppingState();
    const before = tankOf(state, 'p1').money;

    const result = buy(state, 'p1', CHEAP.id, 3);

    expect(result.spent).toBe(CHEAP.price * 3);
    expect(result.moneyAfter).toBe(before - CHEAP.price * 3);
    expect(tankOf(result.state, 'p1').money).toBe(before - CHEAP.price * 3);
    expect(tankOf(result.state, 'p1').inventory[CHEAP.id]).toBe(CHEAP.packSize * 3);
    expect(result.ownedAfter).toBe(CHEAP.packSize * 3);
  });

  it('accumulates across repeat purchases of the same weapon', () => {
    let state = shoppingState();
    const before = tankOf(state, 'p1').money;
    state = buy(state, 'p1', CHEAP.id, 1).state;
    state = buy(state, 'p1', CHEAP.id, 2).state;

    expect(tankOf(state, 'p1').inventory[CHEAP.id]).toBe(CHEAP.packSize * 3);
    expect(tankOf(state, 'p1').money).toBe(before - CHEAP.price * 3);
  });

  it('leaves the caller state untouched', () => {
    const state = shoppingState();
    const before = hashGameState(state);
    buy(state, 'p1', CHEAP.id, 2);
    expect(hashGameState(state)).toBe(before);
  });

  it('buys every weapon in the arsenal for the documented price', () => {
    for (const weapon of FOR_SALE) {
      const state = shoppingState();
      const result = buy(state, 'p1', weapon.id, 1);
      expect(result.spent).toBe(weapon.price);
      expect(tankOf(result.state, 'p1').inventory[weapon.id]).toBe(weapon.packSize);
    }
  });
});

// ---------------------------------------------------------------------------
// Insufficient funds — refused, not clamped
// ---------------------------------------------------------------------------

describe('affordability', () => {
  it('refuses a purchase one coin short and changes nothing', () => {
    const state = shoppingState(5, MID.price - 1);
    const before = hashGameState(state);

    expectRefusal(() => buy(state, 'p1', MID.id, 1), 'insufficient_funds', /cannot afford/i);
    expect(hashGameState(state)).toBe(before);
    expect(tankOf(state, 'p1').money).toBe(MID.price - 1);
    expect(tankOf(state, 'p1').inventory[MID.id]).toBeUndefined();
  });

  it('refuses the whole order rather than selling what the player can pay for', () => {
    // Enough for two packs, asking for three: a clamping shop would sell two.
    const state = shoppingState(5, CHEAP.price * 2);
    expectRefusal(() => buy(state, 'p1', CHEAP.id, 3), 'insufficient_funds', /cannot afford/i);
    expect(tankOf(state, 'p1').inventory[CHEAP.id]).toBeUndefined();

    const ok = buy(state, 'p1', CHEAP.id, 2);
    expect(ok.moneyAfter).toBe(0);
  });

  it('lets a player spend down to exactly zero', () => {
    const state = shoppingState(5, MID.price);
    const result = buy(state, 'p1', MID.id, 1);
    expect(result.moneyAfter).toBe(0);
    expect(tankOf(result.state, 'p1').money).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Which refusal, and why that one
// ---------------------------------------------------------------------------

describe('why a purchase was refused', () => {
  it('says "not in the armoury", not "cannot afford", for a locked weapon', () => {
    // The one state that tells the two apart: broke AND locked out. If
    // affordability were checked first this player would be told to go and earn
    // 30000, which they can do — and the shop would still refuse them, because
    // money was never the obstacle.
    const broke = shoppingState(1, 0);
    expectRefusal(() => buy(broke, 'p1', TOP.id, 1), 'not_for_sale', /not in the armoury/i);

    // Same weapon, same empty wallet, one round later: now money IS the answer.
    const unlocked = shoppingState(2, 0);
    expectRefusal(() => buy(unlocked, 'p1', TOP.id, 1), 'insufficient_funds', /cannot afford/i);
  });

  it('checks the quantity before the wallet, so a bad ask is never "too expensive"', () => {
    const state = shoppingState(5, 0);
    expectRefusal(() => buy(state, 'p1', CHEAP.id, -5), 'bad_quantity', /whole number/i);
  });

  it('checks the shop hours before anything else', () => {
    // Every other thing about this request is also wrong. A closed shop still
    // says so first: there is nothing to discuss until it opens.
    const shut: GameState = { ...shoppingState(1, 0), phase: 'gameover' };
    expectRefusal(() => buy(shut, 'nobody', 'death_star', -1), 'wrong_phase', /shop is closed/i);
  });

  it('checks the weapon exists before the price of it', () => {
    const broke = shoppingState(5, 0);
    expectRefusal(() => buy(broke, 'p1', 'death_star', 99), 'unknown_weapon', /unknown weapon/i);
  });
});

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

describe('shop hours', () => {
  const CLOSED: GamePhase[] = ['aiming', 'resolving', 'gameover'];

  it.each(CLOSED)('refuses to trade during the %s phase', (phase) => {
    const state: GameState = { ...shoppingState(), phase };
    expectRefusal(() => buy(state, 'p1', CHEAP.id), 'wrong_phase', /shop is closed/i);
    expectRefusal(() => sell(state, 'p1', CHEAP.id), 'wrong_phase', /shop is closed/i);
    expectRefusal(() => leaveShop(state, 'p1'), 'wrong_phase', /shop is closed/i);
  });

  it('trades during the shopping intermission', () => {
    const state = shoppingState();
    expect(() => buy(state, 'p1', CHEAP.id)).not.toThrow();
  });

  it('trades in the pre-match armoury, which nothing opens yet', () => {
    // `lobby` is a hook for buying before round 1. No code path produces it
    // today; the rules for it are the same rules, so they are asserted here
    // rather than left to be discovered when someone wires it up.
    const state: GameState = { ...shoppingState(1), phase: 'lobby', round: 1 };
    expect(roundsFought(state)).toBe(0);
    expect(() => buy(state, 'p1', CHEAP.id)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The free weapon
// ---------------------------------------------------------------------------

describe('the free weapon', () => {
  it('is never on the shelf', () => {
    const items = shopInventory(tankOf(shoppingState(), 'p1'), 9);
    expect(items.some((item) => item.weapon.id === BABY_MISSILE)).toBe(false);
    expect(items).toHaveLength(FOR_SALE.length);
  });

  it('cannot be bought at any quantity, in any phase the shop is open', () => {
    for (const phase of ['shopping', 'lobby'] as const) {
      const state: GameState = { ...shoppingState(), phase };
      for (const quantity of [1, 2, MAX_PURCHASE_QUANTITY]) {
        expectRefusal(
          () => buy(state, 'p1', BABY_MISSILE, quantity),
          'not_for_sale',
          /free and unlimited/i,
        );
      }
    }
  });

  it('cannot be sold, even by a player who somehow holds a stack of them', () => {
    const state = shoppingState();
    const stacked: GameState = {
      ...state,
      tanks: state.tanks.map((tank) => ({ ...tank, inventory: { [BABY_MISSILE]: 100 } })),
    };
    expectRefusal(() => sell(stacked, 'p1', BABY_MISSILE), 'not_for_sale', /cannot be sold/i);
    expect(tankOf(stacked, 'p1').money).toBe(100000);
  });
});

// ---------------------------------------------------------------------------
// Selling
// ---------------------------------------------------------------------------

describe('selling', () => {
  it('refunds exactly half the pack price, rounded down', () => {
    for (const weapon of FOR_SALE) {
      expect(refundForPack(weapon)).toBe(Math.floor(weapon.price / 2));
      expect(refundForPack(weapon)).toBeLessThan(weapon.price);
    }
  });

  it('returns the pack and credits the refund', () => {
    const start = shoppingState();
    const bought = buy(start, 'p1', MID.id, 2).state;
    const result = sell(bought, 'p1', MID.id, 1);

    expect(result.spent).toBe(-refundForPack(MID));
    expect(result.moneyAfter).toBe(tankOf(bought, 'p1').money + refundForPack(MID));
    expect(tankOf(result.state, 'p1').inventory[MID.id]).toBe(MID.packSize);
  });

  it('drops the weapon from the inventory when the last pack goes', () => {
    const start = shoppingState();
    const bought = buy(start, 'p1', MID.id, 1).state;
    const withSelection: GameState = {
      ...bought,
      tanks: bought.tanks.map((tank) =>
        tank.id === 'p1' ? { ...tank, selectedWeapon: MID.id } : tank,
      ),
    };

    const sold = sell(withSelection, 'p1', MID.id, 1).state;
    expect(tankOf(sold, 'p1').inventory[MID.id]).toBeUndefined();
    expect(tankOf(sold, 'p1').selectedWeapon).toBe(BABY_MISSILE);
  });

  it('refuses to sell a partial pack', () => {
    const start = shoppingState();
    const bought = buy(start, 'p1', CHEAP.id, 1).state;
    const partial: GameState = {
      ...bought,
      tanks: bought.tanks.map((tank) =>
        tank.id === 'p1' ? { ...tank, inventory: { [CHEAP.id]: CHEAP.packSize - 1 } } : tank,
      ),
    };
    expectRefusal(() => sell(partial, 'p1', CHEAP.id), 'nothing_to_sell', /do not have/i);
  });

  it('refuses to sell more packs than are held, and changes nothing', () => {
    const start = shoppingState();
    const bought = buy(start, 'p1', CHEAP.id, 2).state;
    const before = hashGameState(bought);
    expectRefusal(() => sell(bought, 'p1', CHEAP.id, 3), 'nothing_to_sell', /do not have/i);
    expect(hashGameState(bought)).toBe(before);
  });

  it('cannot manufacture money: one buy/sell round trip always loses', () => {
    for (const weapon of FOR_SALE) {
      const state = shoppingState();
      const before = tankOf(state, 'p1').money;
      const after = sell(buy(state, 'p1', weapon.id, 1).state, 'p1', weapon.id, 1).state;
      expect(tankOf(after, 'p1').money).toBeLessThan(before);
      expect(before - tankOf(after, 'p1').money).toBe(weapon.price - refundForPack(weapon));
      expect(tankOf(after, 'p1').inventory[weapon.id]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Quantity validation
// ---------------------------------------------------------------------------

describe('quantity', () => {
  const BAD: [string, number][] = [
    ['zero', 0],
    ['negative', -1],
    ['very negative', -1000],
    ['fractional', 1.5],
    ['just over a whole pack', 1.0000001],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['one past the cap', MAX_PURCHASE_QUANTITY + 1],
    ['absurd', 1e9],
    ['beyond double precision', Number.MAX_SAFE_INTEGER],
  ];

  it.each(BAD)('rejects a %s quantity on buy', (_label, quantity) => {
    const state = shoppingState();
    const before = hashGameState(state);
    expectRefusal(() => buy(state, 'p1', CHEAP.id, quantity), 'bad_quantity', /whole number/i);
    expect(hashGameState(state)).toBe(before);
  });

  it.each(BAD)('rejects a %s quantity on sell', (_label, quantity) => {
    const state = buy(shoppingState(), 'p1', CHEAP.id, 5).state;
    const before = hashGameState(state);
    expectRefusal(() => sell(state, 'p1', CHEAP.id, quantity), 'bad_quantity', /whole number/i);
    expect(hashGameState(state)).toBe(before);
  });

  it('accepts the boundary quantities', () => {
    const state = shoppingState(5, CHEAP.price * MAX_PURCHASE_QUANTITY);
    expect(buy(state, 'p1', CHEAP.id, 1).spent).toBe(CHEAP.price);
    expect(buy(state, 'p1', CHEAP.id, MAX_PURCHASE_QUANTITY).moneyAfter).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Player isolation
// ---------------------------------------------------------------------------

describe('player isolation', () => {
  it('touches only the buyer', () => {
    const state = shoppingState();
    const others = state.tanks.filter((tank) => tank.id !== 'p1');

    const after = buy(state, 'p1', TOP.id, 1).state;

    for (const before of others) {
      const now = tankOf(after, before.id);
      expect(now.money).toBe(before.money);
      expect(now.inventory).toEqual(before.inventory);
      expect(now.selectedWeapon).toBe(before.selectedWeapon);
    }
  });

  it('keeps three wallets independent through a full shopping session', () => {
    let state = shoppingState(5, 20000);
    state = buy(state, 'p1', CHEAP.id, 2).state;
    state = buy(state, 'p2', MID.id, 1).state;
    state = buy(state, 'p3', CHEAP.id, 1).state;
    state = sell(state, 'p1', CHEAP.id, 1).state;

    expect(tankOf(state, 'p1').money).toBe(20000 - CHEAP.price * 2 + refundForPack(CHEAP));
    expect(tankOf(state, 'p2').money).toBe(20000 - MID.price);
    expect(tankOf(state, 'p3').money).toBe(20000 - CHEAP.price);

    expect(tankOf(state, 'p1').inventory).toEqual({ [CHEAP.id]: CHEAP.packSize });
    expect(tankOf(state, 'p2').inventory).toEqual({ [MID.id]: MID.packSize });
    expect(tankOf(state, 'p3').inventory).toEqual({ [CHEAP.id]: CHEAP.packSize });
  });

  it("does not let one player sell another player's stock", () => {
    const state = buy(shoppingState(), 'p1', MID.id, 1).state;
    expectRefusal(() => sell(state, 'p2', MID.id), 'nothing_to_sell', /do not have/i);
  });
});

// ---------------------------------------------------------------------------
// Closing the shop
// ---------------------------------------------------------------------------

describe('closing time', () => {
  it('stays open until the last player leaves', () => {
    let state = shoppingState();
    expect(state.pendingShoppers).toEqual(['p1', 'p2', 'p3']);
    expect(everyoneHasShopped(state)).toBe(false);

    state = leaveShop(state, 'p2');
    expect(everyoneHasShopped(state)).toBe(false);
    state = leaveShop(state, 'p1');
    expect(everyoneHasShopped(state)).toBe(false);
    state = leaveShop(state, 'p3');
    expect(everyoneHasShopped(state)).toBe(true);
  });

  it('ignores a player leaving twice', () => {
    let state = shoppingState();
    state = leaveShop(state, 'p1');
    state = leaveShop(state, 'p1');
    expect(state.pendingShoppers).toEqual(['p2', 'p3']);
    expect(everyoneHasShopped(state)).toBe(false);
  });

  it('is never closed outside the intermission', () => {
    for (const phase of ['lobby', 'aiming', 'resolving', 'gameover'] as const) {
      const state: GameState = { ...shoppingState(), phase, pendingShoppers: [] };
      expect(everyoneHasShopped(state)).toBe(false);
    }
  });

  it('keeps a knocked-out player in the shop — the dead still spend', () => {
    const base = shoppingState();
    const state: GameState = {
      ...base,
      tanks: base.tanks.map((tank) =>
        tank.id === 'p3' ? { ...tank, alive: false, health: 0 } : tank,
      ),
    };
    expect(state.pendingShoppers).toContain('p3');
    expect(() => buy(state, 'p3', CHEAP.id)).not.toThrow();
    expect(everyoneHasShopped(leaveShop(leaveShop(state, 'p1'), 'p2'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Arms level
// ---------------------------------------------------------------------------

describe('arms level', () => {
  it('gates tier 4 and nothing else', () => {
    for (const weapon of FOR_SALE) {
      expect(unlockRoundFor(weapon)).toBe(weapon.tier >= 4 ? 2 : 0);
      expect(isOnTheShelf(weapon, 0)).toBe(weapon.tier < 4);
    }
    // A tier nobody has invented yet inherits the strictest gate rather than
    // falling through to "on sale".
    expect(unlockRoundFor({ ...TOP, tier: 99 })).toBe(2);
  });

  it("holds the Death's Head back until two rounds have been fought", () => {
    expect(unlockRoundFor(TOP)).toBe(2);
    const early = shoppingState(1, 100000);
    expectRefusal(() => buy(early, 'p1', TOP.id, 1), 'not_for_sale', /not in the armoury/i);
    expect(tankOf(early, 'p1').inventory[TOP.id]).toBeUndefined();

    const later = shoppingState(2, 100000);
    expect(() => buy(later, 'p1', TOP.id, 1)).not.toThrow();
  });

  it('is the reason a three-kill opening round cannot buy one', () => {
    // The whole justification for the gate, measured: a survivor with three
    // kills really does reach the shop with more than 30000 after one round.
    const perKill = DEFAULT_WORLD.maxHealth * DEFAULT_WORLD.damageBounty + DEFAULT_WORLD.killBounty;
    const bankroll = DEFAULT_WORLD.startingMoney + perKill * 3 + DEFAULT_WORLD.survivalBonus;
    expect(bankroll).toBe(33000);
    expect(bankroll).toBeGreaterThanOrEqual(TOP.price);

    const firstShop = shoppingState(1, bankroll);
    expectRefusal(() => buy(firstShop, 'p1', TOP.id, 1), 'not_for_sale', /not in the armoury/i);
  });

  it('never binds on a duel, because the price gets there first', () => {
    // A duel winner who spends nothing: bankroll at each shop.
    const perRound =
      DEFAULT_WORLD.maxHealth * DEFAULT_WORLD.damageBounty +
      DEFAULT_WORLD.killBounty +
      DEFAULT_WORLD.survivalBonus;
    let bank = DEFAULT_WORLD.startingMoney;
    let firstShopThatCouldPay = 0;
    for (let shop = 1; shop <= 5; shop += 1) {
      bank += perRound;
      if (firstShopThatCouldPay === 0 && bank >= TOP.price) firstShopThatCouldPay = shop;
    }
    expect(firstShopThatCouldPay).toBe(3);
    // …and the gate opened at shop 2. Money is the binding constraint, not the shelf.
    expect(unlockRoundFor(TOP)).toBeLessThan(firstShopThatCouldPay);
  });

  it('leaves the rest of the shelf to the price ladder', () => {
    // Why there is no tier 3 gate: the dearest thing below tier 4 is a Nuke,
    // and one clean round already pays for it, so a gate there would only be
    // taking away a decision the money has already made.
    const belowTop = FOR_SALE.filter((weapon) => weapon.tier < 4);
    const dearest = belowTop.reduce((a, b) => (b.price > a.price ? b : a));
    expect(dearest.id).toBe('nuke');
    expect(dearest.price).toBe(12000);

    const perRound =
      DEFAULT_WORLD.maxHealth * DEFAULT_WORLD.damageBounty +
      DEFAULT_WORLD.killBounty +
      DEFAULT_WORLD.survivalBonus;
    expect(DEFAULT_WORLD.startingMoney + perRound).toBeGreaterThanOrEqual(dearest.price);
  });

  it('says plainly what an ungated tier 3 would mean in a pre-match armoury', () => {
    // The gate that was removed could only ever have fired here, in the `lobby`
    // shop nothing opens yet. This is the consequence, pinned so that whoever
    // wires that shop up sees the numbers instead of discovering them: an
    // opening bank reaches four of the five tier 3 weapons and no further.
    const armoury: GameState = {
      ...shoppingState(1, DEFAULT_WORLD.startingMoney),
      phase: 'lobby',
      round: 1,
    };
    expect(roundsFought(armoury)).toBe(0);

    const tierThree = FOR_SALE.filter((weapon) => weapon.tier === 3);
    const reachable = tierThree.filter(
      (weapon) => isOnTheShelf(weapon, 0) && weapon.price <= DEFAULT_WORLD.startingMoney,
    );
    expect(tierThree).toHaveLength(5);
    expect(reachable.map((weapon) => weapon.price).sort((a, b) => a - b)).toEqual([
      8000, 8000, 9000, 9000,
    ]);
    // The Nuke is the one it does not reach, on price alone.
    expect(requireWeapon('nuke').price).toBeGreaterThan(DEFAULT_WORLD.startingMoney);

    // Most of the opening bank for one weapon is a decision, not a doomsday
    // button — and the doomsday button is still two rounds away.
    expectRefusal(() => buy(armoury, 'p1', TOP.id, 1), 'not_for_sale', /not in the armoury/i);
  });

  it('reports locked items in the inventory instead of hiding them', () => {
    const tank = tankOf(shoppingState(1, 100000), 'p1');
    const items = shopInventory(tank, 1);
    expect(items).toHaveLength(FOR_SALE.length);

    const top = items.find((item) => item.weapon.id === TOP.id);
    expect(top?.unlocked).toBe(false);
    expect(top?.affordable).toBe(true);
    expect(top?.maxQuantity).toBe(0);
  });

  it('counts rounds fought correctly in every phase', () => {
    const base = shoppingState(3);
    expect(roundsFought({ ...base, phase: 'shopping' })).toBe(3);
    expect(roundsFought({ ...base, phase: 'gameover' })).toBe(3);
    expect(roundsFought({ ...base, phase: 'aiming' })).toBe(2);
    expect(roundsFought({ ...base, phase: 'resolving' })).toBe(2);
    expect(roundsFought({ ...base, phase: 'lobby', round: 1 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The shop window
// ---------------------------------------------------------------------------

describe('shop inventory', () => {
  it('sorts cheapest tier first, and prices per shot', () => {
    const items = shopInventory(tankOf(shoppingState(), 'p1'), 9);
    for (let i = 1; i < items.length; i += 1) {
      const previous = items[i - 1] as (typeof items)[number];
      const current = items[i] as (typeof items)[number];
      expect(
        current.weapon.tier > previous.weapon.tier ||
          (current.weapon.tier === previous.weapon.tier &&
            current.weapon.price >= previous.weapon.price),
      ).toBe(true);
      expect(current.pricePerShot).toBe(current.weapon.price / current.weapon.packSize);
    }
  });

  it('shows what the player already owns', () => {
    const state = buy(shoppingState(), 'p1', CHEAP.id, 2).state;
    const item = shopInventory(tankOf(state, 'p1'), 9).find(
      (candidate) => candidate.weapon.id === CHEAP.id,
    );
    expect(item?.owned).toBe(CHEAP.packSize * 2);
  });

  it('agrees with what buy will actually allow, and about why', () => {
    // The window and the rules must never disagree: a row the shop draws as
    // buyable has to be buyable, a greyed-out row has to be refused, and the
    // refusal has to name the same obstacle the row is greyed out for.
    let lockedAndBroke = 0;
    for (const bankroll of [0, 1200, 11200, 19000, 33000]) {
      for (const round of [1, 2, 3]) {
        const state = shoppingState(round, bankroll);
        for (const item of shopInventory(tankOf(state, 'p1'), roundsFought(state))) {
          if (item.unlocked && item.affordable) {
            expect(() => buy(state, 'p1', item.weapon.id, 1)).not.toThrow();
          } else {
            // Locked beats broke, both in the window and in the answer.
            const expected = item.unlocked ? /cannot afford/i : /not in the armoury/i;
            const code = item.unlocked ? 'insufficient_funds' : 'not_for_sale';
            expectRefusal(() => buy(state, 'p1', item.weapon.id, 1), code, expected);
            if (!item.unlocked && !item.affordable) lockedAndBroke += 1;
          }
        }
        for (const item of shopInventory(tankOf(state, 'p1'), roundsFought(state))) {
          expect(item.maxQuantity).toBe(
            item.unlocked
              ? Math.min(MAX_PURCHASE_QUANTITY, Math.floor(bankroll / item.weapon.price))
              : 0,
          );
        }
      }
    }
    // The sweep is only evidence for "availability first" if it visits the
    // state where the two answers differ: locked AND unaffordable. That is the
    // Death's Head at round 1, at each of the four bankrolls below its 30000
    // price — four visits out of the sixty rows the sweep walks.
    expect(lockedAndBroke).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Properties (TECH_STACK.md: "Property-based | fast-check")
// ---------------------------------------------------------------------------

describe('property: no sequence of trades can create money', () => {
  /**
   * Money plus stock at cost is the quantity that must never grow.
   *
   * The bankroll is deliberately far larger than anything the income model
   * produces. This property is about arithmetic, not balance: at a realistic
   * 19000 a random walk goes broke in a handful of steps and then tests nothing
   * but the rejection paths, which is how the previous version of this file
   * ended up with 1500 steps and 58 completed trades. The balance claims are
   * measured further down, at bankrolls a player really arrives with.
   */
  const START = 250000;

  it('holds for every generated buy/sell sequence, and the sequences trade', () => {
    let buys = 0;
    let sells = 0;
    let refusals = 0;

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            sell: fc.boolean(),
            pick: fc.nat({ max: 1000 }),
            quantity: fc.integer({ min: 1, max: 3 }),
          }),
          { minLength: 1, maxLength: 24 },
        ),
        (trades) => {
          let state = shoppingState(5, START);

          for (const trade of trades) {
            const tank = tankOf(state, 'p1');
            const owned = Object.keys(tank.inventory);
            // A sale aims at something the player actually holds when there is
            // anything to hold: a walk that only ever sells at random ends up
            // asserting `nothing_to_sell` a few hundred times and the invariant
            // never once.
            const weaponId =
              trade.sell && owned.length > 0
                ? (owned[trade.pick % owned.length] as string)
                : (FOR_SALE[trade.pick % FOR_SALE.length] as WeaponDef).id;
            const worthBefore = netWorth(tank);

            // The try covers the call and nothing else. An assertion that lived
            // inside it would be caught by the catch and re-reported as "not an
            // IllegalMoveError", which hides the counterexample fast-check just
            // spent its shrinking budget finding.
            let executed = true;
            try {
              state = trade.sell
                ? sell(state, 'p1', weaponId, trade.quantity).state
                : buy(state, 'p1', weaponId, trade.quantity).state;
            } catch (error) {
              expect(error).toBeInstanceOf(IllegalMoveError);
              executed = false;
            }

            const worthAfter = netWorth(tankOf(state, 'p1'));
            if (!executed) {
              refusals += 1;
              // A refused trade is a no-op, not a partial one.
              expect(worthAfter).toBe(worthBefore);
            } else if (trade.sell) {
              sells += 1;
              // Half back, rounded down: a sale is always a loss. This is the
              // assertion that dies if SELL_REFUND_DIVISOR ever reaches 1.
              expect(worthAfter).toBeLessThan(worthBefore);
            } else {
              buys += 1;
              // A purchase moves money into stock at cost. Nothing is lost and
              // nothing is gained, so net worth is unchanged to the coin.
              expect(worthAfter).toBe(worthBefore);
            }

            expect(worthAfter).toBeLessThanOrEqual(START);
            expect(tankOf(state, 'p1').money).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 200 },
    );

    // Floors, not fixtures: fast-check reseeds every run. Four runs while this
    // was written landed 587-663 completed buys, 226-242 completed sells and
    // 357-380 refusals, so these bounds have room — and a change that quietly
    // turned the walk into no-ops (the failure this file already had once)
    // fails here instead of passing silently.
    expect(buys).toBeGreaterThan(400);
    expect(sells).toBeGreaterThan(150);
    expect(refusals).toBeGreaterThan(200);
  });

  it('holds across a long seeded soak on one wallet', () => {
    // The property above generates short sequences; this one runs a single
    // wallet through hundreds of consecutive trades and checks the books
    // balance at the end, to the coin.
    const rng = makeRng('shop-soak');
    const START_SOAK = 500000;
    let state = shoppingState(5, START_SOAK);
    let buys = 0;
    let sells = 0;
    let lost = 0;

    for (let step = 0; step < 400; step += 1) {
      const tank = tankOf(state, 'p1');
      const owned = Object.keys(tank.inventory);
      if (owned.length > 0 && rng.chance(0.5)) {
        const weapon = requireWeapon(rng.pick(owned));
        state = sell(state, 'p1', weapon.id, 1).state;
        lost += weapon.price - refundForPack(weapon);
        sells += 1;
      } else {
        const affordable = FOR_SALE.filter((weapon) => weapon.price <= tank.money);
        if (affordable.length === 0) continue;
        state = buy(state, 'p1', rng.pick(affordable).id, 1).state;
        buys += 1;
      }
      expect(netWorth(tankOf(state, 'p1'))).toBe(START_SOAK - lost);
    }

    // Measured on this seed: 199 buys, 194 sells, 7 steps where nothing on the
    // shelf was affordable any more, ending on a net worth of 7250.
    expect(buys).toBe(199);
    expect(sells).toBe(194);
    expect(lost).toBeGreaterThan(0);
    expect(netWorth(tankOf(state, 'p1'))).toBe(7250);
  });
});

describe('property: a purchase is refused for exactly the documented reason', () => {
  it('matches the cascade on every generated request, and most requests trade', () => {
    let bought = 0;
    let lockedAndBroke = 0;
    const refusals = new Map<ShopErrorCode, number>();

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60000 }),
        fc.integer({ min: 1, max: 3 }),
        // Mostly real merchandise, sometimes the free weapon or a made-up id.
        // The gated weapon gets its own weight on purpose: locked-AND-broke is
        // the state that tells "not in the armoury" apart from "cannot afford",
        // and drawn uniformly it is one request in three hundred — too rare for
        // this property to be the thing that catches a reordering.
        fc.oneof(
          { arbitrary: fc.constantFrom(...FOR_SALE.map((weapon) => weapon.id)), weight: 7 },
          { arbitrary: fc.constant(TOP.id), weight: 3 },
          { arbitrary: fc.constantFrom(BABY_MISSILE, 'death_star', ''), weight: 2 },
        ),
        // Mostly sane quantities. Weighted on purpose: an evenly hostile
        // generator spends four requests in five on `bad_quantity` and never
        // reaches the interesting part of the cascade.
        fc.oneof(
          { arbitrary: fc.integer({ min: 1, max: 5 }), weight: 8 },
          {
            arbitrary: fc.oneof(
              fc.integer({ min: -3, max: 105 }),
              fc.double({ noNaN: false }),
              fc.constantFrom(0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e9),
            ),
            weight: 2,
          },
        ),
        fc.oneof(
          { arbitrary: fc.constantFrom('p1', 'p2', 'p3'), weight: 9 },
          { arbitrary: fc.constantFrom('ghost', ''), weight: 1 },
        ),
        (money, round, weaponId, quantity, playerId) => {
          const state = shoppingState(round, money);
          const before = hashGameState(state);
          const predicted = predictBuy(state, playerId, weaponId, quantity);

          const weaponAsked = getWeapon(weaponId);
          if (
            weaponAsked !== undefined &&
            !isOnTheShelf(weaponAsked, roundsFought(state)) &&
            money < weaponAsked.price * quantity
          ) {
            lockedAndBroke += 1;
          }

          if (predicted === null) {
            const weapon = requireWeapon(weaponId);
            const result = buy(state, playerId, weaponId, quantity);
            bought += 1;
            expect(result.spent).toBe(weapon.price * quantity);
            expect(result.moneyAfter).toBe(money - weapon.price * quantity);
            expect(result.moneyAfter).toBeGreaterThanOrEqual(0);
            expect(result.ownedAfter).toBe(weapon.packSize * quantity);
            expect(tankOf(result.state, playerId).inventory[weaponId]).toBe(result.ownedAfter);
          } else {
            const error = rejection(() => buy(state, playerId, weaponId, quantity));
            expect(error.code).toBe(predicted);
            expect(error.message).not.toBe('');
            refusals.set(predicted, (refusals.get(predicted) ?? 0) + 1);
          }
          // Refused or not, the caller's state is never touched.
          expect(hashGameState(state)).toBe(before);
        },
      ),
      { numRuns: 500 },
    );

    // Floors, not fixtures — fast-check reseeds on every run. Three runs while
    // this was written landed 141-152 completed purchases, 32-45 visits to the
    // locked-and-broke state, and every reachable refusal dozens of times over:
    // insufficient_funds 139-154, bad_quantity 62-76, not_for_sale 53-65,
    // unknown_weapon 36-63, unknown_player 25-33. The floors sit well under
    // those so a reseed cannot flake, and well over zero so a generator that
    // stopped producing real purchases — or stopped visiting the state where
    // two refusals disagree — fails instead of passing as 500 no-ops.
    expect(bought).toBeGreaterThan(100);
    expect(lockedAndBroke).toBeGreaterThan(20);
    // Two codes are out of this generator's reach by construction:
    // `wrong_phase`, because every state it builds is an open shop, and
    // `nothing_to_sell`, which only `sell` can produce. Both are covered by the
    // REFUSALS table above.
    const OUT_OF_REACH: ShopErrorCode[] = ['wrong_phase', 'nothing_to_sell'];
    for (const code of SHOP_ERROR_CODES) {
      if (OUT_OF_REACH.includes(code)) continue;
      expect(refusals.get(code) ?? 0).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// Balance — the measurements the economy.ts header cites
// ---------------------------------------------------------------------------

describe('what a round pays', () => {
  it('pays damage, the kill and survival — and nothing for overkill', () => {
    // Two tanks stacked on one spot: the shell hits the second tank's circle at
    // the muzzle, so this is a scripted, deterministic kill through the real
    // fire → detonate → endRound path rather than an assertion about it.
    const base = createGame({ seed: 'PAYOUT:1', totalRounds: 3 }, [
      { id: 'p1', name: 'A' },
      { id: 'p2', name: 'B' },
    ]);
    const x = base.tanks[0]?.x ?? 0;
    const y = base.terrain.surface[x] ?? 0;
    const victimHealth = 15;
    const state: GameState = {
      ...base,
      tanks: base.tanks.map((tank, index) => ({
        ...tank,
        x,
        y,
        health: index === 0 ? DEFAULT_WORLD.maxHealth : victimHealth,
      })),
    };
    const before = tankOf(state, 'p1').money;

    const result = fire(state, 'p1', {
      turnNumber: state.turnNumber,
      angleDeg: 90,
      power: 1,
      weapon: BABY_MISSILE,
    });

    const victimDamage = result.events.filter(
      (event) => event.type === 'damage' && event.tankIndex === 1,
    );
    expect(result.events.some((event) => event.type === 'death')).toBe(true);
    expect(result.events.some((event) => event.type === 'roundEnd')).toBe(true);
    expect(result.state.phase).toBe('shopping');

    // The blast is worth more than 15 points, but a dead tank absorbs only the
    // health it had, so only that much is ever paid for.
    const paidFor = victimDamage.reduce(
      (total, event) => total + (event.type === 'damage' ? event.amount : 0),
      0,
    );
    expect(paidFor).toBe(victimHealth);

    const expected =
      victimHealth * DEFAULT_WORLD.damageBounty +
      DEFAULT_WORLD.killBounty +
      DEFAULT_WORLD.survivalBonus;
    expect(tankOf(result.state, 'p1').money - before).toBe(expected);
    expect(expected).toBe(7300);
  });

  it('makes a clean duel round worth 9000 against a 10000 bank', () => {
    const duelWin =
      DEFAULT_WORLD.maxHealth * DEFAULT_WORLD.damageBounty +
      DEFAULT_WORLD.killBounty +
      DEFAULT_WORLD.survivalBonus;
    expect(duelWin).toBe(9000);
    expect(DEFAULT_WORLD.startingMoney).toBe(10000);
    // The loser is paid for damage only — no survival bonus, no bounty.
    const duelLoss = 60 * DEFAULT_WORLD.damageBounty;
    expect(duelLoss).toBe(1200);

    // The spread the economy.ts header calls out: five rounds of one-way
    // traffic, neither player spending a coin.
    let ahead = DEFAULT_WORLD.startingMoney;
    let behind = DEFAULT_WORLD.startingMoney;
    for (let round = 0; round < 5; round += 1) {
      ahead += duelWin;
      behind += duelLoss;
    }
    expect([ahead, behind]).toEqual([55000, 16000]);
  });
});

describe('affordability sweep', () => {
  /** Bankrolls a real player actually arrives at the shop holding. */
  const BANKROLLS = {
    lostTheRound: 11200,
    wonTheRound: 19000,
    wonThreeKills: 33000,
  } as const;

  it('starts from bankrolls the income model really produces', () => {
    const world = DEFAULT_WORLD;
    const perKill = world.maxHealth * world.damageBounty + world.killBounty;

    expect(world.startingMoney + 60 * world.damageBounty).toBe(BANKROLLS.lostTheRound);
    expect(world.startingMoney + perKill + world.survivalBonus).toBe(BANKROLLS.wonTheRound);
    expect(world.startingMoney + perKill * 3 + world.survivalBonus).toBe(BANKROLLS.wonThreeKills);
  });

  it('opens the whole tier 1-2 shelf to the player who LOST the round', () => {
    const shelf = FOR_SALE.filter((weapon) => weapon.tier <= 2);
    expect(shelf.length).toBeGreaterThan(10);
    for (const weapon of shelf) {
      expect(weapon.price).toBeLessThanOrEqual(BANKROLLS.lostTheRound);
    }
    expect(Math.floor(BANKROLLS.lostTheRound / CHEAP.price)).toBe(6);
    const state = shoppingState(1, BANKROLLS.lostTheRound);
    for (const weapon of shelf) {
      expect(() => buy(state, 'p1', weapon.id, 1)).not.toThrow();
    }
  });

  it("puts a Nuke, or ten packs of Missiles, in the winner's hands", () => {
    const nuke = requireWeapon('nuke');
    expect(Math.floor(BANKROLLS.wonTheRound / nuke.price)).toBe(1);
    expect(Math.floor(BANKROLLS.wonTheRound / CHEAP.price)).toBe(10);
    expect(Math.floor(BANKROLLS.wonTheRound / MID.price)).toBe(3);
    expect(BANKROLLS.wonTheRound).toBeLessThan(TOP.price);

    const state = shoppingState(2, BANKROLLS.wonTheRound);
    const bought = buy(state, 'p1', nuke.id, 1);
    expect(bought.moneyAfter).toBe(BANKROLLS.wonTheRound - nuke.price);
    expectRefusal(() => buy(state, 'p1', TOP.id, 1), 'insufficient_funds', /cannot afford/i);
  });

  it('keeps the match-deciding weapons out of reach of a starting bank', () => {
    const decisive = FOR_SALE.filter((weapon) => weapon.tier >= 3 && weapon.packSize === 1);
    expect(decisive.map((weapon) => weapon.id).sort()).toEqual(['deaths_head', 'nuke']);
    for (const weapon of decisive) {
      expect(weapon.price).toBeGreaterThan(DEFAULT_WORLD.startingMoney);
    }
  });

  it('prices the whole arsenal at about thirteen winning rounds', () => {
    const oneOfEverything = FOR_SALE.reduce((total, weapon) => total + weapon.price, 0);
    expect(oneOfEverything).toBe(120200);

    const perWinningRound =
      DEFAULT_WORLD.maxHealth * DEFAULT_WORLD.damageBounty +
      DEFAULT_WORLD.killBounty +
      DEFAULT_WORLD.survivalBonus;
    expect(Math.round(oneOfEverything / perWinningRound)).toBe(13);
  });

  it('leaves no weapon either free or unbuyable', () => {
    // The two failure modes the balance claim has to rule out: something so
    // cheap it is never a decision, and something nobody can ever reach.
    const affordableAfterOneWin = FOR_SALE.filter(
      (weapon) => weapon.price <= BANKROLLS.wonTheRound,
    );
    expect(affordableAfterOneWin.length).toBeGreaterThan(FOR_SALE.length / 2);
    expect(affordableAfterOneWin.length).toBeLessThan(FOR_SALE.length);

    const perRound =
      DEFAULT_WORLD.maxHealth * DEFAULT_WORLD.damageBounty +
      DEFAULT_WORLD.killBounty +
      DEFAULT_WORLD.survivalBonus;
    for (const weapon of FOR_SALE) {
      // Nothing is small change against one round's takings…
      expect(weapon.price).toBeGreaterThan(perRound / 10);
      // …and nothing needs more than four clean rounds to afford.
      expect(weapon.price).toBeLessThanOrEqual(DEFAULT_WORLD.startingMoney + perRound * 3);
    }
  });
});
