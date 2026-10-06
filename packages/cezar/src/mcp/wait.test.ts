import { describe, expect, it } from 'vitest';
import { runActivitySchema, runStatusSchema, type RunStatus } from '@open-mercato/cezar-contract';
import { CockpitError } from './cockpit.ts';
import { isSettled, waitForRuns, type WaitTarget } from './wait.ts';

describe('isSettled — every status × activity', () => {
  const expected: Record<RunStatus, boolean> = {
    queued: false,
    running: false,
    waiting: true,
    review: true,
    done: true,
    failed: true,
    cancelled: true,
  };

  it.each(runStatusSchema.options)('%s', (status) => {
    expect(isSettled({ status })).toBe(expected[status]);
    for (const activity of runActivitySchema.options) {
      // Monitoring parks a RUNNING run; on any other status the status alone decides.
      expect(isSettled({ status, activity })).toBe(status === 'running' ? true : expected[status]);
    }
  });
});

/** A clock that only moves when the loop sleeps — no real timers, no flakiness. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

const target = (runId: string): WaitTarget => ({ runId, projectId: 'boot' });

describe('waitForRuns', () => {
  it('returns at once when a run is already settled', async () => {
    const clock = fakeClock();
    const out = await waitForRuns([target('a')], async () => ({ status: 'review' as const }), {
      mode: 'any',
      timeoutMs: 40_000,
      signal: new AbortController().signal,
      ...clock,
    });
    expect(out.timedOut).toBe(false);
    expect(clock.sleeps).toEqual([]);
  });

  it('polls every 2 s until a run settles (mode any)', async () => {
    const clock = fakeClock();
    let reads = 0;
    const out = await waitForRuns(
      [target('a'), target('b')],
      async (t) => {
        reads++;
        return { status: t.runId === 'b' && clock.now() >= 6_000 ? ('waiting' as const) : ('running' as const) };
      },
      { mode: 'any', timeoutMs: 40_000, signal: new AbortController().signal, ...clock },
    );
    expect(out.timedOut).toBe(false);
    expect(clock.sleeps).toEqual([2_000, 2_000, 2_000]);
    expect(reads).toBe(8);
    expect(out.outcomes.map((o) => o.run?.status)).toEqual(['running', 'waiting']);
  });

  it('waits for every run in mode all, counting monitoring as settled', async () => {
    const clock = fakeClock();
    const out = await waitForRuns(
      [target('a'), target('b')],
      async (t) =>
        t.runId === 'a'
          ? { status: 'running' as const, activity: 'monitoring' as const }
          : { status: clock.now() >= 4_000 ? ('done' as const) : ('running' as const) },
      { mode: 'all', timeoutMs: 40_000, signal: new AbortController().signal, ...clock },
    );
    expect(out.timedOut).toBe(false);
    expect(clock.now()).toBe(4_000);
  });

  it('times out on schedule and still reports the current state', async () => {
    const clock = fakeClock();
    const out = await waitForRuns([target('a')], async () => ({ status: 'running' as const }), {
      mode: 'any',
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      ...clock,
    });
    expect(out.timedOut).toBe(true);
    expect(clock.sleeps).toEqual([2_000, 2_000, 1_000]);
    expect(out.outcomes[0]!.run?.status).toBe('running');
  });

  it('settles a run that no longer exists instead of spinning on it', async () => {
    const clock = fakeClock();
    const out = await waitForRuns(
      [target('gone')],
      async () => {
        throw new CockpitError('404: not found');
      },
      { mode: 'any', timeoutMs: 40_000, signal: new AbortController().signal, ...clock },
    );
    expect(out).toMatchObject({ timedOut: false, outcomes: [{ error: 'not found' }] });
  });

  it('rides out one failed tick (a restarting cockpit) and fails on the second', async () => {
    const clock = fakeClock();
    let tick = 0;
    const flaky = await waitForRuns(
      [target('a')],
      async () => {
        tick++;
        if (tick === 2) throw new CockpitError('cezar cockpit unreachable');
        return { status: tick >= 3 ? ('review' as const) : ('running' as const) };
      },
      { mode: 'any', timeoutMs: 40_000, signal: new AbortController().signal, ...clock },
    );
    expect(flaky.timedOut).toBe(false);

    const deadClock = fakeClock();
    const dead = waitForRuns(
      [target('a')],
      async () => {
        if (deadClock.now() === 0) return { status: 'running' as const };
        throw new CockpitError('cezar cockpit unreachable');
      },
      { mode: 'any', timeoutMs: 40_000, signal: new AbortController().signal, ...deadClock },
    );
    await expect(dead).rejects.toThrow(/stopped answering while waiting .* last known: a: running/);
  });

  it('stops when the client cancels the call', async () => {
    const controller = new AbortController();
    const clock = fakeClock();
    const out = waitForRuns([target('a')], async () => ({ status: 'running' as const }), {
      mode: 'any',
      timeoutMs: 40_000,
      signal: controller.signal,
      now: clock.now,
      sleep: async (ms) => {
        await clock.sleep(ms);
        controller.abort();
      },
    });
    await expect(out).rejects.toThrow('cancelled');
    expect(clock.sleeps).toEqual([2_000]);
  });
});
