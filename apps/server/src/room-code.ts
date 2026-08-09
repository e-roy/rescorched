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
 * Mint a code for a room nobody is sitting in.
 *
 * `generate` is a parameter, and exported, for one reason: the probe below is
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
      const response = await stub.fetch(new Request('https://room/info'));
      if (!response.ok) continue;
      const summary = (await response.json()) as { players?: number; inProgress?: boolean };
      if ((summary.players ?? 0) === 0 && summary.inProgress !== true) return candidate;
    } catch {
      // A room that cannot be asked is not a room we should hand out.
      continue;
    }
  }
  // Every probe was occupied or unreachable. Return the last candidate rather
  // than fail outright: a shared room is recoverable, "could not create" is not.
  return candidate;
}
