import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
/**
 * P4 render smoke test (feasibility SPIKE — not part of the default test run).
 *
 * Run:  bun run spike:render        (from repo root)
 *   or: bun run src/smoke.ts        (from packages/render-spike)
 *
 * Proves the risky ADR-3 path end-to-end under Bun:
 *   1. renderMedia a synthetic ~1s SolidClip -> temp mp4 (basic render works).
 *   2. renderMedia a Composite that pulls that mp4 back in via <OffthreadVideo>
 *      inside <Series.Sequence> + an <Audio> track -> temp mp4.
 * Asserts both outputs are non-empty, captures timings, and writes a verdict +
 * recommendation to docs/render-smoke.md.
 *
 * Exits non-zero on failure so CI/operators get a clear signal — but this is
 * NOT wired into the default `bun test`; it is opt-in.
 */
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const REMOTION_VERSION = '4.0.491';
const HERE = resolve(import.meta.dir);
const ENTRY = join(HERE, 'entry.ts');
const DOCS = resolve(HERE, '..', '..', '..', 'docs', 'render-smoke.md');

interface StageTiming {
  name: string;
  ms: number;
  bytes: number;
  output: string;
}

/** Minimal valid 16-bit PCM WAV (silent) of `seconds` at 8kHz mono. */
function makeSilentWav(seconds: number): Uint8Array {
  const sampleRate = 8000;
  const numSamples = Math.floor(sampleRate * seconds);
  const dataSize = numSamples * 2; // 16-bit mono
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  // samples already zero (silence)
  return new Uint8Array(buf);
}

async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

/**
 * Serve `dir` over HTTP. Remotion's <OffthreadVideo> only fetches http(s) URLs
 * (file:// is rejected by the compositor) — which mirrors production, where
 * clips are fetched via signed object-storage URLs (ADR-5). So serving over
 * HTTP is the faithful test, not a workaround.
 */
function serveDir(dir: string): { origin: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const name = basename(new URL(req.url).pathname);
      try {
        const bytes = await readFile(join(dir, name));
        const type = name.endsWith('.wav') ? 'audio/wav' : 'video/mp4';
        return new Response(bytes, { headers: { 'content-type': type } });
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  });
  return { origin: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

async function main() {
  const bunVersion = (globalThis as { Bun?: { version: string } }).Bun?.version ?? 'unknown';
  const outDir = join(tmpdir(), `coji-render-smoke-${Date.now()}`);
  await mkdir(outDir, { recursive: true });

  const timings: StageTiming[] = [];
  let chromiumNote = 'Remotion-managed headless Chromium (auto-downloaded via ensureBrowser).';

  // Bundle the Remotion project once.
  console.log('[smoke] bundling Remotion project…');
  const t0 = performance.now();
  const serveUrl = await bundle({ entryPoint: ENTRY });
  console.log(`[smoke] bundled in ${Math.round(performance.now() - t0)}ms`);

  // -- Stage 1: synthetic SolidClip -> mp4 -----------------------------------
  const solidOut = join(outDir, 'solid.mp4');
  {
    const comp = await selectComposition({ serveUrl, id: 'SolidClip' });
    const s = performance.now();
    await renderMedia({ serveUrl, composition: comp, codec: 'h264', outputLocation: solidOut });
    const ms = Math.round(performance.now() - s);
    const bytes = await fileSize(solidOut);
    if (bytes <= 0) throw new Error('SolidClip render produced an empty file');
    timings.push({ name: 'SolidClip (synthetic)', ms, bytes, output: solidOut });
    console.log(`[smoke] SolidClip rendered: ${bytes} bytes in ${ms}ms`);
  }

  // -- Stage 2: Composite via OffthreadVideo + Audio -------------------------
  // Serve the temp dir over HTTP so OffthreadVideo can fetch the clip the same
  // way production fetches signed object-storage URLs.
  const audioPath = join(outDir, 'silence.wav');
  await writeFile(audioPath, makeSilentWav(1));
  const compositeOut = join(outDir, 'composite.mp4');
  const fileServer = serveDir(outDir);
  chromiumNote += ` Source clip fetched over HTTP (${fileServer.origin}) to mirror signed-URL fetch (ADR-5).`;
  try {
    const clipSrc = `${fileServer.origin}/${basename(solidOut)}`;
    const audioSrc = `${fileServer.origin}/${basename(audioPath)}`;
    const inputProps = { clipSrc, audioSrc };
    const comp = await selectComposition({ serveUrl, id: 'Composite', inputProps });
    const s = performance.now();
    await renderMedia({
      serveUrl,
      composition: comp,
      codec: 'h264',
      outputLocation: compositeOut,
      inputProps,
    });
    const ms = Math.round(performance.now() - s);
    const bytes = await fileSize(compositeOut);
    if (bytes <= 0) throw new Error('Composite render produced an empty file');
    timings.push({
      name: 'Composite (OffthreadVideo + Audio + Series)',
      ms,
      bytes,
      output: compositeOut,
    });
    console.log(`[smoke] Composite rendered: ${bytes} bytes in ${ms}ms`);
  } finally {
    fileServer.stop();
  }

  await writeVerdict({ pass: true, bunVersion, chromiumNote, timings, error: null });
  console.log(
    '\n[smoke] PASS — local Remotion render under Bun works for the OffthreadVideo path.',
  );
  console.log(`[smoke] verdict written to ${DOCS}`);
}

async function writeVerdict(opts: {
  pass: boolean;
  bunVersion: string;
  chromiumNote: string;
  timings: StageTiming[];
  error: string | null;
}) {
  const { pass, bunVersion, chromiumNote, timings, error } = opts;
  const verdict = pass ? 'PASS ✅' : 'FAIL ❌';
  const recommendation = pass
    ? 'Local `@remotion/renderer` under Bun is viable for v1 — implement the `RenderProvider` local impl in P4. Keep `@remotion/lambda` as the documented production swap (ADR-3).'
    : 'Local render under Bun FAILED — **pivot to Lambda-first** (`@remotion/lambda`) before building the editor on local render (ADR-3 fallback).';

  const rows = timings
    .map((t) => `| ${t.name} | ${t.ms} ms | ${t.bytes.toLocaleString()} bytes |`)
    .join('\n');

  const body = `# P4 Render Smoke Test — Bun + Chromium + OffthreadVideo

**Verdict: ${verdict}**
**Date:** ${new Date().toISOString().slice(0, 10)}
**Generated by:** bun run spike:render

This is the plan's P4 PRE-GATE: prove server-side Remotion rendering works under
Bun on this host, specifically the risky path of compositing an EXTERNAL video
clip via \`<OffthreadVideo>\` + \`<Audio>\` inside \`<Series.Sequence>\` (de-risks ADR-3,
local render vs Lambda).

## Environment

| Item | Value |
|---|---|
| Remotion version | ${REMOTION_VERSION} (4.0.x stable — NOT v5; avoids mandatory telemetry / contractor-headcount changes) |
| Bun version | ${bunVersion} |
| Chromium source | ${chromiumNote} |
| Platform | ${process.platform} ${process.arch} |

## What was rendered

1. **SolidClip** — a synthetic ~1s animated solid-colour composition rendered to mp4
   (proves basic server-side render + gives a real source clip).
2. **Composite** — pulls that mp4 back in through \`<OffthreadVideo>\` inside a
   \`<Series.Sequence>\`, plus an \`<Audio>\` track (a generated silent WAV), rendered to mp4.
   This is the exact compositing path the production editor/export relies on.

## Results

| Stage | Render time | Output size |
|---|---|---|
${rows || '| (none — failed before any render) | — | — |'}
${error ? `\n**Error:**\n\n\`\`\`\n${error}\n\`\`\`\n` : ''}
## Constraints / notes

- Pinned to Remotion **${REMOTION_VERSION}** (4.0.x). Do **not** adopt v5 without
  handling mandatory render telemetry (Automators) + contractor headcount — see
  docs/api-verification.md §3.
- Under Bun, Remotion auto-disables the \`lazyComponent\` prop and SSR scripts may
  not auto-quit after completion (documented Bun constraints).
- \`<OffthreadVideo>\` uses FFmpeg for frame extraction (SSR-safe) and is **not**
  supported by \`@remotion/web-renderer\` — confirming the plan's elimination of the
  web-renderer export path.
- **Key finding:** \`<OffthreadVideo src>\` only accepts **http(s)** URLs — a
  \`file://\` source is rejected by the compositor ("Can only download URLs starting
  with http:// or https://"). This is not a limitation in practice: production
  fetches clips via **signed object-storage URLs** (ADR-5), so the P4 \`RenderProvider\`
  must hand OffthreadVideo a signed/public HTTP URL (\`clips.video_url\`), never a
  local path. The smoke test serves the intermediate clip over a localhost HTTP
  server to mirror this exactly.
- Deps are isolated in \`packages/render-spike\` and excluded from the default
  \`bun test\` / root \`typecheck\` so the main build stays light. Run with:
  \`bun run spike:render\`.

## Recommendation

${recommendation}
`;

  await writeFile(DOCS, body);
}

main().catch(async (err) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error('[smoke] FAIL:', message);
  const bunVersion = (globalThis as { Bun?: { version: string } }).Bun?.version ?? 'unknown';
  try {
    await writeVerdict({
      pass: false,
      bunVersion,
      chromiumNote: 'N/A (failed before/at render).',
      timings: [],
      error: message,
    });
    console.error(`[smoke] FAIL verdict written to ${DOCS}`);
  } catch (writeErr) {
    console.error('[smoke] could not write verdict:', writeErr);
  }
  process.exit(1);
});
