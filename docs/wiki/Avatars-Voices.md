# Avatars, Voices, Style & Localization

[[Home]] · related: [[Providers]] · [[Pipeline]] · [[Gotchas]]

> **Status: BUILT (talking-photo MVP).** A project now has a **style** (`american`/`russian`)
> and a **locale** (`en-US`/`ru-RU`) + `gender` that drive (1) the look of the generated
> person (image-prompt preamble), (2) the HeyGen voice (`VOICE_DEFAULTS` by locale+gender),
> and (3) the spoken language. The VO script is **split per frame** so each clip speaks its
> own line. Persistent avatar creation (`/v2/photo_avatar`) is still **Phase 2 (not built)**.
>
> **⚠️ Correction vs the original design:** the planned #1 cost lever, **`test: true`**, **does
> not exist** on HeyGen `/v3/videos` — it 400s with `"Extra inputs are not permitted"`
> (verified, [[Gotchas#12]]). It was NOT wired (doing so would break every submit). The real
> cost levers are **`resolution=720p` default** + **short per-frame scripts** + the **Noop
> seam** for CI/dev. See the updated "Cost levers" below.

## What was built (this phase)
- **`@coji/shared/style`** (`packages/shared/src/style/presets.ts`): `STYLE_PRESETS`
  (american/russian → `imagePreamble` + `defaultLocale` + `defaultGender`), `LOCALES`,
  `VOICE_DEFAULTS` (real HeyGen voice ids from `GET /v2/voices`), `defaultVoiceId`,
  `localeForStyle`, and **`splitScriptForFrames(script, n)`** (sentence → word-chunk → cycle).
- **DB**: `projects.style` / `locale` / `gender` (text, defaulted) — migration `0003_calm_wolfpack`.
- **Create** (`service.resolveProjectDefaults`): style defaults to american; locale+gender
  derive from the style; `voiceId` resolves from locale+gender unless the caller picked one.
  Threaded through `CreateProjectBody`, `CreateProjectInput`, both repos, DTO.
- **Photo**: the image job payload carries `style`; the runner prepends
  `STYLE_PRESETS[style].imagePreamble` to the grid prompt (`runner.ts` image case;
  image-stage + preview-gate retry payloads).
- **Per-frame VO** (`resolveFrameAudioPayloads`): the script (or the prompt, when none was
  entered) is split into one line per clip; each animation job gets its own `script` + the
  shared `voice_id`. This closed the first functional gap — animation no longer throws
  `tts audio mode requires both script and voice_id` because create now always sets `voiceId`.
- **HeyGen 720p default** (`heygen.ts` `HeyGenProviderOptions.defaultResolution`, env
  `HEYGEN_RESOLUTION`).
- **UI** (`/new`, `PromptScreen.tsx`): Style + Voice-language + Presenter selects + an
  optional Voiceover-script textarea, sent in the create body.

---

## Current state (what exists today)

- **Frames**: one 2x2 grid generation → cropped into 4 frames (`image-grid.ts`), storyboard
  presets/camera per frame ([[Pipeline]]). No notion of ethnicity/style yet — the look
  comes only from the user's prompt.
- **Animation**: per-frame HeyGen `avatar_iv` (talking-photo). `animation-stage.ts` reads
  `audio = tts { script, voiceId }` from `projects.script` + `projects.voiceId`. **Nothing
  populates these yet**, so the animation stage throws `tts audio mode requires both script
  and voice_id`. This is the first gap to close.
- **HeyGen** (`apps/api/src/providers/heygen.ts`): v3, `POST /v3/assets` (upload frame) →
  `POST /v3/videos` `{type:image, image:{asset_id}, script+voice_id | audio_url, resolution?,
  aspect_ratio?, callback_*}`. Voices: `GET /v3/voices`. **No `test` flag, no voice picker,
  no avatar groups.**
- **DB**: `projects` has `audioMode`, `script`, `voiceId` only — **no `style`/`locale`**.

---

## The model: Style + Locale

A project gains two fields:

| Field | Example | Drives |
|---|---|---|
| `style` | `american`, `russian` (extensible) | the **person's look** (appearance/wardrobe/setting cues injected into the image prompt) **and** the default **voice** (accent/persona). |
| `locale` | `en-US`, `ru-RU` | the **spoken language** of the VO/script and the HeyGen **voice language**; optionally UI strings. |

`style` and `locale` are related but separate: `russian` style + `en-US` locale = a Russian-
looking presenter speaking English. Default mapping: `american→en-US`, `russian→ru-RU`.

### How style reaches the **photo**
The image prompt (`shot-planner.ts` / grid prompt in `openrouter.ts`) gains a **style preamble**
per `style`, e.g.:
- `american` → "an American woman, natural American styling, suburban US kitchen".
- `russian` → "a Russian woman, Eastern-European features, a typical Russian apartment".
Keep it as a small `STYLE_PRESETS` map in `@coji/shared` (one source for UI + api), mirroring
`SHOT_PRESETS`.

### How style/locale reach the **voice**
Curate a **default voice map** from HeyGen's `GET /v3/voices`, keyed by `locale` + gender:
```
VOICE_DEFAULTS = {
  'en-US': { female: '<heygen_voice_id>', male: '<…>' },
  'ru-RU': { female: '<…>',               male: '<…>' },
}
```
`projects.voiceId` is set from this map (or a user pick). Prefer **standard HeyGen voices**
(not premium/ElevenLabs) — see cost levers below.

### Localization of the **script (VO)**
The VO must be in the project's `locale`. Two paths:
1. **User-entered** script (in their language) — simplest.
2. **LLM-generated** VO from the prompt in the target language (OpenRouter chat, the same
   cheap model used by the shot planner), then split into per-frame lines.
The script is split into N parts (one per clip) and sent as each clip's HeyGen `script`.

---

## Avatar creation — two options

| Option | What | Pros | Cons | Recommendation |
|---|---|---|---|---|
| **A. Talking-photo (current `avatar_iv`)** | animate each cropped frame directly, no persistent avatar | already wired, cheapest, no train step | identity consistency relies on the grid (same person per generation) | **MVP** — keep |
| **B. HeyGen Photo Avatar / Avatar Group** | create a persistent avatar from a photo (`POST /v2/photo_avatar/...`, train → `avatar_id`), reuse across clips | strong cross-clip consistency, reusable, more controllable | extra create+train+poll step, stores `avatar_id`, more credits/time | **Phase 2** |

Start with A + style/voice/localization; add B behind a flag once A is solid.

---

## Cost levers (HeyGen — "the cheapest")

avatar_iv cost ≈ **duration × resolution × voice tier**. In priority order:
1. ~~`test: true`~~ — **does not exist on `/v3/videos`** (400s, [[Gotchas#12]]). Not wired.
2. **`resolution` = 720p** default (env `HEYGEN_RESOLUTION`) — the real, schema-valid lever.
3. **Short script per clip** — `splitScriptForFrames` keeps each clip's line short.
4. **Standard HeyGen TTS voice** (`VOICE_DEFAULTS`), not premium/ElevenLabs.
5. **Noop seam = dev/test cost-safety** — CI/e2e/dev run `ANIMATION_PROVIDER=noop`. The test
   key has only **3** free `avatar_iv` credits (+ ~829 api). Real clips: use sparingly.

---

## Proposed data-model additions
- `projects.style` (text, default `american`), `projects.locale` (text, default `en-US`),
  optional `projects.gender` (text). `voiceId`/`script` already exist.
- Migration adds the columns (nullable / defaulted), like `shot_config` (migration 0002).

## Acceptance (when this phase is done)
- A project can be created with a **style** + **locale**; the generated person matches the
  style; the HeyGen clip speaks the **locale** language with a fitting voice.
- The VO **text is mapped per frame** and sent to HeyGen.
- Dev/test runs use **`test: true` + 720p** and do **not** burn HeyGen credits.
- Picking style/locale is in the UI (on `/new`, alongside the storyboard editor).
- `bun run test` stays green; e2e stays on Noop (no real HeyGen calls in CI).
