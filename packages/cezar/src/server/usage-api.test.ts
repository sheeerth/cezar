import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UsageSnapshot } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { clearJsonlScanCache } from '../usage/jsonl-scan.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { createApp, type ServerDeps } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * `GET /api/v1/workspace/usage` — the route, as opposed to the readers behind it
 * (spec `2026-08-14-token-usage-monitor.md`).
 *
 * Three properties live here and nowhere else, because they are properties of the ROUTE:
 *
 *  - hosted mode serves no account rows at all — those homes are on another machine, and their
 *    paths are the host disclosure the agent-profiles family already withholds;
 *  - the read is SIDE-EFFECT FREE for a project this process does not own. `RunStore.open`
 *    `mkdir`s `<dataDir>/runs/` and building a context goes on to prune worktrees and resume
 *    interrupted runs, so the absence of that directory afterwards is the observable proof that
 *    the read went through `readRunIndexFromDisk` instead. Opening a usage panel must not restart
 *    agents;
 *  - without a socket hub there is no publisher keeping a cache warm, so every read computes.
 *
 * `CEZ_HOME` is pinned to a per-worker sandbox by `vitest.setup.ts`, so the registry writes here
 * never touch a real `~/.cezar`.
 */

const CLAUDE_REPLY = {
  type: 'assistant',
  timestamp: new Date().toISOString(),
  requestId: 'req_1',
  message: {
    id: 'msg_1',
    model: 'claude-opus-5',
    usage: { input_tokens: 100, output_tokens: 50 },
  },
};

describe('GET /api/v1/workspace/usage', () => {
  let repoRoot: string;
  let coldRoot: string;
  let claudeHome: string;
  let store: RunStore;
  const saved = {
    remote: process.env.CEZ_REMOTE,
    claude: process.env.CLAUDE_CONFIG_DIR,
    codex: process.env.CODEX_HOME,
    dryRun: process.env.CEZ_DRY_RUN,
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-usage-api-'));
    coldRoot = mkdtempSync(join(tmpdir(), 'cez-usage-cold-'));
    claudeHome = mkdtempSync(join(tmpdir(), 'cez-usage-claude-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_REMOTE;
    // Both agent homes are pinned at temp dirs: the reader must never reach the developer's own
    // `~/.claude` and turn this suite's numbers into whatever they happened to be working on.
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    process.env.CODEX_HOME = join(claudeHome, 'absent-codex');
    clearJsonlScanCache();
  });

  afterEach(() => {
    store.flush();
    for (const dir of [repoRoot, coldRoot, claudeHome]) {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const [key, value] of [
      ['CEZ_REMOTE', saved.remote],
      ['CLAUDE_CONFIG_DIR', saved.claude],
      ['CODEX_HOME', saved.codex],
      ['CEZ_DRY_RUN', saved.dryRun],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearJsonlScanCache();
  });

  const build = () => {
    const deps: ServerDeps = {
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
    };
    return createApp(deps);
  };

  const readUsage = async (app: ReturnType<typeof createApp>): Promise<UsageSnapshot> => {
    const res = await apiRequest(app, '/api/v1/workspace/usage');
    expect(res.status).toBe(200);
    return (await res.json()) as UsageSnapshot;
  };

  /** One assistant reply in the pinned Claude home, so the accounts half has something to count. */
  const writeTranscript = (): void => {
    const dir = join(claudeHome, 'projects', 'a-repo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.jsonl'), `${JSON.stringify(CLAUDE_REPLY)}\n`);
  };

  /** A finished run whose step carries the tokens — the shape the runs half attributes from. */
  const seedRun = (tokens: number): void => {
    const run = store.createRun({
      title: 'a task',
      workflow: 'quick-task',
      task: 'do the thing',
      steps: [{ id: 's1', name: 'implement', kind: 'agent' }],
    });
    store.updateStep(run.id, 's1', {
      status: 'done',
      tokensUsed: tokens,
      backend: 'claude',
      finishedAt: new Date().toISOString(),
    });
    store.flush();
  };

  it('answers with both halves, counting the account home and the runs separately', async () => {
    writeTranscript();
    seedRun(4_242);
    const body = await readUsage(build());

    const claude = body.accounts.find((account) => account.provider === 'claude');
    expect(claude?.available).toBe(true);
    expect(claude?.windows.find((w) => w.id === 'rolling5h')?.totals.tokens).toBe(150);
    expect(body.runs.windows.find((w) => w.id === 'rolling5h')?.totals.tokens).toBe(4_242);
    expect(body.runs.byProvider).toEqual([
      expect.objectContaining({ key: 'claude', runs: 1 }),
    ]);
  });

  it('reports an agent that has never run on this machine instead of omitting it', async () => {
    const body = await readUsage(build());
    const codex = body.accounts.find((account) => account.provider === 'codex');
    expect(codex?.available).toBe(false);
    expect(codex?.reason).toMatch(/no sessions/);
    // Zeroed windows, not an absent array: the cockpit renders one row shape for every account.
    expect(codex?.windows).toHaveLength(4);
  });

  it('serves no account rows in hosted mode, but still answers for the runs', async () => {
    writeTranscript();
    seedRun(10);
    process.env.CEZ_REMOTE = '1';

    const body = await readUsage(build());
    expect(body.accounts).toEqual([]);
    expect(body.runs.windows.find((w) => w.id === 'last30d')?.totals.tokens).toBe(10);
  });

  it('counts the boot project even when the registry never heard of it', async () => {
    // Registration is suppressed for task worktrees and for `$HOME` itself, and an unreadable
    // registry drops everything — but the boot store is in hand either way. Reporting zero here
    // would be wrong in exactly the setup cezar's own task worktrees run in.
    seedRun(777);
    mkdirSync(join(coldRoot, '.ai/cezar'), { recursive: true });
    await registerProject(coldRoot); // a registered project that is NOT the boot one

    const body = await readUsage(build());
    expect(body.runs.windows.find((w) => w.id === 'last30d')?.totals.tokens).toBe(777);
    expect(body.runs.byProject.map((group) => group.totals.tokens)).toEqual([777]);
  });

  it('never opens a project this process does not own', async () => {
    // A registered project with no `.ai/cezar` at all. `RunStore.open` would create `runs/` there,
    // and a built context would go on to prune worktrees and resume interrupted runs.
    mkdirSync(join(coldRoot, '.ai/cezar'), { recursive: true });
    await registerProject(repoRoot);
    await registerProject(coldRoot);

    await readUsage(build());

    expect(existsSync(join(coldRoot, '.ai/cezar/runs'))).toBe(false);
  });

  it('computes fresh on every read when no socket hub keeps a cache warm', async () => {
    const app = build();
    seedRun(100);
    expect((await readUsage(app)).runs.windows[0]?.totals.tokens).toBe(100);

    seedRun(400);
    expect((await readUsage(app)).runs.windows[0]?.totals.tokens).toBe(500);
  });

  it('degrades to zeros rather than a 500 when the workspace cannot be read', async () => {
    rmSync(repoRoot, { recursive: true, force: true });
    const body = await readUsage(build());
    expect(body.runs.windows.every((window) => window.totals.tokens === 0)).toBe(true);
  });
});
