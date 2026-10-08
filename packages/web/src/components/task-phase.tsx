import { ChevronDownIcon } from 'lucide-react'
import * as React from 'react'

import type { ListGrouping } from '@/components/list-view'
import { ReferenceChip } from '@/components/reference-chip'
import { useReferenceStatusLookup } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { useTrackerItemSignals, type TrackerItemSignal } from '@/api/queries'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { groupTrackerRefs, type PhaseLookups, type ReferenceGroup, type TaskPhase } from '@/lib/task-phases'
import { cn } from '@/lib/utils'

/**
 * The two pieces of the "By PR/issue" mode that both task lists paint the same way (spec
 * `2026-10-07-task-phases-by-pr-issue`, "UI/UX"): the Attention · By PR/issue toggle and the
 * phase badge. Presentational — which phase, and why, is `lib/task-phases.ts`'s decision.
 */

const GROUPING_OPTIONS: { value: ListGrouping; label: string }[] = [
  { value: 'attention', label: 'Attention' },
  { value: 'byReference', label: 'By PR/issue' },
]

/**
 * A two-option segmented control. `aria-pressed` toggle buttons, like the Active/Archived tabs
 * beside it — they regroup one list in place rather than switching panels — plus the radio-group
 * arrows the spec asks for, so a keyboard user flips it without tabbing between the halves.
 */
export function GroupingToggle({
  grouping,
  onChange,
  className,
}: {
  grouping: ListGrouping
  onChange: (grouping: ListGrouping) => void
  className?: string
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const next = (index + 1) % GROUPING_OPTIONS.length
    const option = GROUPING_OPTIONS[next]
    if (!option) return
    onChange(option.value)
    refs.current[next]?.focus()
  }
  return (
    <div
      role="group"
      aria-label="Group tasks"
      data-slot="grouping-toggle"
      className={cn('inline-flex gap-0.5 rounded-md bg-muted p-[3px]', className)}
    >
      {GROUPING_OPTIONS.map((option, index) => {
        const active = option.value === grouping
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node
            }}
            type="button"
            data-grouping={option.value}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'flex h-6 flex-1 items-center justify-center rounded-[6px] px-2 text-[11.5px] font-medium whitespace-nowrap text-muted-foreground',
              active && 'bg-card font-semibold text-foreground shadow-xs',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** Four distinct tones, and always the word as well — never colour alone. */
const PHASE_TONE: Record<TaskPhase, string> = {
  plan: 'bg-muted text-soft-foreground',
  implement: 'bg-pending/15 text-pending-strong',
  review: 'bg-violet/15 text-violet',
  delivery: 'bg-success/15 text-success',
}

export const PHASE_LABEL: Record<TaskPhase, string> = {
  plan: 'Plan',
  implement: 'Implement',
  review: 'Review',
  delivery: 'Delivery',
}

/**
 * A group's derived phase. The tooltip is the phase's `source` — the one thing that makes a
 * heuristic explainable on sight ("PR #12 · review-required"). `pending`: the forge has not
 * answered yet, so this is the task-layer guess, painted muted until it settles in place.
 */
export function PhaseBadge({
  phase,
  source,
  pending = false,
  className,
}: {
  phase: TaskPhase
  source: string
  pending?: boolean
  className?: string
}) {
  return (
    <span
      data-slot="phase-badge"
      data-phase={phase}
      data-pending={pending ? '' : undefined}
      title={pending ? `${source} · waiting for the forge` : source}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[10px] font-semibold tracking-[0.02em] uppercase',
        PHASE_TONE[phase],
        pending && 'opacity-60',
        className,
      )}
    >
      {PHASE_LABEL[phase]}
    </span>
  )
}

/**
 * The forge lookups a grouped list needs, read from the surrounding `ReferenceStatusProvider` —
 * the same cache every chip on the surface reads, so a group's phase and its chip can never
 * disagree about a PR's status. Outside a provider nothing is known and the tasks decide.
 */
export function useGroupPhaseLookups(): PhaseLookups {
  const { lookup, projectId } = useReferenceStatusLookup()
  const trackerOf = React.useContext(TrackerSignalsContext)
  return React.useMemo<PhaseLookups>(
    () => ({
      trackerOf,
      statusOf: (key) => {
        if (key.kind === 'tracker' || projectId === undefined) return undefined
        const entry = lookup({ projectId, kind: key.kind === 'pr' ? 'PR' : 'Issue', number: key.number })
        return { status: entry.status, pending: entry.state === 'loading' }
      },
      labelsOf: (key) => {
        if (key.kind === 'tracker' || projectId === undefined) return undefined
        return lookup({ projectId, kind: key.kind === 'pr' ? 'PR' : 'Issue', number: key.number }).labels
      },
    }),
    [lookup, projectId, trackerOf],
  )
}

type TrackerSignalLookup = (ref: { provider: string; key: string }) => TrackerItemSignal | undefined

/** Outside a provider nothing is known about any tracker item — the tasks decide. */
const TrackerSignalsContext = React.createContext<TrackerSignalLookup>(() => undefined)

/**
 * Reads the Jira/Linear items behind a list's `trackerRef`s (task phases, step 10) and hands
 * their status and labels to every grouped list below it. A provider rather than a call inside the
 * lists, for the same reason as `ReferenceStatusProvider`: the lists are presentational and render
 * in tests without a query client, and only a surface standing in the ACTIVE project may mount it —
 * the tracker routes answer for the scoped project, so another project's refs must never reach them.
 */
export function TrackerSignalsProvider({
  runs,
  children,
}: {
  runs: readonly RunRecord[]
  children: React.ReactNode
}) {
  const trackerOf = useTrackerItemSignals(groupTrackerRefs(runs))
  return <TrackerSignalsContext.Provider value={trackerOf}>{children}</TrackerSignalsContext.Provider>
}

/**
 * `[phase] [#123] title · counts · dot` — one group's header. The fold button and the chip are
 * SIBLINGS: the chip is a link to the forge, and a link inside a button is invalid.
 */
export function ReferenceGroupHeader({
  group,
  folded,
  onToggle,
  className,
}: {
  group: ReferenceGroup
  folded: boolean
  onToggle: () => void
  className?: string
}) {
  const { counts, attention, key } = group
  const countsLabel = [
    `${counts.tasks} task${counts.tasks === 1 ? '' : 's'}`,
    counts.needsYou ? `${counts.needsYou} need${counts.needsYou === 1 ? 's' : ''} you` : null,
    counts.working ? `${counts.working} working` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      data-slot="reference-group-header"
      className={cn('flex items-center gap-1.5 px-2.5 pt-2.5 pb-1', className)}
    >
      {group.phase ? <PhaseBadge phase={group.phase} source={group.source} pending={group.pending} /> : null}
      {key && key.kind !== 'tracker' ? (
        <ReferenceChip
          reference={{ kind: key.kind === 'pr' ? 'PR' : 'Issue', number: key.number, url: group.url }}
          taskTitle={group.title}
          compact
          className="h-auto shrink-0 gap-[2px] px-1.5 py-px text-[10.5px]"
        />
      ) : null}
      {/* A Jira/Linear key has no forge status to colour a chip with — a plain link to the item. */}
      {key?.kind === 'tracker' ? (
        <a
          href={group.url}
          target="_blank"
          rel="noreferrer"
          data-slot="tracker-chip"
          title={group.url}
          className="inline-flex shrink-0 items-center rounded-full border border-border px-1.5 py-px font-mono text-[10.5px] font-semibold text-muted-foreground hover:bg-muted"
        >
          {key.key}
        </a>
      ) : null}
      <button
        type="button"
        aria-expanded={!folded}
        onClick={onToggle}
        title={countsLabel}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
          {/* A forge key's chip already IS the reference, so the text spends itself on the counts;
              a tracker key and "No PR/issue" have no chip, so they lead with their title. */}
          {key && key.kind !== 'tracker' ? countsLabel : `${group.title} · ${countsLabel}`}
        </span>
        <StatusDot tone={attention.tone} pulse={attention.pulse} aria-label={attention.label} role="img" />
        <ChevronDownIcon
          className={cn('size-3 shrink-0 text-soft-foreground transition-transform', folded && '-rotate-90')}
          aria-hidden="true"
        />
      </button>
    </div>
  )
}

