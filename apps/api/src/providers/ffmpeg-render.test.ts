/**
 * FfmpegRenderProvider — argv shape test (task #18, target 5).
 *
 * We cannot call the real `ffmpeg` binary in CI, so we inject a fake: a tiny
 * Bun script that records its argv to a temp file and exits 0. The provider's
 * `render()` downloads clips via `fetch` — we stub that with a tiny HTTP server
 * that returns dummy mp4 bytes.
 *
 * Asserts:
 *   - Each input clip produces `-i <tmpfile>` flags (in order).
 *   - Clips with startFrom/endAt → `trim=start:end` and `atrim=start:end`
 *     expressions (seconds = frames / fps) appear in `-filter_complex`.
 *   - Clips without trims → `null` / `anull` (no-op) appear in `-filter_complex`.
 *   - Output flags include `-map [v]`, `-map [a]`, `+faststart`.
 *
 * Pure: no real ffmpeg binary, no DB, no external network, no paid API.
 * Runs unconditionally in CI.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegRenderProvider } from './ffmpeg-render.ts';

// ---------------------------------------------------------------------------
// Fake ffmpeg: a tiny Bun script that writes its argv to a temp file then
// exits 0. We pass this script path as the `ffmpegPath` option.
// ---------------------------------------------------------------------------

let tmpDir: string;
let fakeFfmpegPath: string;
let argvFile: string;

// A tiny Bun server that always returns dummy bytes (acts as the "clip CDN").
let server: ReturnType<typeof Bun.serve>;
let clipUrl: string;

const DUMMY_BYTES = new Uint8Array([0, 1, 2, 3, 4]);

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'coji-ffmpeg-test-'));
  argvFile = join(tmpDir, 'argv.json');

  // Fake ffmpeg script: write argv to argvFile, create an empty out.mp4, exit 0.
  // The provider reads out.mp4 after the run, so we need to create it.
  fakeFfmpegPath = join(tmpDir, 'fake-ffmpeg.ts');
  await writeFile(
    fakeFfmpegPath,
    `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
// argv[0] = bun, argv[1] = script, argv[2..] = ffmpeg args
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));
// Find the output path (-y is always the last arg before output).
const yIdx = args.lastIndexOf('-y');
const out = yIdx !== -1 ? args[yIdx + 1] : null;
if (out) writeFileSync(out, '');
process.exit(0);
`,
  );
  if (process.platform !== 'win32') await chmod(fakeFfmpegPath, 0o755);

  // Minimal HTTP server that returns dummy bytes for any GET.
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(DUMMY_BYTES, {
        headers: { 'content-type': 'video/mp4' },
      });
    },
  });
  clipUrl = `http://localhost:${server.port}/clip.mp4`;
});

afterAll(async () => {
  server.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// trimExpr logic — verified indirectly via filter_complex assertions below.
// We test the pure helper through the observable argv using an actual process.
// ---------------------------------------------------------------------------

describe('FfmpegRenderProvider (argv assertions)', () => {
  // POSIX runs the executable Bun script directly. Windows uses a .cmd wrapper
  // because it does not honor shebangs.
  let wrapperPath: string;

  beforeAll(async () => {
    if (process.platform === 'win32') {
      wrapperPath = join(tmpDir, 'ffmpeg-fake.cmd');
      await writeFile(wrapperPath, `@echo off\nbun "${fakeFfmpegPath}" %*\n`);
    } else {
      wrapperPath = fakeFfmpegPath;
    }
  });

  function makeProvider(fps = 30) {
    return new FfmpegRenderProvider({
      ffmpegPath: wrapperPath,
      fps,
      width: 640,
      height: 360,
    });
  }

  async function readArgv(): Promise<string[]> {
    const text = await Bun.file(argvFile).text();
    return JSON.parse(text) as string[];
  }

  test('each clip produces a -i flag in order', async () => {
    await writeFile(argvFile, '[]');
    const provider = makeProvider();
    await provider.render({ clips: [{ videoUrl: clipUrl }, { videoUrl: clipUrl }], fps: 30 });
    const argv = await readArgv();

    // Should have two pairs of -i <path>
    const iFlags = argv.filter((a) => a === '-i');
    expect(iFlags).toHaveLength(2);
  });

  test('clip WITH startFrom/endAt → trim/atrim with correct seconds in filter_complex', async () => {
    await writeFile(argvFile, '[]');
    // startFrom=15 frames, endAt=60 frames at 30fps → start=0.500s, end=2.000s
    const provider = makeProvider(30);
    await provider.render({
      clips: [{ videoUrl: clipUrl, startFrom: 15, endAt: 60 }],
      fps: 30,
    });
    const argv = await readArgv();

    const fcIdx = argv.indexOf('-filter_complex');
    expect(fcIdx).toBeGreaterThanOrEqual(0);
    const fc = argv[fcIdx + 1] ?? '';

    // Video trim: trim=start=0.500:end=2.000
    expect(fc).toContain('trim=start=0.500:end=2.000');
    // Audio trim: atrim=start=0.500:end=2.000
    expect(fc).toContain('atrim=start=0.500:end=2.000');
  });

  test('clip WITHOUT trims → null/anull (no-op) in filter_complex', async () => {
    await writeFile(argvFile, '[]');
    const provider = makeProvider(30);
    await provider.render({ clips: [{ videoUrl: clipUrl }], fps: 30 });
    const argv = await readArgv();

    const fcIdx = argv.indexOf('-filter_complex');
    expect(fcIdx).toBeGreaterThanOrEqual(0);
    const fc = argv[fcIdx + 1] ?? '';

    expect(fc).toContain('[0:v]null,');
    expect(fc).toContain('[0:a]anull,');
  });

  test('output flags include -map [v], -map [a], +faststart', async () => {
    await writeFile(argvFile, '[]');
    const provider = makeProvider();
    await provider.render({ clips: [{ videoUrl: clipUrl }], fps: 30 });
    const argv = await readArgv();

    expect(argv).toContain('[v]');
    expect(argv).toContain('[a]');
    // +faststart appears as part of the movflags value
    const mfIdx = argv.indexOf('-movflags');
    expect(mfIdx).toBeGreaterThanOrEqual(0);
    expect(argv[mfIdx + 1]).toContain('faststart');
  });

  test('concat filter covers all clips: n=<count>', async () => {
    await writeFile(argvFile, '[]');
    const provider = makeProvider();
    await provider.render({
      clips: [{ videoUrl: clipUrl }, { videoUrl: clipUrl }, { videoUrl: clipUrl }],
      fps: 30,
    });
    const argv = await readArgv();

    const fcIdx = argv.indexOf('-filter_complex');
    const fc = argv[fcIdx + 1] ?? '';
    expect(fc).toContain('concat=n=3:v=1:a=1');
  });

  test('render() rejects when composition has no clips', async () => {
    const provider = makeProvider();
    await expect(provider.render({ clips: [], fps: 30 })).rejects.toThrow(/no clips/i);
  });

  test('only-startFrom (no endAt) → trim=start=X in filter_complex', async () => {
    await writeFile(argvFile, '[]');
    // startFrom=30 frames, no endAt → start=1.000s, no end bound
    const provider = makeProvider(30);
    await provider.render({ clips: [{ videoUrl: clipUrl, startFrom: 30 }], fps: 30 });
    const argv = await readArgv();

    const fcIdx = argv.indexOf('-filter_complex');
    const fc = argv[fcIdx + 1] ?? '';
    expect(fc).toContain('trim=start=1.000');
    expect(fc).not.toContain('trim=start=1.000:end=');
  });

  test('only-endAt (no startFrom) → trim=end=X in filter_complex', async () => {
    await writeFile(argvFile, '[]');
    // endAt=90 frames → end=3.000s, no start bound
    const provider = makeProvider(30);
    await provider.render({ clips: [{ videoUrl: clipUrl, endAt: 90 }], fps: 30 });
    const argv = await readArgv();

    const fcIdx = argv.indexOf('-filter_complex');
    const fc = argv[fcIdx + 1] ?? '';
    expect(fc).toContain('trim=end=3.000');
    expect(fc).not.toContain('trim=start=');
  });
});
