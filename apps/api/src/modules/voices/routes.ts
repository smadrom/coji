/**
 * Voices route (D1) — GET /v2/voices, the cached TTS voice catalog the picker on
 * /new lists. Public read (no project scope); the list is non-sensitive and the
 * same for everyone.
 *
 * The response shape (VoiceListSchema) is the locked contract in the projects
 * module schema (single source for routes + MCP); the service caches the list.
 */
import { Elysia } from 'elysia';
import { VoiceListSchema } from '../projects/schema.ts';
import { type VoicesService, createVoicesService } from './service.ts';

export function voicesRoutes(service: VoicesService = createVoicesService()) {
  return new Elysia({ name: 'voices', prefix: '/v2' }).get('/voices', () => service.list(), {
    response: VoiceListSchema,
    detail: { summary: 'List available TTS voices (cached)', tags: ['projects'] },
  });
}
