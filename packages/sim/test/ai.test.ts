/**
 * Computer players: the three things that must never break.
 *
 * 1. The decision is DETERMINISTIC — a pure function of persisted state, and of
 *    nothing else. This is the load-bearing one: every client replays the
 *    authoritative event stream, so a bot whose aim depended on anything the
 *    sim cannot see would make two browsers disagree about who died.
 * 2. The decision is always LEGAL. Proved by handing it to the real `fire()`
 *    rather than by re-checking the bounds `fire()` checks — a test that
 *    restated "angle is between 0 and 180" would police the constant instead of
 *    the behaviour, which is the mistake this repo keeps making.
 * 3. It NEVER throws, for any state the server can legally hand it.
 *
 * The measured differences between the personalities live in
 * `ai-personalities.test.ts`, the bracket's convergence in
 * `ai-poolshark.test.ts`, and the search's cost in `ai-performance.test.ts`.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  BOT_PERSONALITIES,
  chooseShot,
  chooseShotDetailed,
  chooseTarget,
  chooseWeapon,
  isBotPersonality,
  type BotPersonality,
} from '../src/ai.ts';
import {
  ammoFor,
  createGame,
  fire,
  hashGameState,
  IllegalMoveError,
  type GameState,
  type PlayerSeed,
  type Tank,
} from '../src/game.ts';
import { fromPersisted, toPersisted, toSnapshot } from '../src/serialize.ts';
import { restoreRng } from '../src/rng.ts';
import { emptyTerrain, type Terrain } from '../src/terrain.ts';
import { getWeapon, WEAPONS } from '../src/weapons.ts';

const WIDTH = 1280;
const HEIGHT = 720;

const seats = (count: number, bots: Partial<Record<number, BotPersonality>> = {}): PlayerSeed[] =>
  Array.from({ length: count }, (_, i) => {
    const bot = bots[i];
    return bot === undefined ? { id: `p${i}`, name: `P${i}` } : { id: `p${i}`, name: `P${i}`, bot };
  });

function duel(seed: string, personality: BotPersonality): GameState {
  return createGame({ seed, width: WIDTH, height: HEIGHT }, [
    { id: 'p0', name: 'P0', bot: personality },
    { id: 'p1', name: 'P1' },
  ]);
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('the decision is a pure function of the state', () => {
  it('is byte-identical however many times it is asked', () => {
    for (const personality of BOT_PERSONALITIES) {
      for (let seed = 0; seed < 6; seed += 1) {
        const state = duel(`repeat-${seed}`, personality);
        const first = chooseShot(state, 0);
        for (let again = 0; again < 25; again += 1) {
          const next = chooseShot(state, 0);
          // Exact equality on the floats, not a tolerance. A shot that differs
          // in the last bit is a shot that lands in a different pixel.
          expect(next.angleDeg).toBe(first.angleDeg);
          expect(next.power).toBe(first.power);
          expect(next.weapon).toBe(first.weapon);
        }
      }
    }
  }, 120_000);

  it('is identical for two independently built states with the same seed', () => {
    for (const personality of BOT_PERSONALITIES) {
      for (let seed = 0; seed < 6; seed += 1) {
        const a = duel(`twin-${seed}`, personality);
        const b = duel(`twin-${seed}`, personality);
        expect(hashGameState(a)).toBe(hashGameState(b));
        expect(chooseShot(a, 0)).toEqual(chooseShot(b, 0));
      }
    }
  }, 120_000);

  /**
   * The one that matters most, and the reason `ai.ts` derives its own stream
   * instead of forking the room's.
   *
   * `state.rngState` moves every time a shell scatters sub-munitions or the
   * wind is rolled, so it carries a running count of everything that has
   * happened in the match. A bot that drew from it — `restoreRng(state.rngState)`
   * or a fork of it — would decide differently depending on how many
   * detonations happened to precede this turn, which is exactly the kind of
   * nondeterminism that survives every other test in this suite: it would still
   * be seeded, still reproducible in-process, and still wrong the moment a
   * client replayed the match from a snapshot taken at a different point.
   *
   * So: advance the RNG state by a wildly varying number of draws, change
   * NOTHING else, and demand the identical decision.
   */
  it('does not move when the room RNG has been drawn from', () => {
    for (const personality of BOT_PERSONALITIES) {
      const base = duel('rng-independence', personality);
      const expected = chooseShot(base, 0);

      for (const draws of [1, 2, 7, 64, 999]) {
        const rng = restoreRng(base.rngState);
        for (let i = 0; i < draws; i += 1) rng.nextU32();
        const advanced: GameState = { ...base, rngState: rng.save() };

        expect(advanced.rngState).not.toEqual(base.rngState);
        expect(chooseShot(advanced, 0), `after ${draws} draws`).toEqual(expected);
      }
    }
  }, 120_000);

  /**
   * A Durable Object hibernates between turns. The state that comes back is
   * whatever `serialize.ts` wrote, so anything the bot reads has to survive the
   * round trip — including which computer player is in the seat.
   */
  it('survives a hibernation round trip through JSON', () => {
    for (const personality of BOT_PERSONALITIES) {
      for (let seed = 0; seed < 4; seed += 1) {
        const before = duel(`hibernate-${seed}`, personality);
        const after = fromPersisted(
          JSON.parse(JSON.stringify(toPersisted(before))) as ReturnType<typeof toPersisted>,
        );
        expect((after.tanks[0] as Tank).bot).toBe(personality);
        expect(chooseShot(after, 0)).toEqual(chooseShot(before, 0));
      }
    }
  }, 120_000);

  /**
   * Anti-degeneracy. Everything above would also pass for a bot that returned
   * the same constant forever, so: the same personality on the same map decides
   * differently in a different seat and on a different turn.
   */
  it('is not simply constant across seats and turns', () => {
    for (const personality of BOT_PERSONALITIES) {
      const base = createGame({ seed: 'variety', width: WIDTH, height: HEIGHT }, seats(4));
      const decisions = new Set<string>();
      for (let seat = 0; seat < 4; seat += 1) {
        for (const turnNumber of [1, 2, 3, 4, 5]) {
          const state: GameState = { ...base, turnNumber, activeTank: seat };
          const d = chooseShot(state, seat, undefined, personality);
          decisions.add(`${d.angleDeg}|${d.power}`);
        }
      }
      // 20 samples. A bot that ignored the seat would produce 5, one that
      // ignored the turn would produce 4, and a constant would produce 1.
      expect(decisions.size, personality).toBeGreaterThan(15);
    }
  }, 120_000);

  it('does not depend on the room RNG even at a later turn of a real match', () => {
    // Same property as above but reached by playing rather than by editing the
    // state: two matches that diverge only in how much RNG has been consumed
    // (a detonation's scatter) must still hand the bot the same aim.
    let played = duel('played', 'cyborg');
    for (let turn = 0; turn < 3 && played.phase === 'aiming'; turn += 1) {
      const shooter = played.tanks[played.activeTank] as Tank;
      played = fire(played, shooter.id, {
        turnNumber: played.turnNumber,
        angleDeg: 55,
        power: 70,
        weapon: 'baby_missile',
      }).state;
    }
    expect(played.phase).toBe('aiming');

    const churned = restoreRng(played.rngState);
    for (let i = 0; i < 500; i += 1) churned.nextU32();
    expect(chooseShot({ ...played, rngState: churned.save() }, played.activeTank)).toEqual(
      chooseShot(played, played.activeTank),
    );
  });
});

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

/**
 * Build a game and then rough it up: random health, money, inventory, wind and
 * turn number, and a random subset of the tanks knocked out.
 *
 * Everything here stays inside what the server could really hold — `fire()` is
 * the judge below, and handing it a state it would reject for its own reasons
 * would test nothing.
 */
function batteredState(
  seed: number,
  count: number,
  personality: BotPersonality,
  wind: number,
  arm: boolean,
  corpses: number,
): GameState {
  const base = generatedGame(seed, count);
  const tanks = base.tanks.map((tank, index) => ({
    ...tank,
    bot: index === 0 ? personality : null,
    health: index === 0 ? 100 : 1 + ((seed * 7 + index * 13) % 100),
    money: (seed * 977) % 60000,
    // Half the sweep owns nothing but the free weapon, which is the state a
    // bot spends round one in and the one where a naive "fire the best thing I
    // own" would reach for something that is not there.
    inventory: arm
      ? Object.fromEntries(
          WEAPONS.filter((_, slot) => (slot + seed) % 3 === 0).map((weapon) => [
            weapon.id,
            1 + ((seed + weaponSalt(weapon.id)) % 4),
          ]),
        )
      : {},
    alive: index === 0 || index > corpses,
  }));
  return {
    ...base,
    wind,
    turnNumber: 1 + (seed % 40),
    activeTank: 0,
    tanks,
  };
}

/**
 * Generated maps are memoised by (seed, player count).
 *
 * Only for speed, and it changes nothing about what is generated: `createGame`
 * is a pure function of exactly those two inputs here, and the state is never
 * mutated — `batteredState` spreads a fresh object out of it. fast-check
 * revisits seeds while it shrinks, and at roughly 10 ms of terrain generation
 * per call the cache is the difference between this file taking two seconds and
 * taking ten, which matters: the whole suite runs in parallel and a file that
 * hogs a core makes somebody else's five-second timeout flaky.
 */
const GENERATED = new Map<string, GameState>();
function generatedGame(seed: number, count: number): GameState {
  const key = `${seed}:${count}`;
  let game = GENERATED.get(key);
  if (game === undefined) {
    game = createGame({ seed: `battered-${seed}`, width: WIDTH, height: HEIGHT }, seats(count));
    GENERATED.set(key, game);
  }
  return game;
}

/** Stable per-weapon offset so the generated inventories are not all identical. */
function weaponSalt(weaponId: string): number {
  let hash = 0;
  for (let k = 0; k < weaponId.length; k += 1) hash = (hash * 31 + weaponId.charCodeAt(k)) | 0;
  return Math.abs(hash);
}

describe('property: a bot never produces an illegal move', () => {
  /**
   * The judge is `fire()` itself.
   *
   * Re-asserting "0 <= angle <= 180" here would restate the bound `fire()`
   * already owns, and would keep passing if that bound moved. Handing the
   * decision to the real validator asserts the thing that actually matters —
   * the server accepts what its own bot just said — and it picks up the checks
   * a hand-written assertion would forget, like firing a weapon whose last
   * round was spent two turns ago.
   */
  it('produces a move the real fire() accepts, over generated states', () => {
    let fired = 0;
    let freeWeaponOnly = 0;

    fc.assert(
      fc.property(
        fc.record({
          seed: fc.nat({ max: 400 }),
          count: fc.integer({ min: 2, max: 6 }),
          personality: fc.constantFrom(...BOT_PERSONALITIES),
          wind: fc.double({ min: -10, max: 10, noNaN: true }),
          arm: fc.boolean(),
          corpses: fc.nat({ max: 3 }),
        }),
        (spec) => {
          const state = batteredState(
            spec.seed,
            spec.count,
            spec.personality,
            spec.wind,
            spec.arm,
            spec.corpses,
          );
          const decision = chooseShot(state, 0);
          const tank = state.tanks[0] as Tank;
          if (Object.keys(tank.inventory).length === 0) freeWeaponOnly += 1;

          // Something it owns. `fire()` checks this too, but stating it
          // separately is what tells you WHICH rule broke when it breaks.
          expect(getWeapon(decision.weapon)).toBeDefined();
          expect(ammoFor(tank, decision.weapon)).toBeGreaterThan(0);

          const result = fire(state, tank.id, {
            turnNumber: state.turnNumber,
            angleDeg: decision.angleDeg,
            power: decision.power,
            weapon: decision.weapon,
          });
          expect(result.events.length).toBeGreaterThan(0);
          fired += 1;
        },
      ),
      { numRuns: 150 },
    );

    // Floors, not fixtures — fast-check reseeds every run. Three runs while
    // this was written landed 65-80 of the 150 on an empty armoury.
    expect(fired).toBe(150);
    expect(freeWeaponOnly).toBeGreaterThan(30);
  }, 300_000);

  it('reaches for the free weapon when the armoury is empty, whoever it is', () => {
    for (const personality of BOT_PERSONALITIES) {
      const state = duel('empty-armoury', personality);
      expect(Object.keys((state.tanks[0] as Tank).inventory)).toEqual([]);
      expect(chooseShot(state, 0).weapon).toBe('baby_missile');
    }
  });

  it('never fires a weapon that does no damage to a tank', () => {
    // A Dirt Clod aimed at somebody is a gift. Stocked with nothing but the
    // harmless half of the arsenal, every personality must fall back to the
    // free Baby Missile rather than lob dirt at the enemy.
    const harmless = WEAPONS.filter((weapon) => weapon.damage === 0);
    expect(harmless.length).toBeGreaterThan(3);

    for (const personality of BOT_PERSONALITIES) {
      const base = duel('harmless-only', personality);
      const state: GameState = {
        ...base,
        tanks: base.tanks.map((tank) => ({
          ...tank,
          inventory: Object.fromEntries(harmless.map((weapon) => [weapon.id, 9])),
        })),
      };
      const chosen = getWeapon(chooseShot(state, 0).weapon);
      expect(chosen?.damage, personality).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

/** A perfectly flat plain at a given ground height. */
function plain(groundY: number): Terrain {
  const terrain = emptyTerrain(WIDTH, HEIGHT);
  terrain.surface.fill(groundY);
  return terrain;
}

/** A flat plain with a solid wall of full height sealing one tank in. */
function walledIn(groundY: number, from: number, to: number): Terrain {
  const terrain = plain(groundY);
  for (let x = from; x <= to; x += 1) terrain.surface[x] = 0;
  return terrain;
}

interface Scenario {
  name: string;
  state: GameState;
  shooter: number;
}

function scenarios(): Scenario[] {
  const base = createGame({ seed: 'hostile', width: WIDTH, height: HEIGHT }, seats(4));
  const put = (over: Partial<GameState>): GameState => ({ ...base, ...over });
  const tanksAt = (positions: { x: number; y: number; alive?: boolean }[]): Tank[] =>
    positions.map((p, index) => ({
      ...(base.tanks[index % base.tanks.length] as Tank),
      id: `h${index}`,
      x: p.x,
      y: p.y,
      alive: p.alive ?? true,
    }));

  const flat = plain(600);

  return [
    {
      name: 'last tank alive',
      state: put({
        tanks: base.tanks.map((tank, index) => ({ ...tank, alive: index === 0 })),
      }),
      shooter: 0,
    },
    {
      name: 'shooter is already dead',
      state: put({ tanks: base.tanks.map((tank, index) => ({ ...tank, alive: index !== 0 })) }),
      shooter: 0,
    },
    {
      name: 'flat plain',
      state: put({
        terrain: flat,
        tanks: tanksAt([
          { x: 200, y: 600 },
          { x: 1000, y: 600 },
        ]),
      }),
      shooter: 0,
    },
    {
      name: 'target buried under the surface',
      state: put({
        terrain: flat,
        tanks: tanksAt([
          { x: 200, y: 600 },
          { x: 1000, y: 715 },
        ]),
      }),
      shooter: 0,
    },
    {
      name: 'shooter buried under the surface',
      state: put({
        terrain: flat,
        tanks: tanksAt([
          { x: 200, y: 719 },
          { x: 1000, y: 600 },
        ]),
      }),
      shooter: 0,
    },
    {
      name: 'no line of fire at all — sealed behind a full-height wall',
      state: put({
        terrain: walledIn(600, 400, 460),
        tanks: tanksAt([
          { x: 200, y: 600 },
          { x: 1000, y: 600 },
        ]),
      }),
      shooter: 0,
    },
    {
      name: 'both tanks in the same column',
      state: put({
        terrain: flat,
        tanks: tanksAt([
          { x: 640, y: 600 },
          { x: 640, y: 600 },
        ]),
      }),
      shooter: 0,
    },
    {
      name: 'tanks jammed against the map edges',
      state: put({
        terrain: flat,
        tanks: tanksAt([
          { x: 0, y: 600 },
          { x: WIDTH - 1, y: 600 },
        ]),
      }),
      shooter: 0,
    },
    {
      name: 'target directly overhead',
      state: put({
        terrain: flat,
        tanks: tanksAt([
          { x: 640, y: 700 },
          { x: 641, y: 40 },
        ]),
      }),
      shooter: 0,
    },
    {
      name: 'wind pinned to the stops',
      state: put({ wind: -10 }),
      shooter: 0,
    },
    {
      name: 'sixteen tanks, everybody alive',
      state: createGame({ seed: 'crowd', width: WIDTH, height: HEIGHT }, seats(16)),
      shooter: 7,
    },
    {
      name: 'a doctored state carrying NaN coordinates',
      state: put({
        wind: Number.NaN,
        tanks: tanksAt([
          { x: Number.NaN, y: Number.NaN },
          { x: 900, y: 600 },
        ]),
      }),
      shooter: 0,
    },
    {
      name: 'a seat index nobody is sitting in',
      state: base,
      shooter: 99,
    },
  ];
}

describe('a bot never throws, whatever it is handed', () => {
  it.each(BOT_PERSONALITIES)('%s survives every hostile state', (personality) => {
    for (const scenario of scenarios()) {
      const report = chooseShotDetailed(scenario.state, scenario.shooter, undefined, personality);
      const decision = report.decision;

      expect(Number.isFinite(decision.angleDeg), scenario.name).toBe(true);
      expect(Number.isFinite(decision.power), scenario.name).toBe(true);
      expect(getWeapon(decision.weapon), scenario.name).toBeDefined();
      // The other three entry points share the same guards and are called by
      // the server independently of `chooseShot`.
      expect(() => chooseTarget(scenario.state, scenario.shooter)).not.toThrow();
      expect(() => chooseWeapon(scenario.state, scenario.shooter)).not.toThrow();
    }
  });

  it('holds the current aim when there is nobody left to shoot at', () => {
    const base = duel('alone', 'annihilator');
    const solo: GameState = {
      ...base,
      tanks: base.tanks.map((tank, index) => ({
        ...tank,
        alive: index === 0,
        angleDeg: 37.5,
        power: 63.25,
      })),
    };
    const report = chooseShotDetailed(solo, 0);
    expect(report.targetIndex).toBeNull();
    // Not a reset to some default: the gun stays where the player left it, and
    // the search does not run at all.
    expect(report.decision.angleDeg).toBe(37.5);
    expect(report.decision.power).toBe(63.25);
    expect(report.flights).toBe(0);
  });

  it('refuses to be handed a shot for a seat that does not exist', () => {
    // `chooseShot` degrades; `predictShot` — the low-level primitive it is
    // built on — must not, or a bug in a caller becomes a silent wrong answer.
    const state = duel('no-such-seat', 'cyborg');
    expect(() => chooseShot(state, 42)).not.toThrow();
    expect(chooseShotDetailed(state, 42).targetIndex).toBeNull();
    expect(() =>
      fire(state, 'nobody', {
        turnNumber: state.turnNumber,
        angleDeg: 45,
        power: 50,
        weapon: 'baby_missile',
      }),
    ).toThrow(IllegalMoveError);
  });
});

// ---------------------------------------------------------------------------
// Seating
// ---------------------------------------------------------------------------

describe('seating and identifying a computer player', () => {
  it('remembers which seats are bots and which are people', () => {
    const state = createGame(
      { seed: 'mixed', width: WIDTH, height: HEIGHT },
      seats(4, { 1: 'moron', 3: 'annihilator' }),
    );
    expect(state.tanks.map((tank) => tank.bot)).toEqual([null, 'moron', null, 'annihilator']);
  });

  it('makes two rooms that differ only in their bots hash differently', () => {
    // The state hash is what the golden replay and the illegal-move tests use
    // to prove nothing changed. Two rooms whose seats hold different computer
    // players will play different next moves, so the hash has to see it.
    const human = createGame({ seed: 'hash', width: WIDTH, height: HEIGHT }, seats(2));
    const moron = createGame(
      { seed: 'hash', width: WIDTH, height: HEIGHT },
      seats(2, { 0: 'moron' }),
    );
    const cyborg = createGame(
      { seed: 'hash', width: WIDTH, height: HEIGHT },
      seats(2, { 0: 'cyborg' }),
    );

    expect(hashGameState(moron)).not.toBe(hashGameState(human));
    expect(hashGameState(cyborg)).not.toBe(hashGameState(moron));
    // And an all-human room hashes exactly as it did before bots existed, which
    // is why the golden snapshot did not have to be regenerated for this.
    expect(hashGameState(human)).toBe(hashGameState(createGame({ seed: 'hash' }, seats(2))));
  });

  it('carries the seat through persistence, including from rows written without it', () => {
    const state = createGame(
      { seed: 'persist', width: WIDTH, height: HEIGHT },
      seats(3, { 1: 'poolshark' }),
    );
    const persisted = JSON.parse(JSON.stringify(toPersisted(state))) as ReturnType<
      typeof toPersisted
    >;
    expect(fromPersisted(persisted).tanks.map((tank) => tank.bot)).toEqual([
      null,
      'poolshark',
      null,
    ]);

    // A row written before the field existed has no `bot` key at all. It must
    // come back as a human, not as `undefined`.
    const legacy = JSON.parse(JSON.stringify(persisted)) as ReturnType<typeof toPersisted>;
    for (const tank of legacy.tanks) delete (tank as Partial<{ bot: unknown }>).bot;
    for (const tank of fromPersisted(legacy).tanks) expect(tank.bot).toBeNull();
  });

  it('keeps the personality out of the snapshot that goes down the wire', () => {
    // `GameSnapshot` is promised to stay structurally identical to the
    // protocol's Zod schema, which strips what it does not know. A `bot` field
    // added there would not reach a client, it would silently vanish — so it
    // belongs in the persistence form and only there, and this is the test that
    // notices if somebody moves it.
    const state = createGame(
      { seed: 'wire', width: WIDTH, height: HEIGHT },
      seats(2, { 0: 'cyborg' }),
    );
    const persisted = toPersisted(state);
    const wire = toSnapshot(state);

    expect(persisted.tanks[0]?.bot).toBe('cyborg');
    for (const tank of wire.tanks) expect(Object.keys(tank)).not.toContain('bot');
    // Nothing else differs: the persistence form is the wire form plus `bot`.
    expect(Object.keys(persisted.tanks[0] as object).filter((key) => key !== 'bot')).toEqual(
      Object.keys(wire.tanks[0] as object),
    );
  });

  it('recognises exactly the personalities it ships', () => {
    for (const personality of BOT_PERSONALITIES) expect(isBotPersonality(personality)).toBe(true);
    expect(isBotPersonality('grandmaster')).toBe(false);
    expect(isBotPersonality('')).toBe(false);
  });
});
