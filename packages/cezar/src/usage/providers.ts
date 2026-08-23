import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { UsageLimit } from '@open-mercato/cezar-contract';

import { readJsonlTail, scanJsonlTree } from './jsonl-scan.ts';
import { retentionStartMs, type UsageSample } from './samples.ts';

/**
 * Reading what the agent CLIs themselves recorded, out of their own homes.
 *
 * This is the half of the usage screen that counts sessions cezar never started — a `claude` in a
 * terminal, a `codex` in another editor — because "how much of my plan is left" is a question
 * about the ACCOUNT, not about cezar. Everything here is read-only and best-effort: a home that
 * does not exist is the normal state of an agent the user has not installed, and it degrades to a
 * one-line reason instead of an error.
 *
 * Vendor formats verified against Claude Code 2.1.x transcripts on 2026-08-14. Codex's rollout
 * shape is handled defensively (both the nested `info.last_token_usage` form and the older flat
 * one), and an unrecognized line contributes nothing rather than a wrong number.
 */

export interface ProviderUsageRead {
  available: boolean;
  reason?: string;
  samples: UsageSample[];
  limits: UsageLimit[];
}

const unavailable = (reason: string): ProviderUsageRead => ({
  available: false,
  reason,
  samples: [],
  limits: [],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Claude Code: `<home>/projects/**\/*.jsonl`, one line per conversation event.
 *
 * Only `type: 'assistant'` lines carry `message.usage`, and the SAME reply appears on several of
 * them (one per stream flush) and again in any session that `--resume`d it. `message.id` +
 * `requestId` is the identity that survives both, which is why every sample carries it as its
 * de-duplication key — see `UsageSample.key`.
 */
export async function readClaudeUsage(home: string, now: number): Promise<ProviderUsageRead> {
  const projects = join(home, 'projects');
  if (!(await isDirectory(projects))) {
    return unavailable('no transcripts recorded for this account yet');
  }
  const cutoffMs = retentionStartMs(now);
  const scan = await scanJsonlTree(projects, { cutoffMs, parse: parseClaudeLine });
  warnOnDroppedFiles('claude', scan.droppedFiles);
  // Claude publishes no quota figure to disk — `/usage` in the CLI asks the API. An empty
  // `limits` is therefore the honest answer, not a gap waiting to be filled with a guess.
  return { available: true, samples: scan.samples, limits: [] };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The file cap is the one place this module can undercount without noticing, so it says so.
 *
 * A warning rather than a wire field: reaching 5 000 transcripts inside a 30-day window is far
 * outside normal use, and a permanent contract field for it would ask every consumer to render a
 * case nobody will meet. Silence, though, would let an undercount read as a measurement.
 */
function warnOnDroppedFiles(provider: string, dropped: number): void {
  if (dropped > 0) {
    console.warn(
      `cezar: usage scan for ${provider} skipped ${dropped} transcript file(s) past the per-scan cap; reported tokens are an undercount`,
    );
  }
}

function parseClaudeLine(value: unknown): UsageSample[] {
  if (!isRecord(value) || value.type !== 'assistant') return [];
  const message = value.message;
  if (!isRecord(message) || !isRecord(message.usage)) return [];
  const at = Date.parse(String(value.timestamp ?? ''));
  if (!Number.isFinite(at)) return [];
  const usage = message.usage;
  const model = typeof message.model === 'string' ? message.model : undefined;
  // `<synthetic>` is what Claude Code stamps on locally generated replies (an interrupted turn's
  // filler). They are billed to nobody and would otherwise show up as a model in the breakdown.
  if (model === '<synthetic>') return [];
  const id = typeof message.id === 'string' ? message.id : undefined;
  const requestId = typeof value.requestId === 'string' ? value.requestId : undefined;
  const sample: UsageSample = {
    at,
    inputTokens: num(usage.input_tokens) ?? 0,
    outputTokens: num(usage.output_tokens) ?? 0,
    cacheReadTokens: num(usage.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: num(usage.cache_creation_input_tokens) ?? 0,
  };
  if (model) sample.model = model;
  // `message.id` alone already identifies a reply, so it is the key whenever it exists; the
  // request id is appended only as extra separation when the vendor wrote one. Requiring BOTH
  // would leave a line that carries no `requestId` with no key at all — and therefore counted
  // once per copy, which is exactly the failure this key exists to prevent. Measured on 30 days
  // of real transcripts: 23 of 10 267 usage lines carry no `requestId` (all of them zero-token
  // synthetic entries today, so nothing is double-counted in practice — but the guard is one
  // `||` away and the format is not this repo's to freeze).
  if (id) sample.key = requestId ? `${id}:${requestId}` : id;
  // Present on older transcripts only, and only for API-key billing. Taken when the vendor wrote
  // it; never derived from a price table cezar would have to keep current.
  const cost = num(value.costUSD);
  if (cost !== undefined && cost > 0) sample.costUsd = cost;
  return [sample];
}

/** The model a Codex session declared, remembered per rollout file — see `parseCodexLine`. */
const codexSessionModel = new Map<string, string>();

/**
 * Codex: `<home>/sessions/**\/rollout-*.jsonl`.
 *
 * `token_count` events carry a `last_token_usage` DELTA (and a cumulative `total_token_usage`
 * beside it). Summing the deltas is what makes a resumed session add up; summing the totals would
 * count the whole session again on every event.
 */
export async function readCodexUsage(home: string, now: number): Promise<ProviderUsageRead> {
  const sessions = join(home, 'sessions');
  if (!(await isDirectory(sessions))) {
    return unavailable('no sessions recorded for this account yet');
  }
  const cutoffMs = retentionStartMs(now);
  const scan = await scanJsonlTree(sessions, {
    cutoffMs,
    parse: parseCodexLine,
    // The remembered model is per rollout file, so it is forgotten with the file.
    onForget: (path) => codexSessionModel.delete(path),
  });
  warnOnDroppedFiles('codex', scan.droppedFiles);
  const limits = await readCodexLimits(scan.newestPath);
  return { available: true, samples: scan.samples, limits };
}

function parseCodexLine(value: unknown, filePath: string): UsageSample[] {
  if (!isRecord(value)) return [];
  const payload = isRecord(value.payload) ? value.payload : undefined;
  // `turn_context` states the model once per turn; a `token_count` a few lines later never
  // repeats it, so the last one seen in this file is the one the tokens belong to.
  const model = payload && typeof payload.model === 'string' ? payload.model : undefined;
  if (model) codexSessionModel.set(filePath, model);
  if (!payload || payload.type !== 'token_count') return [];
  const info = isRecord(payload.info) ? payload.info : undefined;
  const last = info && isRecord(info.last_token_usage) ? info.last_token_usage : payload;
  const at = Date.parse(String(value.timestamp ?? ''));
  if (!Number.isFinite(at)) return [];
  const cached = num(last.cached_input_tokens) ?? 0;
  const input = num(last.input_tokens) ?? 0;
  const output = num(last.output_tokens) ?? 0;
  if (input === 0 && output === 0 && cached === 0) return [];
  const sample: UsageSample = {
    at,
    // Codex reports cached tokens INSIDE `input_tokens`; splitting them out is what lets the
    // weighting treat a cache read as the ~10% of a fresh input token that it costs.
    inputTokens: Math.max(0, input - cached),
    outputTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
  const remembered = codexSessionModel.get(filePath);
  if (remembered) sample.model = remembered;
  return [sample];
}

/**
 * The freshest `rate_limits` Codex wrote — the one real quota percentage available on this
 * machine, for either vendor.
 *
 * Read from the newest session's TAIL rather than from the scan above, and deliberately so: the
 * scan is incremental, so a line it already consumed is never handed to a parser again, and a
 * quota reading that only refreshes when a file happens to be re-read from zero would be stale in
 * exactly the situation it matters. The path comes from the scan that just ran, so finding it
 * costs no second walk of the tree.
 */
async function readCodexLimits(newestPath: string | null): Promise<UsageLimit[]> {
  if (!newestPath) return [];
  const lines = await readJsonlTail(newestPath, 256 * 1024);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let value: unknown;
    try {
      value = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    const payload = isRecord(value.payload) ? value.payload : undefined;
    const rateLimits = payload && isRecord(payload.rate_limits) ? payload.rate_limits : undefined;
    if (!rateLimits) continue;
    const observedAt = Date.parse(String(value.timestamp ?? ''));
    const observed = Number.isFinite(observedAt) ? observedAt : Date.now();
    const limits = [
      toCodexLimit('primary', 'Session window', rateLimits.primary, observed),
      toCodexLimit('secondary', 'Weekly window', rateLimits.secondary, observed),
    ].filter((limit): limit is UsageLimit => limit !== null);
    if (limits.length > 0) return limits;
  }
  return [];
}

function toCodexLimit(
  id: string,
  fallbackLabel: string,
  raw: unknown,
  observedAt: number,
): UsageLimit | null {
  if (!isRecord(raw)) return null;
  const usedPercent = num(raw.used_percent);
  if (usedPercent === undefined) return null;
  const windowMinutes = num(raw.window_minutes);
  const resetsInSeconds = num(raw.resets_in_seconds);
  const limit: UsageLimit = {
    id,
    // A window cezar can name from its own length reads better than the vendor's ordinal —
    // "5h window" rather than "primary" — but the ordinal stays as the fallback.
    label: windowMinutes !== undefined ? windowLabel(windowMinutes) : fallbackLabel,
    usedPercent,
    observedAt: new Date(observedAt).toISOString(),
  };
  if (windowMinutes !== undefined) limit.windowMinutes = windowMinutes;
  if (resetsInSeconds !== undefined) {
    limit.resetsAt = new Date(observedAt + resetsInSeconds * 1_000).toISOString();
  }
  return limit;
}

function windowLabel(minutes: number): string {
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return days === 7 ? 'Weekly window' : `${days}d window`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}h window`;
  return `${minutes}m window`;
}
