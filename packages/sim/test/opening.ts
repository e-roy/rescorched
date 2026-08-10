/**
 * Shared fixture: a match that has already been through the opening armoury.
 *
 * `createGame` opens in `shopping` — the pre-match armoury, where a player
 * spends their starting money before the first shell flies (see
 * `isArmouryBeforeRoundOne` in `src/game.ts`). Almost every test in this
 * package is about what happens once shooting starts, and none of them want to
 * restate that transition.
 *
 * It lives here rather than being copied into each suite so that there is one
 * place to look when the opening changes again, and so that a test which
 * genuinely cares about the armoury calls `createGame` directly and is visibly
 * doing something different.
 */

import {
  createGame,
  startNextRound,
  type GameConfig,
  type GameState,
  type PlayerSeed,
} from '../src/game.ts';

/** A match on turn 1 of round 1, everyone still holding whatever they started with. */
export function openedGame(config: GameConfig, players: readonly PlayerSeed[]): GameState {
  return startNextRound(createGame(config, players)).state;
}
