/**
 * The waiting room.
 *
 * One job above all others: make the four-letter room code impossible to miss
 * and trivial to pass on. Everything else — who is in, who is host, who is
 * ready, who dropped — hangs off that.
 */

import type { LobbyPlayer, Spectator } from '@scorched/protocol';
import { el, must } from './dom.ts';
import { colorCss, listNames } from './format.ts';

export interface LobbyCallbacks {
  onStart(): void;
  onReady(ready: boolean): void;
  onLeave(): void;
  onCopied(message: string): void;
}

/** Two is the floor the server enforces; the button says so before it refuses. */
const MIN_PLAYERS = 2;

export class LobbyView {
  private readonly callbacks: LobbyCallbacks;

  private readonly codeOut = must<HTMLSpanElement>('#lobby-code');
  private readonly list = must<HTMLUListElement>('#lobby-players');
  private readonly hint = must<HTMLParagraphElement>('#lobby-hint');
  private readonly spectatorLine = must<HTMLParagraphElement>('#lobby-spectators');
  private readonly startButton = must<HTMLButtonElement>('#btn-start');
  private readonly readyButton = must<HTMLButtonElement>('#btn-ready');
  private readonly copyButton = must<HTMLButtonElement>('#btn-copy');
  private readonly errorLine = must<HTMLParagraphElement>('#lobby-error');

  private roomCode = '';
  private ready = false;

  constructor(callbacks: LobbyCallbacks) {
    this.callbacks = callbacks;

    this.startButton.addEventListener('click', () => this.callbacks.onStart());
    must<HTMLButtonElement>('#btn-leave').addEventListener('click', () => this.callbacks.onLeave());

    this.readyButton.addEventListener('click', () => {
      this.ready = !this.ready;
      this.paintReady();
      this.callbacks.onReady(this.ready);
    });

    this.copyButton.addEventListener('click', () => {
      void this.copyInvite();
    });
  }

  /**
   * Put a joinable link on the clipboard, falling back to the bare code.
   *
   * Clipboard access can be refused outright (insecure context, denied
   * permission), and a Copy button that silently does nothing is worse than one
   * that admits it — so the failure path tells the player what to type instead.
   */
  private async copyInvite(): Promise<void> {
    const link = `${window.location.origin}/?room=${this.roomCode}`;
    try {
      await navigator.clipboard.writeText(link);
      this.callbacks.onCopied('Invite link copied.');
    } catch {
      this.callbacks.onCopied(`Copy failed — read out the code: ${this.roomCode}`);
    }
  }

  reset(): void {
    this.ready = false;
    this.paintReady();
    this.errorLine.hidden = true;
  }

  showError(message: string): void {
    this.errorLine.textContent = message;
    this.errorLine.hidden = false;
  }

  private paintReady(): void {
    this.readyButton.setAttribute('aria-pressed', this.ready ? 'true' : 'false');
    this.readyButton.textContent = this.ready ? 'Ready ✓' : 'Ready';
  }

  render(
    roomCode: string,
    players: readonly LobbyPlayer[],
    hostId: string | null,
    you: string,
  ): void {
    this.roomCode = roomCode;
    this.codeOut.textContent = roomCode;

    // Keep our own toggle honest if the server's view of us disagrees — a
    // reconnect resets the seat, and the button must not claim otherwise.
    const me = players.find((player) => player.id === you);
    if (me !== undefined && me.ready !== this.ready) {
      this.ready = me.ready;
      this.paintReady();
    }

    this.list.replaceChildren(...players.map((player) => this.row(player, hostId, you)));

    const missing = MIN_PLAYERS - players.length;
    const youAreHost = hostId === null || hostId === you;
    this.hint.textContent =
      missing > 0
        ? `Waiting for ${missing} more ${missing === 1 ? 'player' : 'players'}. Anyone with the code can walk in.`
        : youAreHost
          ? `${players.length} in. Start when you are happy with the room.`
          : `${players.length} in. Only the host can start the match.`;

    this.startButton.disabled = players.length < MIN_PLAYERS || !youAreHost;
    this.startButton.title = this.startButton.disabled
      ? youAreHost
        ? 'At least two players are needed'
        : 'Only the host can start'
      : 'Start the match';
  }

  private row(player: LobbyPlayer, hostId: string | null, you: string): HTMLLIElement {
    const li = el('li', { testId: `lobby-player-${player.id}` });
    li.dataset['playerId'] = player.id;
    if (!player.connected) li.classList.add('is-away');

    const swatch = el('span', { className: 'swatch' });
    swatch.style.background = colorCss(player.colorIndex);

    const name = el('span', {
      text: player.id === you ? `${player.name} (you)` : player.name,
    });

    li.append(swatch, name, el('span', { className: 'spacer' }));

    if (player.id === hostId) li.append(el('span', { className: 'tag tag--host', text: 'Host' }));
    if (!player.connected) {
      li.append(el('span', { className: 'tag tag--away', text: 'Dropped' }));
    } else if (player.ready) {
      li.append(el('span', { className: 'tag tag--ready', text: 'Ready' }));
    }

    return li;
  }

  /** Spectators are listed separately so the player list stays a list of players. */
  renderSpectators(count: number, viewers: readonly Spectator[]): void {
    if (count === 0) {
      this.spectatorLine.hidden = true;
      return;
    }
    const names = viewers.map((viewer) => viewer.name);
    const shown = listNames(names);
    const extra = count - names.length;
    this.spectatorLine.hidden = false;
    this.spectatorLine.textContent =
      names.length === 0
        ? `${count} watching.`
        : extra > 0
          ? `Watching: ${shown} and ${extra} more.`
          : `Watching: ${shown}.`;
  }
}
