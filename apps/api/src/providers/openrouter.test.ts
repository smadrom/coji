import { describe, expect, test } from 'bun:test';
import { type FetchLike, OpenRouterImageProvider } from './openrouter.ts';

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

/** A mock fetch that records requests and returns a data-URL image each call. */
function mockFetch(): { fetchImpl: FetchLike; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: '',
              images: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
              ],
            },
          },
        ],
      }),
      text: async () => '',
    };
  };
  return { fetchImpl, calls };
}

describe('OpenRouterImageProvider', () => {
  test('generates 4 frames with correct idx/contentType/caption', async () => {
    const { fetchImpl } = mockFetch();
    const p = new OpenRouterImageProvider({ apiKey: 'sk-test', fetchImpl });
    const frames = await p.generate('woman in a kitchen', {
      shotLabels: ['Wide', 'Medium', 'Close-up', 'Over the shoulder'],
    });
    expect(frames).toHaveLength(4);
    frames.forEach((f, i) => {
      expect(f.idx).toBe(i);
      expect(f.contentType).toBe('image/png');
      expect(Buffer.from(f.bytes).toString()).toBe('fake-png-bytes');
    });
    // Caption is the short per-frame label.
    expect(frames.map((f) => f.caption)).toEqual([
      'Wide',
      'Medium',
      'Close-up',
      'Over the shoulder',
    ]);
  });

  test('sends the configured model + image+text modalities', async () => {
    const { fetchImpl, calls } = mockFetch();
    const p = new OpenRouterImageProvider({ apiKey: 'sk-test', fetchImpl });
    await p.generate('x', { frameCount: 1 });
    const body = calls[0]?.body as { model: string; modalities: string[] };
    expect(body.model).toBe('google/gemini-3.1-flash-image-preview');
    expect(body.modalities).toEqual(['image', 'text']);
  });

  test('makes ONE grid generation and crops it into 4 frames', async () => {
    const { fetchImpl, calls } = mockFetch();
    const p = new OpenRouterImageProvider({ apiKey: 'sk-test', fetchImpl });
    const frames = await p.generate('x');
    // Single call (the 2x2 grid), not one-per-frame.
    expect(calls.length).toBe(1);
    expect(frames).toHaveLength(4);
    const body = calls[0]?.body as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const text = body.messages[0]?.content.find((c) => c.type === 'text')?.text ?? '';
    expect(text).toContain('2x2');
    // No reference image is fed back any more.
    expect(body.messages[0]?.content.some((c) => c.type === 'image_url')).toBe(false);
  });

  test('throws a clear error when no API key', () => {
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = '';
    try {
      expect(() => new OpenRouterImageProvider()).toThrow(/OPENROUTER_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
    }
  });

  test('throws on non-ok HTTP', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => 'rate limited',
    });
    const p = new OpenRouterImageProvider({ apiKey: 'sk-test', fetchImpl });
    await expect(p.generate('x', { frameCount: 1 })).rejects.toThrow(/429/);
  });

  test('throws when response has no image', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'no image', images: [] } }] }),
      text: async () => '',
    });
    const p = new OpenRouterImageProvider({ apiKey: 'sk-test', fetchImpl });
    await expect(p.generate('x', { frameCount: 1 })).rejects.toThrow(/no generated image/);
  });
});
