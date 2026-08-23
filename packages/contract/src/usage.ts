import { z } from 'zod';

import { runnerSchema } from './health.ts';

/**
 * `GET /api/v1/workspace/usage` — how many tokens the machine's agent accounts have actually
 * burned, and how much of that cezar itself spent.
 *
 * Two halves, deliberately separate rather than summed:
 *
 * - `accounts` reads each agent's OWN home (`~/.claude`, `~/.codex`, and every extra account's
 *   `CLAUDE_CONFIG_DIR`/`CODEX_HOME`), so it counts sessions run from a bare terminal exactly like
 *   sessions cezar started. It is the answer to "how much of my plan is gone".
 * - `runs` aggregates cezar's own run records, which is the only half that can attribute tokens to
 *   a project, a task or a dollar figure.
 *
 * Adding them would double-count every cezar run, and neither number can be derived from the
 * other — so the wire carries both and the cockpit says which is which.
 */

/** One accumulated token figure. `tokens` is the cost-weighted number cezar shows everywhere else
 *  (cache reads at 10%, cache writes at 125% — `src/core/usage.ts`); the raw components ride along
 *  so a reader can show the split without a second request. */
export const usageTotalsSchema = z.object({
  tokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  /** Absent unless a backend reported real money — cezar never fabricates a price. */
  costUsd: z.number().optional(),
});
export type UsageTotals = z.infer<typeof usageTotalsSchema>;

/**
 * The four spans every surface reports on.
 *
 * `rolling5h` is the one that answers "can I still work right now": both vendors bill
 * subscriptions in a rolling five-hour session window, so it is the span whose shape a user
 * recognizes. The rest are calendar spans in the HOST's local time — the day boundary a person
 * reads off their own clock, not UTC's.
 */
export const usageWindowIdSchema = z.enum(['rolling5h', 'today', 'last7d', 'last30d']);
export type UsageWindowId = z.infer<typeof usageWindowIdSchema>;

export const usageWindowSchema = z.object({
  id: usageWindowIdSchema,
  /** Inclusive lower bound, ISO-8601 — what the number is a sum over. */
  startedAt: z.string(),
  totals: usageTotalsSchema,
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

/**
 * A quota figure the PROVIDER itself reported — never one cezar computed.
 *
 * Only Codex publishes this locally (its rollout log carries `rate_limits` verbatim), so the array
 * is empty for Claude rather than filled with a guess: cezar does not know a plan's token ceiling
 * and inventing one would be a number the user could act on and be wrong about.
 */
export const usageLimitSchema = z.object({
  /** Vendor's own window key — `primary`, `secondary`. */
  id: z.string(),
  label: z.string(),
  usedPercent: z.number(),
  windowMinutes: z.number().optional(),
  /** When the vendor says the window rolls over, ISO-8601. */
  resetsAt: z.string().optional(),
  /** When this figure was written to disk — a limit read is only as fresh as the last session. */
  observedAt: z.string(),
});
export type UsageLimit = z.infer<typeof usageLimitSchema>;

/** One local day, keyed `YYYY-MM-DD` in the host's local time. */
export const usageDaySchema = z.object({
  date: z.string(),
  totals: usageTotalsSchema,
});
export type UsageDay = z.infer<typeof usageDaySchema>;

export const usageModelSchema = z.object({
  model: z.string(),
  totals: usageTotalsSchema,
});
export type UsageModel = z.infer<typeof usageModelSchema>;

/**
 * One agent ACCOUNT's consumption, read from that account's own home directory.
 *
 * `available: false` is the normal answer for an agent that has never run on this machine (no
 * home, no transcripts) and for one whose home cannot be read — a cockpit that has never seen
 * Codex must still render, so the row degrades to a reason string rather than vanishing or
 * failing the request.
 */
export const usageAccountSchema = z.object({
  provider: runnerSchema,
  /** `default` for the discovered home, otherwise the stored account id. */
  accountId: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
  available: z.boolean(),
  reason: z.string().optional(),
  windows: z.array(usageWindowSchema),
  limits: z.array(usageLimitSchema),
  /** Newest-first by token count, over `last30d`. */
  models: z.array(usageModelSchema),
  /** Oldest-first, one entry per day that had activity inside `last30d`. */
  daily: z.array(usageDaySchema),
});
export type UsageAccount = z.infer<typeof usageAccountSchema>;

/** A named slice of cezar's own spend — one provider, or one project. */
export const usageGroupSchema = z.object({
  key: z.string(),
  label: z.string(),
  totals: usageTotalsSchema,
  /** How many runs contributed, so a big number can be read as "many tasks" or "one runaway". */
  runs: z.number(),
});
export type UsageGroup = z.infer<typeof usageGroupSchema>;

/** What cezar's own run records say, across every registered project. */
export const usageRunsSchema = z.object({
  windows: z.array(usageWindowSchema),
  byProvider: z.array(usageGroupSchema),
  byProject: z.array(usageGroupSchema),
  daily: z.array(usageDaySchema),
  /** Project ids whose run index could not be read — the numbers below them are incomplete. */
  unreadableProjects: z.array(z.string()),
});
export type UsageRuns = z.infer<typeof usageRunsSchema>;

export const usageSnapshotSchema = z.object({
  generatedAt: z.string(),
  accounts: z.array(usageAccountSchema),
  runs: usageRunsSchema,
});
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;
