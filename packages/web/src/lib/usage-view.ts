import type {
  UsageAccount,
  UsageLimit,
  UsageSnapshot,
  UsageTotals,
  UsageWindowId,
} from '@open-mercato/cezar-api-client'

/**
 * The pure half of the token-usage surfaces — everything the sidebar chip and the `/usage` page
 * decide before they paint anything.
 *
 * It lives apart from both because the two must agree: the chip is a one-line summary of the page,
 * and a chip that computed "the window that matters" differently from the page it links to would
 * be a bug nobody could see until they clicked.
 */

export const WINDOW_LABELS: Record<UsageWindowId, string> = {
  rolling5h: 'Last 5h',
  today: 'Today',
  last7d: 'Last 7 days',
  last30d: 'Last 30 days',
}

export function emptyTotals(): UsageTotals {
  return { tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

export function windowTotals(
  windows: readonly { id: UsageWindowId; totals: UsageTotals }[] | undefined,
  id: UsageWindowId,
): UsageTotals {
  return windows?.find((window) => window.id === id)?.totals ?? emptyTotals()
}

/** Add two totals. `costUsd` stays absent unless one side reported real money. */
export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  const cost = a.costUsd === undefined && b.costUsd === undefined ? undefined : (a.costUsd ?? 0) + (b.costUsd ?? 0)
  return {
    tokens: a.tokens + b.tokens,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    ...(cost === undefined ? {} : { costUsd: cost }),
  }
}

/**
 * One window, summed over every account that could be read.
 *
 * Unavailable accounts are skipped rather than added as zero — they carry no information, and
 * including them would make "Codex is not installed" indistinguishable from "Codex was idle".
 */
export function accountsWindowTotals(
  accounts: readonly UsageAccount[],
  id: UsageWindowId,
): UsageTotals {
  return accounts
    .filter((account) => account.available)
    .reduce((sum, account) => addTotals(sum, windowTotals(account.windows, id)), emptyTotals())
}

/**
 * The limit closest to biting, across every account — what the chip shows and what a user
 * actually wants to know ("am I about to be cut off?").
 *
 * Undefined when no vendor published one, which is the normal state of a Claude-only machine.
 */
export function tightestLimit(
  accounts: readonly UsageAccount[],
): { account: UsageAccount; limit: UsageLimit } | undefined {
  let best: { account: UsageAccount; limit: UsageLimit } | undefined
  for (const account of accounts) {
    for (const limit of account.limits) {
      if (best === undefined || limit.usedPercent > best.limit.usedPercent) best = { account, limit }
    }
  }
  return best
}

/**
 * `in 42m` / `in 3h` / `now` — how long a quota window has left.
 *
 * Empty for a missing or unparseable instant: a countdown is the reason to trust the percentage
 * beside it, and `in NaNm` would undermine both.
 */
export function resetsIn(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const seconds = Math.round((at - now) / 1_000)
  if (seconds <= 0) return 'now'
  if (seconds < 3_600) return `in ${Math.max(1, Math.round(seconds / 60))}m`
  if (seconds < 24 * 3_600) return `in ${Math.round(seconds / 3_600)}h`
  return `in ${Math.round(seconds / (24 * 3_600))}d`
}

/** A bar's width as a percentage of the biggest row, floored so a non-zero row is never invisible. */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || value <= 0) return 0
  return Math.max(2, Math.min(100, Math.round((value / max) * 100)))
}

/**
 * The last `days` calendar days ending today, zero-filled — a chart with gaps for idle days
 * would compress the timeline and make a quiet week look like a busy one.
 *
 * `today` is the browser's local day, matching the server's local-midnight bucketing.
 */
export function fillDailySeries(
  daily: readonly { date: string; totals: UsageTotals }[],
  days: number,
  now: number = Date.now(),
): { date: string; totals: UsageTotals }[] {
  const byDate = new Map(daily.map((day) => [day.date, day.totals]));
  const out: { date: string; totals: UsageTotals }[] = []
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)
  cursor.setDate(cursor.getDate() - (days - 1))
  for (let i = 0; i < days; i += 1) {
    const month = `${cursor.getMonth() + 1}`.padStart(2, '0')
    const day = `${cursor.getDate()}`.padStart(2, '0')
    const key = `${cursor.getFullYear()}-${month}-${day}`
    out.push({ date: key, totals: byDate.get(key) ?? emptyTotals() })
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

/** Does this snapshot have anything at all to show? Drives the page's empty state. */
export function hasAnyUsage(snapshot: UsageSnapshot | undefined): boolean {
  if (!snapshot) return false
  const accounts = snapshot.accounts.some(
    (account) => account.available && windowTotals(account.windows, 'last30d').tokens > 0,
  )
  return accounts || windowTotals(snapshot.runs.windows, 'last30d').tokens > 0
}
