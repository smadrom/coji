/**
 * Deterministic Noop provider fakes — the CI default. These NEVER call a paid
 * API; they produce stable, reproducible outputs so tests can drive the full
 * draft→rendered pipeline for free.
 */
import type {
  AnimationProvider,
  AnimationResult,
  AnimationSubmitInput,
  GeneratedFrame,
  ImageGenerateOptions,
  ImageProvider,
  RenderComposition,
  RenderProvider,
  RenderResult,
} from './types.ts';

const encoder = new TextEncoder();

/** Stable bytes derived from a label so output is deterministic and inspectable. */
function fakeBytes(label: string): Uint8Array {
  return encoder.encode(`coji-noop:${label}`);
}

// --------------------------------------------------------------------------

export class NoopImageProvider implements ImageProvider {
  async generate(prompt: string, opts?: ImageGenerateOptions): Promise<GeneratedFrame[]> {
    const count = opts?.frameCount ?? 4;
    const seed = opts?.seed ?? 'seed';
    return Array.from({ length: count }, (_, idx) => {
      // Use the per-frame shot prompt when a storyboard is supplied so the fake
      // frames differ per shot (deterministic) — mirrors the real provider.
      const shot = opts?.shotPrompts?.[idx] ?? prompt;
      return {
        idx,
        bytes: fakeBytes(`image:${seed}:${idx}:${shot}`),
        contentType: 'image/png',
        caption: opts?.shotPrompts?.[idx] ?? `Frame ${idx + 1}: ${prompt}`,
      };
    });
  }
}

// --------------------------------------------------------------------------

/**
 * Synchronously-resolvable animation fake: every submitted job is immediately
 * `completed` with a deterministic video URL keyed by its callbackId, so the
 * runner/poll path resolves without any external service.
 */
export class NoopAnimationProvider implements AnimationProvider {
  private readonly jobs = new Map<string, AnimationResult>();

  async submit(input: AnimationSubmitInput): Promise<{ externalId: string }> {
    const externalId = `noop-video-${input.callbackId}`;
    this.jobs.set(externalId, {
      externalId,
      status: 'completed',
      videoUrl: `noop://clip/${encodeURIComponent(input.frameRef)}/${externalId}.mp4`,
    });
    return { externalId };
  }

  async fetchResult(externalId: string): Promise<AnimationResult> {
    const existing = this.jobs.get(externalId);
    if (existing) return existing;
    // Unknown id (e.g. reconciler for a job submitted elsewhere): resolve
    // deterministically as completed so the happy path still converges.
    return {
      externalId,
      status: 'completed',
      videoUrl: `noop://clip/${externalId}.mp4`,
    };
  }
}

// --------------------------------------------------------------------------

export class NoopRenderProvider implements RenderProvider {
  async render(composition: RenderComposition): Promise<RenderResult> {
    const label = composition.clips.map((c) => c.videoUrl).join('|');
    return {
      bytes: fakeBytes(`render:${label}`),
      contentType: 'video/mp4',
      durationInFrames: Math.max(1, composition.clips.length) * (composition.fps ?? 30),
    };
  }
}
