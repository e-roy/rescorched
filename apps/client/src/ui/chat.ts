/**
 * Chat, and the running commentary the room generates on its own.
 *
 * During a match it floats over the top right of the playfield, input always
 * showing, in one of two states. COLLAPSED puts a click-through feed of the last
 * few lines under the input, each fading out on its own — held while the box
 * has focus, so a player about to reply can still read what they are replying
 * to. EXPANDED is a panel with the whole log.
 *
 * Its input is never focused by surprise: the aiming keys are arrows and Space,
 * so a text box that quietly stole focus would make a player's next shot go
 * nowhere. Press T to talk, Escape to go back to aiming.
 *
 * In the LOBBY it moves into the lobby panel instead (`dock`). The lobby is
 * where strangers from the public browser meet and arrange a game, and a
 * four-line strip at the bottom of the window was the wrong size for that
 * conversation. It is one element either way — moved, not copied — so the log
 * a player was reading comes with them onto the battlefield.
 */

import { MAX_CHAT_CHARS } from '@scorched/protocol';
import { el, must } from './dom.ts';

export interface ChatCallbacks {
  onSend(text: string): void;
}

/** Lines kept in the log. Old ones are dropped so a long match cannot grow forever. */
const MAX_LINES = 60;

export class ChatView {
  private readonly callbacks: ChatCallbacks;
  private readonly root = must<HTMLDivElement>('#chat');
  private readonly log = must<HTMLDivElement>('#chat-log');
  private readonly input = must<HTMLInputElement>('#chat-input');
  private readonly form = must<HTMLFormElement>('#chat-form');
  private readonly toggle = must<HTMLButtonElement>('#chat-toggle');
  private readonly unreadBadge = must<HTMLSpanElement>('#chat-unread');
  /** Lines people said while the log was collapsed, for the badge on the button. */
  private unread = 0;
  /** Where the chat lives when it is not docked in a panel. */
  private readonly home: { parent: Node; anchor: Node | null };

  constructor(callbacks: ChatCallbacks) {
    this.callbacks = callbacks;
    this.input.maxLength = MAX_CHAT_CHARS;
    const parent = this.root.parentNode;
    if (parent === null) throw new Error('The chat must start in the document');
    this.home = { parent, anchor: this.root.nextSibling };

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      this.input.value = '';
      if (text.length === 0) {
        this.input.blur();
        return;
      }
      this.callbacks.onSend(text);
      this.input.blur();
    });

    this.toggle.addEventListener('click', () => {
      this.setExpanded(this.root.dataset['expanded'] !== 'true');
      // A click leaves focus on the button, and Space on a focused button
      // presses it rather than firing. Hand the keyboard back to aiming.
      this.toggle.blur();
    });

    // While the box has focus the recent lines stop fading; see `styles.css`.
    this.form.addEventListener('focusin', () => this.setComposing(true));
    this.form.addEventListener('focusout', (event) => {
      if (!this.form.contains(event.relatedTarget as Node | null)) this.setComposing(false);
    });

    this.input.addEventListener('keydown', (event) => {
      // The window-level aiming keys already ignore events from inputs; this
      // stops Escape bubbling anywhere else and hands focus back to the game.
      if (event.key === 'Escape') {
        this.input.value = '';
        this.input.blur();
        event.stopPropagation();
      }
    });
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    if (!visible) {
      this.input.blur();
      this.setExpanded(false);
    }
  }

  /** Open the whole log over the playfield, or fold it back to the fading feed. */
  setExpanded(expanded: boolean): void {
    this.root.dataset['expanded'] = String(expanded);
    this.toggle.setAttribute('aria-expanded', String(expanded));
    this.toggle.title = expanded ? 'Hide the chat log' : 'Show the whole chat log';
    if (expanded) {
      this.unread = 0;
      this.renderUnread();
      this.log.scrollTop = this.log.scrollHeight;
    }
  }

  /**
   * Move the chat into `slot`, or back over the playfield when `slot` is null.
   *
   * Focus survives the move: re-parenting an element blurs it, and a player
   * mid-sentence when the lobby turns into a match should not have to click
   * back into the box.
   */
  dock(slot: HTMLElement | null): void {
    const target = slot ?? this.home.parent;
    if (this.root.parentNode === target) return;

    const typing = document.activeElement === this.input;
    if (slot === null) this.home.parent.insertBefore(this.root, this.home.anchor);
    else slot.append(this.root);

    const docked = slot !== null;
    this.root.classList.toggle('chat--docked', docked);
    // The lobby panel is always "expanded"; leaving it starts the match folded.
    if (docked) this.setExpanded(false);
    this.input.placeholder = docked ? 'Say something to the room' : 'Press T to talk';
    if (typing) this.input.focus();
  }

  /** Start a clean log — a different room is a different conversation. */
  clear(): void {
    this.log.replaceChildren();
    this.unread = 0;
    this.renderUnread();
  }

  /** Focus the box, reporting whether there was one to focus. */
  focusInput(): boolean {
    if (this.root.hidden) return false;
    this.input.focus();
    return true;
  }

  /** `mine` is a line this player sent, which is never unread. */
  said(name: string, text: string, color: string | null, mine = false): void {
    const line = el('div', { className: 'chat__line' });
    const who = el('span', { className: 'chat__who', text: `${name}: ` });
    if (color !== null) who.style.color = color;
    line.append(who, el('span', { text }));
    this.push(line);
    if (!mine && !this.isOpen()) {
      this.unread += 1;
      this.renderUnread();
    }
  }

  /** Room events — joins, host changes, timeouts — in the same stream as chat. */
  system(text: string): void {
    this.push(el('div', { className: 'chat__line chat__line--system', text }));
  }

  private isOpen(): boolean {
    return this.root.classList.contains('chat--docked') || this.root.dataset['expanded'] === 'true';
  }

  private setComposing(composing: boolean): void {
    this.root.dataset['composing'] = String(composing);
  }

  private renderUnread(): void {
    this.unreadBadge.hidden = this.unread === 0;
    this.unreadBadge.textContent = this.unread > 99 ? '99+' : String(this.unread);
  }

  private push(line: HTMLElement): void {
    this.log.append(line);
    while (this.log.childElementCount > MAX_LINES) {
      this.log.firstElementChild?.remove();
    }
    this.log.scrollTop = this.log.scrollHeight;
  }
}
