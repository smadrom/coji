/**
 * Module registry (P0.7) — metadata only.
 *
 * A single, side-effect-free list of the feature modules mounted on the app and
 * the route metadata the MCP plugin consults for read-only tool exposure. Keeps
 * "what is mounted" and "what is MCP-exposed" declarative and in one place,
 * without importing route handlers (so it stays cheap to import anywhere).
 */
import type { McpRouteDef } from './mcp/plugin.ts';
import { projectsMcpRoutes } from './projects/routes.ts';

export interface ModuleInfo {
  name: string;
  description: string;
}

export const MODULES: ModuleInfo[] = [
  { name: 'projects', description: 'Project lifecycle: create + read (P0); FSM root.' },
  { name: 'jobs', description: 'Unified provider-job runner + applyJobResult writer.' },
  { name: 'credits', description: 'Credit ledger: hold → debit/refund, bounded pricing.' },
  { name: 'mcp', description: 'Read-only MCP tool exposure from TypeBox routes.' },
];

/** All route defs the MCP plugin should consider (read-only opt-in is filtered there). */
export const MCP_ROUTES: McpRouteDef[] = [...projectsMcpRoutes];
