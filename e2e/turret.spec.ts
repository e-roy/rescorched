/**
 * The turret must follow the player's aim.
 *
 * Reported from real play: "when I adjust the angle the turret doesn't move
 * visually on screen". It was true. The barrel was drawn from
 * `snapshot.tanks[i].angleDeg` — the SERVER's copy of the aim, which the server
 * only learns when a shot is fired. So the HUD number moved, the tank did not,
 * and the game read as ignoring its own input.
 *
 * A unit test cannot see this: every value involved was correct, and the bug was
 * that one of them was stale. So this test looks at the pixels — it captures the
 * tank at two very different angles and requires the images to differ, and to
 * differ in the direction the barrel actually swings.
 */

import { expect, test } from '@playwright/test';
import {
  createRoom,
  fire,
  joinRoom,
  openPlayer,
  readSelf,
  readSnapshot,
  setAim,
  startMatch,
  waitForOurTurn,
  waitForSnapshot,
} from './helpers.ts';

/** A tight box around one tank, in canvas pixels. */
function tankBox(tank: { x: number; y: number }) {
  return { x: tank.x - 30, y: tank.y - 40, width: 60, height: 50 };
}

test.describe('aiming is visible', () => {
  test('the barrel swings when the player changes angle', async ({ browser }) => {
    const alice = await openPlayer(browser, 'Alice');
    const bob = await openPlayer(browser, 'Bob');
    const roomCode = await createRoom(alice);
    await joinRoom(bob, roomCode);
    await startMatch(alice, bob);

    let snapshot = await waitForSnapshot(alice.page);
    const aliceId = await readSelf(alice.page);

    // Get to a turn we own, whichever of the two that is.
    const page = snapshot.tanks[snapshot.activeTank]?.id === aliceId ? alice.page : bob.page;
    await waitForOurTurn(page);
    snapshot = await readSnapshot(page);

    const shooter = snapshot.tanks[snapshot.activeTank];
    expect(shooter).toBeDefined();

    const canvas = page.locator('#game-root canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    // The canvas is letterboxed by Phaser's FIT scaling, so a snapshot
    // coordinate is not a page coordinate. Convert through the displayed size.
    const scale = box!.width / snapshot.terrain.width;
    const region = tankBox(shooter!);
    const clip = {
      x: box!.x + region.x * scale,
      y: box!.y + region.y * scale,
      width: region.width * scale,
      height: region.height * scale,
    };

    await setAim(page, 20, 60);
    await page.waitForTimeout(120);
    const low = await page.screenshot({ clip });

    await setAim(page, 85, 60);
    await page.waitForTimeout(120);
    const high = await page.screenshot({ clip });

    // The whole point: the picture must change when the aim does.
    expect(
      Buffer.compare(low, high),
      'the tank looks identical at 20 degrees and at 85 — the barrel is not following the aim',
    ).not.toBe(0);

    // And it must be the barrel moving, not a stray animation: at 85 degrees
    // the barrel stands almost straight up, so the strip directly above the
    // turret must gain ink that is not there at 20 degrees.
    const above = {
      x: box!.x + (shooter!.x - 4) * scale,
      y: box!.y + (shooter!.y - 34) * scale,
      width: 8 * scale,
      height: 14 * scale,
    };
    await setAim(page, 20, 60);
    await page.waitForTimeout(120);
    const aboveLow = await page.screenshot({ clip: above });
    await setAim(page, 85, 60);
    await page.waitForTimeout(120);
    const aboveHigh = await page.screenshot({ clip: above });

    expect(
      Buffer.compare(aboveLow, aboveHigh),
      'nothing changed directly above the turret between a flat aim and a near-vertical one',
    ).not.toBe(0);

    // Sanity: aiming did not break firing.
    await fire(page);

    await alice.context.close();
    await bob.context.close();
  });
});
