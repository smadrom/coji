/**
 * Provider-aware signed URL for browser-loadable stored objects.
 *
 * Two storage backends mint browser URLs differently:
 *  - **local-fs**: there is no public HTTP origin, so we mint a short-lived
 *    HMAC-signed same-origin `/files?key&exp&sig` URL served by `filesRoutes`
 *    (see `signing.ts`). nginx proxies `/files` to the api.
 *  - **s3 / R2**: the object store issues its own absolute presigned GET URL
 *    (`storage.getSignedUrl`) that `<img src>` can load directly — no `/files`
 *    route, no nginx hop.
 *
 * Callers (image-stage frames, gallery preview) must use THIS helper, not
 * `signFileUrl` directly, so the URL follows `STORAGE_PROVIDER`. Using the
 * local `/files` path while objects live in R2 yields broken images.
 */
import { getProviders } from '../../config/providers.ts';
import { env } from '../../env.ts';
import { signFileUrl } from './signing.ts';

export async function signedUrlFor(key: string): Promise<string> {
  if (env.storageProvider !== 'local-fs') {
    return getProviders().storage.getSignedUrl(key, env.storageSignedUrlTtlSeconds);
  }
  return signFileUrl(key);
}
