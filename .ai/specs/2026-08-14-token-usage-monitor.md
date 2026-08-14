# Token usage monitor

> Related: `2026-07-30-session-usage-metrics.md` (per-run token accounting), `2026-07-28-hide-token-metrics.md` (the presentation switches this obeys), `2026-08-03-auto-resume-after-usage-limit.md` (what cezar does AFTER a limit is hit), `2026-07-29-agent-profiles.md` (the accounts whose homes are read).

## TLDR

Cezar knows what each of its own runs spent, and it learns about a plan limit only by walking into one. Neither answers the question a user actually asks — *how much have I burned, and how close am I to the ceiling?* This spec adds one workspace-level read (`GET /api/v1/workspace/usage`) that counts tokens from the agents' OWN homes (so terminal sessions count too) beside cezar's own run totals, a permanent read-out in the sidebar footer, and a `/usage` page. Read-only, zero-config, demand-driven.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why |
|---|----------|-----------------|-----|
| Q1 | Which source of truth? | **Both, side by side, never summed.** | They answer different questions and every cezar run appears in both. The account half (vendor homes) is the only one that sees terminal sessions and vendor quotas; the run half is the only one that can attribute tokens to a project or a dollar. Adding them double-counts. |
| Q2 | Show a "% of plan used" for Claude? | **No — only percentages a vendor published.** | Anthropic does not write a quota figure to disk (`/usage` in the CLI asks the API), and cezar does not know a plan's token ceiling. A percentage derived from a guessed ceiling is a number a user would act on and be wrong about. Codex writes `rate_limits` into its rollout log, so that one is shown verbatim. |
| Q3 | A configurable per-plan token limit? | **No.** | § Zero config: a feature that needs the user to author a number to be useful is a knob, and the honest token count is useful without one. Revisit only if a vendor publishes ceilings. |
| Q4 | How fresh, and at what cost? | Server-side stale-while-revalidate (30 s TTL, 5 min ceiling), incremental transcript reads, and a demand-driven `usage` WS topic. | The first read walks a month of transcripts (~60 MB on the author's machine); every read after it parses only the bytes the agents appended. An idle workspace with no cockpit open scans nothing at all. |
| Q5 | Rolling window or calendar days? | Both: `rolling5h` plus `today`/`last7d`/`last30d` anchored on the HOST's LOCAL midnight. | The five-hour window is the shape both vendors bill subscriptions in and the one a user recognizes; the calendar spans are the ones a person reads off their own clock, so UTC bucketing would put a late-evening session on tomorrow. |
| Q6 | Hosted mode? | Account rows withheld (`accounts: []`); the runs half still answers. | The homes are on another machine, and their paths are the host disclosure `GET /workspace/agent-profiles` already withholds (#431). |
| Q7 | OpenCode? | No account row. | It publishes no per-account usage cezar can read, and its credentials do not even live in a relocatable home (`core/agent-profiles.ts`). A permanently "unavailable" row teaches nobody anything; its runs still appear in the runs half. |

## Problem Statement

Three facts, none of which meet:

1. `RunRecord.tokensUsed` / `StepState.tokensUsed` record what cezar's own runs spent, per step, with the backend and account that spent them. Visible per task; never aggregated.
2. `usage-limit.ts` recognizes an exhausted window — but only from the error of a run that already died in it.
3. Everything a user runs from a terminal is invisible to cezar entirely, while spending the same plan.

So the cockpit can say "this task cost 1.2M tokens" and cannot say "you have used most of this window", which is the question that decides whether to start another task.

## Research

What each vendor writes to disk, verified on 2026-08-14 (Claude Code 2.1.226):

- **Claude Code** — `<home>/projects/<slug>/<session>.jsonl`, plus `…/<session>/subagents/*.jsonl`. Assistant lines carry `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) and a `timestamp`. **One reply is written once per stream flush** — a measured sample held 69 usage lines carrying 28 distinct replies — and a `--resume` copies earlier replies into the new session's file. `message.id` + `requestId` is the identity that survives both. No quota figure anywhere.
  `<home>/stats-cache.json` also holds daily per-model totals, but it is only recomputed when the CLI's own stats view runs (the author's was 27 days stale), so it is not a source.
- **Codex** — `<home>/sessions/**/rollout-*.jsonl`. `token_count` events carry `info.last_token_usage` (a DELTA) beside a cumulative `info.total_token_usage`, and — the valuable part — `rate_limits` with `used_percent`, `window_minutes` and `resets_in_seconds` per window. Older builds write the counters flat on the payload.
- **Accounts** — both relocate their entire home via one env var (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), which `workspace/agent-profiles.ts` already resolves per account. Reading "the account's usage" therefore means reading each resolved home, not `~/.claude`.

## Proposed Solution

### The contract

`GET /api/v1/workspace/usage` → `{generatedAt, accounts[], runs}` (`packages/contract/src/usage.ts`). Workspace-level and single-mount: a plan belongs to an account, not a repo. Both halves report the same four windows so one component renders either.

### The server

`packages/cezar/src/usage/`:

- `samples.ts` — the ONE definition of a window, a local day, and the cache weighting (`core/usage.ts`'s 10% / 125%). Every source reduces to a `UsageSample`, so three readers cannot grow three notions of "today".
- `jsonl-scan.ts` — incremental reader for append-only logs: resume at the last complete line, discard the cache when a file SHRANK, never open a file untouched since the retention floor.
- `providers.ts` — Claude and Codex readers, including the de-duplication key and the `rate_limits` tail read.
- `runs-usage.ts` — per-STEP attribution over run records (`run.tokensUsed` is the sum of its steps, so reading both would double).
- `snapshot.ts` — assembly plus the per-account degrade policy.

The route reuses the run index's ownership rule verbatim: an unowned project is read straight off `runs.json` (`readRunIndexFromDisk`), never through a built context — opening a usage panel must not prune worktrees or resume agents.

### The cockpit

- `UsageChip` in the sidebar footer — the always-there read-out: tokens in the last 5 h, and the tightest published quota when one exists. Absent, never zeroed, when there is nothing honest to say.
- `/usage` — the two labelled halves, per-account quota bars and 30-day sparklines, and cezar's spend by agent and by project.
- One `usage` topic subscription at the root, mirroring `health`: local mode only, publisher runs only while a cockpit holds it.

## What this deliberately does not do

- No price table. `costUsd` appears only where a backend reported real money.
- No writes, no new user-authored state, no new env var.
- No per-message drill-down: the transcripts are the vendor's own record, and cezar is not a second copy of them.
