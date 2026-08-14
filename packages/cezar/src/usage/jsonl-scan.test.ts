import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearJsonlScanCache, readJsonlTail, scanJsonlTree } from './jsonl-scan.ts';
import type { UsageSample } from './samples.ts';

const NOW = Date.now();
const CUTOFF = NOW - 30 * 24 * 60 * 60_000;

let dir: string;
let parsed: number;

/** One sample per line carrying `{at, out}` — enough to see WHICH lines a scan actually parsed. */
const parse = (value: unknown): UsageSample[] => {
  parsed += 1;
  const record = value as { at?: number; out?: number };
  if (typeof record.at !== 'number') return [];
  return [
    {
      at: record.at,
      inputTokens: 0,
      outputTokens: record.out ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ];
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-usage-scan-'));
  parsed = 0;
  clearJsonlScanCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearJsonlScanCache();
});

const line = (at: number, out: number) => `${JSON.stringify({ at, out })}\n`;

describe('scanJsonlTree', () => {
  it('walks nested session folders and ignores everything that is not .jsonl', () => {
    mkdirSync(join(dir, 'project/session/subagents'), { recursive: true });
    writeFileSync(join(dir, 'project/a.jsonl'), line(NOW, 1));
    writeFileSync(join(dir, 'project/session/subagents/b.jsonl'), line(NOW, 2));
    writeFileSync(join(dir, 'project/notes.md'), 'not a transcript');

    return scanJsonlTree(dir, { cutoffMs: CUTOFF, parse }).then(({ samples }) => {
      expect(samples.map((sample) => sample.outputTokens).sort()).toEqual([1, 2]);
    });
  });

  it('parses only the bytes an agent appended since the last scan', async () => {
    const path = join(dir, 'a.jsonl');
    writeFileSync(path, line(NOW, 1) + line(NOW, 2));
    const { samples: first } = await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse });
    expect(first).toHaveLength(2);
    expect(parsed).toBe(2);

    appendFileSync(path, line(NOW, 3));
    const { samples: second } = await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse });
    expect(second.map((sample) => sample.outputTokens)).toEqual([1, 2, 3]);
    // The two lines the first scan consumed are never handed to the parser again.
    expect(parsed).toBe(3);
  });

  it('serves the cache untouched when nothing was appended', async () => {
    writeFileSync(join(dir, 'a.jsonl'), line(NOW, 1));
    await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse });
    await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse });
    expect(parsed).toBe(1);
  });

  it('re-reads a file that SHRANK — a rotation is a different file, not an append', async () => {
    const path = join(dir, 'a.jsonl');
    writeFileSync(path, line(NOW, 1) + line(NOW, 2) + line(NOW, 3));
    await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse });
    parsed = 0;

    writeFileSync(path, line(NOW, 9));
    const { samples } = await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse });
    expect(samples.map((sample) => sample.outputTokens)).toEqual([9]);
    expect(parsed).toBe(1);
  });

  it('waits for a half-written tail to finish instead of dropping it', async () => {
    const path = join(dir, 'a.jsonl');
    // No trailing newline: the agent is mid-flush.
    writeFileSync(path, `${line(NOW, 1)}{"at":${NOW},"out":`);
    expect((await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse })).samples).toHaveLength(1);

    appendFileSync(path, '2}\n');
    const { samples } = await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse });
    expect(samples.map((sample) => sample.outputTokens)).toEqual([1, 2]);
  });

  it('never opens a file untouched since the cutoff', async () => {
    const path = join(dir, 'old.jsonl');
    writeFileSync(path, line(NOW, 1));
    const ancient = (NOW - 60 * 24 * 60 * 60_000) / 1_000;
    utimesSync(path, ancient, ancient);
    expect((await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse })).samples).toEqual([]);
    expect(parsed).toBe(0);
  });

  it('skips a malformed line and keeps reading the rest', async () => {
    writeFileSync(join(dir, 'a.jsonl'), `${line(NOW, 1)}not json\n${line(NOW, 2)}`);
    const { samples } = await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse });
    expect(samples.map((sample) => sample.outputTokens)).toEqual([1, 2]);
  });

  it('is empty for a directory that does not exist', async () => {
    const scan = await scanJsonlTree(join(dir, 'nope'), { cutoffMs: CUTOFF, parse });
    expect(scan).toEqual({ samples: [], newestPath: null, droppedFiles: 0 });
  });

  it('forgets a file that was deleted', async () => {
    const path = join(dir, 'a.jsonl');
    writeFileSync(path, line(NOW, 1));
    await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse });
    rmSync(path);
    expect((await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse })).samples).toEqual([]);
  });
});

describe('scanJsonlTree — newestPath and eviction', () => {
  it('names the most recently written session, so no caller walks the tree twice', async () => {
    writeFileSync(join(dir, 'old.jsonl'), line(NOW, 1));
    const older = (NOW - 60_000) / 1_000;
    utimesSync(join(dir, 'old.jsonl'), older, older);
    writeFileSync(join(dir, 'new.jsonl'), line(NOW, 2));
    const scan = await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse });
    expect(scan.newestPath).toBe(join(dir, 'new.jsonl'));
  });

  it('tells the caller to forget a file it stopped tracking', async () => {
    const forgotten: string[] = [];
    const path = join(dir, 'a.jsonl');
    writeFileSync(path, line(NOW, 1));
    const onForget = (p: string) => forgotten.push(p);
    await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse, onForget });
    expect(forgotten).toEqual([]);

    rmSync(path);
    await scanJsonlTree(dir, { cutoffMs: CUTOFF, parse, onForget });
    expect(forgotten).toEqual([path]);
  });

  it('forgets a file that aged past the cutoff', async () => {
    const forgotten: string[] = [];
    const path = join(dir, 'old.jsonl');
    writeFileSync(path, line(NOW, 1));
    const ancient = (NOW - 60 * 24 * 60 * 60_000) / 1_000;
    utimesSync(path, ancient, ancient);
    await scanJsonlTree(dir, {
      cutoffMs: CUTOFF,
      parse,
      onForget: (p) => forgotten.push(p),
    });
    expect(forgotten).toEqual([path]);
  });
});

describe('readJsonlTail', () => {
  it('returns whole lines only, dropping the partial one a byte window cuts open', async () => {
    const path = join(dir, 'a.jsonl');
    writeFileSync(path, `${'x'.repeat(50)}\n${line(NOW, 7)}`);
    const lines = await readJsonlTail(path, 30);
    expect(lines).toEqual([JSON.stringify({ at: NOW, out: 7 })]);
  });

  it('reads the whole file when it fits inside the window', async () => {
    const path = join(dir, 'a.jsonl');
    writeFileSync(path, line(NOW, 1) + line(NOW, 2));
    expect(await readJsonlTail(path, 64 * 1024)).toHaveLength(2);
  });
});
