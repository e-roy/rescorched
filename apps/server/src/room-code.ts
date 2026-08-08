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
