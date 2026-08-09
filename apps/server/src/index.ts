/**
 * Worker entry point.
 *
 * Two jobs only: hand out room codes, and route WebSocket upgrades to the right
 * Durable Object. Everything else is a static asset served by Workers Static
 * Assets (unmetered), or game logic inside the DO.
 */

import { allocateRoomCode, isValidRoomCode } from './room-code.ts';

export { GameRoom } from './game-room.ts';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

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
