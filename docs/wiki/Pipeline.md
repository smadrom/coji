# Pipeline & Lifecycle FSM

[[Home]] · related: [[Job-Runner]] · [[Providers]] · [[Credits]]

## Project lifecycle (FSM)

```
draft → images_ready → awaiting_decision → composing → animating → clips_ready → editing → rendered
                                  │               │
                                  └───────────────┘ (back to images_ready for frame regen)
                  cancelled / failed (reachable from in-flight states)
```

The FSM is table-driven in `apps/api/src/modules/projects/fsm.ts` (`canTransition` / `assertTransition`). Illegal transitions → **409**, never silent corruption. All job-driven transitions go through [[Job-Runner|applyJobResult]].

> **Clip ≠ frame (clip-composer).** A **clip** is a user-authored unit `{frame, line, order}`; a **frame** is a reusable image source. The 4 generated frames are a pose palette — any frame can back multiple clips. The project's N-clip composition (authored in the `composing` step) is the single source of truth for animation, editor order, and export.

## The 6 stages

### 1. Image (`draft → images_ready`)
`POST /projects/:id/generate-images` → places an image **credit hold**, creates a `provider_jobs(kind=image)` row, returns **202** (no inline await). The [[Job-Runner|runner]] runs the [[Providers|ImageProvider]] → 4 frames → stored → `images_ready` + hold→debit. All-or-nothing: any frame fail → full refund. Per-frame `frames[i].status` is the progress signal; each frame exposes a [[Storage|signedUrl]].

### 2. Preview gate (`images_ready → awaiting_decision`)
`POST /projects/:id/preview` then the user chooses:
- `POST /cancel` → `cancelled`
- `POST /retry {prompt?}` → re-runs the image stage (bumped attempt, fresh hold)
- `POST /continue-to-composing` → `composing` (clip-composer step; no credit charge yet)

`awaiting_decision` may sit indefinitely; signed frame URLs are regenerated on demand.

> Legacy path: `POST /continue` (old name) still transitions directly to `animating` with an auto-seeded 4-clip composition — kept for back-compat.

### 3. Composer (`composing`) — clip-composer
`GET/PUT /projects/:id/composition` — the user authors an ordered list of **N beats** (each = a frame + a VO line), stored as `clips` rows (`order_idx`, `script`, `frame_id`). Frame reuse is the point: one pose can back many clips. The draft is debounce-saved; `POST /continue` then transitions `composing → animating`. **No credit charge** in this step — holds are placed at animate.

- Max N = `MAX_CLIPS_PER_PROJECT` (20). Validated at service + animation stage.
- `POST /projects/:id/continue-to-composing` is the gateway from the preview gate.
- Clips are ordered by `clips.order_idx` (the SINGLE source of truth for order in editor, export, and `getProjectClips`).

### 4. Animation (`animating → clips_ready`)
`POST /continue` (from `composing`) enqueues **N** `provider_jobs(kind=animation)` — one per clip in the composition — each with its own `per_clip` credit hold keyed by **`${clipId}:${attempt}`**. The runner submits each clip to [[Providers|HeyGen]] (frame image + per-clip VO script via TTS), then a **webhook** (`/webhooks/heygen`) or the **reconciler** resolves completion via `applyJobResult`. `clips_ready` once all N clips are terminal (any mix of completed/failed, provided ≥1 succeeded); all failed → `failed` (full refund). Per-clip `↻ Regenerate` places one new hold under the next attempt.

> `applyJobResult` keys animation results by `payload.clipId` (not `frameId`), so a frame backing multiple clips settles each independently.

### 5. Editor (web, `clips_ready → editing`)
React + `@remotion/player`: `<Player>` + timeline scrubber (`PlayerRef` + `frameupdate`) + per-clip trim + per-fragment download. Composition = `<Series>` of `<Video>` (browser preview, NOT `<OffthreadVideo>` which needs the server renderer) with `objectFit:cover` so the preview is **WYSIWYG with the 9:16 export**. Clip order mirrors `order_idx` from the composer.

### 6. Export (`editing → rendered`)
`POST /projects/:id/export` → render hold + `provider_jobs(kind=render)` → runner runs the **`FfmpegRenderProvider`** (trim + concat the clips → one mp4, h264+aac+faststart — NOT a Remotion re-render) → output stored as a key, served same-origin via `/files` → `rendered` + debit. Editor trims are sent and applied frame-accurately.

## Output video format — vertical 9:16 (TikTok / Reels / Shorts)
Single source: **`@coji/shared/video`** (`VIDEO_WIDTH=1080`, `VIDEO_HEIGHT=1920`, `VIDEO_FPS=30`) — imported by BOTH the editor composition and `buildComposition` (the render input), so preview == export. ffmpeg uses **cover** (`scale … force_original_aspect_ratio=increase` + `crop`), so a non-9:16 clip **fills** the vertical frame (center-crop), never letterboxed. Existing ~16:9 HeyGen clips are cover-cropped on export (no regen needed). *Import from `@coji/shared/video` — NOT the package root, which drags Node-only providers into the web bundle ([[Gotchas]]).*

## Credit cost per stage
Configured in `stage_prices` ([[Credits]]): `image=per_set`, `animation=per_clip × N` (N = composed clip count), `render=per_export`.
> Note: the gate's pre-flight estimate (`continueToAnimating`) still prices `ANIMATION_CLIP_COUNT` (4); `enqueueAnimation` does the real `per_clip × N` balance check + holds, so a too-low gate estimate can't over-spend — but the figures differ ([[Follow-ups]]).
