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
 * socket via `serializeAttachment`. The single deliberate exception is the
 * rate-limit buckets — see the comment on `consumeRateLimit`.
 *
 * The room owns *lifecycle* decisions: who holds a seat, who is host, when the
 * clock takes a turn away, when a match nobody is playing gets abandoned. It
 * owns no *game rules*. Whether a shot is legal, what it damages and whose turn
 * comes next all come from `@scorched/sim`, and the room's only way to make
 * something happen in a match is to hand the sim an input.
 */

import {
  encodeServerMessage,
  MAX_SPECTATORS_LISTED,
  parseClientMessage,
  PROTOCOL_VERSION,
  ServerErrorCodeSchema,
  type ClientMessage,
  type ServerErrorCode,
  type ServerMessage,
} from '@scorched/protocol';
import {
  BABY_MISSILE,
  buy,
  createGame,
  everyoneHasShopped,
  fire,
  fromPersisted,
  IllegalMoveError,
  leaveShop,
  matchStandings,
  sell,
  startNextRound,
  toPersisted,
  toSnapshot,
  type GameEvent,
  type GamePhase,
  type GameState,
  type PersistedGame,
} from '@scorched/sim';

import { generateSessionId, seedFromRoom } from './room-code.ts';

/**
 * Seats in a room. The protocol and the sim both allow 16; eight is a *room*
 * policy — a sixteen-tank board leaves each player waiting fifteen turns
 * between shots. Nothing below depends on the number.
 */
export const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;

/**
 * Spectators cost a copy of every broadcast, so they are capped, and the total
 * socket count is capped again on top: a room with unbounded sockets is a room
 * where one script turns every `events` frame into megabytes of fan-out.
 */
export const MAX_SPECTATORS = 16;
const MAX_SOCKETS = MAX_PLAYERS + MAX_SPECTATORS;

/**
 * Turn clock.
 *
 * A player who closes their laptop on their own turn must not freeze the match
 * forever, so every turn is backed by a Durable Object alarm. The alarm is set
 * once per turn — never per frame — and a DO holds at most one alarm, so
 * arming the next turn's clock silently cancels the current one. A turn played
 * normally therefore costs exactly one `setAlarm`, and no wake-up at all.
 *
 * The shop gets longer because reading an arsenal takes longer than picking an
 * angle.
 */
const TURN_TIMEOUT_MS = 60_000;
const SHOP_TIMEOUT_MS = 120_000;

/**
 * How many turns in a row the clock may decide before the room gives up on the
 * match. Without a cap, two idle-but-connected browsers would have the room
 * wake every minute for the rest of the match — the exact standing cost
 * hibernation exists to remove.
 */
const MAX_CONSECUTIVE_TIMEOUTS = 3;

/**
 * The replay log is a ring buffer, not an archive: enough history to inspect
 * the match being played, capped so a long-lived room cannot grow without
 * bound. Nothing in the game reads further back than the current match.
 */
const MAX_REPLAY_ROWS = 200;

/** Per-socket data that must survive hibernation. */
interface SocketAttachment {
  /**
   * Identifies the *connection*. Assigned when the socket is accepted, before
   * anything is known about who is on the other end, so that pre-`hello` frames
   * have something to be rate-limited against.
   */
  connId: string;
  /** Null until `hello` succeeds. For a spectator, an id with no seat behind it. */
  playerId: string | null;
  name: string;
  spectator: boolean;
}

/** A socket that has completed `hello`, so it has an identity to act with. */
type JoinedAttachment = SocketAttachment & { playerId: string };

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

/**
 * A deliberately tiny mirror of the parts of the game state the *room* needs to
 * reason about. Reading it costs a point query and a ~150 byte parse; reading
 * the game costs rebuilding a 1280-column heightmap. `aim` frames arrive by the
 * hundred, so the difference is the whole reason this row exists.
 */
interface TurnInfo {
  turnNumber: number;
  /** Whose turn it is, or null when nobody is aiming. */
  activeId: string | null;
  phase: GamePhase;
  /** Consecutive turns decided by the clock rather than by a player. */
  timeoutStreak: number;
  /** The last turn the clock took away, so a late `fire` can be told why. */
  expiredTurn: number | null;
  /** Wall-clock ms this turn runs out, or null when no clock is running. */
  deadlineAt: number | null;
}

const DEFAULT_META: RoomMeta = { roomCode: '', hostId: null, gameNonce: 0 };
const NO_TURN: TurnInfo = {
  turnNumber: 0,
  activeId: null,
  phase: 'lobby',
  timeoutStreak: 0,
  expiredTurn: null,
  deadlineAt: null,
};

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

/** How long the clock gives a player in this phase, or null for no clock. */
function clockFor(phase: GamePhase): number | null {
  if (phase === 'aiming') return TURN_TIMEOUT_MS;
  if (phase === 'shopping') return SHOP_TIMEOUT_MS;
  return null;
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
    //
    // `replay` (the original) keyed rows by turn number alone, so a rematch in
    // the same room overwrote the previous match's log turn for turn. It is
    // dropped rather than migrated: it held debug history and nothing else.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      DROP TABLE IF EXISTS replay;
      CREATE TABLE IF NOT EXISTS replay_v2 (
        seq INTEGER PRIMARY KEY,
        match INTEGER NOT NULL,
        turn INTEGER NOT NULL,
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

      // Hibernating sockets count here, which is the point: the cap is on
      // connections the room is responsible for, not on ones currently awake.
      if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
        return new Response('Too many connections to this room', { status: 503 });
      }

      const roomCode = url.searchParams.get('room') ?? '';
      const meta = this.readMeta();
      if (meta.roomCode === '' && roomCode !== '') {
        this.writeMeta({ ...meta, roomCode });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      // Hibernation API. The runtime holds the socket while we are evicted.
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        connId: generateSessionId(),
        playerId: null,
        name: '',
        spectator: false,
      } satisfies SocketAttachment);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith('/info')) {
      const meta = this.readMeta();
      return Response.json({
        roomCode: meta.roomCode,
        players: this.readPlayers().length,
        maxPlayers: MAX_PLAYERS,
        spectators: this.countSpectators(),
        inProgress: this.matchInProgress(),
        phase: this.readTurnInfo().phase,
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
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const attachment = readAttachment(ws);
    if (attachment === null || attachment.playerId === null) return;

    if (attachment.spectator) {
      this.broadcastSpectators(ws);
      return;
    }

    const playerId = attachment.playerId;
    const left = !this.matchInProgress();
    if (left) {
      // Before the match starts a departure frees the seat. Otherwise eight
      // people who looked in and left would leave the room permanently full.
      // Once the match is running the seat is held: it is a tank, some money
      // and an inventory, and its owner is expected back.
      this.writePlayers(this.readPlayers().filter((player) => player.id !== playerId));
    }

    this.promoteHostIfNeeded(left ? 'host_left' : 'host_disconnected', ws);
    this.broadcastLobby(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    void ws;
    console.error('GameRoom socket error', error);
  }

  /**
   * The turn clock fired.
   *
   * Everything here is decided from storage, never from an instance field: the
   * object has almost certainly been evicted since the alarm was set.
   */
  async alarm(): Promise<void> {
    const game = this.readGame();
    if (game === null || clockFor(game.phase) === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    // Nobody is waiting on this turn. Re-arming would wake the room every
    // minute forever for an audience of nobody — precisely the standing cost
    // the hibernation API exists to remove. `hello` restarts the clock when
    // someone comes back.
    if (!this.hasConnectedPlayer()) return;

    const streak = this.readTurnInfo().timeoutStreak + 1;
    if (streak > MAX_CONSECUTIVE_TIMEOUTS) {
      await this.abandonMatch();
      return;
    }

    try {
      if (game.phase === 'shopping') await this.forceShopEnd(game, streak);
      else await this.forceTurn(game, streak);
    } catch (error) {
      // The clock must never be able to wedge a room. If the forced move is
      // somehow illegal, drop the match rather than leave a live alarm loop.
      console.error('GameRoom turn timeout failed', error);
      await this.abandonMatch();
    }
  }

  // -------------------------------------------------------------------------
  // Message handling.
  // -------------------------------------------------------------------------

  private async handleMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    const attachment = this.ensureAttachment(ws);

    /*
     * Two buckets, not one.
     *
     * `aim` and `ping` are chatter: a player nudging the angle key emits a
     * stream of them, and none of them change the game. `fire`, `buy` and
     * friends are the moves that matter. Sharing one budget means a player who
     * adjusts their aim a lot gets their SHOT silently rejected — which is
     * exactly the bug this split exists to prevent. Chatter over budget is
     * dropped quietly; a rejected move always gets told why.
     *
     * Frames that arrive before `hello` are limited against the connection
     * rather than the player, so an unidentified socket cannot flood for free.
     */
    const rateKey = attachment.playerId ?? attachment.connId;
    if (isChatter(message.t)) {
      if (!this.consumeRateLimit(rateKey, 'chatter')) return;
    } else if (!this.consumeRateLimit(rateKey, 'action')) {
      this.sendError(ws, 'rate_limited', 'Slow down');
      return;
    }

    if (message.t === 'hello') {
      await this.handleHello(ws, attachment, message);
      return;
    }

    if (attachment.playerId === null) {
      this.sendError(ws, 'bad_protocol', 'Send `hello` before anything else');
      return;
    }
    const joined = attachment as JoinedAttachment;

    switch (message.t) {
      case 'ping':
        this.send(ws, { t: 'pong', nonce: message.nonce });
        return;

      case 'ready': {
        if (this.rejectSpectator(ws, joined)) return;
        if (this.matchInProgress()) {
          this.sendError(ws, 'wrong_phase', 'The match has already started');
          return;
        }
        const players = this.readPlayers();
        const player = players.find((candidate) => candidate.id === joined.playerId);
        if (player === undefined) {
          this.sendError(ws, 'unknown_player', 'You are not seated in this room');
          return;
        }
        // Re-sending the same value is a no-op: no storage write, no broadcast.
        // A client that repeats itself must not cost the room anything.
        if (player.ready === message.ready) return;
        player.ready = message.ready;
        this.writePlayers(players);
        this.broadcastLobby();
        return;
      }

      case 'start':
        await this.handleStart(ws, joined);
        return;

      case 'aim': {
        // Aim is cosmetic — it just lets opponents watch the barrel move. Only
        // the active player has a barrel worth watching, so everyone else's aim
        // frames are dropped instead of being fanned out to the whole room.
        const info = this.readTurnInfo();
        if (info.phase !== 'aiming' || info.activeId !== joined.playerId) return;
        this.broadcast(
          {
            t: 'aim',
            playerId: joined.playerId,
            angleDeg: message.angleDeg,
            power: message.power,
            weapon: message.weapon,
          },
          ws,
        );
        return;
      }

      case 'fire':
        await this.handleFire(ws, joined, message);
        return;

      case 'buy':
      case 'sell':
      case 'shopDone':
        await this.handleShop(ws, joined, message);
        return;

      case 'chat':
        this.broadcast({
          t: 'chat',
          playerId: joined.playerId,
          name: joined.name,
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

  private async handleHello(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { t: 'hello' }>,
  ): Promise<void> {
    if (message.protocol !== PROTOCOL_VERSION) {
      this.sendError(ws, 'bad_protocol', `Server speaks protocol ${PROTOCOL_VERSION}`);
      return;
    }

    // A second `hello` on a socket that already joined is a re-sync, never a
    // second seat. Without this, one connection could quietly claim every slot
    // in the room by saying hello eight times.
    if (attachment.playerId !== null) {
      if (message.sessionId !== undefined && message.sessionId !== attachment.playerId) {
        this.sendError(ws, 'bad_protocol', 'This connection has already joined as someone else');
        return;
      }
      this.sendWelcome(ws, attachment);
      this.sendLiveState(ws);
      return;
    }

    const players = this.readPlayers();
    const seat =
      message.sessionId !== undefined
        ? players.find((candidate) => candidate.id === message.sessionId)
        : undefined;

    if (seat !== undefined && message.role !== 'spectator') {
      // Reconnect: the seat, and with it the tank, the money and the inventory.
      // A rename is accepted only between matches — the name on the tank is
      // baked into every snapshot already broadcast, and two names for one
      // player is worse than a stale one.
      if (!this.matchInProgress() && seat.name !== message.name) {
        seat.name = message.name;
        this.writePlayers(players);
      }
      const joined = this.attach(ws, attachment, seat.id, seat.name, false);
      this.promoteHostIfNeeded('promoted');
      this.sendWelcome(ws, joined);
      this.broadcastLobby();
      // Restart the clock BEFORE handing over the state, so the timer that
      // arrives with it is the real deadline rather than a stopped one.
      await this.restartClockIfStopped();
      this.sendLiveState(ws);
      return;
    }

    // Everyone else watches: someone who asked to spectate, someone who arrived
    // after the first shot, and someone the lobby has no seat left for. They
    // receive the authoritative state and every broadcast, but they are not in
    // `players`, so the sim can never deal them a tank and every move they try
    // is refused.
    const wantsToWatch =
      message.role === 'spectator' || this.matchInProgress() || players.length >= MAX_PLAYERS;

    if (wantsToWatch) {
      if (this.countSpectators() >= MAX_SPECTATORS) {
        this.sendError(ws, 'room_full', 'This room has no seats and no room left to watch');
        return;
      }
      const joined = this.attach(ws, attachment, `spec-${attachment.connId}`, message.name, true);
      this.sendWelcome(ws, joined);
      this.sendLiveState(ws);
      this.broadcastSpectators();
      // Deliberately no clock restart: an audience is not a player, and a room
      // with nobody left to take a turn should stay asleep.
      return;
    }

    const player: RoomPlayer = {
      id: generateSessionId(),
      name: message.name,
      ready: false,
      colorIndex: nextFreeColor(players),
    };
    players.push(player);
    this.writePlayers(players);

    const joined = this.attach(ws, attachment, player.id, player.name, false);
    this.promoteHostIfNeeded('assigned');
    this.sendWelcome(ws, joined);
    this.broadcastLobby();
    // A finished match is still worth seeing: whoever walks in next gets the
    // final board rather than an empty screen.
    this.sendLiveState(ws);
  }

  private async handleStart(ws: WebSocket, attachment: JoinedAttachment): Promise<void> {
    if (this.rejectSpectator(ws, attachment)) return;

    const meta = this.readMeta();
    if (meta.hostId !== null && meta.hostId !== attachment.playerId) {
      this.sendError(ws, 'not_host', 'Only the host can start the match');
      return;
    }
    // A finished match is not an in-progress one: `start` is also how a rematch
    // begins, on fresh terrain with a fresh seed.
    if (this.matchInProgress()) {
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
    this.writeKv('wins', {});

    const state = createGame(
      { seed: seedFromRoom(meta.roomCode || 'AAAA', nonce), totalRounds: 5 },
      players.map((player) => ({
        id: player.id,
        name: player.name,
        colorIndex: player.colorIndex,
      })),
    );

    await this.commitState(state, { timeoutStreak: 0, expiredTurn: null });
    this.broadcast({ t: 'state', snapshot: toSnapshot(state) });
    this.broadcastTurnTimer(state);
  }

  private async handleFire(
    ws: WebSocket,
    attachment: JoinedAttachment,
    message: Extract<ClientMessage, { t: 'fire' }>,
  ): Promise<void> {
    if (this.rejectSpectator(ws, attachment)) return;

    const game = this.readGame();
    if (game === null || game.phase === 'gameover') {
      this.sendError(ws, 'wrong_phase', 'No match in progress');
      return;
    }

    // A shot for a turn the clock already took deserves a straight answer.
    // Left to the sim it comes back as `not_your_turn` or `stale_turn`, both of
    // which read like an accusation of cheating to someone whose only mistake
    // was a slow reconnect.
    const info = this.readTurnInfo();
    if (message.turnNumber !== info.turnNumber && message.turnNumber === info.expiredTurn) {
      this.sendError(ws, 'turn_expired', 'Your turn ran out of time');
      return;
    }

    // Throws IllegalMoveError for anything illegal, and the authoritative state
    // is left untouched — the sim clones only after every check passes.
    const result = fire(game, attachment.playerId, {
      turnNumber: message.turnNumber,
      angleDeg: message.angleDeg,
      power: message.power,
      weapon: message.weapon,
    });

    await this.commitTurn(game.turnNumber, result.state, result.events, {
      timeoutStreak: 0,
      expiredTurn: null,
    });
  }

  private async handleShop(
    ws: WebSocket,
    attachment: JoinedAttachment,
    message: Extract<ClientMessage, { t: 'buy' | 'sell' | 'shopDone' }>,
  ): Promise<void> {
    if (this.rejectSpectator(ws, attachment)) return;
    const playerId = attachment.playerId;

    const game = this.readGame();
    if (game === null || game.phase === 'gameover') {
      this.sendError(ws, 'wrong_phase', 'No match in progress');
      return;
    }

    if (message.t === 'buy' || message.t === 'sell') {
      const next =
        message.t === 'buy'
          ? buy(game, playerId, message.weapon, message.quantity).state
          : sell(game, playerId, message.weapon).state;

      // The clock is not restarted: shopping fast should not buy you more time,
      // and re-arming per purchase would be a storage write per click.
      this.writeKv('game', toPersisted(next));
      // A purchase moves one wallet. Broadcasting a full snapshot — which
      // carries the entire heightmap — to everyone for a transaction nobody
      // else can see is pure waste; the whole room is resynchronised anyway the
      // moment the next round starts.
      this.send(ws, { t: 'state', snapshot: toSnapshot(next) });
      return;
    }

    if (game.phase !== 'shopping') {
      this.sendError(ws, 'wrong_phase', 'The shop is not open');
      return;
    }
    if (!game.pendingShoppers.includes(playerId)) {
      // Already done, or never in this match. Idempotent: a repeat costs no
      // storage write and no broadcast, it just gets the state back.
      this.send(ws, { t: 'state', snapshot: toSnapshot(game) });
      return;
    }

    const next = leaveShop(game, playerId);
    if (everyoneHasShopped(next)) {
      const rolled = startNextRound(next);
      await this.commitTurn(rolled.state.turnNumber, rolled.state, rolled.events, {
        timeoutStreak: 0,
        expiredTurn: null,
      });
      return;
    }

    this.writeKv('game', toPersisted(next));
    // Who is still shopping is everyone's business — this one does broadcast.
    this.broadcast({ t: 'state', snapshot: toSnapshot(next) });
  }

  // -------------------------------------------------------------------------
  // Turn clock.
  // -------------------------------------------------------------------------

  /**
   * The active player ran out of time.
   *
   * The sim exposes no "skip a turn" primitive, and inventing one here would
   * put a game rule in `apps/server`, which this repo bans. So the room does
   * the one thing it is allowed to do — hand the sim an input on the absent
   * player's behalf — using that tank's own last-known aim and the free Baby
   * Missile, so the clock can never spend ammunition somebody paid for.
   *
   * The `timeout` event goes out in front of the shot so the client can say
   * "Bob ran out of time" instead of silently animating a shot Bob never took.
   */
  private async forceTurn(game: GameState, streak: number): Promise<void> {
    const active = game.tanks[game.activeTank];
    if (active === undefined) {
      await this.abandonMatch();
      return;
    }

    const expiredTurn = game.turnNumber;
    const result = fire(game, active.id, {
      turnNumber: expiredTurn,
      angleDeg: active.angleDeg,
      power: active.power,
      weapon: BABY_MISSILE,
    });

    const events: ServerEventPayload = [
      { type: 'timeout', tankIndex: game.activeTank, turnNumber: expiredTurn },
      ...(result.events as ServerEventPayload),
    ];
    await this.commitTurn(expiredTurn, result.state, events, {
      timeoutStreak: streak,
      expiredTurn,
    });
  }

  /** Somebody never left the shop. Close it for everyone still in there. */
  private async forceShopEnd(game: GameState, streak: number): Promise<void> {
    let next = game;
    for (const id of game.pendingShoppers) next = leaveShop(next, id);

    const rolled = startNextRound(next);
    await this.commitTurn(rolled.state.turnNumber, rolled.state, rolled.events, {
      timeoutStreak: streak,
      expiredTurn: null,
    });
  }

  /**
   * Give up on a match nobody is playing: the seats stay, the game goes, and
   * the room is a joinable lobby again. This is a room lifecycle decision, not
   * a game rule — the sim is never asked to invent an ending.
   */
  private async abandonMatch(): Promise<void> {
    this.sql.exec('DELETE FROM kv WHERE k IN (?, ?)', 'game', 'turn');
    const players = this.readPlayers();
    for (const player of players) player.ready = false;
    this.writePlayers(players);
    await this.ctx.storage.deleteAlarm();
    this.broadcast({ t: 'error', code: 'room_closed', message: 'The match was abandoned' });
    this.broadcastLobby();
  }

  /**
   * Restart a clock that stopped because the room emptied out.
   *
   * Only the small turn row is rewritten — re-arming a timer is no reason to
   * push a whole heightmap back through storage.
   */
  private async restartClockIfStopped(): Promise<void> {
    const game = this.readGame();
    if (game === null || clockFor(game.phase) === null) return;
    if ((await this.ctx.storage.getAlarm()) !== null) return;

    // The streak counts turns nobody was there to play. Somebody is there now,
    // so the match gets its full patience back — but `expiredTurn` is kept, so
    // a shot composed before the drop still gets told what happened to it.
    await this.armClock(game, { timeoutStreak: 0, expiredTurn: this.readTurnInfo().expiredTurn });
    // Everyone's countdown just moved, so everyone hears about it.
    this.broadcastTurnTimer(game);
  }

  /**
   * Persist a state and set the clock for it. One storage write per turn,
   * never per frame.
   */
  private async commitState(
    state: GameState,
    options: { timeoutStreak: number; expiredTurn: number | null },
  ): Promise<void> {
    this.writeKv('game', toPersisted(state));
    await this.armClock(state, options);
  }

  /**
   * Record the cheap summary the room reads on chatty paths, and schedule the
   * deadline that goes with it.
   *
   * `Date.now()` is legitimate here for the same reason it is in
   * `consumeRateLimit`: this is the server, and a deadline is wall-clock by
   * definition. The ban on clocks applies to `packages/sim`.
   */
  private async armClock(
    state: GameState,
    options: { timeoutStreak: number; expiredTurn: number | null },
  ): Promise<void> {
    const duration = clockFor(state.phase);
    const deadlineAt = duration === null ? null : Date.now() + duration;
    const active = state.tanks[state.activeTank];
    this.writeKv('turn', {
      turnNumber: state.turnNumber,
      activeId: state.phase === 'aiming' && active !== undefined ? active.id : null,
      phase: state.phase,
      timeoutStreak: options.timeoutStreak,
      expiredTurn: options.expiredTurn,
      deadlineAt,
    } satisfies TurnInfo);

    // A Durable Object holds at most one alarm, so this replaces the previous
    // turn's: a turn played normally cancels its own timeout as a side effect.
    if (deadlineAt === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(deadlineAt);
  }

  private async commitTurn(
    turnPlayed: number,
    state: GameState,
    events: readonly GameEvent[] | ServerEventPayload,
    options: { timeoutStreak: number; expiredTurn: number | null },
  ): Promise<void> {
    await this.commitState(state, options);
    this.recordReplay(turnPlayed, events);
    this.recordRoundWins(events);

    this.broadcast({
      t: 'events',
      turnNumber: turnPlayed,
      events: events as ServerEventPayload,
      snapshot: toSnapshot(state),
    });
    this.broadcastTurnTimer(state);

    if (state.phase === 'gameover') this.broadcastMatchResult(state);
  }

  private broadcastTurnTimer(state: GameState, target?: WebSocket): void {
    const duration = clockFor(state.phase);
    if (state.phase !== 'aiming' || duration === null) return;

    const deadlineAt = this.readTurnInfo().deadlineAt;
    const remainingMs =
      deadlineAt === null ? duration : Math.max(0, Math.round(deadlineAt - Date.now()));

    const frame: ServerMessage = {
      t: 'turnTimer',
      turnNumber: state.turnNumber,
      activeTank: state.activeTank,
      remainingMs: Math.min(remainingMs, duration),
      durationMs: duration,
    };
    if (target === undefined) this.broadcast(frame);
    else this.send(target, frame);
  }

  /**
   * The final scoreboard, sent once when the sim declares the match over.
   *
   * `place` uses standard competition ranking, so an equal score is an equal
   * place. `roundsWon` counts rounds this player ended as the only tank left
   * standing; a round that times out with several survivors is won by nobody.
   */
  private broadcastMatchResult(state: GameState): void {
    try {
      const wins = this.readKv<Record<string, number>>('wins', {});
      let place = 1;
      let previousScore: number | null = null;

      const standings = matchStandings(state).map((tank, index) => {
        if (previousScore === null || tank.score !== previousScore) {
          place = index + 1;
          previousScore = tank.score;
        }
        return {
          playerId: tank.id,
          name: tank.name,
          place,
          score: tank.score,
          roundsWon: wins[tank.id] ?? 0,
        };
      });

      this.broadcast({
        t: 'matchResult',
        winnerId: state.winnerId,
        roundsPlayed: state.round,
        standings,
      });
    } catch (error) {
      // A scoreboard that will not encode must not take the turn commit with
      // it — the match is already decided and persisted at this point.
      console.error('GameRoom could not send the match result', error);
    }
  }

  // -------------------------------------------------------------------------
  // Seats, hosts and sockets.
  // -------------------------------------------------------------------------

  private ensureAttachment(ws: WebSocket): SocketAttachment {
    const existing = readAttachment(ws);
    if (existing !== null) return existing;
    // Only reachable for a socket whose attachment failed to deserialise. It
    // gets an identity now rather than an unhandled null later.
    const fresh: SocketAttachment = {
      connId: generateSessionId(),
      playerId: null,
      name: '',
      spectator: false,
    };
    ws.serializeAttachment(fresh);
    return fresh;
  }

  private attach(
    ws: WebSocket,
    base: SocketAttachment,
    playerId: string,
    name: string,
    spectator: boolean,
  ): SocketAttachment {
    const next: SocketAttachment = { connId: base.connId, playerId, name, spectator };
    ws.serializeAttachment(next);
    return next;
  }

  private rejectSpectator(ws: WebSocket, attachment: SocketAttachment): boolean {
    if (!attachment.spectator) return false;
    this.sendError(ws, 'spectator_only', 'You are watching this match, not playing it');
    return true;
  }

  /**
   * The host is whichever seated player has been here longest and is currently
   * connected. Without this, the one person who can press Start drops out of a
   * lobby and takes the room with them.
   *
   * A returning original host does NOT take it back: swapping the host around
   * on every flaky connection is worse than leaving it where it landed.
   */
  private promoteHostIfNeeded(reason: HostChangeReason, except?: WebSocket): void {
    const meta = this.readMeta();
    const players = this.readPlayers();
    const connected = this.connectedPlayerIds(except);

    const hostIsUsable =
      meta.hostId !== null &&
      players.some((player) => player.id === meta.hostId) &&
      connected.has(meta.hostId);
    if (hostIsUsable) return;

    const heir = players.find((player) => connected.has(player.id));
    const hostId = heir?.id ?? null;
    if (hostId === meta.hostId) return;

    this.writeMeta({ ...meta, hostId });
    this.broadcast({ t: 'host', hostId, reason }, except);
  }

  private connectedPlayerIds(except?: WebSocket): Set<string> {
    const ids = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      const attachment = readAttachment(socket);
      if (attachment?.playerId != null && !attachment.spectator) ids.add(attachment.playerId);
    }
    return ids;
  }

  private hasConnectedPlayer(): boolean {
    return this.connectedPlayerIds().size > 0;
  }

  private spectatorAttachments(except?: WebSocket): SocketAttachment[] {
    const viewers: SocketAttachment[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      const attachment = readAttachment(socket);
      if (attachment?.spectator === true && attachment.playerId !== null) viewers.push(attachment);
    }
    return viewers;
  }

  private countSpectators(): number {
    return this.spectatorAttachments().length;
  }

  private broadcastSpectators(except?: WebSocket): void {
    const viewers = this.spectatorAttachments(except);
    this.broadcast(
      {
        t: 'spectators',
        count: viewers.length,
        viewers: viewers.slice(0, MAX_SPECTATORS_LISTED).map((viewer) => ({
          id: viewer.playerId as string,
          name: viewer.name,
        })),
      },
      except,
    );
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

  private sendWelcome(ws: WebSocket, attachment: SocketAttachment): void {
    this.send(ws, {
      t: 'welcome',
      protocol: PROTOCOL_VERSION,
      sessionId: attachment.playerId ?? '',
      roomCode: this.readMeta().roomCode || 'AAAA',
      you: attachment.playerId ?? '',
      role: attachment.spectator ? 'spectator' : 'player',
    });
  }

  /** Hand a joining or reconnecting socket the authoritative state at once. */
  private sendLiveState(ws: WebSocket): void {
    const game = this.readGame();
    if (game === null) return;
    this.send(ws, { t: 'state', snapshot: toSnapshot(game) });
    this.broadcastTurnTimer(game, ws);
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    const encoded = encodeServerMessage(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      // A socket that has not said `hello` has no business seeing room traffic.
      if (readAttachment(socket)?.playerId == null) continue;
      try {
        socket.send(encoded);
      } catch (error) {
        console.error('Failed to broadcast frame', error);
      }
    }
  }

  private broadcastLobby(except?: WebSocket): void {
    const meta = this.readMeta();
    const players = this.readPlayers();
    const connected = this.connectedPlayerIds(except);

    this.broadcast(
      {
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
      },
      except,
    );
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

  private readTurnInfo(): TurnInfo {
    return { ...NO_TURN, ...this.readKv<Partial<TurnInfo>>('turn', {}) };
  }

  /** True while a match is live. A finished match is over, not in progress. */
  private matchInProgress(): boolean {
    const phase = this.readTurnInfo().phase;
    return phase !== 'lobby' && phase !== 'gameover';
  }

  private recordReplay(turn: number, events: readonly unknown[]): void {
    this.sql.exec(
      'INSERT INTO replay_v2 (match, turn, events) VALUES (?, ?, ?)',
      this.readMeta().gameNonce,
      turn,
      JSON.stringify(events),
    );
    this.sql.exec(
      'DELETE FROM replay_v2 WHERE seq <= (SELECT MAX(seq) FROM replay_v2) - ?',
      MAX_REPLAY_ROWS,
    );
  }

  /** Round wins, for the final scoreboard. One small write per round, at most. */
  private recordRoundWins(events: readonly { type: string }[]): void {
    const winners: string[] = [];
    for (const event of events) {
      if (event.type !== 'roundEnd') continue;
      const survivors = (event as { survivors?: unknown }).survivors;
      if (Array.isArray(survivors) && survivors.length === 1 && typeof survivors[0] === 'string') {
        winners.push(survivors[0]);
      }
    }
    if (winners.length === 0) return;

    const wins = this.readKv<Record<string, number>>('wins', {});
    for (const id of winners) wins[id] = (wins[id] ?? 0) + 1;
    this.writeKv('wins', wins);
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
  private consumeRateLimit(key: string, kind: RateBucketKind): boolean {
    const bucketKey = `${key}:${kind}`;
    const now = Date.now();
    let bucket = this.rateBuckets.get(bucketKey);

    if (bucket === undefined || now - bucket.windowStartedAt > RATE_LIMIT_WINDOW_MS) {
      bucket = { windowStartedAt: now, remaining: RATE_LIMIT_BUDGETS[kind] };
      this.rateBuckets.set(bucketKey, bucket);
    }

    if (bucket.remaining <= 0) return false;

    bucket.remaining -= 1;
    return true;
  }
}

/** The protocol's event array type, structurally satisfied by sim's GameEvent[]. */
type ServerEventPayload = Extract<ServerMessage, { t: 'events' }>['events'];
type HostChangeReason = Extract<ServerMessage, { t: 'host' }>['reason'];

function readAttachment(ws: WebSocket): SocketAttachment | null {
  const raw = ws.deserializeAttachment() as unknown;
  if (raw === null || typeof raw !== 'object') return null;
  const candidate = raw as Partial<SocketAttachment>;
  if (typeof candidate.connId !== 'string') return null;
  return {
    connId: candidate.connId,
    playerId: typeof candidate.playerId === 'string' ? candidate.playerId : null,
    name: typeof candidate.name === 'string' ? candidate.name : '',
    spectator: candidate.spectator === true,
  };
}

function nextFreeColor(players: readonly RoomPlayer[]): number {
  const used = new Set(players.map((player) => player.colorIndex));
  for (let index = 0; index < MAX_PLAYERS; index += 1) {
    if (!used.has(index)) return index;
  }
  return players.length;
}

/**
 * Map a sim error code onto the wire enum.
 *
 * Asks the protocol schema rather than keeping a second copy of the list here.
 * The copy that used to live in this file silently went stale the moment the
 * sim grew a code the protocol had not heard of, and "internal" is a terrible
 * thing to tell a player who simply fired at the wrong moment.
 */
function toErrorCode(code: string): ServerErrorCode {
  const parsed = ServerErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : 'internal';
}
