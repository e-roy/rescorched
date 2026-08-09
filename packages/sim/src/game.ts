/**
 * Turn state machine and round flow.
 *
 * Every function here is pure with respect to the outside world: it takes a
 * state, returns a new state plus the list of events that got it there. The
 * Durable Object stores the state and broadcasts the events; clients replay the
 * events to animate. Nothing here touches a clock, a socket or the DOM.
 *
 * What a weapon *does* on impact lives in `detonation.ts`. This file only knows
 * that something detonated and that it produced events.
 *
 * ## Nothing new gets stored
 *
 * Read this before adding a field to `GameState`. `serialize.ts` is the single
 * crossing point to JSON and it lists the persisted fields explicitly; a field
 * added here that is not added there survives in memory and vanishes the moment
 * a Durable Object hibernates, which is the worst possible failure mode — the
 * room resumes looking fine and playing by different rules.
 *
 * So everything this file added — turn order, the round's turn budget, sudden
 * death, the standings — is a PURE FUNCTION of state that is already persisted
 * (`seed`, `round`, `turnNumber`, `tanks`). `turnOrder()` is derived from the
 * seed and the round number rather than stored as an array; `roundStartTurn()`
 * is arithmetic on `round` rather than a remembered marker. That is why
 * `test/game-rounds.test.ts` can round-trip a mid-match state through JSON and
 * get a bit-identical next turn out of it.
 */

import { clamp } from './math.ts';
import {
  checkPlayability,
  cloneTerrain,
  generateTerrain,
  hashTerrain,
  PLAYABILITY_DEFAULTS,
  surfaceAt,
  TERRAIN_STYLES,
  type Terrain,
  type TerrainStyle,
} from './terrain.ts';
import { simulateFlight, trajectoryToArray, type HitCircle, type Trajectory } from './physics.ts';
import { applyDamage, detonate, type DetonationEvent } from './detonation.ts';
import { makeRng, normalizeSeed, restoreRng, type Rng, type RngState } from './rng.ts';
import { BABY_MISSILE, requireWeapon, type WeaponDef, type WeaponId } from './weapons.ts';

export const DEFAULT_WORLD = {
  width: 1280,
  height: 720,
  maxHealth: 100,
  startingMoney: 10000,
  /** Cash awarded for landing the killing blow. */
  killBounty: 5000,
  /** Cash per point of damage dealt. */
  damageBounty: 20,
  /** Cash every survivor gets at the end of a round. */
  survivalBonus: 2000,
  tankRadius: 9,
  maxWind: 10,
} as const;

/**
 * Largest lobby the turn machine will build a game for.
 *
 * `packages/protocol` caps the player array at 16 and `terrain.ts` sizes its
 * spawn band for the same number. Rejecting a 17th player here rather than
 * letting it through means the sim and the wire agree about what is
 * representable, instead of the sim producing a state the server then cannot
 * broadcast.
 */
export const MAX_PLAYERS = 16;

export type GamePhase = 'lobby' | 'aiming' | 'resolving' | 'shopping' | 'gameover';

export interface Tank {
  readonly id: string;
  name: string;
  x: number;
  y: number;
  health: number;
  money: number;
  score: number;
  alive: boolean;
  angleDeg: number;
  power: number;
  selectedWeapon: WeaponId;
  /** weaponId → rounds remaining. Baby Missile is absent and always available. */
  inventory: Record<WeaponId, number>;
  colorIndex: number;
}

export interface GameState {
  seed: number;
  round: number;
  totalRounds: number;
  phase: GamePhase;
  terrain: Terrain;
  tanks: Tank[];
  /** Index into `tanks` of the player whose turn it is. */
  activeTank: number;
  /** Monotonic turn number — clients echo it back so stale input is rejected. */
  turnNumber: number;
  wind: number;
  rngState: RngState;
  winnerId: string | null;
  /** Players still in the shop this intermission; empty means everyone is ready. */
  pendingShoppers: string[];
}

export interface PlayerSeed {
  id: string;
  name: string;
  colorIndex?: number;
}

export interface GameConfig {
  seed: number | string;
  width?: number;
  height?: number;
  totalRounds?: number;
  terrainStyle?: TerrainStyle;
  startingMoney?: number;
}

// ---------------------------------------------------------------------------
// Events — the wire format for "what happened". Clients replay these.
// ---------------------------------------------------------------------------

/**
 * Mirrored by `GameEventSchema` in `@scorched/protocol`, which is a CLOSED
 * discriminated union: an event kind that is not in that schema is dropped on
 * the floor by `encodeServerMessage` and the client never learns it happened.
 * So everything this file needs to tell a player about — a tank buried alive, a
 * round timed out into sudden death — is said with the eight kinds below rather
 * than with a ninth. Sudden death, in particular, arrives as ordinary `damage`
 * and `death` events, which is also exactly how it should be animated.
 */
export type GameEvent =
  | { type: 'shot'; tankIndex: number; weapon: WeaponId; path: number[]; impactKind: string }
  | { type: 'explosion'; x: number; y: number; radius: number; weapon: WeaponId }
  | { type: 'dirt'; x: number; y: number; radius: number }
  | { type: 'damage'; tankIndex: number; amount: number; healthAfter: number }
  | { type: 'death'; tankIndex: number; byTankIndex: number | null }
  | { type: 'turn'; activeTank: number; turnNumber: number; wind: number }
  | { type: 'roundEnd'; round: number; survivors: string[] }
  | { type: 'gameOver'; winnerId: string | null };

export interface FireInput {
  /** Must match `state.turnNumber`, else the shot is rejected as stale. */
  turnNumber: number;
  angleDeg: number;
  power: number;
  weapon: WeaponId;
}

export interface ResolveResult {
  state: GameState;
  events: GameEvent[];
}

export class IllegalMoveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'IllegalMoveError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function createGame(config: GameConfig, players: readonly PlayerSeed[]): GameState {
  if (players.length < 1)
    throw new IllegalMoveError('no_players', 'A game needs at least 1 player');
  if (players.length > MAX_PLAYERS)
    throw new IllegalMoveError('too_many_players', `A game holds at most ${MAX_PLAYERS} players`);

  // Every player is addressed by id — by `fire`, by the shop, by the standings.
  // Two players sharing one would make "whose turn is it" unanswerable.
  const seen = new Set<string>();
  for (const player of players) {
    if (seen.has(player.id))
      throw new IllegalMoveError('duplicate_player', `Duplicate player id: ${player.id}`);
    seen.add(player.id);
  }

  const totalRounds = config.totalRounds ?? 5;
  if (!Number.isInteger(totalRounds) || totalRounds < 1)
    throw new IllegalMoveError(
      'bad_rounds',
      'A match must be a whole number of rounds, at least 1',
    );

  const width = config.width ?? DEFAULT_WORLD.width;
  const height = config.height ?? DEFAULT_WORLD.height;
  const rng = makeRng(config.seed);

  const terrainRng = rng.fork('terrain');
  const style: TerrainStyle = config.terrainStyle ?? terrainRng.pick(TERRAIN_STYLES);
  const terrain = generateTerrain({ width, height, style }, terrainRng);

  const tanks = players.map((player, index) => ({
    id: player.id,
    name: player.name,
    x: 0,
    y: 0,
    health: DEFAULT_WORLD.maxHealth,
    money: config.startingMoney ?? DEFAULT_WORLD.startingMoney,
    score: 0,
    alive: true,
    angleDeg: 45,
    power: 60,
    selectedWeapon: BABY_MISSILE,
    inventory: {} as Record<WeaponId, number>,
    colorIndex: player.colorIndex ?? index,
  }));
  seatTanks(tanks, terrain, rng.fork('placement'));

  const windRng = rng.fork('wind');
  const wind = roundWind(windRng.range(-DEFAULT_WORLD.maxWind, DEFAULT_WORLD.maxWind));

  const state: GameState = {
    seed: normalizeSeed(config.seed),
    round: 1,
    totalRounds,
    phase: 'aiming',
    terrain,
    tanks,
    activeTank: 0,
    turnNumber: 1,
    wind,
    rngState: rng.save(),
    winnerId: null,
    pendingShoppers: [],
  };
  state.activeTank = firstShooter(state);
  return state;
}

/** Wind is displayed as one decimal place; keep the state exactly that precise. */
function roundWind(raw: number): number {
  return Math.round(raw * 10) / 10;
}

// ---------------------------------------------------------------------------
// Turn order
// ---------------------------------------------------------------------------

/**
 * The order the tanks shoot in this round, as indices into `state.tanks`.
 *
 * The original randomises who fires first every round, and it matters more than
 * it sounds: with a fixed order, player 1 in a two-player match gets the first
 * shot of every single round, which over five rounds is five free ranging shots
 * nobody else gets. Reshuffling per round hands that advantage around.
 *
 * Derived from `(seed, round)` and nothing else, so it is stable across a
 * hibernation — see the note at the top of this file about why nothing new is
 * stored. It deliberately does NOT read `rngState`: that advances with every
 * shot, so an order derived from it would change midway through a round.
 */
export function turnOrder(state: Pick<GameState, 'seed' | 'round' | 'tanks'>): number[] {
  const order = state.tanks.map((_, index) => index);
  const rng = makeRng(`order:${state.seed >>> 0}:${state.round}`);
  // Fisher-Yates, downwards, so every permutation is equally likely.
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i + 1);
    const swap = order[i] as number;
    order[i] = order[j] as number;
    order[j] = swap;
  }
  return order;
}

/** Who opens the round. */
function firstShooter(state: Pick<GameState, 'seed' | 'round' | 'tanks'>): number {
  const order = turnOrder(state);
  for (const index of order) {
    if ((state.tanks[index] as Tank).alive) return index;
  }
  return order[0] ?? 0;
}

/** The next living tank after the active one, following this round's order. */
function nextShooter(state: GameState): number {
  const order = turnOrder(state);
  const at = order.indexOf(state.activeTank);
  for (let step = 1; step <= order.length; step += 1) {
    const index = order[(at + step) % order.length] as number;
    if ((state.tanks[index] as Tank).alive) return index;
  }
  return state.activeTank;
}

// ---------------------------------------------------------------------------
// The round clock
// ---------------------------------------------------------------------------

/**
 * Shots each tank gets in a round before the round is forced to a conclusion.
 *
 * Two players who cannot finish each other off is not a hypothetical, and it
 * has two separate causes. The first is the map: `checkPlayability` is a
 * sample, not a proof, and although the placement search above drove it to zero
 * blocked pairs over a 1000-match sweep, zero-in-a-thousand is a measurement
 * rather than a guarantee. The second cause has nothing to do with the terrain
 * at all — two players who simply keep missing, or who would rather not shoot,
 * produce exactly the same room that never closes. A Durable Object holding a
 * match that cannot end holds it forever.
 *
 * 20 is chosen to be far outside normal play rather than as a balance dial: a
 * two-player round in the original is decided in a handful of ranging shots and
 * a hit, and 20 apiece leaves room for a long duel, a dirt war and a comeback
 * before the clock is even audible.
 */
export const TURNS_PER_TANK = 20;

/**
 * Turns of escalating damage once the budget runs out, and the damage step.
 *
 * `SUDDEN_DEATH_STEP * (1 + 2 + ... + k)` reaches `maxHealth` = 100 at k = 4
 * (12 + 24 + 36 + 48 = 120), so a stalemate is over four turns after the clock
 * runs out. The sixth turn is lethal outright, which is what turns "it ends
 * soon" into "it ends, full stop, whatever anybody's health is" — the bound the
 * round-stride arithmetic below depends on.
 */
export const SUDDEN_DEATH_TURNS = 6;
export const SUDDEN_DEATH_STEP = 12;

/** Turns of ordinary play a round gets before sudden death starts. */
export function roundTurnBudget(tankCount: number): number {
  return TURNS_PER_TANK * Math.max(1, tankCount);
}

/**
 * Turn numbers reserved per round.
 *
 * `turnNumber` is monotonic across the whole match — clients echo it back and
 * the server rejects anything stale, so it must never repeat or go backwards.
 * Giving each round a fixed stride is what lets `roundStartTurn` be arithmetic
 * instead of a stored marker: a round can occupy at most
 * `budget + SUDDEN_DEATH_TURNS` turns, so a stride one larger than that can
 * never be overrun and the next round always starts on a higher number.
 */
function roundStride(tankCount: number): number {
  return roundTurnBudget(tankCount) + SUDDEN_DEATH_TURNS + 1;
}

/** The turn number the current round opened on. */
export function roundStartTurn(state: Pick<GameState, 'round' | 'tanks'>): number {
  return (state.round - 1) * roundStride(state.tanks.length) + 1;
}

/**
 * Turns played in this round so far, counting the one being resolved.
 *
 * Floored at 1 because a hand-built state (tests, a doctored save) can put
 * `turnNumber` anywhere. A too-high `turnNumber` brings sudden death forward,
 * which is safe; a too-low one must not produce a negative clock.
 */
export function turnsTakenThisRound(
  state: Pick<GameState, 'round' | 'tanks' | 'turnNumber'>,
): number {
  return Math.max(1, state.turnNumber - roundStartTurn(state) + 1);
}

/** How far into sudden death this round is; negative means the clock has not run out. */
export function overtimeIndex(state: Pick<GameState, 'round' | 'tanks' | 'turnNumber'>): number {
  return turnsTakenThisRound(state) - roundTurnBudget(state.tanks.length);
}

// ---------------------------------------------------------------------------
// Tank placement
// ---------------------------------------------------------------------------

/**
 * The fraction of its slot a tank may be placed within.
 *
 * `terrain.ts` mirrors these two numbers in its private `placementBand()` to
 * decide which columns its playability check has to sample, and
 * `test/terrain-playability.test.ts` asserts the real `createGame` columns land
 * inside the band it derives. Widening them here without widening them there
 * silently un-covers the edges of the map.
 */
const SLOT_JITTER_LO = 0.2;
const SLOT_JITTER_HI = 0.8;

/**
 * Candidate columns considered per slot.
 *
 * The old placement drew one uniform jitter and took whatever ground was under
 * it. Sampling the slot instead is what makes it possible to reject a column
 * and keep the tank in its own slot, which is the whole point: a tank that gets
 * pushed out of its slot to find footing is no longer evenly spaced.
 *
 * What density actually buys, measured over the 1000-match sweep described on
 * `MAX_SPAWN_ELEVATION_SPREAD` below, is footing and only footing. The share of
 * the 4600 tanks that end up on ground steeper than `KNIFE_EDGE_DROP`:
 *
 *     samples per slot    5     7     9    11    13    17    25    33
 *     perched            507   473   442   419   410   390   382   376
 *
 * It buys nothing else. Every one of those eight densities finished the sweep
 * with ZERO pairs that cannot shoot at each other and ZERO per-column defects,
 * and the height excess over the brute-forced floor did not respond to density
 * at all (median 5-6 px throughout, p95 wandering between 79 and 86 px with no
 * trend). Reachability is the repair loop's job and levelness is
 * `levelWindow`'s; a previous version of this comment credited density with
 * both, and the sweep it cited does not say that.
 *
 * 13 is where the curve flattens: 5 -> 13 removes 97 perched tanks, 13 -> 33
 * removes 34 more. The tail is not worth paying for on every round start of
 * every match.
 */
const SLOT_SAMPLES = 13;

/**
 * Repairs attempted before settling for the least bad placement drawn.
 *
 * Attempts exist only to satisfy the pairwise reachability check; the height
 * rule is satisfied by construction (see `levelWindow`), so this is not a
 * search for a good placement, it is a search for a legal one. Each attempt
 * costs one `checkPlayability` over the real tank columns.
 */
const PLACEMENT_ATTEMPTS = 12;

/**
 * How far from level a placement is allowed to be, in pixels of ground height.
 *
 * This is the "comparable exposure" rule. Height is the single biggest
 * positional advantage in this game — a tank on a peak sees over the terrain
 * that shelters everyone else, and its shells arrive with the drop thrown in —
 * so a placement that puts one player 300 px above another has decided the
 * round before anybody fires.
 *
 * It is SLACK, not a cap, and the difference is the whole design. `levelWindow`
 * first works out the flattest set of spawns the slots can actually produce,
 * then widens that window to at least this much so the placement still varies
 * between matches on the same map. The rule cannot invent level ground that is
 * not there — on six and eight-player maps the slots are narrow and the terrain
 * decides almost everything — so what it promises is only ever "no worse than
 * the flattest possible, plus this much".
 *
 * Measured over 1000 real `createGame` matches (5 styles x {2,3,4,6,8} players
 * x 40 seeds, 1280x720, seeds `real-<style>-<count>-<seed>`), against a
 * brute-forced floor: the smallest spread ANY choice of one column per slot
 * could have reached on that same map, computed over every column rather than
 * the sampled ones.
 *
 *     spawn height spread          median   p95   worst
 *     same search, rule disabled     250    419    432
 *     this rule                      121    319    432
 *     brute-forced floor             103    318    432
 *     this rule minus the floor        6     84    139
 *
 * The last row is the one that matters, because it is the only one that is
 * about the rule rather than about the terrain: the placement is 6 px off the
 * best possible at the median and never more than 139 px off, which is the
 * slack this constant hands out, spent on variety. The 432 px worst case is
 * shared with the floor — an eight-player mountain round where no placement is
 * level — and the median by player count shows why:
 *
 *     players            2     3     4     6     8
 *     this rule         38    88   116   191   243
 *     floor              0    35    86   190   240
 *
 * With eight slots across the map there is nothing left to choose, and the rule
 * honestly claims nothing there. Two players is where it earns its keep: 38 px
 * against 107 px for the same search with the rule disabled.
 *
 * The search is close to free next to the map it runs on. Over those same 1000
 * matches `createGame` averages 9.5 ms and generating the terrain alone — which
 * happens either way — accounts for 9.2 ms of it, leaving placement about a
 * third of a millisecond.
 *
 * Only that difference is worth quoting. The absolute means wander between 8.6
 * and 9.6 ms across the six sweeps run here, and the peaks are pure noise —
 * `createGame`'s peak came in BELOW `generateTerrain`'s on two of the six, which
 * is impossible and is exactly what a single-sample maximum on a machine with
 * other things to do looks like. The difference of the means held between 0.24
 * and 0.35 ms on every one of the six.
 *
 * `test/game-placement.test.ts` reruns a slice of this sweep and fails if the
 * excess over the floor grows.
 */
export const MAX_SPAWN_ELEVATION_SPREAD = 140;

interface Slot {
  lo: number;
  hi: number;
}

/** The column range each tank is allowed to be placed in. */
function slotRanges(width: number, count: number): Slot[] {
  const margin = Math.min(90, Math.floor(width / (count + 2)));
  const slot = (width - margin * 2) / count;
  const ranges: Slot[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = margin + slot * index;
    ranges.push({
      lo: Math.round(clamp(start + slot * SLOT_JITTER_LO, 4, width - 5)),
      hi: Math.round(clamp(start + slot * SLOT_JITTER_HI, 4, width - 5)),
    });
  }
  return ranges;
}

/**
 * Columns in this slot a tank could be placed on.
 *
 * Evenly spaced across the slot and nothing more. This used to pre-filter the
 * samples through `checkPlayability` one column at a time, on the reasoning
 * that headroom, footing and "can this tank shoot out of its own hole" are the
 * terrain module's rules and should not be reimplemented here. The reasoning is
 * right; the filter was dead code anyway.
 *
 * `generateTerrain` will not return a map until `checkPlayability` passes on
 * it, over `SPAWN_SAMPLES` columns spread across the whole `spawnBand` that
 * these slots live inside. That is a grid rather than every column, so it does
 * not strictly prove the columns between the grid points are fine — but
 * `MAX_TERRAIN_SLOPE` keeps a generated map smooth enough that in practice it
 * does. Instrumented over the 1000-match sweep described on
 * `MAX_SPAWN_ELEVATION_SPREAD` below, the filter rejected NONE of the columns
 * it was shown — 115,000 of them at 25 samples per slot, and zero rejections at
 * every density from 5 to 33 — and deleting it left all 1000 placements
 * bit-identical (same digest, same 410 perched tanks, same excess quantiles).
 * It cost `SLOT_SAMPLES * tankCount` `checkPlayability` calls per round start
 * to enforce nothing.
 *
 * Nothing is riding on that measurement holding forever, which is the other
 * reason it is safe to drop. The terrain module's check still runs on the real
 * tank columns in `chooseSpawnColumns` below — the same per-column rules, plus
 * the pairwise line-of-fire sweep a single-column report cannot do — and the
 * repair loop moves any tank it complains about. A column the generator's grid
 * happened to miss gets caught there instead of here.
 * `test/game-placement.test.ts` reruns that check from outside and demands zero
 * issues — and it is the repair loop that earns that, not this function:
 * short-circuiting `chooseSpawnColumns` to accept its first draw puts a blocked
 * pair back into the sweep.
 */
function slotCandidates(slot: Slot): number[] {
  const columns: number[] = [];
  const span = slot.hi - slot.lo;
  for (let i = 0; i < SLOT_SAMPLES; i += 1) {
    const x = SLOT_SAMPLES < 2 ? slot.lo : Math.round(slot.lo + (span * i) / (SLOT_SAMPLES - 1));
    if (columns[columns.length - 1] !== x) columns.push(x);
  }
  return columns;
}

/** Height difference between the highest and lowest of these spawns. */
export function elevationSpread(terrain: Terrain, columns: readonly number[]): number {
  let lowest = -Infinity;
  let highest = Infinity;
  for (const x of columns) {
    const y = surfaceAt(terrain, x);
    if (y > lowest) lowest = y;
    if (y < highest) highest = y;
  }
  return lowest - highest;
}

/**
 * The band of ground heights a fair placement may draw from.
 *
 * The narrowest band that still contains at least one candidate from every
 * slot is the flattest placement those slots can produce — a smallest-range-
 * covering-k-lists sweep, which is exact and costs one sort. That band is then
 * widened to `MAX_SPAWN_ELEVATION_SPREAD` if it is narrower, because a band
 * pinched down to one candidate per slot would make every match on a given map
 * identical.
 *
 * Picking within a band, rather than scoring whole placements and keeping the
 * best, is what makes the height guarantee a property of the code instead of a
 * property of how many attempts got run.
 */
function levelWindow(terrain: Terrain, candidates: readonly (readonly number[])[]): Slot {
  const points: { y: number; slot: number }[] = [];
  candidates.forEach((list, slot) => {
    for (const x of list) points.push({ y: surfaceAt(terrain, x), slot });
  });
  // Tie-break on the slot so the sweep is a pure function of the heightmap and
  // not of the engine's sort stability.
  points.sort((a, b) => a.y - b.y || a.slot - b.slot);

  const need = candidates.length;
  const held = new Array<number>(need).fill(0);
  let covered = 0;
  let left = 0;
  let bestLo = (points[0] as { y: number }).y;
  let bestHi = (points[points.length - 1] as { y: number }).y;

  for (let right = 0; right < points.length; right += 1) {
    const entering = points[right] as { y: number; slot: number };
    if ((held[entering.slot] as number) === 0) covered += 1;
    held[entering.slot] = (held[entering.slot] as number) + 1;

    while (covered === need) {
      const lo = (points[left] as { y: number }).y;
      if (entering.y - lo < bestHi - bestLo) {
        bestLo = lo;
        bestHi = entering.y;
      }
      const leaving = points[left] as { y: number; slot: number };
      held[leaving.slot] = (held[leaving.slot] as number) - 1;
      if ((held[leaving.slot] as number) === 0) covered -= 1;
      left += 1;
    }
  }

  const slack = Math.max(0, (MAX_SPAWN_ELEVATION_SPREAD - (bestHi - bestLo)) / 2);
  return { lo: bestLo - slack, hi: bestHi + slack };
}

/**
 * Pick a column per tank: evenly spaced, on ground worth standing on, mutually
 * reachable, and at comparable heights.
 *
 * Exactly one number is drawn from the caller's `rng` however long the search
 * runs — the same contract `generateTerrain` keeps. Every draw the search makes
 * comes from a stream seeded by that one number, so how hard the search had to
 * work on a given map cannot change what the caller's stream produces next.
 */
function chooseSpawnColumns(terrain: Terrain, count: number, rng: Rng): number[] {
  const search = makeRng(rng.nextU32());
  const slots = slotRanges(terrain.width, count);
  const candidates = slots.map((slot) => slotCandidates(slot));

  const window = levelWindow(terrain, candidates);
  const level = candidates.map((list) => {
    const inside = list.filter((x) => {
      const y = surfaceAt(terrain, x);
      return y >= window.lo && y <= window.hi;
    });
    // The window covers every slot by construction, so `inside` is non-empty;
    // the fallback is here for the degenerate widths the tests use.
    const base = inside.length > 0 ? inside : list;
    const seated = base.filter((x) => footingDrop(terrain, x) <= KNIFE_EDGE_DROP);
    return seated.length > 0 ? seated : base;
  });

  const draw = (slot: number, widened: boolean): number => {
    const pool = (widened ? candidates[slot] : level[slot]) as number[];
    return pool[search.int(0, pool.length)] as number;
  };

  let columns = level.map((_, slot) => draw(slot, false));
  const drawn: number[][] = [];

  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt += 1) {
    const report = checkPlayability(terrain, { spawns: columns, stopEarly: true });
    if (report.ok) return columns;
    drawn.push(columns);

    // Move the tanks the check complained about and leave everyone else where
    // they are. Redrawing all of them instead — which is what this did first —
    // turns a repair into a fresh guess: rerolling the innocent slots throws
    // away the only information the failed check produced.
    const guilty = new Set<number>();
    for (const issue of report.issues) {
      const from = columns.indexOf(issue.column);
      if (from >= 0) guilty.add(from);
      if (issue.target !== undefined) {
        const to = columns.indexOf(issue.target);
        if (to >= 0) guilty.add(to);
      }
    }
    // A complaint about a column nobody is standing on cannot happen, but a
    // stalled search that redraws nothing would loop pointlessly.
    if (guilty.size === 0) guilty.add(search.int(0, columns.length));

    // Half way through, stop insisting on level ground. The two rules can
    // genuinely conflict — the height window can pinch a slot down to a single
    // candidate, and if that candidate is the one nobody can shoot at, no
    // amount of redrawing inside the window will ever fix it — and when they
    // conflict, being able to reach each other wins. A round where one player
    // is high up is unfair; a round where two players cannot exchange fire is
    // not a round.
    const widened = attempt >= PLACEMENT_ATTEMPTS / 2;
    const repaired = [...columns];
    for (const slot of guilty) repaired[slot] = draw(slot, widened);
    columns = repaired;
  }

  drawn.push(columns);
  return leastBad(terrain, drawn);
}

/**
 * Every draw had something wrong with it. Play the least wrong one.
 *
 * Refusing to place is not an option — the round has to start — and taking
 * whichever draw came out of the rng first is how a two-player stalemate gets
 * shipped. So the draws are re-judged with the full report rather than the
 * stop-at-the-first-problem one, and ranked:
 *
 *   1. fewest per-column defects (a tank in a shaft or on a cliff ruins a round
 *      by itself, and unlike a blocked pair there is no aiming around it),
 *   2. fewest pairs that cannot reach each other,
 *   3. and among those, the one whose closest unreachable pair is furthest
 *      apart — because a pair 900 px apart is two players at the limit of the
 *      gun, while a pair 300 px apart staring at each other over a wall they
 *      cannot clear is the deadlock this whole search exists to avoid.
 *
 * Over the 1000-match sweep behind `MAX_SPAWN_ELEVATION_SPREAD` this never ran,
 * and the sweep proves it rather than assuming it: every draw reaching here has
 * already failed `checkPlayability`, so whatever `leastBad` returns carries at
 * least one issue — and rechecking the final placement of all 1000 matches from
 * outside found zero issues of any kind. Twelve targeted repairs were always
 * enough. It is here because "not once in a thousand" is not "never", and the
 * alternative on the map that finally does it is a round that will not start.
 */
function leastBad(terrain: Terrain, drawn: readonly number[][]): number[] {
  let best = drawn[0] as number[];
  let bestDefects = Infinity;
  let bestBlocked = Infinity;
  let bestSeparation = -Infinity;

  for (const columns of drawn) {
    const { issues } = checkPlayability(terrain, { spawns: columns });
    let defects = 0;
    let blocked = 0;
    let separation = Infinity;
    for (const issue of issues) {
      if (issue.kind === 'blocked' && issue.target !== undefined) {
        blocked += 1;
        separation = Math.min(separation, Math.abs(issue.target - issue.column));
      } else {
        defects += 1;
      }
    }

    const better =
      defects < bestDefects ||
      (defects === bestDefects &&
        (blocked < bestBlocked || (blocked === bestBlocked && separation > bestSeparation)));
    if (better) {
      best = columns;
      bestDefects = defects;
      bestBlocked = blocked;
      bestSeparation = separation;
    }
  }

  return best;
}

/**
 * Ground under a tank that changes by more than this across the tank's own
 * footprint is a ridge crest, not a parking space.
 *
 * `checkPlayability` already refuses a genuine cliff face — its `footing`
 * verdict, at `maxFootingDrop` = 44 px — but that threshold is set to catch
 * ground nobody could fight from, and the generator's 3 px/column slope cap
 * means it can never fire on a fresh map: the steepest footprint a generated
 * map can produce is 30 px. So it is the right rule and the wrong number for
 * "do not perch a tank on a knife edge".
 *
 * Two tank radii is the number with a meaning: the ground under the tank
 * changes by more than the tank is tall, so the hull is balanced on an edge
 * rather than sitting on a surface. It is a preference, not a veto — a slot
 * with nothing flatter still gets its tank.
 *
 * Over the same 1000-match sweep quoted on `MAX_SPAWN_ELEVATION_SPREAD`, of
 * 4600 placed tanks the number standing on ground steeper than this:
 *
 *     preference off, height window on      982  (21.3%)
 *     preference on,  height window on      410  ( 8.9%)
 *     preference on,  height window off      14  ( 0.3%)
 *
 * The third row is the honest limit on what this rule can do. The height window
 * usually pinches a slot down to a handful of candidates, and when none of them
 * is flat the preference has nothing to prefer — so most of the 410 are slots
 * where levelness and footing genuinely conflicted and levelness won. Removing
 * the height rule would fix footing almost completely and cost 129 px of median
 * spread, which is not a trade worth making: a tank on a slope is awkward, a
 * tank 250 px above everybody else has already won.
 */
export const KNIFE_EDGE_DROP = DEFAULT_WORLD.tankRadius * 2;

/** Height range of the ground across a tank's footprint. */
function footingDrop(terrain: Terrain, x: number): number {
  const reach = PLAYABILITY_DEFAULTS.footprint;
  let lowest = -Infinity;
  let highest = Infinity;
  for (let offset = -reach; offset <= reach; offset += 1) {
    const y = surfaceAt(terrain, x + offset);
    if (y > lowest) lowest = y;
    if (y < highest) highest = y;
  }
  return lowest - highest;
}

/** Seat every tank on fresh terrain. Used at match start and at every round start. */
function seatTanks(tanks: Tank[], terrain: Terrain, rng: Rng): void {
  const columns = chooseSpawnColumns(terrain, tanks.length, rng);
  const centre = terrain.width / 2;
  tanks.forEach((tank, index) => {
    tank.x = columns[index] as number;
    tank.y = surfaceAt(terrain, tank.x);
    // Point the gun at the rest of the field rather than off the edge of it.
    tank.angleDeg = tank.x < centre ? 45 : 135;
  });
}

// ---------------------------------------------------------------------------
// Settling: falling, burial, and who gets the credit
// ---------------------------------------------------------------------------

/**
 * What a drop costs.
 *
 * Exported because a curve can only be tested against its own parameters: a
 * test that restated 24 and 0.25 as literals would pass whatever the code did,
 * and one that only checked "further hurts more" would pass a curve that does
 * one point of damage off a cliff.
 *
 * `safeDrop` is a little over two tank heights. Below it the ground under a
 * tank has shifted rather than collapsed, and being scratched for it every time
 * a shell lands nearby would make the whole map feel like lava.
 */
export const FALL = {
  safeDrop: 24,
  damagePerPixel: 0.25,
  /** A fall alone should not be able to take a tank from full health to zero. */
  maxDamage: 60,
} as const;

/**
 * What being buried costs.
 *
 * `freeDepth` is one tank radius — roughly the hull. Soil banked up to the top
 * of the tracks is exactly what a Dirt Clod is bought for, and charging for it
 * would turn the defensive weapons into offensive ones.
 *
 * `maxDamage` is deliberately not lethal on its own. A Ton of Dirt dropped
 * straight onto somebody should hurt and should be worth doing, but "dirt
 * weapon kills outright" is a different game from the one the arsenal is priced
 * for — dirt is tier 1 and costs a fraction of a Missile. Two burials, or a
 * burial on a tank that has already been hit, still finish the job.
 */
export const BURIAL = {
  freeDepth: DEFAULT_WORLD.tankRadius,
  damagePerPixel: 0.5,
  maxDamage: 40,
} as const;

export function fallDamage(drop: number): number {
  if (drop <= FALL.safeDrop) return 0;
  return Math.min(FALL.maxDamage, Math.floor((drop - FALL.safeDrop) * FALL.damagePerPixel));
}

export function burialDamage(depth: number): number {
  if (depth <= BURIAL.freeDepth) return 0;
  return Math.min(BURIAL.maxDamage, Math.floor((depth - BURIAL.freeDepth) * BURIAL.damagePerPixel));
}

/**
 * Put every living tank back on the ground after the terrain moved, and charge
 * it for the trip.
 *
 * Two directions, and they are different injuries. The ground fell away and the
 * tank dropped onto what is left — that is a fall, and a long one is fatal. Or
 * dirt landed on top of it, in which case it digs out and ends up standing on
 * the new surface, paying for the dig. A tank left sitting under the heightmap
 * would break the invariant the property suite holds the whole sim to (a living
 * tank is always exactly at `surface[x]`), and it would also be unrenderable —
 * the client draws a tank at its coordinates and nothing else.
 *
 * `byTankIndex` is the tank whose shot moved the ground, and passing it is the
 * point: blowing the hill out from under somebody is a kill you earned, and
 * before this it paid nothing at all. `applyDamage` ignores the credit when the
 * victim is the shooter, so dropping yourself is free of charge in both senses.
 */
export function settleTanks(state: GameState, byTankIndex: number | null = null): GameEvent[] {
  const events: GameEvent[] = [];
  for (let index = 0; index < state.tanks.length; index += 1) {
    const tank = state.tanks[index] as Tank;
    if (!tank.alive) continue;
    const ground = surfaceAt(state.terrain, tank.x);
    if (ground === tank.y) continue;

    // Y grows downwards: a larger ground value is further down, so a positive
    // difference is a fall and a negative one is dirt stacked overhead.
    const drop = ground - tank.y;
    tank.y = ground;

    const damage = drop > 0 ? fallDamage(drop) : burialDamage(-drop);
    if (damage > 0) hurt(state, index, damage, byTankIndex, events);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Turn resolution
// ---------------------------------------------------------------------------

export function ammoFor(tank: Tank, weaponId: WeaponId): number {
  if (weaponId === BABY_MISSILE) return Number.POSITIVE_INFINITY;
  return tank.inventory[weaponId] ?? 0;
}

/**
 * Validate and resolve a shot. Returns a NEW state — the caller's state object
 * is never mutated, so a rejected move leaves the room untouched.
 *
 * Every rejection happens before the first write, which is what makes that
 * true: the clone is taken only once the move is known to be legal.
 */
export function fire(state: GameState, playerId: string, input: FireInput): ResolveResult {
  if (state.phase !== 'aiming') {
    throw new IllegalMoveError('wrong_phase', `Cannot fire during phase "${state.phase}"`);
  }

  const active = state.tanks[state.activeTank];
  if (active === undefined) throw new IllegalMoveError('no_active_tank', 'No active tank');
  if (active.id !== playerId) {
    throw new IllegalMoveError('not_your_turn', 'It is not your turn');
  }
  if (!active.alive) {
    throw new IllegalMoveError('tank_destroyed', 'Your tank has been destroyed');
  }
  if (input.turnNumber !== state.turnNumber) {
    throw new IllegalMoveError('stale_turn', 'That turn has already been played');
  }
  if (!Number.isFinite(input.angleDeg) || input.angleDeg < 0 || input.angleDeg > 180) {
    throw new IllegalMoveError('bad_angle', 'Angle must be between 0 and 180 degrees');
  }
  if (!Number.isFinite(input.power) || input.power < 0 || input.power > 100) {
    throw new IllegalMoveError('bad_power', 'Power must be between 0 and 100');
  }

  const weapon = requireWeaponOrThrow(input.weapon);
  if (ammoFor(active, weapon.id) <= 0) {
    throw new IllegalMoveError('no_ammo', `Out of ${weapon.name}`);
  }

  const next = cloneState(state);
  const shooter = next.tanks[next.activeTank] as Tank;
  const shooterIndex = next.activeTank;
  shooter.angleDeg = input.angleDeg;
  shooter.power = input.power;
  shooter.selectedWeapon = weapon.id;

  if (weapon.id !== BABY_MISSILE) {
    shooter.inventory[weapon.id] = (shooter.inventory[weapon.id] ?? 0) - 1;
    if ((shooter.inventory[weapon.id] ?? 0) <= 0) {
      delete shooter.inventory[weapon.id];
      shooter.selectedWeapon = BABY_MISSILE;
    }
  }

  const events: GameEvent[] = [];
  const rng = restoreRng(next.rngState);

  const muzzle = muzzlePoint(shooter);
  const trajectory = flyShot(next, muzzle, input.angleDeg, input.power, shooterIndex);
  events.push({
    type: 'shot',
    tankIndex: shooterIndex,
    weapon: weapon.id,
    path: trajectoryToArray(trajectory),
    impactKind: trajectory.impact.kind,
  });

  if (trajectory.impact.kind !== 'wall' && trajectory.impact.kind !== 'expired') {
    events.push(
      ...(detonate(
        next,
        weapon,
        trajectory.impact.x,
        trajectory.impact.y,
        shooterIndex,
        rng,
        DETONATION_RULES,
      ) as GameEvent[]),
    );
  }

  events.push(...settleTanks(next, shooterIndex));

  advanceTurn(next, events, rng);
  next.rngState = rng.save();

  return { state: next, events };
}

function requireWeaponOrThrow(id: WeaponId): WeaponDef {
  try {
    return requireWeapon(id);
  } catch {
    throw new IllegalMoveError('unknown_weapon', `Unknown weapon: ${id}`);
  }
}

/** Where the shell leaves the barrel — just outside the tank's own hit circle. */
export function muzzlePoint(tank: Tank): { x: number; y: number } {
  return { x: tank.x, y: tank.y - DEFAULT_WORLD.tankRadius - 2 };
}

function flyShot(
  state: GameState,
  from: { x: number; y: number },
  angleDeg: number,
  power: number,
  shooterIndex: number,
): Trajectory {
  const targets: HitCircle[] = state.tanks.map((tank, index) => ({
    x: tank.x,
    y: tank.y - DEFAULT_WORLD.tankRadius / 2,
    radius: tank.alive ? DEFAULT_WORLD.tankRadius : 0,
    ignore: index === shooterIndex,
  }));

  return simulateFlight(
    { x: from.x, y: from.y, angleDeg, power },
    { terrain: state.terrain, wind: state.wind, targets },
  );
}

/**
 * Blast rules shared by every detonation: what a point of damage is worth in
 * cash, and what a kill pays. These live here rather than in detonation.ts
 * because they are economy decisions, not physics.
 */
const DETONATION_RULES = {
  damageBounty: DEFAULT_WORLD.damageBounty,
  killBounty: DEFAULT_WORLD.killBounty,
} as const;

/**
 * Hurt a tank for something that is not a weapon: a fall, a burial, the sudden
 * death clock. Routes through the same `applyDamage()` as weapon blasts so the
 * "health never goes negative", "overkill pays nothing" and "one death event
 * per tank, ever" invariants have exactly one implementation, and so a kill by
 * any of these credits the killer the same way a direct hit does.
 */
function hurt(
  state: GameState,
  tankIndex: number,
  amount: number,
  byTankIndex: number | null,
  events: GameEvent[],
): void {
  const detonationEvents: DetonationEvent[] = [];
  applyDamage(state, tankIndex, amount, byTankIndex, DETONATION_RULES, detonationEvents);
  events.push(...(detonationEvents as GameEvent[]));
}

function livingCount(state: GameState): number {
  let count = 0;
  for (const tank of state.tanks) if (tank.alive) count += 1;
  return count;
}

/** Hand the turn to the next living tank, or end the round. */
function advanceTurn(state: GameState, events: GameEvent[], rng: Rng): void {
  // The shot just resolved may already have finished the round; if it did, the
  // clock has no more work to do and nobody should be charged for overtime.
  if (livingCount(state) > 1) applySuddenDeath(state, events);

  if (livingCount(state) <= 1) {
    endRound(state, events);
    return;
  }

  state.activeTank = nextShooter(state);
  state.turnNumber += 1;
  state.wind = nextWind(state.wind, rng);
  events.push({
    type: 'turn',
    activeTank: state.activeTank,
    turnNumber: state.turnNumber,
    wind: state.wind,
  });
}

/**
 * Charge everyone still standing for running the clock out.
 *
 * This is the answer to "two players who cannot reach each other must not play
 * forever". It is a damage drain rather than a new event kind or a phase change
 * because the wire vocabulary is closed (see `GameEvent`) — and because a
 * client already knows how to animate a tank taking damage, so the round
 * visibly starts killing people with no new rendering code at all.
 */
function applySuddenDeath(state: GameState, events: GameEvent[]): void {
  const overtime = overtimeIndex(state);
  if (overtime < 0) return;

  // The last permitted overtime turn kills whatever is left outright. Without
  // it the bound on a round's length would depend on tank health rather than on
  // arithmetic, and `roundStride` would be a guess.
  const lethal = overtime >= SUDDEN_DEATH_TURNS - 1;
  const amount = lethal ? DEFAULT_WORLD.maxHealth : SUDDEN_DEATH_STEP * (overtime + 1);

  for (let index = 0; index < state.tanks.length; index += 1) {
    if (!(state.tanks[index] as Tank).alive) continue;
    // No `byTankIndex`: the clock killed them, and crediting the last shooter
    // for a stalemate would pay a bounty for failing to connect.
    hurt(state, index, amount, null, events);
  }
}

// ---------------------------------------------------------------------------
// Wind
// ---------------------------------------------------------------------------

export const WIND = {
  /** Largest step the wind can take between turns. */
  drift: 2.5,
  /** Fraction of the current wind carried into the next turn. */
  retention: 0.9,
} as const;

/**
 * The wind for the next turn.
 *
 * Three properties, and the original has all three. It CHANGES every turn, so a
 * ranging shot is information rather than a solution. It changes by a bounded
 * amount — at most `drift + maxWind * (1 - retention)` = 3.5 of the dial's 20 —
 * so a player who ranged last turn is not simply robbed. And it is pulled back
 * towards calm, which is what the retention factor buys: a plain random walk
 * against a hard clamp spends a great deal of its time pinned at one end of the
 * dial, which reads as the game holding a grudge.
 *
 * The bound reflects off the ends rather than clamping to them, for the same
 * reason: a clamp makes the extremes sticky, since every step that would
 * overshoot lands exactly on the wall.
 */
function nextWind(current: number, rng: Rng): number {
  const drifted = current * WIND.retention + rng.range(-WIND.drift, WIND.drift);
  return roundWind(reflect(drifted, -DEFAULT_WORLD.maxWind, DEFAULT_WORLD.maxWind));
}

function reflect(value: number, min: number, max: number): number {
  let folded = value;
  // One fold is enough for any step this file can produce; the loop is a belt
  // for a caller that hands in something wilder, and the clamp is the braces.
  for (let guard = 0; guard < 4 && (folded < min || folded > max); guard += 1) {
    if (folded > max) folded = max + max - folded;
    else folded = min + min - folded;
  }
  return clamp(folded, min, max);
}

// ---------------------------------------------------------------------------
// Round and match end
// ---------------------------------------------------------------------------

/**
 * What surviving a round is worth on the scoreboard.
 *
 * The scoreboard is `tank.score`, which `detonation.ts` grows by one point per
 * point of damage dealt and which nothing ever resets — that is the "carries
 * across rounds" part. A round win has to be worth something on top, or a
 * player who loses every round while chipping away at people wins the match on
 * accumulated near-misses. One tank's worth of health is the natural size:
 * winning the round counts for as much as destroying one more opponent.
 */
export const ROUND_WIN_SCORE = DEFAULT_WORLD.maxHealth;

function endRound(state: GameState, events: GameEvent[]): void {
  // The round only ends when at most one tank is standing, so "survivors" is
  // the round winner or nobody. Paid here and nowhere else, and `endRound` runs
  // once per round because the phase it leaves behind is one `fire()` refuses.
  const survivors = state.tanks.filter((tank) => tank.alive);
  for (const tank of survivors) {
    tank.money += DEFAULT_WORLD.survivalBonus;
    tank.score += ROUND_WIN_SCORE;
  }
  events.push({
    type: 'roundEnd',
    round: state.round,
    survivors: survivors.map((tank) => tank.id),
  });

  if (state.round >= state.totalRounds) {
    state.phase = 'gameover';
    state.winnerId = matchWinnerId(state);
    events.push({ type: 'gameOver', winnerId: state.winnerId });
    return;
  }

  state.phase = 'shopping';
  state.pendingShoppers = state.tanks.map((tank) => tank.id);
}

/**
 * The match scoreboard, best first.
 *
 * The tiebreak chain matters more than it looks. A drawn match has to resolve
 * to ONE winner that every client agrees on, and the obvious "highest score"
 * leaves ties to `Array.prototype.sort`, whose behaviour for equal keys depends
 * on the order the tanks happen to sit in — which is the lobby join order. So
 * the chain ends on the player id, which is unique by construction (see
 * `createGame`) and identical on every machine. Money comes first among the
 * tiebreaks because it is earned the same way score is and a richer player did
 * more with the round; it is a real tiebreak, not a coin toss.
 */
export function matchStandings(state: Pick<GameState, 'tanks'>): Tank[] {
  return [...state.tanks].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.money !== a.money) return b.money - a.money;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function matchWinnerId(state: Pick<GameState, 'tanks'>): string | null {
  return matchStandings(state)[0]?.id ?? null;
}

/**
 * Start the next round: fresh terrain, everyone back to full health, inventory
 * and the scoreboard carried over. Called once every player has left the shop.
 */
export function startNextRound(state: GameState): ResolveResult {
  if (state.phase !== 'shopping') {
    throw new IllegalMoveError('wrong_phase', 'Not between rounds');
  }

  const next = cloneState(state);
  const rng = restoreRng(next.rngState);

  next.round += 1;
  next.phase = 'aiming';
  next.pendingShoppers = [];

  const terrainRng = rng.fork(`terrain:${next.round}`);
  const style = terrainRng.pick(TERRAIN_STYLES);
  next.terrain = generateTerrain(
    { width: state.terrain.width, height: state.terrain.height, style },
    terrainRng,
  );

  seatTanks(next.tanks, next.terrain, rng.fork(`placement:${next.round}`));
  for (const tank of next.tanks) {
    tank.health = DEFAULT_WORLD.maxHealth;
    tank.alive = true;
  }

  // Normally exactly `roundStartTurn`; the `max` only bites for a hand-built
  // state, and it is there because a turn number that went backwards would make
  // a stale shot from the previous round look current.
  next.turnNumber = Math.max(state.turnNumber + 1, roundStartTurn(next));
  next.activeTank = firstShooter(next);
  next.wind = roundWind(rng.range(-DEFAULT_WORLD.maxWind, DEFAULT_WORLD.maxWind));
  next.rngState = rng.save();

  return {
    state: next,
    events: [
      {
        type: 'turn',
        activeTank: next.activeTank,
        turnNumber: next.turnNumber,
        wind: next.wind,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Cloning / hashing / serialisation
// ---------------------------------------------------------------------------

export function cloneState(state: GameState): GameState {
  return {
    ...state,
    terrain: cloneTerrain(state.terrain),
    tanks: state.tanks.map((tank) => ({ ...tank, inventory: { ...tank.inventory } })),
    rngState: { ...state.rngState },
    pendingShoppers: [...state.pendingShoppers],
  };
}

/**
 * Stable hash of everything that matters for determinism. Golden-file tests
 * compare this after replaying a recorded input sequence, and the illegal-move
 * tests compare it either side of a rejected shot.
 *
 * That second use is why the phase is mixed in character by character. It used
 * to contribute only `phase.length`, and "shopping" and "gameover" are both
 * eight characters long — so the one transition where a rejected move could
 * plausibly have been let through was the one transition the hash could not
 * see. Same reasoning for `winnerId` and `pendingShoppers`: they are the state
 * a between-rounds bug would corrupt, and a hash that ignores them cannot be
 * used to prove nothing changed.
 *
 * `name` is left out on purpose. It is a label, not simulation state; renaming
 * a player must not read as a determinism failure.
 */
export function hashGameState(state: GameState): string {
  let hash = hashTerrain(state.terrain);
  const mix = (value: number): void => {
    hash ^= value | 0;
    hash = Math.imul(hash, 0x01000193);
  };
  const mixText = (text: string): void => {
    for (let i = 0; i < text.length; i += 1) mix(text.charCodeAt(i));
    mix(text.length);
  };

  mix(state.seed);
  mix(state.round);
  mix(state.totalRounds);
  mix(state.turnNumber);
  mix(state.activeTank);
  mix(Math.round(state.wind * 10));
  mixText(state.phase);
  mixText(state.winnerId ?? '');
  for (const id of state.pendingShoppers) mixText(id);
  mix(state.rngState.a);
  mix(state.rngState.b);
  mix(state.rngState.c);
  mix(state.rngState.d);

  for (const tank of state.tanks) {
    mixText(tank.id);
    mix(tank.x);
    mix(tank.y);
    mix(tank.health);
    mix(tank.money);
    mix(tank.score);
    mix(tank.alive ? 1 : 0);
    mix(Math.round(tank.angleDeg * 100));
    mix(Math.round(tank.power * 100));
    mixText(tank.selectedWeapon);
    mix(tank.colorIndex);
    for (const [weaponId, count] of Object.entries(tank.inventory).sort()) {
      mixText(weaponId);
      mix(count);
    }
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}
