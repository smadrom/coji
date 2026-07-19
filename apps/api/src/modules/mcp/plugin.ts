/**
 * Minimal in-house MCP plugin (P0.7 / ADR — TypeBox is the single source).
 *
 * basalt's MCP-from-route convention: routes opt INTO MCP tool exposure by
 * setting `detail.mcp: true`, and only **read-only** (GET) routes may do so.
 * This plugin reflects those opted-in routes into a tiny MCP surface:
 *
 *   GET  /mcp/tools         → { tools: [...] }   (human/debug view)
 *   POST /mcp  {method:'tools/list'} → JSON-RPC-ish { result: { tools } }
 *
 * The tool list is derived from the same TypeBox route schemas that drive
 * validation + OpenAPI, so there is no second source of truth. Mutating routes
 * are never exposed, even if mis-tagged, because we filter to GET.
 *
 * A full MCP server (tools/call, transport) is out of P0 scope; this proves the
 * generation path and the read-only opt-in gate, which is what P0 acceptance
 * asserts.
 */
import { Elysia, t } from 'elysia';

export interface McpTool {
  name: string;
  description: string;
  method: string;
  path: string;
}

/** A route descriptor the app registers for MCP exposure. */
export interface McpRouteDef {
  method: string;
  path: string;
  summary: string;
  /** Only true + GET routes are exposed. */
  mcp?: boolean;
}

/**
 * Path prefixes that are NEVER exposed as MCP tools, even if a route is
 * mis-tagged `mcp:true` — auth + internal surfaces (task #22, basalt pattern).
 */
const MCP_DENY_PREFIXES = ['/api/auth', '/api/me', '/internal'];

function isDenied(path: string): boolean {
  return MCP_DENY_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Build the exposed tool list from route defs (read-only opt-in only). */
export function buildMcpTools(routes: McpRouteDef[]): McpTool[] {
  return routes
    .filter((r) => r.mcp === true && r.method.toUpperCase() === 'GET' && !isDenied(r.path))
    .map((r) => ({
      name: toolName(r.method, r.path),
      description: r.summary,
      method: r.method.toUpperCase(),
      path: r.path,
    }));
}

function toolName(method: string, path: string): string {
  const slug = path
    .replace(/^\//, '')
    .replace(/[:*]/g, '')
    .replace(/[/]/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '');
  return `${method.toLowerCase()}_${slug}`.replace(/_+$/, '');
}

/**
 * Mount the MCP plugin. Pass the registry of route defs (metadata only) the app
 * wants to consider for exposure. Returns an Elysia instance to `.use()`.
 */
export function mcpPlugin(routes: McpRouteDef[]) {
  const tools = buildMcpTools(routes);
  return new Elysia({ name: 'coji-mcp' })
    .get('/mcp/tools', () => ({ tools }), {
      response: t.Object({
        tools: t.Array(
          t.Object({
            name: t.String(),
            description: t.String(),
            method: t.String(),
            path: t.String(),
          }),
        ),
      }),
      detail: { summary: 'List MCP tools (read-only opted-in routes)', tags: ['mcp'] },
    })
    .post(
      '/mcp',
      ({ body }) => {
        if (body.method === 'tools/list') return { result: { tools } };
        return { error: { code: -32601, message: `Method not found: ${body.method}` } };
      },
      {
        body: t.Object({ method: t.String(), params: t.Optional(t.Unknown()) }),
        detail: { summary: 'MCP JSON-RPC endpoint (tools/list)', tags: ['mcp'] },
      },
    );
}
