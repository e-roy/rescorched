/**
 * GameRoom — one Durable Object per match.
 *
 * Authoritative: clients send inputs, this runs the sim, this broadcasts what
 * happened. A client's own opinion about where a shell landed is never trusted.
 *
 * Uses the **WebSocket Hibernation API** (`ctx.acceptWebSocket`, not
 * `server.accept()`). That is what makes a turn-based game nearly free to host:
 * while everyone is thinking, the object is evicted from memory and bills
 * nothing, then wakes on the next frame with its sockets intact.
 *
 * Because it hibernates, NOTHING may live only in instance fields. Anything
 * that must survive is either in `ctx.storage` (SQLite) or attached to the
 * socket via `serializeAttachment`.
 */

import {
  encodeServerMessage,
  parseClientMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerErrorCode,
  type ServerMessage,
} from '@scorched/protocol';
import {
  buy,
  createGame,
  everyoneHasShopped,
  fire,
  fromPersisted,
  IllegalMoveError,
  leaveShop,
  sell,
  startNextRound,
  toPersisted,
  toSnapshot,
  type GameEvent,
  type GameState,
  type PersistedGame,
} from '@scorched/sim';

import { generateSessionId, seedFromRoom } from './room-code.ts';

export const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;

/** Per-socket data that must survive hibernation. */
interface SocketAttachment {
  playerId: string;
  name: string;
}

interface RateBucket {
  /** Wall-clock ms the current window opened. */
  windowStartedAt: number;
  remaining: number;
}

interface RoomPlayer {
  id: string;
  name: string;
  ready: boolean;
  colorIndex: number;
}

type RateBucketKind = 'chatter' | 'action';

interface RoomMeta {
  roomCode: string;
  hostId: string | null;
  gameNonce: number;
}

const DEFAULT_META: RoomMeta = { roomCode: '', hostId: null, gameNonce: 0 };

/**
 * Token buckets, per player, per 10 second window.
 *
 * Chatter is generous because aiming is genuinely chatty and costs nothing.
 * Actions are tight because they are the only frames that can change the game.
 */
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_BUDGETS: Record<RateBucketKind, number> = {
  chatter: 400,
  action: 40,
};

/** Cosmetic frames: dropped silently when over budget, never an error. */
function isChatter(type: ClientMessage['t']): boolean {
  return type === 'aim' || type === 'ping';
}

export class GameRoom implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly sql: SqlStorage;

  /**
   * In-memory only, and deliberately so — see `consumeRateLimit`. This is the
   * one piece of state the room is happy to lose when it hibernates.
   */
  private readonly rateBuckets = new Map<string, RateBucket>();

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;

    // Runs on every wake-up, including after hibernation. Cheap and idempotent.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS replay (
        turn INTEGER PRIMARY KEY,
        events TEXT NOT NULL
      );
    `);
  }

  // -------------------------------------------------------------------------
  // HTTP entry point: the WebSocket upgrade.
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/ws')) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }

      const roomCode = url.searchParams.get('room') ?? '';
      const meta = this.readMeta();
      if (meta.roomCode === '') {
        this.writeMeta({ ...meta, roomCode });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      // Hibernation API. The runtime holds the socket while we are evicted.
      this.ctx.acceptWebSocket(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith('/info')) {
      const meta = this.readMeta();
      const players = this.readPlayers();
      return Response.json({
        roomCode: meta.roomCode,
        players: players.length,
        maxPlayers: MAX_PLAYERS,
        inProgress: this.readGame() !== null,
      });
    }

    return new Response('Not found', { status: 404 });
  }

  // -------------------------------------------------------------------------
  // Hibernation handlers.
  // -------------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Binary frames are not part of the protocol. Reject rather than guess.
    if (typeof message !== 'string') {
      this.sendError(ws, 'bad_message', 'Binary frames are not supported');
      return;
    }

    const parsed = parseClientMessage(message);
    if (!parsed.ok) {
      this.sendError(ws, 'bad_message', parsed.error);
      return;
    }

    try {
      await this.handleMessage(ws, parsed.value);
    } catch (error) {
      if (error instanceof IllegalMoveError) {
        this.sendError(ws, toErrorCode(error.code), error.message);
        return;
      }
      // An unexpected throw must not take the room down for everyone else.
      console.error('GameRoom handler failed', error);
      this.sendError(ws, 'internal', 'Something went wrong handling that message');
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    void code;
    void reason;
    void wasClean;
    const attachment = readAttachment(ws);
    if (attachment !== null) {
      // The player stays in the room so they can reconnect mid-game and
      // resume their tank. Only the socket goes away.
      this.broadcastLobby();
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    void ws;
    console.error('GameRoom socket error', error);
  }

  // -------------------------------------------------------------------------
  // Message handling.
  // -------------------------------------------------------------------------

  private async handleMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    if (message.t === 'hello') {
      this.handleHello(ws, message);
      return;
    }

    const attachment = readAttachment(ws);
    if (attachment === null) {
      this.sendError(ws, 'bad_protocol', 'Send `hello` before anything else');
      return;
    }

    /*
     * Two buckets, not one.
     *
     * `aim` and `ping` are chatter: a player nudging the angle key emits a
     * stream of them, and none of them change the game. `fire`, `buy` and
     * friends are the moves that matter. Sharing one budget means a player who
     * adjusts their aim a lot gets their SHOT silently rejected — which is
     * exactly the bug this split exists to prevent. Chatter over budget is
     * dropped quietly; a rejected move always gets told why.
     */
    if (isChatter(message.t)) {
      if (!this.consumeRateLimit(attachment.playerId, 'chatter')) return;
    } else if (!this.consumeRateLimit(attachment.playerId, 'action')) {
      this.sendError(ws, 'rate_limited', 'Slow down');
      return;
    }

    switch (message.t) {
      case 'ping':
        this.send(ws, { t: 'pong', nonce: message.nonce });
        return;

      case 'ready': {
        const players = this.readPlayers();
        const player = players.find((candidate) => candidate.id === attachment.playerId);
        if (player !== undefined) {
          player.ready = message.ready;
          this.writePlayers(players);
          this.broadcastLobby();
        }
        return;
      }

      case 'start':
        this.handleStart(ws, attachment.playerId);
        return;

      case 'aim': {
        // Aim is cosmetic — it just lets opponents watch the barrel move.
        this.broadcast(
          {
            t: 'aim',
            playerId: attachment.playerId,
            angleDeg: message.angleDeg,
            power: message.power,
            weapon: message.weapon,
          },
          ws,
        );
        return;
      }

      case 'fire':
        this.handleFire(ws, attachment.playerId, message);
        return;

      case 'buy':
      case 'sell':
      case 'shopDone':
        this.handleShop(ws, attachment.playerId, message);
        return;

      case 'chat':
        this.broadcast({
          t: 'chat',
          playerId: attachment.playerId,
          name: attachment.name,
          text: message.text,
        });
        return;

      default: {
        // Exhaustiveness guard: adding a message type without handling it here
        // becomes a compile error.
        const never: never = message;
        void never;
      }
    }
  }

  private handleHello(ws: WebSocket, message: Extract<ClientMessage, { t: 'hello' }>): void {
    if (message.protocol !== PROTOCOL_VERSION) {
      this.sendError(ws, 'bad_protocol', `Server speaks protocol ${PROTOCOL_VERSION}`);
      return;
    }

    const players = this.readPlayers();
    const meta = this.readMeta();

    // Reconnect path: a known session id reclaims its seat, tank and money.
    let player = message.sessionId
      ? players.find((candidate) => candidate.id === message.sessionId)
      : undefined;

    if (player === undefined) {
      if (this.readGame() !== null) {
        // Late joiners may spectate, but cannot take a tank mid-match.
        this.sendError(ws, 'wrong_phase', 'That match has already started');
        return;
      }
      if (players.length >= MAX_PLAYERS) {
        this.sendError(ws, 'room_full', `This room is full (${MAX_PLAYERS} players)`);
        return;
      }
      player = {
        id: generateSessionId(),
        name: message.name,
        ready: false,
        colorIndex: nextFreeColor(players),
      };
      players.push(player);
    } else {
      player.name = message.name;
    }

    if (meta.hostId === null) {
      this.writeMeta({ ...meta, hostId: player.id });
    }
    this.writePlayers(players);

    ws.serializeAttachment({ playerId: player.id, name: player.name } satisfies SocketAttachment);

    this.send(ws, {
      t: 'welcome',
      protocol: PROTOCOL_VERSION,
      sessionId: player.id,
      roomCode: this.readMeta().roomCode || 'AAAA',
      you: player.id,
    });

    this.broadcastLobby();

    // Reconnecting into a live match: hand over the authoritative state at once.
    const game = this.readGame();
    if (game !== null) {
      this.send(ws, { t: 'state', snapshot: toSnapshot(game) });
    }
  }

  private handleStart(ws: WebSocket, playerId: string): void {
    const meta = this.readMeta();
    if (meta.hostId !== null && meta.hostId !== playerId) {
      this.sendError(ws, 'wrong_phase', 'Only the host can start the match');
      return;
    }
    if (this.readGame() !== null) {
      this.sendError(ws, 'wrong_phase', 'The match has already started');
      return;
    }

    const players = this.readPlayers();
    if (players.length < MIN_PLAYERS) {
      this.sendError(ws, 'no_players', `Need at least ${MIN_PLAYERS} players`);
      return;
    }

    const nonce = meta.gameNonce + 1;
    this.writeMeta({ ...meta, gameNonce: nonce });

    const state = createGame(
      { seed: seedFromRoom(meta.roomCode || 'AAAA', nonce), totalRounds: 5 },
      players.map((player) => ({
        id: player.id,
        name: player.name,
        colorIndex: player.colorIndex,
      })),
    );

    this.writeGame(state);
    this.broadcast({ t: 'state', snapshot: toSnapshot(state) });
  }

  private handleFire(
    ws: WebSocket,
    playerId: string,
    message: Extract<ClientMessage, { t: 'fire' }>,
  ): void {
    const game = this.readGame();
    if (game === null) {
      this.sendError(ws, 'wrong_phase', 'No match in progress');
      return;
    }

    // Throws IllegalMoveError for anything illegal; caller turns that into an
    // `error` frame and the authoritative state is left untouched.
    const result = fire(game, playerId, {
      turnNumber: message.turnNumber,
      angleDeg: message.angleDeg,
      power: message.power,
      weapon: message.weapon,
    });

    this.writeGame(result.state);
    this.recordReplay(game.turnNumber, result.events);

    this.broadcast({
      t: 'events',
      turnNumber: game.turnNumber,
      events: result.events as ServerEventPayload,
      snapshot: toSnapshot(result.state),
    });
  }

  private handleShop(
    ws: WebSocket,
    playerId: string,
    message: Extract<ClientMessage, { t: 'buy' | 'sell' | 'shopDone' }>,
  ): void {
    const game = this.readGame();
    if (game === null) {
      this.sendError(ws, 'wrong_phase', 'No match in progress');
      return;
    }

    let next: GameState;
    if (message.t === 'buy') {
      next = buy(game, playerId, message.weapon, message.quantity).state;
    } else if (message.t === 'sell') {
      next = sell(game, playerId, message.weapon).state;
    } else {
      next = leaveShop(game, playerId);
    }

    if (everyoneHasShopped(next)) {
      const rolled = startNextRound(next);
      this.writeGame(rolled.state);
      this.broadcast({
        t: 'events',
        turnNumber: rolled.state.turnNumber,
        events: rolled.events as ServerEventPayload,
        snapshot: toSnapshot(rolled.state),
      });
      return;
    }

    this.writeGame(next);
    // A purchase only changes the buyer's wallet, but the snapshot is small and
    // sending it to everyone keeps every client's view identical by construction.
    this.broadcast({ t: 'state', snapshot: toSnapshot(next) });
  }

  // -------------------------------------------------------------------------
  // Broadcast helpers.
  // -------------------------------------------------------------------------

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(encodeServerMessage(message));
    } catch (error) {
      console.error('Failed to send frame', error);
    }
  }

  private sendError(ws: WebSocket, code: ServerErrorCode, message: string): void {
    this.send(ws, { t: 'error', code, message: message.slice(0, 300) });
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    const encoded = encodeServerMessage(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try {
        socket.send(encoded);
      } catch (error) {
        console.error('Failed to broadcast frame', error);
      }
    }
  }

  private broadcastLobby(): void {
    const meta = this.readMeta();
    const players = this.readPlayers();
    const connected = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (attachment !== null) connected.add(attachment.playerId);
    }

    this.broadcast({
      t: 'lobby',
      roomCode: meta.roomCode || 'AAAA',
      hostId: meta.hostId,
      players: players.map((player) => ({
        id: player.id,
        name: player.name,
        ready: player.ready,
        connected: connected.has(player.id),
        colorIndex: player.colorIndex,
      })),
    });
  }

  // -------------------------------------------------------------------------
  // Storage. Everything here survives hibernation and eviction.
  // -------------------------------------------------------------------------

  private readKv<T>(key: string, fallback: T): T {
    const rows = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', key).toArray();
    const row = rows[0];
    if (row === undefined) return fallback;
    try {
      return JSON.parse(row.v) as T;
    } catch {
      return fallback;
    }
  }

  private writeKv(key: string, value: unknown): void {
    this.sql.exec(
      'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      key,
      JSON.stringify(value),
    );
  }

  private readMeta(): RoomMeta {
    return this.readKv<RoomMeta>('meta', DEFAULT_META);
  }

  private writeMeta(meta: RoomMeta): void {
    this.writeKv('meta', meta);
  }

  private readPlayers(): RoomPlayer[] {
    return this.readKv<RoomPlayer[]>('players', []);
  }

  private writePlayers(players: RoomPlayer[]): void {
    this.writeKv('players', players);
  }

  private readGame(): GameState | null {
    const persisted = this.readKv<PersistedGame | null>('game', null);
    return persisted === null ? null : fromPersisted(persisted);
  }

  private writeGame(state: GameState): void {
    this.writeKv('game', toPersisted(state));
  }

  private recordReplay(turn: number, events: readonly GameEvent[]): void {
    this.sql.exec(
      'INSERT INTO replay (turn, events) VALUES (?, ?) ON CONFLICT(turn) DO UPDATE SET events = excluded.events',
      turn,
      JSON.stringify(events),
    );
  }

  /**
   * Token bucket per player, per kind.
   *
   * Held in memory on purpose. Persisting it would mean a storage read AND
   * write for every single frame — hundreds of SQL round trips just to watch
   * someone move their turret, on an object whose whole economic argument is
   * that it does nothing while players think.
   *
   * Losing the buckets to hibernation is not a loophole: the object only
   * hibernates when nobody is sending anything, and a player who has been
   * silent long enough to evict the room has, by definition, stopped flooding.
   *
   * Uses `Date.now()` — legitimate here: this is the server, and rate limiting
   * is explicitly about wall-clock time. The ban on clocks applies to
   * `packages/sim`, which must stay reproducible.
   */
  private consumeRateLimit(playerId: string, kind: RateBucketKind): boolean {
    const key = `${playerId}:${kind}`;
    const now = Date.now();
    let bucket = this.rateBuckets.get(key);

    if (bucket === undefined || now - bucket.windowStartedAt > RATE_LIMIT_WINDOW_MS) {
      bucket = { windowStartedAt: now, remaining: RATE_LIMIT_BUDGETS[kind] };
      this.rateBuckets.set(key, bucket);
    }

    if (bucket.remaining <= 0) return false;

    bucket.remaining -= 1;
    return true;
  }
}

/** The protocol's event array type, structurally satisfied by sim's GameEvent[]. */
type ServerEventPayload = Extract<ServerMessage, { t: 'events' }>['events'];

function readAttachment(ws: WebSocket): SocketAttachment | null {
  const raw = ws.deserializeAttachment() as unknown;
  if (raw === null || typeof raw !== 'object') return null;
  const candidate = raw as Partial<SocketAttachment>;
  if (typeof candidate.playerId !== 'string' || typeof candidate.name !== 'string') return null;
  return { playerId: candidate.playerId, name: candidate.name };
}

function nextFreeColor(players: readonly RoomPlayer[]): number {
  const used = new Set(players.map((player) => player.colorIndex));
  for (let index = 0; index < MAX_PLAYERS; index += 1) {
    if (!used.has(index)) return index;
  }
  return players.length;
}

const ERROR_CODES = new Set<string>([
  'bad_message',
  'bad_protocol',
  'room_full',
  'not_your_turn',
  'stale_turn',
  'wrong_phase',
  'bad_angle',
  'bad_power',
  'no_ammo',
  'unknown_weapon',
  'insufficient_funds',
  'bad_quantity',
  'not_for_sale',
  'nothing_to_sell',
  'unknown_player',
  'no_players',
  'no_active_tank',
  'rate_limited',
  'internal',
]);

function toErrorCode(code: string): ServerErrorCode {
  return (ERROR_CODES.has(code) ? code : 'internal') as ServerErrorCode;
}
