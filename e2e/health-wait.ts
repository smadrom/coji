/**
 * Health-wait with a timeout budget (Phase 4a).
 *
 * Polls the e2e stack until BOTH gates pass or the budget runs out, then exits
 * 0 (ready) / 1 (timed out — with the last error so CI logs show why):
 *
 *   1. web shell      GET {BASE}/            -> 200 (nginx serving the SPA)
 *   2. api via nginx  GET {BASE}/health      -> ok (proxied to api:3001/health)
 *
 * Both go through the published web origin so we verify the SAME path the
 * browser uses (nginx + `/api`-strip), not the api port directly.
 *
 * Env: E2E_BASE_URL (default http://localhost:8080),
 *      E2E_HEALTH_TIMEOUT_MS (default 180000), E2E_HEALTH_INTERVAL_MS (1500).
 */
const baseURL = (process.env.E2E_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const budgetMs = Number(process.env.E2E_HEALTH_TIMEOUT_MS ?? 180_000);
const intervalMs = Number(process.env.E2E_HEALTH_INTERVAL_MS ?? 1_500);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function check(path: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${baseURL}${path}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: res.ok || res.status === 304, detail: `${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

const started = Date.now();
let last = '';
while (Date.now() - started < budgetMs) {
  const web = await check('/');
  const health = await check('/health');
  if (web.ok && health.ok) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `health-wait: stack ready in ${elapsed}s (web=${web.detail} health=${health.detail})`,
    );
    process.exit(0);
  }
  last = `web=${web.detail} health=${health.detail}`;
  await sleep(intervalMs);
}

console.error(`health-wait: stack not ready within ${budgetMs}ms at ${baseURL} (last: ${last})`);
process.exit(1);
