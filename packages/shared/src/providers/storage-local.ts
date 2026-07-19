/**
 * Local-filesystem StorageProvider fake — the CI/test default. Implements the
 * same key/URL contract as the real S3/R2 provider so tests exercise the exact
 * `frames.image_ref` (key) → `getSignedUrl` (URL) flow without any cloud dep.
 *
 * Bytes are written under a base directory (default `.storage`). Object
 * keys may contain `/`; they are mapped to nested paths but kept inside the
 * base dir (path-traversal guarded).
 */
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { StorageProvider, StorageRange, StoredObject } from './types.ts';

export interface LocalStorageOptions {
  /** Base directory for stored objects. Default: `.storage`. */
  baseDir?: string;
  /**
   * Base URL used to mint "signed" URLs. Default `local://`. The minted URL
   * carries the key and an `exp` query param (epoch seconds) so tests can
   * assert TTL behaviour.
   */
  urlBase?: string;
}

const DEFAULT_BASE_DIR = '.storage';

export class LocalFilesystemStorageProvider implements StorageProvider {
  private readonly baseDir: string;
  private readonly urlBase: string;
  private readonly contentTypes = new Map<string, string>();

  constructor(opts: LocalStorageOptions = {}) {
    this.baseDir = resolve(opts.baseDir ?? DEFAULT_BASE_DIR);
    this.urlBase = opts.urlBase ?? 'local://';
  }

  /** Resolve a key to an absolute path, refusing anything outside baseDir. */
  private pathFor(key: string): string {
    const cleaned = normalize(key).replace(/^([/\\]|\.\.[/\\]?)+/, '');
    const full = resolve(this.baseDir, cleaned);
    if (full !== this.baseDir && !full.startsWith(this.baseDir + sep)) {
      throw new Error(`Storage key escapes base directory: ${key}`);
    }
    return full;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    this.contentTypes.set(key, contentType);
    return { key, contentType, size: bytes.byteLength };
  }

  async getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    if (!(await this.exists(key))) {
      throw new Error(`Cannot sign URL for missing key: ${key}`);
    }
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `${this.urlBase}${encodeURIComponent(key)}?exp=${exp}`;
  }

  async getBytes(key: string): Promise<Uint8Array> {
    const buf = await readFile(this.pathFor(key));
    return new Uint8Array(buf);
  }

  async getRange(key: string, start?: number, end?: number): Promise<StorageRange> {
    const path = this.pathFor(key);
    const { size: totalSize } = await stat(path); // throws ENOENT if missing
    const ct = this.contentTypes.get(key);

    // No range → stream the whole file.
    if (start === undefined && end === undefined) {
      const stream = Readable.toWeb(
        createReadStream(path),
      ) as unknown as ReadableStream<Uint8Array>;
      return {
        stream,
        contentLength: totalSize,
        totalSize,
        start: 0,
        end: Math.max(0, totalSize - 1),
        contentType: ct,
      };
    }

    // Clamp the inclusive range to the object bounds.
    const from = Math.max(0, start ?? 0);
    const to = Math.min(end ?? totalSize - 1, totalSize - 1);
    // createReadStream end is inclusive, matching our contract.
    const stream = Readable.toWeb(
      createReadStream(path, { start: from, end: to }),
    ) as unknown as ReadableStream<Uint8Array>;
    return {
      stream,
      contentLength: Math.max(0, to - from + 1),
      totalSize,
      start: from,
      end: to,
      contentType: ct,
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}
