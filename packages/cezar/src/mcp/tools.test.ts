import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_TOOLS, READ_TOOLS, RESULT_CHAR_CAP, conversationItem } from './tools.ts';
import { connectMcp, fakeCockpit, type McpTestClient } from './mcp.testkit.ts';

const RUN = {
  id: 'r1',
  title: 'Fix the parser',
  workflow: 'quick-task',
  task: 'fix it',
  status: 'waiting',
  createdAt: '2026-10-06T10:00:00Z',
  tokensUsed: 1234,
  costUsd: 0.42,
  branch: 'cez/r1',
  currentStepId: 'task',
  steps: [],
};

let client: McpTestClient | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

const readNames = READ_TOOLS.map((t) => t.name).sort();
const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text) as Record<string, unknown>;

describe('cez mcp — the tool surface', () => {
  it('declares readOnlyHint and destructiveHint on every tool it serves', async () => {
    client = await connectMcp({ fetch: fakeCockpit().fetch });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS.map((t) => t.name).sort());
    for (const t of tools) {
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe('boolean');
      expect(typeof t.annotations?.destructiveHint, t.name).toBe('boolean');
    }
  });

  it('marks exactly the read tools read-only', async () => {
    client = await connectMcp({ fetch: fakeCockpit().fetch });
    const tools = await client.listTools();
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(readNames);
  });

  it('keeps answering tools/list with no cockpit, and each call says how to fix it', async () => {
    client = await connectMcp({ fetch: fakeCockpit({ ports: [] }).fetch });
    expect((await client.listTools()).length).toBeGreaterThan(0);
    const result = await client.callTool('list_projects');
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no cezar cockpit found on 127\.0\.0\.1:4321–4370 — start it with `cez serve`/);
  });

  it('turns a route refusal into isError with the route’s own message', async () => {
    client = await connectMcp({ fetch: fakeCockpit({ routes: { 'GET /api/v1/p/boot/runs/zz': () => ({ status: 404, body: { error: 'not found' } }) } }).fetch });
    const result = await client.callTool('get_run', { runId: 'zz' });
    expect(result).toMatchObject({ isError: true, content: [{ text: '404: not found' }] });
  });
});

describe('cez mcp — read tools', () => {
  it('list_projects marks the cwd’s project as current', async () => {
    client = await connectMcp({ fetch: fakeCockpit().fetch, cwd: '/repos/api/src' });
    const out = parse(await client.callTool('list_projects'));
    expect(out.projects).toEqual([
      { id: 'boot', name: 'boot', status: 'ok', current: false, boot: true },
      { id: 'api', name: 'api', status: 'ok', tags: ['backend'], current: true, boot: false },
    ]);
  });

  it('get_run targets the cwd’s project and projects real fields plus settled/needsAnswer', async () => {
    const fake = fakeCockpit({ routes: { 'GET /api/v1/p/api/runs/r1': () => ({ body: RUN }) } });
    client = await connectMcp({ fetch: fake.fetch, cwd: '/repos/api' });
    const result = await client.callTool('get_run', { runId: 'r1' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      projectId: 'api',
      id: 'r1',
      title: 'Fix the parser',
      status: 'waiting',
      settled: true,
      needsAnswer: true,
      workflow: 'quick-task',
      currentStepId: 'task',
      branch: 'cez/r1',
      tokensUsed: 1234,
      costUsd: 0.42,
      createdAt: '2026-10-06T10:00:00Z',
    });
  });

  it('falls back to the boot project outside every registered project; an explicit projectId wins', async () => {
    const fake = fakeCockpit({
      routes: {
        'GET /api/v1/p/boot/runs/r1': () => ({ body: RUN }),
        'GET /api/v1/p/api/runs/r1': () => ({ body: { ...RUN, status: 'running' } }),
      },
    });
    client = await connectMcp({ fetch: fake.fetch, cwd: '/tmp/elsewhere' });
    expect(parse(await client.callTool('get_run', { runId: 'r1' })).projectId).toBe('boot');
    expect(parse(await client.callTool('get_run', { runId: 'r1', projectId: 'api' }))).toMatchObject({ projectId: 'api', settled: false });
  });

  it('list_runs filters to the project, hides archived runs and carries truncated', async () => {
    const fake = fakeCockpit({
      routes: {
        'GET /api/v1/workspace/runs-index': () => ({
          body: {
            runs: [
              { projectId: 'boot', id: 'a', title: 'A', status: 'running', archived: false, createdAt: 't1', workflow: 'w' },
              { projectId: 'boot', id: 'b', title: 'B', status: 'done', archived: true, createdAt: 't0', workflow: 'w' },
              { projectId: 'api', id: 'c', title: 'C', status: 'review', archived: false, createdAt: 't2', workflow: 'w' },
            ],
            referenceStatuses: {},
            perProjectLimit: 2,
            truncated: ['boot'],
          },
        }),
      },
    });
    client = await connectMcp({ fetch: fake.fetch });
    expect(parse(await client.callTool('list_runs'))).toEqual({
      projectId: 'boot',
      runs: [{ id: 'a', title: 'A', status: 'running', createdAt: 't1' }],
      truncated: true,
    });
    const withArchived = parse(await client.callTool('list_runs', { includeArchived: true, status: ['done'] }));
    expect((withArchived.runs as Array<{ id: string }>).map((r) => r.id)).toEqual(['b']);
  });

  it('list_workflows returns names start_run accepts', async () => {
    const fake = fakeCockpit({
      routes: {
        'GET /api/v1/p/boot/workflows': () => ({
          body: { workflows: [{ name: 'quick-task', description: 'one step', steps: [], source: 'built-in' }], issues: [] },
        }),
      },
    });
    client = await connectMcp({ fetch: fake.fetch });
    expect(parse(await client.callTool('list_workflows'))).toEqual({
      projectId: 'boot',
      workflows: [{ name: 'quick-task', description: 'one step', source: 'built-in' }],
    });
  });

  it('get_run_messages returns the newest conversation items, oldest first, across pages', async () => {
    const ev = (seq: number, type: string, extra: Record<string, unknown> = {}) => ({ seq, ts: `t${seq}`, type, ...extra });
    const fake = fakeCockpit({
      routes: {
        'GET /api/v1/p/boot/runs/r1/history': () => ({
          body: {
            events: [ev(10, 'text', { text: 'looking' }), ev(11, 'token-usage'), ev(12, 'tool-call', { tool: 'Bash', input: { command: 'npm   test' } }), ev(13, 'text', { text: 'which parser?' })],
            itemCount: 4,
            olderCursor: 'older-1',
            liveCursor: 'live',
            asOfSeq: 13,
            hasOlder: true,
          },
        }),
        'GET /api/v1/p/boot/runs/r1/history?cursor=older-1': () => ({
          body: { events: [ev(1, 'user-message', { text: 'fix it' }), ev(2, 'item.completed', { item: {} })], itemCount: 2, liveCursor: 'live', asOfSeq: 13, hasOlder: false },
        }),
      },
    });
    client = await connectMcp({ fetch: fake.fetch });
    const out = parse(await client.callTool('get_run_messages', { runId: 'r1', limit: 4 }));
    expect(out.asOfSeq).toBe(13);
    expect(out.items).toEqual([
      { seq: 1, ts: 't1', role: 'user', text: 'fix it' },
      { seq: 10, ts: 't10', role: 'assistant', text: 'looking' },
      { seq: 12, ts: 't12', role: 'tool', summary: 'Bash: {"command":"npm test"}' },
      { seq: 13, ts: 't13', role: 'assistant', text: 'which parser?' },
    ]);
  });

  it('get_diff narrows to one file, drops patches on request, and omits patches past the cap', async () => {
    const file = (path: string, patch: string) => ({ path, status: 'modified', adds: 1, dels: 0, binary: false, patch });
    const big = 'x'.repeat(30_000);
    const fake = fakeCockpit({
      routes: {
        'GET /api/v1/p/boot/runs/r1/changes': () => ({
          body: { files: [file('a.ts', big), file('b.ts', big), file('c.ts', '+c')], stat: { adds: 3, dels: 0, files: 3 } },
        }),
      },
    });
    client = await connectMcp({ fetch: fake.fetch });
    const one = parse(await client.callTool('get_diff', { runId: 'r1', path: 'c.ts' }));
    expect(one.files).toEqual([{ path: 'c.ts', status: 'modified', adds: 1, dels: 0, patch: '+c' }]);
    const stat = parse(await client.callTool('get_diff', { runId: 'r1', patches: false }));
    expect((stat.files as Array<Record<string, unknown>>).every((f) => !('patch' in f))).toBe(true);
    const all = await client.callTool('get_diff', { runId: 'r1' });
    expect(all.content[0]!.text.length).toBeLessThanOrEqual(RESULT_CHAR_CAP);
    const parsed = parse(all);
    expect(parsed.truncated).toBe(true);
    expect((parsed.files as Array<Record<string, unknown>>).find((f) => f.path === 'b.ts')).toMatchObject({ patchOmitted: true });
    const missing = await client.callTool('get_diff', { runId: 'r1', path: 'nope.ts' });
    expect(missing).toMatchObject({ isError: true, content: [{ text: 'no change to nope.ts in run r1' }] });
  });
});

describe('cez mcp — conversationItem', () => {
  it('skips bookkeeping and v2 twins so nothing is counted twice', () => {
    for (const type of ['token-usage', 'item.started', 'item.completed', 'turn-end', 'lifecycle']) {
      expect(conversationItem({ seq: 1, ts: 't', type }), type).toBeUndefined();
    }
    expect(conversationItem({ seq: 1, ts: 't', type: 'text', text: '   ' })).toBeUndefined();
  });

  it('surfaces questions and errors', () => {
    expect(conversationItem({ seq: 1, ts: 't', type: 'ask.requested', questions: [{ question: 'Which?' }] })).toEqual({
      seq: 1,
      ts: 't',
      role: 'question',
      questions: [{ question: 'Which?' }],
    });
    expect(conversationItem({ seq: 2, ts: 't', type: 'session.error', message: 'boom' })).toMatchObject({ role: 'error', text: 'boom' });
  });
});

describe('cez mcp — the in-task restriction', () => {
  const served = async (options: Parameters<typeof connectMcp>[0]) => {
    client = await connectMcp(options);
    const names = (await client.listTools()).map((t) => t.name).sort();
    await client.close();
    client = undefined;
    return names;
  };

  it('serves only the read tools when CEZ_TASK_ID is set', async () => {
    expect(await served({ fetch: fakeCockpit().fetch, env: { CEZ_TASK_ID: 'run-1' } })).toEqual(readNames);
  });

  it('serves only the read tools inside a task worktree, even with the env stripped', async () => {
    expect(await served({ fetch: fakeCockpit().fetch, cwd: '/repos/boot/.ai/cezar/worktrees/run-1' })).toEqual(readNames);
  });

  it('serves only the read tools with --read-only', async () => {
    expect(await served({ fetch: fakeCockpit().fetch, args: ['--read-only'] })).toEqual(readNames);
  });

  it('serves only the read tools in a task even when dispatch is off (no CEZ_API_URL)', async () => {
    expect(await served({ fetch: fakeCockpit().fetch, env: { CEZ_TASK_ID: 'run-1', CEZ_API_URL: undefined } })).toEqual(readNames);
  });
});

describe('cez mcp — load-path isolation', () => {
  it('imports the MCP SDK only from src/mcp/ (cez serve never loads it)', () => {
    const src = join(import.meta.dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== 'node_modules') walk(path);
        } else if (/\.ts$/.test(name) && !relative(src, path).startsWith(`mcp`)) {
          if (/from ['"]@modelcontextprotocol\//.test(readFileSync(path, 'utf8'))) offenders.push(relative(src, path));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });

  it('reaches src/mcp/ from index.ts through a dynamic import only', () => {
    const index = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8');
    expect(index).toMatch(/await import\('\.\/mcp\/index\.ts'\)/);
    expect(index).not.toMatch(/^import .*['"]\.\/mcp\//m);
  });
});
