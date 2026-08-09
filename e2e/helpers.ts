/**
 * Shared driving helpers for the Playwright suite.
 *
 * Everything here talks to the game the way a player does — clicking the same
 * buttons — except for `readSnapshot`, which reads the authoritative state the
 * client received so assertions can be exact rather than pixel-guessy.
 */

import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { PROTOCOL_VERSION } from '@scorched/protocol';
import {
  applyCrater,
  DEFAULT_WORLD,
  deserializeTerrain,
  requireWeapon,
  simulateFlight,
  type HitCircle,
} from '@scorched/sim';

export interface GameSnapshotLike {
  round: number;
  phase: string;
  turnNumber: number;
  activeTank: number;
  wind: number;
  terrain: { width: number; height: number; surface: number[] };
  tanks: {
    id: string;
    name: string;
    x: number;
    y: number;
    health: number;
    money: number;
    alive: boolean;
    inventory: Record<string, number>;
  }[];
  winnerId: string | null;
}

export interface PlayerSession {
  context: BrowserContext;
  page: Page;
  name: string;
}

/** Open a fresh, isolated browser context — a genuinely separate player. */
export async function openPlayer(browser: Browser, name: string): Promise<PlayerSession> {
  const context = await browser.newContext();
  const page = await context.newPage();

  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  // Surface client-side explosions instead of letting them hide behind a timeout.
  (page as Page & { __errors?: string[] }).__errors = errors;

  await page.goto('/');
  await page.getByTestId('input-name').fill(name);
  return { context, page, name };
}

export function consoleErrors(page: Page): string[] {
  return (page as Page & { __errors?: string[] }).__errors ?? [];
}

/** Create a room and return its code. */
export async function createRoom(session: PlayerSession): Promise<string> {
  await session.page.getByTestId('btn-create').click();
  await expect(session.page.getByTestId('panel-lobby')).toBeVisible();
  // The panel appears immediately but shows a "----" placeholder until the
  // server's `lobby` frame lands, so wait for the real code rather than racing it.
  const codeEl = session.page.getByTestId('lobby-code');
  await expect(codeEl).toHaveText(/^[A-Z]{4}$/, { timeout: 15_000 });
  return (await codeEl.textContent()) as string;
}

export async function joinRoom(session: PlayerSession, roomCode: string): Promise<void> {
  await session.page.getByTestId('input-room').fill(roomCode);
  await session.page.getByTestId('btn-join').click();
  await expect(session.page.getByTestId('panel-lobby')).toBeVisible();
  await expect(session.page.getByTestId('lobby-code')).toHaveText(roomCode, { timeout: 15_000 });
}

/**
 * Rejoin a room whose match is already running.
 *
 * Unlike `joinRoom`, this does NOT expect the lobby: the server replies to a
 * returning session with the live game state, so the client drops straight onto
 * the battlefield. Landing back in the lobby mid-match would be a bug.
 */
export async function rejoinRoom(session: PlayerSession, roomCode: string): Promise<void> {
  await session.page.getByTestId('input-room').fill(roomCode);
  await session.page.getByTestId('btn-join').click();
  await expect(session.page.getByTestId('hud')).toBeVisible({ timeout: 20_000 });
  await expect(session.page.getByTestId('overlay')).toBeHidden({ timeout: 20_000 });
}

export async function startMatch(host: PlayerSession): Promise<void> {
  const start = host.page.getByTestId('btn-start');
  await expect(start).toBeEnabled();
  await start.click();
  await expect(host.page.getByTestId('hud')).toBeVisible();
}

/** Read the last authoritative snapshot this client received. */
export async function readSnapshot(page: Page): Promise<GameSnapshotLike> {
  return page.evaluate(() => {
    const handle = (window as unknown as { __scorched?: { snapshot(): unknown } }).__scorched;
    if (handle === undefined) throw new Error('Game handle not attached');
    return handle.snapshot() as GameSnapshotLike;
  });
}

export async function waitForSnapshot(page: Page): Promise<GameSnapshotLike> {
  await page.waitForFunction(() => {
    const handle = (window as unknown as { __scorched?: { snapshot(): unknown } }).__scorched;
    return handle !== undefined && handle.snapshot() !== null;
  });
  return readSnapshot(page);
}

/** Which player id does this page believe it is? */
export async function readSelf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const handle = (window as unknown as { __scorched?: { you(): string | null } }).__scorched;
    return handle?.you() ?? '';
  });
}

/** Wait until it is this page's turn to fire. */
export async function waitForOurTurn(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const handle = (
        window as unknown as {
          __scorched?: { snapshot(): GameSnapshotLike | null; you(): string | null };
        }
      ).__scorched;
      const snapshot = handle?.snapshot();
      const you = handle?.you();
      if (snapshot == null || you == null) return false;
      return snapshot.phase === 'aiming' && snapshot.tanks[snapshot.activeTank]?.id === you;
    },
    undefined,
    { timeout: 30_000 },
  );
}

/** Wait until the server has advanced past `turnNumber`. */
export async function waitForTurnAfter(page: Page, turnNumber: number): Promise<GameSnapshotLike> {
  await page.waitForFunction(
    (previous) => {
      const handle = (window as unknown as { __scorched?: { snapshot(): GameSnapshotLike | null } })
        .__scorched;
      const snapshot = handle?.snapshot();
      return snapshot != null && snapshot.turnNumber > previous;
    },
    turnNumber,
    { timeout: 30_000 },
  );
  return readSnapshot(page);
}

export async function setAim(page: Page, angle: number, power: number): Promise<void> {
  // Drive the real keyboard path so the HUD state and the network stay in sync.
  await page.evaluate(
    ({ angle: a, power: p }) => {
      const press = (key: string, times: number, shift: boolean): void => {
        for (let i = 0; i < times; i += 1) {
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true }),
          );
        }
      };
      const angleOut = document.querySelector<HTMLOutputElement>('#hud-angle');
      const powerOut = document.querySelector<HTMLOutputElement>('#hud-power');

      let guard = 0;
      while (Number(angleOut?.textContent ?? 0) !== a && guard < 400) {
        press(Number(angleOut?.textContent ?? 0) < a ? 'ArrowLeft' : 'ArrowRight', 1, false);
        guard += 1;
      }
      guard = 0;
      while (Number(powerOut?.textContent ?? 0) !== p && guard < 400) {
        press(Number(powerOut?.textContent ?? 0) < p ? 'ArrowUp' : 'ArrowDown', 1, false);
        guard += 1;
      }
    },
    { angle, power },
  );

  await expect(page.getByTestId('hud-angle')).toHaveText(String(angle));
  await expect(page.getByTestId('hud-power')).toHaveText(String(power));
}

export async function fire(page: Page): Promise<void> {
  const button = page.getByTestId('fire-button');
  await expect(button).toBeEnabled({ timeout: 20_000 });
  // A short click timeout matters: if the round ends between "enabled" and the
  // click, the shop overlay slides over the button and an unbounded click would
  // sit there until the whole test times out.
  await button.click({ timeout: 10_000 });
}

/**
 * Work out an angle and power that will actually hit `targetIndex`.
 *
 * The e2e suite is allowed to use `@scorched/sim` directly — it is the same
 * deterministic engine the server runs, so a shot solved here lands exactly
 * where the server says it lands. That makes tests that need a hit (round ends,
 * the shop opening) fast and reliable instead of spraying random shots and
 * hoping. It also quietly asserts client, server and sim all agree.
 *
 * Returns `null` if no sampled shot gets close, so callers can fall back.
 */
export function solveShot(
  snapshot: GameSnapshotLike,
  shooterIndex: number,
  targetIndex: number,
): { angleDeg: number; power: number; predictedX: number; predictedY: number } | null {
  const shooter = snapshot.tanks[shooterIndex];
  const target = snapshot.tanks[targetIndex];
  if (shooter === undefined || target === undefined) return null;

  const terrain = deserializeTerrain(snapshot.terrain);
  const targets: HitCircle[] = snapshot.tanks.map((tank, index) => ({
    x: tank.x,
    y: tank.y - DEFAULT_WORLD.tankRadius / 2,
    radius: tank.alive ? DEFAULT_WORLD.tankRadius : 0,
    ignore: index === shooterIndex,
  }));

  const from = { x: shooter.x, y: shooter.y - DEFAULT_WORLD.tankRadius - 2 };
  let best: { angleDeg: number; power: number; predictedX: number; predictedY: number } | null =
    null;
  let bestDistance = Number.POSITIVE_INFINITY;

  const evaluate = (angleDeg: number, power: number): void => {
    if (power < 1 || power > 100 || angleDeg < 0 || angleDeg > 180) return;
    const flight = simulateFlight(
      { x: from.x, y: from.y, angleDeg, power },
      { terrain, wind: snapshot.wind, targets },
    );
    const dx = flight.impact.x - target.x;
    const dy = flight.impact.y - target.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { angleDeg, power, predictedX: flight.impact.x, predictedY: flight.impact.y };
    }
  };

  // Coarse sweep, then refine around the winner. Lobbing over a tall ridge
  // needs precise power, and a 5-unit grid walks straight past the solution.
  for (let angleDeg = 3; angleDeg <= 177; angleDeg += 2) {
    for (let power = 20; power <= 100; power += 4) evaluate(angleDeg, power);
  }

  const coarse = best as { angleDeg: number; power: number } | null;
  if (coarse !== null) {
    for (let angleDeg = coarse.angleDeg - 3; angleDeg <= coarse.angleDeg + 3; angleDeg += 1) {
      for (let power = coarse.power - 5; power <= coarse.power + 5; power += 1) {
        evaluate(angleDeg, power);
      }
    }
  }

  return bestDistance <= 22 ? best : null;
}

/**
 * Find an angle and power that will actually land on something.
 *
 * A hardcoded aim is a trap in this suite: 45/75 worked until terrain
 * generation improved, and then two tests began failing because that lob now
 * sails off the map and carves nothing. Asking the shared sim which shots
 * connect keeps these tests about what they claim to be about — that both
 * clients see the same crater — rather than about map luck.
 *
 * Prefers a shot that hits TERRAIN, since a crater is what the callers compare.
 */
export function findLandingShot(
  snapshot: GameSnapshotLike,
  shooterIndex: number,
): { angleDeg: number; power: number } | null {
  let fallback: { angleDeg: number; power: number } | null = null;

  for (let angleDeg = 20; angleDeg <= 160; angleDeg += 5) {
    for (let power = 40; power <= 95; power += 5) {
      const predicted = predictShot(snapshot, shooterIndex, angleDeg, power, 'baby_missile');
      if (predicted.kind === 'terrain') return { angleDeg, power };
      if (predicted.kind === 'tank' && fallback === null) fallback = { angleDeg, power };
    }
  }
  return fallback;
}

/**
 * Replay a shot locally with the shared sim and return the terrain it predicts.
 *
 * Because `@scorched/sim` is the very code the Durable Object runs, the
 * predicted heightmap must match the server's broadcast heightmap column for
 * column. Comparing whole terrains — rather than eyeballing a crater centre —
 * is the strongest available statement that the simulation is deterministic
 * across two processes.
 */
export function predictShot(
  snapshot: GameSnapshotLike,
  shooterIndex: number,
  angleDeg: number,
  power: number,
  weaponId: string,
): { kind: string; x: number; y: number; surface: number[] } {
  const shooter = snapshot.tanks[shooterIndex];
  if (shooter === undefined) throw new Error(`No tank at index ${shooterIndex}`);

  const terrain = deserializeTerrain(snapshot.terrain);
  const targets: HitCircle[] = snapshot.tanks.map((tank, index) => ({
    x: tank.x,
    y: tank.y - DEFAULT_WORLD.tankRadius / 2,
    radius: tank.alive ? DEFAULT_WORLD.tankRadius : 0,
    ignore: index === shooterIndex,
  }));

  const flight = simulateFlight(
    { x: shooter.x, y: shooter.y - DEFAULT_WORLD.tankRadius - 2, angleDeg, power },
    { terrain, wind: snapshot.wind, targets },
  );

  if (flight.impact.kind === 'terrain' || flight.impact.kind === 'tank') {
    applyCrater(terrain, flight.impact.x, flight.impact.y, requireWeapon(weaponId).radius);
  }

  return {
    kind: flight.impact.kind,
    x: flight.impact.x,
    y: flight.impact.y,
    surface: Array.from(terrain.surface),
  };
}

/**
 * Open a raw WebSocket from inside the page, complete the handshake as
 * `sessionId`, send one hand-crafted frame, and report the server's reply.
 *
 * This is how the suite proves the SERVER is authoritative rather than merely
 * that the UI disables a button — it is exactly what a patched client would do.
 */
export async function cheat(
  page: Page,
  roomCode: string,
  sessionId: string,
  frame: Record<string, unknown>,
): Promise<{ t: string; code?: string; message?: string }> {
  return page.evaluate(
    async ({ roomCode: room, sessionId: session, frame: payload, version }) => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${scheme}//${location.host}/api/rooms/${room}/ws`);

      return new Promise<{ t: string; code?: string; message?: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error('Cheat socket timed out'));
        }, 10_000);

        let handshaken = false;

        socket.addEventListener('open', () => {
          // Take the version from the protocol package, never a literal: a
          // hardcoded 1 here turned the whole cheat handshake into a silent
          // no-op the moment the protocol bumped to 2, and the test then failed
          // for a reason that had nothing to do with cheating.
          socket.send(
            JSON.stringify({
              t: 'hello',
              protocol: version,
              name: 'Cheater',
              sessionId: session,
            }),
          );
        });

        socket.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data)) as { t: string; code?: string };
          if (!handshaken && message.t === 'welcome') {
            handshaken = true;
            socket.send(JSON.stringify(payload));
            return;
          }
          // The first verdict after the illegal frame is what we are testing.
          if (handshaken && (message.t === 'error' || message.t === 'events')) {
            clearTimeout(timer);
            socket.close();
            resolve(message as { t: string; code?: string; message?: string });
          }
        });

        socket.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('Cheat socket errored'));
        });
      });
    },
    { roomCode, sessionId, frame, version: PROTOCOL_VERSION },
  );
}

/** A stable fingerprint of the terrain, for "both players see the same crater". */
export function terrainFingerprint(snapshot: GameSnapshotLike): string {
  let hash = 0x811c9dc5;
  for (const value of snapshot.terrain.surface) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
