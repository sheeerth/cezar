import type { RunRecord } from './store.ts';

/**
 * The display-only tracker reference a run carries on the wire (spec
 * 2026-10-07-task-phases-by-pr-issue, step 9): `provider`, `key` and `url`, projected from the
 * persisted `automationTracker` provenance and nothing else from it — the association, receipt
 * and event stay server-side. Present only when the record carries that provenance, so a run a
 * person launched sends no `trackerRef` key at all.
 */
export interface RunTrackerRef {
  provider: 'jira' | 'linear';
  key: string;
  url: string;
}

export function trackerRefOf(run: Pick<RunRecord, 'automationTracker'>): RunTrackerRef | undefined {
  const tracker = run.automationTracker;
  return tracker ? { provider: tracker.provider, key: tracker.key, url: tracker.url } : undefined;
}

/** `run` plus its `trackerRef`, spread conditionally so `undefined` never reaches the wire. */
export function withTrackerRef<T extends Pick<RunRecord, 'automationTracker'>>(
  run: T,
): T & { trackerRef?: RunTrackerRef } {
  const trackerRef = trackerRefOf(run);
  return trackerRef ? { ...run, trackerRef } : run;
}
