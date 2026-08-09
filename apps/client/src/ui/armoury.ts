/**
 * The armoury — the between-rounds screen a player is supposed to spend time in.
 *
 * The whole arsenal is on the shelf at once: what it does, what it costs per
 * pack AND per shot, how many you hold, and whether you can afford it right now.
 * Nothing is hidden — a weapon you cannot afford is the reason to go and win a
 * round, so it is greyed rather than dropped.
 *
 * The shelf itself is computed by `shopInventory` from @scorched/sim: the same
 * module the Durable Object runs. This client does not decide what is on sale,
 * it asks the shared rules and draws the answer.
 */

import {
  BABY_MISSILE,
  refundForPack,
  requireWeapon,
  shopInventory,
  unlockRoundFor,
  type ShopItem,
  type Tank,
  type WeaponDef,
} from '@scorched/sim';
import type { GameSnapshot, TankSnapshot } from '@scorched/protocol';
import { el, must } from './dom.ts';
import { listNames, money } from './format.ts';

export interface ArmouryCallbacks {
  onBuy(weaponId: string): void;
  onSell(weaponId: string): void;
}

/** The live nodes of one weapon card, so a re-render patches instead of rebuilding. */
interface Row {
  readonly li: HTMLLIElement;
  readonly owned: HTMLElement;
  readonly buy: HTMLButtonElement | null;
  readonly sell: HTMLButtonElement | null;
}

export class ArmouryView {
  private readonly callbacks: ArmouryCallbacks;
  private readonly list = must<HTMLUListElement>('#shop-items');
  private readonly cash = must<HTMLElement>('#shop-money');
  private readonly waiting = must<HTMLElement>('#shop-waiting');
  private readonly rows = new Map<string, Row>();

  constructor(callbacks: ArmouryCallbacks) {
    this.callbacks = callbacks;
  }

  render(snapshot: GameSnapshot, you: string): void {
    const tank = snapshot.tanks.find((candidate) => candidate.id === you);
    if (tank === undefined) return;

    this.cash.textContent = money(tank.money);
    this.renderWaiting(snapshot, you);

    /*
     * How many rounds are behind this player, for the arms-level gate.
     *
     * `roundsFought()` in @scorched/sim is the authority, and it takes a full
     * `GameState` — which a wire snapshot is not. The armoury is only ever
     * shown in the `shopping` phase, and for that phase the sim's answer is
     * `round` unchanged, so this reads the same number rather than restating
     * the rule. Off-phase it errs low, which greys a tier-4 weapon out one
     * round early. The server adjudicates every purchase either way, so the
     * cost of being wrong here is a disabled button, never a wrong outcome.
     */
    const roundsFoughtCount = snapshot.phase === 'shopping' ? snapshot.round : snapshot.round - 1;
    const shelf = shopInventory(tank as Tank, Math.max(0, roundsFoughtCount));

    if (this.rows.size === 0) this.build(shelf);
    this.patch(shelf, tank);
  }

  /** Who else is still shopping — the reason the Ready button has not moved on. */
  private renderWaiting(snapshot: GameSnapshot, you: string): void {
    const others = snapshot.pendingShoppers.filter((id) => id !== you);
    const names = others.map(
      (id) => snapshot.tanks.find((tank) => tank.id === id)?.name ?? 'someone',
    );
    const youAreReady = !snapshot.pendingShoppers.includes(you);

    if (names.length === 0) {
      this.waiting.textContent = youAreReady ? 'Everyone is ready. Next round loading…' : '';
      return;
    }
    this.waiting.textContent = youAreReady
      ? `Waiting for ${listNames(names)} to finish shopping.`
      : `${listNames(names)} still shopping.`;
  }

  /**
   * Build every card once.
   *
   * The free weapon is listed too, even though it is not merchandise: a player
   * reading a shelf of things to buy deserves to see what the gun they already
   * have actually does, next to the ones they are being asked to pay for.
   */
  private build(shelf: readonly ShopItem[]): void {
    const free = requireWeapon(BABY_MISSILE);
    const cards = [this.card(free, false), ...shelf.map((item) => this.card(item.weapon, true))];
    this.list.replaceChildren(...cards);
  }

  private card(weapon: WeaponDef, forSale: boolean): HTMLLIElement {
    const li = el('li', { className: 'wpn', testId: `shop-${weapon.id}` });
    li.dataset['tier'] = String(weapon.tier);
    if (!forSale) li.classList.add('wpn--free');

    const name = el('div', { className: 'wpn__name', text: weapon.name });
    name.append(el('span', { className: 'wpn__tier', text: `T${weapon.tier}` }));

    const owned = el('div', { className: 'wpn__owned', testId: `shop-owned-${weapon.id}` });

    const desc = el('div', { className: 'wpn__desc', text: weapon.description });

    const stats = el('div', { className: 'wpn__stats' });
    stats.append(
      stat('Dmg', weapon.damage > 0 ? String(weapon.damage) : '—'),
      stat('Blast', `${weapon.radius}px`),
      stat('Pack', forSale ? String(weapon.packSize) : '∞'),
    );

    const price = el('div', { className: 'wpn__price' });
    if (forSale) {
      price.textContent = money(weapon.price);
      price.append(el('small', { text: `${money(weapon.price / weapon.packSize)} a shot` }));
    } else {
      price.textContent = 'Issued';
      price.append(el('small', { text: 'never runs out' }));
    }

    const buttons = el('div', { className: 'wpn__buttons' });
    let buy: HTMLButtonElement | null = null;
    let sell: HTMLButtonElement | null = null;
    if (forSale) {
      buy = el('button', { className: 'shop__buy', text: 'Buy', testId: `shop-buy-${weapon.id}` });
      buy.type = 'button';
      buy.addEventListener('click', () => this.callbacks.onBuy(weapon.id));

      sell = el('button', {
        className: 'shop__sell',
        text: 'Sell',
        testId: `shop-sell-${weapon.id}`,
        title: `Sell one pack back for ${money(refundForPack(weapon))}`,
      });
      sell.type = 'button';
      sell.addEventListener('click', () => this.callbacks.onSell(weapon.id));

      buttons.append(buy, sell);
    }

    li.append(name, owned, desc, stats, price, buttons);
    const row: Row = { li, owned, buy, sell };
    this.rows.set(weapon.id, row);
    return li;
  }

  /** Update only what a purchase can change: counts, affordability, wording. */
  private patch(shelf: readonly ShopItem[], tank: TankSnapshot): void {
    const freeRow = this.rows.get(BABY_MISSILE);
    if (freeRow !== undefined) {
      freeRow.owned.textContent = '∞';
      freeRow.owned.dataset['empty'] = '0';
    }

    for (const item of shelf) {
      const row = this.rows.get(item.weapon.id);
      if (row === undefined) continue;

      row.owned.textContent = item.owned > 0 ? `×${item.owned}` : '—';
      row.owned.dataset['empty'] = item.owned > 0 ? '0' : '1';
      row.li.classList.toggle('wpn--owned', item.owned > 0);
      row.li.classList.toggle('wpn--broke', !item.affordable || !item.unlocked);

      if (row.buy !== null) {
        const buyable = item.affordable && item.unlocked;
        row.buy.disabled = !buyable;
        row.buy.title = !item.unlocked
          ? `Locked until ${unlockRoundFor(item.weapon)} rounds have been fought`
          : item.affordable
            ? `Buy ${item.weapon.packSize} rounds for ${money(item.weapon.price)}`
            : `Costs ${money(item.weapon.price)} — you have ${money(tank.money)}`;
      }
      if (row.sell !== null) {
        row.sell.disabled = item.owned < item.weapon.packSize;
      }
    }
  }
}

function stat(label: string, value: string): HTMLElement {
  const node = el('span', { text: `${label} ` });
  node.append(el('b', { text: value }));
  return node;
}
