/**
 * What the Worker entry module is allowed to export.
 *
 * This exists because of a failure the rest of the server suite structurally
 * cannot see. Every other test imports `src/index.ts` as an ES module, which
 * happily carries any export you like. The Workers runtime does not: it treats
 * each export of the entry module as a binding, and accepts only the default
 * handler and Durable Object / entrypoint classes.
 *
 * A plain `export const ROOM_CODE_ATTEMPTS = 5` therefore passed 92 in-workerd
 * tests and still stopped `wrangler dev` from booting at all:
 *
 *     service core:user:scorched-earth: Uncaught TypeError:
 *     Incorrect type for map entry 'ROOM_CODE_ATTEMPTS':
 *     the provided value is not of type 'function or ExportedHandler'.
 *
 * The fix is to keep helpers in a non-entry module. The guard is here, so the
 * next helper that drifts into index.ts fails a unit test in a second rather
 * than a dev server in a minute — or, worse, a deploy.
 */

import { describe, expect, it } from 'vitest';

import * as entry from '../src/index.ts';

describe('the Worker entry module', () => {
  it('exports only a default handler and classes the runtime can bind', () => {
    for (const [name, value] of Object.entries(entry)) {
      if (name === 'default') {
        expect(typeof value, 'the default export must be an ExportedHandler').toBe('object');
        continue;
      }
      // Durable Object classes are functions. Anything else — a number, a
      // string, a config object — is what workerd refuses to load.
      expect(
        typeof value,
        `\`export ${name}\` is a ${typeof value}; the Workers runtime only accepts ` +
          'functions (Durable Object / entrypoint classes) and the default handler. ' +
          'Move it to a non-entry module.',
      ).toBe('function');
    }
  });

  it('still exports the GameRoom Durable Object class', () => {
    // wrangler.jsonc names this class; losing the export breaks the binding.
    expect(typeof entry.GameRoom).toBe('function');
  });

  it('exports a fetch handler', () => {
    expect(typeof entry.default.fetch).toBe('function');
  });
});
