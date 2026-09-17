/**
 * Chat, and the running commentary the room generates on its own.
 *
 * It docks under the stage during a match, and its input is never focused by
 * surprise: the aiming keys are arrows and Space, so a text box that quietly
 * stole focus would make a player's next shot go nowhere. Press T to talk,
 * Escape to go back to aiming.
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
    if (!visible) this.input.blur();
  }

  /**
   * Move the chat into `slot`, or back under the stage when `slot` is null.
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
    this.input.placeholder = docked ? 'Say something to the room' : 'Press T to talk';
    if (typing) this.input.focus();
  }

  /** Start a clean log — a different room is a different conversation. */
  clear(): void {
    this.log.replaceChildren();
  }

  /** Focus the box, reporting whether there was one to focus. */
  focusInput(): boolean {
    if (this.root.hidden) return false;
    this.input.focus();
    return true;
  }

  said(name: string, text: string, color: string | null): void {
    const line = el('div', { className: 'chat__line' });
    const who = el('span', { className: 'chat__who', text: `${name}: ` });
    if (color !== null) who.style.color = color;
    line.append(who, el('span', { text }));
    this.push(line);
  }

  /** Room events — joins, host changes, timeouts — in the same stream as chat. */
  system(text: string): void {
    this.push(el('div', { className: 'chat__line chat__line--system', text }));
  }

  private push(line: HTMLElement): void {
    this.log.append(line);
    while (this.log.childElementCount > MAX_LINES) {
      this.log.firstElementChild?.remove();
    }
    this.log.scrollTop = this.log.scrollHeight;
  }
}
