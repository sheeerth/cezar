import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearJsonlScanCache } from './jsonl-scan.ts';
import { readClaudeUsage, readCodexUsage } from './providers.ts';
import { summarizeSamples } from './samples.ts';

const NOW = Date.now();
const iso = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cez-usage-home-'));
  clearJsonlScanCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  clearJsonlScanCache();
});

function writeTranscript(name: string, lines: unknown[]): void {
  const dir = join(home, 'projects', 'a-repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

function claudeReply(overrides: {
  id: string;
  requestId: string;
  at?: string;
  model?: string;
  usage?: Record<string, number>;
}): unknown {
  return {
    type: 'assistant',
    timestamp: overrides.at ?? iso(-60_000),
    requestId: overrides.requestId,
    message: {
      id: overrides.id,
      model: overrides.model ?? 'claude-opus-5',
      usage: overrides.usage ?? { input_tokens: 10, output_tokens: 20 },
    },
  };
}

describe('readClaudeUsage', () => {
  it('reports an account that has never run rather than failing', async () => {
    const read = await readClaudeUsage(join(home, 'missing'), NOW);
    expect(read.available).toBe(false);
    expect(read.reason).toMatch(/no transcripts/);
    expect(read.samples).toEqual([]);
  });

  it('counts one reply once, however many stream flushes wrote it', async () => {
    writeTranscript('session.jsonl', [
      claudeReply({ id: 'msg_1', requestId: 'req_1' }),
      claudeReply({ id: 'msg_1', requestId: 'req_1' }),
      claudeReply({ id: 'msg_1', requestId: 'req_1' }),
    ]);
    const read = await readClaudeUsage(home, NOW);
    expect(summarizeSamples(read.samples, NOW).windows[0]!.totals.tokens).toBe(30);
  });

  it('counts one reply once when --resume copied it into a second session file', async () => {
    writeTranscript('first.jsonl', [claudeReply({ id: 'msg_1', requestId: 'req_1' })]);
    writeTranscript('resumed.jsonl', [
      claudeReply({ id: 'msg_1', requestId: 'req_1' }),
      claudeReply({ id: 'msg_2', requestId: 'req_2' }),
    ]);
    const read = await readClaudeUsage(home, NOW);
    expect(summarizeSamples(read.samples, NOW).windows[0]!.totals.tokens).toBe(60);
  });

  it('splits cache traffic out so the weighting can price it', async () => {
    writeTranscript('session.jsonl', [
      claudeReply({
        id: 'msg_1',
        requestId: 'req_1',
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          cache_read_input_tokens: 1_000,
          cache_creation_input_tokens: 200,
        },
      }),
    ]);
    const [sample] = (await readClaudeUsage(home, NOW)).samples;
    expect(sample).toMatchObject({
      inputTokens: 5,
      outputTokens: 7,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 200,
    });
  });

  it('walks subagent transcripts — a subagent spends the same account\'s tokens', async () => {
    const dir = join(home, 'projects', 'a-repo', 'session', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'agent-1.jsonl'),
      JSON.stringify(claudeReply({ id: 'msg_sub', requestId: 'req_sub' })) + '\n',
    );
    const read = await readClaudeUsage(home, NOW);
    expect(read.samples).toHaveLength(1);
  });

  it('ignores non-assistant lines, synthetic replies and undated ones', async () => {
    writeTranscript('session.jsonl', [
      { type: 'user', timestamp: iso(-60_000), message: { content: 'hi' } },
      claudeReply({ id: 'msg_s', requestId: 'req_s', model: '<synthetic>' }),
      { ...(claudeReply({ id: 'msg_n', requestId: 'req_n' }) as object), timestamp: 'not a date' },
    ]);
    expect((await readClaudeUsage(home, NOW)).samples).toEqual([]);
  });

  it('publishes no quota figure — Claude writes none to disk', async () => {
    writeTranscript('session.jsonl', [claudeReply({ id: 'msg_1', requestId: 'req_1' })]);
    expect((await readClaudeUsage(home, NOW)).limits).toEqual([]);
  });
});

function writeRollout(name: string, lines: unknown[]): void {
  const dir = join(home, 'sessions', '2026', '08', '14');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

const tokenCount = (at: string, last: Record<string, number>, rateLimits?: unknown): unknown => ({
  timestamp: at,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 999_999, output_tokens: 999_999 },
      last_token_usage: last,
    },
    ...(rateLimits ? { rate_limits: rateLimits } : {}),
  },
});

describe('readCodexUsage', () => {
  it('reports an account with no sessions rather than failing', async () => {
    const read = await readCodexUsage(join(home, 'missing'), NOW);
    expect(read.available).toBe(false);
    expect(read.samples).toEqual([]);
  });

  it('sums the per-event DELTA, never the cumulative total beside it', async () => {
    writeRollout('rollout-1.jsonl', [
      tokenCount(iso(-120_000), { input_tokens: 100, output_tokens: 10 }),
      tokenCount(iso(-60_000), { input_tokens: 100, output_tokens: 10 }),
    ]);
    const read = await readCodexUsage(home, NOW);
    expect(summarizeSamples(read.samples, NOW).windows[0]!.totals.tokens).toBe(220);
  });

  it('splits cached tokens out of the input count Codex folds them into', async () => {
    writeRollout('rollout-1.jsonl', [
      tokenCount(iso(-60_000), {
        input_tokens: 1_000,
        cached_input_tokens: 900,
        output_tokens: 50,
      }),
    ]);
    const [sample] = (await readCodexUsage(home, NOW)).samples;
    expect(sample).toMatchObject({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 50 });
  });

  it('reads the older flat shape too', async () => {
    writeRollout('rollout-1.jsonl', [
      {
        timestamp: iso(-60_000),
        payload: { type: 'token_count', input_tokens: 40, output_tokens: 2 },
      },
    ]);
    expect((await readCodexUsage(home, NOW)).samples).toHaveLength(1);
  });

  it('carries the model a turn_context declared onto the token counts that follow', async () => {
    writeRollout('rollout-1.jsonl', [
      { timestamp: iso(-90_000), type: 'turn_context', payload: { model: 'gpt-5-codex' } },
      tokenCount(iso(-60_000), { input_tokens: 10, output_tokens: 1 }),
    ]);
    const read = await readCodexUsage(home, NOW);
    expect(read.samples[0]!.model).toBe('gpt-5-codex');
  });

  it('surfaces the vendor\'s own rate limits, with the reset instant resolved', async () => {
    writeRollout('rollout-1.jsonl', [
      tokenCount(iso(-60_000), { input_tokens: 10, output_tokens: 1 }, {
        primary: { used_percent: 42.5, window_minutes: 300, resets_in_seconds: 600 },
        secondary: { used_percent: 12, window_minutes: 10_080, resets_in_seconds: 3_600 },
      }),
    ]);
    const read = await readCodexUsage(home, NOW);
    expect(read.limits).toEqual([
      {
        id: 'primary',
        label: '5h window',
        usedPercent: 42.5,
        windowMinutes: 300,
        resetsAt: new Date(NOW - 60_000 + 600_000).toISOString(),
        observedAt: iso(-60_000),
      },
      {
        id: 'secondary',
        label: 'Weekly window',
        usedPercent: 12,
        windowMinutes: 10_080,
        resetsAt: new Date(NOW - 60_000 + 3_600_000).toISOString(),
        observedAt: iso(-60_000),
      },
    ]);
  });

  it('takes the LAST rate limits written, not the first', async () => {
    writeRollout('rollout-1.jsonl', [
      tokenCount(iso(-300_000), { input_tokens: 1, output_tokens: 1 }, {
        primary: { used_percent: 10, window_minutes: 300 },
      }),
      tokenCount(iso(-60_000), { input_tokens: 1, output_tokens: 1 }, {
        primary: { used_percent: 80, window_minutes: 300 },
      }),
    ]);
    expect((await readCodexUsage(home, NOW)).limits[0]!.usedPercent).toBe(80);
  });

  it('has no limits when no session recorded any', async () => {
    writeRollout('rollout-1.jsonl', [tokenCount(iso(-60_000), { input_tokens: 1, output_tokens: 1 })]);
    expect((await readCodexUsage(home, NOW)).limits).toEqual([]);
  });
});
