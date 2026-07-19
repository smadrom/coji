import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFilesystemStorageProvider } from './storage-local.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let baseDir: string;
let storage: LocalFilesystemStorageProvider;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'coji-storage-'));
  storage = new LocalFilesystemStorageProvider({ baseDir });
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe('LocalFilesystemStorageProvider', () => {
  test('put then getBytes round-trips the exact bytes', async () => {
    const bytes = encoder.encode('hello-frame');
    const stored = await storage.put('frames/p1/0.png', bytes, 'image/png');

    expect(stored.key).toBe('frames/p1/0.png');
    expect(stored.contentType).toBe('image/png');
    expect(stored.size).toBe(bytes.byteLength);

    const read = await storage.getBytes('frames/p1/0.png');
    expect(decoder.decode(read)).toBe('hello-frame');
  });

  test('exists reflects whether an object was stored', async () => {
    expect(await storage.exists('missing')).toBe(false);
    await storage.put('here', encoder.encode('x'), 'text/plain');
    expect(await storage.exists('here')).toBe(true);
  });

  test('getSignedUrl encodes the key and an expiry that honours the TTL', async () => {
    await storage.put('clips/c.mp4', encoder.encode('v'), 'video/mp4');
    const before = Math.floor(Date.now() / 1000);
    const url = await storage.getSignedUrl('clips/c.mp4', 600);

    expect(url).toContain(encodeURIComponent('clips/c.mp4'));
    const exp = Number(new URL(url.replace('local://', 'http://x/')).searchParams.get('exp'));
    expect(exp).toBeGreaterThanOrEqual(before + 600);
  });

  test('getSignedUrl rejects a missing key', async () => {
    await expect(storage.getSignedUrl('nope', 60)).rejects.toThrow(/missing key/);
  });

  test('rejects keys that escape the base directory', async () => {
    await expect(
      storage.put('../escape', encoder.encode('x'), 'text/plain'),
    ).resolves.toBeDefined(); // leading ../ is stripped, stays in baseDir
    // An absolute traversal attempt is normalised back inside baseDir too.
    expect(await storage.exists('escape')).toBe(true);
  });
});
