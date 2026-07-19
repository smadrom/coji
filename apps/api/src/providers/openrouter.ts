import type {
  GeneratedFrame,
  ImageGenerateOptions,
  ImageProvider,
  VoGenerator,
} from '@coji/shared/providers';
import type { ShotActionPlanner } from '../modules/projects/shot-planner.ts';
import { splitInto4 } from './image-grid.ts';
/**
 * OpenRouterImageProvider — real ImageProvider via OpenRouter (alternative to
 * the native Gemini path). Uses OpenRouter's OpenAI-compatible chat-completions
 * endpoint with `modalities: ['image','text']`; generated images come back as
 * base64 data URLs in `choices[0].message.images[].image_url.url`.
 *
 *   - call 1 produces the base frame from the prompt;
 *   - calls 2–4 feed frame 1 back as an `image_url` reference so the model keeps
 *     the same person across the 4-frame set (consistency path).
 *
 * Default model: `google/gemini-3.1-flash-image-preview` (Nano Banana 2 on
 * OpenRouter) — the same Gemini 3.1 Flash Image used by GeminiImageProvider,
 * but reached through OpenRouter (one key, unified billing, no Google Cloud).
 *
 * Auth: `OPENROUTER_API_KEY` (sent as `Authorization: Bearer <key>`).
 * Endpoint: https://openrouter.ai/api/v1/chat/completions
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL_ID = 'google/gemini-3.1-flash-image-preview';
const DEFAULT_FRAME_COUNT = 4;
const OUTPUT_MIME = 'image/png';

// --------------------------------------------------------------------------
// Minimal structural types for the OpenRouter request/response slice we use.
// --------------------------------------------------------------------------

type TextPart = { type: 'text'; text: string };
type ImageUrlPart = { type: 'image_url'; image_url: { url: string } };
type ContentPart = TextPart | ImageUrlPart;

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: ContentPart[];
}

interface OpenRouterRequest {
  model: string;
  messages: ChatMessage[];
  modalities: string[];
}

interface OpenRouterImage {
  type?: string;
  image_url?: { url?: string };
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string; images?: OpenRouterImage[] } }>;
  error?: { message?: string };
}

/** Injectable fetch (tests pass a mock; prod uses global fetch). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface OpenRouterImageProviderOptions {
  apiKey?: string;
  model?: string;
  /** Inject fetch (tests). Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Optional OpenRouter attribution headers. */
  referer?: string;
  title?: string;
}

export class OpenRouterImageProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterImageProviderError';
  }
}

/** Pull the first generated image (base64 + mime) out of the response. */
function extractImage(res: OpenRouterResponse): { base64: string; mime: string } {
  if (res.error?.message) {
    throw new OpenRouterImageProviderError(`OpenRouter error: ${res.error.message}`);
  }
  const images = res.choices?.[0]?.message?.images ?? [];
  for (const img of images) {
    const url = img.image_url?.url;
    if (typeof url === 'string') {
      // url is a data URL: data:<mime>;base64,<...>
      const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (m?.[1] && m[2] !== undefined) return { mime: m[1], base64: m[2] };
      const comma = url.indexOf(',');
      return { mime: OUTPUT_MIME, base64: comma >= 0 ? url.slice(comma + 1) : url };
    }
  }
  throw new OpenRouterImageProviderError('OpenRouter response contained no generated image');
}

export class OpenRouterImageProvider implements ImageProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly referer?: string;
  private readonly title?: string;

  constructor(opts: OpenRouterImageProviderOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new OpenRouterImageProviderError(
        'OPENROUTER_API_KEY is required for OpenRouterImageProvider.',
      );
    }
    this.apiKey = apiKey;
    this.model = opts.model ?? MODEL_ID;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.referer = opts.referer;
    this.title = opts.title;
  }

  async generate(prompt: string, opts?: ImageGenerateOptions): Promise<GeneratedFrame[]> {
    const count = opts?.frameCount ?? DEFAULT_FRAME_COUNT;
    const shots = opts?.shotPrompts ?? [];

    // ONE generation of a 2x2 grid of `count` distinct shots of the same person,
    // then crop it into `count` frames. This guarantees the same person across
    // frames (single image) AND genuinely different angles (the model composes
    // distinct panels) — and costs one provider call instead of `count`.
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: buildGridPrompt(prompt, shots, count) }] },
    ];
    const { base64 } = await this.callOnce({
      model: opts?.model ?? this.model,
      messages,
      modalities: ['image', 'text'],
    });
    const full = base64ToBytes(base64);

    let quads: Uint8Array[];
    try {
      quads = await splitInto4(full);
    } catch {
      // If the bytes aren't a decodable image (e.g. a test stub), fall back to
      // the whole image per frame so the pipeline still yields `count` frames.
      quads = Array.from({ length: count }, () => full);
    }

    const labels = opts?.shotLabels ?? [];
    return Array.from({ length: count }, (_, idx) => ({
      idx,
      bytes: quads[idx] ?? full,
      contentType: OUTPUT_MIME,
      caption: labels[idx] ?? shots[idx] ?? `Frame ${idx + 1}`,
    }));
  }

  private async callOnce(body: OpenRouterRequest): Promise<{ base64: string; mime: string }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.referer) headers['HTTP-Referer'] = this.referer;
    if (this.title) headers['X-Title'] = this.title;

    const res = await this.fetchImpl(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OpenRouterImageProviderError(
        `OpenRouter HTTP ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    const json = (await res.json()) as OpenRouterResponse;
    return extractImage(json);
  }
}

/** Decode base64 to raw bytes (Buffer is available under Bun/Node). */
function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Build the single-image grid prompt: one photo that is a 2x2 grid of `count`
 * distinct shots of the same person/scene, to be cropped into frames. Asks for
 * no captions/borders so the quadrant crop is clean.
 */
function buildGridPrompt(prompt: string, shots: string[], count: number): string {
  const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const panels = Array.from({ length: count }, (_, i) => {
    const pos = positions[i] ?? `panel ${i + 1}`;
    return `- ${pos}: ${shots[i] ?? prompt}`;
  }).join('\n');
  return `Create ONE single photorealistic image laid out as a clean 2x2 grid of ${count} separate photos of the SAME woman in the SAME room. Concept: ${prompt}.
Each of the 4 panels must be a clearly DIFFERENT camera shot — different distance, angle, height and composition — while keeping the exact same woman (same face, hair, outfit) and the same room and lighting:
${panels}
Arrange the four photos as a seamless 2x2 grid filling the whole frame, panels touching edge to edge. Absolutely NO text, NO captions, NO numbers, NO labels, NO borders or dividing lines.`;
}

// --------------------------------------------------------------------------
// Shot planner (text) — adapts each shot's ACTION to the concept/script via an
// OpenRouter chat model. Returns null (never throws) so the caller falls back
// to the fixed templates. Camera framing always comes from the templates.
// --------------------------------------------------------------------------

/** Extract a JSON array of non-empty strings from a model's text reply. */
function parseShotActions(content: string): string[] | null {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    const m = content.match(/\[[\s\S]*\]/);
    if (!m) return null;
    try {
      data = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  const arr = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? Object.values(data as Record<string, unknown>).find(Array.isArray)
      : null;
  if (!Array.isArray(arr)) return null;
  const strings = arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return strings.length > 0 ? strings : null;
}

export interface OpenRouterShotPlannerOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  referer?: string;
  title?: string;
}

export function makeOpenRouterShotPlanner(opts: OpenRouterShotPlannerOptions): ShotActionPlanner {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const model = opts.model || 'google/gemini-2.5-flash';
  return async ({ prompt, script, framings }) => {
    const system =
      "You are a UGC video-ad shot planner. Reply with ONLY a JSON array of strings — one ACTION per shot, in the given order. Each string describes the subject's action and expression for that shot (NOT the camera framing). Tell a short progression: hook, show the app on the phone, reaction, show the result. Keep the same person and setting throughout.";
    const user = `Concept: ${prompt}\n${script ? `Voiceover script:\n${script}\n` : ''}There are ${framings.length} shots, in this fixed camera order:\n${framings
      .map((f, i) => `${i + 1}. ${f}`)
      .join('\n')}\nReturn exactly ${framings.length} action strings as a JSON array.`;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      };
      if (opts.referer) headers['HTTP-Referer'] = opts.referer;
      if (opts.title) headers['X-Title'] = opts.title;
      const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') return null;
      const actions = parseShotActions(content);
      return actions && actions.length === framings.length ? actions : null;
    } catch {
      return null;
    }
  };
}

// --------------------------------------------------------------------------
// VO-script generator (D2) — produce a spoken voice-over IN THE LOCALE LANGUAGE
// from the project prompt, via the same OpenRouter chat endpoint as the shot
// planner. Returns null on any failure so the seam maps it to an explicit
// VoGenerationError (no silent fall back to reading the raw prompt aloud).
// --------------------------------------------------------------------------

export interface OpenRouterVoGeneratorOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  referer?: string;
  title?: string;
}

/** Human language name for a BCP-47 locale, used in the LLM instruction. */
const LANGUAGE_BY_LOCALE: Record<string, string> = {
  'en-US': 'English (US)',
  'ru-RU': 'Russian',
};

// --------------------------------------------------------------------------
// Storyboard parser — convert raw storyboard text (Setting + scene table) into
// an image-generation prompt + parsed scene list with suggested frame indices.
// Returns null on any failure so the caller surfaces a descriptive error.
// --------------------------------------------------------------------------

export interface ParsedSceneRaw {
  idx: number;
  time: string;
  voLine: string;
  avatarAction: string;
  suggestedFrameIdx: number;
}

export interface StoryboardParseResult {
  imagePrompt: string;
  scenes: ParsedSceneRaw[];
}

export interface OpenRouterStoryboardParserOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  referer?: string;
  title?: string;
}

export function makeOpenRouterStoryboardParser(
  opts: OpenRouterStoryboardParserOptions,
): (text: string) => Promise<StoryboardParseResult | null> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const model = opts.model || 'google/gemini-2.5-flash';
  return async (text: string) => {
    const system = `You are a video storyboard parser. Given raw storyboard text (a Setting description + a markdown table of scenes with Time, VO line, and Avatar Action columns), output a JSON object with:
1. "imagePrompt" — a detailed prompt for generating 4 portrait-style (9:16) photorealistic keyframe photos of the character. Pick the 4 most visually distinct poses/moments from the storyboard, one per panel. Include character description, setting, and concise panel descriptions labeled as [panel1], [panel2], [panel3], [panel4].
2. "scenes" — array of ALL parsed scenes, each: { "idx": 0-based integer, "time": string, "voLine": string, "avatarAction": string, "suggestedFrameIdx": 0-3 integer (which of the 4 keyframe panels fits this scene visually) }.

Return ONLY valid JSON, no markdown fences.`;
    const user = `Storyboard:\n${text}`;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      };
      if (opts.referer) headers['HTTP-Referer'] = opts.referer;
      if (opts.title) headers['X-Title'] = opts.title;
      const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') return null;
      let data: unknown;
      try {
        data = JSON.parse(content);
      } catch {
        const m = content.match(/\{[\s\S]*\}/);
        if (!m) return null;
        try {
          data = JSON.parse(m[0]);
        } catch {
          return null;
        }
      }
      if (!data || typeof data !== 'object') return null;
      const d = data as Record<string, unknown>;
      if (typeof d.imagePrompt !== 'string' || !Array.isArray(d.scenes)) return null;
      const scenes: ParsedSceneRaw[] = (d.scenes as unknown[])
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .map((s, i) => ({
          idx: typeof s.idx === 'number' ? s.idx : i,
          time: typeof s.time === 'string' ? s.time : '',
          voLine: typeof s.voLine === 'string' ? s.voLine : '',
          avatarAction: typeof s.avatarAction === 'string' ? s.avatarAction : '',
          suggestedFrameIdx:
            typeof s.suggestedFrameIdx === 'number'
              ? Math.min(3, Math.max(0, Math.floor(s.suggestedFrameIdx)))
              : i % 4,
        }));
      return { imagePrompt: d.imagePrompt, scenes };
    } catch {
      return null;
    }
  };
}

export function makeOpenRouterVoGenerator(opts: OpenRouterVoGeneratorOptions): VoGenerator {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const model = opts.model || 'google/gemini-2.5-flash';
  return {
    async generate({ prompt, locale }) {
      const language = LANGUAGE_BY_LOCALE[locale] ?? locale;
      const system = `You are a UGC video-ad scriptwriter. Write a short, natural spoken voice-over script for the product/concept below. The script MUST be written ENTIRELY in ${language}. Keep it conversational and punchy: a hook, the benefit, a call to action — 3 to 5 sentences, no stage directions, no markdown, no quotes. Reply with ONLY the script text.`;
      const user = `Concept: ${prompt}`;
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        };
        if (opts.referer) headers['HTTP-Referer'] = opts.referer;
        if (opts.title) headers['X-Title'] = opts.title;
        const res = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = json.choices?.[0]?.message?.content;
        const text = typeof content === 'string' ? content.trim() : '';
        return text.length > 0 ? text : null;
      } catch {
        return null;
      }
    },
  };
}
