import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { UsageSample } from './samples.ts';

/**
 * Reading append-only JSONL logs that a coding agent is writing WHILE the cockpit polls them.
 *
 * Both vendors keep the same kind of file: one line per event, appended, never rewritten. That is
 * what makes an incremental read correct rather than merely fast — a file's first N bytes are the
 * same bytes they were on the last scan, so re-parsing them is pure waste. It is also the
 * difference between a usage panel that costs one 60 MB parse per refresh and one that costs the
 * few KB an agent appended since the last tick.
 *
 * Three rules keep that honest:
 *
 * - the parse resumes at the last COMPLETE line, so a half-written tail is re-read next time
 *   instead of being dropped as malformed;
 * - a file whose size went DOWN was rewritten or replaced, so its cache entry is discarded whole;
 * - a file untouched since the retention floor cannot hold a sample inside any window (its newest
 *   line is at most as new as its mtime), so it is never opened at all.
 */

/** Enough for a machine with years of transcripts; past this the oldest files are simply skipped. */
const MAX_FILES = 5_000;
/** `~/.claude/projects/<project>/<session>/subagents/<agent>.jsonl` is four deep; six is slack. */
const MAX_DEPTH = 6;

interface CachedFile {
  size: number;
  mtimeMs: number;
  /** Byte offset of the first UNPARSED byte — always just past a newline. */
  offset: number;
  samples: UsageSample[];
}

/** Per-process, per-path. A `cezar serve` lives for days; the first scan pays, the rest do not. */
const cache = new Map<string, CachedFile>();

/** Drop everything the scanners hold. Tests call it; nothing in production needs to. */
export function clearJsonlScanCache(): void {
  cache.clear();
}

export interface JsonlScanOptions {
  /** Files untouched since this instant are skipped, and cached entries for them are evicted. */
  cutoffMs: number;
  /**
   * One line → zero or more samples. Never throws: a malformed line is the parser's problem.
   *
   * `filePath` is passed because a rollout log states a fact once (Codex names the model in a
   * `turn_context` line) and then refers to it implicitly for the rest of the session — a parser
   * that wants to carry that forward needs to know which session it is reading.
   */
  parse: (value: unknown, filePath: string) => UsageSample[];
  /**
   * Called with every path this scan stopped tracking — deleted, rotated out, aged past the
   * cutoff, or dropped by the file cap.
   *
   * It exists because a caller may keep its own per-file memory (the Codex reader remembers which
   * model a session declared), and a second map that nothing ever prunes grows for the life of a
   * `cezar serve` as sessions rotate daily. One eviction signal, both caches.
   */
  onForget?: (filePath: string) => void;
}

export interface JsonlScanResult {
  /** Every sample under the directory, in no particular order. */
  samples: UsageSample[];
  /** The newest `.jsonl` by mtime, or `null` — the freshest state the vendor wrote. */
  newestPath: string | null;
  /** How many files the cap dropped. Non-zero means the numbers are an undercount. */
  droppedFiles: number;
}

/**
 * Read a whole tree of append-only JSONL logs.
 *
 * A missing directory is not an error — it is what an agent that has never run on this machine
 * looks like — so it yields nothing. An unreadable subdirectory is skipped for the same reason:
 * one locked folder must not cost the whole account its numbers.
 *
 * `newestPath` rides along rather than being a second function: a caller that wants both the
 * samples and the freshest file (Codex needs the newest session's quota line) would otherwise walk
 * the same tree twice per refresh.
 */
export async function scanJsonlTree(
  dir: string,
  options: JsonlScanOptions,
): Promise<JsonlScanResult> {
  const files: { path: string; size: number; mtimeMs: number }[] = [];
  await collectFiles(dir, 0, options, files);
  // Newest first, so a truncating cap keeps the files a user is most likely asking about.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const kept = files.slice(0, MAX_FILES);

  const live = new Set(kept.map((file) => file.path));
  for (const path of [...cache.keys()]) {
    if (!live.has(path)) forget(path, options);
  }
  for (const file of files.slice(MAX_FILES)) forget(file.path, options);

  const samples: UsageSample[] = [];
  for (const file of kept) {
    const parsed = await readFileSamples(file, options.parse, options.cutoffMs);
    for (const sample of parsed) samples.push(sample);
  }
  return {
    samples,
    newestPath: kept[0]?.path ?? null,
    droppedFiles: files.length - kept.length,
  };
}

/** Stop tracking a path, in this module's cache and in the caller's own per-file memory. */
function forget(path: string, options: JsonlScanOptions): void {
  cache.delete(path);
  options.onForget?.(path);
}

async function collectFiles(
  dir: string,
  depth: number,
  options: JsonlScanOptions,
  out: { path: string; size: number; mtimeMs: number }[],
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(path, depth + 1, options, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    try {
      const stats = await stat(path);
      // Untouched since the floor ⇒ every line in it is older than the floor.
      if (stats.mtimeMs < options.cutoffMs) {
        forget(path, options);
        continue;
      }
      out.push({ path, size: stats.size, mtimeMs: stats.mtimeMs });
    } catch {
      // Vanished between readdir and stat — a session that just rotated. Nothing to read.
    }
  }
}

async function readFileSamples(
  file: { path: string; size: number; mtimeMs: number },
  parse: JsonlScanOptions['parse'],
  cutoffMs: number,
): Promise<UsageSample[]> {
  const cached = cache.get(file.path);
  if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.samples;
  // A shrunk file is a different file: rotation, or a rewrite. Anything reused would be fiction.
  const reusable = cached && file.size >= cached.size ? cached : undefined;
  const state: CachedFile = reusable
    ? { ...reusable, samples: [...reusable.samples] }
    : { size: 0, mtimeMs: 0, offset: 0, samples: [] };

  const appended = await readFrom(file.path, state.offset);
  if (appended === null) {
    // Unreadable right now. Keep whatever the cache holds rather than reporting a drop to zero.
    return state.samples;
  }
  let consumed = 0;
  let start = 0;
  for (let i = 0; i < appended.length; i += 1) {
    if (appended[i] !== '\n') continue;
    const line = appended.slice(start, i).trim();
    start = i + 1;
    consumed = start;
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue; // a line the vendor's own writer half-flushed, or a format cezar has not met
    }
    for (const sample of parse(value, file.path)) state.samples.push(sample);
  }

  state.offset += Buffer.byteLength(appended.slice(0, consumed));
  state.size = file.size;
  state.mtimeMs = file.mtimeMs;
  // The floor only ever moves forward, so a sample below it can never be asked for again. Dropping
  // it here is what stops a session an agent has been appending to for weeks from growing an
  // in-memory copy of its whole history.
  state.samples = state.samples.filter((sample) => sample.at >= cutoffMs);
  cache.set(file.path, state);
  return state.samples;
}

/**
 * The last `maxBytes` of `path` as whole lines, newest last — the cheap way to ask an append-only
 * log what it most recently said. The first (probably partial) line is dropped.
 */
export async function readJsonlTail(path: string, maxBytes: number): Promise<string[]> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return [];
  }
  const start = Math.max(0, size - maxBytes);
  const text = await readFrom(path, start);
  if (text === null) return [];
  const lines = text.split('\n');
  if (start > 0) lines.shift();
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

/** The bytes from `offset` on, decoded as UTF-8, or `null` when the file cannot be read. */
async function readFrom(path: string, offset: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start: offset });
    stream.on('data', (chunk) => chunks.push(chunk as Buffer));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
