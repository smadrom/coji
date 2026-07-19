# Providers (seams)

[[Home]] · related: [[Job-Runner]] · [[Storage]] · [[Pipeline]]

Every external/paid integration sits behind an interface in `packages/shared/src/providers/types.ts`, selected by env in `apps/api/src/config/providers.ts`. **Defaults are free fakes → CI never spends money.**

## ImageProvider — `IMAGE_PROVIDER`
prompt → 4 same-person `GeneratedFrame[]` (idx, bytes, contentType, caption).

| value | impl | notes |
|---|---|---|
| `noop` (default) | `NoopImageProvider` | deterministic placeholder frames |
| `gemini` | `apps/api/src/providers/gemini.ts` | `@google/genai`, model `gemini-3.1-flash-image`, `generateContent` (`responseModalities:['TEXT','IMAGE']`). Frame-0 fed back as `inlineData` reference for consistency. Needs `GEMINI_API_KEY`. No `candidateCount>1` (400). |
| `openrouter` | `apps/api/src/providers/openrouter.ts` | OpenRouter chat-completions, default model `google/gemini-3.1-flash-image-preview`, `modalities:['image','text']`, image = base64 data-URL in `choices[0].message.images[]`. One 2×2 grid generation is cropped into four consistent frames. Needs `OPENROUTER_API_KEY`; model and public attribution are configurable with `OPENROUTER_*`. |

> Imagen (`:predict`) is NOT available via OpenRouter — only the "Flash Image" chat models.

## AnimationProvider — `ANIMATION_PROVIDER`
image-to-video (talking avatar). `submit(input) → {externalId}` then async resolve via webhook/`fetchResult`.

| value | impl | notes |
|---|---|---|
| `noop` (default) | `NoopAnimationProvider` | deterministic, synchronously resolvable |
| `heygen` | `apps/api/src/providers/heygen.ts` | HeyGen **v3** (`X-Api-Key`). Upload frame bytes → `POST /v3/assets` → `POST /v3/videos` `{type:image, image:{type:asset_id}, AUDIO, callback_url, callback_id}`. ⚠️ **No `engine`/`motion_prompt`** for `type:image` (only `type:avatar`). Audio required: tts `script`+`voice_id` (`GET /v3/voices`) or `audio_url`. 429/5xx = retryable (no refund); 4xx = terminal. Webhook helpers: signature verify + `callback_id`→`provider_jobs.id`. |

> HeyGen "v4/v5" don't exist — those are engine names (`avatar_iv`/`avatar_v`). v1/v2 sunset 2026-10-31.
> Free Avatar IV credits are limited (≈3); a 4-clip project needs 4.

**Cost levers (don't burn the limited key).** avatar_iv cost ≈ duration × resolution × voice tier:
> 1. ~~`test: true` on `POST /v3/videos`~~ — **DOES NOT EXIST.** v3 image-to-video rejects it with `400 "Extra inputs are not permitted", param: test` (verified, [[Gotchas#12]]). Do **not** send it (it would 400 every submit). The watermark/test flag is a `/v2/video/generate` feature, not v3.
> 2. **`resolution` = `720p` default** — wired in `heygen.ts` (`HeyGenProviderOptions.defaultResolution`, env `HEYGEN_RESOLUTION`, applied as `body.resolution = input.resolution ?? default`). This is the real, schema-valid lever.
> 3. **Short `script` per clip** (credits scale with seconds) — the per-frame VO split (`splitScriptForFrames`) keeps each clip's line short.
> 4. Standard HeyGen TTS voices (curated in `VOICE_DEFAULTS`, `@coji/shared/style`), not premium/ElevenLabs.
> 5. **Dev/test cost-safety = the Noop seam**, not a test flag: `ANIMATION_PROVIDER=noop` in CI/e2e/dev never calls HeyGen. Use `GET /v2/user/remaining_quota` to inspect the current account quota and `GET /v2/voices` for the full voice catalogue.

**Next phase — avatars/voices/style/localization:** see [[Avatars-Voices]]. Project gains a
`style` (american/russian → look + voice) and `locale` (en-US/ru-RU → spoken language). MVP =
talking-photo (current); persistent HeyGen Photo Avatars (`/v2/photo_avatar`) are Phase 2.

## RenderProvider — `RENDER_PROVIDER`
composition (clips + audio) → final mp4.

| value | impl | notes |
|---|---|---|
| `noop` (default) | `NoopRenderProvider` | fake render (CI/e2e/dev) |
| **`ffmpeg`** | `apps/api/src/providers/ffmpeg-render.ts` | **The primary export.** The clips are already rendered videos → export = **trim + concat**, not a frame-by-frame composite. Downloads each clip, trims to its in/out (`startFrom/endAt` frames → seconds), normalises size/fps/pix-fmt/sample-rate, concatenates → one mp4 (`libx264`+`aac`, `+faststart`). Needs the **`ffmpeg` binary** (installed in the api image via `apk add ffmpeg`). Trim timing was verified at frame precision. |
| `remotion-local` | `apps/api/src/providers/remotion-render.ts` | Remotion 4.0.491 under Bun. Overkill for joining existing clips (re-renders every frame through Chromium) — kept for true composites. `<OffthreadVideo>` needs http(s) URLs. Keep all Remotion packages on the same pinned version and review its custom license. |

> **Why ffmpeg, not Remotion, for export:** the talking-head clips are finished videos; concatenating them with ffmpeg is orders of magnitude lighter/faster than spinning up Remotion+Chromium. Remotion's `<Player>` is still the in-browser editor PREVIEW. Editor per-clip trims are sent on `POST /:id/export {trims}` → composition `startFrom/endAt` → ffmpeg. ([[Gotchas]])
> Render runs **in-process in the api container** (CPU-heavy, no concurrency cap) — fine at current scale; a render worker/queue or `@remotion/lambda` is the prod scale path ([[Follow-ups]]).

## StorageProvider — `STORAGE_PROVIDER`
See [[Storage]]. `local-fs` (default, needs a persistent volume) or `s3` (S3/R2 via `@aws-sdk/client-s3`).

## PaymentProvider — `PAYMENTS_PROVIDER`
See [[Credits]]. `noop` (default; **barred in prod**) or `stripe`.
