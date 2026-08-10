/**
 * DOM overlay: title screen, lobby, HUD, armoury, game over — and the keyboard.
 *
 * Plain DOM by design (TECH_STACK.md) — no framework. Every element it touches
 * carries a `data-testid` so Playwright can drive the whole game without
 * guessing at selectors.
 *
 * It holds NO game rules. It renders the authoritative snapshot, forwards
 * intent, and is told by the caller whether firing is currently legal.
 *
 * The screens themselves live in `./ui/`, split by the thing they are about.
 * This file is the switchboard: which screen is up, what the keyboard does, and
 * which of the server's frames each screen needs to hear about.
 */

import { BABY_MISSILE } from '@scorched/sim';
import type { GameSnapshot, LobbyPlayer, ServerMessage, Standing } from '@scorched/protocol';
import { activeNet, subscribeNet, type ConnectionStatus } from './net.ts';
import { must, el } from './ui/dom.ts';
import { ArmouryView } from './ui/armoury.ts';
import { ChatView } from './ui/chat.ts';
import { HudView, carriedWeapons } from './ui/hud.ts';
import { LobbyView } from './ui/lobby.ts';
import { colorCss } from './ui/format.ts';

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

const ANGLE_MIN = 0;
const ANGLE_MAX = 180;
const POWER_MIN = 0;
const POWER_MAX = 100;
const COARSE_STEP = 10;
const FINE_STEP = 1;
const TOAST_MS = 3200;
/** How often the turn clock repaints. Fine enough to look live, coarse enough to be free. */
const CLOCK_TICK_MS = 250;

/** What the server's last `turnTimer` frame said, and when we heard it. */
interface TimerState {
  turnNumber: number;
  remainingMs: number;
  durationMs: number;
  receivedAt: number;
}

export class Ui {
  private readonly callbacks: UiCallbacks;

  private readonly overlay = must<HTMLDivElement>('#overlay');
  private readonly hudRoot = must<HTMLDivElement>('#hud');
  private readonly panels: Record<Exclude<Screen, 'battle'>, HTMLElement> = {
    title: must<HTMLElement>('#panel-title'),
    lobby: must<HTMLElement>('#panel-lobby'),
    shop: must<HTMLElement>('#panel-shop'),
    gameover: must<HTMLElement>('#panel-gameover'),
  };

  private readonly nameInput = must<HTMLInputElement>('#input-name');
  private readonly roomInput = must<HTMLInputElement>('#input-room');
  private readonly titleError = must<HTMLParagraphElement>('#title-error');

  private readonly gameoverWinner = must<HTMLParagraphElement>('#gameover-winner');
  private readonly gameoverRounds = must<HTMLParagraphElement>('#gameover-rounds');
  private readonly gameoverScores = must<HTMLOListElement>('#gameover-scores');

  private readonly toast = must<HTMLDivElement>('#toast');
  private readonly connBanner = must<HTMLDivElement>('#conn-banner');

  private readonly hud: HudView;
  private readonly lobby: LobbyView;
  private readonly armoury: ArmouryView;
  private readonly chat: ChatView;

  private angle = 45;
  private power = 60;
  private weapon: string = BABY_MISSILE;
  /**
   * Whether we have taken the server's word for which weapon is loaded.
   *
   * Reset on every (re)connect: a player who reloads mid-match should come back
   * holding the shell they were holding, not the free one.
   */
  private weaponAdopted = false;

  private screen: Screen = 'title';
  private snapshot: GameSnapshot | null = null;
  private you = '';
  /**
   * Which seats are computer players, by player id.
   *
   * The lobby frame is the only place the wire says so — `TankSnapshot`
   * deliberately carries no `bot` field, because the sim's snapshot and the
   * protocol's are pinned structurally identical and a personality is
   * persistence rather than wire state (see `LobbyPlayer.bot` in the protocol).
   * So the map is kept from the last lobby frame and read during the match, and
   * that is why the HUD can badge a tank the snapshot says nothing about.
   */
  private botSeats: ReadonlyMap<string, string> = new Map();
  private lastResult: {
    winnerId: string | null;
    roundsPlayed: number;
    standings: Standing[];
  } | null = null;

  private toastTimer: number | null = null;
  private timer: TimerState | null = null;
  private clockTimer: number | null = null;

  constructor(callbacks: UiCallbacks) {
    this.callbacks = callbacks;

    this.hud = new HudView({
      onAdjust: (kind, delta) => {
        if (kind === 'angle') this.setAim(this.angle + delta, this.power);
        else this.setAim(this.angle, this.power + delta);
      },
      onSelectWeapon: (weaponId) => this.selectWeapon(weaponId),
      onFire: () => this.callbacks.onFire(),
    });

    this.lobby = new LobbyView({
      onStart: () => this.callbacks.onStart(),
      onReady: (ready) => activeNet()?.send({ t: 'ready', ready }),
      onLeave: () => this.callbacks.onLeave(),
      onCopied: (message) => this.showToast(message, 'info'),
      // Sent the same way `ready` is: a request, which the room is free to
      // refuse. Nothing here decides whether there is a seat for it.
      onAddBot: (personality) => activeNet()?.send({ t: 'addBot', personality }),
      onRemoveBot: (playerId) => activeNet()?.send({ t: 'removeBot', playerId }),
    });

    this.armoury = new ArmouryView({
      onBuy: (weaponId) => this.callbacks.onBuy(weaponId),
      onSell: (weaponId) => this.callbacks.onSell(weaponId),
    });

    this.chat = new ChatView({
      onSend: (text) => activeNet()?.send({ t: 'chat', text }),
    });

    this.wireTitle();
    this.wireKeyboard();
    subscribeNet((event) => {
      if (event.kind === 'status') this.onConnectionStatus(event.status);
      else this.onServerMessage(event.message);
    });
  }

  // ------------------------------------------------------------------ wiring

  private wireTitle(): void {
    must<HTMLButtonElement>('#btn-create').addEventListener('click', () => {
      this.callbacks.onCreateRoom(this.playerName());
    });

    must<HTMLButtonElement>('#btn-join').addEventListener('click', () => this.submitJoin());

    this.roomInput.addEventListener('input', () => {
      this.roomInput.value = this.roomInput.value.toUpperCase().replace(/[^A-Z]/g, '');
    });
    this.roomInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.submitJoin();
    });
    this.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.callbacks.onCreateRoom(this.playerName());
    });

    must<HTMLButtonElement>('#btn-shop-done').addEventListener('click', () =>
      this.callbacks.onShopDone(),
    );
    must<HTMLButtonElement>('#btn-again').addEventListener('click', () =>
      this.callbacks.onBackToTitle(),
    );

    // A copied invite link carries the room code; honour it so the link works.
    const invited = new URLSearchParams(window.location.search).get('room');
    if (invited !== null && /^[A-Za-z]{4}$/.test(invited)) {
      this.roomInput.value = invited.toUpperCase();
    }
  }

  private playerName(): string {
    return this.nameInput.value.trim() || 'Player';
  }

  private submitJoin(): void {
    const code = this.roomInput.value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) {
      this.showTitleError('Room codes are four letters, like ABCD.');
      return;
    }
    this.callbacks.onJoinRoom(this.playerName(), code);
  }

  /**
   * The aiming keys.
   *
   * Left/Right walk the angle, Up/Down the power, and Shift makes every step a
   * coarse one — the modifier the original uses, kept because muscle memory is
   * the whole point of a remake. Nothing here fires while a panel is up, and
   * nothing here reacts while a text field has focus, so typing a room code or
   * a chat line can never swing the barrel.
   */
  private wireKeyboard(): void {
    window.addEventListener('keydown', (event) => {
      const focused = document.activeElement;
      if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) return;
      /*
       * A focused <select> owns the arrows, Enter, Space and type-ahead. Taking
       * any of those from it would mean the weapon list could be reached by
       * keyboard but never actually changed with one.
       */
      if (focused instanceof HTMLSelectElement) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      // Talk wherever there is a room to talk to — the lobby included, which is
      // where the placeholder's promise is most likely to be taken up.
      if (event.key.toLowerCase() === 't' && this.chat.focusInput()) {
        event.preventDefault();
        return;
      }

      // Everything below aims or fires, and none of it may reach the game while
      // a panel is up.
      if (!this.overlay.hidden) return;

      /*
       * Space and Enter are how a keyboard presses the button it is sitting on.
       * Firing on them regardless would mean tabbing to "angle up" and pressing
       * Enter took the shot instead of nudging the barrel. The arrows stay ours
       * either way — no button uses them, and aiming must not stop just because
       * a stepper still holds focus from the last click.
       */
      const onButton = focused instanceof HTMLButtonElement || focused instanceof HTMLAnchorElement;

      const step = event.shiftKey ? COARSE_STEP : FINE_STEP;
      switch (event.key) {
        case 'ArrowLeft':
          this.setAim(this.angle + step, this.power);
          event.preventDefault();
          return;
        case 'ArrowRight':
          this.setAim(this.angle - step, this.power);
          event.preventDefault();
          return;
        case 'ArrowUp':
          this.setAim(this.angle, this.power + step);
          event.preventDefault();
          return;
        case 'ArrowDown':
          this.setAim(this.angle, this.power - step);
          event.preventDefault();
          return;
        case ' ':
        case 'Enter':
          if (onButton) return;
          if (this.hud.canFire) this.callbacks.onFire();
          event.preventDefault();
          return;
        default:
          break;
      }

      switch (event.key.toLowerCase()) {
        case 'q':
          this.cycleWeapon(-1);
          event.preventDefault();
          return;
        case 'e':
          this.cycleWeapon(1);
          event.preventDefault();
          return;
        default:
          break;
      }

      // 1-9 pick straight from the ammo rail, in the order it is drawn.
      if (/^[1-9]$/.test(event.key)) {
        const carried = this.carried();
        const pick = carried[Number(event.key) - 1];
        if (pick !== undefined) this.selectWeapon(pick.id);
        event.preventDefault();
      }
    });
  }

  private carried(): { id: string; count: number }[] {
    const tank = this.snapshot?.tanks.find((candidate) => candidate.id === this.you);
    return tank === undefined ? [] : carriedWeapons(tank.inventory);
  }

  private cycleWeapon(direction: number): void {
    const carried = this.carried();
    if (carried.length === 0) return;
    const at = carried.findIndex((entry) => entry.id === this.weapon);
    const next = carried[(at + direction + carried.length) % carried.length];
    if (next !== undefined) this.selectWeapon(next.id);
  }

  private selectWeapon(weaponId: string): void {
    this.weapon = weaponId;
    this.weaponAdopted = true;
    this.hud.setSelectedWeapon(weaponId);
    this.callbacks.onAimChange(this.angle, this.power, this.weapon);
  }

  // ---------------------------------------------------------------- screens

  show(screen: Screen): void {
    this.screen = screen;
    document.body.dataset['screen'] = screen;

    const isBattle = screen === 'battle';
    this.overlay.hidden = isBattle;
    /*
     * The HUD belongs to the battlefield and to nothing else.
     *
     * It used to be left up for the armoury as well, which was invisible either
     * way: the overlay covered the whole window and painted over it. Now that
     * the overlay is inset into the stage, "left up" would mean a strip of
     * aiming dials and a dead FIRE button above a shopping screen — so this
     * says what it always meant.
     */
    this.hudRoot.hidden = !isBattle;

    /*
     * Chat follows the room, not the battlefield.
     *
     * The lobby is precisely where people arrange a game, so hiding it there
     * was backwards. It stays hidden on the title screen (there is no room to
     * talk to yet) and in the armoury, whose panel is wide enough to sit on top
     * of it.
     */
    this.chat.setVisible(isBattle || screen === 'lobby' || screen === 'gameover');

    for (const [key, panel] of Object.entries(this.panels)) {
      panel.hidden = key !== screen;
    }

    if (screen === 'title') {
      this.connBanner.hidden = true;
      this.setTimer(null);
    }
  }

  showTitleError(message: string): void {
    this.titleError.textContent = message;
    this.titleError.hidden = false;
  }

  clearTitleError(): void {
    this.titleError.hidden = true;
  }

  showLobbyError(message: string): void {
    this.lobby.showError(message);
  }

  /**
   * Offer a server refusal to whichever screen asked for it, and say whether it
   * was taken.
   *
   * The lobby's computer-player controls are the only thing that claims one
   * today, and the reason they must is `room_full`. That code means two
   * different things: "this room has no seat for you", which belongs on the
   * title screen because there is nothing to stay for, and "this room has no
   * seat for another computer player", which must leave the host exactly where
   * they are. The room cannot tell them apart — it answered the frame it was
   * sent — but the panel that sent the frame can.
   *
   * Anything not claimed here is the caller's to report, unchanged.
   */
  claimError(message: string): boolean {
    return this.screen === 'lobby' && this.lobby.consumeError(message);
  }

  showToast(message: string, tone: 'error' | 'info' = 'error'): void {
    this.toast.textContent = message;
    this.toast.dataset['tone'] = tone;
    this.toast.hidden = false;
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.hidden = true;
    }, TOAST_MS);
  }

  // ------------------------------------------------------------------ lobby

  renderLobby(
    roomCode: string,
    players: readonly LobbyPlayer[],
    hostId: string | null,
    you: string,
  ): void {
    this.you = you;
    this.lobby.render(roomCode, players, hostId, you);
  }

  // -------------------------------------------------------------------- hud

  setAim(angle: number, power: number): void {
    this.angle = clampInt(angle, ANGLE_MIN, ANGLE_MAX);
    this.power = clampInt(power, POWER_MIN, POWER_MAX);
    this.hud.setAim(this.angle, this.power);
    this.callbacks.onAimChange(this.angle, this.power, this.weapon);
  }

  get aim(): { angleDeg: number; power: number; weapon: string } {
    return { angleDeg: this.angle, power: this.power, weapon: this.weapon };
  }

  renderHud(snapshot: GameSnapshot, you: string, canFire: boolean): void {
    this.snapshot = snapshot;
    this.you = you;

    const yourTank = snapshot.tanks.find((tank) => tank.id === you);
    if (!this.weaponAdopted && yourTank !== undefined) {
      this.weapon = yourTank.selectedWeapon;
      this.weaponAdopted = true;
    }

    const effective = this.hud.render(snapshot, you, canFire, this.weapon, this.botSeats);
    if (effective !== this.weapon) {
      // We ran dry mid-match and the rail fell back to the free weapon. Tell
      // the server, or it would keep believing an empty gun is loaded.
      this.weapon = effective;
      this.callbacks.onAimChange(this.angle, this.power, this.weapon);
    }

    // A clock only means anything for the turn it was issued for.
    if (this.timer !== null && this.timer.turnNumber !== snapshot.turnNumber) this.setTimer(null);
    if (snapshot.phase !== 'aiming') this.setTimer(null);
  }

  // ---------------------------------------------------------------- armoury

  renderShop(snapshot: GameSnapshot, you: string): void {
    this.snapshot = snapshot;
    this.you = you;
    this.armoury.render(snapshot, you);
  }

  // -------------------------------------------------------------- game over

  renderGameOver(snapshot: GameSnapshot): void {
    const result = this.lastResult;
    const winnerId = result?.winnerId ?? snapshot.winnerId;
    const winner = snapshot.tanks.find((tank) => tank.id === winnerId);

    this.gameoverWinner.textContent =
      winner !== undefined
        ? winner.id === this.you
          ? `${winner.name} wins. That is you.`
          : `${winner.name} wins.`
        : 'Nobody survived.';

    const rounds = result?.roundsPlayed ?? snapshot.round;
    this.gameoverRounds.textContent = `${rounds} ${rounds === 1 ? 'round' : 'rounds'} fought.`;

    /*
     * Prefer the server's `matchResult` standings: they carry the place (with
     * ties sharing a place) and rounds won, neither of which can be recovered
     * from a snapshot. Fall back to ranking the final snapshot by score if the
     * frame never arrived — a scoreboard is better than an empty panel.
     */
    const rows =
      result !== null
        ? result.standings
        : [...snapshot.tanks]
            .sort((a, b) => b.score - a.score)
            .map((tank, index) => ({
              playerId: tank.id,
              name: tank.name,
              place: index + 1,
              score: tank.score,
              roundsWon: 0,
            }));

    this.gameoverScores.replaceChildren(
      ...rows.map((standing) => {
        const tank = snapshot.tanks.find((candidate) => candidate.id === standing.playerId);
        const li = el('li', { testId: `standing-${standing.playerId}` });
        if (standing.place === 1) li.classList.add('is-first');

        const place = el('span', { className: 'standings__place', text: `${standing.place}.` });

        const swatch = el('span', { className: 'swatch' });
        swatch.style.background = colorCss(tank?.colorIndex ?? 0);

        const name = el('span', {
          className: 'standings__name',
          text: standing.playerId === this.you ? `${standing.name} (you)` : standing.name,
        });

        const roundsWon = el('span', {
          className: 'standings__rounds',
          text:
            standing.roundsWon > 0
              ? `${standing.roundsWon} round ${standing.roundsWon === 1 ? 'win' : 'wins'}`
              : '',
        });

        const score = el('span', {
          className: 'standings__score',
          text: `${standing.score.toLocaleString('en-US')} pts`,
        });

        li.append(place, swatch, name, roundsWon, score);
        return li;
      }),
    );
  }

  // -------------------------------------------------- server-driven extras
  //
  // Frames the game loop has no opinion about, observed through the socket's
  // broadcast tap rather than plumbed through the entry point.

  private onServerMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        this.you = message.you;
        // A fresh seat means a fresh loadout: take the server's word again.
        this.weaponAdopted = false;
        this.lastResult = null;
        if (message.role === 'spectator') {
          this.showToast('The room was full — you are watching.', 'info');
        }
        return;

      case 'lobby': {
        this.lastResult = null;
        const seats = new Map<string, string>();
        for (const player of message.players) {
          if (player.bot != null) seats.set(player.id, player.bot);
        }
        this.botSeats = seats;
        return;
      }

      case 'turnTimer':
        this.setTimer({
          turnNumber: message.turnNumber,
          remainingMs: message.remainingMs,
          durationMs: message.durationMs,
          receivedAt: Date.now(),
        });
        return;

      case 'chat': {
        const tank = this.snapshot?.tanks.find((candidate) => candidate.id === message.playerId);
        this.chat.said(
          message.name,
          message.text,
          tank === undefined ? null : colorCss(tank.colorIndex),
        );
        return;
      }

      case 'spectators':
        this.lobby.renderSpectators(message.count, message.viewers);
        return;

      case 'host':
        if (message.reason !== 'assigned') {
          this.chat.system(
            message.hostId === null
              ? 'The room has no host.'
              : message.hostId === this.you
                ? 'You are the host now.'
                : 'The host changed.',
          );
        }
        return;

      case 'matchResult': {
        this.lastResult = {
          winnerId: message.winnerId,
          roundsPlayed: message.roundsPlayed,
          standings: [...message.standings],
        };
        /*
         * The server sends this right after the turn that ended the match, so
         * it normally lands while the last explosion is still animating and is
         * already in hand when the panel is drawn. But nothing guarantees that
         * order — with no scene to animate, the snapshot is applied
         * immediately and the panel would render from the fallback ranking and
         * then never hear the real standings. Redraw if it is already up.
         */
        const snapshot = this.snapshot;
        if (this.screen === 'gameover' && snapshot !== null) this.renderGameOver(snapshot);
        return;
      }

      case 'events':
        this.narrate(message);
        return;

      default:
        return;
    }
  }

  /** Turn the turn's events into the one-line commentary a player would want. */
  private narrate(message: Extract<ServerMessage, { t: 'events' }>): void {
    for (const event of message.events) {
      if (event.type === 'timeout') {
        const name = message.snapshot.tanks[event.tankIndex]?.name ?? 'Someone';
        this.chat.system(`${name} ran out of time.`);
      }
      if (event.type === 'roundEnd') {
        const survivors = event.survivors
          .map((id) => message.snapshot.tanks.find((tank) => tank.id === id)?.name)
          .filter((name): name is string => name !== undefined);
        this.chat.system(
          survivors.length === 0
            ? `Round ${event.round}: everyone died.`
            : `Round ${event.round} to ${survivors.join(', ')}.`,
        );
      }
      if (event.type === 'damage' && event.healthAfter <= 0) {
        const name = message.snapshot.tanks[event.tankIndex]?.name ?? 'Someone';
        this.chat.system(`${name} is out.`);
      }
    }
  }

  /**
   * The connection light, and the banner that appears when it goes out.
   *
   * The banner is deliberately persistent rather than a toast: "reconnecting"
   * is a state a player is living in, not a notification they missed.
   */
  private onConnectionStatus(status: ConnectionStatus): void {
    this.hud.setConnection(status);

    if (status === 'connecting') {
      this.weaponAdopted = false;
      return;
    }

    if (status === 'open') {
      const wasDown = !this.connBanner.hidden;
      this.connBanner.hidden = true;
      if (wasDown) {
        this.chat.system('Reconnected.');
        this.showToast('Reconnected.', 'info');
      }
      return;
    }

    if (this.screen === 'title') {
      this.connBanner.hidden = true;
      return;
    }

    this.connBanner.hidden = false;
    this.connBanner.dataset['state'] = status;
    this.connBanner.textContent =
      status === 'reconnecting'
        ? 'Connection lost — reconnecting. Your seat is held.'
        : 'Disconnected.';
  }

  // ------------------------------------------------------------- turn clock

  private setTimer(state: TimerState | null): void {
    this.timer = state;
    if (state === null) {
      this.hud.setTimer(null);
      if (this.clockTimer !== null) {
        window.clearInterval(this.clockTimer);
        this.clockTimer = null;
      }
      return;
    }

    this.paintClock();
    this.clockTimer ??= window.setInterval(() => this.paintClock(), CLOCK_TICK_MS);
  }

  /**
   * Count the server's figure down locally.
   *
   * `remainingMs` is relative on purpose (see the protocol) — the server is the
   * only clock that decides anything. This just keeps the readout moving
   * between frames; the number is re-anchored every time one arrives.
   */
  private paintClock(): void {
    const state = this.timer;
    if (state === null) return;
    const elapsed = Date.now() - state.receivedAt;
    this.hud.setTimer({
      remainingMs: Math.max(0, state.remainingMs - elapsed),
      durationMs: state.durationMs,
    });
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
