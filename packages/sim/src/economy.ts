/**
 * The between-rounds shop.
 *
 * Money in, ammo out. Pure functions over `GameState` — the Durable Object
 * decides *when* the shop is open; this decides what a purchase is allowed to do.
 */

import { cloneState, IllegalMoveError, type GameState, type Tank } from './game.ts';
import { BABY_MISSILE, requireWeapon, WEAPONS, type WeaponDef, type WeaponId } from './weapons.ts';

export interface ShopItem {
  readonly weapon: WeaponDef;
  /** Rounds the player currently holds. */
  readonly owned: number;
  readonly affordable: boolean;
}

/** What the shop should show a given player right now. */
export function shopInventory(tank: Tank): ShopItem[] {
  return WEAPONS.filter((weapon) => weapon.id !== BABY_MISSILE)
    .slice()
    .sort((a, b) => a.tier - b.tier || a.price - b.price)
    .map((weapon) => ({
      weapon,
      owned: tank.inventory[weapon.id] ?? 0,
      affordable: tank.money >= weapon.price,
    }));
}

export interface PurchaseResult {
  state: GameState;
  weaponId: WeaponId;
  quantity: number;
  spent: number;
  moneyAfter: number;
}

/**
 * Buy `quantity` packs of a weapon. Rejects — rather than clamping — when the
 * player cannot afford it, so a desynced client learns it is wrong.
 */
export function buy(
  state: GameState,
  playerId: string,
  weaponId: WeaponId,
  quantity = 1,
): PurchaseResult {
  if (state.phase !== 'shopping' && state.phase !== 'lobby') {
    throw new IllegalMoveError('wrong_phase', 'The shop is closed');
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw new IllegalMoveError('bad_quantity', 'Quantity must be a whole number from 1 to 99');
  }

  let weapon: WeaponDef;
  try {
    weapon = requireWeapon(weaponId);
  } catch {
    throw new IllegalMoveError('unknown_weapon', `Unknown weapon: ${weaponId}`);
  }

  if (weapon.id === BABY_MISSILE) {
    throw new IllegalMoveError('not_for_sale', 'Baby Missiles are free and unlimited');
  }

  const index = state.tanks.findIndex((tank) => tank.id === playerId);
  if (index < 0) throw new IllegalMoveError('unknown_player', 'No such player in this game');

  const cost = weapon.price * quantity;
  const current = state.tanks[index] as Tank;
  if (current.money < cost) {
    throw new IllegalMoveError(
      'insufficient_funds',
      `You cannot afford ${quantity}x ${weapon.name}`,
    );
  }

  const next = cloneState(state);
  const tank = next.tanks[index] as Tank;
  tank.money -= cost;
  tank.inventory[weapon.id] = (tank.inventory[weapon.id] ?? 0) + weapon.packSize * quantity;

  return {
    state: next,
    weaponId: weapon.id,
    quantity,
    spent: cost,
    moneyAfter: tank.money,
  };
}

/**
 * Sell a pack back at half price. The original does not have this; it exists
 * so a player who misclicks a Nuke is not ruined for the rest of the match.
 */
export function sell(state: GameState, playerId: string, weaponId: WeaponId): PurchaseResult {
  if (state.phase !== 'shopping' && state.phase !== 'lobby') {
    throw new IllegalMoveError('wrong_phase', 'The shop is closed');
  }

  let weapon: WeaponDef;
  try {
    weapon = requireWeapon(weaponId);
  } catch {
    throw new IllegalMoveError('unknown_weapon', `Unknown weapon: ${weaponId}`);
  }
  if (weapon.id === BABY_MISSILE) {
    throw new IllegalMoveError('not_for_sale', 'Baby Missiles cannot be sold');
  }

  const index = state.tanks.findIndex((tank) => tank.id === playerId);
  if (index < 0) throw new IllegalMoveError('unknown_player', 'No such player in this game');

  const owned = (state.tanks[index] as Tank).inventory[weapon.id] ?? 0;
  if (owned < weapon.packSize) {
    throw new IllegalMoveError('nothing_to_sell', `You do not have a full pack of ${weapon.name}`);
  }

  const next = cloneState(state);
  const tank = next.tanks[index] as Tank;
  const refund = Math.floor(weapon.price / 2);
  tank.money += refund;
  const remaining = owned - weapon.packSize;
  if (remaining > 0) tank.inventory[weapon.id] = remaining;
  else delete tank.inventory[weapon.id];

  if (tank.selectedWeapon === weapon.id && remaining <= 0) {
    tank.selectedWeapon = BABY_MISSILE;
  }

  return {
    state: next,
    weaponId: weapon.id,
    quantity: -1,
    spent: -refund,
    moneyAfter: tank.money,
  };
}

/** Mark a player as done shopping. */
export function leaveShop(state: GameState, playerId: string): GameState {
  const next = cloneState(state);
  next.pendingShoppers = next.pendingShoppers.filter((id) => id !== playerId);
  return next;
}

export function everyoneHasShopped(state: GameState): boolean {
  return state.phase === 'shopping' && state.pendingShoppers.length === 0;
}
