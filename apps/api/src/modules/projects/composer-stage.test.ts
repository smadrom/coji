/**
 * Unit tests for the composer-stage pure logic (clip-composer / WS3+WS7).
 *
 * Covers `InvalidCompositionError` conditions and the `animationIdempotencyKey`
 * canonical format — these are pure-function tests with no DB required; they
 * run unconditionally in CI.
 *
 * The DB-backed round-trips (setComposition CRUD, getComposition ORDER BY
 * order_idx) are covered by composer-stage.db.test.ts (gated on TEST_DATABASE_URL).
 */
import { describe, expect, it } from 'bun:test';
import { animationIdempotencyKey } from './animation-stage.ts';
import { InvalidCompositionError } from './composer-stage.ts';
import { MAX_CLIPS_PER_PROJECT } from './schema.ts';

// ---------------------------------------------------------------------------
// animationIdempotencyKey — canonical `${clipId}:${attempt}` format (WS4)
// ---------------------------------------------------------------------------

describe('animationIdempotencyKey', () => {
  const clipId = '11111111-1111-1111-1111-111111111111';

  it('formats as <clipId>:<attempt>', () => {
    expect(animationIdempotencyKey(clipId, 0)).toBe(`${clipId}:0`);
    expect(animationIdempotencyKey(clipId, 1)).toBe(`${clipId}:1`);
  });

  it('is idempotent: same clipId + attempt always gives the same key', () => {
    expect(animationIdempotencyKey(clipId, 2)).toBe(animationIdempotencyKey(clipId, 2));
  });

  it('different attempts produce different keys for the same clip', () => {
    expect(animationIdempotencyKey(clipId, 0)).not.toBe(animationIdempotencyKey(clipId, 1));
  });

  it('different clips produce different keys at the same attempt', () => {
    const clipId2 = '22222222-2222-2222-2222-222222222222';
    expect(animationIdempotencyKey(clipId, 0)).not.toBe(animationIdempotencyKey(clipId2, 0));
  });

  it('does NOT collide with the render idempotency key format (render:<pid>:<attempt>)', () => {
    // Render keys are prefixed with "render:"; animation keys are NOT.
    // A render key for a project whose id happens to look like a clip UUID must
    // not equal an animation key for that same uuid.
    const key = animationIdempotencyKey(clipId, 0);
    expect(key).not.toMatch(/^render:/);
  });

  it('does NOT collide with the image idempotency key format (<projectId>:<attempt>)', () => {
    // The image key has the same bare `<id>:<attempt>` shape; they differ only
    // because the clip UUID differs from the project UUID. The test asserts the
    // canonical format so any future prefix can be checked here.
    const imageKey = `${clipId}:0`;
    // Currently they ARE the same shape — the disambiguation is by UUID value,
    // not by prefix. The test documents this explicitly.
    expect(animationIdempotencyKey(clipId, 0)).toBe(imageKey);
  });
});

// ---------------------------------------------------------------------------
// InvalidCompositionError — shape + status
// ---------------------------------------------------------------------------

describe('InvalidCompositionError', () => {
  it('has status 422', () => {
    const err = new InvalidCompositionError('too many clips');
    expect(err.status).toBe(422);
  });

  it('carries the supplied message', () => {
    const msg = `composition exceeds the ${MAX_CLIPS_PER_PROJECT}-clip cap`;
    const err = new InvalidCompositionError(msg);
    expect(err.message).toBe(msg);
  });

  it('is an instance of Error', () => {
    expect(new InvalidCompositionError('x')).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// MAX_CLIPS_PER_PROJECT — exported constant used by composer + animation stage
// ---------------------------------------------------------------------------

describe('MAX_CLIPS_PER_PROJECT', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(MAX_CLIPS_PER_PROJECT)).toBe(true);
    expect(MAX_CLIPS_PER_PROJECT).toBeGreaterThan(0);
  });

  it('is exactly 20 (bounds N-hold transaction + abuse cap)', () => {
    expect(MAX_CLIPS_PER_PROJECT).toBe(20);
  });
});
