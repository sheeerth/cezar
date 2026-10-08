import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from './query-client'
import { TRACKER_SIGNAL_MAX, useTrackerItemSignals } from './queries'

/**
 * `useTrackerItemSignals` (task phases, step 10, A6): Jira/Linear reads for phase signals happen
 * only behind a configured connection, never throw, and treat every failure as "no signal".
 */

const association = {
  kind: 'jira' as const,
  source: { id: 'cloud', webUrl: 'https://acme.atlassian.net' },
  externalId: '100',
  externalName: 'OPS',
}
const connection = { id: '7d1f6f2e-2a3b-4c5d-8e9f-0a1b2c3d4e5f', kind: 'jira' as const }
const item = (id: string, status: string, labels: string[] = []) => ({
  available: true,
  item: {
    id,
    title: id,
    kind: 'issue',
    body: '',
    author: 'A',
    status,
    createdAt: '2026-09-19T00:00:00Z',
    updatedAt: '2026-09-19T00:00:00Z',
    url: `https://acme.atlassian.net/browse/${id}`,
    labels,
    bodyTruncated: false,
    unsupportedContent: false,
  },
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function serve(items: Record<string, unknown>, { configured = true } = {}) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path.endsWith('/tracker/connection')) return json({ connection: configured ? connection : null, demo: false })
    if (path.endsWith('/tracker/association')) return json({ association: configured ? association : null })
    const id = decodeURIComponent(decodeURIComponent(path.split('/tracker/')[1] ?? ''))
    const body = items[id]
    return body === undefined ? json({ error: 'not found' }, 404) : json(body)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const itemCalls = (fetchMock: ReturnType<typeof serve>) =>
  fetchMock.mock.calls
    .map((call) => new URL(String(call[0]), 'http://localhost').pathname)
    .filter((path) => !path.endsWith('/connection') && !path.endsWith('/association') && path.includes('/tracker/'))

function render(refs: { provider: string; key: string }[]) {
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return renderHook(() => useTrackerItemSignals(refs), { wrapper })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useTrackerItemSignals', () => {
  it('reads status and labels for refs of the configured provider, with expectedScope', async () => {
    const fetchMock = serve({ 'OPS-1': item('OPS-1', 'In Review', ['qa']) })
    const { result } = render([{ provider: 'jira', key: 'OPS-1' }])
    await waitFor(() => expect(result.current({ provider: 'jira', key: 'OPS-1' })).toEqual({ status: 'In Review', labels: ['qa'] }))
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('OPS-1'))
    expect(new URL(String(call?.[0]), 'http://localhost').searchParams.get('expectedScope')).toContain('cloud')
  })

  it('makes no item request without a configured connection', async () => {
    const fetchMock = serve({ 'OPS-1': item('OPS-1', 'Done') }, { configured: false })
    const { result } = render([{ provider: 'jira', key: 'OPS-1' }])
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(itemCalls(fetchMock)).toEqual([])
    expect(result.current({ provider: 'jira', key: 'OPS-1' })).toBeUndefined()
  })

  it.each(['not_configured', 'unauthorized', 'rate_limited', 'source_changed'])(
    'a %s answer is no signal, and nothing throws',
    async (code) => {
      const fetchMock = serve({ 'OPS-1': { available: false, code, reason: code } })
      const { result } = render([{ provider: 'jira', key: 'OPS-1' }])
      await waitFor(() => expect(itemCalls(fetchMock).length).toBe(1))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(result.current({ provider: 'jira', key: 'OPS-1' })).toBeUndefined()
    },
  )

  it('ignores refs from another provider and caps the reads', async () => {
    const refs = Array.from({ length: TRACKER_SIGNAL_MAX + 5 }, (_, i) => ({ provider: 'jira', key: `OPS-${i}` }))
    const fetchMock = serve({})
    render([{ provider: 'linear', key: 'ENG-1' }, ...refs])
    await waitFor(() => expect(itemCalls(fetchMock).length).toBe(TRACKER_SIGNAL_MAX))
    expect(itemCalls(fetchMock).some((path) => path.includes('ENG-1'))).toBe(false)
  })
})
