/**
 * Provider factory — resolves the four seams from env/config (see env.ts).
 *
 * Defaults are the deterministic fakes (Noop providers + local-filesystem
 * storage), so CI and local dev run the full pipeline with **zero** external
 * calls. Real providers (gemini/heygen/remotion/s3) are wired in P1/P3/P4 and
 * selected only when the corresponding env var opts in.
 */
import {
  type AnimationProvider,
  type ImageProvider,
  LocalFilesystemStorageProvider,
  NoopAnimationProvider,
  NoopImageProvider,
  NoopRenderProvider,
  type Providers,
  type RenderProvider,
  type StorageProvider,
} from '@coji/shared/providers';
import { env } from '../env.ts';
import { FfmpegRenderProvider } from '../providers/ffmpeg-render.ts';
import { GeminiImageProvider } from '../providers/gemini.ts';
import { HeyGenAnimationProvider } from '../providers/heygen.ts';
import { OpenRouterImageProvider } from '../providers/openrouter.ts';
import { RemotionRenderProvider } from '../providers/remotion-render.ts';
import { S3StorageProvider } from '../providers/s3.ts';

function resolveImage(): ImageProvider {
  switch (env.imageProvider) {
    case 'noop':
      return new NoopImageProvider();
    case 'gemini':
      // Real Gemini-native image generation (P1). Requires GEMINI_API_KEY.
      return new GeminiImageProvider({ apiKey: env.geminiApiKey });
    case 'openrouter':
      // Gemini image models via OpenRouter (Nano Banana). Requires OPENROUTER_API_KEY.
      return new OpenRouterImageProvider({
        apiKey: env.openrouterApiKey,
        model: env.openrouterImageModel || undefined,
        referer: env.openrouterSiteUrl,
        title: env.openrouterAppName,
      });
    default:
      throw new Error(
        `Unknown IMAGE_PROVIDER='${env.imageProvider}'. Use 'noop' (default), 'gemini', or 'openrouter'.`,
      );
  }
}

function resolveAnimation(): AnimationProvider {
  switch (env.animationProvider) {
    case 'noop':
      return new NoopAnimationProvider();
    case 'heygen':
      // Real HeyGen image-to-video (P3). Requires HEYGEN_API_KEY. Default to
      // the cheapest standard resolution (HEYGEN_RESOLUTION, 720p) — cost lever.
      return new HeyGenAnimationProvider(env.heygenApiKey, resolveStorage(), {
        defaultResolution: env.heygenResolution,
      });
    default:
      throw new Error(
        `Unknown ANIMATION_PROVIDER='${env.animationProvider}'. Use 'noop' (default) or 'heygen'.`,
      );
  }
}

function resolveRender(): RenderProvider {
  switch (env.renderProvider) {
    case 'noop':
      return new NoopRenderProvider();
    case 'ffmpeg':
      // Real export = trim + concat the already-rendered clips via ffmpeg
      // (needs the `ffmpeg` binary on PATH — installed in the api image).
      return new FfmpegRenderProvider();
    case 'remotion-local':
      // Real local Remotion render (P4.a). Requires Chromium on the host.
      // @remotion/bundler + @remotion/renderer are lazy-imported by the
      // provider so the default build stays light.
      return new RemotionRenderProvider();
    default:
      throw new Error(
        `Unknown RENDER_PROVIDER='${env.renderProvider}'. Use 'noop' (default), 'ffmpeg', or 'remotion-local'.`,
      );
  }
}

function resolveStorage(): StorageProvider {
  switch (env.storageProvider) {
    case 'local-fs':
      return new LocalFilesystemStorageProvider({ baseDir: env.storageLocalDir });
    case 's3':
      // Real S3/R2 storage (P0.b). Requires S3_BUCKET + S3_ACCESS_KEY_ID +
      // S3_SECRET_ACCESS_KEY.  S3_ENDPOINT + S3_FORCE_PATH_STYLE for R2/MinIO.
      return new S3StorageProvider({
        bucket: env.s3Bucket,
        region: env.s3Region,
        accessKeyId: env.s3AccessKeyId,
        secretAccessKey: env.s3SecretAccessKey,
        endpoint: env.s3Endpoint || undefined,
        forcePathStyle: env.s3ForcePathStyle,
        signedUrlTtlSeconds: env.storageSignedUrlTtlSeconds,
      });
    default:
      throw new Error(
        `Unknown STORAGE_PROVIDER='${env.storageProvider}'. Use 'local-fs' (default) or 's3'.`,
      );
  }
}

/** Build the full provider bundle from current env. */
export function createProviders(): Providers {
  return {
    image: resolveImage(),
    animation: resolveAnimation(),
    render: resolveRender(),
    storage: resolveStorage(),
  };
}

/** Lazily-instantiated singleton bundle for the running app. */
let cached: Providers | undefined;
export function getProviders(): Providers {
  if (!cached) cached = createProviders();
  return cached;
}
