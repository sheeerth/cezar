import * as React from 'react'
import type { ReactNode } from 'react'

import type { ListView } from '@/lib/task-groups'

/**
 * The Active/Archived filter, shared by the sidebar quick-list and (Step 3.4) the Tasks table.
 *
 * The spec requires the table's tabs to "share state with the sidebar quick-list tabs", and the
 * legacy UI got that for free by keeping a single `state.listView` global. Two surfaces in two
 * subtrees need one value, so it is context rather than a `useState` in either of them — a
 * quick-list that switched to Archived while the table still showed Active would be two answers
 * to one question.
 *
 * In-memory, not persisted: the legacy filter reset to Active on every reload, and a filter that
 * silently survives a restart hides runs the user does not know are hidden.
 */
const ListViewContext = React.createContext<[ListView, (view: ListView) => void] | null>(null)

/**
 * How the task lists are grouped (spec `2026-10-07-task-phases-by-pr-issue`, A1/A2): the
 * attention buckets, or one group per PR/issue with its derived phase.
 *
 * A sibling of the view above and shared the same way — the sidebar and the Tasks page must not
 * disagree — but PERSISTED, unlike it: grouping hides no task, so surviving a reload cannot hide
 * anything the user does not know about. Absent or unrecognised storage reads as `attention`,
 * which is also what every list rendered before this existed.
 */
export type ListGrouping = 'attention' | 'byReference'

export const LIST_GROUPING_STORAGE_KEY = 'cez.taskList.grouping'

export function readStoredGrouping(): ListGrouping {
  try {
    return localStorage.getItem(LIST_GROUPING_STORAGE_KEY) === 'byReference' ? 'byReference' : 'attention'
  } catch {
    // Private mode / no storage — the default still answers.
    return 'attention'
  }
}

function writeStoredGrouping(grouping: ListGrouping): void {
  try {
    localStorage.setItem(LIST_GROUPING_STORAGE_KEY, grouping)
  } catch {
    // Storage full or blocked — the choice still applies for this page.
  }
}

const ListGroupingContext = React.createContext<[ListGrouping, (grouping: ListGrouping) => void] | null>(null)

export function ListViewProvider({ children }: { children: ReactNode }) {
  const [view, setView] = React.useState<ListView>('active')
  const [grouping, setGroupingState] = React.useState<ListGrouping>(readStoredGrouping)
  const setGrouping = React.useCallback((next: ListGrouping) => {
    writeStoredGrouping(next)
    setGroupingState(next)
  }, [])
  // The tuples are memoized so a re-render of the provider (which sits high in the tree) does not
  // invalidate the context for every consumer below it.
  const value = React.useMemo(() => [view, setView] as [ListView, (view: ListView) => void], [view])
  const groupingValue = React.useMemo(
    () => [grouping, setGrouping] as [ListGrouping, (grouping: ListGrouping) => void],
    [grouping, setGrouping],
  )
  return (
    <ListViewContext.Provider value={value}>
      <ListGroupingContext.Provider value={groupingValue}>{children}</ListGroupingContext.Provider>
    </ListViewContext.Provider>
  )
}

/** Throws without a provider, on purpose: a default would let a consumer mount outside the shell
 *  and quietly keep its own private filter — the exact desync this context exists to prevent. */
export function useListView(): [ListView, (view: ListView) => void] {
  const value = React.useContext(ListViewContext)
  if (!value) throw new Error('useListView must be used inside a <ListViewProvider>')
  return value
}

/** Same contract as `useListView`: one shared value, and no private fallback. */
export function useListGrouping(): [ListGrouping, (grouping: ListGrouping) => void] {
  const value = React.useContext(ListGroupingContext)
  if (!value) throw new Error('useListGrouping must be used inside a <ListViewProvider>')
  return value
}
