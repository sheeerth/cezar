# Task list grouped by PR/issue with a derived SDLC phase per group (slice 1 of task phases)

- Date: 2026-10-07
- Category: feature
- Priority signal: medium — the user supervises many parallel tasks and cannot see at a glance what needs them vs what is waiting
- Risk signal: medium — a new cockpit list view and a derived read model over existing data; no new persisted state, no tracker writes
- Routing: Next: om-auto-write-spec "Task list grouped by PR/issue with a derived SDLC phase per group (plan/implement/review/delivery) — slice 1 of task phases; fork sheeerth/cezar only, PR against sheeerth/cezar main, never open-mercato — brief: .ai/specs/briefs/2026-10-07-task-phases-by-pr-issue.md"

**Target repository: the fork `sheeerth/cezar`.** Every PR from this work is opened against `sheeerth/cezar` `main` (git remote `fork`), never against `open-mercato/cezar` (remote `origin`). Nothing is published upstream.

## Problem

The user runs many cezar tasks in parallel, often several per PR or issue (spec, implementation, review, fixes), and supervises them from a Claude Code session through `cez mcp`. They want to see at a glance which piece of work is in which SDLC phase — plan, implement, review, delivery — so they can tell what they should handle now and what is waiting. Today the task list groups by attention bucket (Pinned / Needs you / Working / Recent, `packages/web/src/lib/task-groups.ts`), so the tasks of one PR are scattered across buckets, and no phase exists anywhere. Tasks have no tags; only projects do.

## Agreed direction

**Slice 1 (this spec):**

- A **"by PR/issue" view** of the task list, toggled next to the current one, that **replaces** the attention buckets while active (grouping inside each bucket was rejected: one PR would show up in two places).
- **Group key:** a task's first PR reference, else its first issue reference — from the fields runs already carry (`prNumber`, `prRefs`, `issueNumber`, `markerRefs` from `CEZ:PR` / `CEZ:ISSUE`, auto-discovered references). A task joins exactly one group. Dispatch children and variants stay under their parent as today; the group holds the whole subtree. Tasks with no PR/issue go to a "no PR/issue" group with no phase.
- **Phase is a property of the PR/issue (the group), not of a single task** — cezar tasks are mostly single-purpose, so a per-task phase would barely move.
- **Derived phase per group** (plan / implement / review / delivery), computed from data cezar already has, with zero-config default rules:
  - PR reference status (`referenceStatusSchema`: draft, review-required, changes-requested, checks-pending, checks-failing, ready, merged, …),
  - the group's task statuses and workflows (e.g. a spec-writing or planning workflow, a task in `review`),
  - tracker `status` and `labels` through the provider-neutral seam (`trackerItemSchema` for Jira/Linear; GitHub issue/PR labels) — so it works for providers other than GitHub. For Jira/Linear there is no PR reference status unless a PR is linked; status/labels carry the phase.
- **Group header:** the derived phase, an attention dot taken from the group's most urgent task (reusing `lib/attention.ts`), and counts. A **filter by phase** on the view.
- **Contract first:** any new response shape (group key, derived phase) is a zod schema in `packages/contract`; routes chained and validated as middleware (AGENTS.md § HTTP API).

**Decision point after slice 1:** the user uses the view for about a week. Meanwhile the supervisor may state in conversation the phase it would have assigned, to compare against the derived one. Slice 2 is built only if the derived phase is not enough.

**Slice 2 (separate, later, only on a go):** a cezar-side phase stored **per PR/issue** (never written to a tracker — "cezar is the supervisor"), set by the supervisor through a `cez mcp` write tool and by the user through a dropdown on the group header; last writer wins, with who/when provenance always recorded; the derived phase shown side by side with a `phaseDiverges` flag exposed in `get_run` / `list_runs` so divergence can be counted.

Rejected:
- **Writing phase/labels back to GitHub/Jira** — outward writes and per-provider write permissions; cezar is the system of record for the supervisor's view.
- **Per-task phase** — the moving thing is the PR/issue.
- **A mapping override in `.ai/cezar/config.json` in v1** — a knob before the defaults are shown wrong (AGENTS.md: never trade a working default for a knob).
- **Kanban board now** — deferred; slice 1's model (groups + phase) is meant to be its future column/card model.
- **Build nothing (GitHub Projects / Jira boards)** — they lose the cezar task context (who is on the move, the task threads) in one place.

## Resolved unknowns

| Question | Answer (from the conversation) |
|----------|--------------------------------|
| Unit that carries the phase | The PR or issue (the group), not the task. |
| Phase values | Fixed: plan, implement, review, delivery (+ none for the "no PR/issue" group). |
| Where the phase comes from in slice 1 | Derived only (PR reference status, task statuses/workflows, tracker status/labels via the provider-neutral seam). No stored field. |
| Other tracker providers | Must work through the provider-neutral seam (`labels`, `status`); nothing GitHub-specific in the phase rules beyond the PR reference status. |
| Write-back to the tracker | Never. |
| View | Toggleable "by PR/issue" list view that replaces the attention buckets while active; attention dot on the group header from the most urgent task; filter by phase. |
| Group key and membership | First PR ref, else first issue ref; one group per task; dispatch children/variants stay under their parent. |
| Configuration | None in v1 (defaults only). |
| MCP exposure | Not in slice 1 — `cez mcp` (fork PR #8) is not merged yet; add phase to `get_run`/`list_runs` after it lands. |
| Delivery order | Slice 1 → about a week of use → go/no-go on slice 2. |

## Non-goals

- Stored phase, `set_phase` MCP tool, phase dropdown (slice 2).
- Any write to GitHub, Jira, Linear or another tracker.
- Mapping configuration in `.ai/cezar/config.json`.
- A Kanban board.
- Phase in `cez mcp` tools (until fork PR #8 is merged).
- Publishing anything to `open-mercato/cezar`.

## Affected areas (if known)

- `packages/web/src/lib/task-groups.ts`, `packages/web/src/lib/attention.ts`, the task quick list / project task list components.
- `packages/contract/src/runs.ts` (`runIndexEntrySchema`, `referenceStatusesByProjectSchema`) and `packages/contract/src/tracker.ts` (`trackerItemSchema`).
- `GET /api/v1/workspace/runs-index` (already returns `referenceStatuses` per project) — the likely source for grouping and the PR side of the derived phase.
- Risk: upstream open-mercato/cezar#1277 (an unpublished Kanban board) may pick different phase names — a possible conflict when syncing the fork.
