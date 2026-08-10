/**
 * The status line, in the spirit of the 1991 original: one compact strip at the
 * top of the window carrying power, angle, whose turn it is, the weapon, the
 * clock and — loudest of all — the wind.
 *
 * It renders the authoritative snapshot and nothing else. It never decides
 * whether a shot is legal; `canFire` is handed to it already answered.
 */

import { BABY_MISSILE, getWeapon, PHYSICS, WEAPONS } from '@scorched/sim';
import type { GameSnapshot, TankSnapshot } from '@scorched/protocol';
import type { ConnectionStatus } from '../net.ts';
import { el, must } from './dom.ts';
import { blurbOf, describeSeat } from './bots.ts';
import { ammo, clock, colorCss, hurtLevel, money, readWind, weaponName } from './format.ts';

/**
 * Which seats are computer players, by player id — carried in from the last
 * lobby frame, because the snapshot does not say. Empty is a perfectly normal
 * value: a match of nothing but people, or a spectator who walked in after the
 * first shot and has not seen a lobby frame yet.
 */
export type BotSeats = ReadonlyMap<string, string>;

export interface HudCallbacks {
  onAdjust(kind: 'angle' | 'power', delta: number): void;
  onSelectWeapon(weaponId: string): void;
  onFire(): void;
}

/** What the server's last `turnTimer` frame said, plus when we heard it. */
export interface TimerReadout {
  remainingMs: number;
  durationMs: number;
}

const COARSE_STEP = 10;
const FINE_STEP = 1;

/** Seconds left below which the clock turns amber, then red. */
const CLOCK_SOON_MS = 15_000;
const CLOCK_NOW_MS = 5_000;

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Linking',
  open: 'Live',
  reconnecting: 'Dropped',
  closed: 'Offline',
};

export interface CarriedWeapon {
  readonly id: string;
  readonly count: number;
}

/**
 * The weapons a tank can actually fire: the free one, plus everything it holds
 * rounds of, in arsenal order.
 *
 * A weapon with zero rounds is deliberately not offered — selecting it could
 * only earn a `no_ammo` refusal from the server, and a control that exists only
 * to be refused is worse than no control.
 */
export function carriedWeapons(inventory: Record<string, number>): CarriedWeapon[] {
  return WEAPONS.filter(
    (weapon) => weapon.id === BABY_MISSILE || (inventory[weapon.id] ?? 0) > 0,
  ).map((weapon) => ({
    id: weapon.id,
    count: weapon.id === BABY_MISSILE ? Number.POSITIVE_INFINITY : (inventory[weapon.id] ?? 0),
  }));
}

export class HudView {
  private readonly callbacks: HudCallbacks;

  private readonly root = must<HTMLDivElement>('#hud');
  private readonly angleOut = must<HTMLOutputElement>('#hud-angle');
  private readonly powerOut = must<HTMLOutputElement>('#hud-power');
  private readonly windValue = must<HTMLOutputElement>('#hud-wind');
  private readonly windBox = must<HTMLDivElement>('#hud-windbox');
  private readonly windFill = must<HTMLSpanElement>('#hud-wind-fill');
  private readonly weaponSelect = must<HTMLSelectElement>('#hud-weapon');
  private readonly fireButton = must<HTMLButtonElement>('#hud-fire');
  private readonly arsenal = must<HTMLDivElement>('#hud-arsenal');
  private readonly playersStrip = must<HTMLDivElement>('#hud-players');
  private readonly turnLine = must<HTMLDivElement>('#hud-turn');
  private readonly link = must<HTMLDivElement>('#hud-conn');

  private readonly activeBox = must<HTMLDivElement>('#hud-active');
  private readonly activeSwatch = must<HTMLSpanElement>('#hud-active-swatch');
  private readonly activeName = must<HTMLSpanElement>('#hud-active-name');
  private readonly activeHealth = must<HTMLSpanElement>('#hud-active-health');

  private readonly timerBox = must<HTMLDivElement>('#hud-timer');
  private readonly timerValue = must<HTMLSpanElement>('#hud-timer-value');
  private readonly timerFill = must<HTMLSpanElement>('#hud-timer-fill');

  /** The last arsenal signature rendered, so a snapshot per turn is not a rebuild per turn. */
  private arsenalSignature = '';
  private weaponSignature = '';
  private selectedWeapon: string = BABY_MISSILE;

  constructor(callbacks: HudCallbacks) {
    this.callbacks = callbacks;

    // One listener for six buttons. `data-coarse` is what makes the outer pair
    // the "big step" pair, matching Shift + arrow on the keyboard.
    this.root.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest<HTMLElement>('[data-action]');
      if (button === null) return;
      const action = button.dataset['action'];
      if (action === undefined) return;

      const size = button.dataset['coarse'] === '1' || event.shiftKey ? COARSE_STEP : FINE_STEP;
      switch (action) {
        case 'angle-up':
          this.callbacks.onAdjust('angle', size);
          break;
        case 'angle-down':
          this.callbacks.onAdjust('angle', -size);
          break;
        case 'power-up':
          this.callbacks.onAdjust('power', size);
          break;
        case 'power-down':
          this.callbacks.onAdjust('power', -size);
          break;
        default:
          break;
      }
    });

    this.weaponSelect.addEventListener('change', () => {
      this.callbacks.onSelectWeapon(this.weaponSelect.value);
    });

    this.fireButton.addEventListener('click', () => this.callbacks.onFire());
  }

  setAim(angle: number, power: number): void {
    // Exactly the number, no unit suffix: the e2e suite reads these two nodes
    // as integers to drive aiming, and the degree sign lives in a sibling.
    this.angleOut.textContent = String(angle);
    this.powerOut.textContent = String(power);
  }

  setSelectedWeapon(weaponId: string): void {
    this.selectedWeapon = weaponId;
    if (this.weaponSelect.value !== weaponId) this.weaponSelect.value = weaponId;
    for (const chip of this.arsenal.querySelectorAll<HTMLElement>('.ammo')) {
      chip.classList.toggle('ammo--active', chip.dataset['weapon'] === weaponId);
    }
  }

  /**
   * Draw the strip, and report back which weapon is actually selected.
   *
   * `preferred` is what the player chose. If they have since run out of it the
   * rail falls back to the free weapon and says so in the return value, so the
   * caller can re-broadcast rather than letting the two ends disagree about
   * what is loaded.
   */
  render(
    snapshot: GameSnapshot,
    you: string,
    canFire: boolean,
    preferred: string,
    bots: BotSeats = new Map(),
  ): string {
    this.renderWind(snapshot.wind);

    const active = snapshot.tanks[snapshot.activeTank];
    this.renderActive(active, you, bots);

    const yourTank = snapshot.tanks.find((tank) => tank.id === you);
    if (yourTank !== undefined) {
      const carried = carriedWeapons(yourTank.inventory);
      const usable = carried.some((entry) => entry.id === preferred) ? preferred : BABY_MISSILE;
      this.renderWeaponOptions(carried, usable);
      this.renderArsenal(carried);
      this.selectedWeapon = usable;
    }

    this.fireButton.disabled = !canFire;
    this.turnLine.textContent = this.describeTurn(snapshot, you, active, bots);
    this.renderPlayers(snapshot, you, bots);
    return this.selectedWeapon;
  }

  get canFire(): boolean {
    return !this.fireButton.disabled;
  }

  get selection(): string {
    return this.selectedWeapon;
  }

  private describeTurn(
    snapshot: GameSnapshot,
    you: string,
    active: TankSnapshot | undefined,
    bots: BotSeats,
  ): string {
    if (snapshot.phase === 'resolving') return 'Shot away…';
    if (snapshot.phase === 'shopping') return 'Between rounds — visit the armoury.';
    if (snapshot.phase !== 'aiming' || active === undefined) return '';
    const heading = `Round ${snapshot.round} of ${snapshot.totalRounds}`;
    if (active.id === you) {
      return `${heading} — your shot. Arrows aim, Shift for big steps, Space fires.`;
    }
    // "Thinking" rather than "waiting for": a computer player is not somebody
    // who might have walked away from the keyboard, and the wait is a second.
    return bots.has(active.id)
      ? `${heading} — ${active.name} is thinking…`
      : `${heading} — waiting for ${active.name}…`;
  }

  private renderActive(active: TankSnapshot | undefined, you: string, bots: BotSeats): void {
    if (active === undefined) {
      this.activeName.textContent = '—';
      this.activeHealth.textContent = '';
      this.activeBox.classList.remove('onturn--you');
      this.activeBox.classList.remove('onturn--bot');
      this.activeBox.title = '';
      return;
    }
    this.activeSwatch.style.background = colorCss(active.colorIndex);
    this.activeName.textContent = active.name;
    this.activeHealth.textContent = `${Math.max(0, Math.round(active.health))}%`;
    this.activeHealth.dataset['hurt'] = hurtLevel(active.health);
    this.activeBox.classList.toggle('onturn--you', active.id === you);

    const personality = bots.get(active.id);
    this.activeBox.classList.toggle('onturn--bot', personality !== undefined);
    this.activeBox.title = personality === undefined ? '' : blurbOf(personality).long;
  }

  /**
   * Wind, drawn twice over: a gauge that grows out of dead centre and a number.
   *
   * The gauge is scaled by the sim's own `PHYSICS.maxWind` rather than by a
   * constant picked to look right, so a full bar always means "as windy as this
   * game gets" even if the physics is retuned.
   */
  private renderWind(wind: number): void {
    const readout = readWind(wind);
    this.windValue.textContent = `${readout.arrow} ${readout.magnitude}`;
    this.windBox.dataset['calm'] = readout.calm ? '1' : '0';
    this.windFill.dataset['dir'] = readout.direction;
    const fraction = Math.min(1, Math.abs(wind) / PHYSICS.maxWind);
    this.windFill.style.width = `${(fraction * 50).toFixed(1)}%`;
    this.windBox.title = readout.calm
      ? 'No wind. Aim straight.'
      : `Wind pushes shells ${readout.direction === 'left' ? 'left' : 'right'} at ${readout.magnitude} of ${PHYSICS.maxWind}.`;
  }

  private renderPlayers(snapshot: GameSnapshot, you: string, bots: BotSeats): void {
    this.playersStrip.replaceChildren(
      ...snapshot.tanks.map((tank, index) => {
        const tag = el('div', { className: 'playertag', testId: `playertag-${tank.id}` });
        if (index === snapshot.activeTank) tag.classList.add('playertag--active');
        if (!tank.alive) tag.classList.add('playertag--dead');
        if (tank.id === you) tag.classList.add('playertag--you');

        const swatch = el('span', { className: 'playertag__swatch' });
        swatch.style.background = colorCss(tank.colorIndex);

        const name = el('span', {
          className: 'playertag__name',
          text: tank.id === you ? `${tank.name} (you)` : tank.name,
        });

        /*
         * Which of these tanks is a machine, said in the one place a player is
         * already looking to see who is left. Without it, a name like "Cyborg"
         * is the only clue — and a bot's name is not a rule, so a room that ever
         * lets a person be called Cyborg would make that clue a lie.
         */
        const personality = bots.get(tank.id);
        const cpu =
          personality === undefined
            ? null
            : el('span', {
                className: 'playertag__cpu',
                text: 'CPU',
                title: `${describeSeat(personality)}. ${blurbOf(personality).long}`,
              });
        if (cpu !== null) tag.classList.add('playertag--bot');

        const bar = el('span', { className: 'playertag__health' });
        bar.dataset['hurt'] = hurtLevel(tank.health);
        const fill = el('span');
        fill.style.width = `${Math.max(0, Math.min(100, tank.health))}%`;
        bar.append(fill);

        const cash = el('span', { className: 'playertag__cash', text: money(tank.money) });

        tag.append(swatch, name);
        if (cpu !== null) tag.append(cpu);
        tag.append(bar, cash);
        return tag;
      }),
    );
  }

  private renderWeaponOptions(carried: readonly CarriedWeapon[], selected: string): void {
    const signature = carried.map((entry) => `${entry.id}:${entry.count}`).join('|');
    if (this.weaponSignature !== signature) {
      this.weaponSignature = signature;
      this.weaponSelect.replaceChildren(
        ...carried.map((entry) => {
          const option = document.createElement('option');
          option.value = entry.id;
          option.textContent = `${weaponName(entry.id)} ×${ammo(entry.count)}`;
          return option;
        }),
      );
    }
    this.setSelectedWeapon(selected);
  }

  /**
   * The ammo rail — every round this tank is carrying, visible at a glance and
   * one click from being selected. The original makes you cycle a list; a rail
   * says what you have without you asking.
   */
  private renderArsenal(carried: readonly CarriedWeapon[]): void {
    const signature = carried.map((entry) => `${entry.id}:${entry.count}`).join('|');
    if (this.arsenalSignature === signature) {
      this.setSelectedWeapon(this.selectedWeapon);
      return;
    }
    this.arsenalSignature = signature;

    const chips: HTMLElement[] = carried.map((entry) => {
      const weapon = getWeapon(entry.id);
      const chip = el('button', { className: 'ammo', testId: `ammo-${entry.id}` });
      chip.type = 'button';
      chip.dataset['weapon'] = entry.id;
      chip.title = weapon?.description ?? '';
      chip.append(
        el('span', { text: weaponName(entry.id) }),
        el('span', { className: 'ammo__count', text: `×${ammo(entry.count)}` }),
      );
      chip.addEventListener('click', () => this.callbacks.onSelectWeapon(entry.id));
      return chip;
    });

    const remaining = WEAPONS.length - carried.length;
    if (remaining > 0) {
      chips.push(
        el('span', {
          className: 'hud__hint',
          text: `+${remaining} more in the armoury between rounds`,
        }),
      );
    }

    this.arsenal.replaceChildren(...chips);
    this.setSelectedWeapon(this.selectedWeapon);
  }

  /** Draw the clock, or hide it when the server is not running one. */
  setTimer(readout: TimerReadout | null): void {
    if (readout === null || readout.durationMs <= 0) {
      this.timerBox.hidden = true;
      return;
    }
    this.timerBox.hidden = false;
    this.timerValue.textContent = clock(readout.remainingMs);
    const fraction = Math.max(0, Math.min(1, readout.remainingMs / readout.durationMs));
    this.timerFill.style.width = `${(fraction * 100).toFixed(1)}%`;
    this.timerBox.dataset['urgency'] =
      readout.remainingMs <= CLOCK_NOW_MS
        ? 'now'
        : readout.remainingMs <= CLOCK_SOON_MS
          ? 'soon'
          : 'fine';
  }

  setConnection(status: ConnectionStatus): void {
    this.link.dataset['state'] = status;
    this.link.textContent = CONNECTION_LABEL[status];
  }
}
