import type { UsageAccount, UsageSnapshot } from '@open-mercato/cezar-contract';

import type { ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import { readClaudeUsage, readCodexUsage, type ProviderUsageRead } from './providers.ts';
import { collectRunsUsage, type RunsUsageProject } from './runs-usage.ts';
import { summarizeSamples, USAGE_WINDOW_IDS, windowStartMs } from './samples.ts';

/**
 * `GET /workspace/usage`'s answer, assembled.
 *
 * The two halves are built independently and never summed — see the contract's note. What this
 * module owns is the degrade policy: one account whose home cannot be read must cost that account
 * its numbers and nothing else, so every read is isolated and a failure becomes a `reason` string
 * on one row.
 *
 * OpenCode has no account row at all. It publishes no per-account usage anywhere cezar can read
 * (its credentials do not even live in a relocatable home — `core/agent-profiles.ts`), and a row
 * that is permanently "unavailable" teaches the reader nothing. Its runs still appear in the runs
 * half, which is the only place cezar knows anything about them.
 */

export interface UsageSnapshotInput {
  /** Claude/Codex accounts to read. Empty in hosted mode: the homes are on another machine. */
  accounts: readonly ResolvedAgentProfile[];
  projects: readonly RunsUsageProject[];
  /** Project ids whose run index could not be read, so the runs half can say it is incomplete. */
  unreadableProjects?: readonly string[];
  now?: number;
}

export async function buildUsageSnapshot(input: UsageSnapshotInput): Promise<UsageSnapshot> {
  const now = input.now ?? Date.now();
  const accounts = await Promise.all(
    input.accounts.map((account) => readAccount(account, now)),
  );
  return {
    generatedAt: new Date(now).toISOString(),
    accounts,
    runs: collectRunsUsage(input.projects, now, input.unreadableProjects ?? []),
  };
}

async function readAccount(account: ResolvedAgentProfile, now: number): Promise<UsageAccount> {
  let read: ProviderUsageRead;
  try {
    read =
      account.provider === 'codex'
        ? await readCodexUsage(account.path, now)
        : await readClaudeUsage(account.path, now);
  } catch {
    read = {
      available: false,
      // A FIXED string, never the error's own message. Node's fs errors quote the path they
      // failed on (`EACCES: permission denied, scandir '/home/…/.claude/projects'`), and while
      // this route answers a trusted same-origin caller, a home directory is the one string not
      // worth repeating by reflex. The readers below already swallow their own I/O failures, so
      // reaching here at all means something unforeseen — which is what this sentence says.
      reason: 'could not be read',
      samples: [],
      limits: [],
    };
  }
  const summary = read.available
    ? summarizeSamples(read.samples, now)
    : {
        // An unavailable account still carries the four windows, zeroed, so the cockpit renders
        // one row shape rather than two.
        windows: USAGE_WINDOW_IDS.map((id) => ({
          id,
          startedAt: new Date(windowStartMs(id, now)).toISOString(),
          totals: {
            tokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        })),
        daily: [],
        models: [],
      };
  return {
    provider: account.provider,
    accountId: account.id,
    label: account.label,
    isDefault: account.isDefault,
    available: read.available,
    ...(read.reason !== undefined ? { reason: read.reason } : {}),
    windows: summary.windows,
    limits: read.limits,
    models: summary.models,
    daily: summary.daily,
  };
}
