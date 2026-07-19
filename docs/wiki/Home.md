# coji — Knowledge Base

> AI video-generation SaaS. **prompt → 4 images → preview gate → compose N clips (frame + line each) → talking-video clips → Remotion editor → 9:16 export.**
> Obsidian-style vault — open `docs/wiki/` as a vault, follow `[[wikilinks]]`.

## Map of content

- [[Architecture]] — monorepo, Eden type spine, module convention
- [[Pipeline]] — project lifecycle FSM, the 6 stages (incl. the clip-composer)
- [[Providers]] — Image / Animation / Render / Storage seams + real impls
- [[Avatars-Voices]] — (design) style/locale → look + voice + spoken language; HeyGen cost levers
- [[Job-Runner]] — unified runner, `applyJobResult`, idempotency, reconciler
- [[Credits]] — credit ledger, hold→debit→refund, `stage_prices`
- [[Auth]] — Better Auth (bearer), `/api/me`, test hatch
- [[Storage]] — object storage seam, signed file URLs for the browser
- [[Deployment]] — self-hosted Docker deployment and production checklist
- [[Runbook]] — env vars, how to run, smoke tests, credentials
- [[Gotchas]] — every bug found during deploy and its fix
- [[Follow-ups]] — known gaps / next steps
- [Open-source release readiness](../OPEN_SOURCE_RELEASE.md) — verified gates and publication sequence

## TL;DR

| | |
|---|---|
| Repo | `github.com/smadrom/coji` |
| Stack | Bun · Elysia · TypeScript · React/Vite · Drizzle · PostgreSQL |
| Release line | **v0.3.0**, pre-1.0 |
| Tests | `bun run test`; DB suites are environment-gated |
| Status | images ✅ · **clip-composer (N clips from 4 frames)** ✅ · animation (HeyGen) ✅ · editor + **9:16 ffmpeg export** ✅ |

## Working state

- **Images**: real generation via **OpenRouter** (Gemini Flash Image), shown in the browser via [[Storage|signed URLs]].
- **Clip-composer** (`composing` step): clip ≠ frame — the user composes **N clips** from the 4 reusable frames, each with its own VO line + chosen shot; per-clip animate/regenerate. See [[Pipeline]].
- **Animation**: **HeyGen** Avatar IV wired (one job per clip, TTS per-clip script); settle-based `clips_ready`.
- **Editor + export**: Remotion `<Player>` preview + **ffmpeg trim/concat** export, **vertical 9:16 (TikTok/Reels)** via cover-crop. Clips served same-origin via `/files`.
- **Auth/credits/billing**: Better Auth bearer + credit ledger + Noop/Stripe payment seams.

See [[Follow-ups]] for what's not done yet (native-portrait image gen, LLM VO, voice picker, S3/prod payments).
