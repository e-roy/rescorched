/**
 * How the six computer players are DESCRIBED. Not how they behave.
 *
 * Every number a bot acts on lives in `packages/sim/src/ai.ts`; nothing here
 * decides anything. What this file owns is the one job the lobby has to do
 * before a match rather than after: make a Moron and an Annihilator
 * distinguishable to somebody who has never met either.
 *
 * ## Four rungs and two specialists, because that is what is measured
 *
 * The roster does not form one difficulty order, and pretending it does was the
 * defect this file shipped last round: it read `BOT_PERSONALITIES` as a ladder
 * and sold the Poolshark — 6.5% on its opening shot, second worst of the six —
 * as "4/6", two rungs above the Shooter's 30.5%. Nothing caught it, because
 * there was nothing to catch it with; no test ever ranked those two.
 *
 * So the picker is built from the two constants the sim exports for it:
 *
 *  - `BOT_DIFFICULTY_LADDER` — Moron, Shooter, Cyborg, Annihilator. Ranked
 *    means measured: `test/ai-personalities.test.ts` walks that array and
 *    demands each rung out-hit the one below by 15 percentage points over 200
 *    opening shots, and miss by less. Reorder it and that suite goes red, so
 *    "2 of 4" in the lobby is a claim under measurement.
 *  - `BOT_SPECIALISTS` — Tosser and Poolshark, which have no honest rung. The
 *    Tosser trades a flat trajectory for a shot over a ridge; the Poolshark
 *    opens badly on purpose and improves every turn. A number would libel both,
 *    in opposite directions, so they get a sentence instead.
 *
 * A test in the sim asserts the two arrays partition the roster, so a seventh
 * personality cannot arrive in this menu with nothing true to say about it.
 *
 * ## Why there are no percentages here
 *
 * The sweep in `ai-personalities.test.ts` prints real hit rates (3.0% for the
 * Moron against 92.0% for the Annihilator). They are honest numbers and they
 * are also the wrong thing to paint into a lobby: the test deliberately refuses
 * to pin them, because they move whenever the terrain generator or the physics
 * is retuned. A number in the interface that no test polices is a number that
 * goes quietly wrong. What IS policed is the ordering of the four and the fact
 * that the other two sit outside it, so that is exactly what gets shown.
 */

import {
  BOT_DIFFICULTY_LADDER,
  BOT_DISPLAY_NAMES,
  BOT_SPECIALISTS,
  type BotPersonality,
} from '@scorched/sim';

export interface BotBlurb {
  /**
   * Two or three words, for the `<option>` text.
   *
   * Kept this short for a mechanical reason: a closed `<select>` clips rather
   * than ellipsises, so anything longer than about 33 characters of label came
   * out chopped mid-word in the lobby. The sentence lives in `long`, which is
   * always on screen underneath.
   */
  readonly short: string;
  /** One sentence, for the line under the picker and the row tooltip. */
  readonly long: string;
}

/**
 * Distilled from each profile's own doc comment in `ai.ts`, and kept to claims
 * something in `packages/sim/test` actually measures — the Poolshark's "lands
 * more than twice as often by the end" is `ai-poolshark.test.ts`'s assertion,
 * not a guess, and the Tosser's height over the flat shooters is
 * `ai-personalities.test.ts`'s.
 */
const BLURBS: Readonly<Record<BotPersonality, BotBlurb>> = {
  moron: {
    short: 'barely aims',
    long: 'Barely aims. Faces the right way and fires; now and then it drops the shell on its own head.',
  },
  shooter: {
    short: 'ignores the wind',
    long: 'Solves the shot properly and then ignores the wind completely — beatable in a gale, dangerous on a calm day.',
  },
  tosser: {
    short: 'lobs over ridges',
    long: 'Always lobs, far higher than the flat shooters, so it can drop a shell behind a ridge they have to fire through. Not harder than the Shooter — different.',
  },
  poolshark: {
    short: 'walks its aim in',
    long: 'Never solves the shot: it fires, sees where that went, and corrects. Its opening shell is nearly as wild as the Moron; by the end of a round it lands more than twice as often.',
  },
  cyborg: {
    short: 'solves the shot',
    long: 'Solves the trajectory properly, wind included, with a small deliberate error. Beatable, not stupid.',
  },
  annihilator: {
    short: 'near-perfect',
    long: 'Solves it properly, shoots at whoever it can finish rather than whoever is nearest, and walks out of the armoury having spent almost everything.',
  },
};

/** The ranked four, weakest first — the sim's array, not a copy of it. */
export const LADDER: readonly BotPersonality[] = BOT_DIFFICULTY_LADDER;

/** The two with no honest rung, in roster order. */
export const SPECIALISTS: readonly BotPersonality[] = BOT_SPECIALISTS;

/** Rungs on the ladder. Four today, and read from the sim so it stays true. */
export const LADDER_STEPS = LADDER.length;

/**
 * Where this personality sits on the difficulty ladder, or null if it is not on
 * one.
 *
 * Null is a real answer and not a failure: two of the six are deliberately
 * unranked, and so is any string the picker has never heard of — a lobby frame
 * is server data, and a badge that reads "difficulty 0 of 4" would be worse
 * than one that says nothing.
 */
export function rankOf(personality: string): number | null {
  const index = (LADDER as readonly string[]).indexOf(personality);
  return index < 0 ? null : index + 1;
}

/*
 * Both lookups take a plain `string` and are widened on the way in, because the
 * personality on a lobby frame is server data. It cannot be anything but one of
 * the six today — the protocol parses it against a closed enum — but a lookup
 * that would return `undefined` typed as a string is the kind of thing that
 * reaches a player as the word "undefined" on a badge.
 */
const NAMES: Readonly<Record<string, string | undefined>> = BOT_DISPLAY_NAMES;
const BLURB_LOOKUP: Readonly<Record<string, BotBlurb | undefined>> = BLURBS;
const NO_BLURB: BotBlurb = { short: '', long: '' };

export function botName(personality: string): string {
  return NAMES[personality] ?? personality;
}

export function blurbOf(personality: string): BotBlurb {
  return BLURB_LOOKUP[personality] ?? NO_BLURB;
}

/**
 * `2/4  Shooter — ignores the wind`, or `Tosser — lobs over ridges` for one of
 * the two that is not on the ladder.
 *
 * The rung leads, so the ranked group reads as a ladder at a glance; the
 * unranked pair carry no number at all rather than a number that would be a
 * guess. Which group an option is in is said by the `<optgroup>` around it.
 */
export function optionLabel(personality: BotPersonality): string {
  const rank = rankOf(personality);
  const tail = `${botName(personality)} — ${blurbOf(personality).short}`;
  return rank === null ? tail : `${rank}/${LADDER_STEPS}  ${tail}`;
}

/** `Cyborg · difficulty 3 of 4`, or `Tosser · specialist`. For tooltips and the HUD. */
export function describeSeat(personality: string): string {
  const rank = rankOf(personality);
  return rank === null
    ? `${botName(personality)} · specialist`
    : `${botName(personality)} · difficulty ${rank} of ${LADDER_STEPS}`;
}

/**
 * `Cyborg · 3/4` — the same fact, for the lobby row, where width is scarce.
 *
 * Spelling it out cost 82 pixels a badge, which was enough to push the remove
 * button off the end of the row and take the Host tag with it. `3/4` is the
 * notation the picker three lines below teaches, and `describeSeat` is on the
 * row's tooltip for anyone who wants the sentence.
 */
export function badgeText(personality: string): string {
  const rank = rankOf(personality);
  return rank === null
    ? `${botName(personality)} · specialist`
    : `${botName(personality)} · ${rank}/${LADDER_STEPS}`;
}
