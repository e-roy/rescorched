/**
 * The waiting room.
 *
 * One job above all others: make the four-letter room code impossible to miss
 * and trivial to pass on. Everything else — who is in, who is host, who is
 * ready, who dropped — hangs off that.
 *
 * The second job, which is the one that decides whether a person who opens this
 * game alone ever plays it: seating a computer player. Note what this file does
 * NOT do. It does not check whether the room has a seat spare, it does not check
 * whether the seat being removed is a person, and it does not decide whether the
 * asker is allowed to ask. All three are the Durable Object's to answer
 * (`handleAddBot` / `handleRemoveBot`), and a copy of any of them here would be
 * a rule that can disagree with the server. What this file does instead is send
 * the frame and show the refusal — see `expectServerReply`.
 */

import type { BotPersonality, LobbyPlayer, Spectator } from '@scorched/protocol';
import { isBotPersonality } from '@scorched/sim';
import { el, must } from './dom.ts';
import { colorCss, listNames } from './format.ts';
import {
  badgeText,
  blurbOf,
  describeSeat,
  LADDER,
  LADDER_STEPS,
  optionLabel,
  rankOf,
  SPECIALISTS,
} from './bots.ts';

export interface LobbyCallbacks {
  onStart(): void;
  onReady(ready: boolean): void;
  onLeave(): void;
  onCopied(message: string): void;
  /** Ask the room to seat a computer player. It may say no. */
  onAddBot(personality: BotPersonality): void;
  /** Ask the room to free a seat a computer player is in. It may say no. */
  onRemoveBot(playerId: string): void;
}

/** Two is the floor the server enforces; the button says so before it refuses. */
const MIN_PLAYERS = 2;

/**
 * Which computer player the picker opens on.
 *
 * The Shooter, matching the server's own `DEFAULT_BOT_PERSONALITY`. It is the
 * one that aims properly and ignores the wind, so a first-time player loses to
 * something they can see how to beat. The two ends agreeing is cosmetic — the
 * client always names the personality explicitly — but a picker that opens on
 * one bot while the server would have seated another is a small lie.
 */
const DEFAULT_PERSONALITY: BotPersonality = 'shooter';

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

  private readonly botBar = must<HTMLDivElement>('#lobby-bots');
  private readonly botSelect = must<HTMLSelectElement>('#select-bot-personality');
  private readonly addBotButton = must<HTMLButtonElement>('#btn-add-bot');
  private readonly botBlurb = must<HTMLParagraphElement>('#bot-blurb');
  private readonly botBlurbText = must<HTMLSpanElement>('#bot-blurb-text');
  private readonly botSkill = must<HTMLSpanElement>('#bot-skill');

  private roomCode = '';
  private ready = false;

  /**
   * Bot frames sent whose answer has not come back yet.
   *
   * This is what lets a refusal be shown next to the button that earned it
   * instead of as a generic toast — and, more than cosmetically, what stops a
   * `room_full` earned by clicking "Add computer" in a full room being mistaken
   * for a `room_full` earned by trying to JOIN a full room, which throws the
   * player back to the title screen. Only an error arriving while we are waiting
   * on an answer is claimed. See `consumeError`.
   */
  private pendingBotReplies = 0;

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

    // How much of the list fits is a function of the window, so the answer is
    // re-measured when the window changes rather than only when the room does.
    window.addEventListener('resize', () => this.paintOverflow());

    this.buildBotPicker();
    this.botSelect.addEventListener('change', () => this.paintBotBlurb());
    this.addBotButton.addEventListener('click', () => {
      this.errorLine.hidden = true;
      this.expectServerReply();
      this.callbacks.onAddBot(this.chosenPersonality());
    });
  }

  // ------------------------------------------------------- computer players

  /**
   * Fill the picker from the sim's own two groups.
   *
   * Two `<optgroup>`s, because the roster is two different kinds of thing and a
   * flat list said otherwise: four ranked difficulties whose order a test
   * measures, then the two that are different rather than harder. Built from
   * `BOT_DIFFICULTY_LADDER` and `BOT_SPECIALISTS` rather than written out in
   * the markup, so the client cannot hold an opinion about the ordering that
   * the sim's measurements do not — and a seventh personality lands in this
   * menu, in the right group, with no client change at all.
   */
  private buildBotPicker(): void {
    const option = (personality: BotPersonality): HTMLOptionElement => {
      const node = document.createElement('option');
      node.value = personality;
      node.textContent = optionLabel(personality);
      node.title = blurbOf(personality).long;
      return node;
    };
    const group = (label: string, members: readonly BotPersonality[]): HTMLOptGroupElement => {
      const node = document.createElement('optgroup');
      node.label = label;
      node.append(...members.map(option));
      return node;
    };

    this.botSelect.replaceChildren(
      group(`Difficulty — 1 to ${LADDER_STEPS}`, LADDER),
      group('Different, not harder', SPECIALISTS),
    );
    this.botSelect.value = DEFAULT_PERSONALITY;
    this.paintBotBlurb();
  }

  private chosenPersonality(): BotPersonality {
    const chosen = this.botSelect.value;
    return isBotPersonality(chosen) ? chosen : DEFAULT_PERSONALITY;
  }

  /** The difficulty meter and the sentence, repainted whenever the choice changes. */
  private paintBotBlurb(): void {
    const personality = this.chosenPersonality();
    const rank = rankOf(personality);

    /*
     * A meter for the four that have a measured position, and the word
     * SPECIALIST for the two that do not. Painting four grey pips for a Tosser
     * would read as "difficulty zero", which is the opposite of true.
     */
    this.botSkill.replaceChildren(
      ...(rank === null
        ? [el('span', { className: 'skill__tag', text: 'Specialist' })]
        : Array.from({ length: LADDER_STEPS }, (_unused, index) => {
            const pip = el('span', { className: 'skill__pip' });
            if (index < rank) pip.classList.add('skill__pip--on');
            return pip;
          })),
    );
    this.botSkill.title =
      rank === null ? 'Not on the difficulty ladder' : `Difficulty ${rank} of ${LADDER_STEPS}`;
    this.botBlurbText.textContent = blurbOf(personality).long;
    this.botBlurb.dataset['rank'] = rank === null ? 'none' : String(rank);
  }

  /**
   * Note that a bot frame is in flight, so the next refusal can be attributed.
   *
   * Bounded, because nothing guarantees an answer: a frame dropped on a closing
   * socket never produces either an error or a lobby frame, and an unbounded
   * counter would leave every later error being claimed by this panel forever.
   */
  private expectServerReply(): void {
    this.pendingBotReplies = Math.min(this.pendingBotReplies + 1, 4);
  }

  /**
   * Show a server refusal that one of our own bot frames earned, if it is ours.
   *
   * Returns whether it was claimed. The caller (the `Ui`) treats a claimed error
   * as fully handled — no toast, and no bouncing back to the title screen.
   */
  consumeError(message: string): boolean {
    if (this.pendingBotReplies === 0) return false;
    this.pendingBotReplies -= 1;
    this.showError(message);
    return true;
  }

  /** A lobby frame is the answer to whatever we asked for. */
  private settle(): void {
    this.pendingBotReplies = 0;
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

  /*
   * There was a `reset()` here that nothing called. It is gone rather than
   * carried forward with a new line added to it: `render()` already re-syncs the
   * Ready toggle from the server's own view of the seat, and `settle()` already
   * runs on every lobby frame, so the only thing it could still have done was
   * clear the error line — which every path that could set one clears first.
   */

  showError(message: string): void {
    this.errorLine.textContent = message;
    this.errorLine.hidden = false;
  }

  /**
   * Say whether the seat list has more in it than is on screen.
   *
   * The panel is capped at the height of the stage and the list is the part
   * that gives, which is what keeps the buttons and the refusal line reachable
   * in a full room. The cost of that is a list that can run out of view, and a
   * row cut off at a hard edge reads as a rendering fault rather than as "there
   * is more below" — the armoury fades its own scroll region for exactly this
   * reason.
   *
   * It is measured rather than guessed from the seat count, because how many
   * rows fit depends on the window: eight is a scrolling list at 720 and a
   * complete one at 1000. `data-more` drives the fade in the stylesheet, and
   * `solo-bot.spec.ts` asserts both states rather than the fade.
   */
  private paintOverflow(): void {
    const hidden = this.list.scrollHeight - this.list.clientHeight > 1;
    this.list.dataset['more'] = hidden ? '1' : '0';
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
    // A lobby frame is the room's answer to whatever was last asked of it.
    this.settle();

    // Keep our own toggle honest if the server's view of us disagrees — a
    // reconnect resets the seat, and the button must not claim otherwise.
    const me = players.find((player) => player.id === you);
    if (me !== undefined && me.ready !== this.ready) {
      this.ready = me.ready;
      this.paintReady();
    }

    const youAreHost = hostId === null || hostId === you;
    this.list.replaceChildren(
      ...players.map((player) => this.row(player, hostId, you, youAreHost)),
    );
    this.paintOverflow();

    /*
     * Adding a seat changes the match everyone else is about to be dealt into,
     * so the server allows it to the host only. Hiding the control for everyone
     * else mirrors what the Start button already does with the same rule, and
     * costs nothing: a non-host who sends the frame anyway is refused, which is
     * where the rule actually lives.
     */
    this.botBar.hidden = !youAreHost;
    this.botBlurb.hidden = !youAreHost;

    const missing = MIN_PLAYERS - players.length;
    this.hint.textContent =
      missing > 0
        ? youAreHost
          ? `Waiting for ${missing} more ${missing === 1 ? 'player' : 'players'} — add a computer player below, or read out the code.`
          : `Waiting for ${missing} more ${missing === 1 ? 'player' : 'players'}. Anyone with the code can walk in.`
        : youAreHost
          ? `${players.length} in. Start when you are happy with the room.`
          : `${players.length} in. Only the host can start the match.`;

    this.startButton.disabled = players.length < MIN_PLAYERS || !youAreHost;
    this.startButton.title = this.startButton.disabled
      ? youAreHost
        ? 'At least two players are needed — a computer player counts'
        : 'Only the host can start'
      : 'Start the match';
  }

  private row(
    player: LobbyPlayer,
    hostId: string | null,
    you: string,
    youAreHost: boolean,
  ): HTMLLIElement {
    const li = el('li', { testId: `lobby-player-${player.id}` });
    li.dataset['playerId'] = player.id;
    if (!player.connected) li.classList.add('is-away');

    const bot = player.bot ?? null;
    if (bot !== null) li.classList.add('is-bot');

    const swatch = el('span', { className: 'swatch' });
    swatch.style.background = colorCss(player.colorIndex);

    const name = el('span', {
      className: 'playerlist__name',
      text: player.id === you ? `${player.name} (you)` : player.name,
    });

    li.append(swatch, name, el('span', { className: 'spacer' }));

    if (player.id === hostId) li.append(el('span', { className: 'tag tag--host', text: 'Host' }));

    if (bot !== null) {
      /*
       * Nobody should have to wonder who they are playing. The badge says the
       * seat is a machine, names which of the six it is, and gives its rung on
       * the measured ladder — or the word "specialist" for the two that have no
       * honest rung. The tooltip says what it actually does.
       */
      li.append(
        el('span', {
          className: 'tag tag--bot',
          text: `CPU · ${badgeText(bot)}`,
          title: `${describeSeat(bot)}. ${blurbOf(bot).long}`,
        }),
      );
      if (youAreHost) li.append(this.removeButton(player));
      // A computer player is always ready and never drops, so neither tag says
      // anything about it that the CPU badge has not already said.
      return li;
    }

    if (!player.connected) {
      li.append(el('span', { className: 'tag tag--away', text: 'Dropped' }));
    } else if (player.ready) {
      li.append(el('span', { className: 'tag tag--ready', text: 'Ready' }));
    }

    return li;
  }

  private removeButton(player: LobbyPlayer): HTMLButtonElement {
    const button = el('button', {
      className: 'rowbtn',
      testId: `btn-remove-bot-${player.id}`,
      text: '✕',
      title: `Remove ${player.name}`,
    });
    button.type = 'button';
    button.setAttribute('aria-label', `Remove ${player.name}`);
    button.addEventListener('click', () => {
      this.errorLine.hidden = true;
      this.expectServerReply();
      this.callbacks.onRemoveBot(player.id);
    });
    return button;
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
