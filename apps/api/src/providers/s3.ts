/**
 * S3StorageProvider — real StorageProvider implementation against the frozen
 * StorageProvider seam (packages/shared/src/providers/types.ts).
 *
 * Works with AWS S3 and S3-compatible stores (Cloudflare R2, MinIO) via a
 * custom `endpoint` option.  Config is injected so tests can pass a mock
 * S3Client without touching process.env.
 *
 * TTL floor (M2 constraint):
 *   The signed-URL TTL must outlive the longest provider fetch/processing
 *   window.  In practice the HeyGen animation job can take up to 10 minutes
 *   and the Remotion render (local path) is CPU-bound but typically < 5 min.
 *   The STORAGE_SIGNED_URL_TTL_SECONDS floor is therefore set to 1 800 s
 *   (30 min) — well above the max observed processing window while staying
 *   well below the S3 presigned-URL cap of 7 days.  Callers that need longer
 *   TTLs (e.g. preview URLs regenerated on demand) pass an explicit value.
 *
 * NEVER import from the job runner — this module is pure provider logic.
 * Real API calls happen only when instantiated with live credentials; unit
 * tests inject a mock S3Client.
 */

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageProvider, StorageRange, StoredObject } from '@coji/shared/providers';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface S3StorageConfig {
  /** S3 bucket name. */
  bucket: string;
  /**
   * AWS region (e.g. 'us-east-1') or Cloudflare R2 pseudo-region ('auto').
   * Required by the SDK even for R2.
   */
  region: string;
  /**
   * Custom endpoint for R2 or MinIO.  Leave undefined for vanilla AWS S3.
   * Example: 'https://<account-id>.r2.cloudflarestorage.com'
   */
  endpoint?: string;
  /**
   * Force path-style URLs (`https://endpoint/bucket/key`) instead of the
   * default virtual-hosted style.  Required for MinIO and some R2 configs.
   */
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Default signed-URL TTL in seconds.  Must be ≥ SIGNED_URL_TTL_FLOOR_S
   * (1 800 s) to satisfy the M2 provider-fetch-window constraint.
   */
  signedUrlTtlSeconds?: number;
  /**
   * Inject a pre-configured S3Client (used by tests to pass a mock).  When
   * provided, the credential/endpoint/region options above are ignored for
   * client construction but `bucket` and `signedUrlTtlSeconds` still apply.
   */
  client?: S3Client;
}

/** Minimum signed-URL TTL (30 min).  Documented in class header (M2 floor). */
export const SIGNED_URL_TTL_FLOOR_S = 1_800;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly defaultTtlSeconds: number;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.defaultTtlSeconds = Math.max(
      config.signedUrlTtlSeconds ?? SIGNED_URL_TTL_FLOOR_S,
      SIGNED_URL_TTL_FLOOR_S,
    );

    if (config.client) {
      // Injected client — test path.
      this.client = config.client;
    } else {
      const clientConfig: S3ClientConfig = {
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      };
      if (config.endpoint) {
        clientConfig.endpoint = config.endpoint;
      }
      if (config.forcePathStyle) {
        clientConfig.forcePathStyle = true;
      }
      this.client = new S3Client(clientConfig);
    }
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ContentLength: bytes.byteLength,
      }),
    );
    return { key, contentType, size: bytes.byteLength };
  }

  async getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    const effectiveTtl = Math.max(ttlSeconds, SIGNED_URL_TTL_FLOOR_S);
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return awsGetSignedUrl(this.client, command, { expiresIn: effectiveTtl });
  }

  async getBytes(key: string): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) {
      throw new Error(`S3: empty response body for key: ${key}`);
    }
    // SDK v3 Body is a ReadableStream in browser, but a Readable/SdkStream
    // in Node/Bun.  The `transformToByteArray` helper works in both.
    const arr = await response.Body.transformToByteArray();
    return arr;
  }

  async getRange(key: string, start?: number, end?: number): Promise<StorageRange> {
    // Build an HTTP Range header so S3/R2 returns only the requested slice and
    // streams it — we never buffer the whole object in API memory (F1).
    let range: string | undefined;
    if (start !== undefined || end !== undefined) {
      const from = Math.max(0, start ?? 0);
      // Open-ended (`bytes=from-`) when no end given; S3 clamps the upper bound.
      range = `bytes=${from}-${end !== undefined ? end : ''}`;
    }

    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }),
    );
    if (!response.Body) {
      throw new Error(`S3: empty response body for key: ${key}`);
    }

    // ContentRange is `bytes start-end/total` for a partial response; for a
    // full response it is absent and ContentLength is the whole object size.
    const contentLength = response.ContentLength ?? 0;
    let totalSize = contentLength;
    let respStart = 0;
    let respEnd = Math.max(0, contentLength - 1);
    const cr = response.ContentRange;
    const m = cr ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr) : null;
    if (m) {
      respStart = Number(m[1]);
      respEnd = Number(m[2]);
      totalSize = Number(m[3]);
    }

    // SDK v3 Body is an SdkStream; transformToWebStream yields a web
    // ReadableStream in Bun/Node without buffering.
    const stream = (
      response.Body as { transformToWebStream: () => ReadableStream<Uint8Array> }
    ).transformToWebStream();

    return {
      stream,
      contentLength,
      totalSize,
      start: respStart,
      end: respEnd,
      contentType: response.ContentType,
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      // The SDK throws a shaped error; 404 = NoSuchKey or NotFound.
      const code =
        (err as { name?: string; $metadata?: { httpStatusCode?: number } }).name ??
        (err as { Code?: string }).Code;
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (code === 'NotFound' || code === 'NoSuchKey' || status === 404) {
        return false;
      }
      throw err;
    }
  }
}
