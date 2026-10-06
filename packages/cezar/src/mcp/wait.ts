/**
 * When a supervisor may stop waiting on a run (spec `2026-10-06-cez-mcp` § `settled` predicate).
 *
 * A run is SETTLED once it stops actively working: it needs you (`waiting`), it is parked on its
 * own downstream work (`running` + `activity: monitoring`), it reached the review gate, or it
 * ended. Monitoring counts because a parked monitor can stay parked for a long time — a wait that
 * ignored it would spin to its timeout on every call.
 */
import type { RunActivity, RunStatus } from '@open-mercato/cezar-contract';

const SETTLED_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['waiting', 'review', 'done', 'failed', 'cancelled']);

export function isSettled(run: { status: RunStatus; activity?: RunActivity }): boolean {
  return SETTLED_STATUSES.has(run.status) || (run.status === 'running' && run.activity === 'monitoring');
}
