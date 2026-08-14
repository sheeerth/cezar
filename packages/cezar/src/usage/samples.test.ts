import { describe, expect, it } from 'vitest';

import { CACHE_CREATION_WEIGHT, CACHE_READ_WEIGHT } from '../core/usage.ts';
import {
  localDateKey,
  summarizeSamples,
  weighSample,
  windowStartMs,
  type UsageSample,
} from './samples.ts';

const NOW = new Date('2026-08-14T15:00:00').getTime();

function sample(overrides: Partial<UsageSample> = {}): UsageSample {
  return {
    at: NOW - 60_000,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

const windowsById = (samples: UsageSample[]) =>
  Object.fromEntries(
    summarizeSamples(samples, NOW).windows.map((window) => [window.id, window.totals.tokens]),
  );

describe('weighSample', () => {
  it('weights cache traffic the way the cockpit already prices it', () => {
    expect(
      weighSample(
        sample({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 1_000, cacheWriteTokens: 400 }),
      ),
    ).toBe(Math.round(100 + 10 + 1_000 * CACHE_READ_WEIGHT + 400 * CACHE_CREATION_WEIGHT));
  });

  it('takes a pre-weighted count verbatim — a run record already carries cezar\'s number', () => {
    expect(weighSample(sample({ weightedTokens: 4_242, inputTokens: 9_999 }))).toBe(4_242);
  });
});

describe('windowStartMs', () => {
  it('anchors calendar spans on LOCAL midnight, not UTC', () => {
    const start = new Date(windowStartMs('today', NOW));
    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
    expect(localDateKey(windowStartMs('today', NOW))).toBe(localDateKey(NOW));
  });

  it('spans seven local days for last7d — today plus the six before it', () => {
    expect(localDateKey(windowStartMs('last7d', NOW))).toBe('2026-08-08');
    expect(localDateKey(windowStartMs('last30d', NOW))).toBe('2026-07-16');
  });

  it('floats rolling5h with the clock', () => {
    expect(windowStartMs('rolling5h', NOW)).toBe(NOW - 5 * 60 * 60_000);
  });
});

describe('summarizeSamples', () => {
  it('counts a sample into every window it falls inside', () => {
    const totals = windowsById([
      sample({ at: NOW - 30 * 60_000, outputTokens: 100 }), // inside all four
      sample({ at: NOW - 8 * 60 * 60_000, outputTokens: 10 }), // today, but past the 5h window
    ]);
    expect(totals).toEqual({ rolling5h: 100, today: 110, last7d: 110, last30d: 110 });
  });

  it('de-duplicates on key — one reply written to the transcript five times is one reply', () => {
    const chunk = () => sample({ outputTokens: 50, key: 'msg_1:req_1' });
    expect(windowsById([chunk(), chunk(), chunk(), chunk(), chunk()]).rolling5h).toBe(50);
  });

  it('keeps distinct keys apart, and counts keyless samples every time', () => {
    expect(
      windowsById([
        sample({ outputTokens: 50, key: 'msg_1:req_1' }),
        sample({ outputTokens: 50, key: 'msg_2:req_2' }),
        sample({ outputTokens: 7 }),
        sample({ outputTokens: 7 }),
      ]).rolling5h,
    ).toBe(114);
  });

  it('drops samples older than retention and stamps beyond a minute of clock skew', () => {
    expect(
      windowsById([
        sample({ at: NOW - 40 * 24 * 60 * 60_000, outputTokens: 1_000 }),
        sample({ at: NOW + 10 * 60_000, outputTokens: 1_000 }),
        sample({ at: NOW + 30_000, outputTokens: 5 }), // a host clock a few seconds fast still counts
      ]).last30d,
    ).toBe(5);
  });

  it('buckets days in local time, oldest first', () => {
    const summary = summarizeSamples(
      [
        sample({ at: new Date('2026-08-13T23:30:00').getTime(), outputTokens: 3 }),
        sample({ at: new Date('2026-08-14T00:30:00').getTime(), outputTokens: 4 }),
      ],
      NOW,
    );
    expect(summary.daily.map((day) => [day.date, day.totals.tokens])).toEqual([
      ['2026-08-13', 3],
      ['2026-08-14', 4],
    ]);
  });

  it('ranks models by weighted tokens and leaves unlabelled samples out of the breakdown', () => {
    const summary = summarizeSamples(
      [
        sample({ outputTokens: 10, model: 'claude-sonnet-5' }),
        sample({ outputTokens: 90, model: 'claude-opus-5' }),
        sample({ outputTokens: 500 }),
      ],
      NOW,
    );
    expect(summary.models.map((model) => model.model)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('leaves costUsd absent until a backend reported one', () => {
    const priced = summarizeSamples([sample({ outputTokens: 1, costUsd: 0.25 })], NOW);
    const unpriced = summarizeSamples([sample({ outputTokens: 1 })], NOW);
    expect(priced.daily[0]!.totals.costUsd).toBe(0.25);
    expect(unpriced.daily[0]!.totals).not.toHaveProperty('costUsd');
  });
});
