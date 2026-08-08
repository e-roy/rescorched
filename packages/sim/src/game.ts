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
 */

import { clamp } from './math.ts';
import {
  cloneTerrain,
  generateTerrain,
  hashTerrain,
  surfaceAt,
  type Terrain,
  type TerrainStyle,
} from './terrain.ts';
import { simulateFlight, trajectoryToArray, type HitCircle, type Trajectory } from './physics.ts';
import { applyDamage, detonate, type DetonationEvent } from './detonation.ts';
import { makeRng, restoreRng, type RngState } from './rng.ts';
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

  const width = config.width ?? DEFAULT_WORLD.width;
  const height = config.height ?? DEFAULT_WORLD.height;
  const rng = makeRng(config.seed);

  const terrainRng = rng.fork('terrain');
  const style: TerrainStyle =
    config.terrainStyle ??
    terrainRng.pick(['rolling', 'mountains', 'plateaus', 'valley', 'canyon'] as const);
  const terrain = generateTerrain({ width, height, style }, terrainRng);

  const tanks = placeTanks(players, terrain, rng.fork('placement'), config.startingMoney);

  const windRng = rng.fork('wind');
  const wind = roundWind(windRng.range(-DEFAULT_WORLD.maxWind, DEFAULT_WORLD.maxWind));

  return {
    seed: typeof config.seed === 'number' ? config.seed >>> 0 : hashSeed(config.seed),
    round: 1,
    totalRounds: config.totalRounds ?? 5,
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
}

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Wind is displayed as one decimal place; keep the state exactly that precise. */
function roundWind(raw: number): number {
  return Math.round(raw * 10) / 10;
}

function placeTanks(
  players: readonly PlayerSeed[],
  terrain: Terrain,
  rng: ReturnType<typeof makeRng>,
  startingMoney: number | undefined,
): Tank[] {
  const count = players.length;
  const margin = Math.min(90, Math.floor(terrain.width / (count + 2)));
  const usable = terrain.width - margin * 2;
  const slot = usable / count;

  return players.map((player, index) => {
    // One tank per evenly spaced slot, jittered inside it so maps never feel identical.
    const slotStart = margin + slot * index;
    const jitter = rng.range(slot * 0.2, slot * 0.8);
    const x = Math.round(clamp(slotStart + jitter, 4, terrain.width - 5));
    const y = surfaceAt(terrain, x);

    return {
      id: player.id,
      name: player.name,
      x,
      y,
      health: DEFAULT_WORLD.maxHealth,
      money: startingMoney ?? DEFAULT_WORLD.startingMoney,
      score: 0,
      alive: true,
      angleDeg: index < count / 2 ? 45 : 135,
      power: 60,
      selectedWeapon: BABY_MISSILE,
      inventory: {},
      colorIndex: player.colorIndex ?? index,
    };
  });
}

/** Re-seat every living tank on the current terrain surface (after a blast). */
export function settleTanks(state: GameState): GameEvent[] {
  const events: GameEvent[] = [];
  for (let index = 0; index < state.tanks.length; index += 1) {
    const tank = state.tanks[index] as Tank;
    if (!tank.alive) continue;
    const ground = surfaceAt(state.terrain, tank.x);
    if (ground === tank.y) continue;

    const fallDistance = ground - tank.y;
    tank.y = ground;

    // Falling hurts, exactly like the original.
    if (fallDistance > 24) {
      const damage = Math.min(60, Math.floor((fallDistance - 24) / 4));
      if (damage > 0) {
        applyFallDamage(state, index, damage, events);
      }
    }
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
  const trajectory = flyShot(next, muzzle, input.angleDeg, input.power, next.activeTank);
  events.push({
    type: 'shot',
    tankIndex: next.activeTank,
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
        next.activeTank,
        rng,
        DETONATION_RULES,
      ) as GameEvent[]),
    );
  }

  events.push(...settleTanks(next));
  next.rngState = rng.save();

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
 * Apply fall damage to a tank that dropped when the ground went out from
 * under it. Routes through the same applyDamage() as weapon blasts so the
 * "health never goes negative" invariant has exactly one implementation.
 */
function applyFallDamage(
  state: GameState,
  tankIndex: number,
  amount: number,
  events: GameEvent[],
): void {
  const detonationEvents: DetonationEvent[] = [];
  applyDamage(state, tankIndex, amount, null, DETONATION_RULES, detonationEvents);
  events.push(...(detonationEvents as GameEvent[]));
}

/** Hand the turn to the next living tank, or end the round. */
function advanceTurn(state: GameState, events: GameEvent[], rng: ReturnType<typeof makeRng>): void {
  const survivors = state.tanks.filter((tank) => tank.alive);

  if (survivors.length <= 1) {
    endRound(state, events, rng);
    return;
  }

  let next = state.activeTank;
  for (let i = 0; i < state.tanks.length; i += 1) {
    next = (next + 1) % state.tanks.length;
    if ((state.tanks[next] as Tank).alive) break;
  }

  state.activeTank = next;
  state.turnNumber += 1;
  // Wind drifts between turns rather than jumping — the original does the same.
  state.wind = roundWind(
    clamp(state.wind + rng.range(-2.5, 2.5), -DEFAULT_WORLD.maxWind, DEFAULT_WORLD.maxWind),
  );
  events.push({ type: 'turn', activeTank: next, turnNumber: state.turnNumber, wind: state.wind });
}

function endRound(state: GameState, events: GameEvent[], rng: ReturnType<typeof makeRng>): void {
  const survivors = state.tanks.filter((tank) => tank.alive);
  for (const tank of survivors) {
    tank.money += DEFAULT_WORLD.survivalBonus;
  }
  events.push({
    type: 'roundEnd',
    round: state.round,
    survivors: survivors.map((tank) => tank.id),
  });

  if (state.round >= state.totalRounds) {
    state.phase = 'gameover';
    const best = [...state.tanks].sort((a, b) => b.score - a.score)[0];
    state.winnerId = best?.id ?? null;
    events.push({ type: 'gameOver', winnerId: state.winnerId });
    return;
  }

  state.phase = 'shopping';
  state.pendingShoppers = state.tanks.map((tank) => tank.id);
  void rng;
}

/**
 * Start the next round: fresh terrain, everyone back to full health, inventory
 * carried over. Called once every player has left the shop.
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
  const style = terrainRng.pick(['rolling', 'mountains', 'plateaus', 'valley', 'canyon'] as const);
  next.terrain = generateTerrain(
    { width: state.terrain.width, height: state.terrain.height, style },
    terrainRng,
  );

  const placementRng = rng.fork(`placement:${next.round}`);
  const count = next.tanks.length;
  const margin = Math.min(90, Math.floor(next.terrain.width / (count + 2)));
  const slot = (next.terrain.width - margin * 2) / count;

  next.tanks.forEach((tank, index) => {
    const jitter = placementRng.range(slot * 0.2, slot * 0.8);
    tank.x = Math.round(clamp(margin + slot * index + jitter, 4, next.terrain.width - 5));
    tank.y = surfaceAt(next.terrain, tank.x);
    tank.health = DEFAULT_WORLD.maxHealth;
    tank.alive = true;
  });

  next.activeTank = 0;
  next.turnNumber += 1;
  next.wind = roundWind(rng.range(-DEFAULT_WORLD.maxWind, DEFAULT_WORLD.maxWind));
  next.rngState = rng.save();

  return {
    state: next,
    events: [{ type: 'turn', activeTank: 0, turnNumber: next.turnNumber, wind: next.wind }],
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
 * compare this after replaying a recorded input sequence.
 */
export function hashGameState(state: GameState): string {
  let hash = hashTerrain(state.terrain);
  const mix = (value: number): void => {
    hash ^= value | 0;
    hash = Math.imul(hash, 0x01000193);
  };

  mix(state.round);
  mix(state.turnNumber);
  mix(state.activeTank);
  mix(Math.round(state.wind * 10));
  mix(state.phase.length);
  mix(state.rngState.a);
  mix(state.rngState.b);
  mix(state.rngState.c);
  mix(state.rngState.d);

  for (const tank of state.tanks) {
    mix(tank.x);
    mix(tank.y);
    mix(tank.health);
    mix(tank.money);
    mix(tank.score);
    mix(tank.alive ? 1 : 0);
    mix(Math.round(tank.angleDeg * 100));
    mix(Math.round(tank.power * 100));
    for (const [weaponId, count] of Object.entries(tank.inventory).sort()) {
      for (let i = 0; i < weaponId.length; i += 1) mix(weaponId.charCodeAt(i));
      mix(count);
    }
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}
