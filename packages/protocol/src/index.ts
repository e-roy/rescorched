/**
 * @scorched/protocol — the wire format.
 *
 * Every WebSocket message in both directions is defined here as a Zod schema
 * and validated on both ends. The server treats client input as hostile until
 * it has parsed; the client treats server output as authoritative only after it
 * has parsed. There is no third place where a message shape is written down.
 *
 * Two rules keep this file honest:
 *
 * 1. **Bound everything an attacker controls.** Every string has a maximum
 *    length, every array a maximum count, every record a maximum key count and
 *    every number a range. A schema that accepts an unbounded value is a schema
 *    that hands the other end an allocation the attacker chose the size of.
 * 2. **Never widen a server-bound schema to make a client convenient.** The
 *    server is authoritative; if a field would let a client assert an outcome,
 *    it does not belong on the wire.
 */

import { z } from 'zod';

/**
 * Bumped when the wire format changes in a way an older peer cannot read.
 *
 * v2 packs the terrain heightmap (see `packSurface`), which a v1 client would
 * receive as a `packed` string it does not know how to expand. Both ends carry
 * their version in the handshake (`hello` / `welcome`) and a mismatch is
 * reported as `bad_protocol` rather than as a generic schema failure — see
 * `describeVersionMismatch`.
 *
 * Computer players did NOT bump it, and the reason is worth writing down so the
 * next additive change does not have to re-derive it. The test for a bump is
 * "can an older peer still read what this build sends", not "is there anything
 * new here":
 *
 *  - `addBot` / `removeBot` are new members of the CLIENT union. Nothing
 *    receives a client frame except our own server, and an older server would
 *    refuse them — but an older server is also an older client, which has no
 *    way to send one, because these frames exist only behind a button that
 *    shipped in the same build. Nothing an old peer receives changed.
 *  - `LobbyPlayer.bot` is a new OPTIONAL field on a server frame. Zod ignores
 *    keys a schema does not mention, so a pre-bot client parses a lobby frame
 *    containing it exactly as before and simply does not draw the badge.
 *
 * Bumping anyway would not be free: the mismatch is reported as "reload to
 * update" and every open tab gets thrown out of its room to gain nothing. What
 * WOULD require a bump is a field an older peer needs and cannot get, or a
 * change to the meaning of one it already reads. `protocol.test.ts` pins the
 * additive half of this by round-tripping a lobby frame with and without `bot`.
 */
export const PROTOCOL_VERSION = 2;

/**
 * Frame size caps, which are deliberately NOT the same in both directions.
 *
 * Inbound client frames are hostile until proven otherwise: nothing a player
 * legitimately sends is anywhere near 16 KB (the largest is a `fire` at a few
 * hundred bytes), so a tight cap is free protection against someone trying to
 * make the room chew on a megabyte of JSON.
 *
 * Outbound server frames are a different problem. An `events` frame carries the
 * turn's trajectories plus the authoritative snapshot, and the snapshot alone is
 * several KB because it contains the full 1280-column heightmap. A Funky Bomb —
 * one blast plus eight sub-munition arcs — measured 18,255 bytes. Under a shared
 * 16 KB cap the client HARD-REJECTED those frames, so the game simply broke on
 * about 5% of shots (38 of 756 measured), and it broke worse the more
 * interesting the weapon was.
 *
 * Those two figures — 18,255 and 38 of 756 — are the historical measurement that
 * motivated splitting the caps, recorded here as the reason this code looks the
 * way it does. They are NOT re-measured on each run and they will drift as the
 * arsenal and the physics change; `frame-size.test.ts` prints today's equivalents
 * on every run and asserts headroom rather than a constant.
 *
 * The generous cap here is still a bound, not an absence of one: it exists to
 * stop a runaway frame exhausting client memory, not to police a server the
 * client is already trusting to adjudicate the whole match.
 *
 * Since then the heightmap moved to the packed encoding below, which takes
 * roughly a fifth off the worst frame in the arsenal — enough that it now fits
 * under the old shared cap again. The split stays anyway. The cap on what a
 * hostile client may SEND has nothing to do with the size of what our own
 * server legitimately BROADCASTS, and re-merging them would re-arm exactly the
 * bug above the next time a weapon gets more interesting.
 *
 * No absolute frame size is quoted here on purpose: it moves every time the
 * arsenal or the physics does. `frame-size.test.ts` sweeps every weapon against
 * the real sim on each run, prints the current worst packed and unpacked
 * figures, and asserts the ratio between them rather than a constant.
 */
export const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;
export const MAX_SERVER_MESSAGE_BYTES = 512 * 1024;

/** @deprecated Use the direction-specific cap. Kept so callers do not silently change meaning. */
export const MAX_MESSAGE_BYTES = MAX_CLIENT_MESSAGE_BYTES;

// ---------------------------------------------------------------------------
// Bounds
//
// These are the numbers the schemas below are built from. Each is generous
// against what the game actually produces (the frame-size test measures the
// real values) and tight against what an attacker could ask us to allocate.
// ---------------------------------------------------------------------------

/** Seats in one room. The server's own MAX_PLAYERS is smaller; this is the wire ceiling. */
export const MAX_PLAYERS_PER_ROOM = 16;
/** Spectators listed by name in a `spectators` frame. The count may exceed this. */
export const MAX_SPECTATORS_LISTED = 32;
/** Columns in a heightmap. 1280 today; 4096 leaves room for a wider board. */
export const MAX_TERRAIN_WIDTH = 4096;
/** Rows. Bounds every y coordinate that can reach a renderer. */
export const MAX_TERRAIN_HEIGHT = 4096;
/**
 * Flat `[x, y, x, y, …]` values in one trajectory. The sim decimates long
 * flights before they cross the wire, so a real arc is a few hundred values —
 * `frame-size.test.ts` measures the current worst and fails if it climbs
 * anywhere near this.
 */
export const MAX_TRAJECTORY_VALUES = 8192;
/** Events in one `events` frame. A real turn produces tens, not thousands. */
export const MAX_EVENTS_PER_FRAME = 4096;
/** Distinct weapons a tank may carry. The arsenal is 21. */
export const MAX_INVENTORY_ENTRIES = 128;
/** Characters in a chat line. */
export const MAX_CHAT_CHARS = 200;
/** Blast radius in pixels. The biggest weapon is 120. */
export const MAX_BLAST_RADIUS = 512;
/** Rounds in a match. */
export const MAX_ROUNDS = 1000;
/** Turns in a match, and the highest turn number a client may echo back. */
export const MAX_TURN_NUMBER = 1_000_000;
/**
 * How far outside the board a coordinate may sit. Sub-munitions and rollers
 * legitimately drift off the edge; nothing legitimate lands 16k pixels away.
 */
export const MAX_WORLD_COORD = 16_384;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Room codes are 4 uppercase letters — easy to read out loud. */
export const RoomCodeSchema = z
  .string()
  .regex(/^[A-Z]{4}$/, 'Room code must be four uppercase letters');

/**
 * Session ids are `crypto.randomUUID()` server-side, but ids also appear as
 * object keys and in DOM text, so the alphabet is restricted rather than
 * "any 64 characters": no control characters, no surrogates, no whitespace.
 */
export const PlayerIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Player id must be 1-64 characters of [A-Za-z0-9_-]');

export const PlayerNameSchema = z
  .string()
  .trim()
  .min(1, 'Name cannot be empty')
  .max(16, 'Name must be 16 characters or fewer')
  // Printable ASCII only: keeps rendering predictable and blocks control chars.
  .regex(/^[\x20-\x7E]+$/, 'Name contains unsupported characters');

/**
 * Weapon ids are lowercase snake_case. The negative lookahead is not paranoia
 * about the weapon table — it is because these ids are used as *object keys*
 * in `inventory`, and a key called `__proto__` is a different kind of value
 * from a key called `nuke`.
 */
export const WeaponIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(
    /^(?!__proto__$|constructor$|prototype$)[a-z0-9_]+$/,
    'Weapon ids are lowercase snake_case',
  );

export const AngleSchema = z.number().finite().min(0).max(180);
export const PowerSchema = z.number().finite().min(0).max(100);
export const TurnNumberSchema = z.number().int().nonnegative().max(MAX_TURN_NUMBER);
export const TankIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_PLAYERS_PER_ROOM - 1);
export const RoundSchema = z.number().int().positive().max(MAX_ROUNDS);
/** A position on (or just off) the board. Finite and bounded so a renderer cannot be walked off a cliff. */
export const WorldCoordSchema = z.number().finite().min(-MAX_WORLD_COORD).max(MAX_WORLD_COORD);
/**
 * One column of the heightmap. Integer, because terrain columns are whole
 * pixels and because the packed codec below can only represent integers.
 *
 * This is the bound the packed codec must agree with — see
 * `SURFACE_MAX_MAGNITUDE`. If the two ever drift apart, the packed branch of
 * `TerrainSnapshotSchema` becomes a hole straight through this bound.
 */
export const SurfaceColumnSchema = z.number().int().min(-MAX_WORLD_COORD).max(MAX_WORLD_COORD);
/** Health, damage: non-negative and bounded well above the 100 the game uses. */
export const HealthSchema = z.number().finite().min(0).max(1_000_000);
/** Cash. Integer — there are no fractional dollars in the shop. */
export const MoneySchema = z.number().int().min(0).max(1_000_000_000);
export const ScoreSchema = z.number().int().min(-1_000_000_000).max(1_000_000_000);
export const ColorIndexSchema = z.number().int().min(0).max(63);
export const WindSchema = z.number().finite().min(-1000).max(1000);
/** A duration in milliseconds. Relative, never a wall-clock instant — see `turnTimer`. */
export const DurationMsSchema = z
  .number()
  .int()
  .min(0)
  .max(24 * 60 * 60 * 1000);
/**
 * A `ping`/`pong` correlator. The value means nothing to either end beyond "this
 * pong answers that ping", so 32 bits is a ceiling no legitimate sender reaches
 * by accident, and Rule 1 at the top of this file — every number a range — gets
 * to be true. It was `.min(0)` alone: bounded below, unbounded above, so
 * `{"t":"ping","nonce":9007199254740991}` parsed clean in BOTH directions. A
 * tiny blast radius, but this file's whole value is that its bounds are real.
 */
export const MAX_NONCE = 0xffffffff;
export const NonceSchema = z.number().int().min(0).max(MAX_NONCE);

/**
 * Free text a player typed. Rejects C0/C1 control characters, lone surrogates
 * (which cannot be re-encoded to UTF-8 and crash naive consumers) and the bidi
 * override characters, which let one player visually rewrite another's line.
 * Everything else — accents, CJK, emoji including ZWJ sequences — is allowed.
 */
export const ChatTextSchema = z
  .string()
  .trim()
  .min(1, 'Message cannot be empty')
  .max(MAX_CHAT_CHARS, `Message must be ${MAX_CHAT_CHARS} characters or fewer`)
  .regex(
    /^[^\p{Cc}\p{Cs}\u202A-\u202E\u2066-\u2069]+$/u,
    'Message contains unsupported characters',
  );

// ---------------------------------------------------------------------------
// Heightmap packing
//
// The snapshot carries the whole terrain in every frame, and as plain JSON that
// was the single largest thing on the wire: 5,159 characters for a 1280-column
// board against 1,320 packed, a 74% cut. A `state` frame is almost nothing but
// heightmap, so it goes from 5,874 characters to 2,035. `frame-size.test.ts`
// re-measures and prints all four numbers on every run.
//
// The encoding is lossless by construction, which is the only interesting
// requirement: if the two clients disagree about one column of dirt they
// disagree about who died. Values are integers, so nothing is rounded and
// nothing is approximated. Columns are delta-coded (neighbouring heights differ
// by a few pixels), zig-zagged so small negative deltas stay small, then written
// little-endian in base-32 digits with the 0x20 bit marking "another digit
// follows". A flat column costs one character.
//
// The decoder is a second front door into the schema, and that is the thing to
// keep in mind when touching it. `TerrainSnapshotSchema` bounds the plain
// `surface` array to `SurfaceColumnSchema`; the `packed` branch hands the
// decoder's output through instead, so whatever the decoder is willing to
// return IS the effective bound on a column. The two must therefore be the same
// number, which is why `SURFACE_MAX_MAGNITUDE` is defined as `MAX_WORLD_COORD`
// rather than as a comfortable round constant of its own.
// ---------------------------------------------------------------------------

const SURFACE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const SURFACE_RADIX = 32;
const SURFACE_MORE = 32;
/**
 * The widest column the codec will encode or decode.
 *
 * MUST equal the bound on `SurfaceColumnSchema`. It is not a separate policy
 * about "values that fit a heightmap" — it is the same policy, reached through
 * the other door. A decoder that returns more than the schema would have
 * accepted does not merely allow a strange number: it hands the renderer a
 * column the array branch would have refused, and it produces a value that
 * `encodeServerMessage` will then throw on, because the encoder validates
 * against the schema. `surface-codec.test.ts` pins the two together
 * behaviourally at exactly +/-MAX_WORLD_COORD.
 */
const SURFACE_MAX_MAGNITUDE = MAX_WORLD_COORD;
/**
 * The largest zig-zagged value the codec can legitimately see. A column steps
 * from -MAX to +MAX at worst, so the delta spans 2x the range and zig-zagging
 * doubles it again — 4x the magnitude, not 2x.
 *
 * This was `* 2`, which is the number the prose above already argued against.
 * The effect was that the decoder rejected, as corrupt, any stream containing a
 * full-range step: `unpackSurface(packSurface([-16384, 16384]))` returned null.
 * Real terrain never steps that far so nothing in the game noticed, but the
 * codec's contract is the schema's range, and it did not hold across it.
 */
const SURFACE_MAX_ZIGZAG = SURFACE_MAX_MAGNITUDE * 4;
/**
 * Characters one column can cost. `SURFACE_MAX_ZIGZAG` is 65,536, which needs
 * four base-32 digits (32^3 = 32,768 fits, 32^4 does not), so four is exact
 * rather than generous — a fifth digit can only be a non-canonical encoding or
 * a run of padding designed to overflow `scale`.
 */
const SURFACE_MAX_DIGITS_PER_COLUMN = 4;
/** The longest packed string that can describe a legal board. */
export const MAX_PACKED_SURFACE_CHARS = MAX_TERRAIN_WIDTH * SURFACE_MAX_DIGITS_PER_COLUMN;

const SURFACE_DIGITS = new Map<string, number>();
for (let index = 0; index < SURFACE_ALPHABET.length; index += 1) {
  SURFACE_DIGITS.set(SURFACE_ALPHABET.charAt(index), index);
}

/** The characters `packSurface` can emit — all JSON- and URL-safe. */
export const PACKED_SURFACE_PATTERN = /^[A-Za-z0-9_-]*$/;

/**
 * Compress a heightmap to a string. Throws on input the schema would have
 * rejected anyway — like every other encode path here, an invalid outbound
 * value is a bug on our side, not something to paper over.
 */
export function packSurface(surface: readonly number[]): string {
  if (surface.length > MAX_TERRAIN_WIDTH) {
    throw new RangeError(`Heightmap has ${surface.length} columns, limit ${MAX_TERRAIN_WIDTH}`);
  }

  let out = '';
  let previous = 0;
  for (const value of surface) {
    if (
      !Number.isInteger(value) ||
      value > SURFACE_MAX_MAGNITUDE ||
      value < -SURFACE_MAX_MAGNITUDE
    ) {
      throw new RangeError(`Heightmap column ${value} is not a packable integer`);
    }
    const delta = value - previous;
    previous = value;

    // Zig-zag: 0, -1, 1, -2, 2 … so a small step down is as cheap as a small
    // step up. Written with * / rather than shifts because a shift would wrap
    // at 32 bits and silently corrupt a large delta.
    let remaining = delta >= 0 ? delta * 2 : delta * -2 - 1;
    for (;;) {
      const digit = remaining % SURFACE_RADIX;
      remaining = (remaining - digit) / SURFACE_RADIX;
      out += SURFACE_ALPHABET.charAt(remaining > 0 ? digit + SURFACE_MORE : digit);
      if (remaining === 0) break;
    }
  }
  return out;
}

/**
 * Expand a packed heightmap. Returns `null` for anything malformed — an unknown
 * character, a truncated final value, a padded (non-canonical) value, a column
 * outside +/-MAX_WORLD_COORD, or more columns than a board can have. Never
 * throws.
 *
 * Every element of a non-null result satisfies `SurfaceColumnSchema`. Callers
 * rely on that: the packed branch of `TerrainSnapshotSchema` does not re-check
 * the columns, because this function's range IS that schema's range.
 */
export function unpackSurface(packed: string): number[] | null {
  if (packed.length > MAX_PACKED_SURFACE_CHARS) return null;

  const out: number[] = [];
  let accumulated = 0;
  let scale = 1;
  let previous = 0;
  let pending = false;

  for (let index = 0; index < packed.length; index += 1) {
    const digit = SURFACE_DIGITS.get(packed.charAt(index));
    if (digit === undefined) return null;

    // Digits are non-negative and `scale` only grows, so a partial value that is
    // already too big can only get bigger — bailing here is safe and stops the
    // arithmetic before it can reach a magnitude where doubles stop being exact.
    accumulated += (digit % SURFACE_RADIX) * scale;
    if (accumulated > SURFACE_MAX_ZIGZAG) return null;

    if (digit >= SURFACE_MORE) {
      scale *= SURFACE_RADIX;
      // A continuation run longer than a real value needs is not a large number,
      // it is padding. Left unbounded, `scale` reaches Infinity after ~205 zero
      // digits and `0 * Infinity` is NaN, which sails past every `>` comparison
      // below and lands a NaN column in the renderer. Measured before this
      // guard existed: unpackSurface('g'.repeat(205) + 'A') returned [NaN].
      if (scale > SURFACE_MAX_ZIGZAG) return null;
      pending = true;
      continue;
    }

    const delta = accumulated % 2 === 0 ? accumulated / 2 : -(accumulated + 1) / 2;
    previous += delta;
    if (previous > SURFACE_MAX_MAGNITUDE || previous < -SURFACE_MAX_MAGNITUDE) return null;
    if (out.length >= MAX_TERRAIN_WIDTH) return null;
    out.push(previous);

    accumulated = 0;
    scale = 1;
    pending = false;
  }

  // A trailing continuation digit means the sender was cut off mid-value.
  return pending ? null : out;
}

// ---------------------------------------------------------------------------
// Shared state shapes
// ---------------------------------------------------------------------------

export const TankSnapshotSchema = z.object({
  id: PlayerIdSchema,
  name: PlayerNameSchema,
  x: WorldCoordSchema,
  y: WorldCoordSchema,
  health: HealthSchema,
  money: MoneySchema,
  score: ScoreSchema,
  alive: z.boolean(),
  angleDeg: AngleSchema,
  power: PowerSchema,
  selectedWeapon: WeaponIdSchema,
  inventory: z
    .record(WeaponIdSchema, z.number().int().min(0).max(9999))
    .refine(
      (inventory) => Object.keys(inventory).length <= MAX_INVENTORY_ENTRIES,
      `Inventory may hold at most ${MAX_INVENTORY_ENTRIES} distinct weapons`,
    ),
  colorIndex: ColorIndexSchema,
});
export type TankSnapshot = z.infer<typeof TankSnapshotSchema>;

/**
 * The heightmap, accepted either as a plain array or in the packed form above,
 * and always handed to callers as a plain array. Both ends therefore see the
 * shape they have always seen; only the bytes between them changed.
 */
export const TerrainSnapshotSchema = z
  .object({
    width: z.number().int().positive().max(MAX_TERRAIN_WIDTH),
    height: z.number().int().positive().max(MAX_TERRAIN_HEIGHT),
    surface: z.array(SurfaceColumnSchema).max(MAX_TERRAIN_WIDTH).optional(),
    packed: z
      .string()
      .max(MAX_PACKED_SURFACE_CHARS)
      .regex(PACKED_SURFACE_PATTERN, 'Packed heightmap contains unsupported characters')
      .optional(),
  })
  .transform((terrain, ctx) => {
    // Both branches produce columns bounded by `SurfaceColumnSchema`: the array
    // branch because Zod checked it, the packed branch because the decoder's
    // range is defined as that same bound. Do not "optimise" either bound
    // independently of the other — the two together are what stops a hostile
    // frame walking the renderer off a cliff through whichever door is looser.
    const surface =
      terrain.surface ?? (terrain.packed === undefined ? null : unpackSurface(terrain.packed));

    if (surface === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Terrain must carry either "surface" or a valid "packed" heightmap',
      });
      return z.NEVER;
    }
    // A heightmap that does not cover the board is not a rendering glitch: the
    // client indexes it by column, so a short one is undefined ground.
    if (surface.length !== terrain.width) {
      ctx.addIssue({
        code: 'custom',
        message: `Heightmap has ${surface.length} columns but the board is ${terrain.width} wide`,
      });
      return z.NEVER;
    }
    return { width: terrain.width, height: terrain.height, surface };
  });
export type TerrainSnapshot = z.infer<typeof TerrainSnapshotSchema>;

export const GamePhaseSchema = z.enum(['lobby', 'aiming', 'resolving', 'shopping', 'gameover']);
/** Exported as a type so `sim-boundary.test.ts` can pin it against the sim's own union. */
export type GamePhase = z.infer<typeof GamePhaseSchema>;

export const GameSnapshotSchema = z.object({
  seed: z.number().int().min(0).max(0xffffffff),
  round: RoundSchema,
  totalRounds: RoundSchema,
  phase: GamePhaseSchema,
  terrain: TerrainSnapshotSchema,
  tanks: z.array(TankSnapshotSchema).max(MAX_PLAYERS_PER_ROOM),
  activeTank: TankIndexSchema,
  turnNumber: TurnNumberSchema,
  wind: WindSchema,
  winnerId: PlayerIdSchema.nullable(),
  pendingShoppers: z.array(PlayerIdSchema).max(MAX_PLAYERS_PER_ROOM),
});
export type GameSnapshot = z.infer<typeof GameSnapshotSchema>;

/**
 * How a shot ended, as far as the client's animation is concerned: it hit dirt,
 * it hit a tank, it left the board sideways, or it simply ran out of flight.
 *
 * These four are the sim's `ImpactKind` union (`packages/sim/src/physics.ts`),
 * and `sim-boundary.test.ts` pins the two sets together *in both directions* at
 * compile time. That test is the enforcement; this array is only the copy of it
 * that lives on our side of the boundary.
 */
export const IMPACT_KINDS = ['terrain', 'tank', 'wall', 'expired'] as const;
export type ImpactKind = (typeof IMPACT_KINDS)[number];

/**
 * The bound the wire actually applies to `impactKind` — a shape bound, not the
 * enum. This is the one field here that is deliberately NOT a `z.enum`, and the
 * reason is worth writing down because the obvious tightening is a trap.
 *
 * `GameEventSchema` only ever travels server → client. A closed enum here buys
 * no protection from a hostile peer, because no client can send one. What it
 * costs is severe: `encodeServerMessage` validates on the way out, and the room
 * calls it while building the turn's `events` frame — outside the try in
 * `broadcast()`. A single cosmetic string the enum did not happen to list would
 * therefore take the whole turn's frame with it and leave every client waiting
 * for a turn that never arrives. That is the same shape of mistake as the shared
 * 16 KB cap recorded above: strictness in the direction where strictness buys
 * nothing and costs the match.
 *
 * The set of kinds is still enforced — at compile time, against the sim's own
 * union, which is where a divergence should surface. Clients that want to switch
 * exhaustively narrow with `isKnownImpactKind` and keep a default branch.
 */
export const ImpactKindSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_]*$/, 'Impact kinds are lowercase snake_case');

/** Narrow a wire `impactKind` to the four the client knows how to animate. */
export function isKnownImpactKind(kind: string): kind is ImpactKind {
  return (IMPACT_KINDS as readonly string[]).includes(kind);
}

/**
 * Mirrors `GameEvent` in @scorched/sim. Kept structural so sim stays
 * dependency-free; `sim-boundary.test.ts` is what stops "structural" drifting
 * into "unrelated".
 *
 * This union is a strict SUPERSET of the sim's: `timeout` is emitted by the
 * room, not by the sim, because a clock is not a game rule and `packages/sim`
 * has no clock. Everything else here comes from the sim.
 */
export const GameEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('shot'),
    tankIndex: TankIndexSchema,
    weapon: WeaponIdSchema,
    /** Flat `[x, y, x, y, …]`. An odd length would leave a renderer reading past the end. */
    path: z
      .array(WorldCoordSchema)
      .max(MAX_TRAJECTORY_VALUES)
      .refine((path) => path.length % 2 === 0, 'Trajectory must be (x, y) pairs'),
    impactKind: ImpactKindSchema,
  }),
  z.object({
    type: z.literal('explosion'),
    x: WorldCoordSchema,
    y: WorldCoordSchema,
    radius: z.number().finite().positive().max(MAX_BLAST_RADIUS),
    weapon: WeaponIdSchema,
  }),
  z.object({
    type: z.literal('dirt'),
    x: WorldCoordSchema,
    y: WorldCoordSchema,
    radius: z.number().finite().positive().max(MAX_BLAST_RADIUS),
  }),
  z.object({
    type: z.literal('damage'),
    tankIndex: TankIndexSchema,
    amount: HealthSchema,
    healthAfter: HealthSchema,
  }),
  z.object({
    type: z.literal('death'),
    tankIndex: TankIndexSchema,
    byTankIndex: TankIndexSchema.nullable(),
  }),
  z.object({
    type: z.literal('turn'),
    activeTank: TankIndexSchema,
    turnNumber: TurnNumberSchema,
    wind: WindSchema,
  }),
  /**
   * A turn that ended because the clock ran out rather than because someone
   * fired. Carried here so the turn machine has somewhere to say so, and so the
   * client can show "Bob ran out of time" instead of a silent hand-off.
   */
  z.object({
    type: z.literal('timeout'),
    tankIndex: TankIndexSchema,
    turnNumber: TurnNumberSchema,
  }),
  z.object({
    type: z.literal('roundEnd'),
    round: RoundSchema,
    survivors: z.array(PlayerIdSchema).max(MAX_PLAYERS_PER_ROOM),
  }),
  z.object({
    type: z.literal('gameOver'),
    winnerId: PlayerIdSchema.nullable(),
  }),
]);
export type WireGameEvent = z.infer<typeof GameEventSchema>;

/** How a seat is occupied. Spectators receive state and may chat; they never fire. */
export const PlayerRoleSchema = z.enum(['player', 'spectator']);
export type PlayerRole = z.infer<typeof PlayerRoleSchema>;

/**
 * The computer players a lobby can seat.
 *
 * These are the sim's `BOT_PERSONALITIES` (`packages/sim/src/ai.ts`), copied
 * rather than imported for the same reason `IMPACT_KINDS` is: the sim must stay
 * dependency-free in both directions, so the two lists live on either side of
 * the boundary and `sim-boundary.test.ts` pins them together at compile time
 * AND by value. A personality the sim does not know would be a room that seats
 * a bot which then cannot decide anything.
 *
 * Closed enum here rather than a loose string, and unlike `ImpactKindSchema`
 * that is the right call: this one travels client -> server, where strictness
 * buys real protection. `addBot` names it, so an unknown value must be refused
 * at the parser rather than turned into a seat.
 */
export const BOT_PERSONALITIES = [
  'moron',
  'shooter',
  'tosser',
  'poolshark',
  'cyborg',
  'annihilator',
] as const;
export const BotPersonalitySchema = z.enum(BOT_PERSONALITIES);
export type BotPersonality = z.infer<typeof BotPersonalitySchema>;

// ---------------------------------------------------------------------------
// Client → Server
//
// Everything here is attacker-controlled. Note what is NOT here: no outcome, no
// damage, no terrain, no "I won". A client sends intent and nothing else.
// ---------------------------------------------------------------------------

export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    protocol: z.literal(PROTOCOL_VERSION),
    name: PlayerNameSchema,
    /** Present when reconnecting to a game already in progress. */
    sessionId: PlayerIdSchema.optional(),
    /**
     * Absent means 'player'. A room that is full may seat a would-be player as
     * a spectator instead — the server decides, and says so in `welcome`.
     */
    role: PlayerRoleSchema.optional(),
  }),
  z.object({ t: z.literal('ready'), ready: z.boolean() }),
  z.object({ t: z.literal('start') }),
  /**
   * Fill a seat with a computer player. Host only, lobby only — the server
   * enforces both; this is the request, not the permission.
   *
   * `personality` is optional so a client can offer "add a bot" without
   * offering a difficulty picker. The server picks the default when it is left
   * out, because "which bot is the sensible default" is a game decision and the
   * wire has no opinion.
   */
  z.object({
    t: z.literal('addBot'),
    personality: BotPersonalitySchema.optional(),
  }),
  /** Free a seat a computer player is sitting in. Host only, lobby only. */
  z.object({ t: z.literal('removeBot'), playerId: PlayerIdSchema }),
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
  z.object({ t: z.literal('chat'), text: ChatTextSchema }),
  z.object({ t: z.literal('ping'), nonce: NonceSchema }),
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
  colorIndex: ColorIndexSchema,
  /**
   * Which computer player holds this seat, or absent/null for a person.
   *
   * Optional rather than required so a client built before bots existed still
   * parses a lobby frame from a server that has them — the field simply is not
   * there for it. Note this is the LOBBY, not the snapshot: `TankSnapshot`
   * deliberately still has no `bot` field, because `packages/sim`'s
   * `GameSnapshot` promises to stay structurally identical to
   * `GameSnapshotSchema` and the personality is persistence, not wire state.
   * See the note on `PersistedTank` in `packages/sim/src/serialize.ts`.
   */
  bot: BotPersonalitySchema.nullable().optional(),
});
export type LobbyPlayer = z.infer<typeof LobbyPlayerSchema>;

export const SpectatorSchema = z.object({
  id: PlayerIdSchema,
  name: PlayerNameSchema,
});
export type Spectator = z.infer<typeof SpectatorSchema>;

/** Why the room's host changed. Purely so the client can word the notice. */
export const HostChangeReasonSchema = z.enum([
  'assigned',
  'host_left',
  'host_disconnected',
  'promoted',
]);

export const StandingSchema = z.object({
  playerId: PlayerIdSchema,
  name: PlayerNameSchema,
  /** 1 = winner. Ties share a place, so places may repeat. */
  place: z.number().int().min(1).max(MAX_PLAYERS_PER_ROOM),
  score: ScoreSchema,
  roundsWon: z.number().int().min(0).max(MAX_ROUNDS),
});
export type Standing = z.infer<typeof StandingSchema>;

/**
 * `room_not_found` is the one code here that is not about a move.
 *
 * A room code resolves to a Durable Object whether or not anybody has ever been
 * in it, so "no such room" cannot be a routing failure — it has to be a decision
 * the room makes and says out loud. Without it, a typo in a friend's code seated
 * the player alone in a brand new room that looked exactly like the one their
 * friend was waiting in.
 *
 * Adding a member to this enum did NOT bump `PROTOCOL_VERSION`, and the test for
 * that is the one stated at the top of this file: can an older peer still read
 * what this build sends? An older client would refuse the frame as a schema
 * failure and report "protocol error" instead of "no such room" — a worse
 * message on a connection that is being refused either way, and nothing it could
 * have done with the better one. That is not the kind of loss a version bump
 * exists to prevent; throwing every open tab out of its room to gain it would be.
 */
export const ServerErrorCodeSchema = z.enum([
  'bad_message',
  'bad_protocol',
  'room_full',
  'room_not_found',
  'room_closed',
  'not_your_turn',
  'stale_turn',
  'turn_expired',
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
  'not_host',
  'spectator_only',
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
    /** Absent means 'player' — the server may have seated you differently than you asked. */
    role: PlayerRoleSchema.optional(),
  }),
  z.object({
    t: z.literal('lobby'),
    roomCode: RoomCodeSchema,
    players: z.array(LobbyPlayerSchema).max(MAX_PLAYERS_PER_ROOM),
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
    events: z.array(GameEventSchema).max(MAX_EVENTS_PER_FRAME),
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
    text: ChatTextSchema,
  }),
  /**
   * How long the active player has left.
   *
   * `remainingMs` is relative on purpose. A deadline expressed as a wall-clock
   * instant is only as good as the agreement between two clocks, and the client
   * clock is set by the player — a deliberately slow one would read as extra
   * thinking time. The server is the only clock that decides anything; this
   * frame just tells the client what to draw.
   */
  z.object({
    t: z.literal('turnTimer'),
    turnNumber: TurnNumberSchema,
    activeTank: TankIndexSchema,
    remainingMs: DurationMsSchema,
    durationMs: DurationMsSchema,
  }),
  /**
   * Who is watching. `count` is authoritative; `viewers` is the first
   * `MAX_SPECTATORS_LISTED` of them, so a popular room does not turn its player
   * list into the largest thing on the wire.
   */
  z.object({
    t: z.literal('spectators'),
    count: z.number().int().min(0).max(100_000),
    viewers: z.array(SpectatorSchema).max(MAX_SPECTATORS_LISTED),
  }),
  /** Host migration. `hostId` is null while a room has nobody left to promote. */
  z.object({
    t: z.literal('host'),
    hostId: PlayerIdSchema.nullable(),
    reason: HostChangeReasonSchema,
  }),
  /** Final scoreboard. Sent once, after the last round resolves. */
  z.object({
    t: z.literal('matchResult'),
    winnerId: PlayerIdSchema.nullable(),
    roundsPlayed: RoundSchema,
    standings: z.array(StandingSchema).max(MAX_PLAYERS_PER_ROOM),
  }),
  z.object({
    t: z.literal('error'),
    code: ServerErrorCodeSchema,
    message: z.string().max(300),
  }),
  z.object({ t: z.literal('pong'), nonce: NonceSchema }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---------------------------------------------------------------------------
// Parse / serialise helpers
// ---------------------------------------------------------------------------

/**
 * Why a frame was refused. `bad_protocol` is called out separately because it
 * is the one failure that is not the peer's fault — it means the two ends are
 * different builds, and the fix is a reload, not a bug report.
 */
export type ParseErrorCode = 'too_large' | 'malformed_json' | 'bad_protocol' | 'bad_message';

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; error: string; code: ParseErrorCode };

export function describeVersionMismatch(claimed: number): string {
  return `Protocol version mismatch: peer speaks ${claimed}, this build speaks ${PROTOCOL_VERSION}. Reload to update.`;
}

function parseJson(raw: string, limit: number): ParseResult<unknown> {
  // Checked before JSON.parse so an oversized frame is never materialised as an
  // object graph. `raw.length` is UTF-16 units, so this is a slight
  // over-estimate of characters and an under-estimate of UTF-8 bytes; either
  // way it bounds the work by a constant.
  if (raw.length > limit) {
    return {
      ok: false,
      code: 'too_large',
      error: `Message too large (${raw.length} bytes, limit ${limit})`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    // Includes the RangeError that deeply nested input throws.
    return { ok: false, code: 'malformed_json', error: 'Malformed JSON' };
  }
}

/**
 * A version mismatch would otherwise surface as "protocol: Invalid input",
 * which tells a player nothing. Look for it before the union runs, and only for
 * an honestly-shaped integer — anything else is a malformed frame, not an old
 * build, and deserves the normal schema error.
 */
function versionMismatch(value: unknown, handshake: string): number | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record['t'] !== handshake) return null;
  const claimed = record['protocol'];
  if (typeof claimed !== 'number' || !Number.isInteger(claimed)) return null;
  return claimed === PROTOCOL_VERSION ? null : claimed;
}

/**
 * Parse an inbound client frame. Never throws — a hostile client should get an
 * error message back, not take the room down.
 */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  const json = parseJson(raw, MAX_CLIENT_MESSAGE_BYTES);
  if (!json.ok) return json;

  const claimed = versionMismatch(json.value, 'hello');
  if (claimed !== null) {
    return { ok: false, code: 'bad_protocol', error: describeVersionMismatch(claimed) };
  }

  const result = ClientMessageSchema.safeParse(json.value);
  if (!result.success) {
    return { ok: false, code: 'bad_message', error: formatZodError(result.error) };
  }
  return { ok: true, value: result.data };
}

/** Parse an inbound server frame on the client. Never throws. */
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  const json = parseJson(raw, MAX_SERVER_MESSAGE_BYTES);
  if (!json.ok) return json;

  const claimed = versionMismatch(json.value, 'welcome');
  if (claimed !== null) {
    return { ok: false, code: 'bad_protocol', error: describeVersionMismatch(claimed) };
  }

  const result = ServerMessageSchema.safeParse(json.value);
  if (!result.success) {
    return { ok: false, code: 'bad_message', error: formatZodError(result.error) };
  }
  return { ok: true, value: result.data };
}

/**
 * Serialise an outbound server frame, validating on the way out and packing the
 * heightmap. Every message carrying a snapshot must go through `toWire` — the
 * round-trip test asserts no server frame ever leaves with a raw `surface`
 * array in it.
 */
export function encodeServerMessage(message: ServerMessage): string {
  const validated = ServerMessageSchema.parse(message);
  return JSON.stringify(toWire(validated));
}

/**
 * `encodeServerMessage` without the throw.
 *
 * The throwing version is the right default: an outbound frame our own server
 * built and cannot serialise is a bug on our side, and swallowing it hides the
 * bug. But there is one caller where that trade is wrong. `broadcast()` in the
 * Durable Object encodes the turn's `events` frame BEFORE the loop that sends
 * it, and the encode sits outside the try that guards `socket.send`. A throw
 * there is not a dropped log line: nobody receives the turn, every client sits
 * waiting for events that never arrive, and the match is over without a message
 * saying so.
 *
 * This variant hands that caller the choice — send what it can, log the frame it
 * could not build, keep adjudicating. It is offered, not imposed: `apps/server`
 * belongs to someone else and still calls the throwing form.
 */
export function tryEncodeServerMessage(message: ServerMessage): ParseResult<string> {
  const result = ServerMessageSchema.safeParse(message);
  if (!result.success) {
    return { ok: false, code: 'bad_message', error: formatZodError(result.error) };
  }
  try {
    return { ok: true, value: JSON.stringify(toWire(result.data)) };
  } catch (error) {
    // `packSurface` throws a RangeError on a heightmap the schema let through
    // but the codec cannot represent, and JSON.stringify throws on a cycle.
    return { ok: false, code: 'bad_message', error: String(error) };
  }
}

function toWire(message: ServerMessage): unknown {
  if (message.t !== 'state' && message.t !== 'events') return message;
  const { terrain, ...rest } = message.snapshot;
  return {
    ...message,
    snapshot: {
      ...rest,
      terrain: {
        width: terrain.width,
        height: terrain.height,
        packed: packSurface(terrain.surface),
      },
    },
  };
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
