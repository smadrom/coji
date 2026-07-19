/**
 * FfmpegRenderProvider — the real RenderProvider for coji's export.
 *
 * The clips are ALREADY rendered videos (HeyGen talking-head mp4s). So "export"
 * is a trim + concatenate, not a frame-by-frame composite — ffmpeg is the right
 * tool (orders of magnitude lighter/faster than spinning up Remotion+Chromium to
 * re-render existing video).
 *
 * For each clip we:
 *   1. download the bytes (the caller passes signed http(s) URLs, ADR-5),
 *   2. trim to its in/out points (startFrom/endAt, in frames → seconds),
 *   3. normalise to a common size/fps/pixel-format/sample-rate,
 * then concat all clips (video + audio) into one mp4 with `+faststart`.
 *
 * ffmpeg is invoked via argv (no shell) so the filtergraph needs no escaping.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RenderComposition, RenderProvider, RenderResult } from '@coji/shared/providers';

const DEFAULT_FPS = 30;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

export interface FfmpegRenderProviderOptions {
  /** ffmpeg binary (default: `ffmpeg` on PATH). */
  ffmpegPath?: string;
  fps?: number;
  width?: number;
  height?: number;
}

/** Run a command to completion; reject with stderr tail on a non-zero exit. */
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (err) => reject(new Error(`${cmd} spawn failed: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

/** Build an ffmpeg trim expression (seconds), or null/anull when no trim. */
function trimExpr(kind: 'v' | 'a', start: number | undefined, end: number | undefined): string {
  const fn = kind === 'v' ? 'trim' : 'atrim';
  if (start == null && end == null) return kind === 'v' ? 'null' : 'anull';
  const parts: string[] = [];
  if (start != null) parts.push(`start=${start.toFixed(3)}`);
  if (end != null) parts.push(`end=${end.toFixed(3)}`);
  return `${fn}=${parts.join(':')}`;
}

export class FfmpegRenderProvider implements RenderProvider {
  readonly #ffmpeg: string;
  readonly #fps: number;
  readonly #width: number;
  readonly #height: number;

  constructor(opts: FfmpegRenderProviderOptions = {}) {
    this.#ffmpeg = opts.ffmpegPath ?? 'ffmpeg';
    this.#fps = opts.fps ?? DEFAULT_FPS;
    this.#width = opts.width ?? DEFAULT_WIDTH;
    this.#height = opts.height ?? DEFAULT_HEIGHT;
  }

  async render(composition: RenderComposition): Promise<RenderResult> {
    const clips = composition.clips ?? [];
    if (clips.length === 0) throw new Error('render: composition has no clips');

    const fps = composition.fps ?? this.#fps;
    const w = composition.width ?? this.#width;
    const h = composition.height ?? this.#height;

    const dir = await mkdtemp(join(tmpdir(), 'coji-ffmpeg-'));
    try {
      // 1) Download each clip to a temp file.
      const inputs: string[] = [];
      for (let i = 0; i < clips.length; i++) {
        const url = clips[i]?.videoUrl;
        if (!url) throw new Error(`render: clip ${i} has no videoUrl`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`render: clip ${i} download failed (${res.status})`);
        const p = join(dir, `in${i}.mp4`);
        await writeFile(p, Buffer.from(await res.arrayBuffer()));
        inputs.push(p);
      }

      // 2) Build the trim+normalise+concat filtergraph.
      const filterParts: string[] = [];
      const concatInputs: string[] = [];
      let totalFrames = 0;
      clips.forEach((c, i) => {
        const start = c.startFrom != null ? c.startFrom / fps : undefined;
        const end = c.endAt != null ? c.endAt / fps : undefined;
        if (c.startFrom != null && c.endAt != null)
          totalFrames += Math.max(1, c.endAt - c.startFrom);
        filterParts.push(
          `[${i}:v]${trimExpr('v', start, end)},setpts=PTS-STARTPTS,` +
            // COVER (fill + center-crop) — not letterbox. A non-9:16 clip fills
            // the vertical frame and the overflow is cropped, so the export has
            // no black bars (TikTok/Reels expect full-bleed 9:16).
            `scale=${w}:${h}:force_original_aspect_ratio=increase,` +
            `crop=${w}:${h},fps=${fps},format=yuv420p[v${i}]`,
        );
        filterParts.push(
          `[${i}:a]${trimExpr('a', start, end)},asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0[a${i}]`,
        );
        concatInputs.push(`[v${i}][a${i}]`);
      });
      const filter = `${filterParts.join(';')};${concatInputs.join('')}concat=n=${clips.length}:v=1:a=1[v][a]`;

      // 3) Render.
      const out = join(dir, 'out.mp4');
      const args = [
        ...inputs.flatMap((p) => ['-i', p]),
        '-filter_complex',
        filter,
        '-map',
        '[v]',
        '-map',
        '[a]',
        '-r',
        String(fps),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        '-y',
        out,
      ];
      await run(this.#ffmpeg, args);

      const bytes = await readFile(out);
      return {
        bytes: new Uint8Array(bytes),
        contentType: 'video/mp4',
        durationInFrames: totalFrames > 0 ? totalFrames : Math.round(fps),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
