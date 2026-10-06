/**
 * When a supervisor may stop waiting on a run (spec `2026-10-06-cez-mcp` § `settled` predicate).
 *
 * A run is SETTLED once it stops actively working: it needs you (`waiting`), it is parked on its
 * own downstream work (`running` + `activity: monitoring`), it reached the review gate, or it
 * ended. Monitoring counts because a parked monitor can stay parked for a long time — a wait that
 * ignored it would spin to its timeout on every call.
 */
import type { RunActivity, RunStatus } from '@open-mercato/cezar-contract';
import { CockpitError } from './cockpit.ts';

const SETTLED_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['waiting', 'review', 'done', 'failed', 'cancelled']);

export function isSettled(run: { status: RunStatus; activity?: RunActivity }): boolean {
  return SETTLED_STATUSES.has(run.status) || (run.status === 'running' && run.activity === 'monitoring');
}

export interface WaitTarget {
  runId: string;
  projectId: string;
}

export interface WaitOutcome<R> {
  target: WaitTarget;
  run?: R;
  /** Set when the run could not be read on the last tick (`not found` counts as settled). */
  error?: string;
}

export interface WaitOptions {
  mode: 'any' | 'all';
  timeoutMs: number;
  signal: AbortSignal;
  intervalMs?: number;
  /** Test seams. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export const POLL_INTERVAL_MS = 2_000;

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Polls `read` for every target until `mode` is satisfied or `timeoutMs` passes — never longer,
 * so one MCP call stays under a client's tool timeout and the caller simply calls again.
 *
 * A 404 settles its target (a deleted run must not keep a wait spinning). Any other read failure
 * keeps the target's last known state for that tick; two failing ticks in a row — a cockpit that
 * went away — end the wait with an error naming what was last known.
 */
export async function waitForRuns<R extends { status: RunStatus; activity?: RunActivity }>(
  targets: readonly WaitTarget[],
  read: (target: WaitTarget, signal: AbortSignal) => Promise<R>,
  options: WaitOptions,
): Promise<{ timedOut: boolean; outcomes: WaitOutcome<R>[] }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const interval = options.intervalMs ?? POLL_INTERVAL_MS;
  const deadline = now() + options.timeoutMs;
  const outcomes: WaitOutcome<R>[] = targets.map((target) => ({ target }));
  let failingTicks = 0;

  for (;;) {
    let failed = false;
    await Promise.all(
      outcomes.map(async (outcome) => {
        try {
          outcome.run = await read(outcome.target, options.signal);
          delete outcome.error;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith('404')) {
            outcome.error = 'not found';
            delete outcome.run;
          } else {
            failed = true;
            outcome.error = message;
          }
        }
      }),
    );
    if (options.signal.aborted) throw new WaitCancelled();
    failingTicks = failed ? failingTicks + 1 : 0;
    if (failingTicks >= 2) {
      const last = outcomes.map((o) => `${o.target.runId}: ${o.run?.status ?? 'unknown'}`).join(', ');
      throw new CockpitError(`the cockpit stopped answering while waiting (${outcomes.find((o) => o.error)?.error}) — last known: ${last}`);
    }
    const settled = outcomes.map((o) => o.error === 'not found' || (o.run !== undefined && isSettled(o.run)));
    if (options.mode === 'any' ? settled.some(Boolean) : settled.every(Boolean)) return { timedOut: false, outcomes };
    const left = deadline - now();
    if (left <= 0) return { timedOut: true, outcomes };
    await sleep(Math.min(interval, left), options.signal);
    if (options.signal.aborted) throw new WaitCancelled();
  }
}

export class WaitCancelled extends CockpitError {
  constructor() {
    super('cancelled');
  }
}
