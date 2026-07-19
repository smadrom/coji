/**
 * D2 — VoGenerator.generate()→null ⇒ VoGenerationError (task #18).
 *
 * Tests the `ensureVoScript` behaviour (accessed via `enqueueAnimation`) using
 * an injected VoGenerator fake and a minimal chainable DB mock. No DB, no paid
 * API. Runs unconditionally in CI.
 *
 * Covers:
 *   1. TTS project with empty script + generator→null ⇒ VoGenerationError (502).
 *      No silent fallback to the raw prompt.
 *   2. TTS project with empty script + NoopVoGenerator ⇒ script is generated
 *      (non-empty string), VoGenerationError is NOT thrown.
 *   3. TTS project with an EXISTING script ⇒ generator is never called (no
 *      unnecessary LLM call on re-animate).
 *   4. audio_url project ⇒ generator is never called (VO generation is TTS-only).
 *   5. VoGenerationError has status 502.
 */
import { describe, expect, test } from 'bun:test';
import { NoopVoGenerator, type VoGenerator } from '@coji/shared/providers';
import { VoGenerationError, enqueueAnimation } from './animation-stage.ts';

// ---------------------------------------------------------------------------
// Minimal chainable DB mock.
//
// enqueueAnimation makes these calls before (and inside) ensureVoScript:
//   1. db.select().from(projects).where(...).limit(1)      → project row
//   2. db.select({id}).from(providerJobs).where(...)        → [] (no prior jobs)
//   3. db.update(projects).set(...).where(...)              → inside ensureVoScript
//      (only reached when script is empty AND generator succeeds)
//
// We only need to reach the ensureVoScript throw, so step 3 is a no-op stub.
// ---------------------------------------------------------------------------

function makeChain(result: unknown) {
  const chain: Record<string, () => unknown> = {};
  // Each method returns the chain itself so calls can be arbitrarily chained.
  const handler = new Proxy(chain, {
    get(_t, _prop) {
      return (..._args: unknown[]) => {
        // `.limit(1)` is the terminal call for selects — return the result.
        // For all other chained calls, return the proxy so chaining continues.
        if (_prop === 'limit') return result;
        return handler;
      };
    },
  });
  return handler;
}

/**
 * Build a minimal DB mock for enqueueAnimation.
 * `projectOverride` lets tests supply a custom project row.
 */
function makeDb(
  projectOverride?: Partial<{
    id: string;
    userId: string;
    status: string;
    audioMode: 'tts' | 'audio_url';
    prompt: string;
    script: string | null;
    locale: string | null;
  }>,
) {
  const project = {
    id: 'proj-1',
    userId: 'u',
    status: 'awaiting_decision',
    audioMode: 'tts' as const,
    prompt: 'A great product that changes your life.',
    script: null as string | null,
    locale: 'en-US',
    ...projectOverride,
  };

  let selectCall = 0;

  return {
    select(_fields?: unknown) {
      selectCall++;
      const callIndex = selectCall;
      // Build a chainable that resolves at .limit() or at the end of .where()
      // depending on whether it's the projects query (has .limit) or the jobs
      // query (no .limit — terminated by .where()).
      const self = {
        from(_table: unknown) {
          return self;
        },
        where(_cond: unknown) {
          // Jobs query has no .limit() — it returns [] directly.
          if (callIndex === 2) return Promise.resolve([]);
          return self;
        },
        limit(_n: number) {
          // Projects query: return the project row.
          return Promise.resolve([project]);
        },
      };
      return self;
    },
    update(_table: unknown) {
      return {
        set(_vals: unknown) {
          return {
            where(_cond: unknown) {
              // persist script update — just resolve silently
              return Promise.resolve();
            },
          };
        },
      };
    },
    // transaction is never reached in the error path tests
    async transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(this);
    },
  };
}

/** Null-returning generator — simulates LLM failure. */
const nullGenerator: VoGenerator = {
  async generate() {
    return null;
  },
};

/** Generator that returns an empty-string (also counts as null after .trim()). */
const emptyGenerator: VoGenerator = {
  async generate() {
    return '   ';
  },
};

const caller = { userId: 'u' };
const projectId = 'proj-1';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoGenerationError (D2)', () => {
  test('generator→null throws VoGenerationError (no silent prompt fallback)', async () => {
    const db = makeDb();
    await expect(
      enqueueAnimation(db, { caller, projectId, voGenerator: nullGenerator }),
    ).rejects.toBeInstanceOf(VoGenerationError);
  });

  test('generator→empty string throws VoGenerationError', async () => {
    const db = makeDb();
    await expect(
      enqueueAnimation(db, { caller, projectId, voGenerator: emptyGenerator }),
    ).rejects.toBeInstanceOf(VoGenerationError);
  });

  test('VoGenerationError has status 502', async () => {
    const db = makeDb();
    let caught: unknown;
    try {
      await enqueueAnimation(db, { caller, projectId, voGenerator: nullGenerator });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VoGenerationError);
    expect((caught as VoGenerationError).status).toBe(502);
  });

  test('NoopVoGenerator produces a non-empty script — does NOT throw', async () => {
    // After ensureVoScript succeeds the function proceeds to db.transaction
    // which tries to query frames. We let it throw a generic error there —
    // the point is that VoGenerationError is NOT thrown first.
    const db = makeDb();
    let thrown: unknown;
    try {
      await enqueueAnimation(db, { caller, projectId, voGenerator: new NoopVoGenerator() });
    } catch (e) {
      thrown = e;
    }
    // Must NOT be a VoGenerationError — anything else (e.g. from the frame
    // query inside the transaction) is acceptable.
    expect(thrown).not.toBeInstanceOf(VoGenerationError);
  });

  test('existing script is passed through — generator is never called', async () => {
    let generatorCalled = false;
    const trackingGenerator: VoGenerator = {
      async generate() {
        generatorCalled = true;
        return null;
      },
    };

    const db = makeDb({ script: 'I already have a script.' });
    // ensureVoScript short-circuits when script is non-empty → generator never
    // called → proceeds to the transaction path (which fails on frame count,
    // which is fine — we only care that no VoGenerationError is thrown and the
    // generator was not invoked).
    let thrown: unknown;
    try {
      await enqueueAnimation(db, { caller, projectId, voGenerator: trackingGenerator });
    } catch (e) {
      thrown = e;
    }
    expect(generatorCalled).toBe(false);
    expect(thrown).not.toBeInstanceOf(VoGenerationError);
  });

  test('audio_url project skips VO generation entirely', async () => {
    let generatorCalled = false;
    const trackingGenerator: VoGenerator = {
      async generate() {
        generatorCalled = true;
        return null;
      },
    };

    const db = makeDb({ audioMode: 'audio_url', script: null });
    let thrown: unknown;
    try {
      await enqueueAnimation(db, { caller, projectId, voGenerator: trackingGenerator });
    } catch (e) {
      thrown = e;
    }
    expect(generatorCalled).toBe(false);
    expect(thrown).not.toBeInstanceOf(VoGenerationError);
  });
});
