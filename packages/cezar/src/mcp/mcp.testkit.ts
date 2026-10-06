/**
 * Test seams for `cez mcp`: a fake cockpit (a `fetch` over a route table) and an in-memory MCP
 * client speaking raw JSON-RPC to `runMcpCommand`, the same opening a 2025-era stdio client sends.
 */
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { runMcpCommand, type McpEnv } from './index.ts';

export type FakeRoute = (init: RequestInit & { url: URL }) => { status?: number; body?: unknown; text?: string } | Promise<{ status?: number; body?: unknown; text?: string }>;

export interface FakeCockpitOptions {
  /** Ports that answer at all (default 4321); every other port refuses the connection. */
  ports?: number[];
  /** `"GET /api/v1/runs/x"` → handler; matched on method + pathname (+ search when present). */
  routes?: Record<string, FakeRoute>;
  /** Per-port overrides for /api/v1/health, e.g. a non-cezar responder. */
  health?: Record<number, unknown>;
}

export const HEALTH = { version: '0.0.0-test', bootProject: 'boot', repoRoot: '/repos/boot' };

export function project(id: string, root: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, root, addedAt: '2026-10-06T00:00:00Z', lastOpenedAt: '2026-10-06T00:00:00Z', source: 'local', status: 'ok', ...extra };
}

export const PROJECTS = {
  projects: [project('boot', '/repos/boot'), project('api', '/repos/api', { tags: ['backend'] })],
  bootProject: 'boot',
  projectsDir: '/repos',
};

export function fakeCockpit(options: FakeCockpitOptions = {}) {
  const ports = new Set(options.ports ?? [4321]);
  const calls: string[] = [];
  const routes: Record<string, FakeRoute> = {
    'GET /api/v1/projects': () => ({ body: PROJECTS }),
    ...options.routes,
  };
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const port = Number(url.port);
    if (!ports.has(port)) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (url.pathname === '/api/v1/health') {
      const body = options.health?.[port] ?? HEALTH;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const handler = routes[`${method} ${url.pathname}${url.search}`] ?? routes[`${method} ${url.pathname}`];
    if (!handler) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const out = await handler({ ...init, url });
    if (out.text !== undefined) return new Response(out.text, { status: out.status ?? 200 });
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpTestClient {
  request: (method: string, params?: Record<string, unknown>) => Promise<JsonRpcResponse>;
  listTools: () => Promise<Array<{ name: string; annotations?: Record<string, unknown>; inputSchema: Record<string, unknown> }>>;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>;
  close: () => Promise<void>;
  errors: string[];
}

export async function connectMcp(options: { args?: string[]; env?: McpEnv; fetch: typeof fetch; cwd?: string }): Promise<McpTestClient> {
  const [client, server] = InMemoryTransport.createLinkedPair();
  const errors: string[] = [];
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let nextId = 1;
  client.onmessage = (message) => {
    const response = message as JsonRpcResponse;
    if (typeof response.id === 'number') pending.get(response.id)?.(response);
  };
  await client.start();
  const code = await runMcpCommand(
    options.args ?? [],
    options.env ?? {},
    { log: () => undefined, error: (line) => errors.push(line), transport: server, fetch: options.fetch, cwd: options.cwd ?? '/repos/boot' },
    '0.0.0-test',
  );
  if (code !== 0) throw new Error(`runMcpCommand exited ${code}: ${errors.join('\n')}`);

  const request = (method: string, params?: Record<string, unknown>) =>
    new Promise<JsonRpcResponse>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      void client.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } as never);
    });

  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);

  return {
    request,
    errors,
    async listTools() {
      const response = await request('tools/list');
      return (response.result?.tools ?? []) as never;
    },
    async callTool(name, args = {}) {
      const response = await request('tools/call', { name, arguments: args });
      if (response.error) throw new Error(`tools/call ${name}: ${response.error.message}`);
      return response.result as unknown as ToolCallResult;
    },
    close: () => client.close(),
  };
}
