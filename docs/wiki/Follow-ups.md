# Follow-ups / Known gaps

[[Home]] · related: [[Pipeline]] · [[Storage]] · [[Credits]] · [[Gotchas]]

What's NOT done yet, roughly in priority order.

## Done (was open, now shipped)
- [x] **Real browser e2e.** Playwright suite drives a real browser → built web bundle → nginx against a Noop docker stack (`docker-compose.e2e.yml`, root `e2e/` workspace), separate non-blocking CI job. Caught the class of bug ([[Gotchas#11]]) that `app.handle` tests structurally cannot. `bun run test` stays scoped to `apps`/`packages` so the Playwright specs don't leak into the fast suite.
- [x] **Project gallery + navigation.** Web moved to react-router: gallery (`/`) lists owned projects (new read-only `GET /projects`), `/p/:id` re-opens any past project (deep-linkable, reload-safe), `/new` to create. Full UI redesign with a design-token system + reusable components.
- [x] **Browser "HTTP 503" on Generate.** Root cause was Eden treaty against a relative base — see [[Gotchas#11]].

## Avatars, voices, style, localization — talking-photo MVP SHIPPED
See **[[Avatars-Voices]]** for what was built + the `test:true` correction ([[Gotchas#12]]).
- [x] **Style** (`american`/`russian`) → image-prompt preamble + default voice. `STYLE_PRESETS` in `@coji/shared/style`.
- [x] **Locale** (`en-US`/`ru-RU`) + `gender` → spoken language + voice (`VOICE_DEFAULTS`).
- [x] **`script` + `voiceId` populated** — create sets a locale/gender-matched voice; VO split per frame (`splitScriptForFrames`). Animation no longer throws.
- [x] **720p default** on HeyGen (`HEYGEN_RESOLUTION`). ~~`test:true`~~ doesn't exist on v3 → not wired ([[Gotchas#12]]).
- [x] DB: `projects.style`/`locale`/`gender` — migration `0003_calm_wolfpack`.
- [x] UI: Style/Locale/Presenter selects + optional VO-script textarea on `/new`.

Still open from this area:
- [ ] **VO generation (LLM)** — generate the script in the target language from the prompt (OpenRouter chat, like the shot planner), instead of falling back to the prompt when none is entered. The split (`splitScriptForFrames`) is already in place.
- [ ] **Persistent HeyGen Photo Avatars** (`/v2/photo_avatar`, Phase 2) for cross-clip identity (behind a flag).
- [ ] **Voice picker UI** — let the user pick a specific voice / preview (`GET /v2/voices`) instead of only the locale+gender default.
- [x] **ru-RU voices**: verified with a real `ru-RU`/female submit at 720p; the generated talking-head clip spoke Russian.
- [x] **Terminally-failed clip no longer hangs the project.** Was: `clips_ready` required all clips, so one terminal failure (e.g. a face-less shot) stranded the project in `animating` forever. Now **settle-based**: advance once every clip is settled — `clips_ready` if at least one succeeded, `failed` if all failed ([transition-policy.ts](../../apps/api/src/modules/jobs/transition-policy.ts)).
- [ ] **Face-less shots waste a clip (avatar_iv).** The default storyboard's `over-the-shoulder` (back of head) reliably fails HeyGen `400 "no face detected"` → that one clip is lost (refunded) and the final video has 3 clips not 4. Drop face-less presets from the default storyboard, or detect/skip them before submitting (don't spend a hold on a clip that can't animate).
- [ ] **Per-frame clip retry UI.** `retryAnimationFrame` exists (backend) but no route/UI calls it; with settle-based transitions a failed clip lands in `clips_ready`, so re-animating it would need a `clips_ready → animating` path or an editor-side "re-animate this clip" action.
- [x] **Editor clip previews.** `GET /projects/:id` now returns `clips[]` (id/idx/`videoUrl`/`durationInFrames`) via the render-stage port; the editor renders them. `video_url` is served **same-origin** through `/files` (`clipEditorUrl`) — see the editor + render shipped block below.

## Editor + export — SHIPPED this session
A real timeline editor (`apps/web/src/EditorScreen.tsx`) on the Remotion `<Player>` + a real ffmpeg export.
- [x] **Clips persisted durably + served same-origin.** `persistClip` stores a storage **key** (not a 30-min presigned URL); runner/reconciler/webhook all re-host the HeyGen mp4 to R2; reads re-sign fresh (`clipEditorUrl` → same-origin `/files`, `clipBrowserUrl` → R2 for the server render). The `/files` route gained **Range** support. ([[Gotchas]] — Brave blocks cross-origin `<video>`, so clips MUST be same-origin.)
- [x] **clips.duration_seconds** (migration `0004`) from HeyGen; editor timeline is accurate (falls back to a client `<video>` metadata probe for legacy clips).
- [x] **Timeline editor**: ruler, clip track (blocks sized to real duration), draggable playhead, click/drag-to-seek, drag-trim handles, transport (play/pause, skip, frame-nudge), per-clip download.
- [x] **Auto-trim to speech**: client-side Web-Audio RMS scan sets each clip's in/out to the speech bounds (verified against ffmpeg `silencedetect`). Buttons: "✂ Auto-trim silence" / "Reset trims".
- [x] **Real export** = `FfmpegRenderProvider` (trim+concat the clips → one mp4, h264+aac, +faststart). `RENDER_PROVIDER=ffmpeg`, ffmpeg in the api image. Editor trims are sent to export (`POST /:id/export {trims}`) and applied frame-accurately (verified: 130 frames → 4.333 s).
- [x] **Render idempotency-key collision** ([[Gotchas]]): `render:` prefix so it no longer matches the image job's key (the bug that made the render job never get created).

## Clip-composer + vertical 9:16 — SHIPPED (this session, v0.3.0)
The big one: **clip ≠ frame**. The user composes **N clips** (≤20) from the 4 reusable frames, each = a chosen shot + its own VO line; per-clip animate + regenerate. See [[Pipeline]] (the `composing` step) + [[Gotchas]] #16–#19.
- [x] **Decouple clips from frames** — `clips.script` + `clips.order_idx` (migration `0006`); `order_idx` is the single order source; `getProjectClips` orders by it. New `composing` FSM state (migration `0007` `ALTER TYPE … ADD VALUE`).
- [x] **Composer CRUD** — `GET/PUT /projects/:id/composition` + `POST /continue-to-composing`; frame picker (one shot per beat, ✓), reuse badge, debounced save, live N-cost, per-beat status + regenerate. Preview "Continue" now routes INTO the composer (#19).
- [x] **N clips/holds** — animation keyed `${clipId}:${attempt}`; `applyJobResult` settles by `payload.clipId` (frame-reuse safe; legacy `frameId` fallback); one writer preserved.
- [x] **Vertical 9:16 (TikTok/Reels)** — `@coji/shared/video` (1080×1920) drives editor + ffmpeg; **cover-crop** fill (no letterbox). Editor preview `<Video objectFit:cover>` is WYSIWYG.
- [x] **Video playback fixed** — `/files` now sends `Content-Length` (was a chunked, length-less stream that hung `<video>` — [[Gotchas]] #16).

Most of the prior "UX & usability gaps" below were closed by this + the editor/export session (re-export bump, same-origin render preview, trim persistence, partial-failure UI + per-clip re-animate, clip reorder/delete, explicit per-clip VO line). The list is kept for history; **strikethrough = now shipped**.

### New follow-ups (this session)
- [ ] **Native-portrait image generation.** 9:16 is currently cover-crop of ~16:9 clips (center-crop can clip head/shoulders on tight framing). For true full-frame portrait, generate the 4 frames vertically — `image-grid` geometry (the 2×2 contact sheet) + a portrait prompt + HeyGen portrait source. Bigger change; requires image regen.
- [ ] **Gate animation estimate is per-4, not per-N.** `continueToAnimating` prices `ANIMATION_CLIP_COUNT` (4) for the pre-flight balance check, but `enqueueAnimation` charges `per_clip × N`. Safe (enqueue re-checks + holds the real N), but the gate figure is wrong for N≠4 — unify on the composition's N.
- [ ] **`ClipViewSchema.sourceFrameId` is optional + round-robin fallback** for legacy clips that predate it — fine, but a backfill or always-populate would let the composer drop the fallback.

## UX & usability gaps (prioritised review — mostly SHIPPED, kept for history)

### P0 — broken / dead-end for the user
- [ ] **Re-export with new trims is a silent no-op.** `render_attempt` is NEVER bumped, so a second export reuses key `render:<pid>:0`; after the first render completes, editing trims + Export again returns `already_enqueued` and re-renders nothing. **Fix:** bump `projects.render_attempt` on each export (or when status is already `rendered`/`editing`) so a fresh render job is created. (`render-stage.ts enqueueExport`).
- [ ] **Final video can't be previewed in-app, and the download is Brave-fragile.** The editor only offers "Download mp4", and `renders.output_url` is a **cross-origin R2** URL — Brave blocks `<video>` preview and even the download is third-party. **Fix:** serve the render output **same-origin** via `/files` (like clips) and add an in-app `<video>` preview of the final cut on the done screen. (`runner.ts` render branch → store key + `signFileUrl`; `getProjectRender`.)
- [ ] **Editor trims are lost on reload** and **auto-trim re-runs every load**, clobbering manual edits. **Fix:** persist per-clip trims (+ an "auto-trimmed" flag) on the project/clip rows; only auto-trim once.
- [ ] **Default storyboard always wastes a clip.** `over-the-shoulder` (no face) reliably 400s on avatar_iv → every project ships 3/4 clips with no explanation. **Fix:** drop face-less presets from `DEFAULT_STORYBOARD`, or skip them before paying. (`packages/shared/src/storyboard/presets.ts`.)

### P1 — important UX, missing
- [ ] **Partial-failure has no UI.** A failed clip silently disappears; the user lands in the editor with fewer clips and no message. **Fix:** surface per-frame failed state + a "re-animate this clip" action (wire `retryAnimationFrame`).
- [ ] **No voice picker / preview.** Only the locale+gender default; the user can't choose or hear a voice. **Fix:** `GET /v2/voices`-backed picker on `/new` (+ preview audio).
- [ ] **VO-script UX is confusing.** Empty script silently falls back to the *prompt* as the spoken line (so the avatar reads the prompt). **Fix:** generate VO via LLM in the locale (the split already exists), and/or make the fallback explicit + per-clip script editing.
- [ ] **No clip reorder / delete in the editor.** Can't drop the wasted clip or change order. **Fix:** drag-reorder + per-clip remove (drives the composition order + export).
- [ ] **Progress/ETA + cancel clarity** on generating/animating screens (animation is 2–5 min; show per-clip progress, allow cancel).
- [ ] **Credits visibility** before each paid stage (animation/export estimate + balance) — partially there for animation; confirm export shows cost.

### P2 — polish / nice-to-have
- [ ] **Trim discoverability/undo**: handles only show on hover; no undo, no "reset this clip", no snapping to speech bounds.
- [ ] **Done screen**: only a download — no thumbnail, share link, or "re-edit".
- [ ] **Mobile**: editor timeline/drag on touch is unverified.
- [ ] **Regenerate a single frame** from the preview gate (retry currently re-does all 4).

### Architecture risks introduced this session
- [ ] **`/files` buffers the requested slice in api memory.** Now uses `storage.getRange` + buffers the **range slice** (not the whole object) into a sized `Response` — required so `<video>` gets a `Content-Length` ([[Gotchas]] #16). A seeking browser fetches small ranges, but the initial `bytes=0-` buffers the full clip (~0.5 MB) — fine at this scale, revisit (true streaming with a forced Content-Length) if clips grow.
- [ ] **ffmpeg render runs in-process in the api container** (CPU-heavy, can starve the event loop / no concurrency cap). **Fix:** a render worker/queue, or cap concurrency; long-term `@remotion/lambda` or a dedicated render service.
- [ ] **Legacy clips backfill.** Old projects' `clips.video_url` may still be expired HeyGen/R2 URLs (only project `02796da7` was hand-fixed). **Fix:** a one-off backfill that re-hosts legacy absolute-URL clips to R2 keys.
- [ ] **Test coverage gaps** for the new code: `FfmpegRenderProvider`, export-with-trims, `clipEditorUrl`/`/files` Range, the auto-trim algorithm. Add unit tests (the gated DB suites don't cover these).

## Product / UX (older)
- [x] **Audio input + default voice/script.** `/new` takes an optional VO-script textarea and always sets a locale/gender-matched `voiceId` at create. Remaining: edit-after-create audio panel + voice picker (above).

## Platform / prod-hardening
- [ ] **Production acceptance** with `NODE_ENV=production` + real `STRIPE_API_KEY` (Noop payments are barred in prod by design). ([[Credits]], [[Gotchas]])
- [ ] **S3/R2 storage** for production (real presigned URLs; no volume needed). Provider already exists. ([[Storage]])
- [ ] **HeyGen credits**: only ~3 free Avatar IV credits; a 4-clip project needs 4 → budget/throttle, or expose frame-count. ([[Providers]])
- [ ] **CI Postgres** so the 36 DB-gated suites actually run (they're the ones that would have caught most of [[Gotchas]]). Add a Postgres service (or pglite) to CI.
- [ ] **RenderProvider in prod**: `remotion-local` works; swap to `@remotion/lambda` for concurrent exports. Remotion **Company License** required at 4+ employees (pin 4.x — v5 = mandatory telemetry). ([[Providers]])

## Data / correctness
- [ ] FK `projects.user_id → user.id` (ownership is enforced at the app layer today).
- [ ] Webhook path in dev relies on the reconciler (no public tunnel); fine, but the HeyGen webhook signature path is only exercised by `app.handle` synthetic tests.
- [ ] Admin/top-up endpoint for credits (currently a manual SQL insert). ([[Credits]])

## Cleanup
- [ ] `getAnimationEstimate` in the web client is a raw-fetch shim (route not in the App type) — fold into the typed client or expose the route.
