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
  }

  get room(): string {
    return this.roomCode;
  }

  connect(): void {
    this.closedByUs = false;
    this.handlers.onStatus(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/api/rooms/${this.roomCode}/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.handlers.onStatus('open');
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
      this.handlers.onMessage(parsed.value);
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      if (this.closedByUs) {
        this.handlers.onStatus('closed');
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
    this.handlers.onStatus('reconnecting');
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
    this.socket?.close(1000, 'Left the room');
    this.socket = null;
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
