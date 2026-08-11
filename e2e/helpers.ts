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
  BABY_MISSILE,
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

/**
 * Walk into a running room and wait for the authoritative state, whatever the
 * match happens to be doing.
 *
 * Unlike `rejoinRoom` this makes no claim about which SCREEN comes up. A match
 * that has reached the end of a round is sitting in the shop, and a joiner is
 * quite correctly shown the shop rather than the battlefield — so a test that
 * only needs "this client and the server agree about the board" must not also
 * demand the battlefield.
 */
export async function watchRoom(
  session: PlayerSession,
  roomCode: string,
): Promise<GameSnapshotLike> {
  await session.page.getByTestId('input-room').fill(roomCode);
  await session.page.getByTestId('btn-join').click();
  return waitForSnapshot(session.page);
}

/**
 * Press Start and take everybody out of the opening armoury.
 *
 * A match no longer drops straight onto the battlefield: it opens in the
 * armoury, where each player spends their starting money before the first shell
 * flies. Every human seat has to press Ready before round one begins, and the
 * LAST one to press it is what opens the round — so this takes every session in
 * the room, not just the host.
 *
 * Computer players shop and leave on their own, which is why they are not
 * listed here and why a room of one person plus bots still only needs the one
 * Ready.
 */
export async function startMatch(host: PlayerSession, ...others: PlayerSession[]): Promise<void> {
  const start = host.page.getByTestId('btn-start');
  await expect(start).toBeEnabled();
  await start.click();

  const everyone = [host, ...others];
  for (const session of everyone) {
    await expect(session.page.getByTestId('panel-shop')).toBeVisible({ timeout: 20_000 });
  }
  for (const session of everyone) {
    await leaveArmoury(session);
  }
  for (const session of everyone) {
    await expect(session.page.getByTestId('hud')).toBeVisible({ timeout: 20_000 });
  }
}

/** Press Ready in the shop. Used at the armoury and between rounds alike. */
export async function leaveArmoury(session: PlayerSession): Promise<void> {
  const done = session.page.getByTestId('btn-shop-done');
  await expect(done).toBeVisible({ timeout: 20_000 });
  await done.click({ timeout: 10_000 });
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
 * An angle and power that lands on dirt and cannot hurt anybody.
 *
 * `findLandingShot` above prefers terrain but takes no interest in what is
 * standing next to it, so the shot it returns is free to wound the opponent —
 * or the shooter, which is where this was first noticed: a solved "landing"
 * shot regularly came back with the firing tank down 20-odd health. For a test
 * that only wants a crater that is fine. For a test whose NEXT assertion needs
 * the round to still be running it is not, because a round ends the moment a
 * tank dies and a round that has ended has no next turn.
 *
 * So this asks for a landing spot no part of the detonation can reach. Two
 * reaches have to clear, and both are taken from the arsenal rather than
 * written down here:
 *
 *   - `radius + tankRadius` is how far the blast reaches a hull, because
 *     `damageToTankAt` measures from the hull's skin rather than its centre;
 *   - one more `radius` for the crater, so the ground under a tank cannot move
 *     either and nobody can be dropped or buried into taking damage.
 *
 * Measured horizontally, which is the stronger test of the two available: the
 * true distance from the impact to a tank is never smaller than the difference
 * in their columns.
 *
 * Returns the quietest shot it can find, or null if this map has nowhere quiet
 * enough — which callers should treat as a failure rather than fall back from,
 * since a fallback is exactly the map luck this exists to remove. Swept over
 * 600 seats of freshly generated two-player rounds it came back null zero times
 * and the worst clearance it settled for was 258 px, against a bar of 45.
 */
export function findHarmlessShot(
  snapshot: GameSnapshotLike,
  shooterIndex: number,
): { angleDeg: number; power: number } | null {
  const weapon = requireWeapon(BABY_MISSILE);
  const needed = weapon.radius * 2 + DEFAULT_WORLD.tankRadius;

  let best: { angleDeg: number; power: number } | null = null;
  let bestClearance = needed;

  for (let angleDeg = 20; angleDeg <= 160; angleDeg += 5) {
    for (let power = 40; power <= 95; power += 5) {
      const predicted = predictShot(snapshot, shooterIndex, angleDeg, power, weapon.id);
      if (predicted.kind !== 'terrain') continue;

      let clearance = Number.POSITIVE_INFINITY;
      for (const tank of snapshot.tanks) {
        if (!tank.alive) continue;
        const gap = Math.abs(predicted.x - tank.x);
        if (gap < clearance) clearance = gap;
      }
      // Strictly better, so whatever comes back has beaten the bar rather than
      // merely tied it.
      if (clearance > bestClearance) {
        bestClearance = clearance;
        best = { angleDeg, power };
      }
    }
  }

  return best;
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
): { kind: string; x: number; y: number; pathLength: number; apexY: number; surface: number[] } {
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

  /*
   * How far the shell travels along its arc, which is how long it is IN THE AIR:
   * the scene paces a flight by exactly this quantity. The screenshot harness
   * needs it to pick a shot that is still up when the shutter opens — see
   * `screenshot.spec.ts`.
   */
  let pathLength = 0;
  /** Highest point the shell reaches. Negative means it left the top of the world. */
  let apexY = Number.POSITIVE_INFINITY;
  for (let point = 0; point < flight.length; point += 1) {
    apexY = Math.min(apexY, flight.points[point * 2 + 1] as number);
    if (point === 0) continue;
    const dx = (flight.points[point * 2] as number) - (flight.points[(point - 1) * 2] as number);
    const dy =
      (flight.points[point * 2 + 1] as number) - (flight.points[(point - 1) * 2 + 1] as number);
    pathLength += Math.sqrt(dx * dx + dy * dy);
  }

  return {
    kind: flight.impact.kind,
    x: flight.impact.x,
    y: flight.impact.y,
    pathLength,
    apexY,
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

export interface Placement {
  /** Is the whole control inside the window, or is part of it below the fold? */
  readonly onScreen: boolean;
  readonly rect: { top: number; bottom: number; left: number; right: number };
  readonly viewport: { width: number; height: number };
  /**
   * What `document.elementFromPoint` reports at the top, middle and bottom of
   * the control: `self` when the control (or its own text) is what a click
   * would land on, otherwise a description of whatever is covering it.
   */
  readonly hits: string[];
}

/**
 * Where a control actually is, and what a click on it would actually hit.
 *
 * Playwright's own `toBeVisible` means "in the document, with a non-zero box" —
 * it is satisfied by an element scrolled a hundred pixels past the bottom of the
 * window and by one sitting under an opaque bar. Both of those shipped. Its
 * `click()` hides them too, because it scrolls the element into view first,
 * which a person clicking does not.
 *
 * So this asks the page the two questions that actually matter, the same way a
 * reviewer with devtools would.
 */
export async function placementOf(page: Page, testId: string): Promise<Placement> {
  return page.evaluate((id) => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (element === null) throw new Error(`No element with data-testid="${id}"`);
    const rect = element.getBoundingClientRect();

    const describe = (node: Element | null): string => {
      if (node === null) return 'nothing';
      if (node === element || element.contains(node)) return 'self';
      const owner = node.closest('[data-testid]');
      return owner === null
        ? `${node.tagName.toLowerCase()}.${node.className}`
        : `${owner.getAttribute('data-testid')}`;
    };

    // Middle of the control's width, at its top edge, centre and bottom edge —
    // avoiding the corners, which a border radius legitimately rounds away.
    const x = rect.left + rect.width / 2;
    const ys = [rect.top + 2, rect.top + rect.height / 2, rect.bottom - 2];

    return {
      onScreen:
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right <= window.innerWidth,
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      hits: ys.map((y) => describe(document.elementFromPoint(x, y))),
    };
  }, testId);
}

/** `placementOf` as an assertion: on screen, and nothing on top of it. */
export async function expectClickable(page: Page, testId: string): Promise<void> {
  const placement = await placementOf(page, testId);
  const report = `${testId} at y=${placement.rect.top.toFixed(0)}..${placement.rect.bottom.toFixed(
    0,
  )} in a ${placement.viewport.height}px window; hit test ${placement.hits.join(', ')}`;
  expect(placement.onScreen, `${report} — part of it is off screen`).toBe(true);
  expect(placement.hits, `${report} — something is covering it`).toEqual(['self', 'self', 'self']);
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
