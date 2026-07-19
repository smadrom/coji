/**
 * Unit tests for the per-frame VO mapping (resolveFrameAudioPayloads) — the
 * avatars-voices gap fix: each clip gets its own script line + the project's
 * locale-matched voice, with a prompt fallback when no script was entered.
 *
 * Pure (no DB) so it runs in CI without Postgres.
 */
import { describe, expect, it } from 'bun:test';
import { resolveFrameAudioPayloads } from './animation-stage.ts';
import { InvalidStateError } from './image-stage.ts';

const base = {
  audioMode: 'tts' as const,
  prompt: 'A confident woman demoing an app',
  script: null as string | null,
  voiceId: 'voice_x',
  audioUrl: null as string | null,
};

describe('resolveFrameAudioPayloads (tts)', () => {
  it('splits the script into one non-empty line per frame, sharing the voice', () => {
    const out = resolveFrameAudioPayloads(
      { ...base, script: 'First line. Second line. Third line. Fourth line.' },
      4,
    );
    expect(out).toHaveLength(4);
    for (const a of out) {
      expect(a.mode).toBe('tts');
      if (a.mode === 'tts') {
        expect(a.voiceId).toBe('voice_x');
        expect(a.script.trim().length).toBeGreaterThan(0);
      }
    }
    // Distinct lines across frames (the script was split, not duplicated).
    const scripts = out.map((a) => (a.mode === 'tts' ? a.script : ''));
    expect(new Set(scripts).size).toBeGreaterThan(1);
  });

  it('falls back to the prompt when no script was entered', () => {
    const out = resolveFrameAudioPayloads({ ...base, script: null }, 4);
    expect(out).toHaveLength(4);
    expect(out.every((a) => a.mode === 'tts' && a.script.trim().length > 0)).toBe(true);
  });

  it('throws when the project has no voice_id', () => {
    expect(() => resolveFrameAudioPayloads({ ...base, voiceId: null }, 4)).toThrow(
      InvalidStateError,
    );
  });
});

describe('resolveFrameAudioPayloads (audio_url)', () => {
  it('uses the same supplied audio URL for every frame', () => {
    const out = resolveFrameAudioPayloads(
      { ...base, audioMode: 'audio_url', audioUrl: 'https://x/y.mp3', voiceId: null },
      4,
    );
    expect(out).toHaveLength(4);
    expect(out.every((a) => a.mode === 'audio_url' && a.audioUrl === 'https://x/y.mp3')).toBe(true);
  });

  it('throws when audio_url mode has no url', () => {
    expect(() =>
      resolveFrameAudioPayloads({ ...base, audioMode: 'audio_url', audioUrl: null }, 4),
    ).toThrow(InvalidStateError);
  });
});
