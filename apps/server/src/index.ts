/**
 * Worker entry point.
 *
 * Three jobs only: hand out room codes, route WebSocket upgrades to the right
 * Durable Object, and serve the public room list. Everything else is a static
 * asset served by Workers Static Assets (unmetered), or game logic inside the
 * DO.
 */

import { MAX_CREATE_ROOM_BODY_BYTES, parseCreateRoomRequest } from '@scorched/protocol';
import { readBoundedText } from './http.ts';
import { directoryStub } from './room-directory.ts';
import { allocateRoomCode, generateRoomCode, isValidRoomCode } from './room-code.ts';

export { GameRoom } from './game-room.ts';
export { RoomDirectory } from './room-directory.ts';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // POST /api/rooms  { visibility? }  →  { roomCode }
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const body = await readBoundedText(request, MAX_CREATE_ROOM_BODY_BYTES);
      if (body === null) return new Response('Request body too large', { status: 413 });
      const parsed = parseCreateRoomRequest(body);
      if (!parsed.ok) return new Response(parsed.error, { status: 400 });

      const roomCode = await allocateRoomCode(
        env,
        generateRoomCode,
        parsed.value.visibility ?? 'private',
      );
      return new Response(JSON.stringify({ roomCode }), { headers: JSON_HEADERS });
    }

    // GET /api/rooms/public  →  { rooms: PublicRoom[] }
    if (url.pathname === '/api/rooms/public' && request.method === 'GET') {
      const listed = await directoryStub(env).fetch(new Request('https://directory/list'));
      // Never cached: a listing is a picture of who is sitting in a lobby right
      // now, and a stale one is a Join button for a room that already started.
      return new Response(listed.body, {
        status: listed.status,
        headers: { ...JSON_HEADERS, 'cache-control': 'no-store' },
      });
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
