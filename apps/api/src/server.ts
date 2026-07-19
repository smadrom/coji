/**
 * Runtime entrypoint. Kept separate from app.ts so tests can import `app` and
 * drive it with `app.handle(...)` without starting a listener.
 */
import { app } from './app.ts';
import { env } from './env.ts';
import { startRunner } from './modules/jobs/runner-lifecycle.ts';

app.listen(env.port);

// Start the background job runner loop (opt-in via RUNNER_ENABLED). Done here,
// not in app.ts, so app.handle(...) tests never spawn a timer implicitly.
const runnerStarted = startRunner();

console.log(
  `coji api on http://localhost:${env.port}  (OpenAPI: /openapi)` +
    `  runner=${runnerStarted ? `on@${env.runnerTickMs}ms` : 'off'}`,
);
