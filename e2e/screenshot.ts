/**
 * Screenshot harness — the ONLY sanctioned way for an agent to form a visual
 * opinion about this game (TECH_STACK.md, "Agent visual verification").
 *
 * Reading the rendering code and imagining the output does not count. Run this,
 * then open the PNGs it writes to `e2e/screenshots/`.
 *
 *   pnpm screenshot
 *
 * Each capture drives the real client against a real `wrangler dev`, so what
 * lands on disk is what a player would actually see.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SHOT_DIR = path.join(HERE, 'screenshots');
export const REFERENCE_DIR = path.join(HERE, 'reference');

export async function ensureShotDir(): Promise<void> {
  await mkdir(SHOT_DIR, { recursive: true });
}

/**
 * Capture the full viewport under a stable name.
 * Returns the absolute path so an agent can read the file straight back.
 */
export async function capture(page: Page, name: string): Promise<string> {
  await ensureShotDir();
  const file = path.join(SHOT_DIR, `${name}.png`);
  // Let tweens and the canvas settle so captures are comparable run to run.
  await page.waitForTimeout(350);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

/** Capture just the game canvas, without the DOM overlay chrome. */
export async function captureCanvas(page: Page, name: string): Promise<string> {
  await ensureShotDir();
  const file = path.join(SHOT_DIR, `${name}.png`);
  const canvas = page.locator('#game-root canvas');
  await page.waitForTimeout(350);
  await canvas.screenshot({ path: file });
  return file;
}

/**
 * Freeze everything that would make two runs of the same scene differ:
 * caret blink, CSS transitions, and the toast timer.
 */
export async function stabilise(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        transition-duration: 0s !important;
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        caret-color: transparent !important;
      }
    `,
  });
}
