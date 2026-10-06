/**
 * The `cez mcp` tool table (spec `.ai/specs/2026-10-06-cez-mcp.md` § API Contracts) — the ONE
 * place a tool is defined: name, description, input schema, kind and handler.
 *
 * A tool's MCP hints are derived from its `kind`, so no tool can ship without them, and the
 * read-only filter (`--read-only`, or running inside a cezar task) is a filter on `kind` too.
 * Handlers map a call onto existing `/api/v1` routes and return a PROJECTION — the fields a
 * supervising agent acts on, not the whole run record.
 */
import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { changesPayloadSchema, createRunInputBaseSchema, runStatusSchema, type RunRecord } from '@open-mercato/cezar-contract';
import { Cockpit, CockpitError } from './cockpit.ts';
import { matchProject, projectScope } from './projects.ts';
import { isSettled, waitForRuns, type WaitTarget } from './wait.ts';

export type ToolKind = 'read' | 'write' | 'destructive';

export interface ToolContext {
  cockpit: Cockpit;
  /** The realpath'd working directory the default project is matched against. */
  cwd: string;
  signal: AbortSignal;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  input: S;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}

/** Results are capped so one call cannot flood the supervising session's context. */
export const RESULT_CHAR_CAP = 50_000;

export function annotationsFor(kind: ToolKind): ToolAnnotations {
  switch (kind) {
    case 'read':
      return { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    case 'write':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    case 'destructive':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  }
}

const projectId = z
  .string()
  .min(1)
  .optional()
  .describe('Registered project id (see list_projects). Omit for the project containing the current directory, else the cockpit’s boot project.');
const runId = z.string().min(1).describe('The run (task) id.');

/** The project a call targets: the explicit id, else the cwd's project, else the boot project. */
export async function resolveProject(ctx: ToolContext, explicit: string | undefined): Promise<string> {
  if (explicit) return explicit;
  const { projects, bootProject } = await ctx.cockpit.projects(ctx.signal);
  return matchProject(projects, ctx.cwd)?.id ?? bootProject;
}

/** What a supervisor needs from a run record — real fields only, plus two derived flags. */
export function runProjection(run: RunRecord & { archived?: boolean }) {
  return {
    id: run.id,
    title: run.title,
    status: run.status,
    ...(run.activity ? { activity: run.activity } : {}),
    settled: isSettled(run),
    needsAnswer: run.status === 'waiting' || run.awaitingAnswerSince !== undefined,
    workflow: run.workflow,
    ...(run.currentStepId ? { currentStepId: run.currentStepId } : {}),
    ...(run.branch ? { branch: run.branch } : {}),
    tokensUsed: run.tokensUsed,
    ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
    ...(run.pullRequestUrl ? { pullRequestUrl: run.pullRequestUrl } : {}),
    createdAt: run.createdAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

export const fetchRun = (ctx: ToolContext, project: string, id: string, signal = ctx.signal) =>
  ctx.cockpit.get<RunRecord>(`${projectScope(project)}/runs/${encodeURIComponent(id)}`, signal);

// ---- conversation projection (get_run_messages) ---------------------------------------------

interface HistoryEvent {
  seq: number;
  ts: string;
  type: string;
  [key: string]: unknown;
}
interface HistoryPage {
  events: HistoryEvent[];
  olderCursor?: string;
  hasOlder: boolean;
  asOfSeq: number;
}

const MAX_HISTORY_PAGES = 3;
const TOOL_SUMMARY_CHARS = 160;

function oneLine(value: unknown, max = TOOL_SUMMARY_CHARS): string {
  const text = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One conversation item out of a stored event, or undefined for bookkeeping events. The v1
 *  `text` event carries assistant prose on every backend (AGENT_PROTOCOL.md); the v2 `item.*`
 *  twins are skipped so nothing is counted twice. */
export function conversationItem(event: HistoryEvent): Record<string, unknown> | undefined {
  const base = { seq: event.seq, ts: event.ts };
  switch (event.type) {
    case 'text':
      return typeof event.text === 'string' && event.text.trim() ? { ...base, role: 'assistant', text: event.text } : undefined;
    case 'user-message':
      return { ...base, role: 'user', text: typeof event.text === 'string' ? event.text : '' };
    case 'tool-call':
      return { ...base, role: 'tool', summary: `${String(event.tool ?? 'tool')}: ${oneLine(event.input)}` };
    case 'ask.requested':
      return { ...base, role: 'question', questions: event.questions };
    case 'error':
    case 'session.error':
      return { ...base, role: 'error', text: typeof event.message === 'string' ? event.message : oneLine(event) };
    default:
      return undefined;
  }
}

// ---- size discipline ---------------------------------------------------------------------------

/** Wraps a projection as an MCP result: the JSON as text plus `structuredContent`, capped. */
export function toResult(value: Record<string, unknown>) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= RESULT_CHAR_CAP) {
    return { content: [{ type: 'text' as const, text }], structuredContent: value };
  }
  const truncated = {
    truncated: true,
    hint: 'result exceeded 50,000 characters — narrow the call (a smaller limit, a path, patches: false)',
    preview: text.slice(0, RESULT_CHAR_CAP - 500),
  };
  return { content: [{ type: 'text' as const, text: JSON.stringify(truncated) }], structuredContent: truncated };
}

export function toError(error: unknown) {
  const message = error instanceof CockpitError ? error.message : `cez mcp: ${error instanceof Error ? error.message : String(error)}`;
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Drops patches past the budget instead of cutting JSON mid-string. */
function capPatches(files: Array<Record<string, unknown> & { patch?: string }>, budget = RESULT_CHAR_CAP - 5_000) {
  let used = 0;
  let truncated = false;
  const out = files.map((file) => {
    const patch = file.patch ?? '';
    if (used + patch.length > budget) {
      truncated = true;
      const { patch: _drop, ...rest } = file;
      return { ...rest, patchOmitted: true };
    }
    used += patch.length;
    return file;
  });
  return { files: out, truncated };
}

// ---- the table ----------------------------------------------------------------------------------

const tool = <S extends z.ZodObject>(def: ToolDef<S>): ToolDef => def as unknown as ToolDef;

export const READ_TOOLS: ToolDef[] = [
  tool({
    name: 'list_projects',
    title: 'List cezar projects',
    description:
      'List the repositories this cezar cockpit serves (id, name, status, tags). `current` marks the project tools use when projectId is omitted. Use an id from here as projectId to work in another repository.',
    kind: 'read',
    input: z.object({}),
    async handler(_args, ctx) {
      const { projects, bootProject } = await ctx.cockpit.projects(ctx.signal);
      const current = matchProject(projects, ctx.cwd)?.id ?? bootProject;
      return {
        cockpit: await ctx.cockpit.url(),
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          ...(p.tags?.length ? { tags: p.tags } : {}),
          current: p.id === current,
          boot: p.id === bootProject,
        })),
      };
    },
  }),
  tool({
    name: 'list_workflows',
    title: 'List workflows',
    description: 'List the workflows a task can run with (pass `name` as start_run’s workflow). `quick-task` is the built-in default.',
    kind: 'read',
    input: z.object({ projectId }),
    async handler({ projectId: explicit }, ctx) {
      const project = await resolveProject(ctx, explicit);
      const body = await ctx.cockpit.get<{ workflows: Array<{ name: string; description?: string; source: string }> }>(
        `${projectScope(project)}/workflows`,
        ctx.signal,
      );
      return {
        projectId: project,
        workflows: body.workflows.map((w) => ({ name: w.name, ...(w.description ? { description: w.description } : {}), source: w.source })),
      };
    },
  }),
  tool({
    name: 'list_runs',
    title: 'List tasks',
    description: 'List recent tasks of a project, newest first, with status. Archived tasks are hidden unless includeArchived is true.',
    kind: 'read',
    input: z.object({
      projectId,
      status: z.array(runStatusSchema).optional().describe('Only tasks in these statuses.'),
      limit: z.number().int().min(1).max(100).optional().describe('At most this many tasks (default 30).'),
      includeArchived: z.boolean().optional(),
    }),
    async handler({ projectId: explicit, status, limit, includeArchived }, ctx) {
      const project = await resolveProject(ctx, explicit);
      const index = await ctx.cockpit.get<{
        runs: Array<{ projectId: string; id: string; title: string; status: string; activity?: string; archived: boolean; createdAt: string; finishedAt?: string; costUsd?: number }>;
        truncated: string[];
      }>('/api/v1/workspace/runs-index', ctx.signal);
      const runs = index.runs
        .filter((r) => r.projectId === project)
        .filter((r) => includeArchived || !r.archived)
        .filter((r) => !status || status.includes(r.status as z.infer<typeof runStatusSchema>))
        .slice(0, limit ?? 30)
        .map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          ...(r.activity ? { activity: r.activity } : {}),
          createdAt: r.createdAt,
          ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
          ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
          ...(r.archived ? { archived: true } : {}),
        }));
      return { projectId: project, runs, truncated: index.truncated.includes(project) };
    },
  }),
  tool({
    name: 'get_run',
    title: 'Get task status',
    description:
      'Current state of one task: status, whether it has settled (stopped actively working: waiting for you, monitoring, in review, or finished), whether it needs an answer, branch, tokens and cost.',
    kind: 'read',
    input: z.object({ projectId, runId }),
    async handler({ projectId: explicit, runId: id }, ctx) {
      const project = await resolveProject(ctx, explicit);
      return { projectId: project, ...runProjection(await fetchRun(ctx, project, id)) };
    },
  }),
  tool({
    name: 'get_run_messages',
    title: 'Read task conversation',
    description:
      'The newest conversation items of a task, oldest first: assistant text, user messages, one-line tool-call summaries, questions the agent asked and errors. Use it to read what the worker last said or asked.',
    kind: 'read',
    input: z.object({
      projectId,
      runId,
      limit: z.number().int().min(1).max(50).optional().describe('How many items (default 15).'),
    }),
    async handler({ projectId: explicit, runId: id, limit }, ctx) {
      const project = await resolveProject(ctx, explicit);
      const want = limit ?? 15;
      const path = `${projectScope(project)}/runs/${encodeURIComponent(id)}/history`;
      const items: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      let asOfSeq = 0;
      let hasOlder = false;
      for (let page = 0; page < MAX_HISTORY_PAGES && items.length < want; page++) {
        const body = await ctx.cockpit.get<HistoryPage>(cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path, ctx.signal);
        if (page === 0) asOfSeq = body.asOfSeq;
        // Pages run oldest→newest; walk each newest-first so the cap keeps the most recent.
        for (const event of [...body.events].reverse()) {
          const item = conversationItem(event);
          if (item) items.push(item);
          if (items.length >= want) break;
        }
        hasOlder = body.hasOlder;
        cursor = body.olderCursor;
        if (!cursor) break;
      }
      return { projectId: project, runId: id, asOfSeq, items: items.reverse(), moreOlder: hasOlder || items.length >= want };
    },
  }),
  tool({
    name: 'get_diff',
    title: 'Get task diff',
    description:
      'What the task changed, against the same base the cockpit’s Changes tab uses: per-file status, line counts and unified patches. Pass path to read one file’s patch, or patches: false for a stat-only overview of a large change.',
    kind: 'read',
    input: z.object({
      projectId,
      runId,
      path: z.string().min(1).optional().describe('Only this file (repo-relative path).'),
      patches: z.boolean().optional().describe('Include unified patches (default true).'),
    }),
    async handler({ projectId: explicit, runId: id, path, patches }, ctx) {
      const project = await resolveProject(ctx, explicit);
      const raw = await ctx.cockpit.get(`${projectScope(project)}/runs/${encodeURIComponent(id)}/changes`, ctx.signal);
      const parsed = changesPayloadSchema.safeParse(raw);
      if (!parsed.success) throw new CockpitError('the cockpit answered /changes with an unexpected shape');
      const selected = parsed.data.files.filter((f) => !path || f.path === path || f.oldPath === path);
      if (path && selected.length === 0) throw new CockpitError(`no change to ${path} in run ${id}`);
      const files = selected.map(({ path: p, oldPath, status, adds, dels, binary, patch }) => ({
        path: p,
        ...(oldPath ? { oldPath } : {}),
        status,
        adds,
        dels,
        ...(binary ? { binary } : {}),
        ...(patches === false ? {} : { patch }),
      }));
      const capped = capPatches(files);
      return {
        projectId: project,
        runId: id,
        stat: parsed.data.stat,
        files: capped.files,
        ...(capped.truncated ? { truncated: true, hint: 'some patches were omitted — call get_diff with path for one file' } : {}),
      };
    },
  }),
];

/** `wait_for_runs` is read-only, but it is the loop's other half, so it lives with the writers. */
export const WAIT_TOOL: ToolDef = tool({
  name: 'wait_for_runs',
  title: 'Wait for tasks',
  description:
    'Wait until one task (mode any, the default) or all of them (mode all) settles — waiting for an answer, monitoring, in review, done, failed or cancelled — or until timeoutS passes (at most 45 s). It always returns within that time with every task’s current state; if timedOut is true and you still want to wait, call it again.',
  kind: 'read',
  input: z.object({
    runs: z
      .array(z.object({ runId, projectId }))
      .min(1)
      .max(8)
      .describe('The tasks to watch; each may name its own project.'),
    mode: z.enum(['any', 'all']).optional(),
    timeoutS: z.number().int().min(1).max(45).optional().describe('Seconds before returning anyway (default 40, max 45).'),
  }),
  async handler({ runs, mode, timeoutS }, ctx) {
    let fallback: string | undefined;
    const targets: WaitTarget[] = [];
    for (const r of runs) {
      fallback ??= r.projectId ? undefined : await resolveProject(ctx, undefined);
      targets.push({ runId: r.runId, projectId: r.projectId ?? fallback! });
    }
    const { timedOut, outcomes } = await waitForRuns(targets, (t, signal) => fetchRun(ctx, t.projectId, t.runId, signal), {
      mode: mode ?? 'any',
      timeoutMs: (timeoutS ?? 40) * 1_000,
      signal: ctx.signal,
    });
    return {
      timedOut,
      runs: outcomes.map((o) =>
        o.run
          ? { projectId: o.target.projectId, ...runProjection(o.run), ...(o.error ? { error: o.error } : {}) }
          : { projectId: o.target.projectId, id: o.target.runId, settled: o.error === 'not found', error: o.error ?? 'unknown' },
      ),
    };
  },
});

/** start_run's body: the contract's own fields, picked — so what the tool advertises is what
 *  `POST /runs` validates. `workflow` is optional HERE because the route needs exactly one of
 *  workflow/steps and this tool never sends steps: it fills in `quick-task`. */
const startRunInput = createRunInputBaseSchema
  .pick({ task: true, workflow: true, runner: true, model: true, agentProfile: true })
  .extend({ projectId });

export const WRITE_TOOLS: ToolDef[] = [
  tool({
    name: 'start_run',
    title: 'Start a task',
    description:
      'Start a cezar task: an agent works on `task` in its own git worktree and branch and stops at the review gate (it never merges). Returns the task id immediately — follow it with wait_for_runs. workflow defaults to quick-task (see list_workflows); runner/model pick the agent backend.',
    kind: 'write',
    input: startRunInput,
    async handler({ projectId: explicit, workflow, ...rest }, ctx) {
      const project = await resolveProject(ctx, explicit);
      const run = await ctx.cockpit.post<RunRecord>(`${projectScope(project)}/runs`, { ...rest, workflow: workflow ?? 'quick-task' }, ctx.signal);
      return { projectId: project, id: run.id, title: run.title, status: run.status, ...(run.branch ? { branch: run.branch } : {}) };
    },
  }),
  tool({
    name: 'send_run_message',
    title: 'Message a task',
    description:
      'Send a message to a task’s agent — an answer to its question, a correction, more instructions. A live session gets it now; a queued task gets it folded into its prompt. To reopen a finished task, use continue_run.',
    kind: 'write',
    input: z.object({ projectId, runId, text: z.string().trim().min(1).max(100_000) }),
    async handler({ projectId: explicit, runId: id, text }, ctx) {
      const project = await resolveProject(ctx, explicit);
      const body = await ctx.cockpit.post<Record<string, unknown>>(`${projectScope(project)}/runs/${encodeURIComponent(id)}/messages`, { text }, ctx.signal);
      return { projectId: project, runId: id, ...body };
    },
  }),
  tool({
    name: 'continue_run',
    title: 'Continue a task',
    description: 'Reopen a task that stopped (review, done, failed, cancelled) for another turn, optionally with new instructions in text.',
    kind: 'write',
    input: z.object({ projectId, runId, text: z.string().max(100_000).optional() }),
    async handler({ projectId: explicit, runId: id, text }, ctx) {
      const project = await resolveProject(ctx, explicit);
      const body = await ctx.cockpit.post<Record<string, unknown>>(
        `${projectScope(project)}/runs/${encodeURIComponent(id)}/continue`,
        text ? { text } : {},
        ctx.signal,
      );
      return { projectId: project, runId: id, ...body };
    },
  }),
  tool({
    name: 'cancel_run',
    title: 'Cancel a task',
    description: 'Stop a task’s agent now. The worktree and branch stay; the task ends cancelled.',
    kind: 'destructive',
    input: z.object({ projectId, runId }),
    async handler({ projectId: explicit, runId: id }, ctx) {
      const project = await resolveProject(ctx, explicit);
      const body = await ctx.cockpit.post<Record<string, unknown>>(`${projectScope(project)}/runs/${encodeURIComponent(id)}/cancel`, {}, ctx.signal);
      return { projectId: project, runId: id, ...body };
    },
  }),
  tool({
    name: 'finish_run',
    title: 'Finish a task',
    description: 'Close a task’s open agent session and settle it as finished — use it when the work is accepted and the agent should stop listening.',
    kind: 'destructive',
    input: z.object({ projectId, runId }),
    async handler({ projectId: explicit, runId: id }, ctx) {
      const project = await resolveProject(ctx, explicit);
      const body = await ctx.cockpit.post<Record<string, unknown>>(`${projectScope(project)}/runs/${encodeURIComponent(id)}/finish`, {}, ctx.signal);
      return { projectId: project, runId: id, ...body };
    },
  }),
];

export const ALL_TOOLS: ToolDef[] = [...READ_TOOLS, WAIT_TOOL, ...WRITE_TOOLS];

/** The tools a server registers: everything, or only `read` when it must not mutate. */
export function selectTools(readOnly: boolean, tools: readonly ToolDef[] = ALL_TOOLS): ToolDef[] {
  return readOnly ? tools.filter((t) => t.kind === 'read') : [...tools];
}
