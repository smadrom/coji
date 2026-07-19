import { describe, expect, test } from 'bun:test';
import { app } from './app.ts';

describe('app', () => {
  test('GET /health returns 200 with status ok', async () => {
    const res = await app.handle(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
  });

  test('OpenAPI spec is generated and includes the health + projects routes', async () => {
    const res = await app.handle(new Request('http://localhost/openapi/json'));
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    expect(spec.paths['/health']).toBeDefined();
    // The projects module is mounted on the literal .use() chain, so its
    // TypeBox-typed routes appear in the generated spec.
    expect(spec.paths['/projects']).toBeDefined();
    expect(spec.paths['/projects/{id}']).toBeDefined();
  });
});
