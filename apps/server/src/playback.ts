/**
 * How long a turn takes to WATCH.
 *
 * The room broadcasts a turn's events and then decides when the next one may
 * happen. For a person that decision is a 60 second clock; for a computer
 * player it is pacing, and pacing that ignores the animation is pacing that
 * hides shots.
 *
 * The defect this exists to fix, exactly as it was reported: `BOT_TURN_DELAY_MS`
 * is 400–1000 ms per personality and a turn takes roughly 840–1500 ms to
 * animate. `BattleScene.playEvents` queues turns with a backlog of ONE and drops
 * the older one when overtaken — which is the right design, and is why the board
 * stays correct — but with three or more computer players the server outruns
 * playback persistently, so a share of the shots are simply never drawn. The
 * board is right and the game looks like it is skipping.
 *
 * So the room estimates the cost of what it just sent and spends it before the
 * next machine takes its turn. Nothing about a HUMAN's turn changes: a person is
 * not paced, they are clocked.
 *
 * ---------------------------------------------------------------------------
 * What this models, and how it is allowed to be wrong
 * ---------------------------------------------------------------------------
 *
 * `BattleScene` (`apps/client/src/scenes/battle.ts`) is the thing being
 * modelled, and the structure below is its structure: a contiguous run of `shot`
 * events flies in parallel; a run of `explosion` / `dirt` events is a barrage
 * staggered over a fixed budget, with `damage` and `death` riding the blast they
 * belong to; everything else is instant because the snapshot carries it.
 *
 * Two of those numbers are the client's exactly — the flight pace and the
 * stagger — because they are the ones that decide the SHAPE of the answer. The
 * per-blast duration is deliberately an upper envelope over the three the client
 * actually uses (fire `200 + 3.4r`, napalm `220 + 3r`, dirt `190 + 1.6r`) rather
 * than a copy of all three, because the failure modes are not symmetric:
 * over-estimating costs a beat of dead air that nobody can name, and
 * under-estimating costs the player the shot. An estimate that is a little
 * generous is the correct kind of wrong.
 *
 * It cannot be a shared module. `packages/sim` is where shared code lives and
 * an animation cost is not a game rule — it is a property of one renderer, and
 * putting it in the sim would make it part of the simulation two clients must
 * agree on. So it is modelled here and pinned end to end instead: `solo-bot.spec`
 * › "a room full of computer players never outruns the animation" plays a real
 * match in the real client and asserts that no turn was dropped, which is the
 * only assertion that can notice this file drifting away from the scene.
 */

import { getWeapon } from '@scorched/sim';
import type { ServerMessage } from '@scorched/protocol';

/** The event vocabulary as it crosses the wire. */
type WireEvent = Extract<ServerMessage, { t: 'events' }>['events'][number];

/**
 * A shell's flight, from `BattleScene.animateShot`: paced by the distance the
 * shell actually travels rather than by the number of points in its path, since
 * the sim decimates long flights before they cross the wire.
 */
const SHOT_MS_PER_PIXEL = 1.3;
const SHOT_MIN_MS = 260;
const SHOT_MAX_MS = 900;

/**
 * One blast. An upper envelope over every `blastStyle` the client uses — see
 * the note above about which way this is allowed to be wrong.
 */
const BLAST_BASE_MS = 220;
const BLAST_MS_PER_RADIUS = 3.4;

/**
 * A barrage is spread over roughly this budget however many blasts it holds, so
 * a pair lands like two punches and nine land like a burst. `BattleScene`'s own
 * numbers.
 */
const BLAST_STAGGER_BUDGET_MS = 420;
const BLAST_STAGGER_MIN_MS = 55;
const BLAST_STAGGER_MAX_MS = 150;

/** A damage number pops a beat after the blast that caused it. */
const DAMAGE_POP_MS = 90;

/**
 * A roller's travel between where the shell landed and where it went off. The
 * sim reports only the resting place, so the client animates the roll — and on
 * a Heavy Roller that is most of a second the room would otherwise not count.
 */
const ROLL_MS_PER_PIXEL = 2.1;
const ROLL_MIN_MS = 200;
const ROLL_MAX_MS = 950;
const ROLL_MIN_DISTANCE = 10;

/**
 * What the client will spend animating this turn, in milliseconds.
 *
 * Pure, and exported, so the pacing can be asserted without a test sitting
 * through any of it.
 */
export function estimatePlaybackMs(events: readonly WireEvent[]): number {
  let total = 0;
  let index = 0;
  /** Where the last shell came down — a roller's animation starts from there. */
  let lastImpactX: number | null = null;

  // Bounded by the event count for the same reason the scene's own loop is: a
  // malformed frame must not be able to produce an unbounded pause.
  let guard = events.length + 1;

  while (index < events.length && guard > 0) {
    guard -= 1;
    const first = events[index];
    if (first === undefined) break;

    if (first.type === 'shot') {
      // A contiguous run flies at once, so the run costs the longest of them.
      let longest = 0;
      while (index < events.length) {
        const event = events[index];
        if (event === undefined || event.type !== 'shot') break;
        const flight = clamp(pathLength(event.path) * SHOT_MS_PER_PIXEL, SHOT_MIN_MS, SHOT_MAX_MS);
        if (flight > longest) longest = flight;
        const endX = event.path[event.path.length - 2];
        if (endX !== undefined) lastImpactX = endX;
        index += 1;
      }
      total += longest;
      continue;
    }

    if (first.type === 'explosion' || first.type === 'dirt') {
      const run = blastRunMs(events, index, lastImpactX);
      total += run.ms;
      index = run.next;
      continue;
    }

    // turn / roundEnd / gameOver / timeout, and any stray damage or death: the
    // scene draws these instantly because the snapshot already carries them.
    index += 1;
  }

  return Math.round(total);
}

/** One barrage: every blast in it, staggered, plus the numbers riding on them. */
function blastRunMs(
  events: readonly WireEvent[],
  start: number,
  lastImpactX: number | null,
): { ms: number; next: number } {
  const entries: { slot: number; ms: number }[] = [];
  let blasts = 0;
  let index = start;

  while (index < events.length) {
    const event = events[index];
    if (event === undefined) break;

    if (event.type === 'explosion' || event.type === 'dirt') {
      entries.push({ slot: blasts, ms: blastMs(event, lastImpactX) });
      blasts += 1;
      index += 1;
      continue;
    }
    // Collected into the run rather than ending it: the sim emits damage
    // immediately after the explosion that caused it, so treating it as a
    // boundary would serialise a salvo the sim meant to be simultaneous.
    if (event.type === 'damage' || event.type === 'death') {
      entries.push({ slot: Math.max(0, blasts - 1), ms: DAMAGE_POP_MS });
      index += 1;
      continue;
    }
    break;
  }

  const stagger = clamp(
    BLAST_STAGGER_BUDGET_MS / Math.max(1, blasts),
    BLAST_STAGGER_MIN_MS,
    BLAST_STAGGER_MAX_MS,
  );

  let ms = 0;
  for (const entry of entries) {
    const finishes = entry.slot * stagger + entry.ms;
    if (finishes > ms) ms = finishes;
  }
  return { ms, next: index };
}

function blastMs(
  event: Extract<WireEvent, { type: 'explosion' | 'dirt' }>,
  lastImpactX: number | null,
): number {
  let ms = BLAST_BASE_MS + event.radius * BLAST_MS_PER_RADIUS;

  if (event.type === 'explosion' && lastImpactX !== null && isRoller(event.weapon)) {
    const distance = Math.abs(event.x - lastImpactX);
    if (distance >= ROLL_MIN_DISTANCE) {
      ms += clamp(distance * ROLL_MS_PER_PIXEL, ROLL_MIN_MS, ROLL_MAX_MS);
    }
  }
  return ms;
}

/**
 * Asked of the arsenal rather than listed here. A weapon that starts rolling
 * next release must not need this file edited to be paced correctly, and an
 * unknown id — a client one build ahead — simply is not a roller.
 */
function isRoller(weaponId: string): boolean {
  return getWeapon(weaponId)?.detonation === 'roller';
}

/** Total travelled distance of a flat `[x, y, x, y, …]` polyline. */
function pathLength(path: readonly number[]): number {
  let total = 0;
  for (let i = 1; i < path.length / 2; i += 1) {
    const dx = (path[i * 2] ?? 0) - (path[i * 2 - 2] ?? 0);
    const dy = (path[i * 2 + 1] ?? 0) - (path[i * 2 - 1] ?? 0);
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
