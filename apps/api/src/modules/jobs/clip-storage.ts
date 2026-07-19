/**
 * Clip persistence helper (P3 / task #18) — shared by the webhook receiver and
 * the reconciler so a completed HeyGen clip is stored the same way regardless of
 * which path resolves it.
 *
 * ADR-5: `clips.video_url` holds a reference WE control, not a provider-
 * lifetime-bound URL. We download the provider's clip bytes (http/https) and
 * re-store them via the StorageProvider, then persist the **storage KEY** — NOT
 * a presigned URL. Presigned URLs are short-lived (30 min); persisting one makes
 * the clip unplayable later. The browser-loadable URL is minted FRESH on read
 * (`clipBrowserUrl` / `signedUrlFor`), exactly like frame `image_ref`. A non-http
 * provider reference (the deterministic `noop://...` the Noop fake emits) is
 * stored under the same key as its stand-in bytes.
 */
import type { Providers } from '@coji/shared/providers';
import { signedUrlFor } from '../files/signed-url.ts';
import { signFileUrl } from '../files/signing.ts';

/**
 * Download the provider clip and re-store it under `key`. Returns the storage
 * KEY (persisted in `clips.video_url`), re-signed on read.
 */
export async function persistClip(
  providers: Providers,
  key: string,
  providerUrl: string,
): Promise<string> {
  const isHttp = providerUrl.startsWith('http://') || providerUrl.startsWith('https://');
  let bytes: Uint8Array;
  if (isHttp) {
    const res = await fetch(providerUrl);
    if (!res.ok) throw new Error(`clip download failed: ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } else {
    bytes = new TextEncoder().encode(providerUrl);
  }
  await providers.storage.put(key, bytes, 'video/mp4');
  return key;
}

/**
 * Browser-loadable URL for the EDITOR (`<video src>`). Storage keys are served
 * SAME-ORIGIN via the signed `/files` streaming route — NOT the storage's own
 * cross-origin presigned URL. This is deliberate: Brave (and similar) silently
 * block cross-origin `<video>` media, so a same-origin URL is the only reliable
 * way to play clips in the browser. A legacy absolute provider URL is passed
 * through (those should be re-hosted to a key to play in Brave).
 */
export function clipEditorUrl(stored: string): string {
  if (stored.startsWith('http://') || stored.startsWith('https://')) return stored;
  return signFileUrl(stored);
}

/**
 * Absolute URL for the SERVER render (Remotion OffthreadVideo). Storage keys are
 * re-signed to the storage's own absolute presigned URL (provider-aware); a
 * legacy absolute provider URL is passed through. Runs server-side, so the
 * cross-origin block that affects the browser editor does not apply.
 */
export function clipBrowserUrl(stored: string): Promise<string> | string {
  if (stored.startsWith('http://') || stored.startsWith('https://')) return stored;
  return signedUrlFor(stored);
}

/**
 * Browser-loadable URL for the final RENDER output on the done screen
 * (`<video src>` + download). Identical policy to {@link clipEditorUrl}: a
 * storage key is served SAME-ORIGIN via the signed `/files` route (cross-origin
 * `<video>` is silently blocked by Brave), and a legacy absolute URL (old render
 * rows that stored a presigned R2 URL) is passed through unchanged.
 */
export function renderEditorUrl(stored: string): string {
  if (stored.startsWith('http://') || stored.startsWith('https://')) return stored;
  return signFileUrl(stored);
}
