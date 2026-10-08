import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  LIST_GROUPING_STORAGE_KEY,
  ListViewProvider,
  useListGrouping,
  useListView,
} from '@/components/list-view'

afterEach(() => {
  cleanup()
  localStorage.removeItem(LIST_GROUPING_STORAGE_KEY)
})

/** Two consumers in two subtrees — the sidebar and the table's shapes. */
function Consumer({ name }: { name: string }) {
  const [view, setView] = useListView()
  return (
    <button type="button" onClick={() => setView(view === 'active' ? 'archived' : 'active')}>
      {name}:{view}
    </button>
  )
}

describe('ListViewProvider', () => {
  it('starts on Active', () => {
    render(
      <ListViewProvider>
        <Consumer name="a" />
      </ListViewProvider>
    )
    expect((screen.getByRole('button'))?.textContent).toContain('a:active')
  })

  it('keeps every consumer on the same view — the sidebar and the table cannot disagree', async () => {
    render(
      <ListViewProvider>
        <div>
          <Consumer name="sidebar" />
        </div>
        <div>
          <Consumer name="table" />
        </div>
      </ListViewProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'sidebar:active' }))
    expect(screen.getByRole('button', { name: 'sidebar:archived' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'table:archived' })).not.toBeNull()

    // …and back, from the other one.
    fireEvent.click(screen.getByRole('button', { name: 'table:archived' }))
    expect(screen.getByRole('button', { name: 'sidebar:active' })).not.toBeNull()
  })

  it('throws outside a provider rather than handing out a private filter', () => {
    // React logs the thrown render error; the assertion is the throw itself.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => render(<Consumer name="orphan" />)).toThrow(/must be used inside a <ListViewProvider>/)
    } finally {
      error.mockRestore()
    }
  })
})

function GroupingConsumer({ name }: { name: string }) {
  const [grouping, setGrouping] = useListGrouping()
  return (
    <button type="button" onClick={() => setGrouping(grouping === 'attention' ? 'byReference' : 'attention')}>
      {name}:{grouping}
    </button>
  )
}

describe('useListGrouping', () => {
  it('defaults to attention', () => {
    render(
      <ListViewProvider>
        <GroupingConsumer name="a" />
      </ListViewProvider>
    )
    expect(screen.getByRole('button').textContent).toBe('a:attention')
  })

  it('is shared by every consumer and persists across a remount', () => {
    const first = render(
      <ListViewProvider>
        <GroupingConsumer name="sidebar" />
        <GroupingConsumer name="table" />
      </ListViewProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'sidebar:attention' }))
    expect(screen.getByRole('button', { name: 'table:byReference' })).not.toBeNull()
    expect(localStorage.getItem(LIST_GROUPING_STORAGE_KEY)).toBe('byReference')
    first.unmount()

    render(
      <ListViewProvider>
        <GroupingConsumer name="again" />
      </ListViewProvider>
    )
    expect(screen.getByRole('button').textContent).toBe('again:byReference')
  })

  it('reads a corrupt or unknown stored value as attention', () => {
    localStorage.setItem(LIST_GROUPING_STORAGE_KEY, '{"nope":1}')
    render(
      <ListViewProvider>
        <GroupingConsumer name="a" />
      </ListViewProvider>
    )
    expect(screen.getByRole('button').textContent).toBe('a:attention')
  })

  it('keeps the Active/Archived view in memory while the grouping persists', () => {
    function Both() {
      const [view, setView] = useListView()
      const [grouping] = useListGrouping()
      return (
        <button type="button" onClick={() => setView('archived')}>
          {view}/{grouping}
        </button>
      )
    }
    localStorage.setItem(LIST_GROUPING_STORAGE_KEY, 'byReference')
    const first = render(
      <ListViewProvider>
        <Both />
      </ListViewProvider>
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button').textContent).toBe('archived/byReference')
    first.unmount()
    render(
      <ListViewProvider>
        <Both />
      </ListViewProvider>
    )
    expect(screen.getByRole('button').textContent).toBe('active/byReference')
  })
})
