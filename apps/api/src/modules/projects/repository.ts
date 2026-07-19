/**
 * ProjectsRepository implementations (P0.7).
 *
 * - `createDbProjectsRepository`: Drizzle-backed (production).
 * - `createInMemoryProjectsRepository`: a deterministic fake for `app.handle`
 *   acceptance tests so the create+read round-trip and ownership rejection run
 *   CI-green with zero DB.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.ts';
import { frames, projects } from '../../db/tables.ts';
import { signedUrlFor } from '../files/signed-url.ts';
import type { ProjectListItemDto } from './schema.ts';
import {
  type CreateProjectInput,
  type ProjectRecord,
  type ProjectsRepository,
  resolveProjectDefaults,
} from './service.ts';

// biome-ignore lint/suspicious/noExplicitAny: structural surface over Drizzle's db (its generics are version-fragile)
type AnyDb = any;

function rowToRecord(row: typeof projects.$inferSelect): ProjectRecord {
  return {
    id: row.id,
    userId: row.userId,
    prompt: row.prompt,
    status: row.status,
    audioMode: row.audioMode,
    script: row.script,
    voiceId: row.voiceId,
    audioUrl: row.audioUrl,
    style: row.style,
    locale: row.locale,
    gender: row.gender,
    creditsSpent: row.creditsSpent,
    renderAttempt: row.renderAttempt,
    autoTrimmed: row.autoTrimmed,
    storyboardScenes: row.storyboardScenes ?? null,
    quality: row.quality,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createDbProjectsRepository(db: AnyDb = defaultDb): ProjectsRepository {
  return {
    async create(input: CreateProjectInput): Promise<ProjectRecord> {
      const defaults = resolveProjectDefaults(input);
      const [row] = await db
        .insert(projects)
        .values({
          userId: input.userId,
          prompt: input.prompt,
          audioMode: input.audioMode ?? 'tts',
          script: input.script ?? null,
          // voiceId resolved from locale+gender unless the caller picked one.
          voiceId: defaults.voiceId,
          audioUrl: input.audioUrl ?? null,
          style: defaults.style,
          locale: defaults.locale,
          gender: defaults.gender,
          shotConfig: input.storyboard ?? null,
          storyboardScenes: input.storyboardScenes ?? null,
          quality: input.quality ?? 'max',
        })
        .returning();
      return rowToRecord(row);
    },

    async findById(id: string): Promise<ProjectRecord | null> {
      const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      return rows[0] ? rowToRecord(rows[0]) : null;
    },

    async listOwned(userId: string): Promise<ProjectListItemDto[]> {
      // Owner's projects, newest first (the ownership guard is this filter).
      const rows = await db
        .select({
          id: projects.id,
          status: projects.status,
          prompt: projects.prompt,
          createdAt: projects.createdAt,
          creditsSpent: projects.creditsSpent,
        })
        .from(projects)
        .where(eq(projects.userId, userId))
        .orderBy(desc(projects.createdAt));
      if (rows.length === 0) return [];

      // First stored frame per project (lowest idx with a non-null image_ref),
      // signed into a browser-loadable preview URL. One extra query, then map.
      const ids = rows.map((r: { id: string }) => r.id);
      const frameRows = await db
        .select({ projectId: frames.projectId, idx: frames.idx, imageRef: frames.imageRef })
        .from(frames)
        .where(and(inArray(frames.projectId, ids), isNotNull(frames.imageRef)))
        .orderBy(asc(frames.idx));
      const firstRef = new Map<string, string>();
      for (const f of frameRows as { projectId: string; imageRef: string | null }[]) {
        if (f.imageRef && !firstRef.has(f.projectId)) firstRef.set(f.projectId, f.imageRef);
      }

      return Promise.all(
        rows.map(
          async (r: {
            id: string;
            status: ProjectRecord['status'];
            prompt: string;
            createdAt: Date;
            creditsSpent: number;
          }) => {
            const ref = firstRef.get(r.id);
            return {
              id: r.id,
              status: r.status,
              prompt: r.prompt,
              createdAt: r.createdAt.toISOString(),
              creditsSpent: r.creditsSpent,
              // Provider-aware: local-fs → /files HMAC, s3/R2 → presigned URL.
              previewUrl: ref ? await signedUrlFor(ref) : null,
            };
          },
        ),
      );
    },
  };
}

/** In-memory fake — same contract, no DB. Used by the HTTP acceptance tests. */
export function createInMemoryProjectsRepository(): ProjectsRepository {
  const store = new Map<string, ProjectRecord>();
  return {
    async create(input: CreateProjectInput): Promise<ProjectRecord> {
      const now = new Date();
      const defaults = resolveProjectDefaults(input);
      const record: ProjectRecord = {
        id: randomUUID(),
        userId: input.userId,
        prompt: input.prompt,
        status: 'draft',
        audioMode: input.audioMode ?? 'tts',
        script: input.script ?? null,
        voiceId: defaults.voiceId,
        audioUrl: input.audioUrl ?? null,
        style: defaults.style,
        locale: defaults.locale,
        gender: defaults.gender,
        creditsSpent: 0,
        renderAttempt: 0,
        autoTrimmed: false,
        quality: input.quality ?? 'max',
        createdAt: now,
        updatedAt: now,
      };
      store.set(record.id, record);
      return record;
    },

    async findById(id: string): Promise<ProjectRecord | null> {
      return store.get(id) ?? null;
    },

    async listOwned(userId: string): Promise<ProjectListItemDto[]> {
      return [...store.values()]
        .filter((r) => r.userId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((r) => ({
          id: r.id,
          status: r.status,
          prompt: r.prompt,
          createdAt: r.createdAt.toISOString(),
          creditsSpent: r.creditsSpent,
          // No frame store in the fake → no preview yet.
          previewUrl: null,
        }));
    },
  };
}
