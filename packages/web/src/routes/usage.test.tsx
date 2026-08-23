import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { UsageChip } from '@/components/usage-chip'
import type { UsageAccount, UsageSnapshot, UsageTotals } from '@open-mercato/cezar-api-client'

import { UsageRoute } from './usage'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function totals(tokens: number, costUsd?: number): UsageTotals {
  return {
    tokens,
    inputTokens: Math.round(tokens * 0.8),
    outputTokens: Math.round(tokens * 0.2),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(costUsd === undefined ? {} : { costUsd }),
  }
}

const windows = (scale: number) => [
  { id: 'rolling5h' as const, startedAt: '2026-08-14T07:00:00.000Z', totals: totals(scale) },
  { id: 'today' as const, startedAt: '2026-08-14T00:00:00.000Z', totals: totals(scale * 2) },
  { id: 'last7d' as const, startedAt: '2026-08-08T00:00:00.000Z', totals: totals(scale * 5) },
  { id: 'last30d' as const, startedAt: '2026-07-16T00:00:00.000Z', totals: totals(scale * 10) },
]

const CLAUDE: UsageAccount = {
  provider: 'claude',
  accountId: 'default',
  label: 'Default',
  isDefault: true,
  available: true,
  windows: windows(120_000),
  limits: [],
  models: [
    { model: 'claude-opus-5', totals: totals(900_000) },
    { model: 'claude-sonnet-5', totals: totals(300_000) },
  ],
  daily: [{ date: '2026-08-14', totals: totals(240_000) }],
}

const CODEX: UsageAccount = {
  provider: 'codex',
  accountId: 'work',
  label: 'Work',
  isDefault: false,
  available: true,
  windows: windows(40_000),
  limits: [
    {
      id: 'primary',
      label: '5h window',
      usedPercent: 73.4,
      windowMinutes: 300,
      resetsAt: '2026-08-14T18:00:00.000Z',
      observedAt: '2026-08-14T11:50:00.000Z',
    },
  ],
  models: [],
  daily: [],
}

const OPENCODE_MISSING: UsageAccount = {
  provider: 'codex',
  accountId: 'spare',
  label: 'Spare',
  isDefault: false,
  available: false,
  reason: 'no sessions recorded for this account yet',
  windows: windows(0),
  limits: [],
  models: [],
  daily: [],
}

const SNAPSHOT: UsageSnapshot = {
  generatedAt: new Date().toISOString(),
  accounts: [CLAUDE, CODEX, OPENCODE_MISSING],
  runs: {
    windows: windows(30_000),
    byProvider: [
      { key: 'claude', label: 'Claude Code', totals: totals(200_000, 4.5), runs: 12 },
      { key: 'codex', label: 'Codex', totals: totals(50_000), runs: 3 },
    ],
    byProject: [{ key: 'cezar', label: 'cezar', totals: totals(250_000, 4.5), runs: 15 }],
    daily: [{ date: '2026-08-14', totals: totals(60_000) }],
    unreadableProjects: [],
  },
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const health = (capabilities: Record<string, unknown> = {}) => ({
  version: '0.0.0-test',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  forge: null,
  checks: [],
  defaultRunner: 'claude',
  projects: [],
  bootProject: 'cezar',
  capabilities: {
    localHandoff: true,
    followups: false,
    singleProject: false,
    automations: false,
    tokenMetrics: true,
    tokenUsageMetrics: true,
    costMetrics: true,
    ...capabilities,
  },
})

function stubFetch(
  snapshot: UsageSnapshot | 'error' = SNAPSHOT,
  capabilities: Record<string, unknown> = {},
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/health') return jsonResponse(health(capabilities))
      if (path === '/api/v1/workspace/usage') {
        return snapshot === 'error' ? jsonResponse({ error: 'nope' }, 500) : jsonResponse(snapshot)
      }
      return jsonResponse({}, 404)
    }),
  )
}

function renderRoute(node = <UsageRoute />) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('UsageRoute', () => {
  it('keeps the account and task halves apart — the two are never summed', async () => {
    stubFetch()
    renderRoute()

    const accounts = await screen.findByRole('region', { name: /Agent accounts/i })
    const tasks = screen.getByRole('region', { name: /cezar tasks/i })
    // 120k in the accounts' 5h window (two readable accounts), 30k of it through cezar.
    expect(within(accounts).getByLabelText('All accounts').textContent).toContain('160.0k')
    expect(within(tasks).getByLabelText('cezar tasks').textContent).toContain('30.0k')
  })

  it('shows a vendor quota with its reset, and never invents one for Claude', async () => {
    stubFetch()
    renderRoute()

    const codex = await screen.findByRole('article', { name: /Codex · Work/ })
    expect(codex.textContent).toContain('5h window')
    expect(codex.textContent).toContain('73%')
    const claude = screen.getByRole('article', { name: /Claude Code · Default/ })
    expect(claude.textContent).not.toContain('%')
  })

  it('says why an account has no numbers instead of dropping it', async () => {
    stubFetch()
    renderRoute()

    const spare = await screen.findByRole('article', { name: /Codex · Spare/ })
    expect(spare.textContent).toContain('no sessions recorded for this account yet')
  })

  it('prices the task half when the server reported money', async () => {
    stubFetch()
    renderRoute()

    const tasks = await screen.findByRole('region', { name: /By agent/i })
    expect(tasks.textContent).toContain('$4.50')
    expect(tasks.textContent).toContain('12 tasks')
  })

  it('hides cost — but keeps tokens — when the server switched cost off', async () => {
    stubFetch(SNAPSHOT, { costMetrics: false })
    renderRoute()

    const tasks = await screen.findByRole('region', { name: /By agent/i })
    expect(tasks.textContent).toContain('200.0k')
    expect(tasks.textContent).not.toContain('$4.50')
  })

  it('renders nothing countable when the server hides token metrics', async () => {
    stubFetch(SNAPSHOT, { tokenUsageMetrics: false, tokenMetrics: false })
    renderRoute()

    expect(await screen.findByText(/Token metrics are hidden/)).toBeTruthy()
    expect(screen.queryByRole('region', { name: /Agent accounts/i })).toBeNull()
  })

  it('explains the missing account half on a remotely served cockpit', async () => {
    stubFetch(
      { ...SNAPSHOT, accounts: [] },
      { localHandoff: false },
    )
    renderRoute()

    expect(await screen.findByText(/served remotely/)).toBeTruthy()
    // The runs half still answers — it does not live in anyone's home directory.
    expect(screen.getByRole('region', { name: /cezar tasks/i })).toBeTruthy()
  })

  it('says the numbers are incomplete when a project could not be read', async () => {
    stubFetch({
      ...SNAPSHOT,
      runs: { ...SNAPSHOT.runs, unreadableProjects: ['gone'] },
    })
    renderRoute()

    expect(await screen.findByText(/1 project could not be read/)).toBeTruthy()
  })

  it('offers an honest empty state rather than a grid of zeros', async () => {
    stubFetch({
      generatedAt: new Date().toISOString(),
      accounts: [],
      runs: { windows: windows(0), byProvider: [], byProject: [], daily: [], unreadableProjects: [] },
    })
    renderRoute()

    expect(await screen.findByText(/Nothing recorded in the last 30 days yet/)).toBeTruthy()
  })

  it('degrades to a stated failure when the snapshot cannot be read', async () => {
    stubFetch('error')
    renderRoute()

    // The query client retries a 5xx once, so this settles a beat later than the others.
    expect(await screen.findByText(/Usage could not be read/, undefined, { timeout: 5_000 })).toBeTruthy()
  })
})

describe('UsageChip', () => {
  it('reads the accounts\' 5h window and links to the page', async () => {
    stubFetch()
    renderRoute(<UsageChip />)

    const chip = await screen.findByRole('link')
    expect(chip.textContent).toContain('160.0k')
    expect(chip.getAttribute('href')).toBe('/usage')
  })

  it('shows the tightest vendor quota when one exists', async () => {
    stubFetch()
    renderRoute(<UsageChip />)

    const chip = await screen.findByRole('link')
    expect(chip.textContent).toContain('73%')
  })

  it('falls back to the day\'s total on a machine with no published quota', async () => {
    stubFetch({ ...SNAPSHOT, accounts: [CLAUDE] })
    renderRoute(<UsageChip />)

    const chip = await screen.findByRole('link')
    expect(chip.textContent).toContain('240.0k today')
  })

  it('is absent — not zeroed — with no readable account, and when metrics are hidden', async () => {
    stubFetch({ ...SNAPSHOT, accounts: [] })
    const { unmount } = renderRoute(<UsageChip />)
    await waitFor(() => expect(screen.queryByRole('link')).toBeNull())
    unmount()

    stubFetch(SNAPSHOT, { tokenUsageMetrics: false, tokenMetrics: false })
    renderRoute(<UsageChip />)
    await waitFor(() => expect(screen.queryByRole('link')).toBeNull())
  })
})
