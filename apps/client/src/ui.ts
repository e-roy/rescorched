/**
 * DOM overlay: title screen, lobby, HUD, shop, game over.
 *
 * Plain DOM by design (TECH_STACK.md) — no framework. Every element it touches
 * carries a `data-testid` so Playwright can drive the whole game without
 * guessing at selectors.
 */

import { WEAPONS, getWeapon, BABY_MISSILE } from '@scorched/sim';
import type { GameSnapshot, LobbyPlayer } from '@scorched/protocol';
import { TANK_COLORS } from './scenes/battle.ts';

export type Screen = 'title' | 'lobby' | 'battle' | 'shop' | 'gameover';

export interface UiCallbacks {
  onCreateRoom(name: string): void;
  onJoinRoom(name: string, roomCode: string): void;
  onStart(): void;
  onLeave(): void;
  onAimChange(angleDeg: number, power: number, weapon: string): void;
  onFire(): void;
  onBuy(weaponId: string): void;
  onSell(weaponId: string): void;
  onShopDone(): void;
  onBackToTitle(): void;
}

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing required element: ${selector}`);
  return element;
}

export class Ui {
  private readonly callbacks: UiCallbacks;

  private readonly overlay = must<HTMLDivElement>('#overlay');
  private readonly hud = must<HTMLDivElement>('#hud');
  private readonly panels: Record<Exclude<Screen, 'battle'>, HTMLElement> = {
    title: must<HTMLElement>('#panel-title'),
    lobby: must<HTMLElement>('#panel-lobby'),
    shop: must<HTMLElement>('#panel-shop'),
    gameover: must<HTMLElement>('#panel-gameover'),
  };

  private readonly nameInput = must<HTMLInputElement>('#input-name');
  private readonly roomInput = must<HTMLInputElement>('#input-room');
  private readonly titleError = must<HTMLParagraphElement>('#title-error');
  private readonly lobbyCode = must<HTMLSpanElement>('#lobby-code');
  private readonly lobbyPlayers = must<HTMLUListElement>('#lobby-players');
  private readonly lobbyError = must<HTMLParagraphElement>('#lobby-error');
  private readonly startButton = must<HTMLButtonElement>('#btn-start');

  private readonly angleOut = must<HTMLOutputElement>('#hud-angle');
  private readonly powerOut = must<HTMLOutputElement>('#hud-power');
  private readonly windOut = must<HTMLOutputElement>('#hud-wind');
  private readonly weaponSelect = must<HTMLSelectElement>('#hud-weapon');
  private readonly fireButton = must<HTMLButtonElement>('#hud-fire');
  private readonly playersStrip = must<HTMLDivElement>('#hud-players');
  private readonly turnLine = must<HTMLDivElement>('#hud-turn');

  private readonly shopMoney = must<HTMLElement>('#shop-money');
  private readonly shopItems = must<HTMLUListElement>('#shop-items');
  private readonly gameoverWinner = must<HTMLParagraphElement>('#gameover-winner');
  private readonly gameoverScores = must<HTMLUListElement>('#gameover-scores');
  private readonly toast = must<HTMLDivElement>('#toast');

  private angle = 45;
  private power = 60;
  private weapon: string = BABY_MISSILE;
  private toastTimer: number | null = null;

  constructor(callbacks: UiCallbacks) {
    this.callbacks = callbacks;
    this.wire();
  }

  private wire(): void {
    must<HTMLButtonElement>('#btn-create').addEventListener('click', () => {
      this.callbacks.onCreateRoom(this.nameInput.value.trim() || 'Player');
    });

    must<HTMLButtonElement>('#btn-join').addEventListener('click', () => {
      const code = this.roomInput.value.trim().toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) {
        this.showTitleError('Room codes are four letters, like ABCD.');
        return;
      }
      this.callbacks.onJoinRoom(this.nameInput.value.trim() || 'Player', code);
    });

    this.roomInput.addEventListener('input', () => {
      this.roomInput.value = this.roomInput.value.toUpperCase().replace(/[^A-Z]/g, '');
    });

    this.startButton.addEventListener('click', () => this.callbacks.onStart());
    must<HTMLButtonElement>('#btn-leave').addEventListener('click', () => this.callbacks.onLeave());
    must<HTMLButtonElement>('#btn-shop-done').addEventListener('click', () =>
      this.callbacks.onShopDone(),
    );
    must<HTMLButtonElement>('#btn-again').addEventListener('click', () =>
      this.callbacks.onBackToTitle(),
    );

    this.hud.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.dataset['action'];
      if (action === undefined) return;
      const step = event.shiftKey ? 10 : 1;
      if (action === 'angle-up') this.setAim(this.angle + step, this.power);
      if (action === 'angle-down') this.setAim(this.angle - step, this.power);
      if (action === 'power-up') this.setAim(this.angle, this.power + step);
      if (action === 'power-down') this.setAim(this.angle, this.power - step);
    });

    this.weaponSelect.addEventListener('change', () => {
      this.weapon = this.weaponSelect.value;
      this.callbacks.onAimChange(this.angle, this.power, this.weapon);
    });

    this.fireButton.addEventListener('click', () => this.callbacks.onFire());

    window.addEventListener('keydown', (event) => {
      if (this.overlay.hidden === false) return;
      if (document.activeElement instanceof HTMLInputElement) return;
      const step = event.shiftKey ? 10 : 1;
      switch (event.key) {
        case 'ArrowLeft':
          this.setAim(this.angle + step, this.power);
          event.preventDefault();
          break;
        case 'ArrowRight':
          this.setAim(this.angle - step, this.power);
          event.preventDefault();
          break;
        case 'ArrowUp':
          this.setAim(this.angle, this.power + step);
          event.preventDefault();
          break;
        case 'ArrowDown':
          this.setAim(this.angle, this.power - step);
          event.preventDefault();
          break;
        case ' ':
        case 'Enter':
          if (!this.fireButton.disabled) this.callbacks.onFire();
          event.preventDefault();
          break;
        default:
          break;
      }
    });
  }

  // ---------------------------------------------------------------- screens

  show(screen: Screen): void {
    const isBattle = screen === 'battle';
    this.overlay.hidden = isBattle;
    this.hud.hidden = !isBattle && screen !== 'shop';

    for (const [key, panel] of Object.entries(this.panels)) {
      panel.hidden = key !== screen;
    }
    if (isBattle) this.hud.hidden = false;
  }

  showTitleError(message: string): void {
    this.titleError.textContent = message;
    this.titleError.hidden = false;
  }

  clearTitleError(): void {
    this.titleError.hidden = true;
  }

  showLobbyError(message: string): void {
    this.lobbyError.textContent = message;
    this.lobbyError.hidden = false;
  }

  showToast(message: string): void {
    this.toast.textContent = message;
    this.toast.hidden = false;
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.hidden = true;
    }, 3200);
  }

  // ------------------------------------------------------------------ lobby

  renderLobby(
    roomCode: string,
    players: readonly LobbyPlayer[],
    hostId: string | null,
    you: string,
  ): void {
    this.lobbyCode.textContent = roomCode;
    this.lobbyPlayers.replaceChildren(
      ...players.map((player) => {
        const li = document.createElement('li');
        li.dataset['playerId'] = player.id;

        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = colorCss(player.colorIndex);
        li.append(swatch);

        const name = document.createElement('span');
        name.textContent = player.name + (player.id === you ? ' (you)' : '');
        li.append(name);

        const spacer = document.createElement('span');
        spacer.className = 'spacer';
        li.append(spacer);

        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = player.id === hostId ? 'HOST' : player.connected ? '' : 'AWAY';
        li.append(tag);

        return li;
      }),
    );

    this.startButton.disabled = players.length < 2 || (hostId !== null && hostId !== you);
  }

  // ------------------------------------------------------------------- hud

  setAim(angle: number, power: number): void {
    this.angle = clampInt(angle, 0, 180);
    this.power = clampInt(power, 0, 100);
    this.angleOut.textContent = String(this.angle);
    this.powerOut.textContent = String(this.power);
    this.callbacks.onAimChange(this.angle, this.power, this.weapon);
  }

  get aim(): { angleDeg: number; power: number; weapon: string } {
    return { angleDeg: this.angle, power: this.power, weapon: this.weapon };
  }

  renderHud(snapshot: GameSnapshot, you: string, canFire: boolean): void {
    this.windOut.textContent = formatWind(snapshot.wind);

    const yourTank = snapshot.tanks.find((tank) => tank.id === you);
    if (yourTank !== undefined) {
      this.renderWeaponOptions(yourTank.inventory, yourTank.selectedWeapon);
    }

    const active = snapshot.tanks[snapshot.activeTank];
    this.turnLine.textContent =
      snapshot.phase === 'aiming' && active !== undefined
        ? active.id === you
          ? 'Your shot.'
          : `Waiting for ${active.name}…`
        : '';

    this.fireButton.disabled = !canFire;

    this.playersStrip.replaceChildren(
      ...snapshot.tanks.map((tank, index) => {
        const tag = document.createElement('div');
        tag.className = 'playertag';
        tag.dataset['testid'] = `playertag-${tank.id}`;
        if (index === snapshot.activeTank) tag.classList.add('playertag--active');
        if (!tank.alive) tag.classList.add('playertag--dead');

        const swatch = document.createElement('span');
        swatch.className = 'playertag__swatch';
        swatch.style.background = colorCss(tank.colorIndex);
        tag.append(swatch);

        const name = document.createElement('span');
        name.textContent = tank.name;
        tag.append(name);

        const bar = document.createElement('span');
        bar.className = 'playertag__health';
        const fill = document.createElement('span');
        fill.style.width = `${Math.max(0, tank.health)}%`;
        bar.append(fill);
        tag.append(bar);

        const cash = document.createElement('span');
        cash.textContent = `$${tank.money.toLocaleString('en-US')}`;
        tag.append(cash);

        return tag;
      }),
    );
  }

  private renderWeaponOptions(inventory: Record<string, number>, selected: string): void {
    const available = [
      { id: BABY_MISSILE, label: 'Baby Missile (∞)' },
      ...Object.entries(inventory)
        .filter(([, count]) => count > 0)
        .map(([id, count]) => ({ id, label: `${getWeapon(id)?.name ?? id} (${count})` })),
    ];

    const signature = available.map((option) => option.label).join('|');
    if (this.weaponSelect.dataset['signature'] === signature) {
      this.weaponSelect.value = selected;
      return;
    }
    this.weaponSelect.dataset['signature'] = signature;

    this.weaponSelect.replaceChildren(
      ...available.map((option) => {
        const element = document.createElement('option');
        element.value = option.id;
        element.textContent = option.label;
        return element;
      }),
    );
    this.weaponSelect.value = available.some((option) => option.id === selected)
      ? selected
      : BABY_MISSILE;
    this.weapon = this.weaponSelect.value;
  }

  // ------------------------------------------------------------------ shop

  renderShop(snapshot: GameSnapshot, you: string): void {
    const tank = snapshot.tanks.find((candidate) => candidate.id === you);
    if (tank === undefined) return;

    this.shopMoney.textContent = `$${tank.money.toLocaleString('en-US')}`;

    const purchasable = WEAPONS.filter((weapon) => weapon.id !== BABY_MISSILE)
      .slice()
      .sort((a, b) => a.tier - b.tier || a.price - b.price);

    this.shopItems.replaceChildren(
      ...purchasable.map((weapon) => {
        const owned = tank.inventory[weapon.id] ?? 0;
        const li = document.createElement('li');
        li.dataset['testid'] = `shop-${weapon.id}`;

        const info = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'shop__name';
        name.textContent = weapon.name;
        const desc = document.createElement('div');
        desc.className = 'shop__desc';
        desc.textContent = weapon.description;
        const price = document.createElement('div');
        price.className = 'shop__price';
        price.textContent = `$${weapon.price.toLocaleString('en-US')} — ${weapon.packSize} rounds`;
        info.append(name, desc, price);
        li.append(info);

        const ownedLabel = document.createElement('span');
        ownedLabel.className = 'shop__owned';
        ownedLabel.dataset['testid'] = `shop-owned-${weapon.id}`;
        ownedLabel.textContent = owned > 0 ? `x${owned}` : '—';
        li.append(ownedLabel);

        const buy = document.createElement('button');
        buy.className = 'shop__buy';
        buy.dataset['testid'] = `shop-buy-${weapon.id}`;
        buy.textContent = 'Buy';
        buy.disabled = tank.money < weapon.price;
        buy.addEventListener('click', () => this.callbacks.onBuy(weapon.id));
        li.append(buy);

        return li;
      }),
    );
  }

  // -------------------------------------------------------------- game over

  renderGameOver(snapshot: GameSnapshot): void {
    const winner = snapshot.tanks.find((tank) => tank.id === snapshot.winnerId);
    this.gameoverWinner.textContent =
      winner !== undefined ? `${winner.name} wins.` : 'Nobody survived.';

    const ranked = [...snapshot.tanks].sort((a, b) => b.score - a.score);
    this.gameoverScores.replaceChildren(
      ...ranked.map((tank) => {
        const li = document.createElement('li');
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = colorCss(tank.colorIndex);
        li.append(swatch);
        const name = document.createElement('span');
        name.textContent = tank.name;
        li.append(name);
        const spacer = document.createElement('span');
        spacer.className = 'spacer';
        li.append(spacer);
        const score = document.createElement('span');
        score.className = 'tag';
        score.textContent = `${tank.score} pts`;
        li.append(score);
        return li;
      }),
    );
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function colorCss(index: number): string {
  const color = TANK_COLORS[index % TANK_COLORS.length] ?? 0xffffff;
  return `#${color.toString(16).padStart(6, '0')}`;
}

function formatWind(wind: number): string {
  const arrow = wind > 0.05 ? '→' : wind < -0.05 ? '←' : '·';
  return `${arrow} ${Math.abs(wind).toFixed(1)}`;
}
