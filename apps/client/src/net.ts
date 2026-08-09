/**
 * WebSocket transport.
 *
 * Every inbound frame is validated with the @scorched/protocol Zod schemas
 * before it reaches game code, and every outbound frame is validated on the way
 * out. Reconnect is automatic with backoff, and carries the session id so the
 * server can hand back the same tank mid-match.
 */

import {
  encodeClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from '@scorched/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface NetHandlers {
  onMessage(message: ServerMessage): void;
  onStatus(status: ConnectionStatus): void;
  /** A frame arrived that failed schema validation — never silently ignored. */
  onProtocolError(detail: string): void;
}

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000];

// ---------------------------------------------------------------------------
// A second, read-only tap on the same stream.
//
// `NetHandlers` is owned by whoever constructs the client — one consumer, and it
// drives the game. But the DOM overlay also needs frames the game loop does not
// care about: chat lines, the turn clock, spectator counts, host migration, the
// final scoreboard. Threading those through the constructor would make every
// caller responsible for forwarding messages it has no opinion about.
//
// So this is a broadcast, not a second handler slot: listeners observe, they
// never answer. A listener that throws is logged and skipped, because a broken
// chat panel must not cost anyone a turn.
// ---------------------------------------------------------------------------

export type NetEvent =
  { kind: 'message'; message: ServerMessage } | { kind: 'status'; status: ConnectionStatus };

export type NetListener = (event: NetEvent) => void;

const listeners = new Set<NetListener>();

/** Observe every frame and status change. Returns an unsubscribe function. */
export function subscribeNet(listener: NetListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(event: NetEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error('Net listener threw', error);
    }
  }
}

let current: NetClient | null = null;

/**
 * The client for the room this tab is in, or null when it is in no room.
 *
 * Exists so a UI module can send the frames it owns end to end — a chat line, a
 * ready toggle — without every such message needing a callback plumbed down
 * from the entry point.
 */
export function activeNet(): NetClient | null {
  return current;
}

function setActiveNet(client: NetClient | null): void {
  current = client;
}

function clearActiveNet(client: NetClient): void {
  if (current === client) current = null;
}

export class NetClient {
  private socket: WebSocket | null = null;
  private readonly handlers: NetHandlers;
  private readonly roomCode: string;
  private playerName: string;
  private sessionId: string | null;
  private reconnectAttempt = 0;
  private closedByUs = false;
  private reconnectTimer: number | null = null;
  /** Frames queued while the socket is down; flushed on reconnect. */
  private readonly outbox: ClientMessage[] = [];

  constructor(roomCode: string, playerName: string, handlers: NetHandlers) {
    this.roomCode = roomCode.toUpperCase();
    this.playerName = playerName;
    this.handlers = handlers;
    this.sessionId = readStoredSession(this.roomCode);
    setActiveNet(this);
  }

  get room(): string {
    return this.roomCode;
  }

  /** Tell the owner and every observer at once, so the two can never disagree. */
  private emitStatus(status: ConnectionStatus): void {
    this.handlers.onStatus(status);
    publish({ kind: 'status', status });
  }

  connect(): void {
    this.closedByUs = false;
    setActiveNet(this);
    this.emitStatus(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/api/rooms/${this.roomCode}/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.emitStatus('open');
      this.sendNow({
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        name: this.playerName,
        ...(this.sessionId !== null ? { sessionId: this.sessionId } : {}),
      });
      while (this.outbox.length > 0) {
        const queued = this.outbox.shift();
        if (queued !== undefined) this.sendNow(queued);
      }
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        this.handlers.onProtocolError('Received a non-text frame');
        return;
      }
      const parsed = parseServerMessage(event.data);
      if (!parsed.ok) {
        this.handlers.onProtocolError(parsed.error);
        return;
      }
      if (parsed.value.t === 'welcome') {
        this.sessionId = parsed.value.sessionId;
        storeSession(this.roomCode, parsed.value.sessionId);
      }
      // The owner sees it first: it is the one that updates authoritative
      // state, and an observer reading that state must not see it stale.
      this.handlers.onMessage(parsed.value);
      publish({ kind: 'message', message: parsed.value });
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      if (this.closedByUs) {
        this.emitStatus('closed');
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 'close' always follows; reconnect is handled there.
    });
  }

  private scheduleReconnect(): void {
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 8000;
    this.reconnectAttempt += 1;
    this.emitStatus('reconnecting');
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Queue-and-send. Frames sent while offline are replayed on reconnect. */
  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendNow(message);
      return;
    }
    // Aim updates are cosmetic and go stale instantly — never queue them.
    if (message.t !== 'aim' && message.t !== 'ping') {
      this.outbox.push(message);
    }
  }

  private sendNow(message: ClientMessage): void {
    try {
      this.socket?.send(encodeClientMessage(message));
    } catch (error) {
      this.handlers.onProtocolError(
        error instanceof Error ? error.message : 'Failed to encode message',
      );
    }
  }

  setName(name: string): void {
    this.playerName = name;
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const wasOpen = this.socket !== null;
    this.socket?.close(1000, 'Left the room');
    this.socket = null;
    clearActiveNet(this);
    // A socket that was already down fires no 'close' event, so say so here
    // rather than leaving observers showing a link that no longer exists.
    if (!wasOpen) this.emitStatus('closed');
  }
}

function sessionKey(roomCode: string): string {
  return `scorched:session:${roomCode}`;
}

function readStoredSession(roomCode: string): string | null {
  try {
    return window.localStorage.getItem(sessionKey(roomCode));
  } catch {
    // Private browsing / disabled storage — reconnect simply won't restore a seat.
    return null;
  }
}

function storeSession(roomCode: string, sessionId: string): void {
  try {
    window.localStorage.setItem(sessionKey(roomCode), sessionId);
  } catch {
    // Non-fatal.
  }
}

/** Ask the Worker for a fresh room code. */
export async function createRoom(): Promise<string> {
  const response = await fetch('/api/rooms', { method: 'POST' });
  if (!response.ok) throw new Error(`Could not create a room (HTTP ${response.status})`);
  const data = (await response.json()) as { roomCode?: unknown };
  if (typeof data.roomCode !== 'string' || !/^[A-Z]{4}$/.test(data.roomCode)) {
    throw new Error('Server returned an invalid room code');
  }
  return data.roomCode;
}
