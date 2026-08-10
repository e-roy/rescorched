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

/** A rectangle of the page, in CSS pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the playfield currently is. Costs one round trip; cache it if timing matters. */
export async function canvasRect(page: Page): Promise<Rect> {
  const box = await page.locator('#game-root canvas').boundingBox();
  if (box === null) throw new Error('No canvas to capture');
  return box;
}

/**
 * Capture just the game canvas, without the DOM overlay chrome.
 *
 * `settleMs` is the pause before the shutter, and it defaults to the same 350 ms
 * `capture` uses so repeated runs are comparable. Pass 0 for a moment that is
 * *supposed* to be mid-animation.
 *
 * Note what this does NOT do: `locator.screenshot()`. That is the obvious call
 * and it is the reason "05-shot-in-flight" has never contained a shell in the
 * air. Measured on this machine, three rounds each: an element screenshot costs
 * 561/701/722 ms end to end, while `page.screenshot({ clip })` costs 314/317/294
 * — half the latency and a fifth of the spread. A shell is up for at most 900 ms,
 * so the difference is the difference between photographing the flight and
 * photographing the crater. Pass `rect` (from `canvasRect`) measured BEFORE the
 * moment you are chasing to save the last round trip as well.
 */
export async function captureCanvas(
  page: Page,
  name: string,
  settleMs = 350,
  rect?: Rect,
): Promise<string> {
  await ensureShotDir();
  const file = path.join(SHOT_DIR, `${name}.png`);
  const clip = rect ?? (await canvasRect(page));
  if (settleMs > 0) await page.waitForTimeout(settleMs);
  await page.screenshot({ path: file, clip });
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
