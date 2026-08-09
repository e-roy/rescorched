/**
 * One person, one computer player, a real match.
 *
 * This is the feature's reason for existing, checked against the real stack:
 * Vite-built client, `wrangler dev`, real workerd, a real Durable Object with
 * real alarms and real WebSockets. Before this the game needed two humans
 * before anything happened at all.
 *
 * ---------------------------------------------------------------------------
 * Why the human here is a raw socket rather than the game's own UI
 * ---------------------------------------------------------------------------
 *
 * The lobby has no "add a computer player" button yet — that is a separate,
 * later piece of client work — so there is no way to drive `addBot` by clicking
 * anything. The frame has to be sent by hand.
 *
 * That is not a shortcut around the product: it is the same thing
 * `helpers.cheat` does, and every frame below goes through the real protocol
 * parser on the way in and the real `parseServerMessage` on the way back, so
 * nothing here is trusted that a client would not be. And the REAL client is
 * still in the test: it joins the finished bot match as a spectator, renders
 * it, and is asserted to agree with the server column for column.
 *
 * When the lobby grows the button, the driver below should be deleted and this
 * file rewritten to click it.
 */

import { expect, test, type Page } from '@playwright/test';
import { parseServerMessage, PROTOCOL_VERSION, type ServerMessage } from '@scorched/protocol';

import {
  consoleErrors,
  openPlayer,
  predictShot,
  readSnapshot,
  rejoinRoom,
  terrainFingerprint,
} from './helpers.ts';

/**
 * The snapshot as the protocol defines it, which is richer than the reading
 * helpers need: it carries `angleDeg` and `power`, and those are the numbers
 * that say what the bot actually aimed. Taken from the schema rather than
 * re-declared, so it cannot drift from what the server sends.
 */
type WireSnapshot = Extract<ServerMessage, { t: 'state' }>['snapshot'];

interface Transcript {
  /** The player id the room welcomed the driver as. */
  you: string;
  /** The seat the room filled with a computer player. */
  botId: string;
  /** Every frame the room sent, exactly as it arrived on the wire. */
  raw: string[];
}

/**
 * Play a solo-plus-bot match from inside the page, over a raw WebSocket.
 *
 * Returns the whole conversation rather than a verdict, so the assertions live
 * in the test where they can be read, and so every frame can be pushed back
 * through the protocol parser in Node.
 */
async function playSoloVersusBot(
  page: Page,
  roomCode: string,
  personality: string,
  humanShots: number,
): Promise<Transcript> {
  return page.evaluate(
    async ({ room, version, personality: bot, shots }) => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${scheme}//${location.host}/api/rooms/${room}/ws`);
      const raw: string[] = [];
      const frames: Record<string, unknown>[] = [];

      const opened = new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve());
        socket.addEventListener('error', () => reject(new Error('bot driver socket errored')));
      });
      socket.addEventListener('message', (event) => {
        const text = String(event.data);
        raw.push(text);
        frames.push(JSON.parse(text) as Record<string, unknown>);
      });

      const send = (message: unknown): void => socket.send(JSON.stringify(message));

      /** Wait for the first frame after `from` that matches. */
      const waitFor = async (
        match: (frame: Record<string, unknown>) => boolean,
        from: number,
        label: string,
      ): Promise<Record<string, unknown>> => {
        const deadline = Date.now() + 30_000;
        for (;;) {
          for (let index = from; index < frames.length; index += 1) {
            const frame = frames[index] as Record<string, unknown>;
            if (match(frame)) return frame;
          }
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };

      await opened;
      send({ t: 'hello', protocol: version, name: 'Solo' });
      const welcome = await waitFor((f) => f['t'] === 'welcome', 0, 'welcome');
      const you = welcome['you'] as string;

      send({ t: 'addBot', personality: bot });
      const lobby = await waitFor(
        (f) => f['t'] === 'lobby' && (f['players'] as unknown[]).length === 2,
        0,
        'a lobby with two seats',
      );
      const seats = lobby['players'] as { id: string; bot?: string | null }[];
      const seat = seats.find((player) => player.bot != null);
      if (seat === undefined) throw new Error('the room seated no computer player');

      send({ t: 'start' });
      const started = await waitFor((f) => f['t'] === 'state', 0, 'the opening state');
      let snapshot = started['snapshot'] as {
        phase: string;
        turnNumber: number;
        activeTank: number;
        tanks: { id: string }[];
      };

      // Play until the human has fired `shots` times and the turn is back with
      // the human — so nothing is left pending when the socket closes.
      let fired = 0;
      for (let step = 0; step < 12; step += 1) {
        if (snapshot.phase !== 'aiming') break;
        const active = snapshot.tanks[snapshot.activeTank];
        if (active === undefined) break;

        if (active.id === you) {
          if (fired >= shots) break;
          fired += 1;
          send({
            t: 'fire',
            turnNumber: snapshot.turnNumber,
            angleDeg: 50,
            power: 65,
            weapon: 'baby_missile',
          });
        }

        const cursor = frames.length;
        const events = await waitFor((f) => f['t'] === 'events', cursor, 'a turn to resolve');
        snapshot = events['snapshot'] as typeof snapshot;
      }

      socket.close();
      return { you, botId: seat.id, raw };
    },
    { room: roomCode, version: PROTOCOL_VERSION, personality, shots: humanShots },
  );
}

/** Parse the transcript with the real client-side parser. Nothing is trusted raw. */
function parseTranscript(transcript: Transcript): ServerMessage[] {
  return transcript.raw.map((text) => {
    const parsed = parseServerMessage(text);
    expect(parsed.ok, parsed.ok ? '' : `server sent an unparseable frame: ${parsed.error}`).toBe(
      true,
    );
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  });
}

/** Ask the worker for a room code the way the client's Create button does. */
async function allocateRoom(page: Page): Promise<string> {
  const code = await page.evaluate(async () => {
    const response = await fetch('/api/rooms', { method: 'POST' });
    return ((await response.json()) as { roomCode: string }).roomCode;
  });
  expect(code).toMatch(/^[A-Z]{4}$/);
  return code;
}

test.describe('one human, one computer player', () => {
  test('plays a real match, and every bot shot lands where the shared sim says', async ({
    browser,
  }) => {
    const solo = await openPlayer(browser, 'Solo');
    const roomCode = await allocateRoom(solo.page);

    const transcript = await playSoloVersusBot(solo.page, roomCode, 'annihilator', 2);
    const frames = parseTranscript(transcript);

    // The lobby really did seat a computer player, and said so on the wire.
    const lobby = frames.find((frame) => frame.t === 'lobby' && frame.players.length === 2);
    expect(lobby, 'no lobby frame with two seats').toBeDefined();
    if (lobby?.t === 'lobby') {
      const seat = lobby.players.find((player) => player.id === transcript.botId);
      expect(seat?.bot).toBe('annihilator');
      // …and it is not the human's seat wearing a label.
      expect(lobby.players.find((player) => player.id === transcript.you)?.bot ?? null).toBe(null);
    }

    // Walk the turns. Every `events` frame is preceded by a snapshot, so a shot
    // can be replayed locally from the state it was fired in.
    const snapshots: WireSnapshot[] = [];
    let botTurns = 0;
    let botIndex = -1;

    for (const frame of frames) {
      if (frame.t === 'state') {
        snapshots.push(frame.snapshot);
        continue;
      }
      if (frame.t !== 'events') continue;

      const before = snapshots[snapshots.length - 1];
      const after = frame.snapshot;
      snapshots.push(after);
      if (before === undefined) continue;

      const shot = frame.events.find((event) => event.type === 'shot');
      if (shot?.type !== 'shot') continue;
      if (before.tanks[shot.tankIndex]?.id !== transcript.botId) continue;

      botTurns += 1;
      botIndex = shot.tankIndex;

      /*
       * The architecture in one assertion, for a shot no human chose.
       *
       * `fire()` writes the aim it resolved onto the tank, so the post-turn
       * snapshot carries the exact angle and power the bot picked. Replaying
       * that shot here — through the same `@scorched/sim` the Durable Object
       * ran — must reproduce the server's heightmap column for column. If a
       * bot's aim were computed anywhere non-deterministic, this is where two
       * machines would part company.
       */
      const tank = after.tanks[shot.tankIndex];
      expect(tank, 'the bot has no tank in the snapshot after its own shot').toBeDefined();
      const predicted = predictShot(
        before,
        shot.tankIndex,
        tank?.angleDeg ?? 0,
        tank?.power ?? 0,
        shot.weapon,
      );
      expect(
        after.terrain.surface,
        `bot turn ${botTurns} (${shot.impactKind}) diverged from the local replay`,
      ).toEqual(predicted.surface);
    }

    // The match was genuinely played: the bot took turns of its own.
    expect(botTurns, 'the computer player never fired').toBeGreaterThanOrEqual(2);
    expect(botIndex).toBeGreaterThanOrEqual(0);

    const last = snapshots[snapshots.length - 1] as WireSnapshot;
    const first = snapshots[0] as WireSnapshot;
    expect(last.turnNumber).toBeGreaterThan(first.turnNumber);
    // Something was actually shot at: the board is not the one it started on.
    expect(terrainFingerprint(last)).not.toBe(terrainFingerprint(first));

    /*
     * And the real client — the one a player uses — renders that match and
     * agrees with the server about every column of it. This is the part the
     * raw driver cannot claim on its own.
     */
    const watcher = await openPlayer(browser, 'Watcher');
    await rejoinRoom(watcher, roomCode);
    const seen = await readSnapshot(watcher.page);

    expect(seen.turnNumber).toBe(last.turnNumber);
    expect(seen.terrain.surface).toEqual(last.terrain.surface);
    expect(seen.tanks.map((tank) => [tank.id, tank.health, tank.x, tank.y])).toEqual(
      last.tanks.map((tank) => [tank.id, tank.health, tank.x, tank.y]),
    );
    expect(consoleErrors(watcher.page), 'client console errors').toEqual([]);

    await watcher.context.close();
    await solo.context.close();
  });

  test('a computer player takes its turn without anybody clicking anything', async ({
    browser,
  }) => {
    /*
     * The same claim stated as the thing a player would notice: nobody sends a
     * frame, and the match moves anyway.
     *
     * The driver fires ONE shot and then does nothing at all. The room has to
     * come back with the bot's turn on its own — which it does on a Durable
     * Object alarm, so this is also the only test that proves the alarm path
     * works in the real runtime rather than being stepped by a test harness.
     */
    const solo = await openPlayer(browser, 'Solo');
    const roomCode = await allocateRoom(solo.page);

    const transcript = await playSoloVersusBot(solo.page, roomCode, 'moron', 1);
    const frames = parseTranscript(transcript);

    const shooters: string[] = [];
    let previous: WireSnapshot | null = null;
    for (const frame of frames) {
      if (frame.t === 'state') previous = frame.snapshot;
      if (frame.t !== 'events') continue;
      const shot = frame.events.find((event) => event.type === 'shot');
      if (shot?.type === 'shot' && previous !== null) {
        shooters.push(previous.tanks[shot.tankIndex]?.id ?? '?');
      }
      previous = frame.snapshot;
    }

    // At least one turn was taken by the seat with nobody behind it.
    expect(shooters.filter((id) => id === transcript.botId).length).toBeGreaterThanOrEqual(1);
    // And the human's own shot is in there too, so this is a match and not a
    // bot playing with itself.
    expect(shooters).toContain(transcript.you);

    await solo.context.close();
  });
});
