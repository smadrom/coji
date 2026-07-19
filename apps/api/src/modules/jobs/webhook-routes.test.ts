import { describe, expect, test } from 'bun:test';
/**
 * Webhook-correctness tests (P3 / task #18) — app.handle, zero DB.
 *
 * The settlement writer (applyJobResult) is injected as a spy so these exercise
 * the webhook's SECURITY + ROUTING contract (signature verification, payload
 * parsing, callback_id→jobId resolution, idempotent re-delivery) without a DB.
 * The real applyJobResult end-to-end is covered by the DB-gated animation test.
 */
import { createHmac } from 'node:crypto';
import { LocalFilesystemStorageProvider } from '@coji/shared/providers';
import type { Providers } from '@coji/shared/providers';
import { Elysia } from 'elysia';
import type { ApplyOutcome, ApplyResult } from './apply-job-result.ts';
import { type ApplyFn, heygenWebhookRoutes } from './webhook-routes.ts';

const SECRET = 'test-webhook-secret';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
}

const fakeProviders = () =>
  ({
    storage: new LocalFilesystemStorageProvider({ baseDir: '.omc/tmp/storage-test-wh' }),
  }) as unknown as Providers;

function buildApp(apply: ApplyFn) {
  // biome-ignore lint/suspicious/noExplicitAny: db is unused (apply is injected)
  const db = {} as any;
  return new Elysia().use(
    heygenWebhookRoutes({ db, providers: fakeProviders, secret: SECRET, apply }),
  );
}

function post(body: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost/webhooks/heygen', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('HeyGen webhook receiver', () => {
  test('valid signature → applyJobResult called with the resolved jobId', async () => {
    const calls: { jobId: string; result: ApplyResult }[] = [];
    const apply: ApplyFn = async (jobId, result): Promise<ApplyOutcome> => {
      calls.push({ jobId, result });
      return { action: 'applied' };
    };
    const app = buildApp(apply);
    const body = JSON.stringify({
      callback_id: 'job-abc',
      video_id: 'hg-123',
      status: 'completed',
      video_url: 'noop://clip/hg-123.mp4',
    });
    const res = await app.handle(post(body, { 'x-heygen-signature': sign(body) }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.jobId).toBe('job-abc');
    expect(calls[0]!.result.status).toBe('completed');
  });

  test('bad signature → 401, applyJobResult NOT called', async () => {
    let called = false;
    const apply: ApplyFn = async () => {
      called = true;
      return { action: 'applied' };
    };
    const app = buildApp(apply);
    const body = JSON.stringify({ callback_id: 'j', video_id: 'v', status: 'completed' });
    const res = await app.handle(post(body, { 'x-heygen-signature': 'deadbeef' }));
    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });

  test('missing signature → 401', async () => {
    const app = buildApp(async () => ({ action: 'applied' }));
    const body = JSON.stringify({ callback_id: 'j', video_id: 'v', status: 'completed' });
    const res = await app.handle(post(body));
    expect(res.status).toBe(401);
  });

  test('valid signature but malformed payload (missing callback_id) → 400', async () => {
    const app = buildApp(async () => ({ action: 'applied' }));
    const body = JSON.stringify({ video_id: 'v', status: 'completed' });
    const res = await app.handle(post(body, { 'x-heygen-signature': sign(body) }));
    expect(res.status).toBe(400);
  });

  test('unknown callback_id is acknowledged 200 with a drop (no retry storm)', async () => {
    // The writer reports "dropped" for an unmapped/ superseded attempt.
    const apply: ApplyFn = async () => ({ action: 'dropped', reason: 'job not found' });
    const app = buildApp(apply);
    const body = JSON.stringify({ callback_id: 'ghost', video_id: 'v', status: 'failed' });
    const res = await app.handle(post(body, { 'x-heygen-signature': sign(body) }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; action: string };
    expect(json.action).toBe('dropped');
  });

  test('duplicate webhook is a no-op at the writer (idempotent)', async () => {
    let n = 0;
    const apply: ApplyFn = async () => {
      n += 1;
      return { action: n === 1 ? 'applied' : 'noop' };
    };
    const app = buildApp(apply);
    const body = JSON.stringify({
      callback_id: 'job-dup',
      video_id: 'hg',
      status: 'completed',
      video_url: 'noop://clip/hg.mp4',
    });
    const sig = sign(body);
    const first = await app.handle(post(body, { 'x-heygen-signature': sig }));
    const second = await app.handle(post(body, { 'x-heygen-signature': sig }));
    expect(((await first.json()) as { action: string }).action).toBe('applied');
    expect(((await second.json()) as { action: string }).action).toBe('noop');
  });

  test('failed status routes a failed result to the writer', async () => {
    const results: ApplyResult[] = [];
    const apply: ApplyFn = async (_jobId, result) => {
      results.push(result);
      return { action: 'applied' };
    };
    const app = buildApp(apply);
    const body = JSON.stringify({
      callback_id: 'job-x',
      video_id: 'hg',
      status: 'failed',
      failure_message: 'render error',
    });
    await app.handle(post(body, { 'x-heygen-signature': sign(body) }));
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failureMessage).toBe('render error');
  });
});
