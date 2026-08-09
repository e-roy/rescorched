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
import type { BotPersonality } from './ai.ts';
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

/**
 * A persisted seat. Everything in `TankSnapshot`, plus who is driving.
 *
 * `bot` lives here and NOT in `TankSnapshot` on purpose. `TankSnapshot` is the
 * wire shape, and the comment at the top of this file is a promise that it
 * stays structurally identical to `GameSnapshotSchema` in `@scorched/protocol`
 * — a Zod object that strips what it does not know, so a field added there
 * would not reach a client anyway, it would just quietly disappear and make the
 * two shapes disagree. Persistence has no such constraint and a real need: a
 * Durable Object that hibernated and forgot which seats were computer players
 * would resume the match with six silent tanks that never take their turn.
 * When the lobby needs to SHOW that a seat is a bot, that is a protocol change,
 * made deliberately, in the protocol package.
 */
export interface PersistedTank extends TankSnapshot {
  bot: BotPersonality | null;
}

/** Full persistence form — includes the RNG state, so a room resumes exactly. */
export interface PersistedGame extends GameSnapshot {
  tanks: PersistedTank[];
  rngState: RngState;
}

export function toPersisted(state: GameState): PersistedGame {
  return {
    ...toSnapshot(state),
    tanks: state.tanks.map((tank) => ({ ...toTankSnapshot(tank), bot: tank.bot })),
    rngState: { ...state.rngState },
  };
}

export function fromPersisted(data: PersistedGame): GameState {
  return {
    seed: data.seed,
    round: data.round,
    totalRounds: data.totalRounds,
    phase: data.phase,
    terrain: deserializeTerrain(data.terrain),
    // `bot` is read defensively rather than spread: a row written before the
    // field existed has no `bot` key at all, and a tank whose `bot` came back
    // `undefined` would be neither a human (null) nor a bot, which is the kind
    // of third state that gets discovered in production.
    tanks: data.tanks.map((tank) => ({
      ...tank,
      inventory: { ...tank.inventory },
      bot: tank.bot ?? null,
    })),
    activeTank: data.activeTank,
    turnNumber: data.turnNumber,
    wind: data.wind,
    rngState: { ...data.rngState },
    winnerId: data.winnerId,
    pendingShoppers: [...data.pendingShoppers],
  };
}
