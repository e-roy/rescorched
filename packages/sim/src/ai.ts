/**
 * Computer players.
 *
 * The original let one person sit down and fill the rest of the lobby with
 * machines of escalating competence, and the difference between a Moron and an
 * Annihilator was legible from watching a single turn. That is what this file
 * reproduces.
 *
 * ## The constraint everything here is shaped by
 *
 * A bot's decision is a PURE FUNCTION of the game state. No clock, no
 * `Math.random`, nothing the sim cannot see. Every client replays the
 * authoritative event stream to render; if a bot's aim were computed anywhere
 * non-deterministic, two clients would replay different shots and disagree
 * about who died.
 *
 * That is stronger than "seeded". A bot must also be independent of HOW FAR
 * ALONG the room's RNG happens to be, because that depends on how many
 * detonations have scattered sub-munitions since the match began — and because
 * drawing from the room stream would make *deciding* a state mutation, so a
 * decision that was then discarded (an illegal move, a disconnect, a retry
 * after a Durable Object woke up) would leave the room's wind and cluster
 * scatter permanently shifted. So the bot draws from a stream of its own,
 * derived from `(seed, round, turnNumber, tankIndex, personality)` — the same
 * technique `turnOrder()` in `game.ts` uses, and for the same reason: those are
 * all persisted, so the decision survives hibernation unchanged.
 *
 * `chooseShot` therefore never touches the `Rng` it is handed unless you hand
 * it one deliberately. See `botStream`.
 *
 * ## Where POOLSHARK's memory lives
 *
 * Read the "Nothing new gets stored" warning at the top of `game.ts` first.
 * Bracketing needs to know where the last shot went, and the temptation is to
 * add a `lastMiss` field. It is not needed: `fire()` writes the aim it resolved
 * back onto the tank (`shooter.angleDeg`, `shooter.power`), `serialize.ts`
 * already persists both, and `simulateFlight` will tell you exactly where that
 * aim lands. So POOLSHARK re-derives its own last shot instead of remembering
 * it, and nothing new is stored anywhere.
 *
 * Be honest about what the reconstruction is and is not. It re-flies the old
 * aim through the CURRENT terrain and the CURRENT wind, so it is a shade better
 * informed than a human's memory about the wind and a shade worse about the
 * hole that got blown in the hillside since. What makes it take several turns
 * to walk in is not ignorance, it is `BRACKET_GAIN` — see there.
 *
 * ## Cost
 *
 * This runs inside a Durable Object on somebody's turn, so the search is
 * bounded by `SEARCH.maxFlights` and the bound is enforced by a counter rather
 * than by arithmetic on the ladder lengths. `test/ai-performance.test.ts`
 * measures the worst case in milliseconds and in flights.
 */

import { clamp, detCosDeg, detSinDeg, hypot2 } from './math.ts';
import { ammoFor, DEFAULT_WORLD, predictShot, type GameState, type Tank } from './game.ts';
import { buy, isOnTheShelf, isShopOpen, roundsFought } from './economy.ts';
import { PHYSICS, type Trajectory } from './physics.ts';
import { makeRng, type Rng } from './rng.ts';
import {
  BABY_MISSILE,
  getWeapon,
  pricePerShot,
  WEAPONS,
  type WeaponDef,
  type WeaponId,
} from './weapons.ts';

// ---------------------------------------------------------------------------
// Who the computer players are
// ---------------------------------------------------------------------------

/**
 * The roster, weakest first. Names kept from the original where they fit.
 *
 * The order is the difficulty order and `test/ai-personalities.test.ts` asserts
 * it holds as a measured hit rate rather than as a comment — with the two
 * deliberate exceptions called out there: TOSSER trades range for loft and
 * POOLSHARK's whole point is that it improves over turns rather than nailing
 * the first one, so neither belongs in a single-shot ranking.
 */
export const BOT_PERSONALITIES = [
  'moron',
  'shooter',
  'tosser',
  'poolshark',
  'cyborg',
  'annihilator',
] as const;

export type BotPersonality = (typeof BOT_PERSONALITIES)[number];

/** How the roster is spelled in the lobby and on the HUD. */
export const BOT_DISPLAY_NAMES: Readonly<Record<BotPersonality, string>> = {
  moron: 'Moron',
  shooter: 'Shooter',
  tosser: 'Tosser',
  poolshark: 'Poolshark',
  cyborg: 'Cyborg',
  annihilator: 'Annihilator',
};

export function isBotPersonality(value: string): value is BotPersonality {
  return (BOT_PERSONALITIES as readonly string[]).includes(value);
}

/** What a bot hands back. Exactly the fields `FireInput` needs. */
export interface BotDecision {
  angleDeg: number;
  power: number;
  weapon: WeaponId;
}

/** `chooseShot` plus the workings, for tests and for a future debug overlay. */
export interface BotDecisionReport {
  decision: BotDecision;
  /** `simulateFlight` calls the search actually spent. Bounded by `SEARCH.maxFlights`. */
  flights: number;
  /** Index of the tank it was shooting at, or null if nothing was left to shoot. */
  targetIndex: number | null;
  personality: BotPersonality;
}

// ---------------------------------------------------------------------------
// Personality profiles
// ---------------------------------------------------------------------------

/** How the aim is arrived at. The three are genuinely different algorithms. */
type AimStyle =
  /** Draw an angle and a power out of the air. Barely aims. */
  | 'wild'
  /** Search angle/power pairs with `simulateFlight` and keep the best. */
  | 'solve'
  /** Re-fly last turn's aim, measure the miss, walk the correction in. */
  | 'bracket';

interface BotProfile {
  readonly aim: AimStyle;
  /**
   * Elevation band the aim may use, in degrees above horizontal. Mirrored onto
   * the target's side of the tank, so 70 becomes 110 when firing left.
   */
  readonly elevationLo: number;
  readonly elevationHi: number;
  /**
   * Whether the trajectory model this bot aims with includes the wind.
   *
   * `false` does not mean "no wind in the game" — the shot still flies through
   * the real wind when the server resolves it. It means the bot solved the
   * wrong problem and will be pushed off target by exactly the amount it
   * ignored, which is what makes SHOOTER beatable in a gale and dangerous on a
   * calm day.
   */
  readonly readsWind: boolean;
  /** Deliberate error added to the solved aim, uniform in +/- this many degrees. */
  readonly angleError: number;
  /** Deliberate error added to the solved power, uniform in +/- this much. */
  readonly powerError: number;
  /** Whether the score penalises landing inside your own blast radius. */
  readonly avoidsSelfHarm: boolean;
  /** Target selection: the one most likely to die, rather than the nearest. */
  readonly picksTheKill: boolean;
  /**
   * Highest weapon tier this bot will pull the trigger on. A bot that owns a
   * Nuke and a tier cap of 1 is holding it for a rainy day it never has.
   */
  readonly weaponTierCap: number;
  /** Whether it declines to spend a Nuke on a target a Missile would finish. */
  readonly economical: boolean;
  /** Shopping preference, best first. Falls through what it cannot afford. */
  readonly shopping: readonly WeaponId[];
  /** Share of the wallet it is willing to commit at one visit to the shop. */
  readonly spendFraction: number;
}

/**
 * The six, and every number that makes them different.
 *
 * The spread has to be real and it has to be measurable, so the knobs are all
 * things that show up in a distribution: how wide the aim is scattered
 * (`angleError`/`powerError`), whether the model is right at all (`readsWind`),
 * what part of the sky the shot may use (`elevationLo`/`Hi`), and what the bot
 * is allowed to spend and fire. `test/ai-personalities.test.ts` measures hit
 * rate and mean miss over real generated terrain and asserts the ORDERING.
 */
const PROFILES: Readonly<Record<BotPersonality, BotProfile>> = {
  /**
   * Barely aims. The comic relief, and the difficulty a new player beats.
   *
   * It does face the right way — a bot that fires off the side of the map every
   * other turn is not funny, it is broken — and that is the whole of its
   * aiming. The power band starts below the point at which a shell can fall
   * back on its own tank (`PHYSICS.armFactor`'s note puts that at power 12), so
   * a Moron blows itself up from time to time. That is deliberate.
   */
  moron: {
    aim: 'wild',
    elevationLo: 12,
    elevationHi: 88,
    readsWind: false,
    angleError: 0,
    powerError: 0,
    avoidsSelfHarm: false,
    picksTheKill: false,
    weaponTierCap: 0,
    economical: false,
    shopping: ['dirt_clod'],
    spendFraction: 0.35,
  },

  /**
   * Plausible angles, ignores wind entirely, does not learn.
   *
   * The archetype of the player who has understood the gun but not the weather.
   * Its solver is the same solver the Cyborg uses, run against a state whose
   * wind has been zeroed — so its shots are systematically pushed downwind by
   * an amount that grows with the loft, exactly as `PHYSICS.windAuthority`
   * describes. Nothing carries between its turns.
   */
  shooter: {
    aim: 'solve',
    elevationLo: 18,
    elevationHi: 80,
    readsWind: false,
    angleError: 2.5,
    powerError: 4,
    avoidsSelfHarm: false,
    picksTheKill: false,
    weaponTierCap: 1,
    economical: false,
    shopping: ['missile'],
    spendFraction: 0.6,
  },

  /**
   * Always lobs. Predictable, and genuinely dangerous over a ridge.
   *
   * The band is the personality. Its low end is set by reach rather than by
   * taste: at power 100 a shot's flat-ground range is `v^2 sin(2e) / g`, which
   * at e = 58 degrees is 934 px and at e = 70 is 669 px — so a band starting
   * much above 58 could not cross a 1280 px map at all and the Tosser would
   * spend the round shelling the valley in front of it. The high end is where
   * the arc is steep enough to drop behind a ridge the Shooter has to shoot
   * through.
   */
  tosser: {
    aim: 'solve',
    elevationLo: 58,
    elevationHi: 84,
    readsWind: true,
    angleError: 2,
    powerError: 3,
    avoidsSelfHarm: false,
    picksTheKill: false,
    weaponTierCap: 2,
    economical: false,
    shopping: ['baby_roller', 'roller', 'leapfrog'],
    spendFraction: 0.6,
  },

  /**
   * Brackets. Walks its aim in over successive turns. Feels like a person.
   *
   * It never searches. It re-flies the aim it fired last turn, sees how far
   * short or long that lands, and moves a FRACTION of the way to the
   * correction — see `BRACKET_GAIN`. That is why it opens badly and closes
   * well, and why `test/ai-poolshark.test.ts` measures convergence rather than
   * a hit rate.
   */
  poolshark: {
    aim: 'bracket',
    elevationLo: 22,
    elevationHi: 78,
    readsWind: true,
    angleError: 0.4,
    powerError: 1,
    avoidsSelfHarm: false,
    picksTheKill: false,
    weaponTierCap: 2,
    economical: false,
    shopping: ['missile', 'baby_nuke'],
    spendFraction: 0.7,
  },

  /**
   * Solves the trajectory properly, wind and all, with a small deliberate error.
   *
   * The error is the only thing standing between it and a machine that never
   * misses, and it is a scatter rather than a bias so it cannot be read and
   * played around. A degree and a bit of angle is roughly a blast radius at
   * duelling distance, which is the size that makes a Cyborg beatable without
   * making it stupid.
   */
  cyborg: {
    aim: 'solve',
    elevationLo: 15,
    elevationHi: 85,
    readsWind: true,
    angleError: 1.2,
    powerError: 1.5,
    avoidsSelfHarm: true,
    picksTheKill: false,
    weaponTierCap: 3,
    economical: false,
    shopping: ['baby_nuke', 'missile'],
    spendFraction: 0.7,
  },

  /**
   * Solves it properly AND spends its money well. Near-perfect.
   *
   * Same solver as the Cyborg with a third of the scatter, plus the three
   * things that make the difference a player feels: it shoots at whoever it can
   * finish rather than whoever is closest, it does not spend a Nuke on a tank a
   * Missile would kill, and it walks out of the shop having spent almost
   * everything on the largest thing on the shelf.
   */
  annihilator: {
    aim: 'solve',
    elevationLo: 15,
    elevationHi: 85,
    readsWind: true,
    angleError: 0.3,
    powerError: 0.4,
    avoidsSelfHarm: true,
    picksTheKill: true,
    weaponTierCap: 4,
    economical: true,
    shopping: ['deaths_head', 'nuke', 'baby_nuke', 'missile'],
    spendFraction: 0.95,
  },
};

export function botProfileExists(personality: BotPersonality): boolean {
  return PROFILES[personality] !== undefined;
}

// ---------------------------------------------------------------------------
// Search tuning
// ---------------------------------------------------------------------------

/**
 * Lowest power a solving bot will fire.
 *
 * Below 12 a flat shot can fall back across its own hit circle and detonate on
 * the shooter — measured, and written up on `PHYSICS.armFactor`. A bot that is
 * trying to hit somebody else should not be able to arrive at that by accident;
 * the Moron is exempt because for the Moron it is the joke.
 */
const MIN_SOLVED_POWER = 14;

/** Power band the Moron draws from. Deliberately reaches under `MIN_SOLVED_POWER`. */
const MORON_POWER = { lo: 8, hi: 100 } as const;

/**
 * The search.
 *
 * Shape: a coarse ladder of elevations across the personality's band, each one
 * refined in power by Newton's method against the real `simulateFlight`; then
 * the best elevation is revisited with its neighbours. Every probe is a
 * candidate answer — the best SCORE seen anywhere is what gets fired, not the
 * last iterate — so a ladder rung that lands a direct hit on the way past is
 * never thrown away in favour of an arithmetic fixed point.
 *
 * `maxFlights` is enforced by a counter, checked before each rung. That matters
 * more than it sounds: it means widening a personality's elevation band, or
 * adding a rung, cannot silently make a turn take longer. The worst case
 * measured over the sweep in `test/ai-performance.test.ts` is quoted there.
 */
const SEARCH = {
  /** Degrees between rungs of the coarse ladder. */
  coarseStep: 10,
  /** Newton corrections per coarse rung. */
  coarseProbes: 4,
  /** Elevation offsets revisited around the coarse winner, in degrees. */
  refineOffsets: [-6, -3, 3, 6] as readonly number[],
  /** Newton corrections per refinement rung, seeded from the winner's power. */
  refineProbes: 3,
  /**
   * Hard ceiling on `simulateFlight` calls per decision.
   *
   * A backstop, not the working bound. The widest ladder any personality has
   * today is eight rungs, so the search costs at most 8*4 + 4*3 = 44 flights
   * and the ceiling never fires — `test/ai-performance.test.ts` measures the
   * real worst case and asserts it as a number, which is the assertion that
   * would notice a band being widened. This exists so that widening one far
   * enough cannot turn a turn into a freeze while nobody is looking.
   */
  maxFlights: 64,
} as const;

/**
 * Fraction of the measured correction a bracketing bot actually applies.
 *
 * This is the whole of POOLSHARK's character. At 1.0 it would re-fly its old
 * aim, compute the exact power that fixes the miss, and fire it — converging in
 * a single turn and being indistinguishable from a Cyborg that happens to
 * probe once. At 0.55 the miss decays by about 45% a turn, so a 300 px opening
 * error is roughly 135, 60, 27, 12 over the next four turns: a player watching
 * can see it closing in, and has those turns to move or to kill it.
 */
const BRACKET_GAIN = 0.55;

/**
 * Degrees the bracket shifts its elevation by when power alone cannot reach.
 *
 * A bracket that only ever adjusts power gets stuck the moment the correction
 * saturates: pinned at 100 and still short, every subsequent turn recomputes
 * the same impossible answer. Flattening the arc when it is short and steepening
 * it when it is long is what a person does with the same problem.
 */
const BRACKET_ELEVATION_STEP = 5;

/**
 * What a shot that leaves the world is worth, in pixels of miss.
 *
 * A shell that sails off the left edge stops being simulated at the margin, and
 * the impact point it reports can happen to sit near the target's row. Without
 * a penalty the search would occasionally prefer that to a real near miss.
 */
const OFF_MAP_PENALTY = 400;

/**
 * How hard a self-harm-avoiding bot weighs its own skin against the target's.
 *
 * Expressed as pixels of extra apparent miss per pixel of overlap between the
 * blast and the shooter, so at 3 the bot will give up three pixels of accuracy
 * to keep one pixel further out of its own crater. Not infinite: a shot that
 * kills the last opponent is worth taking damage for, and the score still
 * prefers a direct hit that clips the shooter to a clean miss that does nothing.
 */
const SELF_HARM_WEIGHT = 3;

/** Most packs of any one weapon a bot buys in a single visit to the shop. */
const MAX_PACKS_PER_ITEM = 4;

// ---------------------------------------------------------------------------
// The bot's own random stream
// ---------------------------------------------------------------------------

/**
 * A stream that belongs to this decision and to nothing else.
 *
 * Derived from persisted state only — seed, round, turn number, seat and
 * personality — so it is the same stream before and after a Durable Object
 * hibernates, the same stream on the server and on every client replaying the
 * match, and completely unaffected by how many numbers the room's RNG has
 * produced. It is also never the room's RNG, so a decision costs the room
 * nothing: deciding is not a state mutation.
 */
export function botStream(
  state: Pick<GameState, 'seed' | 'round' | 'turnNumber'>,
  tankIndex: number,
  personality: BotPersonality,
): Rng {
  return makeRng(
    `bot:${personality}:${state.seed >>> 0}:${state.round}:${state.turnNumber}:${tankIndex}`,
  );
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

/**
 * Who to shoot at, or null if nothing is left.
 *
 * Nearest living opponent by default. `picksTheKill` swaps the first key for
 * health, because a finished tank pays a 5000 bounty and a wounded one that
 * gets a turn back does not. Both chains end on the tank index, which is unique
 * by construction, so the choice is the same on every machine — a tie broken by
 * array order would be a tie broken by lobby join order.
 */
export function chooseTarget(state: GameState, tankIndex: number): number | null {
  const shooter = state.tanks[tankIndex];
  if (shooter === undefined) return null;
  const profile = PROFILES[shooter.bot ?? 'shooter'];

  let bestIndex: number | null = null;
  let bestDistance = Infinity;
  let bestHealth = Infinity;

  for (let index = 0; index < state.tanks.length; index += 1) {
    if (index === tankIndex) continue;
    const other = state.tanks[index] as Tank;
    if (!other.alive) continue;
    const distance = Math.abs(other.x - shooter.x);
    const better =
      bestIndex === null ||
      (profile.picksTheKill
        ? other.health < bestHealth || (other.health === bestHealth && distance < bestDistance)
        : distance < bestDistance || (distance === bestDistance && other.health < bestHealth));
    if (better) {
      bestIndex = index;
      bestDistance = distance;
      bestHealth = other.health;
    }
  }
  return bestIndex;
}

// ---------------------------------------------------------------------------
// Weapon selection
// ---------------------------------------------------------------------------

/**
 * The gun this bot pulls the trigger on.
 *
 * Only weapons that actually damage a tank are considered — a Dirt Clod fired
 * at somebody is a gift, not an attack — and only up to the personality's tier
 * cap. `economical` then takes the CHEAPEST round that still kills outright
 * rather than the biggest, which is the in-play half of "spends its money
 * well": the other half is `choosePurchases`.
 *
 * Always returns something the tank can legally fire. Baby Missile is free and
 * unlimited, so there is always an answer.
 */
export function chooseWeapon(state: GameState, tankIndex: number): WeaponId {
  const tank = state.tanks[tankIndex];
  if (tank === undefined) return BABY_MISSILE;
  const profile = PROFILES[tank.bot ?? 'shooter'];
  const targetIndex = chooseTarget(state, tankIndex);
  const targetHealth =
    targetIndex === null ? DEFAULT_WORLD.maxHealth : (state.tanks[targetIndex] as Tank).health;
  return pickWeapon(tank, profile, targetHealth);
}

function pickWeapon(tank: Tank, profile: BotProfile, targetHealth: number): WeaponId {
  const owned = WEAPONS.filter(
    (weapon) =>
      weapon.damage > 0 && weapon.tier <= profile.weaponTierCap && ammoFor(tank, weapon.id) > 0,
  );
  if (owned.length === 0) return BABY_MISSILE;

  if (profile.economical) {
    const enough = owned.filter((weapon) => weapon.damage >= targetHealth);
    if (enough.length > 0) return cheapest(enough).id;
  }
  return heaviest(owned).id;
}

/** Cheapest per round, then smallest, then by id. Deterministic on every engine. */
function cheapest(weapons: readonly WeaponDef[]): WeaponDef {
  return [...weapons].sort(
    (a, b) => pricePerShot(a) - pricePerShot(b) || a.damage - b.damage || compareIds(a, b),
  )[0] as WeaponDef;
}

/** Hardest hitting, then cheapest, then by id. */
function heaviest(weapons: readonly WeaponDef[]): WeaponDef {
  return [...weapons].sort(
    (a, b) => b.damage - a.damage || pricePerShot(a) - pricePerShot(b) || compareIds(a, b),
  )[0] as WeaponDef;
}

function compareIds(a: WeaponDef, b: WeaponDef): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * What this bot fires this turn.
 *
 * Pure. Same state in, byte-identical decision out, on every engine and however
 * many times you ask.
 *
 * `rng` is an OVERRIDE, and the default is the point: left out, the bot uses
 * `botStream()`, which is derived from persisted state and is therefore immune
 * to where the room's RNG has got to. Pass one only when you deliberately want
 * to sample a personality's distribution from a fixed state, which is what the
 * personality tests do. Passing the room's live RNG would reintroduce exactly
 * the dependency this file exists to avoid.
 *
 * `personality` is the second override, for the same kind of measurement: it
 * runs a different brain from the same seat without rebuilding the state. In
 * production it is left out and the seat's own `tank.bot` decides.
 *
 * There is deliberately no `memory` parameter — see the file header.
 */
export function chooseShot(
  state: GameState,
  tankIndex: number,
  rng?: Rng,
  personality?: BotPersonality,
): BotDecision {
  return decide(state, tankIndex, rng, personality).decision;
}

/** `chooseShot` with the search's workings attached. */
export function chooseShotDetailed(
  state: GameState,
  tankIndex: number,
  rng?: Rng,
  personality?: BotPersonality,
): BotDecisionReport {
  return decide(state, tankIndex, rng, personality);
}

function decide(
  state: GameState,
  tankIndex: number,
  suppliedRng: Rng | undefined,
  suppliedPersonality: BotPersonality | undefined,
): BotDecisionReport {
  const tank = state.tanks[tankIndex];
  const personality: BotPersonality =
    suppliedPersonality ?? (tank?.bot != null ? tank.bot : 'shooter');
  const profile = PROFILES[personality];

  // Nothing that follows may throw for any state the server can legally hand
  // us, so the two things that could be missing are answered first.
  if (tank === undefined) {
    return {
      decision: { angleDeg: 45, power: 50, weapon: BABY_MISSILE },
      flights: 0,
      targetIndex: null,
      personality,
    };
  }

  const targetIndex = chooseTarget(state, tankIndex);
  const weapon = getWeapon(pickWeapon(tank, profile, targetHealthOf(state, targetIndex)));
  const weaponId = weapon?.id ?? BABY_MISSILE;

  // Last tank standing, or everybody else already dead: hold the current aim.
  // The round is over; there is nothing to solve and no reason to move the gun.
  if (targetIndex === null) {
    return {
      decision: legalize({ angleDeg: tank.angleDeg, power: tank.power, weapon: weaponId }, tank),
      flights: 0,
      targetIndex: null,
      personality,
    };
  }

  const rng = suppliedRng ?? botStream(state, tankIndex, personality);
  const solver = makeSolver(state, tankIndex, targetIndex, weapon ?? requireBabyMissile(), profile);

  let aim: { angleDeg: number; power: number };
  switch (profile.aim) {
    case 'wild':
      aim = wildAim(solver, profile, rng);
      break;
    case 'bracket':
      aim = bracketAim(solver, tank, profile, rng);
      break;
    default:
      aim = blur(solveAim(solver, profile), profile, rng);
      break;
  }

  return {
    decision: legalize({ ...aim, weapon: weaponId }, tank),
    flights: solver.flights,
    targetIndex,
    personality,
  };
}

function targetHealthOf(state: GameState, targetIndex: number | null): number {
  return targetIndex === null ? DEFAULT_WORLD.maxHealth : (state.tanks[targetIndex] as Tank).health;
}

function requireBabyMissile(): WeaponDef {
  // The free weapon is a fixture of the table; this is the type system's
  // problem rather than a real one.
  return getWeapon(BABY_MISSILE) as WeaponDef;
}

/**
 * The last gate before the wire. Whatever the search did, what comes out is a
 * move `fire()` will accept: a finite angle in [0, 180], a finite power in
 * [0, 100], and a weapon this tank actually owns.
 */
function legalize(decision: BotDecision, tank: Tank): BotDecision {
  const angleDeg = Number.isFinite(decision.angleDeg) ? clamp(decision.angleDeg, 0, 180) : 45;
  const power = Number.isFinite(decision.power) ? clamp(decision.power, 0, 100) : 50;
  const known = getWeapon(decision.weapon);
  const weapon = known !== undefined && ammoFor(tank, known.id) > 0 ? known.id : BABY_MISSILE;
  return { angleDeg, power, weapon };
}

// ---------------------------------------------------------------------------
// The solver
// ---------------------------------------------------------------------------

interface Solver {
  /**
   * The state the bot AIMS with — a shallow copy of the real one whose wind has
   * been zeroed for a personality that does not read it. The terrain and the
   * tanks are shared by reference, so building it costs nothing.
   */
  readonly model: GameState;
  readonly shooterIndex: number;
  readonly targetIndex: number;
  readonly targetX: number;
  readonly targetY: number;
  readonly muzzleX: number;
  readonly muzzleY: number;
  /** +1 when the target is to the right. */
  readonly dir: 1 | -1;
  /** Horizontal distance from muzzle to target. */
  readonly range: number;
  /** How far the target sits ABOVE the muzzle. Negative when it is below. */
  readonly rise: number;
  readonly weapon: WeaponDef;
  readonly avoidsSelfHarm: boolean;
  flights: number;
}

function makeSolver(
  state: GameState,
  shooterIndex: number,
  targetIndex: number,
  weapon: WeaponDef,
  profile: BotProfile,
): Solver {
  const shooter = state.tanks[shooterIndex] as Tank;
  const target = state.tanks[targetIndex] as Tank;
  const muzzleX = shooter.x;
  const muzzleY = shooter.y - DEFAULT_WORLD.tankRadius - 2;
  // Aim at the centre of the hit circle `game.ts` will actually test against,
  // not at the tank's ground contact point.
  const targetX = target.x;
  const targetY = target.y - DEFAULT_WORLD.tankRadius / 2;

  return {
    model: profile.readsWind ? state : { ...state, wind: 0 },
    shooterIndex,
    targetIndex,
    targetX,
    targetY,
    muzzleX,
    muzzleY,
    dir: targetX >= muzzleX ? 1 : -1,
    range: Math.abs(targetX - muzzleX),
    rise: muzzleY - targetY,
    weapon,
    avoidsSelfHarm: profile.avoidsSelfHarm,
    flights: 0,
  };
}

function fly(solver: Solver, angleDeg: number, power: number): Trajectory {
  solver.flights += 1;
  return predictShot(solver.model, solver.shooterIndex, angleDeg, power);
}

/**
 * How bad a shot is, in pixels. Zero is a direct hit on the intended target.
 *
 * Distance to the target's hit circle, plus the two corrections that stop the
 * search preferring something that merely looks close: a shell that left the
 * world is not a near miss, and for a bot that cares, a crater centred on its
 * own hull is not a good outcome however close to the target it was.
 */
function scoreOf(solver: Solver, trajectory: Trajectory): number {
  const { impact } = trajectory;
  if (impact.kind === 'tank' && impact.tankIndex === solver.targetIndex) return 0;

  let miss = hypot2(impact.x - solver.targetX, impact.y - solver.targetY);
  if (impact.kind === 'wall' || impact.kind === 'expired') miss += OFF_MAP_PENALTY;
  if (solver.avoidsSelfHarm) {
    const toSelf = hypot2(impact.x - solver.muzzleX, impact.y - solver.muzzleY);
    const overlap = solver.weapon.radius - toSelf;
    if (overlap > 0) miss += overlap * SELF_HARM_WEIGHT;
  }
  return miss;
}

interface Best {
  angleDeg: number;
  power: number;
  score: number;
  /** Elevation above horizontal, i.e. `angleDeg` folded onto one side. */
  elevation: number;
}

/** Fold an angle onto the 0..90 elevation the ladders are written in. */
function elevationOf(angleDeg: number): number {
  return angleDeg <= 90 ? angleDeg : 180 - angleDeg;
}

function angleFor(solver: Solver, elevation: number): number {
  return solver.dir > 0 ? elevation : 180 - elevation;
}

/**
 * The coarse ladder for a band: evenly spaced from the bottom, and always
 * ending exactly on the top.
 *
 * The top rung has to be there explicitly. Stopping at the last multiple of the
 * step would quietly narrow every personality whose band is not a whole number
 * of steps wide — the Tosser's 58..84 would top out at 78 and lose the steepest
 * six degrees it exists for. Appending it rather than letting the loop reach it
 * is what stops a band that IS a whole number of steps wide (the Cyborg's
 * 15..85) from firing its top rung twice, which cost four wasted flights per
 * decision.
 */
function elevationLadder(profile: BotProfile): number[] {
  const rungs: number[] = [];
  for (
    let elevation = profile.elevationLo;
    elevation < profile.elevationHi;
    elevation += SEARCH.coarseStep
  ) {
    rungs.push(elevation);
  }
  rungs.push(profile.elevationHi);
  return rungs;
}

/**
 * Search the personality's elevation band for the best shot available.
 *
 * Coarse ladder first, then a second pass either side of whichever rung won.
 * Both passes drive power with `walkPower`; the returned answer is the best
 * scoring probe seen anywhere, not the final iterate of anything.
 */
function solveAim(solver: Solver, profile: BotProfile): Best {
  const best: Best = {
    angleDeg: angleFor(solver, 45),
    power: 60,
    score: Infinity,
    elevation: 45,
  };

  for (const elevation of elevationLadder(profile)) {
    if (solver.flights + SEARCH.coarseProbes > SEARCH.maxFlights) break;
    walkPower(solver, elevation, SEARCH.coarseProbes, best, undefined);
    if (best.score === 0) return best;
  }

  const centre = best.elevation;
  const seed = best.power;
  for (const offset of SEARCH.refineOffsets) {
    if (best.score === 0) break;
    if (solver.flights + SEARCH.refineProbes > SEARCH.maxFlights) break;
    const elevation = clamp(centre + offset, profile.elevationLo, profile.elevationHi);
    if (elevation === centre) continue;
    walkPower(solver, elevation, SEARCH.refineProbes, best, seed);
  }

  return best;
}

/**
 * Drive power at a fixed elevation until the shot lands on the target's column.
 *
 * Newton, with the derivative taken from the ballistics rather than from a
 * second probe: a parabola's range scales with the square of muzzle speed and
 * speed is linear in power, so `dRange/dPower = 2 * range / power`. That buys a
 * root find that costs ONE `simulateFlight` per iteration instead of two, which
 * is the difference between a 46-flight decision and a 92-flight one.
 *
 * The floor under `reached` is what makes it survive a blocked shot. A shell
 * that detonates on the hillside in front of the muzzle has travelled almost no
 * distance, and the true derivative there is nothing like the model's — so the
 * step is computed against a quarter of the range instead, which escalates
 * power sharply rather than dividing by something near zero.
 */
function walkPower(
  solver: Solver,
  elevation: number,
  probes: number,
  best: Best,
  seedPower: number | undefined,
): void {
  const angleDeg = angleFor(solver, elevation);
  let power = seedPower ?? analyticPower(solver, elevation);

  for (let probe = 0; probe < probes; probe += 1) {
    const trajectory = fly(solver, angleDeg, power);
    const score = scoreOf(solver, trajectory);
    if (score < best.score) {
      best.score = score;
      best.angleDeg = angleDeg;
      best.power = power;
      best.elevation = elevation;
    }
    if (score === 0) return;

    const reached = (trajectory.impact.x - solver.muzzleX) * solver.dir;
    const error = reached - solver.range;
    if (Math.abs(error) < 0.5) return;

    const slope = (2 * Math.max(reached, solver.range * 0.25, 1)) / Math.max(power, 1);
    const next = clamp(power - error / slope, MIN_SOLVED_POWER, 100);
    // Pinned at a bound: another iteration would recompute the same number.
    if (next === power) return;
    power = next;
  }
}

/**
 * Opening guess for the power at a given elevation, from the closed form.
 *
 * With no wind and no terrain, a shell fired at elevation e reaches horizontal
 * distance u and vertical rise v when
 *
 *     v = u tan(e) - g u^2 / (2 v0^2 cos^2(e))
 *
 * which rearranges to the speed below. It is only a seed — the wind, the
 * hillside and the tank's own hull are all `walkPower`'s problem — but it is a
 * good enough one that the first probe usually lands within a few tens of
 * pixels, which is what keeps the probe budget at four.
 *
 * `Math.tan` is banned in this package (engine-defined), so the tangent is
 * sin/cos from `math.ts`. The elevation bands never reach 90 degrees, so the
 * cosine cannot be zero.
 */
function analyticPower(solver: Solver, elevation: number): number {
  const cos = detCosDeg(elevation);
  const sin = detSinDeg(elevation);
  const u = Math.max(solver.range, 1);
  const denominator = 2 * cos * cos * ((u * sin) / cos - solver.rise);
  if (!(denominator > 0)) return 100;
  const speedSquared = (PHYSICS.gravity * u * u) / denominator;
  if (!(speedSquared > 0) || !Number.isFinite(speedSquared)) return 100;
  return clamp(Math.sqrt(speedSquared) / PHYSICS.powerScale, MIN_SOLVED_POWER, 100);
}

/** Scatter the solved aim by the personality's deliberate error. */
function blur(best: Best, profile: BotProfile, rng: Rng): { angleDeg: number; power: number } {
  const angleDeg = best.angleDeg + rng.range(-profile.angleError, profile.angleError);
  const power = best.power + rng.range(-profile.powerError, profile.powerError);
  return {
    angleDeg: clamp(angleDeg, 0, 180),
    power: clamp(power, MIN_SOLVED_POWER, 100),
  };
}

// ---------------------------------------------------------------------------
// The other two aiming styles
// ---------------------------------------------------------------------------

/** MORON. Right way round, and that is all. Costs no flights at all. */
function wildAim(
  solver: Solver,
  profile: BotProfile,
  rng: Rng,
): { angleDeg: number; power: number } {
  const elevation = rng.range(profile.elevationLo, profile.elevationHi);
  return {
    angleDeg: clamp(angleFor(solver, elevation), 0, 180),
    power: clamp(rng.range(MORON_POWER.lo, MORON_POWER.hi), 0, 100),
  };
}

/**
 * POOLSHARK. Re-fly last turn's aim, see the miss, walk in.
 *
 * Three flights, never more. The first re-derives the memory: `fire()` wrote
 * the aim it resolved onto `tank.angleDeg` / `tank.power` and `serialize.ts`
 * keeps both, so flying that aim again says where the last shot went. The
 * second checks the power correction before committing to it — without that
 * check a bad Newton step (a blocked shot, a ridge that only exists at one
 * power) can walk the aim AWAY from the target, and a bracket that can get
 * worse is not a bracket.
 *
 * The third is the way out of a trap, and it is what turns "usually converges"
 * into "converges". A bracket that only ever adjusts power gets stuck the
 * moment power is not the problem: shooting into the side of a hill, the
 * correction says "harder", harder does not help, the check rejects it, and the
 * bot re-derives the identical dead end every turn for the rest of the round.
 * Measured over 200 ten-turn duels, adding this probe took the mean miss on
 * turn 10 from 85 px to 56 and the hit rate from 29% to 34% — almost all of it
 * out of the tail, since the median barely moved (32 px to 28).
 *
 * If the old aim already lands inside the blast radius, it fires that instead
 * of correcting: a person who ranged in last turn shoots the same shot again.
 */
function bracketAim(
  solver: Solver,
  tank: Tank,
  profile: BotProfile,
  rng: Rng,
): { angleDeg: number; power: number } {
  const elevation = clamp(elevationOf(tank.angleDeg), profile.elevationLo, profile.elevationHi);
  const power = clamp(tank.power, MIN_SOLVED_POWER, 100);
  const angleDeg = angleFor(solver, elevation);

  const jitter = (aim: {
    angleDeg: number;
    power: number;
  }): { angleDeg: number; power: number } => ({
    angleDeg: clamp(aim.angleDeg + rng.range(-profile.angleError, profile.angleError), 0, 180),
    power: clamp(
      aim.power + rng.range(-profile.powerError, profile.powerError),
      MIN_SOLVED_POWER,
      100,
    ),
  });

  const trajectory = fly(solver, angleDeg, power);
  const held = scoreOf(solver, trajectory);
  // Already ranged in. Fire it again.
  if (held <= solver.weapon.radius) return jitter({ angleDeg, power });

  const reached = (trajectory.impact.x - solver.muzzleX) * solver.dir;
  const error = reached - solver.range;
  const slope = (2 * Math.max(reached, solver.range * 0.25, 1)) / Math.max(power, 1);

  let nextElevation = elevation;
  let nextPower = power - (BRACKET_GAIN * error) / slope;
  if (nextPower > 100) {
    // Cannot throw it any further at this loft: flatten the arc.
    nextPower = 100;
    nextElevation = clamp(
      elevation - BRACKET_ELEVATION_STEP,
      profile.elevationLo,
      profile.elevationHi,
    );
  } else if (nextPower < MIN_SOLVED_POWER) {
    nextPower = MIN_SOLVED_POWER;
    nextElevation = clamp(
      elevation + BRACKET_ELEVATION_STEP,
      profile.elevationLo,
      profile.elevationHi,
    );
  }

  const nextAngle = angleFor(solver, nextElevation);
  const corrected = fly(solver, nextAngle, nextPower);
  if (scoreOf(solver, corrected) < held) return jitter({ angleDeg: nextAngle, power: nextPower });

  // Power was not the problem. Change the shape of the arc instead, steepening
  // or flattening on a coin from the bot's own stream, and re-derive the power
  // that loft wants from the closed form rather than carrying the old one over.
  const escapeElevation = clamp(
    elevation + (rng.chance(0.5) ? BRACKET_ELEVATION_STEP : -BRACKET_ELEVATION_STEP),
    profile.elevationLo,
    profile.elevationHi,
  );
  const escapeAngle = angleFor(solver, escapeElevation);
  const escapePower = analyticPower(solver, escapeElevation);
  const escape = fly(solver, escapeAngle, escapePower);
  if (scoreOf(solver, escape) < held) {
    return jitter({ angleDeg: escapeAngle, power: escapePower });
  }
  return jitter({ angleDeg, power });
}

// ---------------------------------------------------------------------------
// Shopping
// ---------------------------------------------------------------------------

export interface BotPurchase {
  readonly weaponId: WeaponId;
  readonly quantity: number;
}

/**
 * What this bot buys between rounds.
 *
 * A preference list walked best-first against a budget, so a personality
 * degrades gracefully: the Annihilator asks for a Death's Head, cannot afford
 * it or the armoury has not opened yet, and drops to a Nuke and then to a Baby
 * Nuke with whatever is left. Nothing here can produce a purchase `economy.ts`
 * would refuse — the shelf and the wallet are both checked against the same
 * functions the shop itself uses, and the running budget is decremented as it
 * goes, so `applyBotShopping` never has to catch anything.
 *
 * Returns an empty list for a human seat or a closed shop.
 */
export function choosePurchases(state: GameState, tankIndex: number): BotPurchase[] {
  const tank = state.tanks[tankIndex];
  if (tank === undefined || tank.bot == null) return [];
  if (!isShopOpen(state)) return [];

  const profile = PROFILES[tank.bot];
  const fought = roundsFought(state);
  let budget = Math.floor(tank.money * profile.spendFraction);
  const purchases: BotPurchase[] = [];

  for (const weaponId of profile.shopping) {
    const weapon = getWeapon(weaponId);
    if (weapon === undefined) continue;
    if (weapon.price <= 0 || !Number.isFinite(weapon.packSize) || weapon.packSize <= 0) continue;
    if (!isOnTheShelf(weapon, fought)) continue;

    const packs = Math.min(MAX_PACKS_PER_ITEM, Math.floor(budget / weapon.price));
    if (packs < 1) continue;
    purchases.push({ weaponId: weapon.id, quantity: packs });
    budget -= weapon.price * packs;
  }

  return purchases;
}

/**
 * Run this bot through the shop and hand back the resulting state.
 *
 * A thin wrapper over `choosePurchases` and `economy.buy` so the Durable Object
 * has one call to make. Leaves the state untouched — the same object, not a
 * copy — when there is nothing to buy.
 */
export function applyBotShopping(state: GameState, tankIndex: number): GameState {
  const tank = state.tanks[tankIndex];
  if (tank === undefined) return state;

  let next = state;
  for (const purchase of choosePurchases(state, tankIndex)) {
    next = buy(next, tank.id, purchase.weaponId, purchase.quantity).state;
  }
  return next;
}
