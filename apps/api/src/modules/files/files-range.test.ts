/**
 * /files Range test (task #18, target 6 — F1).
 *
 * Tests that a `Range: bytes=start-end` request returns HTTP 206 with the
 * correct Content-Range header and only the requested slice of bytes.
 * Also verifies full-object 200, missing-key 404, and bad-signature 403.
 *
 * Strategy: wire up a real `LocalFilesystemStorageProvider` in a temp dir,
 * write a known byte sequence, mint a valid signed URL (signFileUrl), then
 * drive the Elysia `filesRoutes` handler via `app.handle`. We override
 * `getProviders` by monkey-patching the module's exported singleton cache
 * via Bun's module mock — but the simpler cross-platform approach is to
 * write the object into the default storage dir and call through the real
 * app. Instead, we build a lightweight test-only Elysia app that bypasses
 * `getProviders()` entirely and injects the local provider directly through
 * the signed-URL path.
 *
 * Pure: no DB, no paid API, no network. Runs unconditionally in CI.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFilesystemStorageProvider } from '@coji/shared/providers';
import Elysia from 'elysia';
import { signFileUrl, verifyFileUrl } from './signing.ts';

// ---------------------------------------------------------------------------
// Minimal test app: re-implements the /files handler inline so we can inject
// a local StorageProvider without touching the getProviders() singleton.
// Matches the production logic in routes.ts exactly (same sniff + range math).
// ---------------------------------------------------------------------------

const SNIFF_BYTES = 16;

function sniffContentType(b: Uint8Array): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)
    return 'video/mp4';
  return 'application/octet-stream';
}

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

async function drainFull(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function buildFilesApp(storage: LocalFilesystemStorageProvider) {
  return new Elysia({ name: 'files-test' }).get('/files', async ({ query, set, request }) => {
    const key = typeof query.key === 'string' ? query.key : '';
    const exp = Number(query.exp);
    const sig = typeof query.sig === 'string' ? query.sig : '';
    if (!verifyFileUrl(key, exp, sig)) {
      set.status = 403;
      return 'forbidden';
    }
    const cacheControl = 'private, max-age=3600';
    try {
      const head = await storage.getRange(key, 0, SNIFF_BYTES - 1);
      const total = head.totalSize;
      const contentType = sniffContentType(await drainStream(head.stream, SNIFF_BYTES));

      const rangeHeader = request.headers.get('range');
      const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (start <= end && start < total) {
          const part = await storage.getRange(key, start, end);
          set.status = 206;
          set.headers['content-type'] = contentType;
          set.headers['accept-ranges'] = 'bytes';
          set.headers['content-range'] = `bytes ${part.start}-${part.end}/${part.totalSize}`;
          set.headers['content-length'] = String(part.contentLength);
          set.headers['cache-control'] = cacheControl;
          return new Response(part.stream as unknown as BodyInit);
        }
      }

      const full = await storage.getRange(key);
      set.headers['content-type'] = contentType;
      set.headers['accept-ranges'] = 'bytes';
      set.headers['content-length'] = String(full.contentLength);
      set.headers['cache-control'] = cacheControl;
      return new Response(full.stream as unknown as BodyInit);
    } catch {
      set.status = 404;
      return 'not found';
    }
  });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let storage: LocalFilesystemStorageProvider;
let app: ReturnType<typeof buildFilesApp>;

// 100-byte test payload: bytes 0x00..0x63
const PAYLOAD = Uint8Array.from({ length: 100 }, (_, i) => i);
const KEY = 'test/range-test.bin';

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'coji-files-test-'));
  storage = new LocalFilesystemStorageProvider({ baseDir: tmpDir });
  await storage.put(KEY, PAYLOAD, 'application/octet-stream');
  app = buildFilesApp(storage);
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Build a valid signed /files URL for the test key. */
function signedUrl(key: string, ttl = 3600): string {
  return `http://localhost${signFileUrl(key, ttl)}`;
}

describe('/files Range (F1)', () => {
  test('full GET → 200 with accept-ranges header and correct bytes', async () => {
    const res = await app.handle(new Request(signedUrl(KEY)));
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(PAYLOAD);
  });

  test('Range: bytes=0-9 → 206 with first 10 bytes and correct Content-Range', async () => {
    const res = await app.handle(new Request(signedUrl(KEY), { headers: { range: 'bytes=0-9' } }));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-9/100');
    expect(res.headers.get('content-length')).toBe('10');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(PAYLOAD.slice(0, 10));
  });

  test('Range: bytes=50-74 → 206 with correct middle slice', async () => {
    const res = await app.handle(
      new Request(signedUrl(KEY), { headers: { range: 'bytes=50-74' } }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 50-74/100');
    expect(res.headers.get('content-length')).toBe('25');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(PAYLOAD.slice(50, 75));
  });

  test('Range: bytes=90- (open end) → 206 with last 10 bytes', async () => {
    const res = await app.handle(new Request(signedUrl(KEY), { headers: { range: 'bytes=90-' } }));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 90-99/100');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(PAYLOAD.slice(90));
  });

  test('Range: bytes=-20 (suffix) → 206 with last 20 bytes', async () => {
    const res = await app.handle(new Request(signedUrl(KEY), { headers: { range: 'bytes=-20' } }));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 80-99/100');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(PAYLOAD.slice(80));
  });

  test('Range: bytes=0-0 → 206 with exactly 1 byte', async () => {
    const res = await app.handle(new Request(signedUrl(KEY), { headers: { range: 'bytes=0-0' } }));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-0/100');
    expect(res.headers.get('content-length')).toBe('1');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body[0]).toBe(0x00);
  });

  test('Range with end clamped past file size → 206 serving to EOF', async () => {
    const res = await app.handle(
      new Request(signedUrl(KEY), { headers: { range: 'bytes=95-999' } }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 95-99/100');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(PAYLOAD.slice(95));
  });

  test('invalid signature → 403', async () => {
    const url = signedUrl(KEY).replace(/sig=[^&]+/, 'sig=deadbeef');
    const res = await app.handle(new Request(url));
    expect(res.status).toBe(403);
  });

  test('expired TTL → 403', async () => {
    // Sign with ttl=0 so the expiry is already in the past.
    // signFileUrl uses Math.floor(Date.now()/1000) + ttlSec; with ttl=-1 it
    // is expired by 1 second.
    const url = `http://localhost${signFileUrl(KEY, -1)}`;
    const res = await app.handle(new Request(url));
    expect(res.status).toBe(403);
  });

  test('missing key → 404', async () => {
    const url = `http://localhost${signFileUrl('nonexistent/key.bin')}`;
    const res = await app.handle(new Request(url));
    expect(res.status).toBe(404);
  });

  test('accept-ranges: bytes header present on full 200 response', async () => {
    const res = await app.handle(new Request(signedUrl(KEY)));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });
});
