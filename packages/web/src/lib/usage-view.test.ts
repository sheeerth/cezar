import { describe, expect, it } from 'vitest'

import type { UsageAccount, UsageTotals } from '@open-mercato/cezar-api-client'
import {
  accountsWindowTotals,
  addTotals,
  barPercent,
  fillDailySeries,
  hasAnyUsage,
  resetsIn,
  tightestLimit,
  windowTotals,
} from './usage-view'

const NOW = new Date('2026-08-14T12:00:00').getTime()

function totals(tokens: number, costUsd?: number): UsageTotals {
  return {
    tokens,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(costUsd === undefined ? {} : { costUsd }),
  }
}

function account(overrides: Partial<UsageAccount> = {}): UsageAccount {
  return {
    provider: 'claude',
    accountId: 'default',
    label: 'Default',
    isDefault: true,
    available: true,
    windows: [
      { id: 'rolling5h', startedAt: '2026-08-14T07:00:00.000Z', totals: totals(100) },
      { id: 'today', startedAt: '2026-08-14T00:00:00.000Z', totals: totals(500) },
      { id: 'last7d', startedAt: '2026-08-08T00:00:00.000Z', totals: totals(700) },
      { id: 'last30d', startedAt: '2026-07-16T00:00:00.000Z', totals: totals(900) },
    ],
    limits: [],
    models: [],
    daily: [],
    ...overrides,
  }
}

describe('windowTotals', () => {
  it('is all zeros for a window the server did not send', () => {
    expect(windowTotals([], 'today')).toEqual(totals(0))
  })
})

describe('addTotals', () => {
  it('leaves cost absent unless one side reported money', () => {
    expect(addTotals(totals(1), totals(2))).not.toHaveProperty('costUsd')
    expect(addTotals(totals(1, 0.5), totals(2)).costUsd).toBe(0.5)
    expect(addTotals(totals(1, 0.5), totals(2, 0.25)).costUsd).toBe(0.75)
  })
})

describe('accountsWindowTotals', () => {
  it('sums the accounts that could be read', () => {
    expect(
      accountsWindowTotals([account(), account({ accountId: 'work' })], 'today').tokens,
    ).toBe(1_000)
  })

  it('skips unavailable accounts instead of counting them as an idle zero', () => {
    const missing = account({
      accountId: 'codex',
      available: false,
      reason: 'no sessions recorded for this account yet',
      windows: [{ id: 'today', startedAt: '2026-08-14T00:00:00.000Z', totals: totals(0) }],
    })
    const summed = accountsWindowTotals([account(), missing], 'today')
    expect(summed.tokens).toBe(500)
  })
})

describe('tightestLimit', () => {
  it('finds the fullest window across every account', () => {
    const found = tightestLimit([
      account({
        limits: [{ id: 'primary', label: '5h window', usedPercent: 20, observedAt: '2026-08-14T11:00:00.000Z' }],
      }),
      account({
        accountId: 'work',
        label: 'Work',
        limits: [
          { id: 'primary', label: '5h window', usedPercent: 91, observedAt: '2026-08-14T11:00:00.000Z' },
          { id: 'secondary', label: 'Weekly window', usedPercent: 44, observedAt: '2026-08-14T11:00:00.000Z' },
        ],
      }),
    ])
    expect([found?.account.label, found?.limit.usedPercent]).toEqual(['Work', 91])
  })

  it('is undefined when no vendor published one — the normal Claude-only machine', () => {
    expect(tightestLimit([account()])).toBeUndefined()
  })
})

describe('resetsIn', () => {
  it.each([
    ['2026-08-14T12:42:00', 'in 42m'],
    ['2026-08-14T15:00:00', 'in 3h'],
    ['2026-08-16T12:00:00', 'in 2d'],
    ['2026-08-14T11:00:00', 'now'],
  ])('%s → %s', (iso, expected) => {
    expect(resetsIn(new Date(iso).toISOString(), NOW)).toBe(expected)
  })

  it('says nothing rather than NaN for a missing or broken instant', () => {
    expect(resetsIn(undefined, NOW)).toBe('')
    expect(resetsIn('not a date', NOW)).toBe('')
  })
})

describe('barPercent', () => {
  it('keeps a non-zero row visible and never exceeds the track', () => {
    expect(barPercent(1, 1_000_000)).toBe(2)
    expect(barPercent(500, 1_000)).toBe(50)
    expect(barPercent(2_000, 1_000)).toBe(100)
  })

  it('is zero for nothing to draw', () => {
    expect(barPercent(0, 100)).toBe(0)
    expect(barPercent(5, 0)).toBe(0)
  })
})

describe('fillDailySeries', () => {
  it('zero-fills idle days so the timeline stays honest', () => {
    const series = fillDailySeries([{ date: '2026-08-13', totals: totals(7) }], 3, NOW)
    expect(series.map((day) => [day.date, day.totals.tokens])).toEqual([
      ['2026-08-12', 0],
      ['2026-08-13', 7],
      ['2026-08-14', 0],
    ])
  })
})

describe('hasAnyUsage', () => {
  const runs = (tokens: number) => ({
    windows: [{ id: 'last30d' as const, startedAt: '2026-07-16T00:00:00.000Z', totals: totals(tokens) }],
    byProvider: [],
    byProject: [],
    daily: [],
    unreadableProjects: [],
  })

  it('is false before anything loaded, and for a workspace that never ran an agent', () => {
    expect(hasAnyUsage(undefined)).toBe(false)
    expect(
      hasAnyUsage({
        generatedAt: '2026-08-14T12:00:00.000Z',
        accounts: [account({ available: false, windows: [] })],
        runs: runs(0),
      }),
    ).toBe(false)
  })

  it('is true when either half has something to show', () => {
    expect(
      hasAnyUsage({ generatedAt: '2026-08-14T12:00:00.000Z', accounts: [account()], runs: runs(0) }),
    ).toBe(true)
    expect(
      hasAnyUsage({ generatedAt: '2026-08-14T12:00:00.000Z', accounts: [], runs: runs(5) }),
    ).toBe(true)
  })
})
