/**
 * The between-rounds shop.
 *
 * Money in, ammo out. Pure functions over `GameState` — the Durable Object
 * decides *when* the shop is open; this decides what a purchase is allowed to
 * do. Every function returns a NEW state, so a rejected transaction leaves the
 * room byte-identical to how it was found.
 *
 * Nothing here clamps. A client that asks for more than the player can pay for,
 * a fractional quantity, or a weapon that is not on the shelf gets an
 * `IllegalMoveError` back — silently buying "as much as you could afford"
 * instead would leave a desynced client believing something false about its own
 * inventory, which is the one thing an authoritative server exists to prevent.
 *
 * ---------------------------------------------------------------------------
 * What a round's income actually buys (measured, not asserted)
 * ---------------------------------------------------------------------------
 *
 * The numbers below come from `test/economy.test.ts`, which reads
 * `DEFAULT_WORLD` and the live `WEAPONS` table rather than repeating them — so
 * if either moves, the test that produced these figures goes red instead of
 * this comment quietly becoming a lie.
 *
 * Income rules (game.ts): 20 per point of damage dealt to someone else, 5000
 * for the killing blow, 2000 for surviving the round. A scripted round in the
 * test suite — a real fire() through detonation and endRound, not an assertion
 * about them — pays a measured 7300 for killing a tank that had 15 health
 * left: the blast was worth more than 15 points, but overkill does not pay.
 * Winning a duel outright is therefore 100*20 + 5000 + 2000 = 9000, against a
 * starting bank of 10000.
 *
 * Against the arsenal, at the first shop (after one round):
 *
 *   bankroll   who                       what it buys
 *   11200      lost the round, dealt 60  any tier 1-2 item; 6 packs of Missiles
 *   19000      won the round             a Nuke (12000) with change, or 10
 *                                        packs of Missiles, or 3 Baby Nukes
 *   33000      won a 3-kill free-for-all a Death's Head, if it were on sale
 *
 * So the curve is in the right place at both ends: nothing is trivially
 * affordable (buying one pack of every weapon costs 120200, about thirteen
 * winning rounds), and nothing is out of reach forever (the whole tier 1-2
 * shelf is open to the round's *loser*). The two weapons that decide a match
 * have to be earned: a duel winner who never spends first reaches 30000 at the
 * third shop.
 *
 * The known soft spot is the spread, and it is not fixable from this file. A
 * duel winner banks 9000 a round and the loser 1200, so five rounds of one-way
 * traffic ends 55000 against 16000 — and there is no catch-up term anywhere in
 * the model, because `survivalBonus` pays only survivors and there is no
 * allowance. Interest would make it worse, not better: it pays the leader most.
 * A flat per-round allowance is the fix, and it belongs next to the other
 * bounties in `game.ts` — awarding it from the shop would mean the shop paying
 * players, which is not what a shop is.
 *
 * One more thing this file cannot fix: the shop only ever opens BETWEEN rounds.
 * Round 1 is fought entirely with the free Baby Missile while 10000 sits idle
 * in everyone's bank, because `createGame` goes straight to `aiming`. The
 * `lobby` branch of `isShopOpen` is the hook for a pre-match armoury; nothing
 * produces that phase yet.
 */

import { cloneState, IllegalMoveError, type GameState, type Tank } from './game.ts';
import {
  BABY_MISSILE,
  getWeapon,
  pricePerShot,
  WEAPONS,
  type WeaponDef,
  type WeaponId,
} from './weapons.ts';

/**
 * Every rejection code the shop can produce.
 *
 * These strings are wire vocabulary, not internal labels. `apps/server` maps a
 * sim code onto the protocol enum by safe-parsing it against
 * `ServerErrorCodeSchema` and falling back to `internal` when it does not
 * recognise it — so a code that drifts out of that enum does not throw and does
 * not fail a build. It quietly turns "You cannot afford 3x Baby Nuke" into
 * "Something went wrong handling that message", which is the worst of both: the
 * player is told nothing and nobody is told anything either.
 *
 * The sim must not import the protocol package, so the list lives here and is
 * pinned from both sides in `test/economy.test.ts`: every entry has to parse
 * under `ServerErrorCodeSchema`, and `reject()` below is the only way this file
 * throws, so a code that is not in this list is a compile error rather than a
 * silent downgrade at runtime.
 */
export const SHOP_ERROR_CODES = [
  'wrong_phase',
  'bad_quantity',
  'unknown_weapon',
  'not_for_sale',
  'insufficient_funds',
  'nothing_to_sell',
  'unknown_player',
] as const;

export type ShopErrorCode = (typeof SHOP_ERROR_CODES)[number];

/** The only throw site in this file. Typed, so a stray code cannot compile. */
function reject(code: ShopErrorCode, message: string): never {
  throw new IllegalMoveError(code, message);
}

/**
 * Most packs of one weapon a single transaction may move.
 *
 * Deliberately the same 99 the wire schema enforces (`ClientMessageSchema` in
 * @scorched/protocol). Duplicating the number is not ideal, but the sim must
 * not depend on the protocol package, and the sim has to be able to reject it
 * on its own — the wire cap protects the parser, this one protects the rules.
 */
export const MAX_PURCHASE_QUANTITY = 99;

/**
 * A sold pack refunds half its purchase price, rounded DOWN.
 *
 * Rounding down is what makes the shop safe to leave open: `floor(price / 2)`
 * is strictly less than `price` for every priced weapon in the table, so no
 * buy/sell cycle can end with more money than it started with, at any quantity
 * and in any order. Rounding up or to nearest would break that for an odd
 * price. `test/economy.test.ts` runs the loop over the whole arsenal, and a
 * fast-check property asserts the stronger form: every completed sale strictly
 * reduces money-plus-stock, whatever order the trades arrive in.
 *
 * Selling is an addition to a browse-and-buy shop, and it is here for exactly
 * one reason: one misclick on a 30000 Death's Head is three rounds of winnings,
 * and a shop that could end a match by misclick is a worse shop. Half back
 * keeps it a refund rather than a strategy — nobody trades their way anywhere
 * at that rate.
 */
export const SELL_REFUND_DIVISOR = 2;

/** Cash back for returning one pack. Always strictly less than the price paid. */
export function refundForPack(weapon: WeaponDef): number {
  return Math.floor(weapon.price / SELL_REFUND_DIVISOR);
}

/**
 * Arms level — how much of the arsenal is on the shelf yet.
 *
 * One gate, on tier 4 only, and it stands on a measurement rather than on
 * fidelity to anything. (An earlier draft of this comment claimed the 1991
 * original gates ordnance behind an arms level. That could not be checked from
 * here and is probably wrong — its armoury gates by price. A rules change does
 * not get to borrow authority it has not earned, so the argument below is the
 * only one.)
 *
 * The numbers come from `test/economy.test.ts`, computed from `DEFAULT_WORLD`
 * and the live price table. A round pays 20 per point of damage, 5000 for a
 * kill and 2000 for surviving, so a survivor with three kills in a four-player
 * free-for-all banks 23000 in one round — 33000 at the FIRST shop, against a
 * Death's Head at 30000. Ungated, one good opening hands somebody the weapon
 * that ends the match before anyone else has shopped twice. Two rounds fought
 * is the cheapest rule that stops that without touching a price.
 *
 * In a duel it never binds: the winner banks 9000 a round and does not reach
 * 30000 until the third shop, by which point the gate has been open since the
 * second. So the gate costs the common case nothing and only bites the outlier
 * it was written for.
 *
 * Nothing below tier 4 is gated. The dearest thing on the rest of the shelf is
 * a 12000 Nuke, which one clean round already pays for; a gate there would only
 * take away a decision the price ladder has already made. A previous version
 * gated tier 3 at one round fought — a rule that could never fire, because
 * every shop that exists today opens with at least one round behind it. A rule
 * whose stated purpose is to do nothing is not a rule, and it is gone.
 *
 * Removing it has exactly one consequence, and it is worth stating rather than
 * discovering: if the pre-match `lobby` armoury is ever opened, the 10000
 * starting bank reaches four of the five tier 3 weapons — the ones at 8000 and
 * 9000 — but not the 12000 Nuke. Spending most of an opening bank on one
 * weapon before a shot is fired is a decision, not a doomsday button, and the
 * Death's Head is still two rounds away. Those numbers are pinned in
 * `test/economy.test.ts` so whoever opens that shop sees them.
 */
const ROUNDS_FOUGHT_TO_UNLOCK_TIER: readonly number[] = [0, 0, 0, 0, 2];

/**
 * A tier past the end of the table is newer and rarer than anything in it, so
 * it inherits the strictest gate rather than falling through to "on sale".
 */
const STRICTEST_UNLOCK = Math.max(...ROUNDS_FOUGHT_TO_UNLOCK_TIER);

/** Rounds that must be behind a player before this weapon appears in the shop. */
export function unlockRoundFor(weapon: WeaponDef): number {
  return ROUNDS_FOUGHT_TO_UNLOCK_TIER[weapon.tier] ?? STRICTEST_UNLOCK;
}

/** Whether the arms level has reached this weapon. */
export function isOnTheShelf(weapon: WeaponDef, roundsFoughtCount: number): boolean {
  return roundsFoughtCount >= unlockRoundFor(weapon);
}

/**
 * How many rounds this match has actually played out.
 *
 * `state.round` is the round in progress, except in `shopping` and `gameover`
 * where it names the round that just finished — so the intermission after round
 * 1 reports 1, and a fresh game in `lobby` reports 0.
 */
export function roundsFought(state: GameState): number {
  return state.phase === 'shopping' || state.phase === 'gameover' ? state.round : state.round - 1;
}

export interface ShopItem {
  readonly weapon: WeaponDef;
  /** Rounds the player currently holds. */
  readonly owned: number;
  /** Whether one pack is affordable right now. Says nothing about the shelf. */
  readonly affordable: boolean;
  /** Whether the arms level has reached it. Says nothing about the wallet. */
  readonly unlocked: boolean;
  /** Packs this player could actually complete, respecting both of the above. */
  readonly maxQuantity: number;
  /** Cost of one round — the only fair way to compare a 10-pack with a single. */
  readonly pricePerShot: number;
}

/**
 * What the shop should show a given player right now, cheapest tier first.
 *
 * Locked and unaffordable items are still listed — greyed, never hidden. A shop
 * that dropped rows would get smaller every time a player lost a round, and the
 * price tag on the thing you cannot afford yet is the reason to go and win one.
 *
 * `roundsFoughtCount` defaults to 0 — the most restrictive shelf — so a caller
 * that forgets it shows too little rather than offering something the rules
 * would then refuse to sell.
 */
export function shopInventory(tank: Tank, roundsFoughtCount = 0): ShopItem[] {
  return WEAPONS.filter((weapon) => isForSale(weapon))
    .sort((a, b) => a.tier - b.tier || a.price - b.price)
    .map((weapon) => {
      const unlocked = isOnTheShelf(weapon, roundsFoughtCount);
      const affordable = tank.money >= weapon.price;
      return {
        weapon,
        owned: tank.inventory[weapon.id] ?? 0,
        affordable,
        unlocked,
        maxQuantity: unlocked
          ? Math.min(MAX_PURCHASE_QUANTITY, Math.floor(tank.money / weapon.price))
          : 0,
        pricePerShot: pricePerShot(weapon),
      };
    });
}

/**
 * Whether a weapon can be traded at all.
 *
 * Structural rather than a hardcoded id: anything free, or with a pack size
 * that is not a positive finite number, is a permanent fixture of the loadout
 * and not merchandise. Today that is exactly the Baby Missile.
 */
function isForSale(weapon: WeaponDef): boolean {
  return weapon.price > 0 && Number.isFinite(weapon.packSize) && weapon.packSize > 0;
}

/**
 * The two phases in which trading is legal.
 *
 * `shopping` is the between-rounds intermission. `lobby` is the pre-match
 * armoury — no code path currently puts a game in that phase, so it is a hook
 * rather than a feature, but the rules for it are the same rules and there is
 * no reason for them to differ.
 */
export function isShopOpen(state: GameState): boolean {
  return state.phase === 'shopping' || state.phase === 'lobby';
}

export interface PurchaseResult {
  state: GameState;
  weaponId: WeaponId;
  /** Packs bought, or negative packs sold. */
  quantity: number;
  /** Cash that left the wallet. Negative for a sale. */
  spent: number;
  moneyAfter: number;
  /** Rounds of this weapon the player holds afterwards. */
  ownedAfter: number;
}

/**
 * Buy `quantity` packs of a weapon.
 *
 * Order of checks is the order a player would want to be told about:
 *
 *   wrong_phase → bad_quantity → unknown_weapon → not_for_sale → unknown_player
 *   → insufficient_funds
 *
 * Availability deliberately comes before affordability. "Not in the armoury
 * yet" is the useful answer; "you cannot afford it" would be a lie about a
 * weapon nobody can buy at any price, and it would send a player off to earn
 * money that was never the obstacle. The distinguishing state is a broke player
 * asking for a locked weapon, and `test/economy.test.ts` constructs exactly
 * that and asserts the code — swapping these two blocks turns that test red.
 *
 * The checks that depend only on the request come before the one that depends
 * on the player, so the shop answers "is this on sale?" the same way whoever is
 * asking. An unknown player is refused either way.
 */
export function buy(
  state: GameState,
  playerId: string,
  weaponId: WeaponId,
  quantity = 1,
): PurchaseResult {
  requireOpenShop(state);
  requireQuantity(quantity);

  const weapon = lookUpWeapon(weaponId);
  if (!isForSale(weapon)) {
    reject('not_for_sale', `${weapon.name}s are free and unlimited`);
  }
  if (!isOnTheShelf(weapon, roundsFought(state))) {
    reject(
      'not_for_sale',
      `${weapon.name} is not in the armoury until ${unlockRoundFor(weapon)} rounds have been fought`,
    );
  }

  const index = requirePlayerIndex(state, playerId);
  const cost = weapon.price * quantity;
  if ((state.tanks[index] as Tank).money < cost) {
    reject('insufficient_funds', `You cannot afford ${quantity}x ${weapon.name}`);
  }

  const next = cloneState(state);
  const tank = next.tanks[index] as Tank;
  tank.money -= cost;
  const ownedAfter = (tank.inventory[weapon.id] ?? 0) + weapon.packSize * quantity;
  tank.inventory[weapon.id] = ownedAfter;

  return {
    state: next,
    weaponId: weapon.id,
    quantity,
    spent: cost,
    moneyAfter: tank.money,
    ownedAfter,
  };
}

/**
 * Sell `quantity` whole packs back at the refund rate.
 *
 * Whole packs only: a partial pack has no defined price, and letting one be
 * sold for a share of `refundForPack` is precisely how a rounding step turns
 * into a money printer.
 */
export function sell(
  state: GameState,
  playerId: string,
  weaponId: WeaponId,
  quantity = 1,
): PurchaseResult {
  requireOpenShop(state);
  requireQuantity(quantity);

  const weapon = lookUpWeapon(weaponId);
  if (!isForSale(weapon)) {
    reject('not_for_sale', `${weapon.name}s cannot be sold`);
  }

  const index = requirePlayerIndex(state, playerId);
  const owned = (state.tanks[index] as Tank).inventory[weapon.id] ?? 0;
  const rounds = weapon.packSize * quantity;
  if (owned < rounds) {
    reject('nothing_to_sell', `You do not have ${quantity} full pack(s) of ${weapon.name}`);
  }

  const next = cloneState(state);
  const tank = next.tanks[index] as Tank;
  const refund = refundForPack(weapon) * quantity;
  tank.money += refund;

  const remaining = owned - rounds;
  if (remaining > 0) tank.inventory[weapon.id] = remaining;
  else delete tank.inventory[weapon.id];

  // Selling the gun out from under the crosshair would otherwise leave the
  // player aiming something they cannot fire.
  if (tank.selectedWeapon === weapon.id && remaining <= 0) {
    tank.selectedWeapon = BABY_MISSILE;
  }

  return {
    state: next,
    weaponId: weapon.id,
    quantity: -quantity,
    spent: -refund,
    moneyAfter: tank.money,
    ownedAfter: remaining,
  };
}

/**
 * Mark a player as done shopping. Idempotent — a client that sends "done"
 * twice, or reconnects and sends it again, must not be an error.
 */
export function leaveShop(state: GameState, playerId: string): GameState {
  requireOpenShop(state);
  requirePlayerIndex(state, playerId);

  const next = cloneState(state);
  next.pendingShoppers = next.pendingShoppers.filter((id) => id !== playerId);
  return next;
}

/**
 * Whether the intermission is over. The caller starts the next round on `true`.
 *
 * Every tank is a pending shopper, including the ones that died — a player who
 * was knocked out still gets to spend the bounty their killer paid them, and
 * still has to press Done before the match moves on.
 */
export function everyoneHasShopped(state: GameState): boolean {
  return state.phase === 'shopping' && state.pendingShoppers.length === 0;
}

// ---------------------------------------------------------------------------
// Guards. Shared so buy and sell cannot drift apart.
// ---------------------------------------------------------------------------

function requireOpenShop(state: GameState): void {
  if (!isShopOpen(state)) {
    reject('wrong_phase', 'The shop is closed');
  }
}

/**
 * `Number.isInteger` is doing more work than it looks: it rejects NaN,
 * both infinities and every fractional value in one test, so 1.5 packs and
 * 1e309 packs fail here rather than becoming a NaN wallet further down.
 */
function requireQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PURCHASE_QUANTITY) {
    reject('bad_quantity', `Quantity must be a whole number from 1 to ${MAX_PURCHASE_QUANTITY}`);
  }
}

function lookUpWeapon(weaponId: WeaponId): WeaponDef {
  const weapon = getWeapon(weaponId);
  if (weapon === undefined) reject('unknown_weapon', `Unknown weapon: ${weaponId}`);
  return weapon;
}

function requirePlayerIndex(state: GameState, playerId: string): number {
  const index = state.tanks.findIndex((tank) => tank.id === playerId);
  if (index < 0) reject('unknown_player', 'No such player in this game');
  return index;
}
