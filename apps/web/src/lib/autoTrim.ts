/**
 * autoTrim — pure speech-bounds detection for the editor's "auto-trim silence".
 *
 * The browser-only parts (fetch + Web-Audio `decodeAudioData`) live in the
 * caller; this module is a PURE function over already-decoded PCM samples so it
 * can be unit-tested without a DOM/AudioContext (worker-tests).
 *
 * Algorithm: scan the mono RMS envelope in small windows, find the first/last
 * window above an adaptive threshold (a fraction of the peak), and return the
 * in/out points in FRAMES with a little lead-in/tail padding. Returns null when
 * the clip is effectively silent (→ caller keeps the clip full).
 */

/** Tuning for the speech scan. Defaults match the editor's prior inline values. */
export interface AutoTrimOptions {
  /** RMS window length in seconds (default 0.02 = 20 ms). */
  windowSec?: number;
  /** Lead-in kept before the first detected phoneme (default 0.08 s). */
  padInSec?: number;
  /** Tail kept after the last detected phoneme (default 0.14 s). */
  padOutSec?: number;
  /** Peak fraction for the speech threshold (default 0.08). */
  threshFraction?: number;
  /** Absolute floor for the threshold (default 0.004). */
  threshFloor?: number;
  /** Silence cutoff: peak RMS below this → treat the clip as silent (default 1e-4). */
  silencePeak?: number;
}

const DEFAULTS: Required<AutoTrimOptions> = {
  windowSec: 0.02,
  padInSec: 0.08,
  padOutSec: 0.14,
  threshFraction: 0.08,
  threshFloor: 0.004,
  silencePeak: 1e-4,
};

export interface SpeechBounds {
  startFrame: number;
  endFrame: number;
}

/**
 * Detect speech in/out points (in frames at `fps`) from mono PCM `samples`.
 * Returns null when the audio is effectively silent or empty.
 */
export function detectSpeechBoundsFromSamples(
  samples: Float32Array | number[],
  sampleRate: number,
  fps: number,
  options: AutoTrimOptions = {},
): SpeechBounds | null {
  const opts = { ...DEFAULTS, ...options };
  const length = samples.length;
  if (length === 0 || sampleRate <= 0 || fps <= 0) return null;

  const win = Math.max(1, Math.floor(sampleRate * opts.windowSec));
  const windows = Math.floor(length / win);
  if (windows === 0) return null;

  const rms = new Float32Array(windows);
  let peak = 0;
  for (let i = 0; i < windows; i++) {
    let sum = 0;
    const base = i * win;
    for (let j = 0; j < win; j++) {
      const v = samples[base + j] ?? 0;
      sum += v * v;
    }
    const r = Math.sqrt(sum / win);
    rms[i] = r;
    if (r > peak) peak = r;
  }

  if (peak < opts.silencePeak) return null; // effectively silent

  const thresh = Math.max(peak * opts.threshFraction, opts.threshFloor);
  let first = -1;
  let last = -1;
  for (let i = 0; i < windows; i++) {
    if ((rms[i] ?? 0) > thresh) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;

  const startSec = Math.max(0, first * opts.windowSec - opts.padInSec);
  const endSec = (last + 1) * opts.windowSec + opts.padOutSec;
  return {
    startFrame: Math.floor(startSec * fps),
    endFrame: Math.ceil(endSec * fps),
  };
}
