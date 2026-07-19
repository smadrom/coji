import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
/**
 * @coji/api — Elysia app for the AI video-generation service.
 *
 * The literal `.use()` chain below is the Eden type spine: it must NOT be
 * reduced/looped over, because `export type App = typeof app` is what gives the
 * web client end-to-end type safety with no codegen. Feature modules mount onto
 * this chain via `.use(<module>Routes)`.
 *
 * Built-in OpenAPI (@elysiajs/openapi) serves the spec + Scalar UI at /openapi.
 * The MCP plugin reflects read-only opted-in routes (TypeBox is the single
 * source for validation + OpenAPI + MCP tool shapes).
 */
import { Elysia, t } from 'elysia';
import pkg from '../package.json' with { type: 'json' };
import { getProviders } from './config/providers.ts';
import { db } from './db/index.ts';
import { env } from './env.ts';
import { aiRoutes } from './modules/ai/routes.ts';
import { authRoutes } from './modules/auth/routes.ts';
import { getPaymentProvider } from './modules/billing/provider.ts';
import { billingRoutes } from './modules/billing/routes.ts';
import { createBillingService } from './modules/billing/service.ts';
import { filesRoutes } from './modules/files/routes.ts';
import { runnerRoutes } from './modules/jobs/runner-routes.ts';
import { heygenWebhookRoutes } from './modules/jobs/webhook-routes.ts';
import { mcpPlugin } from './modules/mcp/plugin.ts';
import { createDbAnimationStage } from './modules/projects/animation-stage.ts';
import { createDbComposerStage } from './modules/projects/composer-stage.ts';
import { createDbImageStage } from './modules/projects/image-stage.ts';
import { createDbPreviewGate } from './modules/projects/preview-gate.ts';
import { createDbRenderStage } from './modules/projects/render-stage.ts';
import { createDbProjectsRepository } from './modules/projects/repository.ts';
import { projectsRoutes } from './modules/projects/routes.ts';
import { createProjectsService } from './modules/projects/service.ts';
import { MCP_ROUTES } from './modules/registry.ts';
import { voicesRoutes } from './modules/voices/routes.ts';

/** App version (package.json) — surfaced at /health so the live build is visible. */
const APP_VERSION = pkg.version;

// Production wiring: Drizzle-backed projects service + image stage (provider_jobs
// + frames + credit hold) + preview gate (cancel/retry/continue transitions) +
// render stage (export → render job + hold). Acceptance tests build a parallel
// app with in-memory fakes (see modules/projects/*.test.ts).
const projectsService = createProjectsService(
  createDbProjectsRepository(),
  createDbImageStage(),
  createDbPreviewGate(),
  createDbRenderStage(),
  createDbAnimationStage(),
  createDbComposerStage(),
);

// Billing (P-pay): payment provider (Noop default; Stripe for real, barred in
// prod as Noop) + the credit-ledger top-up bridge.
const billingService = createBillingService({ db, provider: getPaymentProvider() });

export const app = new Elysia()
  .use(cors())
  .use(
    openapi({
      documentation: {
        info: {
          title: 'Coji — AI Video-Generation API',
          version: '0.1.0',
          description:
            'Elysia + Drizzle service: prompt → 4 consistent frames → HeyGen clips → Remotion export.',
        },
        tags: [
          { name: 'system', description: 'Health & meta' },
          { name: 'auth', description: 'Authentication (Better Auth)' },
          { name: 'projects', description: 'Project lifecycle' },
          { name: 'mcp', description: 'Model Context Protocol tools' },
        ],
      },
    }),
  )
  .get('/health', () => ({ status: 'ok', version: APP_VERSION }) as const, {
    response: t.Object({ status: t.Literal('ok'), version: t.String() }),
    detail: { summary: 'Health check', tags: ['system'] },
  })
  // Better Auth handler (/api/auth/*) + /api/me — mounted before feature routes
  // so the bearer session resolves for everything downstream (task #22).
  .use(authRoutes())
  .use(aiRoutes())
  .use(projectsRoutes(projectsService))
  .use(voicesRoutes())
  .use(runnerRoutes())
  .use(heygenWebhookRoutes({ db, providers: getProviders }))
  .use(billingRoutes({ service: billingService, webhookSecret: env.paymentsWebhookSecret }))
  .use(filesRoutes())
  .use(mcpPlugin(MCP_ROUTES));

/** App type for the Eden treaty client (imported by @coji/shared/client). */
export type App = typeof app;
