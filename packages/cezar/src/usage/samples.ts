import type {
  UsageDay,
  UsageModel,
  UsageTotals,
  UsageWindow,
  UsageWindowId,
} from '@open-mercato/cezar-contract';

import { CACHE_CREATION_WEIGHT, CACHE_READ_WEIGHT } from '../core/usage.ts';

/**
 * The shared arithmetic behind `GET /workspace/usage` — pure, no filesystem, no clock of its own.
 *
 * Every source (Claude transcripts, Codex rollout logs, cezar's own run records) is reduced to the
 * SAME `UsageSample`, and this module is the only place that turns samples into windows, days and
 * per-model rows. Three readers producing three subtly different notions of "today" is exactly how
 * a usage screen ends up disagreeing with itself, so they do not get to have one.
 */

export interface UsageSample {
  /** Epoch ms the tokens were billed at. */
  at: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Real money the backend reported. Never derived from token counts. */
  costUsd?: number;
  model?: string;
  /**
   * Identity for cross-file de-duplication, when the source has one.
   *
   * Load-bearing for Claude: one assistant reply is written to the transcript once per stream
   * chunk (measured: 69 usage lines carrying 28 distinct replies), and a `--resume` copies earlier
   * replies into the new session's file. Summing lines instead of replies overstates usage by
   * roughly a factor of two.
   */
  key?: string;
  /**
   * Pre-weighted token count, when the source already carries cezar's weighted number (run
   * records do — `step.tokensUsed`). Absent means "weight the raw components here", which is what
   * every transcript reader wants.
   */
  weightedTokens?: number;
}

/** The window ids in the order every surface renders them. */
export const USAGE_WINDOW_IDS: readonly UsageWindowId[] = [
  'rolling5h',
  'today',
  'last7d',
  'last30d',
];

/** Claude and Codex both bill subscriptions in a rolling five-hour session window. */
export const ROLLING_WINDOW_MS = 5 * 60 * 60_000;

/** How far back any reader is asked to look. Also the daily chart's span. */
export const USAGE_RETENTION_DAYS = 30;

export function emptyTotals(): UsageTotals {
  return { tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Cost-weight a sample the way `src/core/usage.ts` weights a raw usage record. */
export function weighSample(sample: UsageSample): number {
  if (sample.weightedTokens !== undefined) return sample.weightedTokens;
  return Math.round(
    sample.inputTokens +
      sample.outputTokens +
      sample.cacheWriteTokens * CACHE_CREATION_WEIGHT +
      sample.cacheReadTokens * CACHE_READ_WEIGHT,
  );
}

/** Fold one sample into a running total. Mutates `totals` — it is always a local accumulator. */
export function addSample(totals: UsageTotals, sample: UsageSample): void {
  totals.tokens += weighSample(sample);
  totals.inputTokens += sample.inputTokens;
  totals.outputTokens += sample.outputTokens;
  totals.cacheReadTokens += sample.cacheReadTokens;
  totals.cacheWriteTokens += sample.cacheWriteTokens;
  // `costUsd` stays ABSENT until some sample carries one: an optional key means "no backend
  // priced this", which reads differently from a confident `$0.00`.
  if (sample.costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + sample.costUsd;
}

/**
 * Start of a window, in epoch ms.
 *
 * The calendar spans anchor on LOCAL midnight because that is the boundary the person reading the
 * screen lives on; `rolling5h` is the only one that floats with the clock.
 */
export function windowStartMs(id: UsageWindowId, now: number): number {
  if (id === 'rolling5h') return now - ROLLING_WINDOW_MS;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (id === 'today') return midnight.getTime();
  const days = id === 'last7d' ? 6 : USAGE_RETENTION_DAYS - 1;
  midnight.setDate(midnight.getDate() - days);
  return midnight.getTime();
}

/** The oldest instant any reader needs to keep. */
export function retentionStartMs(now: number): number {
  return Math.min(windowStartMs('last30d', now), windowStartMs('rolling5h', now));
}

/** `YYYY-MM-DD` in LOCAL time — `toISOString` would bucket a late-evening run into tomorrow. */
export function localDateKey(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface UsageSummary {
  windows: UsageWindow[];
  daily: UsageDay[];
  models: UsageModel[];
}

/**
 * Reduce samples to the shape the wire carries.
 *
 * De-duplicates on `key` (first occurrence wins), drops anything older than the retention floor or
 * dated in the future, and leaves `daily` oldest-first and `models` biggest-first.
 */
export function summarizeSamples(samples: readonly UsageSample[], now: number): UsageSummary {
  const floor = retentionStartMs(now);
  const windows = USAGE_WINDOW_IDS.map((id) => ({
    id,
    start: windowStartMs(id, now),
    totals: emptyTotals(),
  }));
  const daily = new Map<string, UsageTotals>();
  const models = new Map<string, UsageTotals>();
  const seen = new Set<string>();

  for (const sample of samples) {
    if (!Number.isFinite(sample.at) || sample.at < floor) continue;
    // A clock-skewed future stamp would sit in every window forever; a small grace keeps an
    // agent whose host clock runs a few seconds fast from being dropped mid-run.
    if (sample.at > now + 60_000) continue;
    if (sample.key !== undefined) {
      if (seen.has(sample.key)) continue;
      seen.add(sample.key);
    }
    for (const window of windows) {
      if (sample.at >= window.start) addSample(window.totals, sample);
    }
    const dateKey = localDateKey(sample.at);
    let day = daily.get(dateKey);
    if (!day) daily.set(dateKey, (day = emptyTotals()));
    addSample(day, sample);
    if (sample.model) {
      let model = models.get(sample.model);
      if (!model) models.set(sample.model, (model = emptyTotals()));
      addSample(model, sample);
    }
  }

  return {
    windows: windows.map((window) => ({
      id: window.id,
      startedAt: new Date(window.start).toISOString(),
      totals: window.totals,
    })),
    daily: [...daily.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, totals]) => ({ date, totals })),
    models: [...models.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([model, totals]) => ({ model, totals })),
  };
}
