/**
 * @scorched/protocol — the wire format.
 *
 * Every WebSocket message in both directions is defined here as a Zod schema
 * and validated on both ends. The server treats client input as hostile until
 * it has parsed; the client treats server output as authoritative only after it
 * has parsed. There is no third place where a message shape is written down.
 */

import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/** Cap on any single frame the server will even attempt to parse. */
export const MAX_MESSAGE_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Room codes are 4 uppercase letters — easy to read out loud. */
export const RoomCodeSchema = z
  .string()
  .regex(/^[A-Z]{4}$/, 'Room code must be four uppercase letters');

export const PlayerIdSchema = z.string().min(1).max(64);

export const PlayerNameSchema = z
  .string()
  .trim()
  .min(1, 'Name cannot be empty')
  .max(16, 'Name must be 16 characters or fewer')
  // Printable ASCII only: keeps rendering predictable and blocks control chars.
  .regex(/^[\x20-\x7E]+$/, 'Name contains unsupported characters');

export const WeaponIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9_]+$/, 'Weapon ids are lowercase snake_case');

export const AngleSchema = z.number().finite().min(0).max(180);
export const PowerSchema = z.number().finite().min(0).max(100);
export const TurnNumberSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Shared state shapes
// ---------------------------------------------------------------------------

export const TankSnapshotSchema = z.object({
  id: PlayerIdSchema,
  name: PlayerNameSchema,
  x: z.number().finite(),
  y: z.number().finite(),
  health: z.number().min(0),
  money: z.number().int().min(0),
  score: z.number().int(),
  alive: z.boolean(),
  angleDeg: AngleSchema,
  power: PowerSchema,
  selectedWeapon: WeaponIdSchema,
  inventory: z.record(WeaponIdSchema, z.number().int().min(0)),
  colorIndex: z.number().int().min(0),
});
export type TankSnapshot = z.infer<typeof TankSnapshotSchema>;

export const TerrainSnapshotSchema = z.object({
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  surface: z.array(z.number().int()).max(4096),
});
export type TerrainSnapshot = z.infer<typeof TerrainSnapshotSchema>;

export const GamePhaseSchema = z.enum(['lobby', 'aiming', 'resolving', 'shopping', 'gameover']);

export const GameSnapshotSchema = z.object({
  seed: z.number().int(),
  round: z.number().int().positive(),
  totalRounds: z.number().int().positive(),
  phase: GamePhaseSchema,
  terrain: TerrainSnapshotSchema,
  tanks: z.array(TankSnapshotSchema).max(16),
  activeTank: z.number().int().min(0),
  turnNumber: TurnNumberSchema,
  wind: z.number().finite(),
  winnerId: PlayerIdSchema.nullable(),
  pendingShoppers: z.array(PlayerIdSchema).max(16),
});
export type GameSnapshot = z.infer<typeof GameSnapshotSchema>;

/** Mirrors `GameEvent` in @scorched/sim. Kept structural so sim stays dependency-free. */
export const GameEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('shot'),
    tankIndex: z.number().int().min(0),
    weapon: WeaponIdSchema,
    path: z.array(z.number().finite()),
    impactKind: z.string().max(32),
  }),
  z.object({
    type: z.literal('explosion'),
    x: z.number().finite(),
    y: z.number().finite(),
    radius: z.number().finite().positive(),
    weapon: WeaponIdSchema,
  }),
  z.object({
    type: z.literal('dirt'),
    x: z.number().finite(),
    y: z.number().finite(),
    radius: z.number().finite().positive(),
  }),
  z.object({
    type: z.literal('damage'),
    tankIndex: z.number().int().min(0),
    amount: z.number().min(0),
    healthAfter: z.number().min(0),
  }),
  z.object({
    type: z.literal('death'),
    tankIndex: z.number().int().min(0),
    byTankIndex: z.number().int().min(0).nullable(),
  }),
  z.object({
    type: z.literal('turn'),
    activeTank: z.number().int().min(0),
    turnNumber: TurnNumberSchema,
    wind: z.number().finite(),
  }),
  z.object({
    type: z.literal('roundEnd'),
    round: z.number().int().positive(),
    survivors: z.array(PlayerIdSchema),
  }),
  z.object({
    type: z.literal('gameOver'),
    winnerId: PlayerIdSchema.nullable(),
  }),
]);
export type WireGameEvent = z.infer<typeof GameEventSchema>;

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    protocol: z.literal(PROTOCOL_VERSION),
    name: PlayerNameSchema,
    /** Present when reconnecting to a game already in progress. */
    sessionId: PlayerIdSchema.optional(),
  }),
  z.object({ t: z.literal('ready'), ready: z.boolean() }),
  z.object({ t: z.literal('start') }),
  z.object({
    t: z.literal('aim'),
    angleDeg: AngleSchema,
    power: PowerSchema,
    weapon: WeaponIdSchema,
  }),
  z.object({
    t: z.literal('fire'),
    turnNumber: TurnNumberSchema,
    angleDeg: AngleSchema,
    power: PowerSchema,
    weapon: WeaponIdSchema,
  }),
  z.object({
    t: z.literal('buy'),
    weapon: WeaponIdSchema,
    quantity: z.number().int().min(1).max(99),
  }),
  z.object({ t: z.literal('sell'), weapon: WeaponIdSchema }),
  z.object({ t: z.literal('shopDone') }),
  z.object({ t: z.literal('chat'), text: z.string().trim().min(1).max(200) }),
  z.object({ t: z.literal('ping'), nonce: z.number().int() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export const LobbyPlayerSchema = z.object({
  id: PlayerIdSchema,
  name: PlayerNameSchema,
  ready: z.boolean(),
  connected: z.boolean(),
  colorIndex: z.number().int().min(0),
});
export type LobbyPlayer = z.infer<typeof LobbyPlayerSchema>;

export const ServerErrorCodeSchema = z.enum([
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
export type ServerErrorCode = z.infer<typeof ServerErrorCodeSchema>;

export const ServerMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('welcome'),
    protocol: z.literal(PROTOCOL_VERSION),
    sessionId: PlayerIdSchema,
    roomCode: RoomCodeSchema,
    you: PlayerIdSchema,
  }),
  z.object({
    t: z.literal('lobby'),
    roomCode: RoomCodeSchema,
    players: z.array(LobbyPlayerSchema).max(16),
    hostId: PlayerIdSchema.nullable(),
  }),
  z.object({
    t: z.literal('state'),
    snapshot: GameSnapshotSchema,
  }),
  z.object({
    t: z.literal('events'),
    /** The turn these events resolved. Clients apply them in order. */
    turnNumber: TurnNumberSchema,
    events: z.array(GameEventSchema).max(4096),
    /** Authoritative state after the events — clients reconcile against it. */
    snapshot: GameSnapshotSchema,
  }),
  z.object({
    t: z.literal('aim'),
    playerId: PlayerIdSchema,
    angleDeg: AngleSchema,
    power: PowerSchema,
    weapon: WeaponIdSchema,
  }),
  z.object({
    t: z.literal('chat'),
    playerId: PlayerIdSchema,
    name: PlayerNameSchema,
    text: z.string().max(200),
  }),
  z.object({
    t: z.literal('error'),
    code: ServerErrorCodeSchema,
    message: z.string().max(300),
  }),
  z.object({ t: z.literal('pong'), nonce: z.number().int() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---------------------------------------------------------------------------
// Parse / serialise helpers
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseJson(raw: string): ParseResult<unknown> {
  if (raw.length > MAX_MESSAGE_BYTES) {
    return { ok: false, error: `Message too large (${raw.length} bytes)` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, error: 'Malformed JSON' };
  }
}

/**
 * Parse an inbound client frame. Never throws — a hostile client should get an
 * error message back, not take the room down.
 */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  const json = parseJson(raw);
  if (!json.ok) return json;

  const result = ClientMessageSchema.safeParse(json.value);
  if (!result.success) {
    return { ok: false, error: formatZodError(result.error) };
  }
  return { ok: true, value: result.data };
}

/** Parse an inbound server frame on the client. Never throws. */
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  const json = parseJson(raw);
  if (!json.ok) return json;

  const result = ServerMessageSchema.safeParse(json.value);
  if (!result.success) {
    return { ok: false, error: formatZodError(result.error) };
  }
  return { ok: true, value: result.data };
}

/** Serialise an outbound server frame, validating on the way out. */
export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(ServerMessageSchema.parse(message));
}

/** Serialise an outbound client frame, validating on the way out. */
export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(ClientMessageSchema.parse(message));
}

function formatZodError(error: z.ZodError): string {
  const first = error.issues[0];
  if (first === undefined) return 'Invalid message';
  const path = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return `${path}${first.message}`;
}
