import type { UsageGroup, UsageRuns, UsageTotals } from '@open-mercato/cezar-contract';

import type { RunRecord } from '../runs/store.ts';
import {
  addSample,
  emptyTotals,
  summarizeSamples,
  windowStartMs,
  type UsageSample,
} from './samples.ts';

/**
 * What cezar's OWN runs cost, across every registered project.
 *
 * The unit of attribution is the STEP, not the run: a chain routinely mixes backends (review on
 * Codex, the fix on Claude), and `run.tokensUsed` is by construction the sum of its steps
 * (`runs/store.ts`), so reading both would count every token twice. A run whose steps carry
 * nothing but which has a run-level total — an old record, or one written before the step
 * accounting existed — contributes one run-level sample instead, which is the only case where the
 * two sources are not redundant.
 *
 * Pure: the caller supplies the records and the clock. Reading them off disk without owning the
 * project is `runs/run-index.ts`'s job, and typing in a search box must not resume an agent.
 */

export interface RunsUsageProject {
  projectId: string;
  label: string;
  runs: readonly RunRecord[];
}

interface TaggedSample extends UsageSample {
  provider: string;
  projectId: string;
  projectLabel: string;
  runId: string;
}

export function collectRunsUsage(
  projects: readonly RunsUsageProject[],
  now: number,
  unreadableProjects: readonly string[] = [],
): UsageRuns {
  const samples: TaggedSample[] = [];
  for (const project of projects) {
    for (const run of project.runs) {
      samples.push(...runSamples(run, project));
    }
  }

  const summary = summarizeSamples(samples, now);
  // Groups answer "where did the last month go", so they share the daily chart's span rather than
  // inventing a fifth one.
  const floor = windowStartMs('last30d', now);
  const inSpan = samples.filter((sample) => sample.at >= floor && sample.at <= now + 60_000);

  return {
    windows: summary.windows,
    byProvider: group(inSpan, (sample) => [sample.provider, providerLabel(sample.provider)]),
    byProject: group(inSpan, (sample) => [sample.projectId, sample.projectLabel]),
    daily: summary.daily,
    unreadableProjects: [...unreadableProjects],
  };
}

function runSamples(run: RunRecord, project: RunsUsageProject): TaggedSample[] {
  const fallbackAt = timestamp(run.finishedAt) ?? timestamp(run.createdAt);
  if (fallbackAt === undefined) return [];
  const out: TaggedSample[] = [];
  for (const step of run.steps) {
    if (step.tokensUsed <= 0 && step.costUsd === undefined) continue;
    const at = timestamp(step.finishedAt) ?? timestamp(step.startedAt) ?? fallbackAt;
    out.push(
      tag(
        run,
        project,
        {
          at,
          weightedTokens: step.tokensUsed,
          inputTokens: step.inputTokens ?? 0,
          outputTokens: step.outputTokens ?? 0,
          // Steps record the weighted number and its two raw halves only; there is no per-step
          // cache split to report, and deriving one from the weighted total would be fiction.
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          ...(step.costUsd !== undefined ? { costUsd: step.costUsd } : {}),
        },
        step.backend ?? run.runner,
      ),
    );
  }
  if (out.length > 0) return out;
  if (run.tokensUsed <= 0 && run.costUsd === undefined) return [];
  return [
    tag(
      run,
      project,
      {
        at: fallbackAt,
        weightedTokens: run.tokensUsed,
        inputTokens: run.inputTokens ?? 0,
        outputTokens: run.outputTokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
      },
      run.runner,
    ),
  ];
}

function tag(
  run: RunRecord,
  project: RunsUsageProject,
  sample: UsageSample,
  provider?: string,
): TaggedSample {
  return {
    ...sample,
    provider: provider ?? 'unknown',
    projectId: project.projectId,
    projectLabel: project.label,
    runId: run.id,
  };
}

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function group(
  samples: readonly TaggedSample[],
  keyOf: (sample: TaggedSample) => [string, string],
): UsageGroup[] {
  const groups = new Map<string, { label: string; totals: UsageTotals; runs: Set<string> }>();
  for (const sample of samples) {
    const [key, label] = keyOf(sample);
    let entry = groups.get(key);
    if (!entry) groups.set(key, (entry = { label, totals: emptyTotals(), runs: new Set() }));
    addSample(entry.totals, sample);
    entry.runs.add(sample.runId);
  }
  return [...groups.entries()]
    .map(([key, entry]) => ({
      key,
      label: entry.label,
      totals: entry.totals,
      runs: entry.runs.size,
    }))
    .sort((a, b) => b.totals.tokens - a.totals.tokens);
}

/** Old records predate per-step backends, so `unknown` is a real row rather than a bug. */
function providerLabel(provider: string): string {
  if (provider === 'claude') return 'Claude Code';
  if (provider === 'codex') return 'Codex';
  if (provider === 'opencode') return 'OpenCode';
  return 'Unattributed';
}
