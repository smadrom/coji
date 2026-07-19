/**
 * HeyGenAnimationProvider — real implementation against the AnimationProvider seam.
 *
 * API facts sourced from docs/api-verification.md (P0.2 doc-verification gate):
 *   - Base: https://api.heygen.com/v3
 *   - Auth: X-Api-Key header (env: HEYGEN_API_KEY)
 *   - Upload frame bytes → POST /v3/assets (multipart) → asset_id
 *   - Submit job      → POST /v3/videos  { type:"image", image:{type:"asset_id",…}, … }
 *                       ⚠️ NO `engine` or `motion_prompt` fields for type:"image"
 *   - Poll status     → GET  /v3/videos/{id}
 *   - Webhook sig     → HMAC-SHA256(rawBody, secret), hex-encoded
 *
 * NEVER import from the job runner — this module is pure provider logic.
 * Real API calls are made only when instantiated with a live API key;
 * unit tests mock globalThis.fetch.
 */

import { createHmac } from 'node:crypto';
import type {
  AnimationProvider,
  AnimationResult,
  AnimationSubmitInput,
  StorageProvider,
} from '@coji/shared/providers';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Transient error (429 / 5xx) — runner retries with backoff, no refund. */
export class HeyGenRetryableError extends Error {
  readonly kind = 'retryable' as const;
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'HeyGenRetryableError';
  }
}

/** Terminal error — job has definitively failed; runner should refund hold. */
export class HeyGenTerminalError extends Error {
  readonly kind = 'terminal' as const;
  constructor(
    message: string,
    public readonly failureCode?: string,
  ) {
    super(message);
    this.name = 'HeyGenTerminalError';
  }
}

// ---------------------------------------------------------------------------
// Internal HeyGen response shapes
// ---------------------------------------------------------------------------

interface AssetsResponse {
  data: {
    asset_id: string;
    url: string;
    mime_type: string;
    size_bytes: number;
  };
}

interface VideosCreateResponse {
  data: {
    video_id: string;
  };
}

interface VideoStatusResponse {
  data: {
    id: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    video_url: string | null;
    thumbnail_url?: string | null;
    duration?: number | null;
    failure_code?: string | null;
    failure_message?: string | null;
  };
}

// ---------------------------------------------------------------------------
// Webhook types
// ---------------------------------------------------------------------------

export interface HeyGenWebhookPayload {
  /** Mirrors the `callback_id` sent at submission — encodes provider_jobs.id. */
  callback_id: string;
  video_id: string;
  status: 'completed' | 'failed';
  video_url?: string;
  failure_code?: string;
  failure_message?: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const HEYGEN_BASE = 'https://api.heygen.com';

export interface HeyGenProviderOptions {
  /**
   * Default render resolution applied when the submit input doesn't specify one.
   * '720p' is the cheapest standard tier (cost lever — see docs/wiki/Providers).
   */
  defaultResolution?: string;
}

export class HeyGenAnimationProvider implements AnimationProvider {
  readonly #apiKey: string;
  readonly #storage: StorageProvider;
  readonly #defaultResolution: string;

  constructor(apiKey: string, storage: StorageProvider, opts: HeyGenProviderOptions = {}) {
    if (!apiKey) throw new Error('HEYGEN_API_KEY is required');
    this.#apiKey = apiKey;
    this.#storage = storage;
    this.#defaultResolution = opts.defaultResolution ?? '720p';
  }

  // -------------------------------------------------------------------------
  // submit — upload frame bytes then POST /v3/videos
  // -------------------------------------------------------------------------

  async submit(input: AnimationSubmitInput): Promise<{ externalId: string }> {
    // 1. Fetch frame bytes from storage (upload to HeyGen rather than passing a URL,
    //    so we have no URL-lifetime dependency on the signed URL — see ADR-5 / M2).
    const frameBytes = await this.#storage.getBytes(input.frameRef);

    // 2. Upload to POST /v3/assets
    const assetId = await this.#uploadAsset(frameBytes, input.frameRef);

    // 3. Build POST /v3/videos body.
    //    ⚠️ Per doc-verification (P0.2): type:"image" does NOT accept `engine` or
    //    `motion_prompt` — those are Digital Twin (type:"avatar") fields only.
    const body: Record<string, unknown> = {
      type: 'image',
      image: { type: 'asset_id', asset_id: assetId },
      callback_id: input.callbackId,
    };

    if (input.callbackUrl) body.callback_url = input.callbackUrl;
    // Cost lever: default to the cheapest standard resolution (720p) unless the
    // caller overrode it. There is intentionally NO `test`/watermark flag —
    // /v3/videos rejects unknown fields with a 400 (verified against the API).
    body.resolution = input.resolution ?? this.#defaultResolution;
    if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;

    // Audio (required — avatar_iv lip-syncs to audio)
    if (input.audio.mode === 'tts') {
      body.script = input.audio.script;
      body.voice_id = input.audio.voiceId;
    } else {
      body.audio_url = input.audio.audioUrl;
    }

    // 4. Submit job
    const resp = await this.#post<VideosCreateResponse>('/v3/videos', body);
    return { externalId: resp.data.video_id };
  }

  // -------------------------------------------------------------------------
  // fetchResult — GET /v3/videos/{id}
  // -------------------------------------------------------------------------

  async fetchResult(externalId: string): Promise<AnimationResult> {
    const resp = await this.#get<VideoStatusResponse>(`/v3/videos/${externalId}`);
    const d = resp.data;

    // Map "waiting" (unofficial but seen in the wild) to "pending"
    const rawStatus = (d.status as string) === 'waiting' ? 'pending' : d.status;

    return {
      externalId,
      status: rawStatus as AnimationResult['status'],
      videoUrl: d.video_url ?? undefined,
      durationSeconds: d.duration ?? undefined,
      failureCode: d.failure_code ?? undefined,
      failureMessage: d.failure_message ?? undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Private HTTP helpers
  // -------------------------------------------------------------------------

  async #uploadAsset(bytes: Uint8Array, frameRef: string): Promise<string> {
    // Derive a filename from the storage key for the multipart field
    const filename = frameRef.split('/').pop() ?? 'frame.jpg';
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' });
    const form = new FormData();
    form.append('file', blob, filename);

    const res = await fetch(`${HEYGEN_BASE}/v3/assets`, {
      method: 'POST',
      headers: { 'X-Api-Key': this.#apiKey },
      body: form,
    });

    await this.#throwOnError(res, 'POST /v3/assets');
    const json = (await res.json()) as AssetsResponse;
    return json.data.asset_id;
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${HEYGEN_BASE}${path}`, {
      method: 'POST',
      headers: {
        'X-Api-Key': this.#apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    await this.#throwOnError(res, `POST ${path}`);
    return res.json() as Promise<T>;
  }

  async #get<T>(path: string): Promise<T> {
    const res = await fetch(`${HEYGEN_BASE}${path}`, {
      headers: { 'X-Api-Key': this.#apiKey },
    });
    await this.#throwOnError(res, `GET ${path}`);
    return res.json() as Promise<T>;
  }

  async #throwOnError(res: Response, context: string): Promise<void> {
    if (res.ok) return;

    // 429 and 5xx are transient — runner retries with backoff, no refund yet
    if (res.status === 429 || res.status >= 500) {
      throw new HeyGenRetryableError(
        `HeyGen ${context} returned ${res.status} (retryable)`,
        res.status,
      );
    }

    // 4xx (other than 429) are terminal
    let detail = '';
    try {
      const body = (await res.json()) as { message?: string };
      detail = body.message ?? '';
    } catch {
      // ignore parse errors
    }
    throw new HeyGenTerminalError(`HeyGen ${context} returned ${res.status}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Webhook helpers (used by the P3 webhook route — no job runner dependency)
// ---------------------------------------------------------------------------

/**
 * Verify a HeyGen webhook signature.
 *
 * HeyGen signs the raw request body with HMAC-SHA256 using the webhook secret
 * and sends the hex digest in the `X-HeyGen-Signature` (or `x-heygen-signature`)
 * header. Returns true when the computed digest matches.
 */
export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  const sigHeader = headers['x-heygen-signature'] ?? headers['X-HeyGen-Signature'] ?? '';
  const receivedSig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  if (!receivedSig) return false;

  const hmac = createHmac('sha256', secret);
  if (typeof rawBody === 'string') {
    hmac.update(rawBody, 'utf8');
  } else {
    hmac.update(rawBody);
  }
  const expected = hmac.digest('hex');

  // Constant-time comparison (prevent timing attacks)
  if (expected.length !== receivedSig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ receivedSig.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Parse and validate a HeyGen webhook payload, extracting the `callback_id`
 * that encodes the attempt-specific `provider_jobs.id`.
 *
 * Returns the typed payload or throws if required fields are missing.
 */
export function parseWebhookPayload(rawBody: string): HeyGenWebhookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error('HeyGen webhook: body is not valid JSON');
  }

  const p = parsed as Record<string, unknown>;
  if (typeof p.callback_id !== 'string' || !p.callback_id) {
    throw new Error('HeyGen webhook: missing callback_id');
  }
  if (typeof p.video_id !== 'string' || !p.video_id) {
    throw new Error('HeyGen webhook: missing video_id');
  }
  if (p.status !== 'completed' && p.status !== 'failed') {
    throw new Error(`HeyGen webhook: unexpected status "${p.status}"`);
  }

  return {
    callback_id: p.callback_id,
    video_id: p.video_id,
    status: p.status,
    video_url: typeof p.video_url === 'string' ? p.video_url : undefined,
    failure_code: typeof p.failure_code === 'string' ? p.failure_code : undefined,
    failure_message: typeof p.failure_message === 'string' ? p.failure_message : undefined,
  };
}
