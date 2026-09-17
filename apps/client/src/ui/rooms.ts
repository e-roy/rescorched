/**
 * Public rooms, on the title screen.
 *
 * The first thing a person opening the game should be able to tell is whether
 * anybody is playing. So the title screen carries a live card beside the
 * console: how many public rooms there are, the first few worth joining, and
 * the rest on request, expanded in place. Quick start is then one click either
 * way — Create room on the left, Join on the right — with no second screen to
 * find and no code to be read out loud.
 *
 * It decides nothing. Whether there is a seat, whether the match has started
 * and whether a room is still there at all are the room's to answer when the
 * player arrives. The listing is a picture of a moment, so Join is an offer,
 * not a promise: a room that filled up since the last refresh seats the player
 * as a spectator, and one that closed says "no room" on this same screen.
 *
 * It polls only while the title screen is up and the tab is visible, and has no
 * refresh button: the list keeps itself current, and a control that only does
 * what is already happening is one more thing to read on a screen whose job is
 * to get somebody into a game. Every
 * visitor looking at the title screen costs the directory one request per
 * interval, so the interval is slower than a dedicated browser page would use,
 * and a tab in the background costs nothing at all.
 */

import type { PublicRoom } from '@scorched/protocol';
import { listPublicRooms } from '../net.ts';
import { el, must } from './dom.ts';

export interface RoomsCallbacks {
  onJoin(roomCode: string): void;
  /** Host a public room straight from the empty state. */
  onCreatePublic(): void;
}

/**
 * Rooms shown before the player asks for more: enough to pick from at a
 * glance, few enough that the card never grows past the console beside it.
 * The server already sorts somewhere-you-can-sit first, so these are the best
 * few rather than an arbitrary few.
 */
const COLLAPSED_ROOMS = 3;

/** How often a visible title screen re-reads the list. */
const REFRESH_MS = 10_000;

export class RoomsView {
  private readonly callbacks: RoomsCallbacks;

  private readonly root = must<HTMLElement>('#title-rooms');
  private readonly live = must<HTMLSpanElement>('#title-rooms-live');
  private readonly summary = must<HTMLParagraphElement>('#title-rooms-summary');
  private readonly list = must<HTMLUListElement>('#title-rooms-list');
  private readonly empty = must<HTMLDivElement>('#title-rooms-empty');
  private readonly errorLine = must<HTMLParagraphElement>('#title-rooms-error');
  private readonly moreButton = must<HTMLButtonElement>('#btn-rooms-more');

  private open = false;
  private expanded = false;
  /** Null until the first answer arrives, so "nobody is playing" is never shown before it is known. */
  private rooms: readonly PublicRoom[] | null = null;
  private timer: number | null = null;
  /**
   * Which request is the latest. A slow answer to an old request must not paint
   * over a newer one, and nothing at all may be painted once the screen closed.
   */
  private generation = 0;

  constructor(callbacks: RoomsCallbacks) {
    this.callbacks = callbacks;

    must<HTMLButtonElement>('#btn-rooms-create').addEventListener('click', () =>
      this.callbacks.onCreatePublic(),
    );
    this.moreButton.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.paint();
    });

    // Coming back to a tab that sat in the background: whatever it last showed
    // is stale, so ask at once rather than at the next tick.
    document.addEventListener('visibilitychange', () => {
      if (this.open && !document.hidden) void this.refresh();
    });
  }

  start(): void {
    if (this.open) return;
    this.open = true;
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop(): void {
    if (!this.open) return;
    this.open = false;
    this.generation += 1;
    // Back on the title screen later, the card starts compact again.
    this.expanded = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refresh(): Promise<void> {
    if (!this.open || document.hidden) return;
    this.generation += 1;
    const ticket = this.generation;
    this.root.setAttribute('aria-busy', 'true');
    try {
      const rooms = await listPublicRooms();
      if (ticket !== this.generation) return;
      this.rooms = rooms;
      this.errorLine.hidden = true;
      this.paint();
    } catch (error) {
      if (ticket !== this.generation) return;
      // The last good list stays up: a blip should not empty the card.
      this.errorLine.textContent =
        error instanceof Error ? error.message : 'Could not load public rooms';
      this.errorLine.hidden = false;
    } finally {
      if (ticket === this.generation) this.root.removeAttribute('aria-busy');
    }
  }

  private paint(): void {
    const rooms = this.rooms;
    if (rooms === null) return;

    const total = rooms.length;
    const open = rooms.filter((room) => statusOf(room) === 'open').length;
    const full = rooms.filter((room) => statusOf(room) === 'full').length;
    const playing = rooms.filter((room) => statusOf(room) === 'playing').length;

    this.root.dataset['state'] = total === 0 ? 'empty' : 'rooms';
    this.live.textContent = `${total} live`;

    const parts = [
      ...(open > 0 ? [`${open} ${open === 1 ? 'lobby' : 'lobbies'} waiting for players`] : []),
      ...(full > 0 ? [`${full} full`] : []),
      ...(playing > 0 ? [`${playing} ${playing === 1 ? 'match' : 'matches'} in progress`] : []),
    ];
    this.summary.textContent =
      total === 0 ? 'Nobody is hosting a public game right now.' : `${parts.join(' · ')}.`;

    const shown = this.expanded ? rooms : rooms.slice(0, COLLAPSED_ROOMS);
    this.list.replaceChildren(...shown.map((room) => this.row(room)));
    this.list.dataset['total'] = String(total);
    this.list.hidden = total === 0;
    this.empty.hidden = total > 0;

    const hiddenCount = total - shown.length;
    this.moreButton.hidden = total <= COLLAPSED_ROOMS;
    this.moreButton.setAttribute('aria-expanded', this.expanded ? 'true' : 'false');
    this.moreButton.textContent = this.expanded
      ? 'Show fewer'
      : `Show all ${total} rooms (${hiddenCount} more)`;
  }

  private row(room: PublicRoom): HTMLLIElement {
    const status = statusOf(room);
    const li = el('li', { testId: `public-room-${room.roomCode}` });
    li.dataset['status'] = status;

    const info = el('div', { className: 'roomlist__info' });
    const title = el('div', { className: 'roomlist__title' });
    title.append(
      el('span', { className: 'roomlist__host', text: `${room.hostName}'s room` }),
      el('span', { className: 'roomlist__code', text: room.roomCode }),
    );

    const meta = el('div', { className: 'roomlist__meta' });
    meta.append(
      el('span', {
        className: 'roomlist__tag',
        text: status === 'open' ? 'Lobby' : status === 'full' ? 'Full' : 'In play',
      }),
      el('span', {
        text: `${room.players}/${room.maxPlayers} seats${room.bots > 0 ? ` · ${room.bots} CPU` : ''}`,
      }),
    );
    info.append(title, meta);

    // Anybody who cannot take a seat is still welcome to watch — the room seats
    // them as a spectator on its own. The button just says so before they click.
    const seat = status === 'open';
    const join = el('button', {
      className: seat ? 'btn btn--primary' : 'btn',
      testId: `btn-join-${room.roomCode}`,
      text: seat ? 'Join' : 'Watch',
      title: seat
        ? `Take a seat in ${room.hostName}'s lobby`
        : status === 'full'
          ? 'Every seat is taken — you will watch'
          : 'The match has started — you will watch until it ends',
    });
    join.type = 'button';
    join.addEventListener('click', () => this.callbacks.onJoin(room.roomCode));

    li.append(info, join);
    return li;
  }
}

function statusOf(room: PublicRoom): 'open' | 'full' | 'playing' {
  if (room.status === 'playing') return 'playing';
  return room.players >= room.maxPlayers ? 'full' : 'open';
}
