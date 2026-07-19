/**
 * Dev-only runner trigger route (P1 / task #14).
 *
 * Mounts `POST /internal/runner/tick` ONLY when RUNNER_DEV_TICK_ROUTE=true, so
 * local development can drain the job queue on demand without waiting for the
 * background interval. It is never mounted in CI/prod by default, and carries no
 * auth — keep it behind the env flag and off in any public deployment.
 *
 * The route is always part of the Eden `.use()` chain (so the type spine is
 * stable); when the flag is off it simply registers no endpoints.
 */
import { Elysia, t } from 'elysia';
import { env } from '../../env.ts';
import { tickOnce } from './runner-lifecycle.ts';

export function runnerRoutes() {
  const app = new Elysia({ name: 'runner-internal' });
  if (!env.runnerDevTickRoute) return app;
  return app.post(
    '/internal/runner/tick',
    async () => {
      const processed = await tickOnce();
      return { processed };
    },
    {
      response: t.Object({ processed: t.Integer() }),
      detail: {
        summary: 'DEV ONLY: drain the job queue once',
        tags: ['system'],
      },
    },
  );
}
