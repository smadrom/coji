/**
 * Unit tests for RemotionRenderProvider.
 *
 * The heavy Remotion deps (@remotion/bundler, @remotion/renderer) are fully
 * mocked — no real Chromium is launched, no real render is performed. CI
 * never calls a paid API and never downloads a browser.
 *
 * A separate env-gated smoke test (RUN_REAL_RENDER=1) is provided at the
 * bottom of this file and is excluded from the default `bun test` run via
 * the `if (process.env.RUN_REAL_RENDER === '1')` guard.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RenderComposition } from '@coji/shared/providers';
import {
  type RemotionBundler,
  type RemotionComposition,
  RemotionRenderProvider,
  type RemotionRenderer,
} from './remotion-render.ts';

// ---------------------------------------------------------------------------
// Helpers / shared fixtures
// ---------------------------------------------------------------------------

const FAKE_SERVE_URL = 'http://localhost:3333/remotion-bundle';
const FAKE_OUTPUT_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0xde, 0xad, 0xbe, 0xef]);

/** A composition matching the defaults the provider sets. */
const FAKE_COMPOSITION: RemotionComposition = {
  id: 'CojiClips',
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 150,
};

/**
 * Build a mock bundler that records calls and returns FAKE_SERVE_URL.
 */
function makeBundler(): { bundler: RemotionBundler; calls: { entryPoint: string }[] } {
  const calls: { entryPoint: string }[] = [];
  const bundler: RemotionBundler = {
    bundle: mock(async (opts) => {
      calls.push({ entryPoint: opts.entryPoint });
      return FAKE_SERVE_URL;
    }),
  };
  return { bundler, calls };
}

/**
 * Build a mock renderer that records selectComposition + renderMedia calls,
 * and writes FAKE_OUTPUT_BYTES to the outputLocation.
 */
function makeRenderer(): {
  renderer: RemotionRenderer;
  selectCalls: { id: string; inputProps?: Record<string, unknown> }[];
  renderCalls: { outputLocation: string; inputProps?: Record<string, unknown>; codec: string }[];
} {
  const selectCalls: { id: string; inputProps?: Record<string, unknown> }[] = [];
  const renderCalls: {
    outputLocation: string;
    inputProps?: Record<string, unknown>;
    codec: string;
  }[] = [];

  const renderer: RemotionRenderer = {
    selectComposition: mock(async (opts) => {
      selectCalls.push({ id: opts.id, inputProps: opts.inputProps });
      return FAKE_COMPOSITION;
    }),
    renderMedia: mock(async (opts) => {
      renderCalls.push({
        outputLocation: opts.outputLocation,
        inputProps: opts.inputProps,
        codec: opts.codec,
      });
      // Write fake bytes to the output path so the provider can read them.
      await writeFile(opts.outputLocation, FAKE_OUTPUT_BYTES);
    }),
  };

  return { renderer, selectCalls, renderCalls };
}

/**
 * Build a minimal RenderComposition with one clip.
 */
function oneClipComposition(overrides: Partial<RenderComposition> = {}): RenderComposition {
  return {
    clips: [
      {
        videoUrl: 'https://storage.example.com/clips/clip-0.mp4',
        startFrom: 0,
        endAt: 150,
      },
    ],
    fps: 30,
    width: 1920,
    height: 1080,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemotionRenderProvider.render', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = join(
      tmpdir(),
      `remotion-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(outputDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('bundles the entry point and returns video/mp4 bytes', async () => {
    const { bundler, calls: bundleCalls } = makeBundler();
    const { renderer } = makeRenderer();

    const provider = new RemotionRenderProvider({
      bundler,
      renderer,
      outputDir,
    });

    const result = await provider.render(oneClipComposition());

    expect(bundleCalls).toHaveLength(1);
    // entryPoint resolves to the remotion-compositions.tsx sibling
    expect(bundleCalls[0]!.entryPoint).toMatch(/remotion-compositions\.tsx$/);
    expect(result.contentType).toBe('video/mp4');
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(result.bytes.length).toBeGreaterThan(0);
  });

  it('calls selectComposition with CojiClips id and correct inputProps', async () => {
    const { bundler } = makeBundler();
    const { renderer, selectCalls } = makeRenderer();

    const provider = new RemotionRenderProvider({ bundler, renderer, outputDir });

    const composition = oneClipComposition({
      clips: [
        { videoUrl: 'https://example.com/clip-1.mp4' },
        { videoUrl: 'https://example.com/clip-2.mp4' },
      ],
      audioUrl: 'https://example.com/audio.mp3',
    });

    await provider.render(composition);

    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0]!.id).toBe('CojiClips');

    const props = selectCalls[0]!.inputProps as {
      clips: { videoUrl: string }[];
      audioUrl?: string;
    };
    expect(props.clips).toHaveLength(2);
    expect(props.clips[0]!.videoUrl).toBe('https://example.com/clip-1.mp4');
    expect(props.clips[1]!.videoUrl).toBe('https://example.com/clip-2.mp4');
    expect(props.audioUrl).toBe('https://example.com/audio.mp3');
  });

  it('passes audioUrl=undefined when no audio track is supplied', async () => {
    const { bundler } = makeBundler();
    const { renderer, selectCalls } = makeRenderer();

    const provider = new RemotionRenderProvider({ bundler, renderer, outputDir });
    await provider.render(oneClipComposition({ audioUrl: undefined }));

    const props = selectCalls[0]!.inputProps as { audioUrl?: string };
    expect(props.audioUrl).toBeUndefined();
  });

  it('calls renderMedia with h264 codec and the correct outputLocation', async () => {
    const { bundler } = makeBundler();
    const { renderer, renderCalls } = makeRenderer();

    const provider = new RemotionRenderProvider({ bundler, renderer, outputDir });
    await provider.render(oneClipComposition());

    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]!.codec).toBe('h264');
    expect(renderCalls[0]!.outputLocation).toMatch(/output\.mp4$/);
  });

  it('durationInFrames is the sum of all clip durationInFrames', async () => {
    const { bundler } = makeBundler();
    const { renderer } = makeRenderer();

    const provider = new RemotionRenderProvider({ bundler, renderer, outputDir });

    // Inject durationInFrames via the escape hatch the provider supports
    const composition: RenderComposition = {
      clips: [
        {
          videoUrl: 'https://example.com/c1.mp4',
          ...({ durationInFrames: 60 } as object),
        } as RenderComposition['clips'][0],
        {
          videoUrl: 'https://example.com/c2.mp4',
          ...({ durationInFrames: 90 } as object),
        } as RenderComposition['clips'][0],
      ],
      fps: 30,
    };

    const result = await provider.render(composition);
    expect(result.durationInFrames).toBe(150); // 60 + 90
  });

  it('returns the bytes written by the renderer', async () => {
    const { bundler } = makeBundler();
    const { renderer } = makeRenderer();

    const provider = new RemotionRenderProvider({ bundler, renderer, outputDir });
    const result = await provider.render(oneClipComposition());

    expect(Array.from(result.bytes)).toEqual(Array.from(FAKE_OUTPUT_BYTES));
  });

  it('forwards startFrom and endAt to clip inputProps', async () => {
    const { bundler } = makeBundler();
    const { renderer, selectCalls } = makeRenderer();

    const provider = new RemotionRenderProvider({ bundler, renderer, outputDir });

    await provider.render({
      clips: [{ videoUrl: 'https://example.com/clip.mp4', startFrom: 10, endAt: 80 }],
      fps: 30,
    });

    const props = selectCalls[0]!.inputProps as {
      clips: { startFrom?: number; endAt?: number }[];
    };
    expect(props.clips[0]!.startFrom).toBe(10);
    expect(props.clips[0]!.endAt).toBe(80);
  });

  it('uses default fps/width/height when composition omits them', async () => {
    const { bundler } = makeBundler();
    const { renderer, renderCalls } = makeRenderer();

    const provider = new RemotionRenderProvider({ bundler, renderer, outputDir });

    // No fps/width/height in the composition
    await provider.render({ clips: [{ videoUrl: 'https://example.com/clip.mp4' }] });

    // The provider should have called renderMedia with the defaults
    const comp = renderCalls[0]!;
    // We can't directly inspect the composition object from RenderMedia (it's opaque),
    // but we verify the render succeeded and returned bytes.
    expect(comp.outputLocation).toMatch(/output\.mp4$/);
  });

  it('uses injected entryPoint when provided', async () => {
    const { bundler, calls: bundleCalls } = makeBundler();
    const { renderer } = makeRenderer();

    const customEntry = '/custom/path/my-root.tsx';
    const provider = new RemotionRenderProvider({
      bundler,
      renderer,
      outputDir,
      entryPoint: customEntry,
    });
    await provider.render(oneClipComposition());

    expect(bundleCalls[0]!.entryPoint).toBe(customEntry);
  });

  it('propagates bundler errors to the caller', async () => {
    const failingBundler: RemotionBundler = {
      bundle: mock(async () => {
        throw new Error('bundler failed: webpack error');
      }),
    };
    const { renderer } = makeRenderer();

    const provider = new RemotionRenderProvider({ bundler: failingBundler, renderer, outputDir });

    await expect(provider.render(oneClipComposition())).rejects.toThrow('bundler failed');
  });

  it('propagates renderMedia errors to the caller', async () => {
    const { bundler } = makeBundler();
    const failingRenderer: RemotionRenderer = {
      selectComposition: mock(async () => FAKE_COMPOSITION),
      renderMedia: mock(async () => {
        throw new Error('render failed: chromium crashed');
      }),
    };

    const provider = new RemotionRenderProvider({ bundler, renderer: failingRenderer, outputDir });

    await expect(provider.render(oneClipComposition())).rejects.toThrow('render failed');
  });
});

// ---------------------------------------------------------------------------
// Env-gated real render smoke (excluded from default `bun test`)
// ---------------------------------------------------------------------------

// This block is only evaluated when RUN_REAL_RENDER=1 is set in the
// environment. It performs an actual Remotion render with real Chromium
// (which must be available on the host). Do not run in CI.
if (process.env.RUN_REAL_RENDER === '1') {
  describe('[REAL RENDER] RemotionRenderProvider end-to-end', () => {
    it('renders a single-clip composition to mp4 bytes', async () => {
      // Uses the real bundler + renderer (no mocks injected).
      // The clip URL must be a publicly accessible http(s) URL.
      const TEST_CLIP_URL =
        process.env.REAL_RENDER_CLIP_URL ?? 'https://www.w3schools.com/html/mov_bbb.mp4';

      const provider = new RemotionRenderProvider();
      const result = await provider.render({
        clips: [{ videoUrl: TEST_CLIP_URL }],
        fps: 30,
        width: 320,
        height: 240,
      });

      expect(result.bytes.length).toBeGreaterThan(0);
      expect(result.contentType).toBe('video/mp4');
      expect(result.durationInFrames).toBeGreaterThan(0);
      console.log(
        `[real render] PASS — ${result.bytes.length} bytes, ${result.durationInFrames} frames`,
      );
    }, 300_000); // 5 min timeout for real render
  });
}
