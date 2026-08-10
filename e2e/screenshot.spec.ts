/**
 * Drives the game to each interesting state and saves a PNG.
 *
 * This is not an assertion suite — it is the evidence generator that visual
 * critics read. `pnpm screenshot` runs exactly this file.
 */

import { expect, test, type Page } from '@playwright/test';
import { canvasRect, capture, captureCanvas, stabilise } from './screenshot.ts';
import {
  createRoom,
  expectClickable,
  fire,
  joinRoom,
  openPlayer,
  predictShot,
  readSelf,
  readSnapshot,
  setAim,
  solveShot,
  leaveArmoury,
  startMatch,
  waitForOurTurn,
  waitForSnapshot,
  waitForTurnAfter,
  type GameSnapshotLike,
} from './helpers.ts';

/**
 * The one shot on this map worth photographing twice: it lands on dirt near the
 * MIDDLE of the field, and among those it stays in the air the LONGEST.
 *
 * Both halves are corrections of a harness that failed at each in turn.
 *
 * Centre, because the previous version maximised distance from the shooter and
 * that drives the impact into the frame edge: both runs of it put the crater at
 * x≈0..15, half clipped, so `06-crater.png` could not answer the question
 * `reference/README.md` exists to ask — does a crater look like something was
 * torn out of the ground.
 *
 * Longest, because of a measurement rather than a preference. The scene flies a
 * shell in `clamp(pathLength * 1.3, 260, 900)` ms and the shutter costs about
 * 300ms of that (see `screenshot.ts`), so a short lob is over before any capture
 * can open on it — whatever delay is asked for. That is why "shot in flight" had
 * never once contained a shot in flight. Picking the longest arc puts the flight
 * at its 900ms ceiling, and the shutter then lands about a third of the way
 * along it.
 */
function centredLandingShot(
  snapshot: GameSnapshotLike,
  shooterIndex: number,
): { angleDeg: number; power: number } | null {
  if (snapshot.tanks[shooterIndex] === undefined) return null;
  const middle = snapshot.terrain.width / 2;
  /** How near the centre counts as near enough to then prefer a long flight. */
  const band = snapshot.terrain.width * 0.2;
  /**
   * The shell has to stay in the picture. A near-vertical lob over a deep valley
   * is a long flight and a useless photograph: the arc leaves the top of the
   * frame and takes the shell with it, which is what the run before this one
   * produced.
   */
  const ceiling = 24;

  let best: { angleDeg: number; power: number } | null = null;
  let bestOffset = Number.POSITIVE_INFINITY;
  let bestFlight = -1;

  for (let angleDeg = 20; angleDeg <= 160; angleDeg += 5) {
    for (let power = 40; power <= 95; power += 5) {
      const predicted = predictShot(snapshot, shooterIndex, angleDeg, power, 'baby_missile');
      if (predicted.kind !== 'terrain') continue;
      if (predicted.apexY < ceiling) continue;

      const offset = Math.abs(predicted.x - middle);
      const inBand = offset <= band;
      const bestInBand = bestOffset <= band;

      // Inside the band, the longest flight wins; outside it, the nearest miss
      // to the centre does — so a map on which nothing lands centrally still
      // produces the best available photograph rather than nothing.
      const better = bestInBand
        ? inBand && predicted.pathLength > bestFlight
        : inBand || offset < bestOffset;
      if (better) {
        bestOffset = offset;
        bestFlight = predicted.pathLength;
        best = { angleDeg, power };
      }
    }
  }
  return best;
}

/**
 * Block until the client STARTS playing a turn, so a mid-flight capture is
 * timed from the animation rather than from the click.
 *
 * The old harness waited a flat 300ms after pressing Fire, which is the click,
 * the round trip, the server's simulation and then whatever was left of the
 * flight — and the click alone measured 584ms. `main.ts` locks the HUD the
 * instant the turn's frame arrives and immediately begins the animation, so the
 * Fire button going dead is the starting gun.
 *
 * Nothing is waited for after it: the shutter's own ~300ms is the delay, and
 * adding 200ms to it is what put the last "in flight" frame on the detonation.
 */
async function waitForPlayback(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector<HTMLButtonElement>('#hud-fire')?.disabled === true,
    undefined,
    { timeout: 20_000 },
  );
}

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

  /*
   * The lobby a person alone actually sees: the picker open on one of the six,
   * a computer player already seated and badged, and Start no longer refusing.
   * This is the screen the whole "one person can play" feature lives or dies on,
   * so it gets its own capture rather than being judged from the two-human one.
   */
  test('lobby with a computer player', async ({ browser }) => {
    const alice = await openPlayer(browser, 'Alice');
    await createRoom(alice);

    await alice.page.getByTestId('select-bot-personality').selectOption('annihilator');
    await alice.page.getByTestId('btn-add-bot').click();
    await expect(alice.page.locator('#lobby-players li.is-bot')).toHaveCount(1);

    await alice.page.getByTestId('select-bot-personality').selectOption('moron');
    await stabilise(alice.page);
    await capture(alice.page, '02b-lobby-computer-player');

    /*
     * …and the same room once it is a match, because the badge has to survive
     * the trip. Mid-match the snapshot says nothing about who is a machine, so
     * this frame is the evidence that the HUD still knows.
     */
    await alice.page.getByTestId('btn-start').click();
    // A match opens in the armoury; the computer player shops itself out, so
    // the one Ready here is the human's.
    await leaveArmoury(alice);
    await waitForSnapshot(alice.page);
    await expect(alice.page.getByTestId('hud')).toBeVisible();
    await stabilise(alice.page);
    await capture(alice.page, '02c-battlefield-computer-player');
    await alice.context.close();
  });

  /*
   * The tallest this screen ever gets, and the state a critic could only reach
   * before by writing their own drive: every seat taken, the server's refusal
   * on screen, the Start button still clickable under it.
   *
   * It is captured at 720 rather than the default because that is where the
   * panel stops fitting — the height at which the refusal used to sit 17px
   * below the bottom of the window and the Start button sat under the chat bar.
   */
  test('lobby with every seat taken', async ({ browser }) => {
    test.setTimeout(180_000);

    const alice = await openPlayer(browser, 'Alice');
    await alice.page.setViewportSize({ width: 1280, height: 720 });
    await createRoom(alice);

    for (let attempt = 0; attempt < 32; attempt += 1) {
      const seated = await alice.page.locator('#lobby-players li').count();
      await alice.page.getByTestId('btn-add-bot').click();
      await expect
        .poll(async () =>
          (await alice.page.locator('#lobby-players li').count()) > seated
            ? true
            : alice.page.getByTestId('lobby-error').isVisible(),
        )
        .toBe(true);
      if (await alice.page.getByTestId('lobby-error').isVisible()) break;
    }

    await stabilise(alice.page);
    await capture(alice.page, '02d-lobby-full-room');
    await alice.context.close();
  });

  test('battlefield, shot in flight, and fresh crater', async ({ browser }) => {
    const alice = await openPlayer(browser, 'Alice');
    const bob = await openPlayer(browser, 'Bob');
    const roomCode = await createRoom(alice);
    await joinRoom(bob, roomCode);
    await startMatch(alice, bob);

    const before = await waitForSnapshot(alice.page);
    await stabilise(alice.page);

    // The battlefield at rest: terrain, tanks, wind indicator, HUD.
    await capture(alice.page, '03-battlefield');
    await captureCanvas(alice.page, '04-battlefield-canvas');

    const activePage =
      before.tanks[before.activeTank]?.id === (await readSelf(alice.page)) ? alice.page : bob.page;
    await waitForOurTurn(activePage);

    /*
     * Solve a shot that actually hits the ground instead of firing 50/80 and
     * hoping. The fixed aim used to sail off the edge of the map, and the
     * consequence was not a dull picture: `06-crater.png` contained no crater at
     * all, so the one question `reference/README.md` tells a critic to ask —
     * does a crater look like something was torn out of the ground — could not
     * be answered from the evidence the harness produced.
     */
    const solved = centredLandingShot(before, before.activeTank);
    expect(solved, 'no shot on this map lands anywhere — nothing to photograph').not.toBeNull();
    await setAim(activePage, solved?.angleDeg ?? 50, solved?.power ?? 80);

    /*
     * Mid-flight: fire, wait for the animation to actually begin, and open the
     * shutter at once — no settle pause, and the playfield's rectangle measured
     * in advance so not even that round trip is spent while the shell is up.
     * The shutter itself takes about 300ms of the shell's 900, which is what
     * lands this frame a third of the way along the arc.
     */
    const frame = await canvasRect(activePage);
    await fire(activePage);
    await waitForPlayback(activePage);
    await captureCanvas(activePage, '05-shot-in-flight', 0, frame);

    /*
     * …and the bang, which is the third question `reference/README.md` puts to a
     * critic — does the explosion have enough weight that landing a hit feels
     * good — and which no capture in this suite could answer before, because the
     * only two frames on either side of it were the arc and the settled crater.
     *
     * Timed rather than hoped for. The previous version fired the next shutter
     * immediately and trusted the two exposures to add up to the flight; they
     * did not, and every capture under that name was a shell still in the air.
     * The scene flies a shell for `clamp(pathLength * 1.3, 260, 900)` ms, so the
     * wait is whatever is left of that once both exposures are paid for.
     *
     * `SHUTTER_MS` is measured against this call shape rather than taken from
     * the ~300 quoted in `screenshot.ts`: at 300 the frame landed on a Baby
     * Missile's fireball at t≈0.95, fading out. It is only a photograph, so
     * being 100ms out costs a duller picture and nothing else — but the whole
     * point of the frame is to show the blast at its size, and a fading one
     * cannot answer the question it exists to answer.
     */
    const SHUTTER_MS = 385;
    const flightMs = Math.min(
      900,
      Math.max(
        260,
        predictShot(
          before,
          before.activeTank,
          solved?.angleDeg ?? 50,
          solved?.power ?? 80,
          'baby_missile',
        ).pathLength * 1.3,
      ),
    );
    await activePage.waitForTimeout(Math.max(0, flightMs - SHUTTER_MS * 2));
    await captureCanvas(activePage, '05b-detonation', 0, frame);

    await waitForTurnAfter(alice.page, before.turnNumber);
    // The crater is drawn when the client finishes replaying the turn's events,
    // which is a beat after the authoritative snapshot lands.
    await alice.page.waitForTimeout(900);
    await captureCanvas(alice.page, '06-crater');

    /*
     * The opponent's view of the same crater.
     *
     * This pair is presented as evidence that two clients agree, so it has to be
     * capable of being wrong. Captured identically it was not: both clients
     * render a 1280x720 world into the same viewport and both were correct, so
     * the two PNGs came out byte-identical — which is exactly what photographing
     * one page twice would produce, and therefore evidence of nothing.
     *
     * Two changes make it say something. The second capture is Bob's whole
     * window at a different size, so it carries his HUD, his name badged as
     * "(you)", and a differently-scaled playfield: a shape that cannot be
     * produced from Alice's page at all. And the claim the pair illustrates is
     * asserted here rather than left to the eye — the heightmaps are compared
     * column for column, which is the same assertion `multiplayer.spec.ts` makes
     * and the reason these two pictures are worth looking at.
     */
    await bob.page.setViewportSize({ width: 1024, height: 700 });
    await stabilise(bob.page);
    await capture(bob.page, '07-crater-opponent-view');

    const aliceSees = await readSnapshot(alice.page);
    const bobSees = await readSnapshot(bob.page);
    expect(bobSees.turnNumber).toBe(aliceSees.turnNumber);
    expect(bobSees.terrain.surface, 'the two captures are of two different battlefields').toEqual(
      aliceSees.terrain.surface,
    );

    await alice.context.close();
    await bob.context.close();
  });

  test('the shop between rounds', async ({ browser }) => {
    test.setTimeout(240_000);

    const alice = await openPlayer(browser, 'Alice');
    const bob = await openPlayer(browser, 'Bob');
    const roomCode = await createRoom(alice);
    await joinRoom(bob, roomCode);
    await startMatch(alice, bob);
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
        /*
         * This is the BETWEEN-ROUNDS armoury, reached by fighting a round to
         * its end, and it is the only place in the suite that ever is. The
         * panel is two screens sharing one piece of markup — it is also the
         * first thing a match shows — and the copy that used to be baked into
         * the HTML announced a round that had not happened yet on the opening
         * one, and told the player "the shop only opens between rounds" while
         * they were standing in the counter-example.
         *
         * The opening half is asserted in `solo-bot.spec.ts`, which reaches it
         * in seconds. This is the half that costs a real round.
         */
        await expect(alice.page.getByTestId('shop-hint')).toContainText(/is over/i);
        await expect(alice.page.getByTestId('shop-hint')).not.toContainText(/first shot/i);

        await stabilise(alice.page);
        await capture(alice.page, '08-shop');
        shopCaptured = true;
        /*
         * The one assertion in this file that is about layout rather than about
         * getting somewhere, and it earns its place: the armoury is the tallest
         * panel in the game, and the panel cap it relies on is a percentage
         * height that quietly does nothing if the overlay's grid row is left to
         * size itself. When that happened, this screen ran off the bottom of the
         * window and took the button that closes it with it — and the capture
         * above looked fine at a glance, because the part that was missing was
         * the part below the fold.
         */
        await expectClickable(alice.page, 'btn-shop-done');
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
