/**
 * Plain-JSON view of the game state.
 *
 * The sim owns typed arrays (`Int32Array` for the heightmap) which do not
 * survive `JSON.stringify`. These converters are the single crossing point
 * between the in-memory state and anything that gets stored in Durable Object
 * SQLite or pushed down a WebSocket.
 *
 * The shape here is structurally identical to `GameSnapshotSchema` in
 * @scorched/protocol — deliberately duplicated rather than imported, so that
 * `packages/sim` keeps its zero-dependency guarantee.
 */

import type { GameState, GamePhase, Tank } from './game.ts';
import { deserializeTerrain, serializeTerrain } from './terrain.ts';
import type { RngState } from './rng.ts';
import type { WeaponId } from './weapons.ts';

export interface TankSnapshot {
  id: string;
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
  inventory: Record<string, number>;
  colorIndex: number;
}

export interface GameSnapshot {
  seed: number;
  round: number;
  totalRounds: number;
  phase: GamePhase;
  terrain: { width: number; height: number; surface: number[] };
  tanks: TankSnapshot[];
  activeTank: number;
  turnNumber: number;
  wind: number;
  winnerId: string | null;
  pendingShoppers: string[];
}

/**
 * Snapshot sent to clients. Note it deliberately omits `rngState`: knowing the
 * PRNG state would let a client predict future wind and cluster scatter.
 */
export function toSnapshot(state: GameState): GameSnapshot {
  return {
    seed: state.seed,
    round: state.round,
    totalRounds: state.totalRounds,
    phase: state.phase,
    terrain: serializeTerrain(state.terrain),
    tanks: state.tanks.map(toTankSnapshot),
    activeTank: state.activeTank,
    turnNumber: state.turnNumber,
    wind: state.wind,
    winnerId: state.winnerId,
    pendingShoppers: [...state.pendingShoppers],
  };
}

function toTankSnapshot(tank: Tank): TankSnapshot {
  return {
    id: tank.id,
    name: tank.name,
    x: tank.x,
    y: tank.y,
    health: tank.health,
    money: tank.money,
    score: tank.score,
    alive: tank.alive,
    angleDeg: tank.angleDeg,
    power: tank.power,
    selectedWeapon: tank.selectedWeapon,
    inventory: { ...tank.inventory },
    colorIndex: tank.colorIndex,
  };
}

/** Full persistence form — includes the RNG state, so a room resumes exactly. */
export interface PersistedGame extends GameSnapshot {
  rngState: RngState;
}

export function toPersisted(state: GameState): PersistedGame {
  return { ...toSnapshot(state), rngState: { ...state.rngState } };
}

export function fromPersisted(data: PersistedGame): GameState {
  return {
    seed: data.seed,
    round: data.round,
    totalRounds: data.totalRounds,
    phase: data.phase,
    terrain: deserializeTerrain(data.terrain),
    tanks: data.tanks.map((tank) => ({ ...tank, inventory: { ...tank.inventory } })),
    activeTank: data.activeTank,
    turnNumber: data.turnNumber,
    wind: data.wind,
    rngState: { ...data.rngState },
    winnerId: data.winnerId,
    pendingShoppers: [...data.pendingShoppers],
  };
}
