import * as React from 'react'

import type { ListGrouping } from '@/components/list-view'
import type { TaskPhase } from '@/lib/task-phases'
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
  implement: 'bg-pending/15 text-pending',
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
