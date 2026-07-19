# Gotchas — bugs found & fixed

[[Home]] · related: [[Deployment]] · [[Job-Runner]] · [[Auth]]

These issues were found while moving from green CI to a real browser deployment. Most slipped past CI because the relevant tests are **DB-gated and skipped without a Postgres**, or only exercised via the [[Auth|AUTH_TEST_HEADER]] hatch (not the real HTTP path).

## 1. Bun workspaces nest devDeps → Docker images broke
`bun install` hoists most deps to root `node_modules` but **nests some workspace devDeps** under `apps/*/node_modules`. The original Dockerfiles copied only root `node_modules` across stages → `vite`/`@vitejs/plugin-react` (web) and `drizzle-kit` (api migrate) were missing.
**Fix:** run `bun install --frozen-lockfile` **inside the build/runtime stage** with the full manifest graph. (`apps/web/Dockerfile`, `apps/api/Dockerfile`.)

## 2. Better Auth `.mount` strips the prefix → 404
`.mount('/api/auth', auth.handler)` strips `/api/auth` before the handler, but Better Auth expects the full path → all auth routes 404.
**Fix:** `.all('/api/auth/*', ({ request }) => auth.handler(request))`. ([[Auth]])

## 3. `FOR UPDATE SKIP LOCKED` before `LIMIT` → SQL error
Postgres requires the locking clause **after** `LIMIT`. The claim query had it before → every runner tick failed.
**Fix:** `... ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`. ([[Job-Runner]])

## 4. postgres-js under Bun rejects `Date` in raw SQL
Drizzle's query-builder maps `Date`→ISO via column types, but raw `` sql`${dateObj}` `` passes the `Date` straight to postgres-js, which under Bun throws *"string argument must be ... Received an instance of Date"*. Affected `runner.ts` (claim/lease) and `reconciler.ts`.
**Fix:** interpolate `.toISOString()` in raw SQL. ([[Job-Runner]])

## 5. `RUNNER_ENABLED=1` did nothing
`env.ts` checks `=== 'true'`. `'1'` → runner off.
**Fix:** `RUNNER_ENABLED=true`. ([[Runbook]])

## 6. `PAYMENTS_PROVIDER=noop` throws in prod (by design)
Boot gate bars Noop payments when `NODE_ENV=production`.
**Fix (test deploy):** run `NODE_ENV=development`. Prod must use `stripe` + `STRIPE_API_KEY`. ([[Credits]])

## 7. `stage_prices` empty → paid stages 500
`unitPrice` throws if no row.
**Fix:** seed the table on first run. ([[Runbook]], [[Credits]])

## 8. local-fs storage isn't persistent / not browser-loadable
Files lived inside the api container (lost on recreate) and `getSignedUrl` returned a `local://` string `<img>` can't load.
**Fix:** mount a persistent volume (`coji-storage:/data/storage`, `STORAGE_LOCAL_DIR`) **and** add the signed `/files` route. ([[Storage]])
> **Follow-on (found via the gallery):** `signFileUrl()` mints a **relative `/files?...`** URL, but the web nginx only proxied `/api/`, `/health`, `/assets/` — so `/files` fell through to the SPA fallback (`try_files → /index.html`) and `<img>` got HTML → **broken images in the browser** (curl/direct-to-api hid it, same pattern as #11). **Fix:** add `location /files { proxy_pass http://api:3001; }` (no URI part → preserves `/files?...`, no `/api` strip) in `apps/web/nginx.conf`.

## 9. `BETTER_AUTH_URL` unset → browser "Invalid origin"
Better Auth defaults `baseURL` to `http://localhost:3001`; a browser origin such as `https://coji.example.com` is then rejected. curl (no Origin header) masked it.
**Fix:** set `BETTER_AUTH_URL` to the exact public web origin. ([[Auth]])

## 10. nginx `/api/` strip + web `BASE_URL=/api` → double `/api`
The web client base is `/api`; feature routes are at root (`/projects`) and auth at `/api/*`. nginx `proxy_pass http://api:3001/` strips one `/api/`. Net effect: `/api/projects` → `/projects` ✅, and `/api/api/auth/*` → `/api/auth/*` ✅. Consistent **only** because the strip cancels the extra prefix — keep this in mind before touching the proxy or client base. ([[Deployment]])

## 11. Eden `treaty('/api')` relative base → browser "HTTP 503" (the big one)
The web client built the Eden treaty client against a **relative** base `/api` (`apps/web/src/api.ts`, baked by `apps/web/Dockerfile` `ARG VITE_API_URL=/api`). **Eden `treaty(domain)` requires an absolute origin** — given `/api` it treats the first path segment as the **hostname**, so the browser fetched `https://api/projects/:id/generate-images` → `net::ERR_NAME_NOT_RESOLVED`, which the UI rendered as a bogus **"HTTP 503"**. No server ever emitted 503 (the `server:` header was absent — the request never reached nginx/Traefik/Elysia).
**Why it was browser-only and invisible:** curl hit explicit correct paths; the **raw-`fetch` shims** (`PromptScreen` create, `billing.ts`, `getAnimationEstimate`) use a relative `/api/...` the browser resolves same-origin → 200. Only **Eden treaty** calls (`generateImages`, `getProject`, `cancel`, `retry`, `continue`, `export`, and the new `GET /projects`) broke. The existing `app.handle` "e2e" never construct a treaty client against a relative base, so they never caught it — **this is the bug that motivated real Playwright e2e** (browser → built bundle → nginx).
**Fix:** in `apps/web/src/api.ts`, qualify a same-origin relative `VITE_API_URL` with `window.location.origin` before handing it to treaty (keeps the `/api` prefix so the nginx `/api/`-strip in #10 is unchanged). Browser verification covered `POST /api/projects/:id/generate-images` → 202 and the project reaching `images_ready` with four frames. **`BASE_URL` is baked at vite build → the web image MUST be rebuilt (`up -d --build`) on every client/path change; keep the previous `coji-web` image for rollback.**

## 12. HeyGen `/v3/videos` has NO `test`/watermark flag (the planned #1 cost lever doesn't exist)
The avatars-voices handoff + [[Avatars-Voices]] + [[Providers]] all assumed `test: true` on `POST /v3/videos` would return a watermarked, ~free preview (so wiring animation wouldn't burn the limited key). **It doesn't exist on this endpoint.** A real submit (valid uploaded asset, server key) returns:
```
400 {"error":{"code":"invalid_parameter","message":"Extra inputs are not permitted","param":"test"}}
```
`test:true` is a field on the older `/v2/video/generate` (avatar/template) endpoint, not the v3 image-to-video (`avatar_iv`) path coji uses. **Had we wired `body.test = true` blindly (as the handoff said to do first), every real animation submit would 400** — breaking the feature entirely. Verifying with a real submit first (as the handoff also instructed) is what caught it.
**What actually controls cost on `/v3/videos`:** (1) `resolution` (confirmed schema-valid; reached face-detection) — default **720p**; (2) **short scripts** (credits scale with seconds) → the per-frame VO split keeps each clip short; (3) the **Noop seam** is the real dev/test cost-safety (CI/e2e/dev all run `ANIMATION_PROVIDER=noop`, never calling HeyGen). Check account quota through the provider API before live tests. See [[Providers]], [[Avatars-Voices]].
> Voices: `GET /v3/voices` may return a smaller standard catalogue; use `GET /v2/voices` for the full locale-aware catalogue. `VOICE_DEFAULTS` in `@coji/shared/style` is curated from that response.

## 13. Brave (and similar) BLOCK cross-origin `<video>` — clips must be SAME-ORIGIN
The timeline editor stuck on "Loading clips…" forever in Brave. Diagnosed in-browser: a `<video>` pointed at ANY third-party origin (HeyGen `files2.heygen.ai`, our R2 `*.r2.cloudflarestorage.com`, **and even Google's public `commondatastorage.googleapis.com/...ForBiggerBlazes.mp4`**) never loads — `video.networkState=0`/`readyState=0`, no error — while `fetch()` of the same URL returns **206** and `<img>` of cross-origin images works fine. `navigator.brave === true`. So it's Brave's media/Shields blocking cross-origin `<video>`, not a coji bug or CORS (no CSP present).
**Fix:** serve every clip the EDITOR plays **same-origin** through the signed `/files` stream (`clipEditorUrl` → `signFileUrl(key)`), NOT the storage's own cross-origin presigned URL. The SERVER render (`clipBrowserUrl` → R2 presigned) is unaffected — no browser. Same applies to `renders.output_url` (still cross-origin — [[Follow-ups]] P0). See [[Storage]].
> Also: a detached `document.createElement('video')` used only to probe `loadedmetadata` gets **garbage-collected before the event fires** → mount probe `<video>`s in JSX (React keeps them alive). And the Remotion `<Player>`'s rAF loop **freezes CDP `Page.captureScreenshot`** — read the DOM via JS instead of screenshotting the editor.

## 14. Clips were stored as short-lived URLs → died within the hour
`clips.video_url` was persisted inconsistently and non-durably: the runner's poll path stored the **raw HeyGen CDN URL** (expires ~7 days), while `persistClip` (reconciler/webhook) re-hosted to R2 but returned a **30-minute presigned URL** — so that clip became unplayable within the hour. A clip that "worked" at generation was dead by the time the user opened the editor.
**Fix (ADR-5 done right):** `persistClip` stores the storage **KEY**; ALL completion paths (runner poll / reconciler / webhook) re-host the provider mp4 to R2 under a key; the browser/render URL is minted **fresh on read** (`clipEditorUrl` / `clipBrowserUrl`), exactly like frame `image_ref`. Never persist a presigned/provider URL as the durable reference. ([[Storage]], [[Job-Runner]])

## 15. Render idempotency key collided with the IMAGE key → render job never created
`renderIdempotencyKey` was `${projectId}:${renderAttempt}` — **identical** to the image job's `${projectId}:${attempt}` when both are 0. `provider_jobs.idempotency_key` is UNIQUE across the whole table, so `enqueueExport`'s dup-check matched the **image** job and returned `already_enqueued` — a render job was **never created**. Export silently did nothing for every project (with Noop too). Symptom: "render doesn't work."
**Fix:** prefix render keys → `render:${projectId}:${renderAttempt}`. Lesson: namespace idempotency keys per stage; the table-wide UNIQUE makes bare `pid:N` keys collide across stages. (Open: `render_attempt` is also never bumped → re-export is a no-op — [[Follow-ups]] P0.)

## 16. `/files` streamed body dropped `Content-Length` → `<video>` hung forever
The F1 change made `/files` return `new Response(stream)` (a `ReadableStream` from `storage.getRange`). **Bun drops a manually-set `Content-Length` for a stream body and serves it chunked.** A media response with no `Content-Length` makes `<video>` stall in `NETWORK_LOADING` (`readyState=0`, no error) — even for a faststart MP4 — while `fetch()` of the SAME url returns 200/206 with all bytes (fetch just drains the stream; the media element needs the length to range-seek). Editor clips + the done-screen render preview both stuck on "Loading clips…". Found via live smoke (server response was textbook-correct; only the `<video>` element failed).
**Fix:** buffer the (bounded, range-sized) slice into a `Uint8Array` and return `new Response(body)` — Bun then emits a real `Content-Length`. A seeking browser fetches small ranges, so this never buffers the whole object. (`apps/api/src/modules/files/routes.ts`.) Extends #13 (same-origin alone wasn't enough — length matters too).

## 17. Composer marked ALL 4 shots selected — frames DTO never exposed `id`
The clip-composer picks ONE shot per beat: `active = beat.sourceFrameId === frame.id`. But `getProjectFrames` / `FrameProgressSchema` returned only `{idx, status, imageRef, caption}` — **no `id`** — so `frame.id` was `undefined` for all 4, and `undefined === undefined` marked **every** shot selected (and a saved sourceFrameId couldn't round-trip). The web `FrameRow` TYPE claimed `id: string`, which hid it from typecheck.
**Fix:** `getProjectFrames` selects `frames.id` + `FrameProgressSchema` exposes it (optional, so in-memory fakes still pass); `getProjectClips` returns `clips.frame_id` as `sourceFrameId` so a reloaded draft restores the chosen shot; the composer guards `!!frame.id && …`. Lesson: a too-loose web type (`id: string` on data that lacks it) masks a missing-field bug — the runtime `undefined===undefined` is the tell.

## 18. Importing `@coji/shared` ROOT broke the web (vite) build
`@coji/shared` root (`index.ts`) does `export * from './providers'`, which transitively pulls `storage-local.ts` (`node:fs`/`node:path`) + `payments-noop.ts` (`node:crypto`). The web bundles via vite/rollup → importing the **root** drags Node-only modules into the browser bundle → `vite build` **fails on `node:path`**. Typecheck passed (TS resolves the root fine); only the bundler broke. The web only ever imported safe LEAF subpaths (`@coji/shared/style`, `/storyboard`) — adding a root import for `VIDEO_WIDTH` broke it. The first 9:16 deploy reported exit 0 but the web image **never rebuilt** (build failed inside `up -d --build`), so containers kept the old version.
**Fix:** put browser-safe constants in a LEAF module `@coji/shared/video` (zero Node imports) + an `exports` entry; import `@coji/shared/video`, never the root, from web. **Lesson: for web changes, run the real `vite build` (not just `tsc --noEmit`) before deploying — typecheck does NOT catch bundler/resolution failures. And confirm containers actually recreated (uptime) after a deploy.**

## 19. Composer was unreachable — preview "Continue" skipped the `composing` step
The clip-composer screen + `composing` state shipped, but the preview gate's **Continue** button still called `continueProject` (`awaiting_decision → animating` directly), so a new project bypassed the composer entirely — the user never saw where to put a line per clip.
**Fix:** `PreviewScreen.handleContinue` → `continueToComposing` (`awaiting_decision → composing` → `ComposerScreen`); the paid Animate runs from the composer. Lesson: shipping a new pipeline STEP isn't done until the prior screen's primary CTA actually routes INTO it.

## Also re-confirmed (not bugs, just facts)
- **Export = trim + concat the already-rendered clips via ffmpeg** — NOT a Remotion/Chromium re-render. `RENDER_PROVIDER=ffmpeg` (ffmpeg in the api image); orders of magnitude lighter. Remotion `<Player>` is still the browser PREVIEW. ([[Providers]])
- **HeyGen avatar_iv needs a real face** in the source image → a face-less shot (the default storyboard's `over-the-shoulder` = back of head) returns `400 "no face detected"` and that clip is lost every time. Rejected requests cost 0 quota.
- **R2 (S3-API endpoint) needs a bucket CORS policy** for browser access; set GET/HEAD for the web origin (done). Images load cross-origin via `<img>` regardless; video does not (see #13).
- `STORAGE_SIGNED_URL_TTL_SECONDS` is 1800 (30 min) — fine when re-signed per read, fatal if persisted (see #14).
- Remotion render works under Bun + headless Chromium; `<OffthreadVideo>` needs http(s) URLs, not `file://`.
- HeyGen has no "v4/v5" API (engine names); `engine`/`motion_prompt` are invalid on `type:image`.
- OpenRouter returns images as base64 data-URLs and may use **JPEG or PNG** → derive content-type, don't hardcode.
