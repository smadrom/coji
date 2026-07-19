import type { GeneratedFrame, ImageGenerateOptions, ImageProvider } from '@coji/shared/providers';
/**
 * GeminiImageProvider — real ImageProvider implementation (P1.a).
 *
 * Generates 4 same-person frames with `gemini-3.1-flash-image` via
 * `generateContent` (`responseModalities: ['TEXT','IMAGE']`):
 *   - call 1 produces the base frame from the prompt;
 *   - calls 2–4 feed frame 1 back as an `inlineData` reference part so the
 *     model keeps the same person across the set (documented consistency path).
 *
 * Facts verified in docs/api-verification.md:
 *   - SDK `@google/genai` v2.8.0; model id `gemini-3.1-flash-image` (stable).
 *   - Reference images go in `contents` as `{ inlineData: { mimeType, data } }`.
 *   - Response image bytes: `candidates[0].content.parts[].inlineData.data`
 *     (base64) — decoded here to raw bytes.
 *   - `candidateCount > 1` returns HTTP 400 → never set it.
 *   - `personGeneration` is NOT a documented config key on the generateContent
 *     path (only on the Imagen `:predict` endpoint), so it is intentionally
 *     OMITTED here. Re-add to `config` only if Google documents it for
 *     gemini-native generation.
 *   - All output carries a SynthID watermark that is non-removable per Google's
 *     responsible-AI policy; surface this as a disclosure in project metadata.
 *
 * Auth: `GEMINI_API_KEY` (the SDK sends it as the `x-goog-api-key` header).
 */
import { GoogleGenAI } from '@google/genai';

const MODEL_ID = 'gemini-3.1-flash-image';
const DEFAULT_FRAME_COUNT = 4;
const OUTPUT_MIME = 'image/png';

// --------------------------------------------------------------------------
// Minimal structural types for the slice of @google/genai we use. Declaring
// them locally lets tests inject a fake client without pulling the SDK at all.
// --------------------------------------------------------------------------

export interface GeminiInlineDataPart {
  inlineData: { mimeType: string; data: string };
}
export interface GeminiTextPart {
  text: string;
}
export type GeminiPart = GeminiInlineDataPart | GeminiTextPart | Record<string, unknown>;

export interface GeminiContent {
  role?: string;
  parts: GeminiPart[];
}

export interface GeminiGenerateContentParams {
  model: string;
  contents: GeminiContent[];
  config?: { responseModalities?: string[] };
}

export interface GeminiGenerateContentResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
}

/** The slice of the SDK surface the provider depends on (mockable in tests). */
export interface GeminiClient {
  models: {
    generateContent(params: GeminiGenerateContentParams): Promise<GeminiGenerateContentResponse>;
  };
}

export interface GeminiImageProviderOptions {
  /** Inject a client (tests). When omitted, a real GoogleGenAI client is built. */
  client?: GeminiClient;
  /** API key; defaults to GEMINI_API_KEY. Required when no client is injected. */
  apiKey?: string;
  model?: string;
}

export class GeminiImageProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiImageProviderError';
  }
}

function isInlineDataPart(part: GeminiPart): part is GeminiInlineDataPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    'inlineData' in part &&
    typeof (part as GeminiInlineDataPart).inlineData?.data === 'string'
  );
}

/** Pull the first inline image (base64) out of a generateContent response. */
function extractImageBase64(response: GeminiGenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (isInlineDataPart(part)) return part.inlineData.data;
  }
  throw new GeminiImageProviderError('Gemini response contained no inline image data');
}

export class GeminiImageProvider implements ImageProvider {
  private readonly client: GeminiClient;
  private readonly model: string;

  constructor(opts: GeminiImageProviderOptions = {}) {
    this.model = opts.model ?? MODEL_ID;
    if (opts.client) {
      this.client = opts.client;
    } else {
      const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new GeminiImageProviderError(
          'GEMINI_API_KEY is required for GeminiImageProvider (or inject a client).',
        );
      }
      // The SDK sends the key as the `x-goog-api-key` header.
      this.client = new GoogleGenAI({ apiKey }) as unknown as GeminiClient;
    }
  }

  async generate(prompt: string, opts?: ImageGenerateOptions): Promise<GeneratedFrame[]> {
    const count = opts?.frameCount ?? DEFAULT_FRAME_COUNT;
    const frames: GeneratedFrame[] = [];
    let referenceBase64: string | undefined;

    for (let idx = 0; idx < count; idx++) {
      // Frame 0 = base prompt; frames 1..n feed frame-0 back as a character
      // reference so the same person is preserved across the set.
      const contents: GeminiContent[] = [
        { role: 'user', parts: this.buildParts(prompt, idx, referenceBase64) },
      ];

      const response = await this.client.models.generateContent({
        model: this.model,
        contents,
        // NOTE: no candidateCount (>1 → HTTP 400); no personGeneration (not a
        // documented generateContent config key).
        config: { responseModalities: ['TEXT', 'IMAGE'] },
      });

      const base64 = extractImageBase64(response);
      if (idx === 0) referenceBase64 = base64;

      frames.push({
        idx,
        bytes: base64ToBytes(base64),
        contentType: OUTPUT_MIME,
        caption: this.captionFor(prompt, idx),
      });
    }

    return frames;
  }

  /** Build the parts array; frames after the first include the reference image. */
  private buildParts(
    prompt: string,
    idx: number,
    referenceBase64: string | undefined,
  ): GeminiPart[] {
    const parts: GeminiPart[] = [];
    if (idx > 0 && referenceBase64) {
      // Same person as the reference image, varied per shot.
      parts.push({ inlineData: { mimeType: OUTPUT_MIME, data: referenceBase64 } });
      parts.push({
        text: `Keep the exact same person as in the reference image. ${this.shotPrompt(prompt, idx)}`,
      });
    } else {
      parts.push({ text: this.shotPrompt(prompt, idx) });
    }
    return parts;
  }

  private shotPrompt(prompt: string, idx: number): string {
    return idx === 0 ? prompt : `${prompt} — shot ${idx + 1} of the same scene.`;
  }

  private captionFor(prompt: string, idx: number): string {
    return `Frame ${idx + 1}: ${prompt}`;
  }
}

/** Decode base64 to raw bytes (Buffer is available under Bun/Node). */
function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
