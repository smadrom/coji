import { describe, expect, test } from 'bun:test';
import {
  type GeminiClient,
  type GeminiGenerateContentParams,
  type GeminiGenerateContentResponse,
  GeminiImageProvider,
  GeminiImageProviderError,
} from './gemini.ts';

const decoder = new TextDecoder();

/** base64 of a recognisable label, so we can assert decode correctness. */
function b64(label: string): string {
  return Buffer.from(label).toString('base64');
}

/**
 * Build a fake GeminiClient that records every generateContent call and
 * returns a distinct inline image per call. NO network, NO real SDK.
 */
function fakeClient(images: string[]): {
  client: GeminiClient;
  calls: GeminiGenerateContentParams[];
} {
  const calls: GeminiGenerateContentParams[] = [];
  let n = 0;
  const client: GeminiClient = {
    models: {
      async generateContent(params): Promise<GeminiGenerateContentResponse> {
        calls.push(params);
        const data = images[n++] ?? images[images.length - 1]!;
        return {
          candidates: [
            {
              content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data } }] },
            },
          ],
        };
      },
    },
  };
  return { client, calls };
}

describe('GeminiImageProvider', () => {
  test('returns 4 frames with correct idx, contentType and captions', async () => {
    const { client } = fakeClient([b64('img0'), b64('img1'), b64('img2'), b64('img3')]);
    const provider = new GeminiImageProvider({ client });

    const frames = await provider.generate('a woman in a red coat');

    expect(frames).toHaveLength(4);
    frames.forEach((frame, i) => {
      expect(frame.idx).toBe(i);
      expect(frame.contentType).toBe('image/png');
      expect(frame.caption).toBe(`Frame ${i + 1}: a woman in a red coat`);
    });
  });

  test('decodes base64 inline data to the exact bytes', async () => {
    const { client } = fakeClient([b64('hello-pixels')]);
    const provider = new GeminiImageProvider({ client });

    const [frame] = await provider.generate('x', { frameCount: 1 });
    expect(decoder.decode(frame!.bytes)).toBe('hello-pixels');
  });

  test('makes exactly one call per frame and never sets candidateCount', async () => {
    const { client, calls } = fakeClient([b64('a'), b64('b'), b64('c'), b64('d')]);
    await new GeminiImageProvider({ client }).generate('p');

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.model).toBe('gemini-3.1-flash-image');
      expect(call.config?.responseModalities).toEqual(['TEXT', 'IMAGE']);
      // candidateCount > 1 is a 400 — it must never be sent.
      expect((call.config as Record<string, unknown> | undefined)?.candidateCount).toBeUndefined();
      // personGeneration is not a documented generateContent key — omitted.
      expect(
        (call.config as Record<string, unknown> | undefined)?.personGeneration,
      ).toBeUndefined();
    }
  });

  test('feeds frame-1 back as an inlineData reference into calls 2-4', async () => {
    const frame0 = b64('FRAME-ZERO');
    const { client, calls } = fakeClient([frame0, b64('f1'), b64('f2'), b64('f3')]);
    await new GeminiImageProvider({ client }).generate('keep the same person');

    // Call 0: text only, no reference image.
    const call0Parts = calls[0]!.contents[0]!.parts;
    expect(call0Parts.some((p) => 'inlineData' in p)).toBe(false);

    // Calls 1..3: include an inlineData part whose data === frame 0's bytes.
    for (let i = 1; i < 4; i++) {
      const parts = calls[i]!.contents[0]!.parts;
      const ref = parts.find((p) => 'inlineData' in p) as
        | { inlineData: { mimeType: string; data: string } }
        | undefined;
      expect(ref).toBeDefined();
      expect(ref!.inlineData.data).toBe(frame0);
      expect(ref!.inlineData.mimeType).toBe('image/png');
    }
  });

  test('throws when the response carries no inline image', async () => {
    const client: GeminiClient = {
      models: {
        async generateContent() {
          return { candidates: [{ content: { parts: [{ text: 'no image here' }] } }] };
        },
      },
    };
    await expect(new GeminiImageProvider({ client }).generate('x')).rejects.toBeInstanceOf(
      GeminiImageProviderError,
    );
  });

  test('throws a clear error when no client and no API key are provided', () => {
    const prev = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = '';
    try {
      // Pass an explicit empty apiKey so the test never reads a real env key.
      expect(() => new GeminiImageProvider({ apiKey: '' })).toThrow(/GEMINI_API_KEY is required/);
    } finally {
      process.env.GEMINI_API_KEY = prev ?? '';
    }
  });
});
