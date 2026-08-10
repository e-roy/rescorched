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
  applyBotShopping,
  BABY_MISSILE,
  BOT_DISPLAY_NAMES,
  buy,
  chooseShot,
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
  type BotPersonality,
  type GameEvent,
  type GamePhase,
  type GameState,
  type PersistedGame,
} from '@scorched/sim';

import { estimatePlaybackMs } from './playback.ts';
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
 * angle. Both are exported so a test can assert which clock a phase got
 * without restating the numbers — a test that hardcoded 60000 would still pass
 * if the shop quietly started using the turn clock.
 */
export const TURN_TIMEOUT_MS = 60_000;
export const SHOP_TIMEOUT_MS = 120_000;

/**
 * How long the room waits before a computer player takes its turn.
 *
 * A bot's decision costs single-digit milliseconds, so this is not thinking
 * time — it is pacing, and it is a product decision rather than a technical
 * one. A human should see whose turn it is before the shell is already in the
 * air; three bots firing inside one animation frame reads as a glitch, not as
 * opponents.
 *
 * It used to be a flat 1500 ms, chosen to be longer than a turn takes to
 * animate, because the client had no playback queue and a frame arriving
 * mid-flight restarted the animation the player was watching.
 *
 * This is now ONLY the character pause, and the animation is paid for
 * separately: `armClock` adds `estimatePlaybackMs` of the turn it just
 * broadcast, so the next machine starts after the last one has been seen. That
 * split is the fix for a real regression against the old flat number — at 400
 * to 1000 ms against a turn that animates for 840 to 1500, three or more bots
 * outran playback persistently, `BattleScene` dropped the overtaken turns (a
 * bounded backlog, deliberately), and the player never saw a share of the
 * shots. See `playback.ts`.
 *
 * So it varies by personality, weakest first, and the variation is the point: a
 * metronome at any speed reads as a machine waiting, while a Moron that snaps
 * off a shot and an Annihilator that takes a beat over it read as two different
 * opponents. The numbers are ordered by how much the bot actually deliberates —
 * see `PROFILES` in `packages/sim/src/ai.ts` — so the ordering means something
 * rather than being decoration.
 *
 * Delivered by the turn alarm rather than by a timer, because a Durable Object
 * has no timers it can hold across hibernation — see `armClock`. Exported as
 * data so a test can assert the shape of the pacing without waiting for any of
 * it, and so nothing has to restate a millisecond count.
 */
export const BOT_TURN_DELAY_MS: Readonly<Record<BotPersonality, number>> = {
  /** Does not aim. There is nothing for it to be thinking about. */
  moron: 400,
  shooter: 650,
  tosser: 650,
  /** Looking at where the last one went. */
  poolshark: 900,
  cyborg: 800,
  /** Long enough that you notice it deciding, which it is. */
  annihilator: 1_000,
};

/**
 * The pause in front of this seat's shot, or null when the seat is a person.
 *
 * Null rather than 0 for a human, because "no bot is up" and "a bot with no
 * pause" are different situations for `armClock` and conflating them is how a
 * turn clock becomes a bot clock.
 */
export function botTurnDelayMs(state: GameState): number | null {
  if (state.phase !== 'aiming') return null;
  const personality = botSeatOf(state, state.activeTank);
  return personality === null ? null : BOT_TURN_DELAY_MS[personality];
}

/**
 * The whole gap in front of a computer player's shot: however long the turn
 * just broadcast takes to WATCH, and then the seat's own character pause.
 *
 * The two halves are different things and are kept apart on purpose. The
 * animation cost is a fact about the frame that was sent and applies to every
 * seat identically; the pause is what makes a Moron and an Annihilator read as
 * two different opponents. Adding them here — rather than inside
 * `BOT_TURN_DELAY_MS` — is what stops the personality table quietly becoming a
 * timing table nobody can tune.
 *
 * Null for a person, who is clocked rather than paced.
 */
export function botAlarmDelayMs(state: GameState, playbackMs: number): number | null {
  const pause = botTurnDelayMs(state);
  if (pause === null) return null;
  return Math.max(0, playbackMs) + pause;
}

/**
 * Which computer player a lobby gets when it does not say.
 *
 * The Shooter: it aims properly and ignores the wind, which is beatable by
 * someone who has understood the wind and not by someone who has not. A room
 * whose default opponent is the Moron teaches nothing; one whose default is the
 * Annihilator sends first-time players away.
 */
export const DEFAULT_BOT_PERSONALITY: BotPersonality = 'shooter';

/**
 * How many turns in a row the clock may decide before the room gives up on the
 * match. Without a cap, two idle-but-connected browsers would have the room
 * wake every minute for the rest of the match — the exact standing cost
 * hibernation exists to remove.
 */
export const MAX_CONSECUTIVE_TIMEOUTS = 3;

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
  /**
   * The credential this socket authenticated with: the seat's `secret` for a
   * player, the spectator's own id for a viewer. Never broadcast and never
   * derivable from anything that is — see `RoomPlayer.secret`.
   */
  secret: string | null;
  name: string;
  spectator: boolean;
}

/** A socket that has completed `hello`, so it has an identity to act with. */
type JoinedAttachment = SocketAttachment & { playerId: string; secret: string };

interface RateBucket {
  /** Wall-clock ms the current window opened. */
  windowStartedAt: number;
  remaining: number;
}

interface RoomPlayer {
  /**
   * Public. It is in every `lobby` frame, in every tank of every snapshot, and
   * in every `chat` line, so every client in the room knows it for every
   * player.
   */
  id: string;
  /**
   * Private. This — not `id` — is what proves ownership of the seat on
   * reconnect, and it goes to exactly one place: the `sessionId` field of that
   * player's own `welcome`.
   *
   * The two fields exist because the reconnect handshake needs a bearer token
   * and the game needs a name to put on a tank, and those cannot be the same
   * string. When `hello` matched on the public id, any client could re-hello
   * with an opponent's id from the lobby list, be welcomed as them, and fire
   * their shot or spend their money — with the victim's socket still open and
   * none the wiser.
   *
   * The wire already carried both: `welcome.sessionId` is what a client
   * replays in `hello`, `welcome.you` is the identity it renders with. Only
   * the room was collapsing them into one value.
   */
  secret: string;
  name: string;
  ready: boolean;
  colorIndex: number;
  /**
   * Which computer player holds this seat, or null for a person.
   *
   * A bot seat is a seat in every other respect: it has an id, a colour, a tank
   * and a wallet, and it is counted against `MAX_PLAYERS`. What it does not
   * have is a socket, which is exactly why it is stored here and not inferred
   * from the connection — nothing about a bot is knowable from the sockets the
   * room is holding.
   *
   * It gets a `secret` like anybody else, and that secret goes nowhere: it is
   * never broadcast and never sent to a client, so `hello` can never match a
   * bot seat and no player can take one over.
   */
  bot: BotPersonality | null;
}

type RateBucketKind = 'chatter' | 'action';

interface RoomMeta {
  roomCode: string;
  hostId: string | null;
  gameNonce: number;
  /**
   * Somebody asked for this code and was given it — `POST /api/rooms` claimed
   * it. See `roomExists`.
   *
   * It has to be recorded, because it cannot be inferred. `idFromName` resolves
   * every well-formed code to a Durable Object, so all 331,776 of them "exist"
   * as far as routing is concerned and a room nobody has ever opened is
   * indistinguishable from one that is simply quiet.
   */
  opened?: boolean;
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
      /*
       * Learn the code, but only for a room that is really there.
       *
       * Writing it unconditionally would mean a mistyped code left a storage
       * row behind in a room nobody ever entered — one SQLite write per typo,
       * on any of 331,776 objects, from an unauthenticated request. `hello`
       * refuses the connection a moment later anyway; there is nothing here
       * worth remembering about it.
       */
      if (meta.roomCode === '' && roomCode !== '' && this.roomExists()) {
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
        secret: null,
        name: '',
        spectator: false,
      } satisfies SocketAttachment);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith('/info')) {
      const meta = this.readMeta();
      return Response.json({
        roomCode: meta.roomCode,
        exists: this.roomExists(),
        players: this.readPlayers().length,
        maxPlayers: MAX_PLAYERS,
        spectators: this.countSpectators(),
        inProgress: this.matchInProgress(),
        phase: this.readTurnInfo().phase,
      });
    }

    /*
     * Claim this code for somebody about to create a room.
     *
     * Two jobs in one round trip, because `allocateRoomCode` probes candidates
     * in a loop and a second call per candidate would double the cost of
     * creating a room. It refuses a code somebody is already sitting in, and
     * it MARKS the one it hands over — which is what makes "join" and "create"
     * different operations rather than the same one under two buttons.
     *
     * Not reachable from the outside: the Worker's route only forwards `/ws`
     * and `/info`, so the only caller is room allocation itself.
     */
    if (url.pathname.endsWith('/claim')) {
      const meta = this.readMeta();
      const occupied = this.readPlayers().length > 0 || this.matchInProgress();
      if (!occupied) {
        const roomCode = url.searchParams.get('room') ?? meta.roomCode;
        this.writeMeta({ ...meta, roomCode, opened: true });
      }
      return Response.json({ claimed: !occupied });
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Is there a room here at all?
   *
   * "Does not exist" has to be decided rather than discovered: the Worker
   * resolves any well-formed code to a Durable Object, so a room nobody has
   * ever joined answers requests exactly like one that is merely empty. Three
   * ways to be real, and the last two are what keep rooms that predate the
   * `opened` flag — and any room a test or a future entry point seats somebody
   * in — joinable:
   *
   *  - somebody was handed this code by `POST /api/rooms`;
   *  - somebody holds a seat in it;
   *  - a match is stored in it (which is also how a reload mid-match gets back
   *    in, since the seat is held but the connection is gone).
   */
  private roomExists(): boolean {
    if (this.readMeta().opened === true) return true;
    if (this.readPlayers().length > 0) return true;
    return this.readKv<PersistedGame | null>('game', null) !== null;
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
      const remaining = this.readPlayers().filter((player) => player.id !== playerId);
      // …and a lobby of nothing but computer players is not a lobby. Whoever
      // walks in next should get an empty room to set up their own way, not
      // somebody else's three Morons and no way to remove them (they would not
      // be host until the room noticed, and by then they would have started a
      // match against a line-up they did not choose).
      const anyoneHome = remaining.some((player) => player.bot === null);
      this.writePlayers(anyoneHome ? remaining : []);
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

    /*
     * Nobody is waiting on this turn. Re-arming would wake the room every
     * minute forever for an audience of nobody — precisely the standing cost
     * the hibernation API exists to remove. `hello` restarts the clock when
     * someone comes back.
     *
     * Who counts as "somebody" depends on what this alarm was going to do, and
     * this is the one place in the room where the distinction matters. A turn
     * the CLOCK is about to decide is only worth waking for if a seated player
     * is still here to be covered for — a spectator cannot fire, so nothing
     * changes for them but the same board arriving a minute later. A turn a
     * COMPUTER PLAYER is about to take is worth waking for if ANYBODY is
     * watching, because a bot's turn needs no socket: an all-bot match with an
     * audience is a match, and freezing it because none of the seats happens to
     * own a connection is a stopped board the viewer sees.
     *
     * With nobody connected at all both answers are false and the room goes
     * back to sleep either way, which is the property that keeps an idle room
     * free — including a room full of computer players playing to an empty
     * theatre.
     */
    const botIsUp = isBotTurn(game);
    if (!(botIsUp ? this.hasAudience() : this.hasConnectedPlayer())) return;

    const info = this.readTurnInfo();

    /*
     * A computer player's turn, and NOT a timeout.
     *
     * This is the only path by which a bot ever fires, and it is deliberately
     * the alarm rather than a continuation of whatever move led here. A Durable
     * Object can be evicted between any two invocations, so a bot turn held in
     * memory is a bot turn that can evaporate; a bot turn held as an alarm over
     * persisted state cannot. The room wakes, re-reads the game from SQLite,
     * asks the sim what this seat does — the same answer, because `chooseShot`
     * is a pure function of exactly that state — and fires it.
     *
     * It is checked BEFORE the timeout bookkeeping, and that ordering is the
     * whole of "a bot is never starved by the clock". A bot cannot run out of
     * time because the clock never gets to look at its turn: however late this
     * alarm arrives — a slow wake-up, a room resumed hours later, a deadline
     * long past — a seat with a brain behind it fires its shot rather than
     * being fired on its behalf.
     *
     * The timeout streak is carried through rather than reset. A room where one
     * person walked away and a bot keeps answering is still a room only the
     * clock is playing, and resetting here would mean it never got abandoned.
     */
    if (botIsUp) {
      try {
        await this.playBotTurn(game, info);
      } catch (error) {
        console.error('GameRoom bot turn failed', error);
        await this.abandonMatch();
      }
      return;
    }

    const streak = info.timeoutStreak + 1;
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

      case 'addBot':
        this.handleAddBot(ws, joined, message.personality ?? DEFAULT_BOT_PERSONALITY);
        return;

      case 'removeBot':
        this.handleRemoveBot(ws, joined, message.playerId);
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

    /*
     * A code nobody was ever given is not a room, and joining it must not make
     * one.
     *
     * This is the whole of the fix for a defect that looked like nothing: a
     * typo in a friend's room code seated the player in a brand new, empty
     * room that was pixel for pixel the room their friend was waiting in, and
     * both of them then sat looking at a lobby wondering where the other one
     * was. Creating a room is a different act, and it has its own door —
     * `POST /api/rooms`, which claims the code before the socket is opened.
     *
     * Refused before anything is written, so the phantom room stays phantom.
     */
    if (!this.roomExists()) {
      this.sendError(
        ws,
        'room_not_found',
        'No room with that code. Check it with whoever invited you, or create one.',
      );
      return;
    }

    // A second `hello` on a socket that already joined is a re-sync, never a
    // second seat. Without this, one connection could quietly claim every slot
    // in the room by saying hello eight times.
    if (attachment.playerId !== null) {
      // A socket carrying an identity but no credential cannot be re-synced and
      // must not be allowed to fall through and claim a fresh seat. Only
      // reachable for an attachment written by an older build.
      if (
        attachment.secret === null ||
        (message.sessionId ?? attachment.secret) !== attachment.secret
      ) {
        this.sendError(ws, 'bad_protocol', 'This connection has already joined as someone else');
        return;
      }
      this.sendWelcome(ws, attachment as JoinedAttachment);
      this.sendLiveState(ws);
      return;
    }

    const players = this.readPlayers();
    // Matched on the seat's SECRET, never on its public id. The public id is on
    // every lobby frame every client in the room receives, so matching on it
    // made "play as the person whose turn it is" a two-line client patch.
    //
    // An empty claim matches nothing rather than matching a seat whose
    // credential failed to persist.
    const claimed = message.sessionId ?? '';
    const seat = claimed === '' ? undefined : players.find((player) => player.secret === claimed);

    if (seat !== undefined && message.role !== 'spectator') {
      // Reconnect: the seat, and with it the tank, the money and the inventory.
      // A rename is accepted only between matches — the name on the tank is
      // baked into every snapshot already broadcast, and two names for one
      // player is worse than a stale one.
      if (!this.matchInProgress() && seat.name !== message.name) {
        seat.name = message.name;
        this.writePlayers(players);
      }
      const joined = this.attach(ws, attachment, seat.id, seat.secret, seat.name, false);
      // Whoever held this seat a moment ago does not hold it any more.
      this.displaceSeat(seat.id, ws);
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
      // A spectator has no seat to prove ownership of, so its "credential" is
      // just its own id: replaying it in a later `hello` re-syncs the same
      // socket and matches no seat anywhere.
      const spectatorId = `spec-${attachment.connId}`;
      const joined = this.attach(ws, attachment, spectatorId, spectatorId, message.name, true);
      this.sendWelcome(ws, joined);
      /*
       * An audience is not a player, so a match waiting on an absent HUMAN
       * stays asleep: there is nobody here for the clock to cover for and
       * waking to time somebody out for a viewer buys nothing.
       *
       * A computer player's turn is the exception, and the only one. It needs
       * no socket, so somebody arriving to watch is by itself reason enough to
       * start the clock again. Without this, an all-bot match that emptied out
       * could only ever be resumed by a returning seat holder — and in a match
       * whose seats are all machines there is no seat holder to return.
       */
      await this.restartClockIfStopped({ botTurnsOnly: true });
      this.sendLiveState(ws);
      this.broadcastSpectators();
      return;
    }

    const player: RoomPlayer = {
      id: generateSessionId(),
      secret: generateSessionId(),
      name: message.name,
      ready: false,
      colorIndex: nextFreeColor(players),
      bot: null,
    };
    players.push(player);
    this.writePlayers(players);

    const joined = this.attach(ws, attachment, player.id, player.secret, player.name, false);
    this.promoteHostIfNeeded('assigned');
    this.sendWelcome(ws, joined);
    this.broadcastLobby();
    // A finished match is still worth seeing: whoever walks in next gets the
    // final board rather than an empty screen.
    this.sendLiveState(ws);
  }

  /**
   * Seat a computer player.
   *
   * This is the whole of "one person can sit down and play". Everything else
   * about a bot — taking its turn, spending its money — follows from the seat
   * existing, because the sim decides all of it from `tank.bot`.
   *
   * Host only and lobby only, for the same reason `start` is: adding a seat
   * changes the match everyone else is about to be dealt into. Refused with the
   * existing error codes rather than new ones; nothing here is a new KIND of
   * refusal.
   */
  private handleAddBot(
    ws: WebSocket,
    attachment: JoinedAttachment,
    personality: BotPersonality,
  ): void {
    if (this.rejectSpectator(ws, attachment)) return;

    const meta = this.readMeta();
    if (meta.hostId !== null && meta.hostId !== attachment.playerId) {
      this.sendError(ws, 'not_host', 'Only the host can add a computer player');
      return;
    }
    if (this.matchInProgress()) {
      this.sendError(ws, 'wrong_phase', 'The match has already started');
      return;
    }

    const players = this.readPlayers();
    if (players.length >= MAX_PLAYERS) {
      this.sendError(ws, 'room_full', 'Every seat in this room is taken');
      return;
    }

    players.push({
      id: generateSessionId(),
      secret: generateSessionId(),
      name: botName(personality, players),
      // Always ready. A bot is never the reason a lobby is waiting.
      ready: true,
      colorIndex: nextFreeColor(players),
      bot: personality,
    });
    this.writePlayers(players);
    this.broadcastLobby();
  }

  /** Free a seat a computer player is sitting in. Host only, lobby only. */
  private handleRemoveBot(ws: WebSocket, attachment: JoinedAttachment, playerId: string): void {
    if (this.rejectSpectator(ws, attachment)) return;

    const meta = this.readMeta();
    if (meta.hostId !== null && meta.hostId !== attachment.playerId) {
      this.sendError(ws, 'not_host', 'Only the host can remove a computer player');
      return;
    }
    if (this.matchInProgress()) {
      this.sendError(ws, 'wrong_phase', 'The match has already started');
      return;
    }

    const players = this.readPlayers();
    const target = players.find((player) => player.id === playerId);
    // Deliberately the same refusal for "no such seat" and "that seat is a
    // person": `removeBot` is not a way to find out who in the room is human,
    // and it is certainly not a way to kick them.
    if (target === undefined || target.bot === null) {
      this.sendError(ws, 'unknown_player', 'That seat does not hold a computer player');
      return;
    }

    this.writePlayers(players.filter((player) => player.id !== playerId));
    this.broadcastLobby();
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
    // Computer players count. That is the point of them: one person plus one
    // Shooter is a match, and before bots existed this room needed two humans
    // before anything at all could happen.
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
        // `PlayerSeed.bot` is optional and `undefined` means a person, so a
        // human seat must not carry `bot: null` — it would be a different
        // object shape for the same meaning.
        ...(player.bot !== null ? { bot: player.bot } : {}),
      })),
    );

    /*
     * A match opens in the ARMOURY, not on the battlefield: `createGame`
     * returns a `shopping` phase with everybody pending, so a player spends
     * their starting money before the first shell flies. The room does not
     * decide that and could not — it is a rule, and rules live in the sim. What
     * the room has to do is exactly what it already does at every other shop:
     * walk the computer players through it, and roll straight into round one if
     * that empties the shop. Without this a lobby of nothing but bots would sit
     * in a shop none of them was ever going to leave.
     */
    const settled = this.settleBotShopping(state, []);

    await this.commitState(settled.state, { timeoutStreak: 0, expiredTurn: null });
    this.broadcast({ t: 'state', snapshot: toSnapshot(settled.state) });
    this.broadcastTurnTimer(settled.state);
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
   * player's behalf — using the angle and power already stored on that tank,
   * and always the free Baby Missile, so the clock can never spend ammunition
   * somebody paid for.
   *
   * Be precise about whose aim that is, because it is less than it sounds.
   * `aim` frames are chatter: the room relays them and keeps nothing, and
   * `fire()` is the only thing in the sim that writes `angleDeg`/`power` onto a
   * tank. So the forced shot reuses the aim of that player's last FIRED shot,
   * and for a player who has not fired since the round was seated it is the
   * placement default — 45 degrees if they spawned on the left half of the
   * board, 135 if on the right (`seatTanks` in `packages/sim/src/game.ts`).
   * Someone who walks away on their very first turn therefore gets a canned
   * opening shot, which is exactly the common case this clock exists for. That
   * is accepted deliberately: the alternative is a skip-turn rule invented in
   * `apps/server`, and rules belong in the sim.
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

  /**
   * A computer player takes its turn.
   *
   * The room's only move is still "hand the sim an input" — this is the same
   * `fire()` a human's frame goes through, with the same validation and the
   * same events. What the room adds is nothing: it does not aim, it does not
   * decide, it does not know what a good shot is. `chooseShot` does all of it
   * from the persisted state, which is what makes the shot identical whether it
   * is computed now or after the object has been evicted and woken up again.
   */
  private async playBotTurn(game: GameState, info: TurnInfo): Promise<void> {
    const active = game.tanks[game.activeTank];
    if (active === undefined) {
      await this.abandonMatch();
      return;
    }

    const decision = chooseShot(game, game.activeTank);
    const result = fire(game, active.id, {
      turnNumber: game.turnNumber,
      angleDeg: decision.angleDeg,
      power: decision.power,
      weapon: decision.weapon,
    });

    await this.commitTurn(game.turnNumber, result.state, result.events, {
      timeoutStreak: info.timeoutStreak,
      expiredTurn: info.expiredTurn,
    });
  }

  /**
   * Take every computer player through the shop and out the other side.
   *
   * Run at the moment the shop opens rather than on a clock, because a bot has
   * nothing to think about: `choosePurchases` is a preference list against a
   * budget. So the state that gets broadcast when a round ends already shows
   * the bots' new inventories and already has them out of `pendingShoppers`,
   * and the humans see a shop that is waiting for them alone.
   *
   * Both shops go through here, and the pre-match ARMOURY is the one that
   * matters most: `handleStart` calls this on the state `createGame` hands
   * back, so a computer player arrives at round one armed with whatever its
   * personality chose to buy. Without it, a bot would fight the opening round
   * with the free weapon against a human who had shopped, and nothing on
   * screen would say why.
   *
   * If that empties the shop — every remaining shopper was a bot — the next
   * round is rolled here too, so the room never sits in a `shopping` phase
   * nobody is going to leave.
   */
  private settleBotShopping(
    state: GameState,
    events: ServerEventPayload,
  ): { state: GameState; events: ServerEventPayload } {
    if (state.phase !== 'shopping') return { state, events };

    let next = state;
    for (let index = 0; index < next.tanks.length; index += 1) {
      const tank = next.tanks[index];
      if (tank === undefined || tank.bot === null) continue;
      if (!next.pendingShoppers.includes(tank.id)) continue;
      next = applyBotShopping(next, index);
      next = leaveShop(next, tank.id);
    }
    if (next === state) return { state, events };

    if (!everyoneHasShopped(next)) return { state: next, events };
    const rolled = startNextRound(next);
    return {
      state: rolled.state,
      events: [...events, ...(rolled.events as ServerEventPayload)],
    };
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
   *
   * `botTurnsOnly` is what a spectator gets: restart a clock a computer player
   * is going to answer, leave a clock that is waiting on an absent human alone.
   * See the spectator branch of `handleHello`.
   */
  private async restartClockIfStopped(options: { botTurnsOnly?: boolean } = {}): Promise<void> {
    const game = this.readGame();
    if (game === null || clockFor(game.phase) === null) return;
    if (options.botTurnsOnly === true && !isBotTurn(game)) return;
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
    options: { timeoutStreak: number; expiredTurn: number | null; playbackMs?: number },
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
   *
   * Read ONCE, into `armedAt`, and used for both the deadline and the alarm.
   * Two readings with a storage write between them differ by however long that
   * write took, which makes the relationship between the row and the alarm
   * unstateable — and it is exactly that relationship the pacing tests read to
   * recover the gap the room scheduled without waiting for it.
   */
  private async armClock(
    state: GameState,
    options: { timeoutStreak: number; expiredTurn: number | null; playbackMs?: number },
  ): Promise<void> {
    const armedAt = Date.now();
    const duration = clockFor(state.phase);
    const deadlineAt = duration === null ? null : armedAt + duration;
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
    if (deadlineAt === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    /*
     * A computer player's turn is scheduled on the same alarm, just sooner.
     *
     * The bot is not going to run out of time, so the turn clock has nothing to
     * do on its turn; what the alarm is for here is the gap in front of the
     * shot (`botAlarmDelayMs`) — the animation the client is still playing,
     * then the seat's own pause. Reusing the one alarm rather than inventing a
     * second mechanism is what keeps this hibernation-safe: there is no timer
     * to lose, no continuation to hold in memory, and the wake-up re-derives
     * the whole decision from storage.
     *
     * `deadlineAt` in the turn row stays the real turn deadline, so a bot seat
     * that somehow does not fire is still covered by the ordinary clock — and
     * capping the pause at it means an absurd playback estimate can only ever
     * cost the room its normal patience, never more.
     */
    const gap = botAlarmDelayMs(state, options.playbackMs ?? 0);
    await this.ctx.storage.setAlarm(
      gap === null ? deadlineAt : Math.min(armedAt + gap, deadlineAt),
    );
  }

  private async commitTurn(
    turnPlayed: number,
    state: GameState,
    events: readonly GameEvent[] | ServerEventPayload,
    options: { timeoutStreak: number; expiredTurn: number | null },
  ): Promise<void> {
    // Bots shop before the turn is committed, so what gets persisted, replayed
    // and broadcast is one consistent picture rather than a round end followed
    // by a second frame nobody asked for.
    const settled = this.settleBotShopping(state, events as ServerEventPayload);

    /*
     * How long the frame about to go out takes to watch.
     *
     * Measured from the events themselves rather than assumed, and spent before
     * the next computer player is allowed to move — see `botAlarmDelayMs`. A
     * Nuke and a Baby Missile are not the same amount of time on screen, and a
     * fixed pause that suits one hides the other.
     */
    const playbackMs = estimatePlaybackMs(settled.events);

    await this.commitState(settled.state, { ...options, playbackMs });
    this.recordReplay(turnPlayed, settled.events);
    this.recordRoundWins(settled.events);

    this.broadcast({
      t: 'events',
      turnNumber: turnPlayed,
      events: settled.events,
      snapshot: toSnapshot(settled.state),
    });
    this.broadcastTurnTimer(settled.state);

    if (settled.state.phase === 'gameover') this.broadcastMatchResult(settled.state);
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
   * The final scoreboard.
   *
   * Sent to the whole room when the sim declares the match over, and again to
   * any single socket that arrives afterwards — see `sendLiveState`. `target`
   * is which of the two: omitted broadcasts, given sends.
   *
   * `place` uses standard competition ranking, so an equal score is an equal
   * place. `roundsWon` counts rounds this player ended as the only tank left
   * standing; a round that times out with several survivors is won by nobody.
   */
  private broadcastMatchResult(state: GameState, target?: WebSocket): void {
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

      const frame: ServerMessage = {
        t: 'matchResult',
        winnerId: state.winnerId,
        roundsPlayed: state.round,
        standings,
      };
      if (target === undefined) this.broadcast(frame);
      else this.send(target, frame);
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
      secret: null,
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
    secret: string,
    name: string,
    spectator: boolean,
  ): JoinedAttachment {
    const next: JoinedAttachment = { connId: base.connId, playerId, secret, name, spectator };
    ws.serializeAttachment(next);
    return next;
  }

  /**
   * One live socket per seat.
   *
   * Someone holding the seat's secret has just proved they own it, so any
   * earlier socket on that seat is either a stale half-open connection the
   * runtime has not reaped yet or a second tab. Either way the room should not
   * be fanning every frame out twice, and it must not have two `webSocketClose`
   * events racing over one seat.
   *
   * The displaced attachment is cleared BEFORE the close, because the close
   * handler frees a seat when the match has not started — and the seat it would
   * free is the one the arriving socket is sitting in.
   */
  private displaceSeat(playerId: string, keep: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === keep) continue;
      const other = readAttachment(socket);
      if (other === null || other.spectator || other.playerId !== playerId) continue;

      socket.serializeAttachment({
        ...other,
        playerId: null,
        secret: null,
      } satisfies SocketAttachment);
      this.sendError(socket, 'room_closed', 'This seat was taken over by a newer connection');
      try {
        socket.close(4000, 'Seat taken over');
      } catch (error) {
        console.error('Failed to close a displaced socket', error);
      }
    }
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

  /**
   * Anybody on the other end at all — a seated player OR a spectator.
   *
   * The weaker of the two audience tests, and it is used in exactly one place:
   * deciding whether a computer player's turn is worth waking up for. See
   * `alarm()` for why the two differ.
   */
  private hasAudience(): boolean {
    for (const socket of this.ctx.getWebSockets()) {
      if (readAttachment(socket)?.playerId != null) return true;
    }
    return false;
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

  /**
   * `sessionId` is the seat's credential and goes to this socket only;
   * `you` is the public identity the same client renders with and the same
   * value every other client in the room already has. Keeping them different
   * is the whole of the anti-impersonation story — see `RoomPlayer.secret`.
   */
  private sendWelcome(ws: WebSocket, attachment: JoinedAttachment): void {
    this.send(ws, {
      t: 'welcome',
      protocol: PROTOCOL_VERSION,
      sessionId: attachment.secret,
      roomCode: this.readMeta().roomCode || 'AAAA',
      you: attachment.playerId,
      role: attachment.spectator ? 'spectator' : 'player',
    });
  }

  /** Hand a joining or reconnecting socket the authoritative state at once. */
  private sendLiveState(ws: WebSocket): void {
    const game = this.readGame();
    if (game === null) return;
    this.send(ws, { t: 'state', snapshot: toSnapshot(game) });
    this.broadcastTurnTimer(game, ws);

    /*
     * A finished match tells its result to whoever walks in, not only to
     * whoever was there when it ended.
     *
     * `matchResult` was sent exactly once, from `commitTurn`, so a client that
     * joined, reconnected, or was still handshaking a beat later got the
     * `gameover` snapshot and nothing else. That is not a blank screen — the
     * client falls back to ranking the snapshot by score — but the fallback
     * cannot know places (ties share a place) or rounds won, so two people
     * looking at the same finished match saw two different scoreboards. An
     * ending has to be the same ending for everybody.
     *
     * Idempotent by construction: it is derived from stored state, carries no
     * "new" flag, and the client redraws the panel when it arrives.
     */
    if (game.phase === 'gameover') this.broadcastMatchResult(game, ws);
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
          // A computer player is always "connected": there is no socket to
          // drop, and showing it greyed out like an absent human would be a
          // lie about a seat that is going to take its turn.
          connected: player.bot !== null || connected.has(player.id),
          colorIndex: player.colorIndex,
          bot: player.bot,
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
    // `bot` is normalised on the way out rather than trusted, because a row
    // written before the field existed simply has no key — and a seat whose
    // `bot` came back `undefined` would be neither a person nor a computer
    // player, which is the sort of third state that gets found in production.
    // `serialize.ts` reads the same field the same way, for the same reason.
    return this.readKv<RoomPlayer[]>('players', []).map((player) => ({
      ...player,
      bot: player.bot ?? null,
    }));
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
    secret: typeof candidate.secret === 'string' ? candidate.secret : null,
    name: typeof candidate.name === 'string' ? candidate.name : '',
    spectator: candidate.spectator === true,
  };
}

/** Which computer player holds a seat, or null for a person or no seat at all. */
function botSeatOf(state: GameState, tankIndex: number): BotPersonality | null {
  return state.tanks[tankIndex]?.bot ?? null;
}

/**
 * Is the room waiting on a machine rather than on a person?
 *
 * One definition, read by all three places that care — the alarm that decides
 * whether to fire or to time out, the clock that decides how long to wait, and
 * the spectator arrival that decides whether to restart a stopped clock. Three
 * copies of `phase === 'aiming' && tank.bot !== null` would be three chances to
 * disagree about it, and a room that thinks a seat is a bot when it arms the
 * clock and a person when the clock fires times a computer player out.
 *
 * The phase half is not decoration, and it is the half that looks removable.
 * `endRound` in `packages/sim/src/game.ts` leaves `activeTank` where it was, so
 * a bot that fires the shot which wins a round is still the active seat while
 * the room sits in `shopping`. On the seat alone this reads as "a machine is
 * up": the room would arm the pause in front of a bot shot instead of the shop
 * clock, wake, ask `fire()` to shoot during `shopping`, and abandon the match on
 * the refusal — throwing a solo player out of a round they just won. Pinned by
 * "does not mistake the shop for a computer player's turn when a bot ends the
 * round" in the server suite.
 */
function isBotTurn(state: GameState): boolean {
  return state.phase === 'aiming' && botSeatOf(state, state.activeTank) !== null;
}

/**
 * A name for a new computer player: its personality, numbered if the lobby
 * already has one.
 *
 * Numbered rather than randomised because two tanks called "Shooter" is a
 * scoreboard nobody can read, and `PlayerNameSchema` caps a name at 16
 * characters — "Annihilator 8" is 13, and eight seats is the most this room has.
 */
function botName(personality: BotPersonality, players: readonly RoomPlayer[]): string {
  const base = BOT_DISPLAY_NAMES[personality];
  const taken = new Set(players.map((player) => player.name));
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix <= MAX_PLAYERS + 1; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
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
