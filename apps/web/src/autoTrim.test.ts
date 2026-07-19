/**
 * detectSpeechBoundsFromSamples — pure-function tests (task #18, target 7).
 *
 * The function lives in apps/web/src/lib/autoTrim.ts (extracted by task #11).
 * It is pure (no DOM, no AudioContext) so it runs in Bun without a browser.
 *
 * Algorithm summary:
 *   - Scan mono PCM in 20 ms RMS windows.
 *   - Threshold = max(peak * threshFraction, threshFloor).
 *   - peak < silencePeak → null (silent clip).
 *   - Returns { startFrame, endFrame } in frames at the given fps, with
 *     padInSec / padOutSec lead-in/tail padding.
 *
 * All tests use synthetic Float32Arrays — no network, no DB, no DOM.
 */
import { describe, expect, test } from 'bun:test';
import { detectSpeechBoundsFromSamples } from './lib/autoTrim.ts';

const SR = 44100; // sample rate used throughout
const FPS = 30;

// ---------------------------------------------------------------------------
// Helpers to synthesise clean test signals
// ---------------------------------------------------------------------------

/** Fill `length` samples with a constant amplitude sine wave at `freq` Hz. */
function sine(length: number, amplitude = 0.5, freq = 440): Float32Array {
  const s = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    s[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  }
  return s;
}

/** Concatenate Float32Arrays. */
function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** N samples of silence (zeros). */
function silence(n: number): Float32Array {
  return new Float32Array(n);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectSpeechBoundsFromSamples', () => {
  test('returns null for an all-silence sample (zeros)', () => {
    const s = silence(SR); // 1 s of zeros
    expect(detectSpeechBoundsFromSamples(s, SR, FPS)).toBeNull();
  });

  test('returns null for an empty sample array', () => {
    expect(detectSpeechBoundsFromSamples(new Float32Array(0), SR, FPS)).toBeNull();
  });

  test('returns null when peak is below silencePeak threshold', () => {
    // A signal so quiet it's below the 1e-4 silence floor.
    const s = new Float32Array(SR).fill(1e-5);
    expect(detectSpeechBoundsFromSamples(s, SR, FPS)).toBeNull();
  });

  test('returns {startFrame, endFrame} for a loud signal surrounded by silence', () => {
    // Layout: 0.5 s silence | 1.0 s loud speech | 0.5 s silence.
    const silenceSamples = Math.round(0.5 * SR);
    const speechSamples = Math.round(1.0 * SR);
    const signal = concat(
      silence(silenceSamples),
      sine(speechSamples, 0.5),
      silence(silenceSamples),
    );

    const result = detectSpeechBoundsFromSamples(signal, SR, FPS);
    expect(result).not.toBeNull();
    // Speech starts at ~0.5 s → padded back by 0.08 s → ~0.42 s → frame ~12.
    // Speech ends at ~1.5 s → padded by 0.14 s → ~1.64 s → frame ~50.
    // Allow ±4 frame tolerance for windowing boundary.
    expect(result!.startFrame).toBeGreaterThanOrEqual(8);
    expect(result!.startFrame).toBeLessThanOrEqual(17);
    expect(result!.endFrame).toBeGreaterThanOrEqual(46);
    expect(result!.endFrame).toBeLessThanOrEqual(56);
  });

  test('startFrame is always less than endFrame when non-null', () => {
    const signal = concat(silence(SR / 4), sine(SR / 2, 0.5), silence(SR / 4));
    const result = detectSpeechBoundsFromSamples(signal, SR, FPS);
    expect(result).not.toBeNull();
    expect(result!.startFrame).toBeLessThan(result!.endFrame);
  });

  test('endFrame does not exceed total frame count of the signal', () => {
    // 2 s signal → at most 60 frames at 30 fps (plus a little pad allowance).
    const signal = concat(silence(SR / 4), sine(SR, 0.5), silence(SR / 4));
    const totalFrames = Math.ceil((signal.length / SR) * FPS);
    const result = detectSpeechBoundsFromSamples(signal, SR, FPS);
    expect(result).not.toBeNull();
    // endFrame may slightly exceed totalFrames due to tail padding — that's fine
    // but it should be within 1 pad-out period (0.14 s * 30 fps = 4.2 frames, ~5).
    expect(result!.endFrame).toBeLessThanOrEqual(totalFrames + 5);
  });

  test('RMS detection is deterministic — same input produces the same result', () => {
    const signal = concat(silence(SR / 4), sine(SR / 2, 0.5), silence(SR / 4));
    const a = detectSpeechBoundsFromSamples(signal, SR, FPS);
    const b = detectSpeechBoundsFromSamples(signal, SR, FPS);
    expect(a).toEqual(b);
  });

  test('speech at the very start → startFrame is 0 (no silence before)', () => {
    const signal = concat(sine(SR, 0.5), silence(SR / 4));
    const result = detectSpeechBoundsFromSamples(signal, SR, FPS);
    expect(result).not.toBeNull();
    // No silence before speech → lead-in pad clamps to 0.
    expect(result!.startFrame).toBe(0);
  });

  test('higher fps produces proportionally larger frame numbers for the same signal', () => {
    const signal = concat(silence(SR / 4), sine(SR / 2, 0.5), silence(SR / 4));
    const r30 = detectSpeechBoundsFromSamples(signal, SR, 30);
    const r60 = detectSpeechBoundsFromSamples(signal, SR, 60);
    expect(r30).not.toBeNull();
    expect(r60).not.toBeNull();
    // At 60fps, frame numbers should be roughly double those at 30fps.
    expect(r60!.startFrame).toBeGreaterThanOrEqual(r30!.startFrame * 1.7);
    expect(r60!.endFrame).toBeGreaterThanOrEqual(r30!.endFrame * 1.7);
  });

  test('custom threshFraction=0 keeps all non-silent audio', () => {
    // With a threshold fraction of 0, even very quiet audio passes.
    const signal = concat(silence(SR / 4), sine(SR / 4, 0.01), silence(SR / 4));
    const result = detectSpeechBoundsFromSamples(signal, SR, FPS, { threshFraction: 0 });
    expect(result).not.toBeNull();
  });
});
