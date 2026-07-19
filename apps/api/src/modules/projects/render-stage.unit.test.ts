/**
 * Render-stage UNIT tests (task #18 — A1/A2, no DB required).
 *
 * Covers the pure / deterministic logic extracted from render-stage.ts and
 * clip-storage.ts without touching Postgres, HeyGen, or ffmpeg.
 *
 * A1 — render_attempt idempotency key:
 *   `renderIdempotencyKey` must be prefixed so it never collides with the
 *   image idempotency key (`${projectId}:${attempt}`).
 *
 * A2 — same-origin clip URL:
 *   `clipEditorUrl` must return a same-origin `/files?…` URL for storage keys
 *   and pass legacy absolute http(s) URLs through unchanged.
 *
 * These are pure-function tests — zero network, zero DB, runs in CI always.
 */
import { describe, expect, test } from 'bun:test';
import { clipEditorUrl } from '../jobs/clip-storage.ts';
import { renderIdempotencyKey } from './render-stage.ts';

// ---------------------------------------------------------------------------
// A1 — renderIdempotencyKey prefix / collision guard
// ---------------------------------------------------------------------------

describe('renderIdempotencyKey (A1)', () => {
  test('is prefixed with "render:"', () => {
    const key = renderIdempotencyKey('proj-1', 0);
    expect(key).toMatch(/^render:/);
  });

  test('encodes project id and attempt', () => {
    const pid = 'abc-123';
    expect(renderIdempotencyKey(pid, 0)).toBe(`render:${pid}:0`);
    expect(renderIdempotencyKey(pid, 3)).toBe(`render:${pid}:3`);
  });

  test('never matches bare image key (projectId:attempt)', () => {
    // The image key has the shape `${projectId}:${attempt}` with no prefix.
    // The render key MUST differ so they never occupy the same unique row.
    const pid = 'my-project';
    const imageKey = `${pid}:0`;
    expect(renderIdempotencyKey(pid, 0)).not.toBe(imageKey);
  });

  test('different attempts produce different keys for same project', () => {
    const pid = 'proj-x';
    expect(renderIdempotencyKey(pid, 0)).not.toBe(renderIdempotencyKey(pid, 1));
    expect(renderIdempotencyKey(pid, 1)).not.toBe(renderIdempotencyKey(pid, 2));
  });

  test('same project + same attempt always produces the same key (idempotent)', () => {
    const pid = 'proj-y';
    expect(renderIdempotencyKey(pid, 2)).toBe(renderIdempotencyKey(pid, 2));
  });
});

// ---------------------------------------------------------------------------
// A2 — clipEditorUrl: same-origin /files URL vs. legacy passthrough
// ---------------------------------------------------------------------------

describe('clipEditorUrl (A2)', () => {
  test('storage key → same-origin /files URL', () => {
    const url = clipEditorUrl('projects/abc/clips/0.mp4');
    // Must start with /files (same-origin) and carry query params
    expect(url).toMatch(/^\/files\?/);
    expect(url).toContain('key=');
    expect(url).toContain('sig=');
    expect(url).toContain('exp=');
  });

  test('legacy https URL passes through unchanged', () => {
    const legacy = 'https://cdn.heygen.com/clip-xyz.mp4';
    expect(clipEditorUrl(legacy)).toBe(legacy);
  });

  test('legacy http URL passes through unchanged', () => {
    const legacy = 'http://localhost/clip.mp4';
    expect(clipEditorUrl(legacy)).toBe(legacy);
  });

  test('noop:// scheme (Noop provider) is treated as a storage key → /files URL', () => {
    // noop:// URLs are not http/https, so they go through signFileUrl just like
    // a real storage key — this is intentional (they're stored as keys).
    const url = clipEditorUrl('noop://clip/frame-0.mp4');
    expect(url).toMatch(/^\/files\?/);
  });

  test('two different storage keys produce different signed URLs', () => {
    const a = clipEditorUrl('projects/1/clips/0.mp4');
    const b = clipEditorUrl('projects/1/clips/1.mp4');
    expect(a).not.toBe(b);
  });
});
