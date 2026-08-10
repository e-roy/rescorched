/**
 * The end-to-end contract from TECH_STACK.md:
 *   "two browser contexts join one room, play a complete turn, both see the
 *    same crater. Also: reconnect mid-game, refuse illegal moves."
 *
 * Runs against a real `wrangler dev` — real workerd, real Durable Object, real
 * WebSockets.
 */

import { expect, test } from '@playwright/test';
import {
  cheat,
  consoleErrors,
  createRoom,
  expectClickable,
  fire,
  joinRoom,
  openPlayer,
  findLandingShot,
  predictShot,
  readSelf,
  readSnapshot,
  rejoinRoom,
  setAim,
  startMatch,
  terrainFingerprint,
  waitForOurTurn,
  waitForSnapshot,
  waitForTurnAfter,
} from './helpers.ts';

test.describe('two players, one room', () => {
  test('both contexts join, play a turn, and observe the identical crater', async ({ browser }) => {
    const alice = await openPlayer(browser, 'Alice');
    const bob = await openPlayer(browser, 'Bob');

    const roomCode = await createRoom(alice);
    await joinRoom(bob, roomCode);

    // Both see two players in the lobby.
    await expect(alice.page.getByTestId('lobby-players').locator('li')).toHaveCount(2);
    await expect(bob.page.getByTestId('lobby-players').locator('li')).toHaveCount(2);

    await startMatch(alice, bob);

    const before = await waitForSnapshot(alice.page);
    await waitForSnapshot(bob.page);
    expect(before.phase).toBe('aiming');

    const terrainBefore = terrainFingerprint(before);

    // Whoever is first fires a shot the shared sim says will actually carve
    // ground. Picking the aim from the sim rather than hardcoding it is what
    // keeps this test about the crater agreeing, not about the map cooperating.
    const activePage =
      before.tanks[before.activeTank]?.id === (await readSelf(alice.page)) ? alice.page : bob.page;
    await waitForOurTurn(activePage);

    const shot = findLandingShot(before, before.activeTank);
    expect(shot, 'no angle/power in the sweep lands on terrain').not.toBeNull();
    await setAim(activePage, shot!.angleDeg, shot!.power);
    await fire(activePage);

    const aliceAfter = await waitForTurnAfter(alice.page, before.turnNumber);
    const bobAfter = await waitForTurnAfter(bob.page, before.turnNumber);

    // The turn actually advanced.
    expect(aliceAfter.turnNumber).toBe(before.turnNumber + 1);

    // The terrain changed …
    const terrainAfter = terrainFingerprint(aliceAfter);
    expect(terrainAfter).not.toBe(terrainBefore);

    // … and both players see EXACTLY the same terrain, column for column.
    expect(terrainFingerprint(bobAfter)).toBe(terrainAfter);
    expect(bobAfter.terrain.surface).toEqual(aliceAfter.terrain.surface);

    // And the same tank state.
    expect(bobAfter.tanks.map((tank) => [tank.id, tank.health, tank.x, tank.y])).toEqual(
      aliceAfter.tanks.map((tank) => [tank.id, tank.health, tank.x, tank.y]),
    );

    expect(consoleErrors(alice.page), 'client console errors').toEqual([]);
    expect(consoleErrors(bob.page), 'client console errors').toEqual([]);

    await alice.context.close();
    await bob.context.close();
  });

  test('a shot lands exactly where the shared sim predicts it will', async ({ browser }) => {
    // This is the whole architecture in one assertion. The test runs
    // `@scorched/sim` locally to predict an impact point; the server runs the
    // same code inside workerd and broadcasts what really happened. If those
    // ever disagree, determinism is broken and every other guarantee with it.
    const alice = await openPlayer(browser, 'Alice');
    const bob = await openPlayer(browser, 'Bob');
    const roomCode = await createRoom(alice);
    await joinRoom(bob, roomCode);
    await startMatch(alice, bob);

    const before = await waitForSnapshot(alice.page);
    const aliceId = await readSelf(alice.page);
    const shooterIndex = before.activeTank;
    const page = before.tanks[shooterIndex]?.id === aliceId ? alice.page : bob.page;
    await waitForOurTurn(page);

    const shot = findLandingShot(before, shooterIndex);
    expect(shot, 'no angle/power in the sweep lands on terrain').not.toBeNull();
    const { angleDeg, power } = shot!;
    const predicted = predictShot(before, shooterIndex, angleDeg, power, 'baby_missile');
    expect(predicted.kind, 'the test shot should actually connect').not.toBe('wall');

    await setAim(page, angleDeg, power);
    await fire(page);
    const after = await waitForTurnAfter(page, before.turnNumber);

    // Not "roughly the same crater" — the SAME heightmap, every column.
    expect(after.terrain.surface).toEqual(predicted.surface);

    // And it really did change something, so the comparison is not vacuous.
    expect(after.terrain.surface).not.toEqual(before.terrain.surface);

    await alice.context.close();
    await bob.context.close();
  });

  test('the server refuses an illegal move even from a cheating client', async ({ browser }) => {
    const alice = await openPlayer(browser, 'Alice');
    const bob = await openPlayer(browser, 'Bob');
    const roomCode = await createRoom(alice);
    await joinRoom(bob, roomCode);
    await startMatch(alice, bob);

    const before = await waitForSnapshot(bob.page);
    const bobId = await readSelf(bob.page);
    const aliceId = await readSelf(alice.page);
    const activeId = before.tanks[before.activeTank]?.id;

    // The offender is whoever it is NOT the turn of.
    const offender = activeId === bobId ? alice : bob;
    const offenderId = activeId === bobId ? aliceId : bobId;

    // The UI already refuses: the Fire button is disabled off-turn.
    await expect(offender.page.getByTestId('fire-button')).toBeDisabled();

    // Now bypass the UI entirely. Open a raw socket, do the handshake with the
    // offender's own session id, and fire out of turn — exactly what a patched
    // client would do. The server must say no.
    const verdict = await cheat(offender.page, roomCode, offenderId, {
      t: 'fire',
      turnNumber: before.turnNumber,
      angleDeg: 45,
      power: 75,
      weapon: 'baby_missile',
    });

    /*
     * Refused — the exact code depends on how far the frame gets.
     *
     * `not_your_turn` is the game logic saying no. `spectator_only` is the room
     * saying no sooner: a seat holds one socket, so a SECOND live connection
     * carrying an existing session id is seated as a spectator rather than
     * handed the tank. Both are correct refusals and the second is the stronger
     * one, so this asserts the property (the frame was rejected) rather than
     * pinning which layer got there first.
     *
     * The per-code behaviour is not lost: apps/server/test/game-room.test.ts
     * exercises not_your_turn, stale_turn and no_ammo directly against the room,
     * where a test can hold exactly one socket per seat and say precisely which
     * rule fired.
     */
    expect(verdict.t).toBe('error');
    expect(['not_your_turn', 'spectator_only']).toContain(verdict.code);

    // An out-of-range angle never even reaches the game logic — schema
    // validation runs before any question of seats or turns, so this one is
    // refused identically whether the socket is seated or spectating.
    const badAngle = await cheat(offender.page, roomCode, activeId ?? '', {
      t: 'fire',
      turnNumber: before.turnNumber,
      angleDeg: 9999,
      power: 75,
      weapon: 'baby_missile',
    });
    expect(badAngle.code).toBe('bad_message');

    // And the authoritative state never budged.
    const after = await readSnapshot(offender.page);
    expect(after.turnNumber).toBe(before.turnNumber);
    expect(after.terrain.surface).toEqual(before.terrain.surface);
    expect(after.tanks.map((tank) => tank.health)).toEqual(before.tanks.map((tank) => tank.health));

    await alice.context.close();
    await bob.context.close();
  });

  test('a room code that does not exist is refused, not created', async ({ browser }) => {
    /*
     * The defect: a typo in a friend's room code dropped the player into a
     * brand new, empty room that looked exactly like the one their friend was
     * waiting in — same lobby, same "waiting for players", same everything —
     * and the two of them then sat in separate rooms wondering where the other
     * one was.
     *
     * The Worker resolves any well-formed code to a Durable Object, so "does
     * not exist" cannot be discovered; it has to be decided and said. Creating
     * a room is a different act with its own door (`POST /api/rooms`), and the
     * assertions below are the two halves of the fix: the player is told, and
     * the room they failed to find still does not exist afterwards.
     */
    const alice = await openPlayer(browser, 'Alice');
    const bob = await openPlayer(browser, 'Bob');

    // Four letters, well-formed, and never minted: the client's own format
    // check passes it straight through to the server, which is the point.
    const typo = 'QZQZ';
    await alice.page.getByTestId('input-room').fill(typo);
    await alice.page.getByTestId('btn-join').click();

    const refusal = alice.page.getByTestId('title-error');
    await expect(refusal).toBeVisible({ timeout: 20_000 });
    await expect(refusal).toContainText(/no room/i);
    // Told where they are, not silently seated somewhere else.
    await expect(alice.page.getByTestId('panel-title')).toBeVisible();
    await expect(alice.page.getByTestId('panel-lobby')).toBeHidden();
    // And the message is on the screen rather than merely in the document.
    await expectClickable(alice.page, 'title-error');

    /*
     * The refusal did not quietly bring the room into being either. If it had,
     * this second player would now join "Alice's room" — which is the original
     * defect wearing an error message.
     */
    await bob.page.getByTestId('input-room').fill(typo);
    await bob.page.getByTestId('btn-join').click();
    await expect(bob.page.getByTestId('title-error')).toContainText(/no room/i, {
      timeout: 20_000,
    });
    await expect(bob.page.getByTestId('panel-lobby')).toBeHidden();

    // …and the flow this must not have broken: create a room, join it by code.
    const roomCode = await createRoom(alice);
    await joinRoom(bob, roomCode);
    await expect(alice.page.getByTestId('lobby-players').locator('li')).toHaveCount(2);

    expect(consoleErrors(alice.page), 'client console errors').toEqual([]);
    await alice.context.close();
    await bob.context.close();
  });

  test('a player who reloads mid-game gets their tank and the live state back', async ({
    browser,
  }) => {
    const alice = await openPlayer(browser, 'Alice');
    const bob = await openPlayer(browser, 'Bob');
    const roomCode = await createRoom(alice);
    await joinRoom(bob, roomCode);
    await startMatch(alice, bob);

    const before = await waitForSnapshot(bob.page);
    const bobId = await readSelf(bob.page);
    const bobTankBefore = before.tanks.find((tank) => tank.id === bobId);
    expect(bobTankBefore).toBeDefined();

    // Bob's browser reloads — new socket, same session id from localStorage.
    await bob.page.reload();
    await bob.page.getByTestId('input-name').fill('Bob');
    // Rejoining a live match must land on the battlefield, not back in the lobby.
    await rejoinRoom(bob, roomCode);

    const after = await waitForSnapshot(bob.page);
    const bobIdAfter = await readSelf(bob.page);

    expect(bobIdAfter).toBe(bobId);
    const bobTankAfter = after.tanks.find((tank) => tank.id === bobId);
    expect(bobTankAfter?.x).toBe(bobTankBefore?.x);
    expect(bobTankAfter?.health).toBe(bobTankBefore?.health);
    expect(after.turnNumber).toBe(before.turnNumber);
    // The terrain he comes back to is the same terrain everyone else is on.
    expect(after.terrain.surface).toEqual(before.terrain.surface);

    // And he can still take his turn: the game is genuinely resumed, not a
    // read-only replay.
    await waitForOurTurn(alice.page).catch(() => undefined);
    const live = await readSnapshot(bob.page);
    const activeIsBob = live.tanks[live.activeTank]?.id === bobId;
    if (activeIsBob) {
      await waitForOurTurn(bob.page);
      await setAim(bob.page, 60, 70);
      await fire(bob.page);
      const played = await waitForTurnAfter(bob.page, live.turnNumber);
      expect(played.turnNumber).toBe(live.turnNumber + 1);
    }

    await alice.context.close();
    await bob.context.close();
  });
});
