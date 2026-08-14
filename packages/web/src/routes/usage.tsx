import { GaugeIcon } from 'lucide-react'

import { useHealth, useTokenUsage } from '@/api/queries'
import type {
  UsageAccount,
  UsageGroup,
  UsageRuns,
  UsageTotals,
  UsageWindowId,
} from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { compactTokens, shortAge } from '@/lib/format'
import { formatCost } from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import {
  accountsWindowTotals,
  barPercent,
  fillDailySeries,
  hasAnyUsage,
  resetsIn,
  windowTotals,
  WINDOW_LABELS,
} from '@/lib/usage-view'
import { cn } from '@/lib/utils'

/**
 * `/usage` — the token-usage monitor (spec `2026-08-14-token-usage-monitor`).
 *
 * Two sections, never one total, because the two numbers answer different questions and adding
 * them would count every cezar run twice:
 *
 *  - **Agent accounts** — what each agent CLI recorded in its own home, terminal sessions
 *    included. This is the "how much of my plan is gone" number, and the only one that can carry a
 *    vendor's own quota percentage (Codex publishes one; Claude does not).
 *  - **cezar tasks** — what this cockpit's runs spent, the only half that can be attributed to a
 *    project or priced in dollars.
 *
 * Presentation follows the same switches as every other usage surface: `CEZ_HIDE_TOKEN_METRICS=1`
 * removes the counts, and a hosted cockpit gets no account rows at all (the homes are on another
 * machine) — so the page says that rather than rendering an empty grid.
 */
export function UsageRoute() {
  const health = useHealth().data
  const visibility = usageMetricVisibility(health)
  const query = useTokenUsage(visibility.tokens)
  const snapshot = query.data

  if (!visibility.tokens) {
    return (
      <CenteredState
        icon={<GaugeIcon />}
        title="Token metrics are hidden"
        subtitle="This server runs with CEZ_HIDE_TOKEN_METRICS=1, so the cockpit does not display token counts."
      />
    )
  }
  if (query.isPending) {
    return (
      <CenteredState
        icon={<GaugeIcon />}
        title="Reading usage…"
        subtitle="Walking this month's agent transcripts."
      />
    )
  }
  if (query.isError || !snapshot) {
    return (
      <CenteredState
        icon={<GaugeIcon />}
        title="Usage could not be read"
        subtitle="The server could not assemble a usage snapshot. It will try again on the next refresh."
      />
    )
  }

  const localHandoff = health?.capabilities.localHandoff !== false

  return (
    <div data-slot="usage-route" className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">Token usage</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What the agent accounts on this machine have spent, and how much of it went through
          cezar. Updated {shortAge(snapshot.generatedAt) || '0s'} ago.
        </p>
      </header>

      {!hasAnyUsage(snapshot) ? (
        <p className="rounded-md border border-border px-4 py-3 text-sm text-muted-foreground">
          Nothing recorded in the last 30 days yet. Numbers appear as soon as an agent runs — from
          cezar or from a terminal.
        </p>
      ) : null}

      <section className="mb-8" aria-labelledby="usage-accounts">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="usage-accounts" className="text-sm font-semibold">
            Agent accounts
          </h2>
          <p className="text-xs text-muted-foreground">
            Every session on this machine, cezar&rsquo;s and your terminal&rsquo;s
          </p>
        </div>
        {!localHandoff ? (
          <p className="rounded-md border border-border px-4 py-3 text-sm text-muted-foreground">
            This cockpit is served remotely, so the agent homes it would read are on another
            machine. Only the cezar tasks below can be counted from here.
          </p>
        ) : snapshot.accounts.length === 0 ? (
          <p className="rounded-md border border-border px-4 py-3 text-sm text-muted-foreground">
            No Claude or Codex home found on this machine.
          </p>
        ) : (
          <>
            <WindowRow
              totals={(id) => accountsWindowTotals(snapshot.accounts, id)}
              showCost={false}
              label="All accounts"
            />
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {snapshot.accounts.map((account) => (
                <AccountCard key={`${account.provider}:${account.accountId}`} account={account} />
              ))}
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="usage-runs">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="usage-runs" className="text-sm font-semibold">
            cezar tasks
          </h2>
          <p className="text-xs text-muted-foreground">Across every registered project</p>
        </div>
        <RunsSection runs={snapshot.runs} showCost={visibility.cost} />
      </section>
    </div>
  )
}

const WINDOW_ORDER: UsageWindowId[] = ['rolling5h', 'today', 'last7d', 'last30d']

/** The four windows as one row of figures — the shape both sections lead with. */
function WindowRow({
  totals,
  showCost,
  label,
}: {
  totals: (id: UsageWindowId) => UsageTotals
  showCost: boolean
  label: string
}) {
  return (
    <dl
      data-slot="usage-windows"
      aria-label={label}
      className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4"
    >
      {WINDOW_ORDER.map((id) => {
        const value = totals(id)
        const cost = showCost ? formatCost(value.costUsd) : ''
        return (
          <div key={id} className="bg-background px-3 py-2">
            <dt className="text-xs text-muted-foreground">{WINDOW_LABELS[id]}</dt>
            <dd className="font-mono text-sm tabular-nums">
              {compactTokens(value.tokens)}
              {cost ? <span className="ml-1.5 text-xs text-muted-foreground">{cost}</span> : null}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

function AccountCard({ account }: { account: UsageAccount }) {
  const daily = fillDailySeries(account.daily, 30)
  const peak = daily.reduce((max, day) => Math.max(max, day.totals.tokens), 0)

  return (
    <article
      data-slot="usage-account"
      className="rounded-md border border-border px-4 py-3"
      aria-label={`${PROVIDER_LABELS[account.provider] ?? account.provider} · ${account.label}`}
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">
          {PROVIDER_LABELS[account.provider] ?? account.provider}
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">{account.label}</span>
        </h3>
        {account.isDefault ? <span className="text-xs text-muted-foreground">default</span> : null}
      </header>

      {!account.available ? (
        <p className="mt-2 text-sm text-muted-foreground">{account.reason ?? 'Not readable.'}</p>
      ) : (
        <>
          {account.limits.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {account.limits.map((limit) => {
                const reset = resetsIn(limit.resetsAt)
                return (
                  <li key={limit.id}>
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="text-muted-foreground">{limit.label}</span>
                      <span className="font-mono tabular-nums">
                        {Math.round(limit.usedPercent)}%{reset ? ` · resets ${reset}` : ''}
                      </span>
                    </div>
                    <span
                      aria-hidden
                      className="mt-1 block h-1.5 overflow-hidden rounded-full bg-border"
                    >
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${barPercent(limit.usedPercent, 100)}%` }}
                      />
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : null}

          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {WINDOW_ORDER.map((id) => (
              <div key={id} className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">{WINDOW_LABELS[id]}</dt>
                <dd className="font-mono tabular-nums">
                  {compactTokens(windowTotals(account.windows, id).tokens)}
                </dd>
              </div>
            ))}
          </dl>

          {peak > 0 ? (
            <div
              data-slot="usage-sparkline"
              aria-hidden
              className="mt-3 flex h-8 items-end gap-px"
              title="Daily tokens, last 30 days"
            >
              {daily.map((day) => (
                <span
                  key={day.date}
                  className={cn(
                    'flex-1 rounded-t-sm',
                    day.totals.tokens > 0 ? 'bg-primary/70' : 'bg-border',
                  )}
                  style={{ height: `${Math.max(4, barPercent(day.totals.tokens, peak))}%` }}
                />
              ))}
            </div>
          ) : null}

          {account.models.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs">
              {account.models.slice(0, 3).map((model) => (
                <li key={model.model} className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-muted-foreground">{model.model}</span>
                  <span className="font-mono tabular-nums">{compactTokens(model.totals.tokens)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </article>
  )
}

function RunsSection({ runs, showCost }: { runs: UsageRuns; showCost: boolean }) {
  return (
    <>
      <WindowRow
        totals={(id) => windowTotals(runs.windows, id)}
        showCost={showCost}
        label="cezar tasks"
      />
      {runs.unreadableProjects.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {runs.unreadableProjects.length} project
          {runs.unreadableProjects.length === 1 ? '' : 's'} could not be read, so these numbers are
          incomplete.
        </p>
      ) : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <GroupList title="By agent" groups={runs.byProvider} showCost={showCost} />
        <GroupList title="By project" groups={runs.byProject} showCost={showCost} />
      </div>
    </>
  )
}

/** One ranked bar list — the last 30 days, which is the span the server groups over. */
function GroupList({
  title,
  groups,
  showCost,
}: {
  title: string
  groups: readonly UsageGroup[]
  showCost: boolean
}) {
  const peak = groups.reduce((max, group) => Math.max(max, group.totals.tokens), 0)
  return (
    <section className="rounded-md border border-border px-4 py-3" aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      {groups.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Nothing in the last 30 days.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {groups.map((group) => {
            const cost = showCost ? formatCost(group.totals.costUsd) : ''
            return (
              <li key={group.key}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate">{group.label}</span>
                  <span className="shrink-0 font-mono tabular-nums">
                    {compactTokens(group.totals.tokens)}
                    {cost ? <span className="ml-1.5 text-muted-foreground">{cost}</span> : null}
                  </span>
                </div>
                <span aria-hidden className="mt-1 block h-1.5 overflow-hidden rounded-full bg-border">
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${barPercent(group.totals.tokens, peak)}%` }}
                  />
                </span>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {group.runs} task{group.runs === 1 ? '' : 's'}
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
