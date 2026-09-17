/**
 * Public rooms, end to end: somebody opening the game sees on the title screen
 * that people are playing, walks into a lobby nobody read them a code for, and
 * the room talks before the host starts.
 *
 * Runs against a real `wrangler dev`, which every spec in this suite shares, so
 * the public list may contain other specs' rooms. Nothing here asserts which
 * rooms are listed beyond the ones a test made itself.
 *
 * The title screen refreshes the list on its own every few seconds and offers no
 * button to hurry it along, so a test waiting for a change waits for that tick.
 * The polls below are therefore generous: they are waiting on a timer, not on a
 * round trip.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  consoleErrors,
  createRoom,
  expectClickable,
  hostPublicRooms,
  openPlayer,
  startMatch,
  waitForSnapshot,
  type PlayerSession,
} from './helpers.ts';

const LIST_TIMEOUT = { timeout: 20_000 };
const POLL = { timeout: 40_000, intervals: [500, 1_000, 2_000] };

async function createPublicRoom(session: PlayerSession): Promise<string> {
  await session.page.getByTestId('input-public').check();
  return createRoom(session);
}

/** Show every listed room, so a row is findable however far down it sorts. */
async function expandRooms(page: Page): Promise<void> {
  const more = page.getByTestId('btn-rooms-more');
  if ((await more.isVisible()) && (await more.getAttribute('aria-expanded')) === 'false') {
    await more.click();
  }
}

/** The title screen's row for a room, refreshing and expanding until it shows up. */
async function findRoom(page: Page, roomCode: string): Promise<Locator> {
  const row = page.getByTestId(`public-room-${roomCode}`);
  await expect
    .poll(async () => {
      if (await row.isVisible()) return true;
      await expandRooms(page);
      return row.isVisible();
    }, POLL)
    .toBe(true);
  return row;
}

/** The room is not listed at all — checked with the list expanded, so "collapsed" cannot pass for "gone". */
async function expectNoRoom(page: Page, roomCode: string): Promise<void> {
  await expect
    .poll(async () => {
      await expect(page.getByTestId('title-rooms-summary')).not.toHaveText(/looking/i);
      await expandRooms(page);
      return page.getByTestId(`public-room-${roomCode}`).count();
    }, POLL)
    .toBe(0);
}

async function listedTotal(page: Page): Promise<number> {
  return Number((await page.getByTestId('title-rooms-list').getAttribute('data-total')) ?? '0');
}

async function say(page: Page, text: string): Promise<void> {
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-send').click();
}

test.describe('public rooms', () => {
  test('the title screen shows a public lobby, and a stranger walks straight in and talks', async ({
    browser,
  }) => {
    const alice = await openPlayer(browser, 'Alice');
    const carol = await openPlayer(browser, 'Carol');
    const bob = await openPlayer(browser, 'Bob');

    const publicCode = await createPublicRoom(alice);
    await expect(alice.page.getByTestId('btn-visibility-public')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(alice.page.getByTestId('lobby-eyebrow')).toContainText(/public/i);

    // The default is still an invite-only room, and it must stay unlisted.
    const privateCode = await createRoom(carol);

    // Bob never leaves the title screen to find it.
    const row = await findRoom(bob.page, publicCode);
    await expect(row).toContainText("Alice's room");
    await expect(row).toContainText('1/8 seats');
    await expect(bob.page.getByTestId('title-rooms-live')).toContainText(/live/i);
    await expect(bob.page.getByTestId('title-rooms-summary')).toContainText(/waiting for players/i);
    await expectNoRoom(bob.page, privateCode);
    // Create room and Join sit on the same screen, both on it at once.
    await expectClickable(bob.page, 'btn-create');
    await expectClickable(bob.page, `btn-join-${publicCode}`);

    await bob.page.getByTestId(`btn-join-${publicCode}`).click();
    await expect(bob.page.getByTestId('panel-lobby')).toBeVisible();
    await expect(bob.page.getByTestId('lobby-code')).toHaveText(publicCode, LIST_TIMEOUT);
    await expect(alice.page.getByTestId('lobby-players').locator('li')).toHaveCount(2);
    await expect(bob.page.getByTestId('lobby-players').locator('li')).toHaveCount(2);

    // Everybody can see the room is public; only the host can change it.
    await expect(bob.page.getByTestId('btn-visibility-public')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(bob.page.getByTestId('btn-visibility-private')).toBeDisabled();

    // The host is told somebody arrived.
    await expect(alice.page.getByTestId('chat-log')).toContainText('Bob joined the room.');

    // The chat is IN the lobby panel, and on screen, for both of them.
    await expect(alice.page.getByTestId('lobby-chat').getByTestId('chat-input')).toBeVisible();
    await expectClickable(alice.page, 'chat-input');
    await expectClickable(bob.page, 'chat-input');

    await say(bob.page, 'hi all, first time here');
    await expect(alice.page.getByTestId('chat-log')).toContainText('Bob: hi all, first time here');
    await say(alice.page, 'welcome! starting in a sec');
    await expect(bob.page.getByTestId('chat-log')).toContainText(
      'Alice: welcome! starting in a sec',
    );

    // A guest cannot start the match; the host can.
    await expect(bob.page.getByTestId('btn-start')).toBeDisabled();
    await startMatch(alice, bob);

    // The conversation came with them onto the battlefield.
    await expect(bob.page.getByTestId('chat-log')).toContainText('hi all, first time here');

    expect(consoleErrors(alice.page), 'client console errors').toEqual([]);
    expect(consoleErrors(bob.page), 'client console errors').toEqual([]);
    await alice.context.close();
    await bob.context.close();
    await carol.context.close();
  });

  test('the title screen shows a few rooms, and the rest when asked', async ({ browser }) => {
    test.setTimeout(120_000);

    // More rooms than the card shows by default, whatever that number is. They
    // are held open from this very page — see `hostPublicRooms` for why not from
    // five more browser windows.
    const viewer = await openPlayer(browser, 'Viewer');
    const codes = await hostPublicRooms(viewer.page, 5);

    const list = viewer.page.getByTestId('title-rooms-list');
    await expect
      .poll(async () => {
        return listedTotal(viewer.page);
      }, POLL)
      .toBeGreaterThanOrEqual(codes.length);

    const more = viewer.page.getByTestId('btn-rooms-more');
    await expect(more).toHaveAttribute('aria-expanded', 'false');

    // Collapsed: SOME of them — at least one to join, fewer than all.
    const total = await listedTotal(viewer.page);
    const collapsed = await list.locator('li').count();
    expect(collapsed, 'the collapsed card shows nothing to join').toBeGreaterThan(0);
    expect(collapsed, 'the collapsed card shows every room anyway').toBeLessThan(total);
    await expect(more).toContainText(`Show all ${total} rooms`);
    // …and what it does show are the ones you can sit down in.
    for (const status of await list
      .locator('li')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-status')))) {
      expect(status).toBe('open');
    }

    // Expanded, in place: every room, including each one opened above.
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(list.locator('li')).toHaveCount(await listedTotal(viewer.page));
    for (const code of codes) {
      await expect(viewer.page.getByTestId(`public-room-${code}`)).toBeVisible();
    }
    // Still the title screen: nothing was navigated away from.
    await expect(viewer.page.getByTestId('panel-title')).toBeVisible();
    await expectClickable(viewer.page, 'btn-create');

    // …and back down again.
    await more.click();
    await expect(list.locator('li')).toHaveCount(collapsed);

    expect(consoleErrors(viewer.page), 'client console errors').toEqual([]);
    await viewer.context.close();
  });

  test('the host decides who can find the room, and the list follows it', async ({ browser }) => {
    const alice = await openPlayer(browser, 'Alice');
    const dave = await openPlayer(browser, 'Dave');

    const code = await createPublicRoom(alice);
    await findRoom(dave.page, code);

    // Private: gone from the list.
    await alice.page.getByTestId('btn-visibility-private').click();
    await expect(alice.page.getByTestId('btn-visibility-private')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expectNoRoom(dave.page, code);

    // Public again: back.
    await alice.page.getByTestId('btn-visibility-public').click();
    const row = await findRoom(dave.page, code);
    await expect(row).toHaveAttribute('data-status', 'open');

    // Once the match starts the row says so, and offers to watch instead.
    await alice.page.getByTestId('select-bot-personality').selectOption('moron');
    await alice.page.getByTestId('btn-add-bot').click();
    await expect(alice.page.getByTestId('lobby-players').locator('li')).toHaveCount(2);
    await alice.page.getByTestId('btn-start').click();
    await expect(alice.page.getByTestId('panel-shop')).toBeVisible(LIST_TIMEOUT);

    await expect
      .poll(async () => {
        await expandRooms(dave.page);
        return dave.page.getByTestId(`public-room-${code}`).getAttribute('data-status');
      }, POLL)
      .toBe('playing');
    await expect(dave.page.getByTestId(`btn-join-${code}`)).toHaveText('Watch');

    await dave.page.getByTestId(`btn-join-${code}`).click();
    await waitForSnapshot(dave.page);

    expect(consoleErrors(dave.page), 'client console errors').toEqual([]);
    await alice.context.close();
    await dave.context.close();
  });

  test('a public lobby everybody has left is taken off the list', async ({ browser }) => {
    const alice = await openPlayer(browser, 'Alice');
    const erin = await openPlayer(browser, 'Erin');

    const code = await createPublicRoom(alice);
    await findRoom(erin.page, code);

    await alice.page.getByTestId('btn-leave').click();
    await expect(alice.page.getByTestId('panel-title')).toBeVisible();

    await expectNoRoom(erin.page, code);
    // Alice is back on the title screen too, and her old room is not offered to her.
    await expectNoRoom(alice.page, code);

    await alice.context.close();
    await erin.context.close();
  });
});
