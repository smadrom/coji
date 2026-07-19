/**
 * VoGenerator seam (D2) — turn a project's prompt into a spoken voice-over
 * script IN THE PROJECT'S LOCALE LANGUAGE, used when the user left the script
 * empty. Without this the pipeline read the raw prompt aloud (often the wrong
 * language and not script-shaped); the animate stage now generates a proper VO
 * instead, and surfaces a failure explicitly rather than silently degrading.
 *
 * Like every paid seam it ships with a deterministic fake (the CI default) so CI
 * never calls a paid LLM (hard rule #3). The real impl (OpenRouter, like the shot
 * planner) lives in apps/api and is selected only when its env var opts in.
 */

export interface VoGenerateInput {
  /** The project concept/prompt the VO should pitch. */
  prompt: string;
  /** BCP-47 locale (e.g. 'en-US', 'ru-RU') — the VO must be IN THIS LANGUAGE. */
  locale: string;
}

export interface VoGenerator {
  /**
   * Produce a spoken VO script for `prompt` in `locale`. Returns null to signal
   * "could not generate" (the caller decides how to surface it) — must not throw
   * for control flow.
   */
  generate(input: VoGenerateInput): Promise<string | null>;
}

/** A short, deterministic English VO template for the fake (default). */
const fakeEnUs = (p: string): string =>
  `Meet your new favorite thing: ${p}. It is simple, it just works, and you are going to love it. Try it today and see the difference for yourself.`;

/** Locale → a short, deterministic VO template for the fake. */
const FAKE_VO_BY_LOCALE: Record<string, (prompt: string) => string> = {
  'en-US': fakeEnUs,
  'ru-RU': (p) =>
    `Познакомьтесь с тем, что вам понравится: ${p}. Это просто, это работает, и вы будете в восторге. Попробуйте уже сегодня и увидите разницу сами.`,
};

/**
 * Deterministic VoGenerator fake — the CI default. Returns a stable VO in the
 * requested locale (falling back to the en-US template for unknown locales) so
 * tests exercise the generated-VO path without a paid LLM.
 */
export class NoopVoGenerator implements VoGenerator {
  async generate({ prompt, locale }: VoGenerateInput): Promise<string | null> {
    const make = FAKE_VO_BY_LOCALE[locale] ?? fakeEnUs;
    return make(prompt.trim());
  }
}
