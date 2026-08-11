/**
 * One person opens the game and plays it. By clicking.
 *
 * `bots.spec.ts` already proves the room seats a computer player, takes its
 * turns on an alarm and resolves them identically on both machines — but it
 * proves it by hand-writing `addBot` onto a raw socket, because when it was
 * written the lobby had no button to press. This file is the other half, and it
 * is the half the feature is actually for: a person alone in a room can now
 * reach a match through the interface, and nothing here sends a frame that a
 * click did not.
 *
 * What each test defends, and what breaking it looks like:
 *
 *  - the journey: pick a personality, add it, start, take a turn, and the
 *    computer player takes one back with nobody touching the keyboard.
 *  - the picker explains itself before the match rather than after, and does
 *    not invent a difficulty for the two personalities nobody has ranked.
 *  - a FULL room — eight seats, which is what this feature lets one person
 *    produce on their own — still has a clickable Start button and a refusal
 *    that is on the screen rather than merely in the document.
 *  - the chat bar does not sit on the battlefield.
 *  - a computer player firing while your own shot is still animating cannot
 *    rewind the board.
 *
 * The last three are measurements, not eyeballs: rectangles, hit tests and a
 * turn counter. Every one of them regressed once already.
 */

import { expect, test, type Page } from '@playwright/test';

import {
  consoleErrors,
  createRoom,
  expectClickable,
  findHarmlessShot,
  findLandingShot,
  fire,
  openPlayer,
  readSelf,
  readSnapshot,
  setAim,
  startMatch,
  terrainFingerprint,
  waitForOurTurn,
  waitForSnapshot,
  waitForTurnAfter,
} from './helpers.ts';

/** Seat a computer player of the named personality, and hand back its seat id. */
async function addBot(page: Page, personality: string): Promise<string> {
  const before = await page.locator('#lobby-players li').count();
  await page.getByTestId('select-bot-personality').selectOption(personality);
  await page.getByTestId('btn-add-bot').click();
  await expect(page.locator('#lobby-players li')).toHaveCount(before + 1);

  const row = page.locator('#lobby-players li.is-bot').last();
  const id = await row.getAttribute('data-player-id');
  expect(id, 'the new row carries no player id').not.toBeNull();
  return id as string;
}

test.describe('one person, one computer player, no second browser', () => {
  test('picks an opponent, starts the match and trades a turn with it', async ({ browser }) => {
    // Two real turns plus a Durable Object alarm between them. The default 60s
    // is enough on a warm dev server and not on a cold one.
    test.setTimeout(150_000);

    const solo = await openPlayer(browser, 'Solo');
    const page = solo.page;
    await createRoom(solo);

    /*
     * The state this whole feature exists to get out of: one person, in a room,
     * with the Start button refusing them.
     */
    await expect(page.getByTestId('btn-start')).toBeDisabled();
    await expect(page.getByTestId('lobby-hint')).toContainText('computer player');

    /*
     * The six are told apart BEFORE the match, and told apart honestly.
     *
     * Four of them have a measured position — `BOT_DIFFICULTY_LADDER` in the
     * sim, whose order `ai-personalities.test.ts` asserts as a hit rate — and
     * carry it in the option text. The other two have none, and the previous
     * version of this screen invented one for them: it read the whole roster as
     * a ladder and sold the Poolshark, second worst of the six on its opening
     * shot, as harder than the Shooter. So what is asserted here is the
     * STRUCTURE — who carries a number and who does not — rather than a list of
     * names this file would then be restating from `ai.ts`.
     */
    const picker = page.getByTestId('select-bot-personality');
    const groups = await picker.locator('optgroup').evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: (node as HTMLOptGroupElement).label,
        options: Array.from(node.children, (option) => option.textContent ?? ''),
      })),
    );

    expect(groups, 'the picker no longer separates ranked from unranked').toHaveLength(2);
    const [ranked, specialists] = groups as [(typeof groups)[0], (typeof groups)[0]];

    // Every ranked option carries its rung, and they count up from the top.
    ranked.options.forEach((label, index) => {
      expect(label, `ranked option ${index}`).toMatch(
        new RegExp(`^${index + 1}/${ranked.options.length}\\s+\\S`),
      );
    });
    expect(ranked.label).toMatch(new RegExp(`\\b${ranked.options.length}\\b`));

    // And nothing outside the ladder claims a place on it.
    for (const label of specialists.options) {
      expect(label, 'an unranked personality is advertising a difficulty').not.toMatch(/^\d+\//);
    }
    expect(specialists.options.length).toBeGreaterThan(0);
    expect(ranked.options.length + specialists.options.length).toBe(6);
    expect(await picker.locator('option').count()).toBe(6);

    // The named ends of the ladder, which is what a player actually reads.
    expect(ranked.options[0]).toMatch(/^1\/4\s+Moron\b/);
    expect(ranked.options[ranked.options.length - 1]).toMatch(/^4\/4\s+Annihilator\b/);

    // The line under the picker changes with the choice, and says "specialist"
    // rather than a difficulty for the two that have none.
    await picker.selectOption('annihilator');
    await expect(page.getByTestId('bot-blurb')).toContainText('spent almost everything');
    await picker.selectOption('poolshark');
    await expect(page.getByTestId('bot-blurb')).toContainText('Specialist');
    await expect(page.getByTestId('bot-blurb')).toContainText('corrects');
    await picker.selectOption('moron');
    await expect(page.getByTestId('bot-blurb')).toContainText('Barely aims');

    // …and adding one is a click.
    const botId = await addBot(page, 'moron');

    /*
     * It is in the room, it is obviously not a person, and it says which of the
     * six it is. Nobody should have to wonder who they are playing.
     */
    const botRow = page.getByTestId(`lobby-player-${botId}`);
    await expect(botRow).toContainText('Moron');
    await expect(botRow).toContainText('CPU');
    await expect(botRow).toContainText('1/4');
    // The row is short on width, so it carries the rung in the picker's own
    // notation and spells it out on hover.
    await expect(botRow.locator('.tag--bot')).toHaveAttribute('title', /difficulty 1 of 4/);

    /*
     * One human plus one computer player is a match.
     *
     * Started through the shared `startMatch` helper rather than by clicking the
     * button here, so that whatever a match START comes to involve — an opening
     * armoury, a countdown — is described in one place for the whole suite
     * instead of four times in this file.
     */
    await expect(page.getByTestId('btn-start')).toBeEnabled();
    await startMatch(solo);

    const opening = await waitForSnapshot(page);
    expect(opening.tanks).toHaveLength(2);

    // Mid-match, the tank nobody is driving is still marked as such.
    await expect(page.getByTestId(`playertag-${botId}`)).toContainText('CPU');

    // -- our turn ----------------------------------------------------------
    await waitForOurTurn(page);
    const mine = await readSnapshot(page);
    const you = await readSelf(page);
    const seat = mine.tanks.findIndex((tank) => tank.id === you);
    expect(seat, 'the human has no tank').toBeGreaterThanOrEqual(0);

    /*
     * Solved against the shared sim rather than guessed, for the reason
     * `helpers.findHarmlessShot` exists: a hardcoded aim is a map-luck test.
     *
     * Harmless rather than merely landing, because the next assertion is that
     * the computer player takes a turn BACK — and it only gets one if the round
     * is still running. A shot that lands on dirt next to a tank still hurts
     * it, so "keeps the round alive" was resting on how many Baby Missiles a
     * tank can absorb rather than on nobody being hit. It still carves a crater,
     * which is what the fingerprint below compares.
     */
    const aim = findHarmlessShot(mine, seat);
    expect(aim, 'no shot on this map lands clear of every tank').not.toBeNull();
    await setAim(page, aim!.angleDeg, aim!.power);
    await fire(page);

    const afterOurs = await waitForTurnAfter(page, mine.turnNumber);
    expect(afterOurs.turnNumber).toBeGreaterThan(mine.turnNumber);
    // The click did something to the world, not just to the turn counter: the
    // solved shot was chosen to land on dirt, so there is a crater in there.
    expect(terrainFingerprint(afterOurs), 'firing left the board untouched').not.toBe(
      terrainFingerprint(opening),
    );

    // -- its turn, with nobody touching anything ---------------------------
    /*
     * Nothing below sends a frame. The room has to come back on its own, which
     * it does on a Durable Object alarm — so this is the claim a solo player
     * actually cares about: the game keeps going.
     */
    /*
     * Anchored on the turn we fired FROM, not on what the previous wait
     * happened to see.
     *
     * `waitForTurnAfter` latches on the first sighting past its argument, and
     * the two frames here can arrive close together — so a slow read can return
     * the BOT's turn as `afterOurs`. Chaining off that then waits for a third
     * turn, which only the human can cause, and the human is this test. That is
     * a 30-second hang rather than a failure, and it is exactly the shape of the
     * deadlock that took CI down in the rewind test below.
     *
     * Asking for "two past where we started" is immune to which of the two the
     * earlier read caught.
     */
    const afterTheirs = await waitForTurnAfter(page, mine.turnNumber + 1);
    expect(afterTheirs.turnNumber).toBeGreaterThanOrEqual(mine.turnNumber + 2);

    expect(consoleErrors(page), 'client console errors').toEqual([]);
    await solo.context.close();
  });

  test('the opening armoury does not claim a round just ended', async ({ browser }) => {
    /*
     * This panel is two screens, and until now it only had copy for one of
     * them. A match opens in the armoury — before a shell has been fired — and
     * the line under the heading read "Round over. Cash carries over, regrets
     * do not — and the shop only opens between rounds." On the first screen of
     * a match that is wrong twice: no round has ended, and the player is
     * standing in the counter-example to the second half.
     *
     * The between-rounds wording is asserted in `screenshot.spec.ts`, which
     * fights a real round to reach it.
     */
    const solo = await openPlayer(browser, 'Solo');
    const page = solo.page;
    await createRoom(solo);
    await addBot(page, 'moron');

    await page.getByTestId('btn-start').click();
    await expect(page.getByTestId('panel-shop')).toBeVisible({ timeout: 20_000 });

    const hint = page.getByTestId('shop-hint');
    await expect(hint).toContainText(/first shot/i);
    await expect(hint).not.toContainText(/is over/i);
    // The sentence that was simply false on this screen.
    await expect(hint).not.toContainText(/only opens between rounds/i);
    // And it is legible where it is, not merely present in the document.
    await expectClickable(page, 'shop-hint');

    expect(consoleErrors(page), 'client console errors').toEqual([]);
    await solo.context.close();
  });

  test('a server refusal is readable, and never lands on the weapon readout', async ({
    browser,
  }) => {
    /*
     * Two defects, one box.
     *
     * The toast was `position: fixed; top: 16px`, measured against the window —
     * whose top 46 pixels are the status line, with the weapon readout sitting
     * dead centre where a centred box lands. So "Reconnected." was painted
     * across "Baby Nuke ×4", and so was every server refusal, which is the only
     * way most of them ever reach the player at all.
     *
     * The refusal here is a real one from the real server rather than a string
     * poked into the DOM: the room's action budget is finite, and a client that
     * spends it gets `rate_limited` back. That is exactly the class of message
     * this box exists to carry.
     */
    test.setTimeout(150_000);

    const solo = await openPlayer(browser, 'Solo');
    const page = solo.page;
    await createRoom(solo);
    await addBot(page, 'moron');
    await startMatch(solo);
    await waitForSnapshot(page);
    await expect(page.getByTestId('hud')).toBeVisible();

    /*
     * Spend the room's action budget. Chat is a move, not chatter — deliberately
     * so, per the rate-limit split — and the room refuses past the budget.
     *
     * Submitted in one pass from inside the page rather than typed. The budget
     * is a token bucket over a rolling window, and Playwright's fill-and-press
     * costs about 180ms a line: sixty of them take eleven seconds, the window
     * turns over halfway through, and the room quite correctly never refuses
     * anything. This drives the client's own submit handler — the same path the
     * Enter key takes — just fast enough to actually be a flood.
     */
    const toast = page.getByTestId('toast');
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#chat-input');
      const form = document.querySelector<HTMLFormElement>('#chat-form');
      if (input === null || form === null) throw new Error('no chat box to talk in');
      for (let line = 0; line < 60; line += 1) {
        input.value = `spam ${line}`;
        form.requestSubmit();
      }
    });

    await expect(toast, 'the room never refused anything').toBeVisible({ timeout: 20_000 });

    const placed = await page.evaluate(() => {
      const rect = (selector: string): DOMRect | null =>
        document.querySelector(selector)?.getBoundingClientRect() ?? null;
      const overlap = (a: DOMRect, b: DOMRect): number =>
        Math.min(
          Math.min(a.right, b.right) - Math.max(a.left, b.left),
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
        );
      const toastRect = rect('#toast');
      const hud = rect('#hud');
      const weapon = rect('#hud-weapon');
      if (toastRect === null || hud === null || weapon === null) return null;
      return {
        text: document.querySelector('#toast')?.textContent ?? '',
        overHud: overlap(toastRect, hud),
        overWeapon: overlap(toastRect, weapon),
        onScreen:
          toastRect.top >= 0 &&
          toastRect.left >= 0 &&
          toastRect.bottom <= window.innerHeight &&
          toastRect.right <= window.innerWidth,
        height: toastRect.height,
      };
    });

    expect(placed, 'the toast or the HUD is not in the document').not.toBeNull();
    // It said something, and the something is the room's own words.
    expect(placed!.text.length).toBeGreaterThan(0);
    // Nowhere near the status line — not the strip, and not the readout in it.
    expect(
      placed!.overHud,
      `the notice "${placed!.text}" is sitting on the HUD`,
    ).toBeLessThanOrEqual(0);
    expect(placed!.overWeapon).toBeLessThanOrEqual(0);
    // …and all of it is inside the window, which is what "legible" needs first.
    expect(placed!.onScreen, `the notice "${placed!.text}" is partly off screen`).toBe(true);
    expect(placed!.height).toBeGreaterThan(10);

    // The readout it used to cover is still there to be read and still usable.
    await expectClickable(page, 'hud-weapon');

    await solo.context.close();
  });

  test('a room full of computer players never outruns the animation', async ({ browser }) => {
    /*
     * The regression that has no other symptom.
     *
     * `BOT_TURN_DELAY_MS` paced a bot's turn at 400–1000 ms while a turn takes
     * 840–1500 ms to animate. `BattleScene` queues turns with a backlog of
     * exactly one and drops the older one when overtaken — a sound design, and
     * the reason the board stayed correct throughout — so nothing about the game
     * state ever looked wrong. The player simply never saw a share of the shots.
     *
     * `window.__scorched.droppedTurns()` is the count of turns the scene was
     * handed faster than it could draw them, and zero is the claim.
     *
     * ---------------------------------------------------------------------
     * Why SEVEN Morons and not three of anything
     * ---------------------------------------------------------------------
     *
     * The first version of this test seated a Shooter, a Cyborg and an
     * Annihilator, and it passed with the fix REVERTED — the exact defect this
     * repository keeps finding in its own tests, caught by running the mutation
     * before believing it. Two reasons it could not fail:
     *
     *  - The backlog is one, so falling a single turn behind drops nothing. A
     *    deficit has to accumulate past a whole turn's animation before the
     *    player loses a shot.
     *  - The human resets it. On our turn the room waits for us, playback
     *    catches up, and the deficit goes back to zero — so a room where every
     *    fourth turn is a person's can never accumulate one.
     *
     * So the room is filled: seven machines between our turns, which is the
     * longest run this game can produce, and Morons because at 400 ms they have
     * the shortest pause in the table and therefore the largest deficit per
     * turn. Measured with the pacing reverted, that seats a real failure —
     * turns are dropped — and with it in place the count stays at zero.
     */
    test.setTimeout(240_000);

    const solo = await openPlayer(browser, 'Solo');
    const page = solo.page;
    await createRoom(solo);
    // As many as the room will seat, so the run of machine turns between two of
    // ours is as long as this game ever gets.
    for (let seat = 0; seat < 7; seat += 1) await addBot(page, 'moron');
    await expect(page.locator('#lobby-players li')).toHaveCount(8);
    await startMatch(solo);

    const opening = await waitForSnapshot(page);
    const you = await readSelf(page);
    let snapshot = opening;

    for (let step = 0; step < 40 && snapshot.turnNumber - opening.turnNumber < 16; step += 1) {
      snapshot = await readSnapshot(page);
      if (snapshot.phase !== 'aiming') break;

      if (snapshot.tanks[snapshot.activeTank]?.id === you) {
        await waitForOurTurn(page);
        const seat = snapshot.tanks.findIndex((tank) => tank.id === you);
        const aim = findLandingShot(snapshot, seat) ?? { angleDeg: 45, power: 70 };
        await setAim(page, aim.angleDeg, aim.power);
        await fire(page).catch(() => undefined);
      }
      await waitForTurnAfter(page, snapshot.turnNumber).catch(() => undefined);
    }

    const played = snapshot.turnNumber - opening.turnNumber;
    // Long enough to contain a full run of machine turns, which is the only
    // thing that can produce a drop.
    expect(played, 'the match never got going, so nothing was measured').toBeGreaterThanOrEqual(8);

    const dropped = await page.evaluate(() => {
      const handle = (window as unknown as { __scorched?: { droppedTurns(): number } }).__scorched;
      return handle === undefined ? -1 : handle.droppedTurns();
    });
    expect(
      dropped,
      `${dropped} of ${played} turns arrived faster than the client could draw them`,
    ).toBe(0);

    expect(consoleErrors(page), 'client console errors').toEqual([]);
    await solo.context.close();
  });

  test('a computer player can be taken back out again', async ({ browser }) => {
    const solo = await openPlayer(browser, 'Solo');
    const page = solo.page;
    await createRoom(solo);

    const first = await addBot(page, 'cyborg');
    const second = await addBot(page, 'tosser');
    await expect(page.locator('#lobby-players li')).toHaveCount(3);
    // Three rows fit in any window this suite runs in, so nothing is hidden and
    // the list must not be pretending otherwise — the paired half of the
    // "there is more below" fade asserted in the full-room test.
    await expect(page.locator('#lobby-players')).toHaveAttribute('data-more', '0');

    // The unranked pair are badged as such in the room too, not just in the
    // picker they were chosen from.
    await expect(page.getByTestId(`lobby-player-${second}`)).toContainText('specialist');
    await expect(page.getByTestId(`lobby-player-${first}`)).toContainText('3/4');

    /*
     * And the control that takes one back out is actually on the row, not past
     * its right-hand edge. It went there once: a badge 80px longer than the row
     * could hold pushed every row's contents wide, and the list — which clips —
     * cut the remove button and the Host tag off the end.
     */
    await expectClickable(page, `btn-remove-bot-${first}`);
    await expectClickable(page, `btn-remove-bot-${second}`);

    /*
     * …and on a window too narrow to hold the row's contents, which is where a
     * flex row decides who gives way. The seat name is the part that can be cut
     * short and still be understood; the control that removes the seat is not.
     */
    await page.setViewportSize({ width: 360, height: 740 });
    await expectClickable(page, `btn-remove-bot-${first}`);
    await expectClickable(page, `btn-remove-bot-${second}`);
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.getByTestId(`btn-remove-bot-${second}`).click();
    await expect(page.getByTestId(`lobby-player-${second}`)).toHaveCount(0);
    await expect(page.getByTestId(`lobby-player-${first}`)).toHaveCount(1);
    // Still a match: one human, one machine.
    await expect(page.getByTestId('btn-start')).toBeEnabled();

    await page.getByTestId(`btn-remove-bot-${first}`).click();
    await expect(page.locator('#lobby-players li')).toHaveCount(1);
    // …and back to the state the feature exists to get out of.
    await expect(page.getByTestId('btn-start')).toBeDisabled();

    expect(consoleErrors(page), 'client console errors').toEqual([]);
    await solo.context.close();
  });

  test('a full room stays usable, refuses another one, and says so on screen', async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    const solo = await openPlayer(browser, 'Solo');
    const page = solo.page;
    /*
     * The short window on purpose. A full room is the tallest this panel ever
     * gets, and 720 is where it stops fitting — the height at which the docked
     * chat bar covered the Start button and the refusal fell off the bottom of
     * the screen. Testing at the default 800 would have found neither.
     */
    await page.setViewportSize({ width: 1280, height: 720 });
    await createRoom(solo);

    /*
     * Fill it. The client does not know how many seats a room has and must not:
     * `MAX_PLAYERS` is the room's policy, so the only honest way to find the
     * ceiling from here is to walk into it. Keep adding until the room says no;
     * the state worth measuring is the last one, where the panel is tallest.
     */
    const CEILING = 32;
    let seated = 1;
    for (let attempt = 0; attempt < CEILING; attempt += 1) {
      await page.getByTestId('select-bot-personality').selectOption('shooter');
      await page.getByTestId('btn-add-bot').click();
      // Either a seat appeared or the room refused; whichever came first.
      await expect
        .poll(async () => {
          const rows = await page.locator('#lobby-players li').count();
          const refused = await page.getByTestId('lobby-error').isVisible();
          return rows > seated || refused;
        })
        .toBe(true);
      if (await page.getByTestId('lobby-error').isVisible()) break;
      seated = await page.locator('#lobby-players li').count();
    }

    /*
     * The refusal is the server's, shown where the button that earned it is, and
     * the host is still in their own room.
     *
     * That second half is the part worth having a test for. `room_full` also
     * means "this room has no seat for YOU", and that one bounces the player
     * back to the title screen — so a client that treated every `room_full` the
     * same way would throw the host out of the lobby for the crime of trying to
     * add a ninth player.
     */
    const error = page.getByTestId('lobby-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText(/seat/i);
    await expect(page.getByTestId('panel-lobby')).toBeVisible();
    await expect(page.getByTestId('panel-title')).toBeHidden();
    expect(seated, 'the room seated nobody at all').toBeGreaterThan(1);

    /*
     * …and both of those are on the SCREEN, which `toBeVisible` above does not
     * say. At eight seats this panel used to run 100px past the bottom of the
     * window: the refusal sat at y=737 in a 720px viewport, and the Start button
     * sat under the chat form. Playwright was happy with both.
     */
    await expectClickable(page, 'lobby-error');
    await expectClickable(page, 'btn-start');
    // The list is what gives when the room is full — everything else stays put.
    await expectClickable(page, 'btn-add-bot');
    await expectClickable(page, 'lobby-code');
    /*
     * And the traffic goes both ways: the panel does not cover the chat either.
     * The lobby is where people arrange a game, so a panel that grew over the
     * chat box would be the same bug with the layers swapped — which is exactly
     * what happens if the overlay is measured against the window instead of the
     * stage, since a full-height panel then paints across the bar.
     */
    await expectClickable(page, 'chat-input');

    /*
     * The list is the part that gave, and it says so. A seat list longer than
     * the space for it fades out at the cut instead of ending at a hard edge —
     * the same admission the armoury makes about its own scroll region.
     */
    await expect(page.locator('#lobby-players')).toHaveAttribute('data-more', '1');

    expect(consoleErrors(page), 'client console errors').toEqual([]);
    await solo.context.close();
  });

  test('the chat bar does not sit on the battlefield', async ({ browser }) => {
    test.setTimeout(120_000);

    const solo = await openPlayer(browser, 'Solo');
    const page = solo.page;
    await createRoom(solo);
    await addBot(page, 'shooter');
    await startMatch(solo);
    await waitForSnapshot(page);

    /*
     * The chat used to float over the bottom-left of the playfield: the input
     * box and its Send button sat on the terrain, across the exact corner a tank
     * can spawn in. Chrome that can cover a tank is a playability bug, and prose
     * about where a box "should" be is not evidence — so this measures the two
     * rectangles and asserts they do not overlap.
     */
    /*
     * Polled rather than measured once, because Phaser rescales the canvas to
     * fit on an animation frame: for a tick after the HUD appears the canvas is
     * still its old size, and a single measurement taken in that tick reports an
     * overlap that is a layout frame rather than a bug. Polling asks for the
     * settled answer. A chat that genuinely sits on the map never settles into a
     * clean one, so this still fails on the layout it was written to catch —
     * checked by putting the old `position: fixed` rule back.
     */
    const overlap = async (): Promise<number> => {
      const canvas = await page.locator('#game-root canvas').boundingBox();
      const chat = await page.getByTestId('chat').boundingBox();
      if (canvas === null || chat === null) return Number.POSITIVE_INFINITY;
      return Math.min(
        Math.min(canvas.x + canvas.width, chat.x + chat.width) - Math.max(canvas.x, chat.x),
        Math.min(canvas.y + canvas.height, chat.y + chat.height) - Math.max(canvas.y, chat.y),
      );
    };

    await expect
      .poll(overlap, { message: 'the chat bar is sitting on the playfield' })
      .toBeLessThanOrEqual(0.5);

    // And the playfield is still worth having: most of the window, not a strip.
    const canvas = await page.locator('#game-root canvas').boundingBox();
    expect(canvas?.height ?? 0).toBeGreaterThan(400);

    await solo.context.close();
  });

  test('a computer player firing mid-animation cannot rewind the board', async ({ browser }) => {
    test.setTimeout(150_000);

    /*
     * The race this defends against is the normal case once a room has a
     * computer player in it, and it is invisible to every other test here.
     *
     * The client animates a turn and applies the authoritative snapshot when the
     * animation finishes. A second `events` frame arriving mid-flight restarts
     * playback — but the animation it interrupted still resolves, a beat AFTER
     * the newer frame was handled, and its callback would then re-apply its own
     * older snapshot on top. The board goes back a turn and stays there for the
     * length of the newer animation, because the newer playback's own callback
     * is now the one that looks stale.
     *
     * `main.ts` guards it with an identity check. Left to the wire's own timing
     * the guard is untestable: the room takes the bot's turn a playback and a
     * pause after yours, which is usually just after your explosion has
     * finished. So the timing is made deterministic instead — the socket is
     * intercepted and the first turn's frame is HELD until the second one
     * exists, then released 200 ms ahead of it, putting the bot's shot squarely
     * inside the animation of ours on every run.
     *
     * ---------------------------------------------------------------------
     * Two ways that harness used to hang the page it was testing
     * ---------------------------------------------------------------------
     *
     * Both were reproduced before this rewrite, and both end the same way: a
     * wait burning its full timeout while the socket is healthy and the server
     * is idle — on every retry, on CI, and never on a laptop.
     *
     *  1. NOTHING RELEASED WHAT WAS HELD except the arrival of a second `events`
     *     frame. There is no rule that one ever arrives — the room falls silent
     *     whenever the next move is the human's — so a held frame could sit
     *     there forever with the page frozen behind it.
     *
     *     Demonstrated by arming the old harness on a ROUND-ENDING shot: the
     *     killing turn's frame was held, no successor ever came (the room went
     *     quiet waiting for Ready), and the page sat on `turn=4 phase=aiming`
     *     with the dead tank still drawn alive until the wait timed out.
     *     Reproduced twice out of two.
     *
     *     An earlier draft of this comment credited a different demonstration —
     *     arming one frame earlier, on the frame that opens round one — and that
     *     one does NOT hold: two `events` frames do arrive there, and it pairs
     *     in about 600 ms. The mechanism is real; that particular reproduction
     *     was not, and a confident sentence nobody re-ran is precisely the
     *     defect CLAUDE.md warns about.
     *
     *     The harness now releases on a DEADLINE as well, so no sequence of
     *     server frames can strand anything.
     *
     *  2. READING THE TWO TURN NUMBERS OFF THE CLIENT was a race in itself.
     *     `waitForTurnAfter` polls, so it reports whatever the page happens to
     *     be holding when it next looks — and the two frames are deliberately
     *     only 200 ms apart. Miss the first and it returns the SECOND turn,
     *     after which waiting for "one more than that" waits for a turn nobody
     *     is going to play: the room is waiting for the human, and the human is
     *     this test. Locally the margin was ~85 ms of the 200; compressing the
     *     gap to 20 ms reproduced it three times out of three. So the numbers
     *     now come from the frames themselves, in the harness, and the client is
     *     only ever asked "have you reached this turn yet" — a question that
     *     cannot be missed by arriving late.
     *
     * What holds the assertion up is that the ROUND cannot end on this
     * exchange, because a round that ends has no next turn to race against the
     * first. Both halves of that are arranged rather than hoped for: see the
     * Moron and the harmless shot below.
     */

    /** How far into the first turn's animation the second turn is delivered. */
    const RELEASE_GAP_MS = 200;
    /**
     * Longest the harness will hold a frame waiting for a partner.
     *
     * This is a safety net and not a schedule: the second turn lands about a
     * second after the first, so a run that reaches this has already failed at
     * something. What it buys is that the failure is a named, bounded one
     * rather than a frozen page.
     */
    const HOLD_LIMIT_MS = 20_000;
    /** …and how long this test waits for the harness to say anything at all. */
    const STAGING_LIMIT_MS = 25_000;

    /** The part of an `events` frame this test reasons about. */
    interface Turn {
      /** `snapshot.turnNumber` — the board the frame settles on. */
      readonly turnNumber: number;
      readonly health: readonly number[];
    }

    /** What the harness managed to stage, reported once it has stood down. */
    interface Staged {
      /**
       * `paired` is the race this test exists for. The other two are the ways
       * it could not be produced, and both are reported rather than waited out.
       */
      readonly mode: 'paired' | 'expired' | 'silent';
      readonly first: Turn | null;
      readonly second: Turn | null;
    }

    const solo = await openPlayer(browser, 'Solo');
    const page = solo.page;

    /** Frames the interceptor actually handled, so a route that never fires fails. */
    const intercepted: string[] = [];
    /**
     * Rescheduling is armed only for OUR shot.
     *
     * Turn order is drawn from the seed, so the computer player fires first
     * about half the time, and holding that frame back would be holding it
     * against the human's own move — which is not the race under test.
     */
    let armed = false;
    let first: Turn | null = null;
    let second: Turn | null = null;

    let publish!: (staged: Staged) => void;
    const staged = new Promise<Staged>((resolve) => {
      publish = resolve;
    });

    await page.routeWebSocket(/\/api\/rooms\/[A-Za-z]+\/ws/, (client) => {
      intercepted.push(client.url());
      // Page -> server is left alone and forwards itself; only the server's
      // side is rescheduled.
      const server = client.connectToServer();

      let phase: 'before' | 'holding' | 'releasing' | 'after' = 'before';
      let queue: (string | Buffer)[] = [];
      let limit: ReturnType<typeof setTimeout> | null = null;

      /** The turn a frame carries, or null if the frame is not a turn. */
      const turnOf = (frame: string | Buffer): Turn | null => {
        let parsed: {
          t?: string;
          snapshot?: { turnNumber?: number; tanks?: { health: number }[] };
        };
        try {
          parsed = JSON.parse(frame.toString()) as typeof parsed;
        } catch {
          return null;
        }
        const snapshot = parsed.snapshot;
        if (parsed.t !== 'events' || snapshot === undefined) return null;
        return {
          turnNumber: snapshot.turnNumber ?? -1,
          health: (snapshot.tanks ?? []).map((tank) => tank.health),
        };
      };

      /**
       * Hand everything back, in arrival order, and stop interfering.
       *
       * Every path out of the hold comes through here, which is the property
       * that matters: the page ends up with every frame the server sent it, on
       * a bounded delay, whatever the server did or did not go on to say.
       */
      const standDown = (mode: Staged['mode']): void => {
        if (limit !== null) {
          clearTimeout(limit);
          limit = null;
        }
        const pending = queue;
        queue = [];
        phase = 'after';
        for (const frame of pending) {
          // The page can be gone by the time a deadline fires; an exception out
          // of a timer would take the whole run with it.
          try {
            client.send(frame);
          } catch {
            break;
          }
        }
        publish({ mode, first, second });
      };

      server.onMessage((message) => {
        const turn = turnOf(message);

        if (!armed || phase === 'after') {
          client.send(message);
          return;
        }
        if (phase === 'before') {
          if (turn === null) {
            client.send(message);
            return;
          }
          first = turn;
          queue = [message];
          phase = 'holding';
          limit = setTimeout(() => standDown('expired'), HOLD_LIMIT_MS);
          return;
        }

        queue.push(message);
        if (phase === 'releasing' || turn === null) return;

        // `message` is the SECOND turn. Everything before it goes now; it and
        // anything that arrives during the gap go a beat later, inside the
        // first animation.
        second = turn;
        if (limit !== null) {
          clearTimeout(limit);
          limit = null;
        }
        const boundary = queue.length - 1;
        const early = queue.slice(0, boundary);
        queue = queue.slice(boundary);
        phase = 'releasing';
        for (const frame of early) client.send(frame);
        setTimeout(() => standDown('paired'), RELEASE_GAP_MS);
      });
    });

    /*
     * Reload, because the WebSocket shim Playwright installs for routing is a
     * document-start script: a page already open when the route is registered
     * keeps the browser's own `WebSocket` and is never intercepted at all. That
     * is not a footnote — the first version of this test routed nothing, held
     * nothing, and passed against a client with the guard deleted. `intercepted`
     * below is the assertion that stops that happening again silently.
     */
    await page.reload();
    await page.getByTestId('input-name').fill(solo.name);

    await createRoom(solo);
    /*
     * The Moron, and it is load-bearing rather than flavour.
     *
     * Its `weaponTierCap` is 0 and the only tier-0 gun in the arsenal is the
     * free Baby Missile, so whatever it buys, what it FIRES does 30 at ground
     * zero against 100 health. It cannot finish a full-health tank in one shot,
     * which is what guarantees there is a turn after ours for its frame to
     * carry. `expect(theirs.turnNumber)` below is where that stops being an
     * assumption.
     */
    await addBot(page, 'moron');
    await startMatch(solo);
    await waitForSnapshot(page);

    await waitForOurTurn(page);
    const mine = await readSnapshot(page);
    const you = await readSelf(page);
    const seat = mine.tanks.findIndex((tank) => tank.id === you);

    /*
     * Our half of "the round survives this exchange".
     *
     * `findLandingShot`, which this used to call, only promises a crater — the
     * shot it picks is free to land next to a tank, and in a sample of runs it
     * took 23 health off the SHOOTER. That is not lethal with a Baby Missile
     * either, but it makes the claim above depend on arithmetic across two
     * shots instead of on nobody being touched at all. `findHarmlessShot` picks
     * a landing spot outside the reach of both the blast and its crater, so the
     * board's health column is untouched by our turn.
     */
    const aim = findHarmlessShot(mine, seat);
    expect(aim, 'no shot on this map lands clear of every tank').not.toBeNull();
    await setAim(page, aim!.angleDeg, aim!.power);

    armed = true;
    await fire(page);

    /*
     * Whatever happens next, this resolves: the harness reports on its own
     * deadline, and this waits a little past it so that a harness that somehow
     * never saw a frame is also a message rather than a hung test.
     */
    const race = await Promise.race([
      staged,
      new Promise<Staged>((resolve) => {
        setTimeout(() => resolve({ mode: 'silent', first, second }), STAGING_LIMIT_MS);
      }),
    ]);

    expect(intercepted, 'the socket was never routed — nothing was rescheduled').toHaveLength(1);
    expect(
      race.mode,
      race.mode === 'silent'
        ? 'our shot never came back as a turn at all'
        : 'the computer player never answered, so no second frame was there to race',
    ).toBe('paired');

    const ours = race.first as Turn;
    const theirs = race.second as Turn;

    // The two preconditions, stated as assertions because everything below is
    // meaningless without them: our shot hurt nobody, and the round is still
    // running afterwards — a round that ended would leave both frames sitting
    // on the same turn number and nothing to notice a rewind with.
    expect(ours.health, 'the shot chosen to touch nobody took health off somebody').toEqual(
      mine.tanks.map((tank) => tank.health),
    );
    expect(
      theirs.turnNumber,
      'the exchange did not advance the board, so there was no newer turn to go back from',
    ).toBeGreaterThan(ours.turnNumber);

    /*
     * Read as "have you reached this turn yet", never as "catch it going past".
     * The frames are 200 ms apart on purpose and a poll that has to see the
     * first one before the second arrives is the race that used to hang this
     * test on CI.
     */
    await page.waitForFunction(
      (turnNumber) => {
        const handle = (
          window as unknown as { __scorched?: { snapshot(): { turnNumber: number } | null } }
        ).__scorched;
        const seen = handle?.snapshot()?.turnNumber;
        return typeof seen === 'number' && seen >= turnNumber;
      },
      theirs.turnNumber,
      { timeout: 30_000 },
    );

    /*
     * Both animations are still running at this point — the turn counter moves
     * when the frame ARRIVES, not when the explosion finishes. The rewind
     * happens when the first one lands, and lasts as long as the second one
     * takes to play, so the assertion is sampled the whole way there rather
     * than peeked at once.
     */
    const rewound = await page.evaluate(async (floor: number) => {
      const handle = (
        window as unknown as { __scorched?: { snapshot(): { turnNumber: number } | null } }
      ).__scorched;
      const seen: number[] = [];
      for (let sample = 0; sample < 80; sample += 1) {
        const turnNumber = handle?.snapshot()?.turnNumber;
        if (typeof turnNumber === 'number') seen.push(turnNumber);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { below: seen.filter((turnNumber) => turnNumber < floor), last: seen.at(-1) };
    }, theirs.turnNumber);

    expect(
      rewound.below,
      `the board went back to turn ${rewound.below[0]} after reaching ${theirs.turnNumber}`,
    ).toEqual([]);
    expect(rewound.last, 'the board settled on an older turn').toBeGreaterThanOrEqual(
      theirs.turnNumber,
    );

    expect(consoleErrors(page), 'client console errors').toEqual([]);
    await solo.context.close();
  });
});
