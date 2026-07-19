/**
 * RemotionRenderProvider — real RenderProvider implementation (P4.a).
 *
 * Bundles + renders the CojiClips composition using @remotion/bundler +
 * @remotion/renderer (remotionb under Bun). The entry point is the sibling
 * remotion-compositions.tsx, which is only ever consumed via the bundler —
 * it is NOT imported here at runtime so the api typecheck stays clean.
 *
 * Key constraints from the render smoke test (task #10 / packages/render-spike):
 *   - <OffthreadVideo src> only accepts http(s) URLs — never file://.
 *     The caller (job runner) must pass signed object-storage URLs (ADR-5).
 *   - jsxImportSource:"remotion" crashes the webpack bundler; the standard
 *     react-jsx transform is used instead (tsconfig.base.json).
 *   - Remotion 4.0.491 is pinned; review the bundled custom license before
 *     commercial use (see THIRD_PARTY_NOTICES.md).
 *   - Under Bun, remotionb is used (bun-compatible CLI wrapper).
 *
 * Injection contract (matches other providers in this codebase):
 *   - Pass `bundler` + `renderer` in opts to inject mocks in tests.
 *   - When omitted, the real @remotion/bundler and @remotion/renderer are
 *     dynamically imported so they are only loaded when RENDER_PROVIDER=remotion.
 *     This keeps the default `bun test` / CI fast (no Chromium download).
 *
 * Default output temp dir: OS tmpdir. Override via `outputDir` option for tests.
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RenderComposition, RenderProvider, RenderResult } from '@coji/shared/providers';

// ---------------------------------------------------------------------------
// Mockable bundler + renderer surface (the slice we call)
// ---------------------------------------------------------------------------

export interface RemotionBundler {
  bundle(opts: { entryPoint: string; onProgress?: (progress: number) => void }): Promise<string>;
}

export interface RemotionComposition {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  defaultProps?: Record<string, unknown>;
}

export interface RemotionRenderer {
  selectComposition(opts: {
    serveUrl: string;
    id: string;
    inputProps?: Record<string, unknown>;
  }): Promise<RemotionComposition>;
  renderMedia(opts: {
    serveUrl: string;
    composition: RemotionComposition;
    codec: string;
    outputLocation: string;
    inputProps?: Record<string, unknown>;
    onProgress?: (progress: { progress: number }) => void;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// CojiCompositionProps mirror (keeps this file free of the .tsx import)
// ---------------------------------------------------------------------------

interface CojiClipInputProps {
  videoUrl: string;
  durationInFrames: number;
  startFrom?: number;
  endAt?: number;
}

interface CojiCompositionInputProps {
  clips: CojiClipInputProps[];
  audioUrl?: string;
}

// ---------------------------------------------------------------------------
// Provider options
// ---------------------------------------------------------------------------

export interface RemotionRenderProviderOptions {
  /**
   * Absolute path to the Remotion entry .tsx file.
   * Defaults to the sibling remotion-compositions.tsx (resolved at construction
   * time via import.meta.dir so tests that inject mocks still get the right path).
   */
  entryPoint?: string;

  /** Inject a bundler mock (tests). When omitted, @remotion/bundler is used. */
  bundler?: RemotionBundler;

  /** Inject a renderer mock (tests). When omitted, @remotion/renderer is used. */
  renderer?: RemotionRenderer;

  /**
   * Output directory for rendered mp4 files.
   * Defaults to a fresh subdirectory under OS tmpdir per render call.
   * Inject a fixed path in tests so cleanup is predictable.
   */
  outputDir?: string;

  /** fps used when the composition lacks an fps value. Default: 30. */
  defaultFps?: number;

  /** Width override when composition lacks width. Default: 1920. */
  defaultWidth?: number;

  /** Height override when composition lacks height. Default: 1080. */
  defaultHeight?: number;
}

// ---------------------------------------------------------------------------
// Default frame-rate for a clip when the caller does not specify durationInFrames
// ---------------------------------------------------------------------------

const DEFAULT_FPS = 30;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const COMPOSITION_ID = 'CojiClips';

/** Seconds per clip used when the provider needs to estimate frame count. */
const DEFAULT_CLIP_SECONDS = 5;

// ---------------------------------------------------------------------------
// RemotionRenderProvider
// ---------------------------------------------------------------------------

export class RemotionRenderProvider implements RenderProvider {
  readonly #entryPoint: string;
  readonly #bundlerOpt: RemotionBundler | undefined;
  readonly #rendererOpt: RemotionRenderer | undefined;
  readonly #outputDir: string | undefined;
  readonly #defaultFps: number;
  readonly #defaultWidth: number;
  readonly #defaultHeight: number;

  constructor(opts: RemotionRenderProviderOptions = {}) {
    // Resolve the entry point relative to this file's directory so it works
    // whether invoked from the repo root, apps/api, or a test.
    this.#entryPoint = opts.entryPoint ?? resolve(import.meta.dir, 'remotion-compositions.tsx');
    this.#bundlerOpt = opts.bundler;
    this.#rendererOpt = opts.renderer;
    this.#outputDir = opts.outputDir;
    this.#defaultFps = opts.defaultFps ?? DEFAULT_FPS;
    this.#defaultWidth = opts.defaultWidth ?? DEFAULT_WIDTH;
    this.#defaultHeight = opts.defaultHeight ?? DEFAULT_HEIGHT;
  }

  async render(composition: RenderComposition): Promise<RenderResult> {
    const fps = composition.fps ?? this.#defaultFps;
    const width = composition.width ?? this.#defaultWidth;
    const height = composition.height ?? this.#defaultHeight;

    // Build inputProps for the CojiClips composition.
    // Each RenderClipInput gets a durationInFrames derived from the clip
    // metadata if available, or a reasonable default (the caller should
    // supply this via future RenderClipInput.durationInFrames additions).
    const clips: CojiClipInputProps[] = composition.clips.map((c) => ({
      videoUrl: c.videoUrl,
      // durationInFrames is not yet in RenderClipInput seam — derive from fps
      // as a safe default. P4.b will extend RenderClipInput with this field.
      durationInFrames:
        (c as unknown as { durationInFrames?: number }).durationInFrames ??
        Math.round(DEFAULT_CLIP_SECONDS * fps),
      startFrom: c.startFrom,
      endAt: c.endAt,
    }));

    const inputProps: CojiCompositionInputProps = {
      clips,
      audioUrl: composition.audioUrl,
    };

    const totalFrames = clips.reduce((sum, c) => sum + c.durationInFrames, 0);

    // Lazy-load the real Remotion modules (only when no injected mock).
    const bundler = this.#bundlerOpt ?? (await this.#loadBundler());
    const renderer = this.#rendererOpt ?? (await this.#loadRenderer());

    // Bundle once per render call. The bundle result is a local serve URL.
    const serveUrl = await bundler.bundle({ entryPoint: this.#entryPoint });

    // selectComposition resolves the registered composition by id.
    const comp = await renderer.selectComposition({
      serveUrl,
      id: COMPOSITION_ID,
      inputProps: inputProps as unknown as Record<string, unknown>,
    });

    // Resolve output path.
    const outDir =
      this.#outputDir ??
      join(tmpdir(), `coji-render-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(outDir, { recursive: true });
    const outputLocation = join(outDir, 'output.mp4');

    try {
      await renderer.renderMedia({
        serveUrl,
        composition: {
          ...comp,
          // Override dimensions/fps from our config so the output matches the
          // project settings, not the composition defaults.
          width,
          height,
          fps,
          durationInFrames: totalFrames,
        },
        codec: 'h264',
        outputLocation,
        inputProps: inputProps as unknown as Record<string, unknown>,
      });

      // Read the rendered file into memory for the caller to persist via
      // StorageProvider. For large exports this could be streamed, but the
      // seam returns bytes — a future RenderResult.outputPath extension can
      // avoid the read when Lambda or a file-based caller is used.
      const bytes = await Bun.file(outputLocation).bytes();

      return {
        bytes: new Uint8Array(bytes),
        contentType: 'video/mp4',
        durationInFrames: totalFrames,
      };
    } finally {
      // Clean up the temp output file (not the serveUrl bundle cache —
      // Remotion manages that). Skip cleanup if caller supplied a fixed dir.
      if (!this.#outputDir) {
        await rm(outDir, { recursive: true, force: true });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lazy loader helpers — only called when no mock is injected
  // ---------------------------------------------------------------------------

  async #loadBundler(): Promise<RemotionBundler> {
    // @remotion/bundler is not in apps/api/package.json — it lives in
    // packages/render-spike (heavy dep, isolated from the default build).
    // This dynamic import only runs when RENDER_PROVIDER=remotion-local and
    // Remotion is installed on the host.  The indirection via a variable
    // prevents TypeScript from trying to resolve the specifier at typecheck
    // time while keeping the import legal at runtime under Bun/Node.
    const specifier = '@remotion/bundler';
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      bundle: RemotionBundler['bundle'];
    };
    return {
      bundle: (opts) => mod.bundle(opts),
    };
  }

  async #loadRenderer(): Promise<RemotionRenderer> {
    const specifier = '@remotion/renderer';
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      selectComposition: RemotionRenderer['selectComposition'];
      renderMedia: RemotionRenderer['renderMedia'];
    };
    return {
      selectComposition: (opts) => mod.selectComposition(opts),
      renderMedia: (opts) => mod.renderMedia(opts),
    };
  }
}
