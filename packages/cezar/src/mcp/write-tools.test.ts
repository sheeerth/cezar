/**
 * The write tools against the REAL routes: a `createApp` cockpit behind the fake `fetch`, so a
 * body built from what a tool advertises must pass the route's own validation (spec Step 8).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import { createApp } from '../server/server.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { connectMcp, fakeCockpit, type McpTestClient } from './mcp.testkit.ts';

describe('cez mcp — write tools against the real routes', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let client: McpTestClient | undefined;
  let started: StartRunInput[];
  let finishOk: boolean;
  const calls: string[] = [];

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-mcp-write-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    started = [];
    finishOk = true;
    calls.length = 0;
    const manager = {
      startRun: (workflow: { name: string }, input: StartRunInput) => {
        started.push(input);
        return store.createRun({ title: 'started', workflow: workflow.name, task: input.task, steps: [] });
      },
      sendMessage: (id: string) => (calls.push(`message ${id}`), true),
      cancel: (id: string) => (calls.push(`cancel ${id}`), true),
      finish: (id: string) => (calls.push(`finish ${id}`), finishOk),
      continueRun: (id: string, opts: { text?: string } = {}) => (calls.push(`continue ${id} ${opts.text ?? ''}`.trim()), { ok: true }),
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** /health and /projects from the fake; every project route goes to the real app. */
  const connect = () => {
    const fake = fakeCockpit({
      routes: {},
    });
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/api/v1/p/')) return apiRequest(app, `${url.pathname}${url.search}`, init);
      return fake.fetch(input, init);
    }) as typeof fetch;
    return connectMcp({ fetch: fetchImpl, cwd: '/tmp/outside' });
  };
  const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

  it('start_run with only a task is accepted (workflow defaults to quick-task)', async () => {
    client = await connect();
    const result = await client.callTool('start_run', { task: 'fix the parser', projectId: 'default' });
    expect(result.isError, result.content[0]!.text).toBeUndefined();
    expect(parse(result)).toMatchObject({ projectId: 'default', title: 'started', status: 'queued' });
    expect(started).toHaveLength(1);
    expect(started[0]!.task).toBe('fix the parser');
  });

  it('start_run passes runner/model through and the route refuses what the contract refuses', async () => {
    client = await connect();
    expect((await client.callTool('start_run', { task: 't', projectId: 'default', runner: 'codex', model: 'gpt-x' })).isError).toBeUndefined();
    const refused = await client.callTool('start_run', { task: 't', projectId: 'default', workflow: 'no-such-workflow' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/^4\d\d: /);
  });

  it('send_run_message, continue_run, cancel_run and finish_run reach their routes', async () => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'running' });
    client = await connect();
    const id = run.id;
    expect(parse(await client.callTool('send_run_message', { projectId: 'default', runId: id, text: 'use the new parser' }))).toMatchObject({ delivered: true });
    expect(parse(await client.callTool('cancel_run', { projectId: 'default', runId: id }))).toMatchObject({ cancelled: true });
    expect(parse(await client.callTool('finish_run', { projectId: 'default', runId: id }))).toMatchObject({ finished: true });
    store.updateRun(id, { status: 'review' });
    expect((await client.callTool('continue_run', { projectId: 'default', runId: id, text: 'one more thing' })).isError).toBeUndefined();
    expect(calls).toEqual([`message ${id}`, `cancel ${id}`, `finish ${id}`, `continue ${id} one more thing`]);
  });

  it('relays a 409 from the route as isError', async () => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    finishOk = false;
    client = await connect();
    expect(await client.callTool('finish_run', { projectId: 'default', runId: run.id })).toMatchObject({
      isError: true,
      content: [{ text: '409: no open session' }],
    });
  });

  it('wait_for_runs returns the settled run from the real GET /runs/:id', async () => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'review' });
    client = await connect();
    const out = parse(await client.callTool('wait_for_runs', { runs: [{ runId: run.id, projectId: 'default' }], timeoutS: 1 }));
    expect(out).toMatchObject({ timedOut: false, runs: [{ id: run.id, status: 'review', settled: true }] });
  });
});
