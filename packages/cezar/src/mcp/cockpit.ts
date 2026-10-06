/**
 * The cockpit half of `cez mcp` (spec `.ai/specs/2026-10-06-cez-mcp.md`): finding the running
 * `cez serve` and talking to its `/api/v1` over plain `fetch`.
 *
 * Nothing here throws anything but `CockpitError`, and the tool layer turns that into an MCP
 * `isError` result — a dead cockpit must never take the stdio server down with it, or the client
 * marks `cez mcp` as broken and stops offering its tools.
 */
import { healthResponseSchema, projectsResponseSchema, type ProjectsResponse } from '@open-mercato/cezar-contract';
import { matchProject } from './projects.ts';

/** `cez serve` starts at 4321 and takes the first free port of the next 50 (`pickPort`). */
export const DISCOVERY_PORTS: readonly [number, number] = [4321, 4370];
const PROBE_TIMEOUT_MS = 300;
const REQUEST_TIMEOUT_MS = 15_000;

/** Enough of `/api/v1/health` to know it is a cezar cockpit — tolerant of version skew. */
const cockpitHealthSchema = healthResponseSchema.pick({ version: true, bootProject: true, repoRoot: true });

export class CockpitError extends Error {}

export interface CockpitOptions {
  /** `--url`, then `CEZ_API_URL`; absent means discover. */
  url?: string;
  /** The MCP server's own (realpath'd) working directory — the tiebreak between cockpits. */
  cwd: string;
  fetch?: typeof fetch;
  ports?: readonly [number, number];
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export class Cockpit {
  private readonly explicit: string | undefined;
  private readonly cwd: string;
  private readonly fetchImpl: typeof fetch;
  private readonly ports: readonly [number, number];
  private resolved: Promise<string> | undefined;

  constructor(options: CockpitOptions) {
    this.explicit = options.url ? trimSlash(options.url) : undefined;
    this.cwd = options.cwd;
    this.fetchImpl = options.fetch ?? fetch;
    this.ports = options.ports ?? DISCOVERY_PORTS;
  }

  /** The cockpit's base URL, resolved once and re-resolved after a connection failure. */
  url(): Promise<string> {
    this.resolved ??= this.resolve().catch((error: unknown) => {
      this.resolved = undefined;
      throw error;
    });
    return this.resolved;
  }

  async get<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
    return this.call<T>(path, { method: 'GET' }, signal);
  }

  async post<T = unknown>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.call<T>(
      path,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) },
      signal,
    );
  }

  async projects(signal?: AbortSignal): Promise<ProjectsResponse> {
    const parsed = projectsResponseSchema.safeParse(await this.get('/api/v1/projects', signal));
    if (!parsed.success) throw new CockpitError('the cockpit answered /api/v1/projects with an unexpected shape');
    return parsed.data;
  }

  private async call<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const base = await this.url();
    let response: Response;
    try {
      response = await this.fetchImpl(`${base}${path}`, {
        ...init,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (signal?.aborted) throw new CockpitError('cancelled');
      // A restarted cockpit may come back on another port: forget this one.
      this.resolved = undefined;
      throw new CockpitError(`cezar cockpit unreachable at ${base} — is \`cez serve\` still running? (${describe(error)})`);
    }
    const text = await response.text();
    const body = parseJson(text);
    if (!response.ok) {
      const message =
        body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : text.slice(0, 300) || response.statusText;
      throw new CockpitError(`${response.status}: ${message}`);
    }
    return (body === undefined ? text : body) as T;
  }

  private async resolve(): Promise<string> {
    if (this.explicit) {
      if (await this.probe(this.explicit)) return this.explicit;
      throw new CockpitError(`no cezar cockpit at ${this.explicit} — start it with \`cez serve\`, or fix --url / CEZ_API_URL`);
    }
    const [first, last] = this.ports;
    const candidates = Array.from({ length: last - first + 1 }, (_, i) => `http://127.0.0.1:${first + i}`);
    const healthy = (await Promise.all(candidates.map(async (url) => ((await this.probe(url)) ? url : undefined)))).filter(
      (url): url is string => url !== undefined,
    );
    if (healthy.length === 0) {
      throw new CockpitError(`no cezar cockpit found on 127.0.0.1:${first}–${last} — start it with \`cez serve\``);
    }
    if (healthy.length === 1) return healthy[0]!;
    // Several cockpits: the one that serves this directory's project wins, then the lowest port.
    for (const url of healthy) {
      try {
        const response = await this.fetchImpl(`${url}/api/v1/projects`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 3) });
        const parsed = projectsResponseSchema.safeParse(await response.json());
        if (parsed.success && matchProject(parsed.data.projects, this.cwd)) return url;
      } catch {
        // an unreadable registry is just not a match
      }
    }
    return healthy[0]!;
  }

  private async probe(url: string): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${url}/api/v1/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!response.ok) return false;
      return cockpitHealthSchema.safeParse(await response.json()).success;
    } catch {
      return false;
    }
  }
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: unknown } }).cause;
    return typeof cause?.code === 'string' ? cause.code : error.message;
  }
  return String(error);
}
