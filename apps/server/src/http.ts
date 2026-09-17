/**
 * Small HTTP helpers for the Worker entry.
 *
 * They live here rather than in `index.ts` because the entry module may only
 * export what the Workers runtime can bind — see `test/entry-shape.test.ts`.
 */

/**
 * Read a request body as text, giving up at `limit` bytes.
 *
 * `request.text()` alone buffers whatever the sender chose to send, and a
 * `Content-Length` check alone is defeated by a chunked body that declares
 * none. So the header is used to refuse early and the stream is counted anyway.
 * Returns null for a body over the limit.
 */
export async function readBoundedText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) return null;
  if (request.body === null) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
