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

import { expect, test, type Page } from '@playwright/test';
import {
  createRoom,
  expectClickable,
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

/**
 * Convert a canvas rectangle into a page rectangle.
 *
 * Phaser FIT-scales a fixed 1280x720 world into whatever box it is given, so a
 * snapshot coordinate is not a page coordinate.
 */
async function clipFor(
  page: Page,
  region: { x: number; y: number; width: number; height: number },
  worldWidth: number,
) {
  const box = await page.locator('#game-root canvas').boundingBox();
  expect(box).not.toBeNull();
  const scale = box!.width / worldWidth;
  return {
    x: box!.x + region.x * scale,
    y: box!.y + region.y * scale,
    width: region.width * scale,
    height: region.height * scale,
  };
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

  test('the HUD dials aim, for a player who never touches the keyboard', async ({ browser }) => {
    /*
     * The control a mouse-only player actually uses, clicked.
     *
     * Every aiming test in this suite drove `helpers.setAim`, which dispatches
     * synthetic KeyboardEvents at the window — so the keyboard path was covered
     * three times over and the pointer path, which is the PRIMARY one for
     * anybody not reading the hint line, had never been exercised at all. The
     * buttons did not even carry testids, which is a fair summary of how much
     * attention they had had.
     *
     * Asserted at both ends: the readout follows the clicks, and the barrel on
     * the canvas follows the readout. Either one alone passes with the other
     * broken — a HUD that counts to itself, or a turret that moves for the
     * keyboard and not for the mouse.
     */
    test.setTimeout(150_000);

    const solo = await openPlayer(browser, 'Solo');
    const page = solo.page;
    await createRoom(solo);
    await page.getByTestId('select-bot-personality').selectOption('moron');
    await page.getByTestId('btn-add-bot').click();
    await expect(page.locator('#lobby-players li')).toHaveCount(2);
    await startMatch(solo);
    await waitForSnapshot(page);
    await waitForOurTurn(page);

    const snapshot = await readSnapshot(page);
    const you = await readSelf(page);
    const tank = snapshot.tanks.find((candidate) => candidate.id === you);
    expect(tank).toBeDefined();

    // Nothing on top of them, and all of them inside the window: a control that
    // has to be scrolled to is not the control a player clicks.
    for (const id of [
      'dial-angle-down-10',
      'dial-angle-down',
      'dial-angle-up',
      'dial-angle-up-10',
    ]) {
      await expectClickable(page, id);
    }

    // A known starting point, then nothing but clicks.
    await setAim(page, 20, 60);
    await page.waitForTimeout(150);
    const clip = await clipFor(page, tankBox(tank!), snapshot.terrain.width);
    const flat = await page.screenshot({ clip });

    // Fine steps first: five clicks, five degrees.
    for (let click = 0; click < 5; click += 1) {
      await page.getByTestId('dial-angle-up').click();
    }
    await expect(page.getByTestId('hud-angle')).toHaveText('25');

    // …then the coarse pair, which is the same control with a bigger step.
    for (let click = 0; click < 6; click += 1) {
      await page.getByTestId('dial-angle-up-10').click();
    }
    await expect(page.getByTestId('hud-angle')).toHaveText('85');

    await page.waitForTimeout(150);
    const raised = await page.screenshot({ clip });
    expect(
      Buffer.compare(flat, raised),
      'the tank looks identical after eleven clicks on the angle dial',
    ).not.toBe(0);

    // And it is the barrel that moved: at 85 degrees it stands nearly vertical,
    // so the strip directly above the turret has to have gained ink.
    const above = await clipFor(
      page,
      { x: tank!.x - 4, y: tank!.y - 34, width: 8, height: 14 },
      snapshot.terrain.width,
    );
    const aboveRaised = await page.screenshot({ clip: above });
    await page.getByTestId('dial-angle-down-10').click();
    await page.getByTestId('dial-angle-down-10').click();
    await page.getByTestId('dial-angle-down-10').click();
    await page.getByTestId('dial-angle-down-10').click();
    await page.getByTestId('dial-angle-down-10').click();
    await page.getByTestId('dial-angle-down-10').click();
    await expect(page.getByTestId('hud-angle')).toHaveText('25');
    await page.waitForTimeout(150);
    const aboveFlat = await page.screenshot({ clip: above });
    expect(
      Buffer.compare(aboveRaised, aboveFlat),
      'nothing changed above the turret between a near-vertical aim and a flat one',
    ).not.toBe(0);

    // The other dial is wired to the other number, and to nothing else.
    const angleBefore = await page.getByTestId('hud-angle').textContent();
    await page.getByTestId('dial-power-up').click();
    await page.getByTestId('dial-power-up').click();
    await page.getByTestId('dial-power-up').click();
    await expect(page.getByTestId('hud-power')).toHaveText('63');
    await page.getByTestId('dial-power-down-10').click();
    await expect(page.getByTestId('hud-power')).toHaveText('53');
    expect(await page.getByTestId('hud-angle').textContent()).toBe(angleBefore);

    // And an aim built entirely out of clicks is a shot the server accepts.
    await fire(page);

    await solo.context.close();
  });
});
