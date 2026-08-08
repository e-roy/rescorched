/**
 * Drives the game to each interesting state and saves a PNG.
 *
 * This is not an assertion suite — it is the evidence generator that visual
 * critics read. `pnpm screenshot` runs exactly this file.
 */

import { expect, test } from '@playwright/test';
import { capture, captureCanvas, stabilise } from './screenshot.ts';
import {
  createRoom,
  fire,
  joinRoom,
  openPlayer,
  readSelf,
  readSnapshot,
  setAim,
  solveShot,
  startMatch,
  waitForOurTurn,
  waitForSnapshot,
  waitForTurnAfter,
} from './helpers.ts';

test.describe('visual capture', () => {
  test('title screen', async ({ browser }) => {
    const player = await openPlayer(browser, 'Alice');
    await stabilise(player.page);
    await capture(player.page, '01-title');
    await player.context.close();
  });

  test('lobby with two players', async ({ browser }) => {
    const alice = await openPlayer(browser, 'Alice');
    const bob = await openPlayer(browser, 'Bob');
    const roomCode = await createRoom(alice);
    await joinRoom(bob, roomCode);
    await stabilise(alice.page);
    await capture(alice.page, '02-lobby');
    await alice.context.close();
    await bob.context.close();
  });

  test('battlefield, shot in flight, and fresh crater', async ({ browser }) => {
    const alice = await openPlayer(browser, 'Alice');
    const bob = await openPlayer(browser, 'Bob');
    const roomCode = await createRoom(alice);
    await joinRoom(bob, roomCode);
    await startMatch(alice);

    const before = await waitForSnapshot(alice.page);
    await stabilise(alice.page);

    // The battlefield at rest: terrain, tanks, wind indicator, HUD.
    await capture(alice.page, '03-battlefield');
    await captureCanvas(alice.page, '04-battlefield-canvas');

    const activePage =
      before.tanks[before.activeTank]?.id === (await readSelf(alice.page)) ? alice.page : bob.page;
    await waitForOurTurn(activePage);
    await setAim(activePage, 50, 80);

    // Mid-flight: fire, then grab a frame while the shell is still up.
    await fire(activePage);
    await activePage.waitForTimeout(220);
    await captureCanvas(activePage, '05-shot-in-flight');

    await waitForTurnAfter(alice.page, before.turnNumber);
    await captureCanvas(alice.page, '06-crater');

    // Both players' view of the same moment, for the "identical crater" check.
    await captureCanvas(bob.page, '07-crater-opponent-view');

    await alice.context.close();
    await bob.context.close();
  });

  test('the shop between rounds', async ({ browser }) => {
    test.setTimeout(240_000);

    const alice = await openPlayer(browser, 'Alice');
    const bob = await openPlayer(browser, 'Bob');
    const roomCode = await createRoom(alice);
    await joinRoom(bob, roomCode);
    await startMatch(alice);
    await waitForSnapshot(alice.page);

    const aliceId = await readSelf(alice.page);
    let shopCaptured = false;

    /*
     * Fight a real round to its end so the shop screenshot shows a genuine
     * post-battle state — real damage, real spoils, a real crater-scarred map
     * behind the panel.
     *
     * Every shot is solved against `@scorched/sim` rather than guessed, which
     * is what makes this converge: the same engine the server runs picks an
     * angle and power that actually connects.
     */
    for (let turn = 0; turn < 70; turn += 1) {
      const snapshot = await readSnapshot(alice.page);

      if (snapshot.phase === 'shopping') {
        await stabilise(alice.page);
        await capture(alice.page, '08-shop');
        shopCaptured = true;
        break;
      }
      if (snapshot.phase === 'gameover') {
        await stabilise(alice.page);
        await capture(alice.page, '09-gameover');
        break;
      }
      if (snapshot.phase !== 'aiming') {
        await alice.page.waitForTimeout(200);
        continue;
      }

      const shooterIndex = snapshot.activeTank;
      const page = snapshot.tanks[shooterIndex]?.id === aliceId ? alice.page : bob.page;
      await waitForOurTurn(page);

      const targetIndex = snapshot.tanks.findIndex(
        (tank, index) => index !== shooterIndex && tank.alive,
      );
      if (targetIndex < 0) break;

      // Walk the fallback aim around so a blocked line of sight still reshapes
      // the terrain instead of firing the identical dud shot forever.
      const solved = solveShot(snapshot, shooterIndex, targetIndex);
      const fallbackAngle =
        (snapshot.tanks[targetIndex]?.x ?? 0) > (snapshot.tanks[shooterIndex]?.x ?? 0)
          ? 35 + (turn % 25)
          : 120 + (turn % 25);
      await setAim(
        page,
        Math.round(solved?.angleDeg ?? fallbackAngle),
        Math.round(solved?.power ?? 70 + (turn % 25)),
      );
      await fire(page).catch(() => undefined);
      await waitForTurnAfter(page, snapshot.turnNumber).catch(() => undefined);
    }

    expect(shopCaptured, 'never reached the shop — no screenshot for critics to review').toBe(true);

    await alice.context.close();
    await bob.context.close();
  });
});
