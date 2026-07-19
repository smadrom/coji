/**
 * Drizzle schema barrel — the single source of truth for coji-owned tables.
 *
 * drizzle.config.ts and the db client both point here. Table definitions live
 * in ./tables.ts (P0.3); TypeBox request/response schemas live alongside in
 * the projects module (modules/projects/schema.ts) for routes + MCP.
 */

export * from './tables.ts';
