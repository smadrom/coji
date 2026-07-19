import type { Providers } from '@coji/shared/providers';
/**
 * HeyGen webhook receiver (P3 / task #18).
 *
 * POST /webhooks/heygen — the fast path for animation results.
 *   1. read the RAW request body (signature is HMAC over the exact bytes);
 *   2. verify the signature against HEYGEN_WEBHOOK_SECRET → 401 on mismatch;
 *   3. parse the payload; `callback_id` encodes the attempt-specific
 *      provider_jobs.id;
 *   4. resolve → applyJobResult ONLY (the single writer; drops superseded /
 *      already-terminal / already-retried attempts). On completed, persist the
 *      clip to our StorageProvider first.
 *
 * No auth header (it's a provider callback); the HMAC signature IS the auth.
 * An unknown/mismatched callback_id is acknowledged 200 but applied as a drop,
 * so HeyGen does not retry a webhook we can't map (avoids retry storms) — the
 * reconciler remains the safety net.
 */
import { Elysia, t } from 'elysia';
import { env } from '../../env.ts';
import { parseWebhookPayload, verifyWebhookSignature } from '../../providers/heygen.ts';
import {
  type ApplyOutcome,
  type ApplyResult,
  type DbLike,
  applyJobResult,
} from './apply-job-result.ts';
import { persistClip } from './clip-storage.ts';

/** The settlement function the route calls (the single writer). Injectable for tests. */
export type ApplyFn = (jobId: string, result: ApplyResult) => Promise<ApplyOutcome>;

export interface WebhookDeps {
  db: DbLike;
  /** Lazy provider bundle so app import doesn't eagerly construct providers. */
  providers: () => Providers;
  /** Override the configured secret (tests). */
  secret?: string;
  /** Override the settlement writer (tests inject a spy; defaults to applyJobResult). */
  apply?: ApplyFn;
}

export function heygenWebhookRoutes(deps: WebhookDeps) {
  const secret = deps.secret ?? env.heygenWebhookSecret;
  const apply: ApplyFn = deps.apply ?? ((jobId, result) => applyJobResult(deps.db, jobId, result));
  return new Elysia({ name: 'heygen-webhook' }).post(
    '/webhooks/heygen',
    async ({ request, set }) => {
      const rawBody = await request.text();

      // Collect headers into a plain record for the verifier.
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => {
        headers[k] = v;
      });

      if (!secret || !verifyWebhookSignature(rawBody, headers, secret)) {
        set.status = 401;
        return { error: 'invalid signature' };
      }

      let payload: ReturnType<typeof parseWebhookPayload>;
      try {
        payload = parseWebhookPayload(rawBody);
      } catch (err) {
        set.status = 400;
        return { error: err instanceof Error ? err.message : 'bad payload' };
      }

      // callback_id encodes provider_jobs.id (the attempt row).
      const jobId = payload.callback_id;

      if (payload.status === 'completed') {
        const videoUrl = payload.video_url
          ? await persistClip(deps.providers(), `clips/${jobId}.mp4`, payload.video_url)
          : undefined;
        const outcome = await apply(jobId, {
          status: 'completed',
          clipVideoUrl: videoUrl,
          // The HeyGen webhook payload doesn't carry duration; the reconciler
          // poll path backfills it from fetchResult() if needed.
          clipDurationSeconds: undefined,
          heygenVideoId: payload.video_id,
        });
        return { ok: true, action: outcome.action };
      }

      const outcome = await apply(jobId, {
        status: 'failed',
        failureMessage: payload.failure_message,
      });
      return { ok: true, action: outcome.action };
    },
    {
      // Body is read raw for signature verification; do not let Elysia coerce it.
      parse: 'none',
      detail: { summary: 'HeyGen animation webhook (signature-verified)', tags: ['system'] },
      response: t.Union([
        t.Object({ ok: t.Boolean(), action: t.String() }),
        t.Object({ error: t.String() }),
      ]),
    },
  );
}
