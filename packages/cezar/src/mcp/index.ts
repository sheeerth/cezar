/**
 * `cez mcp` — an MCP server over stdio so an agent OUTSIDE cezar (a Claude Code session in a
 * terminal) can supervise cezar tasks: start, wait, read status, messages and diff, reply,
 * continue, cancel (spec `.ai/specs/2026-10-06-cez-mcp.md`).
 *
 * A thin client of the already-running cockpit: no server route, no state, nothing to configure.
 * It is NOT the interface for an agent INSIDE a task — that is `cez task` (dispatch), whose engine
 * brakes (children in flight, a budget carved from the parent's) this server must never bypass.
 * So inside a task it serves the read tools only, however it was registered.
 */
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Transport } from '@modelcontextprotocol/server';
import { Cockpit } from './cockpit.ts';
import { inTaskWorktree, realCwd } from './projects.ts';
import { annotationsFor, selectTools, toError, toResult, type ToolDef } from './tools.ts';

const USAGE = `cez mcp — an MCP server (stdio) for supervising cezar tasks from an MCP client

  cez mcp [--url <cockpit url>] [--read-only]

  Register it in your MCP client, e.g. Claude Code:
    { "mcpServers": { "cezar": { "command": "cez", "args": ["mcp"] } } }

  It talks to an already-running cockpit (\`cez serve\`): --url, then CEZ_API_URL, then the first
  cezar cockpit found on 127.0.0.1:4321–4370. --read-only serves only the read tools; inside a
  cezar task (CEZ_TASK_ID set, or a task worktree) that is always the case.`;

export interface McpEnv {
  CEZ_API_URL?: string;
  CEZ_TASK_ID?: string;
}

export interface McpIo {
  log: (line: string) => void;
  error: (line: string) => void;
  /** Test seam: serve over this transport instead of the process's stdio. */
  transport?: Transport;
  fetch?: typeof fetch;
  cwd?: string;
}

/** Inside a cezar task the write tools are never offered (spec § In-task restriction). */
export function runsInsideTask(env: McpEnv, cwd: string): boolean {
  return Boolean(env.CEZ_TASK_ID) || inTaskWorktree(cwd);
}

export function buildServer(tools: readonly ToolDef[], cockpit: Cockpit, cwd: string, version: string): McpServer {
  const server = new McpServer({ name: 'cezar', version }, { capabilities: { tools: {} } });
  for (const def of tools) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: def.input, annotations: annotationsFor(def.kind) },
      async (args, ctx) => {
        try {
          return toResult(await def.handler(args as never, { cockpit, cwd, signal: ctx.mcpReq.signal }));
        } catch (error) {
          return toError(error);
        }
      },
    );
  }
  return server;
}

export async function runMcpCommand(
  args: string[],
  env: McpEnv = process.env,
  io: McpIo = { log: console.log, error: console.error },
  version = '0.0.0',
): Promise<number> {
  let values: { url?: string; 'read-only'?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      options: { url: { type: 'string' }, 'read-only': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } },
      strict: true,
    }));
  } catch (error) {
    io.error(`cez mcp: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.log(USAGE);
    return 0;
  }
  const cwd = realCwd(io.cwd);
  const readOnly = Boolean(values['read-only']) || runsInsideTask(env, cwd);
  const cockpit = new Cockpit({ url: values.url ?? env.CEZ_API_URL, cwd, fetch: io.fetch });
  const tools = selectTools(readOnly);
  // stdout is the JSON-RPC channel: diagnostics go to stderr only.
  serveStdio(() => buildServer(tools, cockpit, cwd, version), {
    ...(io.transport ? { transport: io.transport } : {}),
    onerror: (error) => io.error(`cez mcp: ${error.message}`),
  });
  return 0;
}
