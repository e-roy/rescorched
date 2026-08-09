/**
 * Rounds, the match, and the clock that stops a match lasting forever.
 *
 * The interesting cases here are the ones a real game reaches rarely and a
 * server has to survive anyway: a round nobody can win, a round everybody
 * loses, and a match that ends level.
 */

import { describe, expect, it } from 'vitest';
import {
  createGame,
  DEFAULT_WORLD,
  fire,
  hashGameState,
  IllegalMoveError,
  matchStandings,
  matchWinnerId,
  ROUND_WIN_SCORE,
  roundStartTurn,
  roundTurnBudget,
  startNextRound,
  SUDDEN_DEATH_STEP,
  SUDDEN_DEATH_TURNS,
  turnsTakenThisRound,
  TURNS_PER_TANK,
  type GameEvent,
  type GameState,
  type PlayerSeed,
  type Tank,
} from '../src/game.ts';
import { leaveShop } from '../src/economy.ts';
import { emptyTerrain } from '../src/terrain.ts';
import { makeRng } from '../src/rng.ts';
import { BABY_MISSILE } from '../src/weapons.ts';
import { fromPersisted, toPersisted } from '../src/serialize.ts';

const WIDTH = 1280;
const HEIGHT = 720;
const GROUND = 400;

const players = (count: number): PlayerSeed[] =>
  Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

/**
 * A round nobody can win: flat ground, tanks at x = 100, 300, 500, 700, and
 * one shot — 45 degrees, full power — that lands 310 px clear of the nearest
 * tank or leaves the map altogether. See `game-turns.test.ts` for the geometry.
 *
 * This is the stalemate the turn clock exists for, built deliberately rather
 * than fished out of a seed.
 */
function stalemateGame(count: number, seed: string, totalRounds = 3): GameState {
  if (count > 4) throw new Error('the harmless geometry only holds for up to 4 tanks');
  const base = createGame({ seed, totalRounds, width: WIDTH, height: HEIGHT }, players(count));
  const terrain = emptyTerrain(WIDTH, HEIGHT);
  terrain.surface.fill(GROUND);
  return {
    ...base,
    terrain,
    wind: 0,
    tanks: base.tanks.map((tank, index) => ({ ...tank, x: 100 + index * 200, y: GROUND })),
  };
}

const HARMLESS = { angleDeg: 45, power: 100, weapon: BABY_MISSILE } as const;

function step(state: GameState): { state: GameState; events: GameEvent[] } {
  const shooter = state.tanks[state.activeTank] as Tank;
  return fire(state, shooter.id, { turnNumber: state.turnNumber, ...HARMLESS });
}

function kill(state: GameState, indices: readonly number[]): GameState {
  const doomed = new Set(indices);
  return {
    ...state,
    tanks: state.tanks.map((tank, index) =>
      doomed.has(index) ? { ...tank, alive: false, health: 0 } : tank,
    ),
  };
}

describe('a round ends when it should and pays once', () => {
  it('keeps going while two or more tanks are standing', () => {
    let state = stalemateGame(3, 'three-left');
    state = kill(state, [(state.activeTank + 1) % 3]);
    const { state: after, events } = step(state);

    expect(after.phase).toBe('aiming');
    expect(events.some((event) => event.type === 'roundEnd')).toBe(false);
  });

  it('ends the moment one tank is left, and pays that tank exactly once', () => {
    const start = stalemateGame(3, 'last-one-standing');
    const survivorIndex = start.activeTank;
    const doomed = [0, 1, 2].filter((index) => index !== survivorIndex);
    const state = kill(start, doomed);
    const before = state.tanks[survivorIndex] as Tank;

    const { state: after, events } = step(state);

    const roundEnds = events.filter((event) => event.type === 'roundEnd');
    expect(roundEnds).toHaveLength(1);
    expect(roundEnds[0]).toEqual({ type: 'roundEnd', round: 1, survivors: [before.id] });

    const survivor = after.tanks[survivorIndex] as Tank;
    expect(survivor.money).toBe(before.money + DEFAULT_WORLD.survivalBonus);
    expect(survivor.score).toBe(before.score + ROUND_WIN_SCORE);
    expect(after.phase).toBe('shopping');

    // And there is no way to be paid twice: the phase it left behind is one
    // `fire` refuses outright.
    expect(() => fire(after, survivor.id, { turnNumber: after.turnNumber, ...HARMLESS })).toThrow(
      IllegalMoveError,
    );
  });

  it('ends with nobody paid when the last two die together', () => {
    // Zero survivors is a real outcome — the clock below produces it — and the
    // round has to close cleanly rather than wait for a winner who is not
    // coming.
    const start = stalemateGame(3, 'mutual-destruction');
    const state = kill(start, [(start.activeTank + 1) % 3, (start.activeTank + 2) % 3]);
    const shooter = state.tanks[state.activeTank] as Tank;
    const doomed = kill(state, [state.activeTank]);
    // Everyone is gone; the next resolution has to notice.
    const { state: after, events } = fire(
      {
        ...doomed,
        tanks: doomed.tanks.map((t) => (t.id === shooter.id ? { ...t, alive: true } : t)),
      },
      shooter.id,
      { turnNumber: state.turnNumber, ...HARMLESS },
    );
    expect(after.phase).toBe('shopping');
    expect(events.filter((event) => event.type === 'roundEnd')).toHaveLength(1);
  });

  it('opens the shop for everyone, living and dead', () => {
    const start = stalemateGame(3, 'shop-opens');
    const survivorIndex = start.activeTank;
    const state = kill(
      start,
      [0, 1, 2].filter((index) => index !== survivorIndex),
    );
    const { state: after } = step(state);
    expect(after.pendingShoppers).toEqual(after.tanks.map((tank) => tank.id));
  });
});

describe('the next round', () => {
  it('regenerates terrain, revives everyone and carries the scoreboard over', () => {
    const base = stalemateGame(2, 'next-round');
    const state: GameState = {
      ...base,
      phase: 'shopping',
      pendingShoppers: [],
      tanks: base.tanks.map((tank, index) => ({
        ...tank,
        health: 0,
        alive: false,
        score: 40 + index,
        money: 7777,
        inventory: { missile: 3 },
      })),
    };

    const { state: next } = startNextRound(state);

    expect(next.round).toBe(2);
    expect(next.phase).toBe('aiming');
    expect(next.terrain.surface).not.toEqual(state.terrain.surface);
    next.tanks.forEach((tank, index) => {
      expect(tank.alive).toBe(true);
      expect(tank.health).toBe(DEFAULT_WORLD.maxHealth);
      expect(tank.y).toBe(next.terrain.surface[tank.x]);
      // Carried, not reset: this is what makes it a match rather than a series
      // of unrelated rounds.
      expect(tank.score).toBe(40 + index);
      expect(tank.money).toBe(7777);
      expect(tank.inventory).toEqual({ missile: 3 });
    });
  });

  it('never lets the turn number go backwards', () => {
    // Clients echo the turn number back and the server rejects anything stale.
    // A number that repeated across a round boundary would make a shot from the
    // previous round look current.
    let state = stalemateGame(2, 'monotonic', 4);
    let previous = state.turnNumber;
    for (let round = 0; round < 3; round += 1) {
      // Force the round to a close, then roll on. The round-ending shot hands
      // nobody a turn, so it does not consume a turn number — but it must not
      // give one back either.
      state = kill(state, [(state.activeTank + 1) % 2]);
      state = step(state).state;
      expect(state.turnNumber).toBeGreaterThanOrEqual(previous);
      previous = state.turnNumber;

      if (state.phase !== 'shopping') break;
      for (const id of [...state.pendingShoppers]) state = leaveShop(state, id);
      state = startNextRound(state).state;
      expect(state.turnNumber).toBeGreaterThan(previous);
      previous = state.turnNumber;
      expect(turnsTakenThisRound(state)).toBe(1);
      expect(state.turnNumber).toBe(roundStartTurn(state));
    }
  });
});

describe('the match ends and picks a winner', () => {
  it('runs exactly the configured number of rounds', () => {
    for (const totalRounds of [1, 2, 3]) {
      let state = stalemateGame(2, `rounds-${totalRounds}`, totalRounds);
      let ended = 0;
      for (let guard = 0; guard < 20 && state.phase !== 'gameover'; guard += 1) {
        if (state.phase === 'shopping') {
          for (const id of [...state.pendingShoppers]) state = leaveShop(state, id);
          state = startNextRound(state).state;
          continue;
        }
        state = kill(state, [(state.activeTank + 1) % 2]);
        const result = step(state);
        state = result.state;
        ended += result.events.filter((event) => event.type === 'roundEnd').length;
      }
      expect(state.phase).toBe('gameover');
      expect(ended).toBe(totalRounds);
      expect(state.round).toBe(totalRounds);
      expect(state.winnerId).not.toBeNull();
    }
  });

  /**
   * Finish a one-round match with `survivorScore` on the last tank standing and
   * `rivalScore` on the tank that died, and report who the match crowns.
   *
   * Both numbers are damage already dealt — `detonation.ts` grows `score` by one
   * point per point of damage — so this is a match where one player out-shot
   * the other and the other outlived them.
   */
  function crownedWith(
    seed: string,
    survivorScore: number,
    rivalScore: number,
  ): { winnerId: string | null; survivorId: string; rivalId: string } {
    const start = stalemateGame(2, seed, 1);
    const winnerIndex = start.activeTank;
    const state: GameState = {
      ...kill(start, [(winnerIndex + 1) % 2]),
      tanks: start.tanks.map((tank, index) => ({
        ...tank,
        alive: index === winnerIndex,
        health: index === winnerIndex ? 100 : 0,
        score: index === winnerIndex ? survivorScore : rivalScore,
        // Level money, so the standings are decided by the scoreboard this test
        // is about rather than by the survival bonus that comes with it.
        money: 0,
      })),
    };
    const { state: after, events } = step(state);
    expect(after.phase).toBe('gameover');
    expect(events).toContainEqual({ type: 'gameOver', winnerId: after.winnerId });
    return {
      winnerId: after.winnerId,
      survivorId: (start.tanks[winnerIndex] as Tank).id,
      rivalId: (start.tanks[(winnerIndex + 1) % 2] as Tank).id,
    };
  }

  it('crowns the scoreboard, not the last one standing', () => {
    // A 490-point lead on damage is not something surviving one round can
    // overturn, and it should not be: the match is won on the scoreboard.
    const { winnerId, rivalId } = crownedWith('crown', 10, 500);
    expect(winnerId).toBe(rivalId);
  });

  it('makes surviving a round worth more than a near-lethal miss', () => {
    // 99 points is the most damage one tank can take and live: the rival hit
    // for everything short of a kill, and then died. Surviving has to outweigh
    // that, or the shot that nearly worked scores better than the round that
    // was actually won.
    const { winnerId, survivorId } = crownedWith('near-miss', 0, DEFAULT_WORLD.maxHealth - 1);
    expect(winnerId).toBe(survivorId);
  });

  it('does not let a player who loses every round win on accumulated near-misses', () => {
    // The regression in full, over a real three-round match: one player wins
    // every round without landing a shot, the other lands a near-lethal hit
    // every round and dies every round. Winning the match by losing it is the
    // failure mode `ROUND_WIN_SCORE` exists to prevent, and it is stated here in
    // rounds and damage rather than by restating the constant.
    const nearLethal = DEFAULT_WORLD.maxHealth - 1;
    const rounds = 3;
    let state = stalemateGame(2, 'never-wins', rounds);
    const winner = (state.tanks[0] as Tank).id;
    const loser = (state.tanks[1] as Tank).id;

    for (let round = 1; round <= rounds; round += 1) {
      // Tank 1 spent the round chipping tank 0 down to one health and no
      // further. `score` is a plain accumulator that `detonation.ts` grows by a
      // point per point of damage; adding to it directly is the same ledger
      // entry a real hit would have made, and it keeps this test about the
      // round machinery rather than about ballistics.
      state = {
        ...kill(state, [1]),
        activeTank: 0,
        tanks: state.tanks.map((tank, index) =>
          index === 1
            ? { ...tank, alive: false, health: 0, score: tank.score + nearLethal }
            : { ...tank, alive: true, health: 1 },
        ),
      };
      state = step(state).state;
      expect(state.round).toBe(round);
      if (state.phase !== 'shopping') break;
      for (const id of [...state.pendingShoppers]) state = leaveShop(state, id);
      state = startNextRound(state).state;
    }

    expect(state.phase).toBe('gameover');
    const standings = matchStandings(state);
    expect((standings[0] as Tank).id).toBe(winner);
    expect((standings[1] as Tank).id).toBe(loser);
    expect(state.winnerId).toBe(winner);
    // The loser really did out-damage the winner, which is what makes this a
    // test of the round bonus rather than of arithmetic.
    expect((state.tanks[1] as Tank).score).toBe(rounds * nearLethal);
    expect((state.tanks[0] as Tank).score).toBeGreaterThan((state.tanks[1] as Tank).score);
  });

  it('breaks a dead-level tie the same way whatever order the lobby is in', () => {
    // Two players, identical everything. `Array.prototype.sort` leaves equal
    // keys in input order, and input order is lobby join order — so without an
    // explicit tiebreak the winner would depend on who clicked join first.
    const level = (ids: readonly string[]): Pick<GameState, 'tanks'> => ({
      tanks: ids.map((id) => ({ id, score: 100, money: 5000 }) as Tank),
    });

    expect(matchWinnerId(level(['zoe', 'adam']))).toBe('adam');
    expect(matchWinnerId(level(['adam', 'zoe']))).toBe('adam');

    // Money splits a score tie before the id has to.
    const richer: Pick<GameState, 'tanks'> = {
      tanks: [
        { id: 'adam', score: 100, money: 10 } as Tank,
        { id: 'zoe', score: 100, money: 20 } as Tank,
      ],
    };
    expect(matchWinnerId(richer)).toBe('zoe');
  });

  it('orders the whole scoreboard, not just the top of it', () => {
    const state: Pick<GameState, 'tanks'> = {
      tanks: [
        { id: 'c', score: 10, money: 1 } as Tank,
        { id: 'a', score: 30, money: 1 } as Tank,
        { id: 'b', score: 30, money: 9 } as Tank,
      ],
    };
    expect(matchStandings(state).map((tank) => tank.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('the turn clock', () => {
  it('gives every tank its budget before it starts biting', () => {
    const state = stalemateGame(2, 'budget');
    expect(roundTurnBudget(2)).toBe(TURNS_PER_TANK * 2);
    expect(roundStartTurn(state)).toBe(1);
    expect(turnsTakenThisRound(state)).toBe(1);
  });

  it('ends a round nobody can win, and does it on schedule', () => {
    // The headline claim: two players who cannot reach each other must not be
    // able to play forever. Nothing here is contrived except the map — every
    // shot is legal, lands nowhere, and hurts nobody.
    let state = stalemateGame(2, 'forever');
    const budget = roundTurnBudget(2);
    const limit = budget + SUDDEN_DEATH_TURNS;

    const damageTurns: number[] = [];
    let deaths: GameEvent[] = [];
    let roundEnd: GameEvent | undefined;
    let turns = 0;

    while (state.phase === 'aiming' && turns < limit + 5) {
      const taken = turnsTakenThisRound(state);
      const result = step(state);
      turns += 1;
      if (result.events.some((event) => event.type === 'damage')) damageTurns.push(taken);
      deaths = [...deaths, ...result.events.filter((event) => event.type === 'death')];
      roundEnd = result.events.find((event) => event.type === 'roundEnd') ?? roundEnd;
      state = result.state;
    }

    expect(state.phase).not.toBe('aiming');
    expect(turns).toBeLessThanOrEqual(limit);

    // Not one point of damage before the budget ran out, and damage on every
    // turn after it.
    expect(Math.min(...damageTurns)).toBe(budget);
    expect(damageTurns).toEqual(Array.from({ length: damageTurns.length }, (_, i) => budget + i));

    // Everybody died, the clock killed them, and the round closed with nobody
    // to pay.
    expect(state.tanks.every((tank) => !tank.alive)).toBe(true);
    expect(deaths.length).toBe(2);
    for (const death of deaths) {
      expect(death).toMatchObject({ byTankIndex: null });
    }
    expect(roundEnd).toMatchObject({ type: 'roundEnd', survivors: [] });
  });

  it('escalates rather than executing', () => {
    // A single lethal hit at the buzzer would be indistinguishable from a bug.
    // The drain has to be visible for a few turns first so a player can see the
    // round closing and take a desperate shot.
    let state = stalemateGame(2, 'escalation');
    const budget = roundTurnBudget(2);
    const dealt: number[] = [];

    while (state.phase === 'aiming' && turnsTakenThisRound(state) <= budget + 2) {
      const overtime = turnsTakenThisRound(state) - budget;
      const result = step(state);
      if (overtime >= 0) {
        const amounts = result.events
          .filter((event) => event.type === 'damage')
          .map((event) => (event as Extract<GameEvent, { type: 'damage' }>).amount);
        expect(new Set(amounts).size).toBe(1);
        dealt.push(amounts[0] as number);
      }
      state = result.state;
    }

    expect(dealt).toEqual([SUDDEN_DEATH_STEP, SUDDEN_DEATH_STEP * 2, SUDDEN_DEATH_STEP * 3]);
  });

  it('closes a whole match of stalemates without running away', () => {
    let state = stalemateGame(2, 'whole-stalemate-match', 3);
    const perRound = roundTurnBudget(2) + SUDDEN_DEATH_TURNS;
    let guard = 0;

    while (state.phase !== 'gameover' && guard < 3 * perRound + 10) {
      guard += 1;
      if (state.phase === 'shopping') {
        for (const id of [...state.pendingShoppers]) state = leaveShop(state, id);
        state = startNextRound(state).state;
        continue;
      }
      state = step(state).state;
    }

    expect(state.phase).toBe('gameover');
    expect(state.round).toBe(3);
    expect(state.winnerId).not.toBeNull();
  });

  it('gives every round its whole budget, even after one that ran to the buzzer', () => {
    // What `roundStride` is for, and it can only be seen after a round that
    // actually used its overtime — which is why this drives a stalemate match
    // rather than killing a tank to end each round early.
    //
    // `turnNumber` is monotonic across the whole match, so each round has to be
    // handed a block of numbers wide enough for the longest round that can
    // happen: the budget plus every sudden-death turn. Size the stride at just
    // the budget and round one overruns into round two's block. `startNextRound`
    // keeps the number moving forwards, so nothing looks broken — but round two
    // opens with `turnsTakenThisRound` already at 4, four turns of its budget
    // gone before anybody fires, and the error compounds every round until a
    // round begins in sudden death.
    let state = stalemateGame(2, 'full-budget', 3);
    const opened: number[] = [];
    let guard = 0;

    while (
      state.phase !== 'gameover' &&
      guard < 3 * (roundTurnBudget(2) + SUDDEN_DEATH_TURNS) + 10
    ) {
      guard += 1;
      if (state.phase === 'shopping') {
        for (const id of [...state.pendingShoppers]) state = leaveShop(state, id);
        state = startNextRound(state).state;
        // Every round starts on its own first turn number, with its budget
        // untouched — not merely on a number larger than the last one.
        expect(state.turnNumber, `round ${state.round}`).toBe(roundStartTurn(state));
        expect(turnsTakenThisRound(state), `round ${state.round}`).toBe(1);
        opened.push(state.turnNumber);
        continue;
      }
      // The rounds really are running long enough for this to mean something.
      expect(turnsTakenThisRound(state)).toBeLessThanOrEqual(
        roundTurnBudget(2) + SUDDEN_DEATH_TURNS,
      );
      state = step(state).state;
    }

    expect(state.phase).toBe('gameover');
    // Two round boundaries in a three-round match, and each block starts a
    // whole stride after the last.
    expect(opened).toHaveLength(2);
    const stride = (opened[1] as number) - (opened[0] as number);
    expect(stride).toBeGreaterThan(roundTurnBudget(2) + SUDDEN_DEATH_TURNS);
  });
});

// ---------------------------------------------------------------------------
// Whole matches
// ---------------------------------------------------------------------------

interface Shot {
  angleDeg: number;
  power: number;
}

function scriptedShots(seed: string, count: number): Shot[] {
  const rng = makeRng(seed);
  return Array.from({ length: count }, () => ({
    angleDeg: Math.round(rng.range(5, 175)),
    power: Math.round(rng.range(20, 100)),
  }));
}

/** Play a whole match with a fixed script, driving the shop like the server does. */
function playMatch(seed: string, count: number, totalRounds: number): GameState {
  let state = createGame({ seed, totalRounds, width: WIDTH, height: HEIGHT }, players(count));
  const budget = roundTurnBudget(count) + SUDDEN_DEATH_TURNS;
  const limit = totalRounds * (budget + 2) + 10;
  const shots = scriptedShots(seed, limit);

  let guard = 0;
  while (state.phase !== 'gameover') {
    expect(guard, `match ${seed} never finished`).toBeLessThan(limit);
    if (state.phase === 'shopping') {
      for (const id of [...state.pendingShoppers]) state = leaveShop(state, id);
      state = startNextRound(state).state;
      guard += 1;
      continue;
    }
    expect(state.phase).toBe('aiming');
    const shooter = state.tanks[state.activeTank] as Tank;
    const shot = shots[guard] as Shot;
    state = fire(state, shooter.id, {
      turnNumber: state.turnNumber,
      angleDeg: shot.angleDeg,
      power: shot.power,
      weapon: BABY_MISSILE,
    }).state;
    guard += 1;
  }
  return state;
}

describe('whole matches', () => {
  it('plays to a finish for many seeds and player counts without throwing', () => {
    for (let seed = 0; seed < 24; seed += 1) {
      for (const count of [2, 3, 4]) {
        const final = playMatch(`match-${seed}`, count, 2);
        expect(final.phase).toBe('gameover');
        expect(final.round).toBe(2);
        expect(final.winnerId).toBe(matchWinnerId(final));
        expect(final.tanks.map((tank) => tank.id)).toContain(final.winnerId);
        for (const tank of final.tanks) {
          expect(tank.health).toBeGreaterThanOrEqual(0);
          expect(tank.health).toBeLessThanOrEqual(DEFAULT_WORLD.maxHealth);
          expect(tank.money).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(tank.score)).toBe(true);
        }
      }
    }
  }, 300_000);

  it('same seed and same inputs, same final state — every time', () => {
    for (let seed = 0; seed < 12; seed += 1) {
      const a = playMatch(`replay-${seed}`, 3, 2);
      const b = playMatch(`replay-${seed}`, 3, 2);
      expect(hashGameState(a)).toBe(hashGameState(b));
    }
  }, 300_000);

  it('different seeds really do diverge', () => {
    const hashes = new Set(
      Array.from({ length: 12 }, (_, seed) => hashGameState(playMatch(`diverge-${seed}`, 3, 2))),
    );
    expect(hashes.size).toBe(12);
  }, 300_000);
});

describe('storing and resuming mid-match', () => {
  /** A state several turns into a real match, in whatever phase it lands in. */
  function partway(seed: string, turns: number): GameState {
    let state = createGame({ seed, totalRounds: 3, width: WIDTH, height: HEIGHT }, players(3));
    const shots = scriptedShots(seed, turns);
    for (let i = 0; i < turns; i += 1) {
      if (state.phase !== 'aiming') break;
      const shooter = state.tanks[state.activeTank] as Tank;
      const shot = shots[i] as Shot;
      state = fire(state, shooter.id, {
        turnNumber: state.turnNumber,
        angleDeg: shot.angleDeg,
        power: shot.power,
        weapon: BABY_MISSILE,
      }).state;
    }
    return state;
  }

  const roundTrip = (state: GameState): GameState =>
    fromPersisted(JSON.parse(JSON.stringify(toPersisted(state))));

  it('round-trips through JSON with no drift, at every point in a match', () => {
    for (let seed = 0; seed < 8; seed += 1) {
      for (const turns of [1, 4, 9]) {
        const state = partway(`resume-${seed}`, turns);
        expect(hashGameState(roundTrip(state))).toBe(hashGameState(state));
      }
    }
  });

  it('produces a bit-identical next turn after a restore', () => {
    for (let seed = 0; seed < 8; seed += 1) {
      const state = partway(`next-turn-${seed}`, 5);
      if (state.phase !== 'aiming') continue;
      const shooter = state.tanks[state.activeTank] as Tank;
      const input = { turnNumber: state.turnNumber, angleDeg: 63, power: 71, weapon: BABY_MISSILE };

      const direct = fire(state, shooter.id, input);
      const resumed = fire(roundTrip(state), shooter.id, input);

      expect(hashGameState(resumed.state)).toBe(hashGameState(direct.state));
      // The events go on the wire; a client replaying a resumed room has to see
      // exactly what a client in the original room saw.
      expect(resumed.events).toEqual(direct.events);
    }
  });

  it('rolls the next round identically after a restore', () => {
    // The round boundary is where the derived state lives — turn order, the
    // round's turn budget, the placement fork — so it is the boundary most
    // likely to disagree with itself across a hibernation.
    const base = stalemateGame(3, 'resume-round');
    const shopping: GameState = { ...base, phase: 'shopping', pendingShoppers: [] };

    const direct = startNextRound(shopping);
    const resumed = startNextRound(roundTrip(shopping));

    expect(hashGameState(resumed.state)).toBe(hashGameState(direct.state));
    expect(resumed.events).toEqual(direct.events);
    expect(resumed.state.activeTank).toBe(direct.state.activeTank);
    expect(resumed.state.tanks.map((tank) => tank.x)).toEqual(
      direct.state.tanks.map((tank) => tank.x),
    );
  });
});
