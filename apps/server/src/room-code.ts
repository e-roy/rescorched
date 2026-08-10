/**
 * Room codes: four uppercase letters, readable over voice chat.
 *
 * Uses `crypto.getRandomValues` — this is the Worker, not the sim, so real
 * entropy is correct here. The sim's seeded RNG is for *game* randomness.
 */

// I and O are excluded: they read as 1 and 0 when someone types a code in.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;

export function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  }
  return code;
}

export function isValidRoomCode(code: string): boolean {
  return /^[A-Z]{4}$/.test(code);
}

/** Anonymous session id — no accounts at launch (TECH_STACK.md). */
export function generateSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Deterministic 32-bit seed derived from a room code plus a nonce.
 * The room code alone would make every game in room "ABCD" identical.
 */
export function seedFromRoom(roomCode: string, nonce: number): number {
  let hash = 0x811c9dc5;
  const source = `${roomCode}:${nonce}`;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * How many codes to try before handing one over anyway.
 *
 * There are 24^4 = 331,776 codes, so a collision is rare — but "rare" over a
 * weekend is "someone got dropped into a stranger's lobby", which is a far
 * worse bug than one extra Durable Object round trip at room-creation time.
 * The first candidate is free almost every time, so this usually costs exactly
 * one probe.
 */
export const ROOM_CODE_ATTEMPTS = 5;

/**
 * Mint a code for a room nobody is sitting in, and open that room.
 *
 * The probe and the claim are one request (`/claim`), and that is deliberate on
 * both counts. The probe is what stops a code being handed to somebody while
 * strangers are playing in it. The claim is what makes this the ONLY way a room
 * comes into being: `idFromName` turns every four-letter code into a Durable
 * Object, so a room has to be marked as opened or "no such room" cannot be
 * distinguished from "nobody has said anything yet" — see `roomExists` in
 * `game-room.ts`. Before it existed, a typo'd join silently created the room it
 * had failed to find.
 *
 * `generate` is a parameter, and exported, for one reason: the probe is
 * otherwise untestable. With 331,776 codes, a test that mints a handful and
 * checks they came back empty passes at 99.998% whether the probe runs or not —
 * it measures the dice, not the code. Handing in a generator that returns an
 * occupied code first forces the collision every run, so deleting the probe
 * turns the test red. See `test/room-code.test.ts`.
 */
export async function allocateRoomCode(
  env: Env,
  generate: () => string = generateRoomCode,
): Promise<string> {
  let candidate = generate();
  for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) candidate = generate();
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(candidate));
    try {
      const response = await stub.fetch(
        new Request(`https://room/claim?room=${candidate}`, { method: 'POST' }),
      );
      if (!response.ok) continue;
      const summary = (await response.json()) as { claimed?: boolean };
      if (summary.claimed === true) return candidate;
    } catch {
      // A room that cannot be asked is not a room we should hand out.
      continue;
    }
  }
  /*
   * Every probe was occupied or unreachable. Return the last candidate rather
   * than fail outright: a shared room is recoverable, "could not create" is not.
   *
   * It is claimed on the way out, because the caller is about to be told this
   * is their room and being sent to one that then refuses them would be a worse
   * outcome than sharing.
   */
  try {
    const response = await env.GAME_ROOM.get(env.GAME_ROOM.idFromName(candidate)).fetch(
      new Request(`https://room/claim?room=${candidate}`, { method: 'POST' }),
    );
    // Read the body even though the answer is not interesting: a response left
    // undrained holds its request open, and an object with a request in flight
    // never hibernates.
    await response.json();
  } catch {
    // Nothing left to try; the room will still open for whoever gets a seat.
  }
  return candidate;
}
