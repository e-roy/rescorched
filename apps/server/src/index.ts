/**
 * Worker entry point.
 *
 * Two jobs only: hand out room codes, and route WebSocket upgrades to the right
 * Durable Object. Everything else is a static asset served by Workers Static
 * Assets (unmetered), or game logic inside the DO.
 */

import { generateRoomCode, isValidRoomCode } from './room-code.ts';

export { GameRoom } from './game-room.ts';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

/**
 * How many codes to try before handing one over anyway.
 *
 * There are 24^4 = 331,776 codes, so a collision is rare — but "rare" over a
 * weekend is "someone got dropped into a stranger's lobby", which is a far
 * worse bug than one extra Durable Object round trip at room-creation time.
 * The first candidate is free almost every time, so this usually costs exactly
 * one probe.
 */
const ROOM_CODE_ATTEMPTS = 5;

async function allocateRoomCode(env: Env): Promise<string> {
  let candidate = generateRoomCode();
  for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) candidate = generateRoomCode();
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // POST /api/rooms  →  { roomCode }
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const roomCode = await allocateRoomCode(env);
      return new Response(JSON.stringify({ roomCode }), { headers: JSON_HEADERS });
    }

    // GET /api/rooms/:code/ws     → WebSocket upgrade into the room
    // GET /api/rooms/:code/info   → lightweight room summary
    const roomMatch = /^\/api\/rooms\/([A-Za-z]{4})\/(ws|info)$/.exec(url.pathname);
    if (roomMatch !== null) {
      const roomCode = (roomMatch[1] as string).toUpperCase();
      const action = roomMatch[2] as string;

      if (!isValidRoomCode(roomCode)) {
        return new Response('Invalid room code', { status: 400 });
      }

      // idFromName means "room ABCD" always resolves to the same object,
      // anywhere in the world, with no lookup table.
      const id = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(id);

      const forwarded = new URL(request.url);
      forwarded.pathname = `/${action}`;
      forwarded.searchParams.set('room', roomCode);

      return stub.fetch(new Request(forwarded, request));
    }

    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404 });
    }

    // Anything else is a static asset (the built Vite client).
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
