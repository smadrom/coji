/**
 * AI utility routes — lightweight LLM helpers that don't belong to a specific
 * project lifecycle stage. Currently: POST /ai/parse-storyboard.
 *
 * Requires auth (same bearer guard as project routes) to prevent abuse.
 */
import { Elysia, t } from 'elysia';
import { env } from '../../env.ts';
import { makeOpenRouterStoryboardParser } from '../../providers/openrouter.ts';
import { UnauthenticatedError, requireAuth } from '../auth/context.ts';
import { ParsedSceneSchema } from '../projects/schema.ts';

const ParseStoryboardBody = t.Object({
  text: t.String({ minLength: 1 }),
});

const ParseStoryboardResponse = t.Object({
  imagePrompt: t.String(),
  scenes: t.Array(ParsedSceneSchema),
});

export function aiRoutes() {
  const parser = env.openrouterApiKey
    ? makeOpenRouterStoryboardParser({
        apiKey: env.openrouterApiKey,
        referer: env.openrouterSiteUrl,
        title: env.openrouterAppName,
      })
    : null;

  return new Elysia({ name: 'ai', prefix: '/ai' })
    .onError(({ error, set }) => {
      if (error instanceof UnauthenticatedError) {
        set.status = 401;
        return { error: (error as Error).message };
      }
      return undefined;
    })
    .post(
      '/parse-storyboard',
      async ({ body, request, set }) => {
        await requireAuth(request.headers);
        if (!parser) {
          set.status = 501;
          return { error: 'Storyboard parsing is not configured (missing OPENROUTER_API_KEY).' };
        }
        const result = await parser(body.text);
        if (!result) {
          set.status = 422;
          return { error: 'Could not parse storyboard. Check the format and try again.' };
        }
        return result;
      },
      {
        body: ParseStoryboardBody,
        detail: {
          summary: 'Parse a storyboard text into an image prompt + scene list',
          tags: ['ai'],
        },
      },
    );
}
