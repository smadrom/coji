import { describe, expect, test } from 'bun:test';
import { NoopAnimationProvider, NoopImageProvider, NoopRenderProvider } from './noop.ts';
import type { AnimationSubmitInput } from './types.ts';

const decoder = new TextDecoder();

describe('NoopImageProvider', () => {
  test('returns 4 deterministic frames with captions by default', async () => {
    const provider = new NoopImageProvider();
    const frames = await provider.generate('a woman in a red coat', { seed: 'p1' });

    expect(frames).toHaveLength(4);
    frames.forEach((frame, i) => {
      expect(frame.idx).toBe(i);
      expect(frame.contentType).toBe('image/png');
      expect(frame.caption).toContain('a woman in a red coat');
      expect(frame.bytes.byteLength).toBeGreaterThan(0);
    });
  });

  test('output is deterministic for the same prompt + seed', async () => {
    const a = await new NoopImageProvider().generate('x', { seed: 's' });
    const b = await new NoopImageProvider().generate('x', { seed: 's' });
    expect(decoder.decode(a[0]!.bytes)).toBe(decoder.decode(b[0]!.bytes));
  });

  test('honours a custom frameCount', async () => {
    const frames = await new NoopImageProvider().generate('x', { frameCount: 2 });
    expect(frames).toHaveLength(2);
  });
});

describe('NoopAnimationProvider', () => {
  const baseInput = (callbackId: string): AnimationSubmitInput => ({
    frameRef: 'frames/p1/0.png',
    audio: { mode: 'tts', script: 'hi', voiceId: 'v1' },
    callbackId,
  });

  test('submit returns an external id derived from callbackId', async () => {
    const provider = new NoopAnimationProvider();
    const { externalId } = await provider.submit(baseInput('job-1'));
    expect(externalId).toBe('noop-video-job-1');
  });

  test('fetchResult resolves a submitted job as completed with a video URL', async () => {
    const provider = new NoopAnimationProvider();
    const { externalId } = await provider.submit(baseInput('job-1'));
    const result = await provider.fetchResult(externalId);
    expect(result.status).toBe('completed');
    expect(result.videoUrl).toContain('noop://clip/');
  });

  test('fetchResult for an unknown id still resolves deterministically', async () => {
    const result = await new NoopAnimationProvider().fetchResult('noop-video-x');
    expect(result.status).toBe('completed');
    expect(result.videoUrl).toBeDefined();
  });
});

describe('NoopRenderProvider', () => {
  test('renders deterministic bytes and a frame count from the composition', async () => {
    const provider = new NoopRenderProvider();
    const result = await provider.render({
      clips: [{ videoUrl: 'a.mp4' }, { videoUrl: 'b.mp4' }],
      fps: 30,
    });
    expect(result.contentType).toBe('video/mp4');
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(result.durationInFrames).toBe(60);
  });
});
