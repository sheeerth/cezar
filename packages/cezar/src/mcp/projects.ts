/**
 * Which project a `cez mcp` tool call means when it names none (spec `2026-10-06-cez-mcp`):
 * the registered project whose root contains the MCP server's working directory — Claude Code
 * spawns stdio servers in its own cwd — and otherwise the cockpit's boot project.
 */
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';

interface ProjectLike {
  id: string;
  root: string;
  status: string;
}

/** `cwd` is `root` or below it — on a path-segment boundary, never a string prefix. */
export function containsPath(root: string, cwd: string): boolean {
  const base = root.endsWith(sep) ? root.slice(0, -1) : root;
  return cwd === base || cwd.startsWith(base + sep);
}

/** The usable project with the LONGEST root containing `cwd` (nested registrations exist). */
export function matchProject<P extends ProjectLike>(projects: readonly P[], cwd: string): P | undefined {
  let best: P | undefined;
  for (const project of projects) {
    if (project.status !== 'ok' || !containsPath(project.root, cwd)) continue;
    if (!best || project.root.length > best.root.length) best = project;
  }
  return best;
}

/** `realpath(cwd)`, so a symlinked checkout still matches the registry's realpath'd roots. */
export function realCwd(cwd = process.cwd()): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** True inside a cezar task worktree (`<root>/.ai/cezar/worktrees/<id>`, or below it). */
export function inTaskWorktree(cwd: string): boolean {
  return /[\\/]\.ai[\\/]cezar[\\/]worktrees[\\/][^\\/]+(?:[\\/]|$)/.test(cwd);
}

/** The scope prefix every project route answers under. */
export const projectScope = (projectId: string) => `/api/v1/p/${encodeURIComponent(projectId)}`;
