import type { ReferenceStatus, RunRecord } from '@open-mercato/cezar-api-client'
import { ATTENTION_RANK, deriveAttention, isNeedsYouStatus, type Attention } from './attention'
import { groupTitle, queuePositions, sortRuns, type ListView, type QuickListRow } from './task-groups'
import { buildTaskTree, type TaskTreeNode } from './task-tree'
import { taskReferences } from './tasks-table'

/**
 * The "By PR/issue" task list (spec `.ai/specs/2026-10-07-task-phases-by-pr-issue.md`): every
 * task, with its dispatch subtree and its variants, in exactly ONE group keyed by its first PR,
 * else its first issue — and a DERIVED SDLC phase per group.
 *
 * Pure, React-free and Node-free on purpose, like `task-groups.ts` beside it: the grouping and
 * the phase rules are the behavior worth testing, and they are testable as tables. Nothing is
 * stored and nothing is configurable — the phase is recomputed from what cezar already knows
 * (the forge's reference status, the group's tasks) every time the list paints.
 *
 * The phase enum and the key type live HERE until a route carries them (spec, A3): the day a
 * stored phase or `cez mcp` exposes one, they move to `packages/contract` as zod schemas.
 * When syncing the fork with upstream (open-mercato/cezar#1277 may pick other names),
 * `TASK_PHASES` is the one place to reconcile.
 */

export const TASK_PHASES = ['plan', 'implement', 'review', 'delivery'] as const
export type TaskPhase = (typeof TASK_PHASES)[number]

/** How far along each phase is — "most advanced wins" inside one layer-2 source. */
const PHASE_RANK: Record<TaskPhase, number> = { plan: 0, implement: 1, review: 2, delivery: 3 }

export type TaskGroupKey =
  | { kind: 'pr'; number: number }
  | { kind: 'issue'; number: number }
  | { kind: 'tracker'; provider: 'jira' | 'linear'; key: string }

/** A stable string for a key — map keys, React keys, `data-group` attributes. */
export function groupKeyId(key: TaskGroupKey | null): string {
  if (key === null) return 'none'
  if (key.kind === 'tracker') return `tracker:${key.provider}:${key.key}`
  return `${key.kind}#${key.number}`
}

/** `#12` for a forge key, `ABC-41` for a tracker one — what a group header's chip prints. */
export function groupKeyLabel(key: TaskGroupKey): string {
  return key.kind === 'tracker' ? key.key : `#${key.number}`
}

/** What the phase filter offers: the four phases, plus the "No PR/issue" group. */
export type PhaseFilter = 'all' | TaskPhase | 'none'

// ── Plan-kind (spec A7) ──────────────────────────────────────────────────────────────────────

/** Words that make a task plan-kind: it writes the spec, it does not build the thing. */
const PLAN_HINTS = ['spec', 'plan', 'brainstorm', 'design', 'shape'] as const
/**
 * Words that override a plan hint in the SAME text. `om-auto-implement-spec` names a spec, but
 * it builds one; without this every implementation of a spec would read as planning, and a PR
 * whose only task is that implementation would be stuck at "plan" forever.
 */
const BUILD_HINTS = ['implement', 'implementation', 'fix', 'build', 'review', 'qa'] as const

/** Lower-case, every non-alphanumeric run (`-`, `_`, `:`, `/`) collapsed to one space. */
function normalizeWords(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
}

function hasWord(normalized: string, phrase: string): boolean {
  return normalized.includes(` ${phrase} `)
}

/** `/om-auto-write-spec do the thing` → `om-auto-write-spec`. Undefined without a leading slash. */
function leadingSkill(task: string): string | undefined {
  return /^\s*\/([\w:.-]+)/.exec(task)?.[1]
}

export type PlanKindInput = Pick<RunRecord, 'workflow' | 'task' | 'steps' | 'dispatch'>

/**
 * Whether a task is planning work rather than building, reviewing or shipping it.
 *
 * A dispatched child says what it is for (`kind`), so that answers first. Otherwise the prompt's
 * leading `/skill` is the most specific statement there is, and decides alone when present; only
 * without one do the workflow name and its step names speak — the built-in `quick-task`
 * ("Do the task") says nothing, which is "not plan".
 */
export function isPlanKind(run: PlanKindInput): boolean {
  if (run.dispatch?.parentRunId !== undefined) return false
  const skill = leadingSkill(run.task)
  const text = normalizeWords(
    skill ?? [run.workflow, ...run.steps.filter((step) => step.kind === 'agent').map((step) => step.name)].join(' '),
  )
  if (BUILD_HINTS.some((word) => hasWord(text, word))) return false
  return PLAN_HINTS.some((word) => hasWord(text, word))
}

// ── Group keys ───────────────────────────────────────────────────────────────────────────────

export type GroupKeyInput = Parameters<typeof taskReferences>[0]

/** The run's OWN key: its first reference in `taskReferences` order (PRs strongest-first, then
 *  issues). Null when it knows none. */
export function runGroupKey(run: GroupKeyInput, repoBase?: string): TaskGroupKey | null {
  const first = taskReferences(run, repoBase)[0]
  if (!first) return null
  return { kind: first.kind === 'PR' ? 'pr' : 'issue', number: first.number }
}

/**
 * A tree node's key: its own, else the first one found depth-first in its dispatch subtree — a
 * root that ordered a child which then opened a PR belongs to that PR.
 *
 * The children are walked in the order the node carries them; `groupByReference` builds the tree
 * in CREATION order, so "first" never depends on a status (see the stability note there).
 */
export function groupKeyOf<T extends GroupKeyInput & { id: string }>(
  node: TaskTreeNode<T>,
  repoBase?: string,
): TaskGroupKey | null {
  const own = runGroupKey(node.run, repoBase)
  if (own) return own
  for (const child of node.children) {
    const found = groupKeyOf(child, repoBase)
    if (found) return found
  }
  return null
}

// ── Phase rules ──────────────────────────────────────────────────────────────────────────────

const REVIEW_STATUSES: ReadonlySet<ReferenceStatus> = new Set([
  'review-required',
  'changes-requested',
  'checks-pending',
  'checks-failing',
])

/** Layer-2 vocabulary. Matched as whole words, case-insensitive, `-`/`_` read as spaces. */
const PHASE_WORDS: Record<TaskPhase, readonly string[]> = {
  delivery: ['merge queue', 'qa', 'qa approved', 'done', 'released', 'deployed', 'shipped', 'resolved'],
  review: ['review', 'in review', 'code review', 'changes requested'],
  implement: ['in progress', 'in development', 'doing', 'wip', 'implementing'],
  plan: ['backlog', 'todo', 'to do', 'triage', 'spec', 'needs spec', 'design', 'planning', 'refinement'],
}

/** The phase one piece of text names, or null. When it names several, the most advanced wins. */
export function phaseFromWords(text: string): TaskPhase | null {
  const normalized = normalizeWords(text)
  let best: TaskPhase | null = null
  for (const phase of TASK_PHASES) {
    if (PHASE_WORDS[phase].some((phrase) => hasWord(normalized, phrase))) {
      if (best === null || PHASE_RANK[phase] > PHASE_RANK[best]) best = phase
    }
  }
  return best
}

/** The most advanced phase any of `texts` names, with the text that named it. */
function phaseFromTexts(texts: readonly string[]): { phase: TaskPhase; text: string } | null {
  let best: { phase: TaskPhase; text: string } | null = null
  for (const text of texts) {
    const phase = phaseFromWords(text)
    if (phase && (best === null || PHASE_RANK[phase] > PHASE_RANK[best.phase])) best = { phase, text }
  }
  return best
}

export type PhaseMemberInput = PlanKindInput & Pick<RunRecord, 'status'>

export interface PhaseSignals {
  /** The group's key; null is the "No PR/issue" group, which has no phase. */
  key: TaskGroupKey | null
  /** The forge's reference status for the key, when it has answered. */
  keyStatus?: ReferenceStatus | undefined
  /** Labels on the key PR/issue (layer 2a). */
  keyLabels?: readonly string[] | undefined
  /** The tracker item of the newest member that carries one (layers 2b and 2c). */
  tracker?: { key: string; status?: string | undefined; labels?: readonly string[] | undefined } | undefined
  /** EVERY member of the group, whatever the Active/Archived view (spec A9). */
  members: readonly PhaseMemberInput[]
}

export type PhaseLayer = 'forge' | 'labels' | 'tracker' | 'tasks'

export interface DerivedPhase {
  phase: TaskPhase | null
  /** What decided it, in words — the badge's tooltip. Empty for the "No PR/issue" group. */
  source: string
  layer: PhaseLayer | null
}

const NO_PHASE: DerivedPhase = { phase: null, source: '', layer: null }

/**
 * The derived phase of one group (spec, "Phase rules"). Layers, first that yields wins:
 *
 *  1. The forge state of the key — the freshest fact cezar has about the PR. A plan-only group
 *     (every task plan-kind) with an open PR stays in plan: a spec PR in review is still planning.
 *  2. Labels on the key → the tracker item's status → the tracker item's labels, in that order;
 *     the first SOURCE that matches decides, and inside it the most advanced phase wins.
 *  3. The tasks: one in review → review; any non-plan task → implement; only plan tasks → plan.
 *
 * Layer 1 beats labels because it is fresher; labels beat tasks because a label is a human
 * statement about the work, and the tasks are only cezar's own activity.
 */
export function deriveGroupPhase(signals: PhaseSignals): DerivedPhase {
  const { key, members } = signals
  if (key === null) return NO_PHASE
  const planOnly = members.length > 0 && members.every(isPlanKind)
  const keyName = key.kind === 'tracker' ? key.key : `${key.kind === 'pr' ? 'PR' : 'Issue'} #${key.number}`

  // Layer 1. Read by status VALUE rather than by key kind: the forge files a number under what it
  // really is, and a "PR" the task stored that is really an issue answers with an issue status.
  const status = signals.keyStatus
  if (status !== undefined) {
    const source = `${keyName} · ${status}`
    if (status === 'merged' || status === 'ready' || status === 'completed') {
      return { phase: 'delivery', source, layer: 'forge' }
    }
    if (REVIEW_STATUSES.has(status)) {
      return planOnly
        ? { phase: 'plan', source: `${source} · plan tasks only`, layer: 'forge' }
        : { phase: 'review', source, layer: 'forge' }
    }
    if (status === 'draft') {
      return planOnly
        ? { phase: 'plan', source: `${source} · plan tasks only`, layer: 'forge' }
        : { phase: 'implement', source, layer: 'forge' }
    }
    // `closed`, `open`, `not-planned`: no signal — the next layer decides (spec A8).
  }

  // Layer 2.
  const keyLabel = phaseFromTexts(signals.keyLabels ?? [])
  if (keyLabel) return { phase: keyLabel.phase, source: `label \`${keyLabel.text}\``, layer: 'labels' }
  const tracker = signals.tracker
  if (tracker) {
    const trackerStatus = tracker.status ? phaseFromWords(tracker.status) : null
    if (trackerStatus && tracker.status) {
      return { phase: trackerStatus, source: `${tracker.key} · ${tracker.status}`, layer: 'tracker' }
    }
    const trackerLabel = phaseFromTexts(tracker.labels ?? [])
    if (trackerLabel) {
      return { phase: trackerLabel.phase, source: `${tracker.key} label \`${trackerLabel.text}\``, layer: 'tracker' }
    }
  }

  // Layer 3.
  if (members.length === 0) return NO_PHASE
  const inReview = members.filter(
    (run) =>
      run.status === 'review' ||
      (run.status === 'running' && run.dispatch?.parentRunId !== undefined && run.dispatch.kind === 'review'),
  ).length
  if (inReview > 0) {
    return { phase: 'review', source: `from tasks · ${inReview} task${inReview === 1 ? '' : 's'} in review`, layer: 'tasks' }
  }
  if (!planOnly) return { phase: 'implement', source: 'from tasks · implementation work', layer: 'tasks' }
  return { phase: 'plan', source: 'from tasks · plan tasks only', layer: 'tasks' }
}

// ── Grouping ─────────────────────────────────────────────────────────────────────────────────

/** What a group's phase inputs need from the outside world, per key. All optional: without a
 *  lookup the forge layers stay silent and the tasks decide. */
export interface PhaseLookups {
  repoBase?: string | undefined
  /** The forge's answer for a PR/issue key — `pending` while it is still being asked. */
  statusOf?: ((key: TaskGroupKey) => { status?: ReferenceStatus | undefined; pending?: boolean } | undefined) | undefined
  labelsOf?: ((key: TaskGroupKey) => readonly string[] | undefined) | undefined
}

export interface GroupCounts {
  tasks: number
  needsYou: number
  working: number
}

export interface ReferenceGroup {
  key: TaskGroupKey | null
  /** `groupKeyId(key)` — stable across renders. */
  id: string
  phase: TaskPhase | null
  source: string
  /** True while the forge has not answered for the key: the badge shows the task-layer phase,
   *  muted, and settles in place when the answer arrives. */
  pending: boolean
  /** A tracker key has no number to show as the title, so the group borrows its root task's. */
  title: string
  /** Where the key's chip links — the first member reference that names it with a URL. */
  url?: string
  /** The rows in view, in `sortRuns` order, variants collapsed — the existing row shape. */
  rows: QuickListRow[]
  attention: Attention
  counts: GroupCounts
}

const activityOf = (run: RunRecord): string => run.finishedAt ?? run.startedAt ?? run.createdAt

const NO_ATTENTION: Attention = { bucket: 'none', tone: 'neutral', pulse: false, label: 'idle' }

/** The most urgent member's attention — the lowest `ATTENTION_RANK`, first wins on a tie. */
export function groupAttention(members: readonly RunRecord[]): Attention {
  let best: Attention | null = null
  for (const run of members) {
    const attention = deriveAttention(run)
    if (best === null || ATTENTION_RANK[attention.bucket] < ATTENTION_RANK[best.bucket]) best = attention
  }
  return best ?? NO_ATTENTION
}

/**
 * The whole list as reference groups (spec, "Proposed Solution").
 *
 * Membership reads ALL runs, active and archived alike, and so do the phase inputs (A9): a PR's
 * phase must not change with the tab the user is on. Only the ROWS obey the view — a group with
 * nothing in view is not painted at all.
 *
 * STABILITY: a key is a function of the run records alone — never of a reference status or a
 * label — so a status refresh never regroups anything. The tree is built in creation order for the
 * same reason: `sortRuns` ranks by status, and a depth-first walk in that order would let a child
 * finishing reshuffle which reference its root inherits.
 */
export function groupByReference(
  runs: readonly RunRecord[],
  view: ListView,
  lookups: PhaseLookups = {},
): ReferenceGroup[] {
  const byCreation = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const roots = buildTaskTree(byCreation)

  // Every root's own key (own reference, else depth-first in its subtree).
  const rootKey = new Map<string, TaskGroupKey | null>()
  for (const root of roots) rootKey.set(root.run.id, groupKeyOf(root, lookups.repoBase))

  // Variants (spec 010) travel as a tile, so they share one key: the first member, BY LETTER,
  // that has one.
  const variantKey = new Map<string, TaskGroupKey | null>()
  const variantRoots = roots
    .filter((root) => root.run.groupId)
    .sort((a, b) => (a.run.variant ?? '').localeCompare(b.run.variant ?? ''))
  for (const root of variantRoots) {
    const groupId = root.run.groupId as string
    if (variantKey.get(groupId)) continue
    variantKey.set(groupId, rootKey.get(root.run.id) ?? null)
  }

  // Every run inherits its root's key: the whole subtree joins the root's group.
  const keyOfRun = new Map<string, TaskGroupKey | null>()
  const assign = (node: TaskTreeNode<RunRecord>, key: TaskGroupKey | null) => {
    keyOfRun.set(node.run.id, key)
    for (const child of node.children) assign(child, key)
  }
  for (const root of roots) {
    const key = root.run.groupId ? (variantKey.get(root.run.groupId) ?? null) : (rootKey.get(root.run.id) ?? null)
    assign(root, key)
  }

  const groupIdOfRun = (run: RunRecord) => groupKeyId(keyOfRun.get(run.id) ?? null)

  // ALL members per group — the phase inputs.
  const allMembers = new Map<string, RunRecord[]>()
  const keys = new Map<string, TaskGroupKey | null>()
  for (const run of byCreation) {
    const id = groupIdOfRun(run)
    keys.set(id, keyOfRun.get(run.id) ?? null)
    const list = allMembers.get(id)
    if (list) list.push(run)
    else allMembers.set(id, [run])
  }

  // The painted rows, exactly as `groupRuns` builds them — same view filter, same order, same
  // variant collapsing — only filed by group instead of by attention bucket.
  const positions = queuePositions(runs)
  const sorted = sortRuns(runs, view)
  const rowsByGroup = new Map<string, QuickListRow[]>()
  const visibleByGroup = new Map<string, RunRecord[]>()
  const seenVariants = new Set<string>()
  for (const run of sorted) {
    const id = groupIdOfRun(run)
    const visible = visibleByGroup.get(id)
    if (visible) visible.push(run)
    else visibleByGroup.set(id, [run])
    let row: QuickListRow | null = { kind: 'run', run, queuePosition: positions.get(run.id) ?? null }
    if (run.groupId) {
      if (seenVariants.has(run.groupId)) row = null
      else {
        seenVariants.add(run.groupId)
        const members = sorted
          .filter((member) => member.groupId === run.groupId)
          .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''))
        if (members.length > 1) row = { kind: 'group', groupId: run.groupId, title: groupTitle(run), members }
      }
    }
    if (row === null) continue
    const rows = rowsByGroup.get(id)
    if (rows) rows.push(row)
    else rowsByGroup.set(id, [row])
  }

  const groups: (ReferenceGroup & { activity: string })[] = []
  for (const [id, rows] of rowsByGroup) {
    const key = keys.get(id) ?? null
    const members = allMembers.get(id) ?? []
    const visible = visibleByGroup.get(id) ?? []
    const forge = key && key.kind !== 'tracker' ? lookups.statusOf?.(key) : undefined
    const derived = deriveGroupPhase({
      key,
      keyStatus: forge?.status,
      keyLabels: key ? lookups.labelsOf?.(key) : undefined,
      members,
    })
    const root = members.find((run) => run.dispatch?.parentRunId === undefined) ?? members[0]
    const url = key && key.kind !== 'tracker' ? keyUrl(key, members, lookups.repoBase) : undefined
    groups.push({
      ...(url ? { url } : {}),
      key,
      id,
      phase: derived.phase,
      source: derived.source,
      pending: Boolean(forge?.pending) && forge?.status === undefined,
      title: key === null ? 'No PR/issue' : key.kind === 'tracker' && root ? groupTitle(root) : groupKeyLabel(key),
      rows,
      attention: groupAttention(visible),
      counts: {
        tasks: visible.length,
        needsYou: visible.filter(isNeedsYouStatus).length,
        working: visible.filter((run) => run.status === 'running' || run.status === 'queued').length,
      },
      activity: visible.reduce((latest, run) => (activityOf(run) > latest ? activityOf(run) : latest), ''),
    })
  }

  // Most urgent first, then the most recently active; "No PR/issue" always last.
  groups.sort((a, b) => {
    if ((a.key === null) !== (b.key === null)) return a.key === null ? 1 : -1
    const urgency = ATTENTION_RANK[a.attention.bucket] - ATTENTION_RANK[b.attention.bucket]
    if (urgency !== 0) return urgency
    return b.activity.localeCompare(a.activity)
  })
  return groups.map(({ activity: _activity, ...group }) => group)
}

function keyUrl(key: TaskGroupKey & { number: number }, members: readonly RunRecord[], repoBase?: string) {
  const kind = key.kind === 'pr' ? 'PR' : 'Issue'
  for (const run of members) {
    const match = taskReferences(run, repoBase).find((ref) => ref.kind === kind && ref.number === key.number && ref.url)
    if (match?.url) return match.url
  }
  return undefined
}

/** Which filter value a group answers to. */
export function groupPhaseFilter(group: Pick<ReferenceGroup, 'key' | 'phase'>): Exclude<PhaseFilter, 'all'> {
  return group.key === null || group.phase === null ? 'none' : group.phase
}

/** The phase filter: whole groups, never individual tasks. */
export function filterGroupsByPhase<G extends Pick<ReferenceGroup, 'key' | 'phase'>>(
  groups: readonly G[],
  filter: PhaseFilter,
): G[] {
  if (filter === 'all') return [...groups]
  return groups.filter((group) => groupPhaseFilter(group) === filter)
}

/** Groups per filter chip, `all` included. */
export function phaseFilterCounts(groups: readonly Pick<ReferenceGroup, 'key' | 'phase'>[]): Record<PhaseFilter, number> {
  const counts: Record<PhaseFilter, number> = { all: groups.length, plan: 0, implement: 0, review: 0, delivery: 0, none: 0 }
  for (const group of groups) counts[groupPhaseFilter(group)] += 1
  return counts
}

/**
 * Cap the grouped list at `limit` rows ACROSS groups, in group order (the sidebar's ten rows per
 * project). A collapsed variant tile is one row. A group cut short says how many rows it lost
 * (`hidden`), so it can offer "+k more"; a group the cap reached with no room left is dropped,
 * and the project's own "More…" link is the way to it.
 */
export function capReferenceGroups<G extends Pick<ReferenceGroup, 'rows'>>(
  groups: readonly G[],
  limit: number,
): (G & { hidden: number })[] {
  const capped: (G & { hidden: number })[] = []
  let remaining = limit
  for (const group of groups) {
    if (remaining <= 0) break
    const rows = group.rows.slice(0, remaining)
    remaining -= rows.length
    capped.push({ ...group, rows, hidden: group.rows.length - rows.length })
  }
  return capped
}

/** Every PR/issue key a grouped list needs a forge status for — what a surface adds to its
 *  `ReferenceStatusProvider` requests, because a key can come from a child row nobody painted. */
export function groupStatusRequests(
  groups: readonly Pick<ReferenceGroup, 'key'>[],
): { kind: 'PR' | 'Issue'; number: number }[] {
  return groups.flatMap((group) =>
    group.key && group.key.kind !== 'tracker'
      ? [{ kind: group.key.kind === 'pr' ? ('PR' as const) : ('Issue' as const), number: group.key.number }]
      : [],
  )
}
