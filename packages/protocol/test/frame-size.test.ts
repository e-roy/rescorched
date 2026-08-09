/**
 * Frame sizes, measured against the real simulation rather than guessed.
 *
 * This file exists because of a bug that a unit test could never have caught by
 * inspection: `events` frames and `fire` frames shared one 16 KB cap, and the
 * sim outgrew it. A Funky Bomb — one blast plus eight sub-munition arcs, on top
 * of a snapshot carrying the full 1280-column heightmap — measured 18,255 bytes,
 * so `parseServerMessage` rejected it and the client froze mid-turn. It affected
 * roughly 5% of shots, and disproportionately the interesting ones.
 *
 * The lesson worth keeping: the cap on what a hostile client may SEND has
 * nothing to do with the size of what our own server legitimately BROADCASTS.
 */

import { describe, expect, it } from 'vitest';
import { createGame, fire, toSnapshot, WEAPONS } from '@scorched/sim';

import {
  encodeServerMessage,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_SERVER_MESSAGE_BYTES,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
} from '../src/index.ts';

const PLAYERS = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
  { id: 'p3', name: 'Cleo' },
];

/** Fire one weapon on a full-size map and return the frame the server would send. */
function frameFor(weaponId: string, seed: number, angleDeg: number, power: number): string {
  let state = createGame({ seed, totalRounds: 3, width: 1280, height: 720 }, PLAYERS);
  state = {
    ...state,
    tanks: state.tanks.map((tank) => ({
      ...tank,
      inventory: Object.fromEntries(WEAPONS.map((weapon) => [weapon.id, 99])),
    })),
  };

  const shooter = state.tanks[state.activeTank];
  if (shooter === undefined) throw new Error('no active tank');

  const result = fire(state, shooter.id, {
    turnNumber: state.turnNumber,
    angleDeg,
    power,
    weapon: weaponId,
  });

  return encodeServerMessage({
    t: 'events',
    turnNumber: state.turnNumber,
    events: result.events as never,
    snapshot: toSnapshot(result.state) as never,
  });
}

describe('server frames survive the wire', () => {
  it('the worst weapon in the arsenal round-trips', () => {
    // Funky Bomb at high power was the measured worst case: eight sub-munitions,
    // eight arcs, one heightmap.
    const frame = frameFor('funky_bomb', 11, 80, 100);
    expect(frame.length).toBeGreaterThan(MAX_CLIENT_MESSAGE_BYTES);

    const parsed = parseServerMessage(frame);
    expect(parsed.ok, parsed.ok ? '' : `rejected: ${parsed.error}`).toBe(true);
  });

  it('every weapon at every awkward angle round-trips', () => {
    let worst = 0;
    let worstLabel = '';

    for (const weapon of WEAPONS) {
      for (const seed of [0, 7, 11]) {
        for (const [angleDeg, power] of [
          [45, 80],
          [80, 100],
          [120, 65],
        ] as const) {
          const frame = frameFor(weapon.id, seed, angleDeg, power);
          const parsed = parseServerMessage(frame);
          expect(
            parsed.ok,
            parsed.ok ? '' : `${weapon.id} @${angleDeg}/${power} seed ${seed}: ${parsed.error}`,
          ).toBe(true);

          if (frame.length > worst) {
            worst = frame.length;
            worstLabel = `${weapon.id} seed ${seed} ${angleDeg}/${power}`;
          }
        }
      }
    }

    // A ceiling with real headroom, not a restatement of the constant. If the
    // sim starts emitting frames anywhere near the cap this fails long before
    // players start losing turns.
    expect(worst, `worst frame was ${worstLabel}`).toBeLessThan(MAX_SERVER_MESSAGE_BYTES / 4);
  });
});

describe('client frames stay tightly capped', () => {
  it('rejects an oversized client frame well below the server limit', () => {
    const huge = `{"t":"chat","text":"${'x'.repeat(MAX_CLIENT_MESSAGE_BYTES)}"}`;
    expect(huge.length).toBeLessThan(MAX_SERVER_MESSAGE_BYTES);

    const parsed = parseClientMessage(huge);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/too large/i);
  });

  it('accepts the largest frame a legitimate player can actually send', () => {
    // The biggest real client message is a hello with a full-length name, or a
    // chat at the schema's 200-character limit. Both are tiny; the point of the
    // assertion is to record how much room the cap leaves.
    const chat = JSON.stringify({ t: 'chat', text: 'x'.repeat(200) });
    const hello = JSON.stringify({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      name: 'x'.repeat(16),
      sessionId: 'x'.repeat(64),
    });

    expect(parseClientMessage(chat).ok).toBe(true);
    expect(parseClientMessage(hello).ok).toBe(true);
    expect(Math.max(chat.length, hello.length)).toBeLessThan(MAX_CLIENT_MESSAGE_BYTES / 20);
  });
});
