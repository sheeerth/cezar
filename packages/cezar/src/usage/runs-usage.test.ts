import { describe, expect, it } from 'vitest';

import type { RunRecord, StepState } from '../runs/store.ts';
import { collectRunsUsage, type RunsUsageProject } from './runs-usage.ts';

const NOW = new Date('2026-08-14T15:00:00').getTime();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function step(overrides: Partial<StepState> = {}): StepState {
  return {
    id: 's1',
    name: 'implement',
    kind: 'agent',
    status: 'done',
    iterations: 1,
    tokensUsed: 0,
    finishedAt: iso(-60_000),
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    title: 'a task',
    workflow: 'quick-task',
    task: 'do the thing',
    status: 'done',
    steps: [],
    createdAt: iso(-120_000),
    finishedAt: iso(-60_000),
    tokensUsed: 0,
    archived: false,
    ...overrides,
  } as RunRecord;
}

const project = (projectId: string, runs: RunRecord[], label = projectId): RunsUsageProject => ({
  projectId,
  label,
  runs,
});

const windowTokens = (usage: ReturnType<typeof collectRunsUsage>, id: string) =>
  usage.windows.find((window) => window.id === id)!.totals.tokens;

describe('collectRunsUsage', () => {
  it('attributes tokens per STEP and never adds the run total on top of them', () => {
    // `run.tokensUsed` is by construction the sum of its steps — counting both doubles everything.
    const usage = collectRunsUsage(
      [
        project('alpha', [
          run({
            tokensUsed: 300,
            runner: 'claude',
            steps: [
              step({ id: 's1', tokensUsed: 100, backend: 'claude' }),
              step({ id: 's2', tokensUsed: 200, backend: 'codex' }),
            ],
          }),
        ]),
      ],
      NOW,
    );
    expect(windowTokens(usage, 'rolling5h')).toBe(300);
    expect(usage.byProvider.map((group) => [group.key, group.totals.tokens])).toEqual([
      ['codex', 200],
      ['claude', 100],
    ]);
  });

  it('falls back to the run total only when no step accounted for anything', () => {
    const usage = collectRunsUsage(
      [project('alpha', [run({ tokensUsed: 500, runner: 'codex', steps: [] })])],
      NOW,
    );
    expect(windowTokens(usage, 'today')).toBe(500);
    expect(usage.byProvider).toEqual([
      { key: 'codex', label: 'Codex', totals: expect.objectContaining({ tokens: 500 }), runs: 1 },
    ]);
  });

  it('reads a step backend over the run-level one — a chain mixes agents', () => {
    const usage = collectRunsUsage(
      [
        project('alpha', [
          run({ runner: 'claude', tokensUsed: 10, steps: [step({ tokensUsed: 10, backend: 'codex' })] }),
        ]),
      ],
      NOW,
    );
    expect(usage.byProvider[0]!.key).toBe('codex');
  });

  it('keeps records that predate per-step backends as an explicit unattributed row', () => {
    const usage = collectRunsUsage(
      [project('alpha', [run({ tokensUsed: 7, steps: [step({ tokensUsed: 7 })] })])],
      NOW,
    );
    expect(usage.byProvider).toEqual([
      { key: 'unknown', label: 'Unattributed', totals: expect.objectContaining({ tokens: 7 }), runs: 1 },
    ]);
  });

  it('groups by project and counts contributing RUNS, not steps', () => {
    const usage = collectRunsUsage(
      [
        project(
          'alpha',
          [
            run({
              id: 'r1',
              tokensUsed: 30,
              steps: [step({ id: 's1', tokensUsed: 10 }), step({ id: 's2', tokensUsed: 20 })],
            }),
            run({ id: 'r2', tokensUsed: 5, steps: [step({ tokensUsed: 5 })] }),
          ],
          'Alpha',
        ),
        project('beta', [run({ id: 'r3', tokensUsed: 100, steps: [step({ tokensUsed: 100 })] })], 'Beta'),
      ],
      NOW,
    );
    expect(usage.byProject).toEqual([
      { key: 'beta', label: 'Beta', totals: expect.objectContaining({ tokens: 100 }), runs: 1 },
      { key: 'alpha', label: 'Alpha', totals: expect.objectContaining({ tokens: 35 }), runs: 2 },
    ]);
  });

  it('dates a step by when it finished, and falls back through start to the run itself', () => {
    const usage = collectRunsUsage(
      [
        project('alpha', [
          run({
            id: 'old',
            createdAt: iso(-10 * 24 * 60 * 60_000),
            finishedAt: iso(-10 * 24 * 60 * 60_000),
            tokensUsed: 40,
            steps: [step({ tokensUsed: 40, finishedAt: undefined, startedAt: undefined })],
          }),
          run({ id: 'now', tokensUsed: 4, steps: [step({ tokensUsed: 4 })] }),
        ]),
      ],
      NOW,
    );
    expect(windowTokens(usage, 'rolling5h')).toBe(4);
    expect(windowTokens(usage, 'last30d')).toBe(44);
    expect(usage.daily.map((day) => day.date)).toEqual(['2026-08-04', '2026-08-14']);
  });

  it('sums reported cost and leaves it absent when no backend priced anything', () => {
    const priced = collectRunsUsage(
      [
        project('alpha', [
          run({
            tokensUsed: 2,
            steps: [step({ id: 's1', tokensUsed: 1, costUsd: 0.5 }), step({ id: 's2', tokensUsed: 1, costUsd: 0.25 })],
          }),
        ]),
      ],
      NOW,
    );
    const free = collectRunsUsage(
      [project('alpha', [run({ tokensUsed: 1, steps: [step({ tokensUsed: 1 })] })])],
      NOW,
    );
    expect(priced.byProject[0]!.totals.costUsd).toBe(0.75);
    expect(free.byProject[0]!.totals).not.toHaveProperty('costUsd');
  });

  it('carries the projects it could not read so the numbers are never presented as complete', () => {
    expect(collectRunsUsage([], NOW, ['gone']).unreadableProjects).toEqual(['gone']);
  });

  it('is all zeros, never a throw, for a workspace with no runs at all', () => {
    const usage = collectRunsUsage([project('alpha', [])], NOW);
    expect(usage.windows.map((window) => window.totals.tokens)).toEqual([0, 0, 0, 0]);
    expect([usage.byProvider, usage.byProject, usage.daily]).toEqual([[], [], []]);
  });
});
