/**
 * Centralised, typed access to environment configuration.
 *
 * Provider selection and the credit/lease knobs are config-driven so behaviour
 * changes need no code change (ADR-2, ADR-6). Defaults keep CI free: Noop
 * providers + local-filesystem storage, no external keys required.
 */

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  port: int('PORT', 3001),
  databaseUrl: str('DATABASE_URL', 'postgres://coji:coji@127.0.0.1:5432/coji'),

  imageProvider: str('IMAGE_PROVIDER', 'noop'),
  animationProvider: str('ANIMATION_PROVIDER', 'noop'),
  renderProvider: str('RENDER_PROVIDER', 'noop'),
  storageProvider: str('STORAGE_PROVIDER', 'local-fs'),

  storageLocalDir: str('STORAGE_LOCAL_DIR', '.storage'),
  leaseTtlMs: int('LEASE_TTL_MS', 60_000),
  creditUsdRate: int('CREDIT_USD_RATE', 1),

  // Job runner lifecycle (server.ts). The background tick is opt-in so tests /
  // app.handle never spawn it implicitly; server boot enables it explicitly.
  runnerEnabled: str('RUNNER_ENABLED', 'false') === 'true',
  runnerTickMs: int('RUNNER_TICK_MS', 1_000),
  // Dev-only manual trigger route (POST /internal/runner/tick) — off by default.
  runnerDevTickRoute: str('RUNNER_DEV_TICK_ROUTE', 'false') === 'true',
  // Stable id for this runner instance's claims (claimed_by).
  runnerInstanceId: str('RUNNER_INSTANCE_ID', `api-${process.pid}`),

  // Animation reconciler (P3): poll provider for jobs stuck in `processing`
  // past `staleMs`; sweep jobs older than `maxAgeMs` to failed (refund). The
  // max-age MUST exceed the worst-case submission backoff window (plan note 4).
  reconcileStaleMs: int('RECONCILE_STALE_MS', 30_000),
  reconcileMaxAgeMs: int('RECONCILE_MAX_AGE_MS', 30 * 60_000),

  // Payments (P-pay): default to the free Noop; 'stripe' for real. Noop is
  // barred in production at boot (see modules/billing).
  paymentsProvider: str('PAYMENTS_PROVIDER', 'noop'),
  paymentsWebhookSecret: str('PAYMENTS_WEBHOOK_SECRET', 'dev-noop-secret'),
  stripeApiKey: str('STRIPE_API_KEY', ''),
  paymentsSuccessUrl: str('PAYMENTS_SUCCESS_URL', 'http://localhost:5173/billing?status=success'),
  paymentsCancelUrl: str('PAYMENTS_CANCEL_URL', 'http://localhost:5173/billing?status=cancel'),
  nodeEnv: str('NODE_ENV', 'development'),

  // Better Auth (task #22). Secret required in production (modules/auth/auth.ts
  // prod-throws if left at the dev fallback); dev fallback keeps local/test easy.
  betterAuthSecret: str('BETTER_AUTH_SECRET', 'dev-secret-change-me'),
  betterAuthUrl: str('BETTER_AUTH_URL', `http://localhost:${int('PORT', 3001)}`),
  // Dev/test escape hatch: when true, resolveAuth also accepts an `x-user-id`
  // header (no real session). MUST stay false in production. The app.handle test
  // suites enable it so they exercise the real guard without a live session.
  authTestHeader: str('AUTH_TEST_HEADER', 'false') === 'true',

  // Provider secrets — empty in CI (fakes are the default; never logged).
  geminiApiKey: str('GEMINI_API_KEY', ''),
  openrouterApiKey: str('OPENROUTER_API_KEY', ''),
  openrouterSiteUrl: str('OPENROUTER_SITE_URL', 'http://localhost:5173'),
  openrouterAppName: str('OPENROUTER_APP_NAME', 'coji'),
  openrouterImageModel: str('OPENROUTER_IMAGE_MODEL', ''),
  // Quality-mode model overrides. Draft = cheap/fast; Max = best quality.
  // When unset, both fall back to openrouterImageModel (then the provider default).
  openrouterImageModelDraft: str('OPENROUTER_IMAGE_MODEL_DRAFT', ''),
  openrouterImageModelMax: str('OPENROUTER_IMAGE_MODEL_MAX', ''),
  // Chat model used by the shot planner to adapt per-shot actions to the
  // prompt/script. Cheap text model; only called when OPENROUTER_API_KEY is set.
  openrouterChatModel: str('OPENROUTER_CHAT_MODEL', 'google/gemini-2.5-flash'),
  heygenApiKey: str('HEYGEN_API_KEY', ''),
  heygenWebhookSecret: str('HEYGEN_WEBHOOK_SECRET', ''),
  // HeyGen cost lever: default render resolution for avatar_iv clips. 720p is
  // the cheapest standard tier. NOTE: HeyGen's `/v3/videos` has NO `test`/
  // watermark flag (it 400s "Extra inputs are not permitted") — resolution +
  // short scripts are the real levers; CI/e2e cost-safety is the Noop seam.
  heygenResolution: str('HEYGEN_RESOLUTION', '720p'),

  // S3 / R2 — only read when STORAGE_PROVIDER=s3.
  // TTL floor: 1 800 s (30 min) per M2 provider-fetch-window constraint.
  s3Endpoint: str('S3_ENDPOINT', ''),
  s3Region: str('S3_REGION', 'us-east-1'),
  s3Bucket: str('S3_BUCKET', ''),
  s3AccessKeyId: str('S3_ACCESS_KEY_ID', ''),
  s3SecretAccessKey: str('S3_SECRET_ACCESS_KEY', ''),
  s3ForcePathStyle: str('S3_FORCE_PATH_STYLE', '') === 'true',
  storageSignedUrlTtlSeconds: int('STORAGE_SIGNED_URL_TTL_SECONDS', 1_800),
} as const;

export type Env = typeof env;
