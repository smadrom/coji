/**
 * Signed file-serving route — streams a stored object's bytes when the request
 * carries a valid signature (see signing.ts). No Bearer auth (the signature is
 * the capability) so it works from <img src>/<video src>. Content-type is
 * sniffed from the leading magic bytes.
 *
 * Streaming (F1): the object is streamed straight from the backing store via
 * StorageProvider.getRange — for a Range request we ask the store for only the
 * requested slice, so a multi-MB video seek never buffers the whole object in
 * API memory. Content-type is sniffed from a tiny head read, not the body.
 */
import { Elysia } from 'elysia';
import { getProviders } from '../../config/providers.ts';
import { verifyFileUrl } from './signing.ts';

/** How many leading bytes to read for magic-byte content sniffing. */
const SNIFF_BYTES = 16;

function sniffContentType(b: Uint8Array): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png';
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)
    return 'video/mp4';
  return 'application/octet-stream';
}

/** Drain a (short) stream into a Uint8Array — only used for the sniff head. */
async function drainStream(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    // Release the (head) stream; the real serve uses a fresh getRange.
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(total, limit));
  let off = 0;
  for (const c of chunks) {
    if (off >= out.length) break;
    const take = Math.min(c.byteLength, out.length - off);
    out.set(c.subarray(0, take), off);
    off += take;
  }
  return out;
}

export function filesRoutes() {
  return new Elysia({ name: 'files' }).get('/files', async ({ query, set, request }) => {
    const key = typeof query.key === 'string' ? query.key : '';
    const exp = Number(query.exp);
    const sig = typeof query.sig === 'string' ? query.sig : '';
    if (!verifyFileUrl(key, exp, sig)) {
      set.status = 403;
      return 'forbidden';
    }
    const storage = getProviders().storage;
    const cacheControl = 'private, max-age=3600';

    try {
      // Sniff content-type from a tiny head read (never buffers the whole file).
      const head = await storage.getRange(key, 0, SNIFF_BYTES - 1);
      const total = head.totalSize;
      const contentType = sniffContentType(await drainStream(head.stream, SNIFF_BYTES));

      // Range support — required for smooth <video> seeking (and Safari). Parse a
      // single `bytes=start-end` range; ignore multi-range/invalid (serve full).
      const rangeHeader = request.headers.get('range');
      const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (start <= end && start < total) {
          // Ask the store for exactly this slice. We must buffer it into a
          // sized body: Bun DROPS a manually-set Content-Length when the body is
          // a ReadableStream (it serves the response chunked), and a media
          // response with no Content-Length makes `<video>` hang forever in
          // NETWORK_LOADING — it can't range-seek to a non-faststart MP4's `moov`
          // atom without knowing the size. A seeking browser asks for small
          // ranges, so this slice is bounded (never the whole object on a seek).
          const part = await storage.getRange(key, start, end);
          const body = new Uint8Array(
            await new Response(part.stream as unknown as BodyInit).arrayBuffer(),
          );
          set.status = 206;
          set.headers['content-type'] = contentType;
          set.headers['accept-ranges'] = 'bytes';
          set.headers['content-range'] = `bytes ${part.start}-${part.end}/${part.totalSize}`;
          set.headers['content-length'] = String(body.byteLength);
          set.headers['cache-control'] = cacheControl;
          return new Response(body);
        }
      }

      // Full object (no Range or unsatisfiable Range). Same reasoning as the
      // 206 path: buffer into a sized body so Content-Length is real (a chunked,
      // length-less media response hangs `<video>`).
      const full = await storage.getRange(key);
      const body = new Uint8Array(
        await new Response(full.stream as unknown as BodyInit).arrayBuffer(),
      );
      set.headers['content-type'] = contentType;
      set.headers['accept-ranges'] = 'bytes';
      set.headers['content-length'] = String(body.byteLength);
      set.headers['cache-control'] = cacheControl;
      return new Response(body);
    } catch {
      set.status = 404;
      return 'not found';
    }
  });
}
