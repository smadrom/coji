/**
 * Voices service (D1) — the catalog of TTS voices the picker on /new lists.
 *
 * Backed by the VoicesProvider seam (@coji/shared/providers); the CI default is
 * the deterministic StaticVoicesProvider (curated standard voices) so CI never
 * calls the HeyGen voices API (hard rule #3). The list is cached in-memory with
 * a TTL so a real upstream is hit at most once per window.
 */
import { StaticVoicesProvider, type Voice, type VoicesProvider } from '@coji/shared/providers';

/** Cache TTL for the voices list (ms). Voices change rarely; 1h is plenty. */
const VOICES_CACHE_TTL_MS = 60 * 60 * 1000;

export interface VoicesService {
  /** The available voices (cached). */
  list(): Promise<Voice[]>;
}

export function createVoicesService(
  provider: VoicesProvider = new StaticVoicesProvider(),
  ttlMs: number = VOICES_CACHE_TTL_MS,
): VoicesService {
  let cache: { at: number; voices: Voice[] } | null = null;

  return {
    async list(): Promise<Voice[]> {
      const now = Date.now();
      if (cache && now - cache.at < ttlMs) return cache.voices;
      const voices = await provider.list();
      cache = { at: now, voices };
      return voices;
    },
  };
}
