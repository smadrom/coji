/**
 * Unit tests for HeyGenAnimationProvider, verifyWebhookSignature, and
 * parseWebhookPayload.
 *
 * All fetch calls are intercepted via mock — no real API calls are made.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { StorageProvider } from '@coji/shared/providers';
import {
  HeyGenAnimationProvider,
  HeyGenRetryableError,
  HeyGenTerminalError,
  parseWebhookPayload,
  verifyWebhookSignature,
} from './heygen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_API_KEY = 'test-api-key';
const FAKE_SECRET = 'webhook-secret';
const FRAME_BYTES = new Uint8Array([1, 2, 3, 4]);
const FRAME_REF = 'frames/proj-1/frame-0.jpg';

/** Minimal StorageProvider stub — only getBytes is called by the provider. */
function makeStorage(bytes = FRAME_BYTES): StorageProvider {
  return {
    getBytes: async (_key: string) => bytes,
    put: async () => ({ key: '', contentType: '', size: 0 }),
    getSignedUrl: async () => 'https://example.com/signed',
    exists: async () => true,
    // getRange is required by the StorageProvider interface (F1). HeyGen never
    // calls it, but the stub must be structurally complete for typecheck.
    async getRange(_key, start, end) {
      const from = start ?? 0;
      const to = end ?? bytes.length - 1;
      const slice = bytes.slice(from, to + 1);
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(slice);
          ctrl.close();
        },
      });
      return {
        stream,
        contentLength: slice.length,
        totalSize: bytes.length,
        start: from,
        end: to,
      };
    },
  };
}

/** Stub a single fetch call with a JSON response. */
function stubFetch(statusCode: number, body: unknown) {
  return mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: statusCode,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

/** Compute the correct HMAC-SHA256 hex signature for a payload. */
function sign(payload: string, secret = FAKE_SECRET): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// HeyGenAnimationProvider — submit
// ---------------------------------------------------------------------------

describe('HeyGenAnimationProvider.submit', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws if apiKey is empty', () => {
    expect(() => new HeyGenAnimationProvider('', makeStorage())).toThrow();
  });

  it('uploads frame bytes to /v3/assets then POSTs to /v3/videos', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url, method });

      if (url.endsWith('/v3/assets')) {
        return new Response(
          JSON.stringify({
            data: {
              asset_id: 'asset-abc',
              url: 'https://cdn.heygen.com/asset-abc',
              mime_type: 'image/jpeg',
              size_bytes: 4,
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v3/videos')) {
        return new Response(JSON.stringify({ data: { video_id: 'vid-xyz' } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const provider = new HeyGenAnimationProvider(FAKE_API_KEY, makeStorage());
    const result = await provider.submit({
      frameRef: FRAME_REF,
      audio: { mode: 'tts', script: 'Hello world', voiceId: 'voice-1' },
      resolution: '1080p',
      aspectRatio: '16:9',
      callbackUrl: 'https://app.example.com/webhook',
      callbackId: 'job-row-id-001',
    });

    expect(result.externalId).toBe('vid-xyz');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('/v3/assets');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[1]!.url).toContain('/v3/videos');
    expect(calls[1]!.method).toBe('POST');
  });

  it('/v3/videos payload includes correct fields for tts audio mode', async () => {
    let capturedBody: Record<string, unknown> = {};

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/v3/assets')) {
        return new Response(
          JSON.stringify({
            data: { asset_id: 'asset-1', url: '', mime_type: 'image/jpeg', size_bytes: 4 },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v3/videos')) {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ data: { video_id: 'vid-1' } }), { status: 200 });
      }
      throw new Error(`Unexpected: ${url}`);
    }) as unknown as typeof fetch;

    const provider = new HeyGenAnimationProvider(FAKE_API_KEY, makeStorage());
    await provider.submit({
      frameRef: FRAME_REF,
      audio: { mode: 'tts', script: 'Say this', voiceId: 'v-001' },
      callbackId: 'job-001',
    });

    // Core type:image fields
    expect(capturedBody.type).toBe('image');
    expect((capturedBody.image as Record<string, unknown>).type).toBe('asset_id');
    expect((capturedBody.image as Record<string, unknown>).asset_id).toBe('asset-1');
    // TTS audio
    expect(capturedBody.script).toBe('Say this');
    expect(capturedBody.voice_id).toBe('v-001');
    expect(capturedBody.audio_url).toBeUndefined();
    // callbackId
    expect(capturedBody.callback_id).toBe('job-001');
    // Cost lever: defaults to 720p when the input doesn't specify a resolution.
    expect(capturedBody.resolution).toBe('720p');
    // CRITICAL: engine and motion_prompt must NOT be present (doc-verify P0.2 CHANGED)
    expect(capturedBody.engine).toBeUndefined();
    expect(capturedBody.motion_prompt).toBeUndefined();
    // CRITICAL: no `test`/watermark flag — /v3/videos 400s on unknown fields.
    expect(capturedBody.test).toBeUndefined();
  });

  it('honours an explicit resolution and a custom default', async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/v3/assets')) {
        return new Response(
          JSON.stringify({
            data: { asset_id: 'a', url: '', mime_type: 'image/jpeg', size_bytes: 4 },
          }),
          { status: 200 },
        );
      }
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ data: { video_id: 'v' } }), { status: 200 });
    }) as unknown as typeof fetch;

    // Explicit input resolution wins over the provider default.
    const p1 = new HeyGenAnimationProvider(FAKE_API_KEY, makeStorage(), {
      defaultResolution: '720p',
    });
    await p1.submit({
      frameRef: FRAME_REF,
      audio: { mode: 'tts', script: 'x', voiceId: 'v' },
      resolution: '1080p',
      callbackId: 'j',
    });
    expect(capturedBody.resolution).toBe('1080p');

    // Provider default applies when the input omits resolution.
    const p2 = new HeyGenAnimationProvider(FAKE_API_KEY, makeStorage(), {
      defaultResolution: '540p',
    });
    await p2.submit({
      frameRef: FRAME_REF,
      audio: { mode: 'tts', script: 'x', voiceId: 'v' },
      callbackId: 'j',
    });
    expect(capturedBody.resolution).toBe('540p');
  });

  it('/v3/videos payload uses audio_url when mode=audio_url', async () => {
    let capturedBody: Record<string, unknown> = {};

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/v3/assets')) {
        return new Response(
          JSON.stringify({
            data: { asset_id: 'asset-2', url: '', mime_type: 'image/jpeg', size_bytes: 4 },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v3/videos')) {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ data: { video_id: 'vid-2' } }), { status: 200 });
      }
      throw new Error(`Unexpected: ${url}`);
    }) as unknown as typeof fetch;

    const provider = new HeyGenAnimationProvider(FAKE_API_KEY, makeStorage());
    await provider.submit({
      frameRef: FRAME_REF,
      audio: { mode: 'audio_url', audioUrl: 'https://example.com/audio.mp3' },
      callbackId: 'job-002',
    });

    expect(capturedBody.audio_url).toBe('https://example.com/audio.mp3');
    expect(capturedBody.script).toBeUndefined();
    expect(capturedBody.voice_id).toBeUndefined();
    // Still no engine/motion_prompt
    expect(capturedBody.engine).toBeUndefined();
    expect(capturedBody.motion_prompt).toBeUndefined();
  });

  it('throws HeyGenRetryableError on 429 from /v3/assets', async () => {
    globalThis.fetch = stubFetch(429, { message: 'rate limited' }) as unknown as typeof fetch;

    const provider = new HeyGenAnimationProvider(FAKE_API_KEY, makeStorage());
    await expect(
      provider.submit({
        frameRef: FRAME_REF,
        audio: { mode: 'tts', script: 'Hi', voiceId: 'v-1' },
        callbackId: 'job-429',
      }),
    ).rejects.toBeInstanceOf(HeyGenRetryableError);
  });

  it('throws HeyGenRetryableError on 500 from /v3/videos', async () => {
    let callCount = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      callCount++;
      if (url.endsWith('/v3/assets')) {
        return new Response(
          JSON.stringify({
            data: { asset_id: 'a', url: '', mime_type: 'image/jpeg', size_bytes: 1 },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ message: 'server error' }), { status: 500 });
    }) as unknown as typeof fetch;

    const provider = new HeyGenAnimationProvider(FAKE_API_KEY, makeStorage());
    const err = await provider
      .submit({
        frameRef: FRAME_REF,
        audio: { mode: 'tts', script: 'x', voiceId: 'v' },
        callbackId: 'j',
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(HeyGenRetryableError);
    expect((err as HeyGenRetryableError).statusCode).toBe(500);
    expect((err as HeyGenRetryableError).kind).toBe('retryable');
  });

  it('throws HeyGenTerminalError on 400 from /v3/videos', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/v3/assets')) {
        return new Response(
          JSON.stringify({
            data: { asset_id: 'a', url: '', mime_type: 'image/jpeg', size_bytes: 1 },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ message: 'bad request' }), { status: 400 });
    }) as unknown as typeof fetch;

    const provider = new HeyGenAnimationProvider(FAKE_API_KEY, makeStorage());
    const err = await provider
      .submit({
        frameRef: FRAME_REF,
        audio: { mode: 'tts', script: 'x', voiceId: 'v' },
        callbackId: 'j',
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(HeyGenTerminalError);
    expect((err as HeyGenTerminalError).kind).toBe('terminal');
  });
});

// ---------------------------------------------------------------------------
// HeyGenAnimationProvider — fetchResult
// ---------------------------------------------------------------------------

describe('HeyGenAnimationProvider.fetchResult', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeProvider() {
    return new HeyGenAnimationProvider(FAKE_API_KEY, makeStorage());
  }

  it('maps status=pending correctly', async () => {
    globalThis.fetch = stubFetch(200, {
      data: { id: 'v1', status: 'pending', video_url: null },
    }) as unknown as typeof fetch;

    const r = await makeProvider().fetchResult('v1');
    expect(r.status).toBe('pending');
    expect(r.videoUrl).toBeUndefined();
  });

  it('maps status=processing correctly', async () => {
    globalThis.fetch = stubFetch(200, {
      data: { id: 'v2', status: 'processing', video_url: null },
    }) as unknown as typeof fetch;

    const r = await makeProvider().fetchResult('v2');
    expect(r.status).toBe('processing');
  });

  it('maps status=completed with video_url', async () => {
    globalThis.fetch = stubFetch(200, {
      data: { id: 'v3', status: 'completed', video_url: 'https://cdn.heygen.com/v3.mp4' },
    }) as unknown as typeof fetch;

    const r = await makeProvider().fetchResult('v3');
    expect(r.status).toBe('completed');
    expect(r.videoUrl).toBe('https://cdn.heygen.com/v3.mp4');
  });

  it('maps duration → durationSeconds on a completed result', async () => {
    globalThis.fetch = stubFetch(200, {
      data: {
        id: 'v3d',
        status: 'completed',
        video_url: 'https://cdn.heygen.com/v3d.mp4',
        duration: 7.5,
      },
    }) as unknown as typeof fetch;

    const r = await makeProvider().fetchResult('v3d');
    expect(r.durationSeconds).toBe(7.5);
  });

  it('leaves durationSeconds undefined when duration is absent/null', async () => {
    globalThis.fetch = stubFetch(200, {
      data: { id: 'v3n', status: 'completed', video_url: 'https://x/y.mp4', duration: null },
    }) as unknown as typeof fetch;

    const r = await makeProvider().fetchResult('v3n');
    expect(r.durationSeconds).toBeUndefined();
  });

  it('maps status=failed with failure details', async () => {
    globalThis.fetch = stubFetch(200, {
      data: {
        id: 'v4',
        status: 'failed',
        video_url: null,
        failure_code: 'ASSET_ERROR',
        failure_message: 'Cannot process image',
      },
    }) as unknown as typeof fetch;

    const r = await makeProvider().fetchResult('v4');
    expect(r.status).toBe('failed');
    expect(r.failureCode).toBe('ASSET_ERROR');
    expect(r.failureMessage).toBe('Cannot process image');
    expect(r.videoUrl).toBeUndefined();
  });

  it('maps unofficial "waiting" status to "pending"', async () => {
    globalThis.fetch = stubFetch(200, {
      data: { id: 'v5', status: 'waiting', video_url: null },
    }) as unknown as typeof fetch;

    const r = await makeProvider().fetchResult('v5');
    expect(r.status).toBe('pending');
  });

  it('throws HeyGenRetryableError on 429', async () => {
    globalThis.fetch = stubFetch(429, { message: 'rate limited' }) as unknown as typeof fetch;
    await expect(makeProvider().fetchResult('v6')).rejects.toBeInstanceOf(HeyGenRetryableError);
  });

  it('throws HeyGenRetryableError on 503', async () => {
    globalThis.fetch = stubFetch(503, {
      message: 'service unavailable',
    }) as unknown as typeof fetch;
    const err = await makeProvider()
      .fetchResult('v7')
      .catch((e) => e);
    expect(err).toBeInstanceOf(HeyGenRetryableError);
    expect((err as HeyGenRetryableError).statusCode).toBe(503);
  });

  it('throws HeyGenTerminalError on 404', async () => {
    globalThis.fetch = stubFetch(404, { message: 'not found' }) as unknown as typeof fetch;
    await expect(makeProvider().fetchResult('v-missing')).rejects.toBeInstanceOf(
      HeyGenTerminalError,
    );
  });
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature', () => {
  const payload = JSON.stringify({ video_id: 'v1', callback_id: 'job-1', status: 'completed' });

  it('returns true for a valid HMAC-SHA256 signature', () => {
    const sig = sign(payload);
    expect(verifyWebhookSignature(payload, { 'x-heygen-signature': sig }, FAKE_SECRET)).toBe(true);
  });

  it('returns true with mixed-case header name', () => {
    const sig = sign(payload);
    expect(verifyWebhookSignature(payload, { 'X-HeyGen-Signature': sig }, FAKE_SECRET)).toBe(true);
  });

  it('returns false for a wrong signature', () => {
    expect(verifyWebhookSignature(payload, { 'x-heygen-signature': 'deadbeef' }, FAKE_SECRET)).toBe(
      false,
    );
  });

  it('returns false when signature header is missing', () => {
    expect(verifyWebhookSignature(payload, {}, FAKE_SECRET)).toBe(false);
  });

  it('returns false when signed with the wrong secret', () => {
    const sig = sign(payload, 'wrong-secret');
    expect(verifyWebhookSignature(payload, { 'x-heygen-signature': sig }, FAKE_SECRET)).toBe(false);
  });

  it('accepts Uint8Array rawBody', () => {
    const bodyBytes = new TextEncoder().encode(payload);
    const sig = sign(payload);
    expect(verifyWebhookSignature(bodyBytes, { 'x-heygen-signature': sig }, FAKE_SECRET)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// parseWebhookPayload
// ---------------------------------------------------------------------------

describe('parseWebhookPayload', () => {
  it('parses a valid completed payload', () => {
    const raw = JSON.stringify({
      callback_id: 'job-row-123',
      video_id: 'heygen-vid-456',
      status: 'completed',
      video_url: 'https://cdn.heygen.com/output.mp4',
    });
    const p = parseWebhookPayload(raw);
    expect(p.callback_id).toBe('job-row-123');
    expect(p.video_id).toBe('heygen-vid-456');
    expect(p.status).toBe('completed');
    expect(p.video_url).toBe('https://cdn.heygen.com/output.mp4');
  });

  it('parses a valid failed payload', () => {
    const raw = JSON.stringify({
      callback_id: 'job-row-789',
      video_id: 'heygen-vid-789',
      status: 'failed',
      failure_code: 'ASSET_ERROR',
      failure_message: 'Cannot process image',
    });
    const p = parseWebhookPayload(raw);
    expect(p.status).toBe('failed');
    expect(p.failure_code).toBe('ASSET_ERROR');
    expect(p.failure_message).toBe('Cannot process image');
    expect(p.video_url).toBeUndefined();
  });

  it('throws on invalid JSON', () => {
    expect(() => parseWebhookPayload('not json{')).toThrow();
  });

  it('throws when callback_id is missing', () => {
    expect(() =>
      parseWebhookPayload(JSON.stringify({ video_id: 'v1', status: 'completed' })),
    ).toThrow(/callback_id/);
  });

  it('throws when video_id is missing', () => {
    expect(() =>
      parseWebhookPayload(JSON.stringify({ callback_id: 'job-1', status: 'completed' })),
    ).toThrow(/video_id/);
  });

  it('throws on unexpected status value', () => {
    expect(() =>
      parseWebhookPayload(
        JSON.stringify({ callback_id: 'job-1', video_id: 'v1', status: 'processing' }),
      ),
    ).toThrow(/status/);
  });
});

// ---------------------------------------------------------------------------
// Error class shape
// ---------------------------------------------------------------------------

describe('HeyGenRetryableError', () => {
  it('has kind=retryable and exposes statusCode', () => {
    const e = new HeyGenRetryableError('rate limited', 429);
    expect(e.kind).toBe('retryable');
    expect(e.statusCode).toBe(429);
    expect(e).toBeInstanceOf(Error);
  });
});

describe('HeyGenTerminalError', () => {
  it('has kind=terminal and exposes optional failureCode', () => {
    const e = new HeyGenTerminalError('job failed', 'ASSET_ERROR');
    expect(e.kind).toBe('terminal');
    expect(e.failureCode).toBe('ASSET_ERROR');
    expect(e).toBeInstanceOf(Error);
  });
});
