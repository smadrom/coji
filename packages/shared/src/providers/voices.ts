/**
 * VoicesProvider seam (D1) — the catalog of TTS voices the user can pick on
 * /new. Like every paid seam it ships with a deterministic fake (the CI
 * default) so CI never calls the HeyGen voices API (hard rule #3).
 *
 * The real provider (HeyGen `GET /v2/voices`) lives in apps/api/src/providers
 * and is selected only when its env var opts in; the fake here returns the
 * curated standard voices already encoded in @coji/shared/style (VOICE_DEFAULTS)
 * so dev/test has a stable, playable list.
 */
import { GENDERS, LOCALES, VOICE_DEFAULTS } from '../style/presets.ts';

/** A TTS voice the user can pick. `id` is the provider voice id (→ projects.voice_id). */
export interface Voice {
  id: string;
  name: string;
  locale: string;
  gender?: string;
  /** Browser-loadable sample URL (audio is not Brave-blocked); may be absent. */
  previewUrl?: string;
}

export interface VoicesProvider {
  /** The available voices. Implementations should cache upstream (TTL). */
  list(): Promise<Voice[]>;
}

/** Human label for a curated default voice, keyed by its provider id. */
const DEFAULT_VOICE_NAMES: Record<string, string> = {
  '16a09e4706f74997ba4ed05ea11470f6': 'Cassidy',
  '6be73833ef9a4eb0aeee399b8fe9d62b': 'Andrew',
  '37832e32d4f7475ab7a1cb0db8e5dd66': 'Anya',
  ba1544b5eae84eae9cb92598f078b6b0: 'Oleg',
};

/**
 * The curated standard voices as a flat list (locale × gender), derived from the
 * single source of truth in @coji/shared/style so the fake list and the create
 * defaults can never drift.
 */
export const STATIC_VOICES: Voice[] = LOCALES.flatMap((locale) =>
  GENDERS.map((gender) => {
    const id = VOICE_DEFAULTS[locale][gender];
    return {
      id,
      name: DEFAULT_VOICE_NAMES[id] ?? `${locale} ${gender}`,
      locale,
      gender,
    } satisfies Voice;
  }),
);

/**
 * Deterministic VoicesProvider fake — the CI default. Returns the curated
 * standard voices; never calls a paid API.
 */
export class StaticVoicesProvider implements VoicesProvider {
  async list(): Promise<Voice[]> {
    return STATIC_VOICES;
  }
}
