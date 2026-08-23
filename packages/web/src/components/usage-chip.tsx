import { GaugeIcon } from 'lucide-react'

import { useHealth, useTokenUsage } from '@/api/queries'
import { Link } from '@/lib/project-router'
import { compactTokens } from '@/lib/format'
import { usageMetricVisibility } from '@/lib/token-metrics'
import {
  accountsWindowTotals,
  barPercent,
  resetsIn,
  tightestLimit,
  windowTotals,
} from '@/lib/usage-view'
import { cn } from '@/lib/utils'

/**
 * The always-there token read-out in the sidebar footer — the "stały podgląd" half of the usage
 * feature (spec `2026-08-14-token-usage-monitor`).
 *
 * It answers ONE question at a glance: how much have I burned in the current five-hour window,
 * and (when a vendor publishes a quota) how close that window is to its ceiling. Everything else
 * — per project, per model, per day — is a click away on `/usage`, because a sidebar row that
 * tried to say more would say it in six points.
 *
 * The number is the ACCOUNTS' number, not cezar's own runs: the question behind a permanent
 * read-out is "can I keep working", and that is decided by everything the account spent, terminal
 * sessions included. The page shows both halves side by side and labels them.
 *
 * Absent, never zeroed, when there is nothing honest to say: while the first snapshot loads, when
 * `CEZ_HIDE_TOKEN_METRICS=1` asks the cockpit not to show token counts, and in hosted mode, where
 * the agent homes live on a machine this browser cannot see.
 */
export function UsageChip({ className }: { className?: string }) {
  const health = useHealth().data
  const visibility = usageMetricVisibility(health)
  const snapshot = useTokenUsage(visibility.tokens).data

  if (!visibility.tokens || !snapshot) return null
  const readable = snapshot.accounts.filter((account) => account.available)
  // Hosted mode sends no accounts at all, and a machine where neither agent has ever run reads
  // the same way. Both mean: this chip has no number, so it is not a chip.
  if (readable.length === 0) return null

  const rolling = accountsWindowTotals(readable, 'rolling5h')
  const limit = tightestLimit(readable)
  const reset = limit ? resetsIn(limit.limit.resetsAt) : ''
  const runsRolling = windowTotals(snapshot.runs.windows, 'rolling5h')
  const title = [
    `${compactTokens(rolling.tokens)} tokens across ${readable.length} account${readable.length === 1 ? '' : 's'} in the last 5h`,
    `${compactTokens(runsRolling.tokens)} of it through cezar tasks`,
    limit
      ? `${limit.account.label} · ${limit.limit.label}: ${Math.round(limit.limit.usedPercent)}% used${reset ? ` (resets ${reset})` : ''}`
      : 'no vendor quota published locally',
  ].join('\n')

  return (
    <Link
      to="/usage"
      data-slot="usage-chip"
      title={title}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground',
        'hover:bg-accent hover:text-accent-foreground',
        className,
      )}
    >
      <GaugeIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="font-mono tabular-nums">{compactTokens(rolling.tokens)}</span>
      <span className="shrink-0">/ 5h</span>
      {limit ? (
        <span className="ml-auto flex min-w-0 items-center gap-1.5">
          {/* The bar is decoration over the number beside it: the percentage is the fact, and a
           *  screen reader reads it from the title above rather than from a div's width. */}
          <span aria-hidden className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-border">
            <span
              className="block h-full rounded-full bg-primary"
              style={{ width: `${barPercent(limit.limit.usedPercent, 100)}%` }}
            />
          </span>
          <span className="font-mono tabular-nums">{Math.round(limit.limit.usedPercent)}%</span>
        </span>
      ) : (
        // No vendor quota to show (a Claude-only machine): the day's total is the next most
        // useful thing the same row can carry, and it never pretends to be a percentage.
        <span className="ml-auto font-mono tabular-nums">
          {compactTokens(accountsWindowTotals(readable, 'today').tokens)} today
        </span>
      )}
    </Link>
  )
}
