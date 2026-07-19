/**
 * Style + Locale presets — the shared vocabulary that drives a project's
 * appearance, voice, and spoken language. One source of truth for BOTH the web
 * UI (pick a style/locale) and the api (image preamble + default voice + the
 * per-frame VO split), mirroring storyboard/presets.ts.
 *
 * - `style`  → the person's LOOK (an image-prompt preamble) AND a default voice
 *   persona. Extensible: add an entry to STYLE_PRESETS.
 * - `locale` → the spoken language of the VO + the HeyGen voice language. The
 *   default voice is chosen from VOICE_DEFAULTS by `locale` + `gender`.
 *
 * `style` and `locale` are related but separate: `russian` style + `en-US`
 * locale = a Russian-looking presenter speaking English.
 */

export const STYLE_IDS = ['american', 'russian'] as const;
export type StyleId = (typeof STYLE_IDS)[number];

export const LOCALES = ['en-US', 'ru-RU'] as const;
export type Locale = (typeof LOCALES)[number];

export type Gender = 'female' | 'male';
export const GENDERS: Gender[] = ['female', 'male'];

export interface StylePreset {
  id: StyleId;
  /** Human label for the UI. */
  label: string;
  /**
   * Image-prompt preamble describing the person's look — prepended to the grid
   * prompt so the generated frames match the style (appearance/setting cues).
   */
  imagePreamble: string;
  /** Locale this style defaults to (american→en-US, russian→ru-RU). */
  defaultLocale: Locale;
  /** Default presenter gender for this style. */
  defaultGender: Gender;
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'american',
    label: 'American',
    imagePreamble:
      'an American woman with natural North-American styling, in a bright modern suburban US home',
    defaultLocale: 'en-US',
    defaultGender: 'female',
  },
  {
    id: 'russian',
    label: 'Russian',
    imagePreamble:
      'a Russian woman with Eastern-European features and styling, in a typical modern Russian apartment',
    defaultLocale: 'ru-RU',
    defaultGender: 'female',
  },
];

const STYLE_BY_ID = new Map<string, StylePreset>(STYLE_PRESETS.map((s) => [s.id, s]));

/** The fallback style (american) — guaranteed defined. */
const FALLBACK_STYLE: StylePreset =
  STYLE_PRESETS.find((s) => s.id === 'american') ?? (STYLE_PRESETS[0] as StylePreset);

export function getStylePreset(id: string): StylePreset | undefined {
  return STYLE_BY_ID.get(id);
}

/** Resolve a style id to a preset, falling back to american. */
export function resolveStyle(id: string | null | undefined): StylePreset {
  return (id != null ? STYLE_BY_ID.get(id) : undefined) ?? FALLBACK_STYLE;
}

/** The locale a style defaults to (american→en-US, russian→ru-RU). */
export function localeForStyle(id: string | null | undefined): Locale {
  return resolveStyle(id).defaultLocale;
}

function isLocale(x: string | null | undefined): x is Locale {
  return x === 'en-US' || x === 'ru-RU';
}

/** Coerce arbitrary input to a known Locale, falling back to en-US. */
export function resolveLocale(id: string | null | undefined): Locale {
  return isLocale(id) ? id : 'en-US';
}

/** Coerce arbitrary input to a known Gender, falling back to female. */
export function resolveGender(id: string | null | undefined): Gender {
  return id === 'male' ? 'male' : 'female';
}

/**
 * Default HeyGen voice_id per locale + gender. Curated from HeyGen's
 * `GET /v2/voices` catalog (standard public voices, `support_locale: true`) so
 * dev/test stays on the cheapest standard TTS tier (not premium/ElevenLabs).
 * The en-US ids are also in the key's `/v3/voices` standard set.
 */
export const VOICE_DEFAULTS: Record<Locale, Record<Gender, string>> = {
  'en-US': {
    female: '16a09e4706f74997ba4ed05ea11470f6', // Cassidy
    male: '6be73833ef9a4eb0aeee399b8fe9d62b', // Andrew
  },
  'ru-RU': {
    female: '37832e32d4f7475ab7a1cb0db8e5dd66', // Anya
    male: 'ba1544b5eae84eae9cb92598f078b6b0', // Oleg
  },
};

/** Resolve the default voice_id for a locale + gender. */
export function defaultVoiceId(
  locale: string | null | undefined,
  gender: string | null | undefined,
): string {
  return VOICE_DEFAULTS[resolveLocale(locale)][resolveGender(gender)];
}

/**
 * Split a VO script into exactly `n` non-empty lines, one per clip/frame, so
 * each HeyGen clip speaks its own segment (shorter scripts = cheaper clips).
 *
 * Strategy: prefer sentence boundaries; if there are fewer sentences than
 * frames, fall back to even word-chunks; if there are fewer words than frames,
 * cycle the words so every frame still gets a non-empty line. The returned
 * array always has length `n` with every entry non-empty when `script` is
 * non-empty (callers guard the empty case).
 */
export function splitScriptForFrames(script: string, n: number): string[] {
  const text = script.trim();
  if (n <= 0) return [];
  if (!text) return Array.from({ length: n }, () => '');

  // Primary: sentence segments.
  let segs = text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (segs.length < n) {
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    if (words.length >= n) {
      segs = chunkEven(words, n).map((w) => w.join(' '));
    } else if (words.length > 0) {
      // Fewer words than frames: cycle so every frame gets a non-empty line.
      segs = Array.from({ length: n }, (_, i) => words[i % words.length] as string);
    } else {
      segs = [text];
    }
  }

  // Distribute segments into exactly n buckets (join when there are more
  // segments than frames; pad by cycling when somehow still short).
  if (segs.length === n) return segs;
  if (segs.length > n) {
    return chunkEven(segs, n).map((g) => g.join(' '));
  }
  return Array.from({ length: n }, (_, i) => segs[i % segs.length] as string);
}

/** Split `items` into `n` contiguous, roughly-equal groups (no empty groups). */
function chunkEven<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  const len = items.length;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const remaining = len - start;
    const size = Math.ceil(remaining / (n - i));
    out.push(items.slice(start, start + size));
    start += size;
  }
  return out;
}
