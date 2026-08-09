/**
 * The parse functions must never throw, for any input at all.
 *
 * This is not a style preference. `parseClientMessage` runs inside the Durable
 * Object on a frame an attacker wrote; a throw there is not a rejected message,
 * it is a room that stops adjudicating a match other people are playing in. The
 * same argument applies in the other direction on the client, where a throw is
 * a frozen game.
 *
 * fast-check is not a dependency here (minimal dependency count is a stated
 * feature in TECH_STACK.md), so the generators below are hand-rolled on a
 * seeded PRNG. Seeded matters: a failure has to reproduce on the next run.
 *
 * A hole this file previously had, worth stating so it is not re-dug: the
 * generators emitted `packed` heightmaps only as random noise and as one run of
 * 30,000 underscores, all of which decode to null. So the corpus exercised the
 * codec's *rejection* path thousands of times and its *acceptance* path never,
 * and `assertStable` — which is the strongest claim in the file — could not see
 * that a frame the decoder accepted was a frame `encodeServerMessage` then threw
 * on. The corpus below deliberately carries well-formed packed heightmaps at the
 * extremes of the legal range (which must survive the whole round trip) and
 * well-formed ones just past it (which must be refused, not thrown on).
 */

import { describe, expect, it } from 'vitest';
import {
  encodeClientMessage,
  encodeServerMessage,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_WORLD_COORD,
  packSurface,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
} from '../src/index.ts';

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[randomInt(random, 0, items.length - 1)] as T;
}

/**
 * Characters chosen to include everything that has historically broken a
 * parser: JSON punctuation, control characters, a lone high surrogate, a lone
 * low surrogate, an astral pair, and a byte-order mark.
 */
const NASTY_CHARS = [
  '{',
  '}',
  '[',
  ']',
  '"',
  ':',
  ',',
  '\\',
  '/',
  't',
  'e',
  '0',
  '9',
  '-',
  '.',
  'E',
  'n',
  'u',
  'l',
  ' ',
  '\n',
  '\t',
  '\u0000',
  '\u0007',
  '\u001f',
  '\u007f',
  '\u009f',
  '\ud800',
  '\udfff',
  '😀',
  '\ufeff',
  '\u202e',
  '__proto__',
  'constructor',
  'prototype',
  'NaN',
  'Infinity',
  '1e400',
  't',
];

function randomString(random: () => number, maxLength: number): string {
  const length = randomInt(random, 0, maxLength);
  let out = '';
  for (let index = 0; index < length; index += 1) out += pick(random, NASTY_CHARS);
  return out;
}

/**
 * Well-formed packed heightmaps, so the generator produces input the codec can
 * actually get its teeth into rather than only noise it rejects on the first
 * character.
 *
 * `'e'` is a single terminating base-32 digit whose zig-zag value is 30, so a
 * run of `'e'` is a map climbing 15 pixels per column: 1,092 of them stop just
 * inside the legal range and 1,093 step outside it. `'g'` is the zero digit
 * with the continuation bit set, so a run of `'g'` is padding — the shape that
 * used to overflow the decoder's scale into Infinity and hand back a NaN
 * column.
 */
const PACKED_SAMPLES = [
  '',
  'A',
  packSurface([0, 1, 2, 3]),
  packSurface([300, 300, 300, 300]),
  packSurface([-MAX_WORLD_COORD, MAX_WORLD_COORD, -MAX_WORLD_COORD, MAX_WORLD_COORD]),
  'e'.repeat(1092), // last column 16,380 — legal
  'e'.repeat(1093), // last column 16,395 — one step outside the range
  'e'.repeat(4000), // a long way outside it
  'g'.repeat(3) + 'A', // maximum legal digits for one column
  'g'.repeat(205) + 'A', // the padding run that used to decode to [NaN]
  'g'.repeat(3000) + 'A',
  'g', // a lone continuation digit: truncated mid-value
  '_'.repeat(30_000), // longer than any board, refused before decoding
];

const DISCRIMINATORS = [
  'hello',
  'ready',
  'start',
  'aim',
  'fire',
  'buy',
  'sell',
  'shopDone',
  'chat',
  'ping',
  'welcome',
  'lobby',
  'state',
  'events',
  'turnTimer',
  'spectators',
  'host',
  'matchResult',
  'error',
  'pong',
  '',
  'x',
];

const LEAVES: unknown[] = [
  0,
  -1,
  1.5,
  1e308,
  -1e308,
  Number.MAX_SAFE_INTEGER,
  true,
  false,
  null,
  '',
  'x',
  '\ud800',
  '\u0000',
];

/** A random JSON-shaped document, sometimes wearing a real discriminator. */
function randomJsonValue(random: () => number, depth: number): unknown {
  if (depth <= 0 || random() < 0.35) return pick(random, LEAVES);

  if (random() < 0.4) {
    const length = randomInt(random, 0, 4);
    return Array.from({ length }, () => randomJsonValue(random, depth - 1));
  }

  const out: Record<string, unknown> = {};
  if (random() < 0.7) out['t'] = pick(random, DISCRIMINATORS);
  if (random() < 0.3) out['type'] = pick(random, DISCRIMINATORS);
  if (random() < 0.2) out['protocol'] = pick(random, [PROTOCOL_VERSION, 0, 1, 99, 'x', null]);
  const extras = randomInt(random, 0, 5);
  for (let index = 0; index < extras; index += 1) {
    const key = pick(random, [
      'name',
      'text',
      'weapon',
      'angleDeg',
      'power',
      'turnNumber',
      'quantity',
      'nonce',
      'snapshot',
      'events',
      'terrain',
      'surface',
      'packed',
      'inventory',
      '__proto__',
      'constructor',
      randomString(random, 3),
    ]);
    // A `packed` key usually gets something the codec will actually decode.
    // Filling it with the same noise as every other key is how the codec ended
    // up fuzzed only on inputs it rejects at the first character.
    out[key] =
      key === 'packed' && random() < 0.8
        ? pick(random, PACKED_SAMPLES)
        : randomJsonValue(random, depth - 1);
  }
  return out;
}

/**
 * Anything that parsed must be re-encodable and must parse back to itself.
 * Returns how many of the two directions accepted the frame, so a test can
 * assert the accepting path was actually exercised and not merely never hit.
 */
function assertStable(raw: string): number {
  let accepted = 0;

  const asClient = parseClientMessage(raw);
  expect(typeof asClient.ok).toBe('boolean');
  if (asClient.ok) {
    accepted += 1;
    const reparsed = parseClientMessage(encodeClientMessage(asClient.value));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.value).toEqual(asClient.value);
  } else {
    expect(typeof asClient.error).toBe('string');
    expect(asClient.error.length).toBeGreaterThan(0);
  }

  const asServer = parseServerMessage(raw);
  expect(typeof asServer.ok).toBe('boolean');
  if (asServer.ok) {
    accepted += 1;
    const reparsed = parseServerMessage(encodeServerMessage(asServer.value));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.value).toEqual(asServer.value);
  } else {
    expect(asServer.error.length).toBeGreaterThan(0);
  }

  return accepted;
}

describe('parse never throws', () => {
  it('for 4000 seeded strings of JSON-adjacent noise', () => {
    const random = makeRandom(0x1234);
    for (let trial = 0; trial < 4000; trial += 1) {
      const raw = randomString(random, 60);
      expect(() => assertStable(raw), `trial ${trial}: ${JSON.stringify(raw)}`).not.toThrow();
    }
  });

  it('for 3000 seeded JSON documents', () => {
    const random = makeRandom(0xbeef);
    let accepted = 0;
    for (let trial = 0; trial < 3000; trial += 1) {
      let raw: string;
      try {
        raw = JSON.stringify(randomJsonValue(random, 4)) ?? 'undefined';
      } catch {
        continue; // generator produced something unstringifiable; not our concern
      }
      expect(
        () => {
          accepted += assertStable(raw);
        },
        `trial ${trial}: ${raw.slice(0, 200)}`,
      ).not.toThrow();
    }
    // The generator emits `{"t":"start"}` and friends often enough that a zero
    // here would mean it had stopped producing anything the schema recognises,
    // and the round-trip half of this test had quietly stopped running.
    expect(accepted).toBeGreaterThan(0);
  });

  it('for mutations of frames that were valid a moment ago', () => {
    const random = makeRandom(0xfeed);
    const seeds = [
      encodeClientMessage({ t: 'hello', protocol: PROTOCOL_VERSION, name: 'Alice' }),
      encodeClientMessage({ t: 'fire', turnNumber: 3, angleDeg: 45, power: 60, weapon: 'nuke' }),
      encodeClientMessage({ t: 'chat', text: 'good shot' }),
      encodeServerMessage({
        t: 'welcome',
        protocol: PROTOCOL_VERSION,
        sessionId: 's1',
        roomCode: 'ABCD',
        you: 's1',
      }),
      encodeServerMessage({
        t: 'state',
        snapshot: {
          seed: 1,
          round: 1,
          totalRounds: 3,
          phase: 'aiming',
          terrain: { width: 6, height: 100, surface: [10, 11, 12, 13, 14, 15] },
          tanks: [],
          activeTank: 0,
          turnNumber: 1,
          wind: 0,
          winnerId: null,
          pendingShoppers: [],
        },
      }),
      // A packed heightmap sitting on the extremes of the legal range. This is
      // the seed the corpus was missing: it is well-formed, it parses, and
      // therefore `assertStable` demands it re-encode and come back identical.
      // A decoder whose range is wider than the schema's fails here, because
      // `encodeServerMessage` validates against the schema on the way out.
      JSON.stringify({
        t: 'state',
        snapshot: {
          seed: 1,
          round: 1,
          totalRounds: 3,
          phase: 'aiming',
          terrain: {
            width: 4,
            height: 100,
            packed: packSurface([
              -MAX_WORLD_COORD,
              MAX_WORLD_COORD,
              -MAX_WORLD_COORD,
              MAX_WORLD_COORD,
            ]),
          },
          tanks: [],
          activeTank: 0,
          turnNumber: 1,
          wind: 0,
          winnerId: null,
          pendingShoppers: [],
        },
      }),
    ];

    let accepted = 0;
    for (const seed of seeds) accepted += assertStable(seed);
    expect(accepted).toBe(seeds.length);

    for (let trial = 0; trial < 4000; trial += 1) {
      const base = pick(random, seeds);
      const cut = randomInt(random, 0, base.length);
      const mode = randomInt(random, 0, 3);
      const mutated =
        mode === 0
          ? base.slice(0, cut)
          : mode === 1
            ? base.slice(0, cut) + pick(random, NASTY_CHARS) + base.slice(cut)
            : mode === 2
              ? base.slice(0, cut) + base.slice(cut + 1)
              : base.slice(cut) + base.slice(0, cut);

      expect(() => assertStable(mutated), `trial ${trial}: ${mutated.slice(0, 200)}`).not.toThrow();
    }
  });

  it('for pathological sizes and shapes', () => {
    const pathological = [
      '',
      ' ',
      '\u0000',
      '\ud800',
      'null',
      'undefined',
      '[]',
      '{}',
      '{"t":',
      '{"t":"fire"',
      '"' + 'x'.repeat(MAX_CLIENT_MESSAGE_BYTES - 3) + '"',
      '['.repeat(200_000) + ']'.repeat(200_000),
      '{"t":"chat","text":"' + '\\u0000'.repeat(1000) + '"}',
      '{"t":"events","turnNumber":1,"events":' + '[1,'.repeat(2000) + '1' + ']'.repeat(2000) + '}',
      JSON.stringify({ t: 'state', snapshot: { terrain: { packed: '_'.repeat(30_000) } } }),
      JSON.stringify({ t: 'ping', nonce: Number.MAX_SAFE_INTEGER }),
    ];

    for (const raw of pathological) {
      expect(() => assertStable(raw), raw.slice(0, 80)).not.toThrow();
    }
  });

  /**
   * The codec, driven through a whole frame rather than on its own.
   *
   * `assertStable` is the claim that matters here — anything that parses must
   * re-encode and come back identical — and it is only a claim about the codec
   * if the corpus contains packed heightmaps the codec accepts. It did not,
   * which is how a decoder that returned columns 610x the documented limit
   * passed 11,000 fuzz cases: every packed input in the corpus decoded to null,
   * so the accepting branch of `assertStable` never ran on packed input at all.
   */
  it('for state frames carrying every shape of packed heightmap', () => {
    const frame = (terrain: unknown): string =>
      JSON.stringify({
        t: 'state',
        snapshot: {
          seed: 1,
          round: 1,
          totalRounds: 3,
          phase: 'aiming',
          terrain,
          tanks: [],
          activeTank: 0,
          turnNumber: 1,
          wind: 0,
          winnerId: null,
          pendingShoppers: [],
        },
      });

    let accepted = 0;
    for (const packed of PACKED_SAMPLES) {
      // Sweep the declared width across the truth and several lies about it,
      // so both the "decodes but is the wrong length" and the "decodes and
      // fits" paths are reached.
      for (const width of [1, 4, 1092, 1093, 4096]) {
        const raw = frame({ width, height: 720, packed });
        expect(
          () => {
            accepted += assertStable(raw);
          },
          `width ${width}, packed ${packed.slice(0, 24)}… (${packed.length} chars)`,
        ).not.toThrow();
      }

      // …and the same heightmap offered as a plain array, when it is one.
      const raw = frame({ width: 4, height: 720, packed, surface: [1, 2, 3, 4] });
      expect(
        () => {
          accepted += assertStable(raw);
        },
        `array form, packed ${packed.slice(0, 24)}`,
      ).not.toThrow();
    }

    // If this ever reads zero, the sweep has stopped producing anything the
    // schema accepts and the round-trip half of `assertStable` — the half that
    // catches a decoder wider than the encoder — has quietly stopped running.
    expect(accepted).toBeGreaterThan(0);
  });
});
