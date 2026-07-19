# Storage & Signed File URLs

[[Home]] · related: [[Providers]] · [[Pipeline]] · [[Gotchas]]

## StorageProvider seam (`STORAGE_PROVIDER`)
`put(key,bytes,contentType)` / `getBytes(key)` / `getSignedUrl(key,ttl)` / `exists(key)`.

| value | impl | notes |
|---|---|---|
| `local-fs` (default) | `LocalFilesystemStorageProvider` | writes under `STORAGE_LOCAL_DIR` (default `.storage`). Path-traversal guarded. `getSignedUrl` returns a `local://…` string (NOT browser-loadable). **Needs a persistent Docker volume** or files vanish on container recreate — see [[Gotchas]]. |
| `s3` | `S3StorageProvider` (`@aws-sdk/client-s3` + presigner) | S3 **or Cloudflare R2** via `S3_ENDPOINT` + `S3_FORCE_PATH_STYLE`. Real presigned GET URLs (TTL floor 1800 s). Prod option. |

Column semantics: `frames.image_ref` = storage **key**; **`clips.video_url` now also holds a storage KEY** (re-hosted clip), re-signed on read — see "Durable clips" below; `renders.output_url` = URL (still a presigned R2 URL — [[Follow-ups]]).

## Why a signed file route exists
Two consumers need HTTP-reachable bytes:
- the **browser `<img>`** (preview/editor) — can't send a Bearer header;
- Remotion **`<OffthreadVideo>`** (render) — only accepts http(s) URLs.

`local-fs` has no public URL, so we mint **signed file URLs**.

## `/files` route (`apps/api/src/modules/files`)
- `signFileUrl(key, ttl)` → `/files?key=<enc>&exp=<unix>&sig=<hmac>` where `sig = HMAC-SHA256(\`${key}:${exp}\`, BETTER_AUTH_SECRET)`.
- `GET /files` verifies exp + constant-time sig, then streams `StorageProvider.getBytes(key)` with a **sniffed** content-type (JPEG/PNG/GIF/MP4). **No Bearer** — the signature is the capability, so it works from `<img src>`/`<video src>`.
- Bad/expired signature → **403**; missing object → **404**.

`getProjectFrames` attaches `signedUrl` to each frame; the web renders `frame.signedUrl`. Browser smoke tests verify that generated frames load through the signed route.

The `/files` route supports **HTTP Range** (`bytes=start-end` → 206 + `Content-Range` + `Accept-Ranges`) so `<video>` seeking works.

## Durable clips + SAME-ORIGIN video (editor)
Two hard-won rules (see [[Gotchas]] #13/#14):
1. **`clips.video_url` stores a storage KEY, never a presigned/provider URL.** Every animation-completion path (`runner` poll / `reconciler` / `webhook`) calls `persistClip` → downloads the provider mp4 → `storage.put(key)` → returns the **key**. URLs are minted fresh on read (`apps/api/src/modules/jobs/clip-storage.ts`):
   - `clipEditorUrl(stored)` → **same-origin** `signFileUrl(key)` (`/files?key…`) — for the browser editor. **Brave blocks cross-origin `<video>`**, so the editor MUST use this, not the R2 presigned URL.
   - `clipBrowserUrl(stored)` → R2 **presigned** absolute URL — for the SERVER render (ffmpeg fetches it server-side; no browser).
   - Both pass through a legacy absolute URL unchanged (those need a re-host backfill — [[Follow-ups]]).
2. **R2 needs a bucket CORS policy** (GET/HEAD for the deployed web origin, for example `https://coji.example.com`) — set once via `PutBucketCorsCommand`. Cross-origin `<img>` works regardless; cross-origin `<video>` may still be blocked by privacy-focused browsers (rule 1 is the real fix).

`renders.output_url` is still a cross-origin R2 presigned URL → not in-app previewable in Brave; make it same-origin too — [[Follow-ups]] P0.

> `getProjectClips` (render-stage port) returns clips with `videoUrl` (same-origin) + `durationInFrames` (from `clips.duration_seconds`, migration 0004) for the editor.
