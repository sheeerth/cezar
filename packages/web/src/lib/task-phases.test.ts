import { describe, expect, it } from 'vitest'

import type { ReferenceStatus, RunRecord } from '@open-mercato/cezar-api-client'
import { buildTaskTree } from '@/lib/task-tree'
import {
  TASK_PHASES,
  capReferenceGroups,
  deriveGroupPhase,
  filterGroupsByPhase,
  groupByReference,
  groupKeyId,
  groupKeyOf,
  groupStatusRequests,
  isPlanKind,
  phaseFilterCounts,
  phaseFromWords,
  runGroupKey,
  type ReferenceGroup,
  type TaskGroupKey,
  type TaskPhase,
} from '@/lib/task-phases'

let seq = 0

function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'quick-task',
    task: `task ${seq}`,
    status: 'done',
    createdAt: `2026-10-01T10:${String(seq % 60).padStart(2, '0')}:00.000Z`,
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

const child = (parent: RunRecord, over: Partial<RunRecord> = {}) =>
  run({ dispatch: { parentRunId: parent.id, rootRunId: parent.id, kind: 'implement' } as RunRecord['dispatch'], ...over })

const PR = (number: number): TaskGroupKey => ({ kind: 'pr', number })
const ISSUE = (number: number): TaskGroupKey => ({ kind: 'issue', number })

/** `id: run, run` per group — the assertions are about placement and order. */
function shape(groups: ReferenceGroup[]): string[] {
  return groups.map(
    (group) =>
      `${group.id}: ${group.rows
        .map((row) => (row.kind === 'group' ? `[${row.members.map((m) => m.variant).join('')}]` : row.run.id))
        .join(', ')}`,
  )
}

describe('isPlanKind', () => {
  it.each([
    ['/om-auto-write-spec build the thing', 'quick-task', true],
    ['/om-spec-writing', 'quick-task', true],
    ['/om-brainstorm should we', 'quick-task', true],
    ['/om-ux-shape the flow', 'quick-task', true],
    ['/om-auto-implement-spec 9', 'quick-task', false],
    ['/om-auto-review-pr 12', 'quick-task', false],
    ['fix the login bug', 'quick-task', false],
    ['write something', 'spec-writer', true],
    ['write something', 'design_review', false],
    ['write something', '(planned)', false],
  ])('%s on %s → %s', (task, workflow, expected) => {
    expect(isPlanKind(run({ task, workflow }))).toBe(expected)
  })

  it('reads agent step names when the prompt has no leading skill', () => {
    const steps = [{ id: 's', name: 'Plan the work', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 }] as RunRecord['steps']
    expect(isPlanKind(run({ steps }))).toBe(true)
  })

  it('a dispatched child is never plan-kind — its dispatch kind says what it is for', () => {
    const parent = run({ task: '/om-auto-write-spec' })
    expect(isPlanKind(child(parent, { task: '/om-auto-write-spec' }))).toBe(false)
  })
})

describe('runGroupKey / groupKeyOf', () => {
  it('takes the first reference in taskReferences order: created PR, then issue', () => {
    expect(runGroupKey(run({ pullRequestUrl: 'https://github.com/o/r/pull/12', issueNumber: 3 }))).toEqual(PR(12))
    expect(runGroupKey(run({ issueNumber: 3 }))).toEqual(ISSUE(3))
    expect(runGroupKey(run({ markerRefs: { pr: 7 } }))).toEqual(PR(7))
    expect(runGroupKey(run())).toBeNull()
  })

  it('inherits depth-first from the dispatch subtree when the root has no reference', () => {
    const root = run()
    const a = child(root)
    const b = child(a, { prNumber: 44 })
    const [tree] = buildTaskTree([root, a, b])
    expect(groupKeyOf(tree!)).toEqual(PR(44))
  })
})

describe('deriveGroupPhase', () => {
  const impl = run({ status: 'done' })
  const plan = run({ task: '/om-auto-write-spec x', status: 'done' })

  const forgeTable: [ReferenceStatus, TaskPhase | 'tasks'][] = [
    ['merged', 'delivery'],
    ['ready', 'delivery'],
    ['completed', 'delivery'],
    ['review-required', 'review'],
    ['changes-requested', 'review'],
    ['checks-pending', 'review'],
    ['checks-failing', 'review'],
    ['draft', 'implement'],
    ['closed', 'tasks'],
    ['open', 'tasks'],
    ['not-planned', 'tasks'],
  ]
  it.each(forgeTable)('forge %s → %s', (status, expected) => {
    const derived = deriveGroupPhase({ key: PR(1), keyStatus: status, members: [impl] })
    if (expected === 'tasks') {
      expect(derived.layer).toBe('tasks')
      expect(derived.phase).toBe('implement')
    } else {
      expect(derived).toMatchObject({ phase: expected, layer: 'forge' })
      expect(derived.source).toBe(`PR #1 · ${status}`)
    }
  })

  it('a plan-only group with an open PR stays in plan', () => {
    expect(deriveGroupPhase({ key: PR(1), keyStatus: 'review-required', members: [plan] }).phase).toBe('plan')
    expect(deriveGroupPhase({ key: PR(1), keyStatus: 'draft', members: [plan] }).phase).toBe('plan')
    expect(deriveGroupPhase({ key: PR(1), keyStatus: 'merged', members: [plan] }).phase).toBe('delivery')
    // One implementation task breaks the plan-only override.
    expect(deriveGroupPhase({ key: PR(1), keyStatus: 'review-required', members: [plan, impl] }).phase).toBe('review')
  })

  it('labels: review + qa → delivery (most advanced wins inside a source)', () => {
    const derived = deriveGroupPhase({ key: PR(1), keyLabels: ['review', 'qa'], members: [impl] })
    expect(derived).toMatchObject({ phase: 'delivery', layer: 'labels', source: 'label `qa`' })
  })

  it('layer 2 reads key labels, then tracker status, then tracker labels — first matching source decides', () => {
    const tracker = { key: 'ABC-41', status: 'In Progress', labels: ['qa'] }
    expect(deriveGroupPhase({ key: PR(1), keyLabels: ['needs-spec'], tracker, members: [impl] }).phase).toBe('plan')
    expect(deriveGroupPhase({ key: PR(1), keyLabels: ['bug'], tracker, members: [impl] })).toMatchObject({
      phase: 'implement',
      source: 'ABC-41 · In Progress',
    })
    expect(
      deriveGroupPhase({ key: PR(1), tracker: { key: 'ABC-41', status: 'Blocked', labels: ['qa'] }, members: [impl] }),
    ).toMatchObject({ phase: 'delivery', layer: 'tracker' })
  })

  it('the forge beats labels', () => {
    expect(deriveGroupPhase({ key: PR(1), keyStatus: 'merged', keyLabels: ['wip'], members: [impl] }).phase).toBe('delivery')
  })

  it('tasks layer: review status, running review child, implement, plan only', () => {
    expect(deriveGroupPhase({ key: PR(1), members: [run({ status: 'review' })] }).phase).toBe('review')
    const parent = run({ status: 'running' })
    const reviewer = child(parent, {
      status: 'running',
      dispatch: { parentRunId: parent.id, rootRunId: parent.id, kind: 'review' } as RunRecord['dispatch'],
    })
    expect(deriveGroupPhase({ key: PR(1), members: [parent, reviewer] }).phase).toBe('review')
    expect(deriveGroupPhase({ key: PR(1), members: [impl] }).phase).toBe('implement')
    expect(deriveGroupPhase({ key: PR(1), members: [plan] }).phase).toBe('plan')
  })

  it('no key → no phase; no signals and no members → no phase', () => {
    expect(deriveGroupPhase({ key: null, members: [impl] })).toEqual({ phase: null, source: '', layer: null })
    expect(deriveGroupPhase({ key: PR(1), members: [] }).phase).toBeNull()
  })

  it('vocabulary is whole-word and treats -/_ as spaces', () => {
    expect(phaseFromWords('In-Review')).toBe('review')
    expect(phaseFromWords('status: to_do')).toBe('plan')
    expect(phaseFromWords('reviewer-needed')).toBeNull()
    expect(phaseFromWords('quality')).toBeNull()
    expect(TASK_PHASES).toEqual(['plan', 'implement', 'review', 'delivery'])
  })
})

describe('groupByReference', () => {
  it('puts a subtree in its root group and leaves unreferenced tasks in "No PR/issue", last', () => {
    const root = run({ prNumber: 10, status: 'done' })
    const kid = child(root, { status: 'running' })
    const loner = run({ status: 'waiting' })
    const groups = groupByReference([root, kid, loner], 'active')
    expect(shape(groups)).toEqual([`pr#10: ${kid.id}, ${root.id}`, `none: ${loner.id}`])
    expect(groups[1]).toMatchObject({ key: null, phase: null, title: 'No PR/issue' })
  })

  it('a root without a reference joins the PR its child opened', () => {
    const root = run()
    const kid = child(root, { pullRequestUrl: 'https://github.com/o/r/pull/5' })
    // Rows keep `sortRuns` order (newest first); the renderer nests the child under its parent.
    expect(shape(groupByReference([root, kid], 'active'))).toEqual([`pr#5: ${kid.id}, ${root.id}`])
  })

  it('declaring a CEZ:PR in a child moves the whole subtree (the intended transition)', () => {
    const root = run({ issueNumber: 3 })
    const kid = child(root)
    expect(groupByReference([root, kid], 'active').map((g) => g.id)).toEqual(['issue#3'])
    // The root's own issue still wins — the child's PR only applies when the root has nothing.
    const bare = run()
    const bareKid = child(bare)
    expect(groupByReference([bare, bareKid], 'active').map((g) => g.id)).toEqual(['none'])
    const declared = { ...bareKid, markerRefs: { pr: 21 } }
    expect(groupByReference([bare, declared], 'active').map((g) => g.id)).toEqual(['pr#21'])
  })

  it('a variant tile joins the first member, by letter, that has a reference', () => {
    const a = run({ groupId: 'g', variant: 'A', title: 'X (A)' })
    const b = run({ groupId: 'g', variant: 'B', title: 'X (B)', prNumber: 8 })
    const c = run({ groupId: 'g', variant: 'C', title: 'X (C)', prNumber: 9 })
    const groups = groupByReference([c, b, a], 'active')
    expect(shape(groups)).toEqual(['pr#8: [ABC]'])
  })

  it('the key never depends on reference statuses', () => {
    const runs = [run({ prNumber: 1 }), run({ issueNumber: 2 }), run()]
    const plain = groupByReference(runs, 'active').map((g) => g.id)
    for (const status of ['merged', 'closed', 'draft'] as const) {
      expect(groupByReference(runs, 'active', { statusOf: () => ({ status }) }).map((g) => g.id).sort()).toEqual(
        [...plain].sort(),
      )
    }
  })

  it('rows obey the view; phase inputs read every member (A9)', () => {
    const planActive = run({ prNumber: 4, task: '/om-auto-write-spec', status: 'done' })
    const implArchived = run({ prNumber: 4, status: 'done', archived: true })
    const statusOf = () => ({ status: 'review-required' as const })
    const active = groupByReference([planActive, implArchived], 'active', { statusOf })
    const archived = groupByReference([planActive, implArchived], 'archived', { statusOf })
    expect(shape(active)).toEqual([`pr#4: ${planActive.id}`])
    expect(shape(archived)).toEqual([`pr#4: ${implArchived.id}`])
    // Not plan-only across BOTH views, so review in both.
    expect(active[0]!.phase).toBe('review')
    expect(archived[0]!.phase).toBe('review')
  })

  it('orders groups by most urgent attention, then newest activity', () => {
    const old = run({ prNumber: 1, status: 'done', createdAt: '2026-10-01T09:00:00.000Z' })
    const recent = run({ prNumber: 2, status: 'done', createdAt: '2026-10-02T09:00:00.000Z' })
    const urgent = run({ prNumber: 3, status: 'waiting', createdAt: '2026-09-01T09:00:00.000Z' })
    const groups = groupByReference([old, recent, urgent], 'active')
    expect(groups.map((g) => g.id)).toEqual(['pr#3', 'pr#2', 'pr#1'])
    expect(groups[0]!.attention.bucket).toBe('waiting')
    expect(groups[0]!.counts).toEqual({ tasks: 1, needsYou: 1, working: 0 })
  })

  it('marks a group pending while the forge has not answered, with the task-layer phase', () => {
    const groups = groupByReference([run({ prNumber: 1 })], 'active', { statusOf: () => ({ pending: true }) })
    expect(groups[0]).toMatchObject({ pending: true, phase: 'implement' })
  })
})

describe('filters, counts, cap and requests', () => {
  const groups = groupByReference(
    [
      run({ prNumber: 1, status: 'review' }),
      run({ prNumber: 2, task: '/om-spec-writing' }),
      run({ prNumber: 3 }),
      run(),
    ],
    'active',
  )

  it('filters whole groups by phase, "none" being the No PR/issue group', () => {
    expect(filterGroupsByPhase(groups, 'review').map((g) => g.id)).toEqual(['pr#1'])
    expect(filterGroupsByPhase(groups, 'plan').map((g) => g.id)).toEqual(['pr#2'])
    expect(filterGroupsByPhase(groups, 'none').map((g) => g.id)).toEqual(['none'])
    expect(filterGroupsByPhase(groups, 'all')).toHaveLength(4)
    expect(phaseFilterCounts(groups)).toEqual({ all: 4, plan: 1, implement: 1, review: 1, delivery: 0, none: 1 })
  })

  it('caps rows across groups and reports what each group lost', () => {
    const many = groupByReference(
      [run({ prNumber: 1, status: 'waiting' }), run({ prNumber: 1, status: 'waiting' }), run({ prNumber: 2 })],
      'active',
    )
    const capped = capReferenceGroups(many, 1)
    expect(capped).toHaveLength(1)
    expect(capped[0]).toMatchObject({ id: 'pr#1', hidden: 1 })
    expect(capped[0]!.rows).toHaveLength(1)
  })

  it('asks the forge about every keyed group', () => {
    expect(groupStatusRequests(groups)).toEqual(
      expect.arrayContaining([
        { kind: 'PR', number: 1 },
        { kind: 'PR', number: 2 },
        { kind: 'PR', number: 3 },
      ]),
    )
    expect(groupKeyId(null)).toBe('none')
    expect(groupKeyId({ kind: 'tracker', provider: 'jira', key: 'ABC-1' })).toBe('tracker:jira:ABC-1')
  })
})
