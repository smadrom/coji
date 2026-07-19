# Remotion Render Smoke Test Results

**Date:** 2026-06-08
**Overall: PASS**

## Environment

| | |
|---|---|
| Remotion version | `4.0.491` |
| Bun version | `1.3.14` |
| Node version | `v24.3.0` |
| Chromium source | Remotion-managed (auto-downloaded by `@remotion/renderer`) |
| Platform | win32 / x64 |

## Test Results

| Test | Result | Output | Elapsed |
|---|---|---|---|
| SolidColor | PASS | 45901 bytes | 2272ms |
| CompositeClip (OffthreadVideo+Audio+Series) | PASS | 45901 bytes | 1353ms |

## Known Bun Constraints (from docs/api-verification.md + remotion.dev/docs/bun)

- `lazyComponent` prop on `<Composition>` and `<Player>` is automatically disabled under Bun
- SSR scripts may not auto-quit after completion under Bun (documented quirk)
- Minimum Bun version for Remotion v5: 1.1.3 (this run: Bun 1.3.14)
- `<OffthreadVideo>` uses FFmpeg for frame extraction (not browser APIs) — compatible with Bun per OffthreadVideo docs

## Recommendation

local `@remotion/renderer` is viable for v1 RenderProvider (ADR-3: ship local first, Lambda as documented production swap).

## ADR-3 Decision Confirmed

Ship P4 editor using local `@remotion/renderer` via `remotionb`. Wire `@remotion/lambda` as the documented production swap behind the `RenderProvider` seam. No code change needed to swap — just env config.
