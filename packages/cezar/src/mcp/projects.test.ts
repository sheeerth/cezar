import { describe, expect, it } from 'vitest';
import { containsPath, inTaskWorktree, matchProject } from './projects.ts';
import { project } from './mcp.testkit.ts';

describe('default-project resolution from the cwd', () => {
  it('matches on path-segment boundaries, never a string prefix', () => {
    expect(containsPath('/a/repo', '/a/repo')).toBe(true);
    expect(containsPath('/a/repo', '/a/repo/src/x')).toBe(true);
    expect(containsPath('/a/repo/', '/a/repo/src')).toBe(true);
    expect(containsPath('/a/repo', '/a/repo-2')).toBe(false);
    expect(containsPath('/a/repo', '/a')).toBe(false);
  });

  it('picks the longest root when registrations nest', () => {
    const projects = [project('outer', '/w'), project('inner', '/w/packages/inner')];
    expect(matchProject(projects, '/w/packages/inner/src')?.id).toBe('inner');
    expect(matchProject(projects, '/w/docs')?.id).toBe('outer');
  });

  it('resolves a task worktree to the project that owns it', () => {
    const projects = [project('boot', '/repos/boot')];
    expect(matchProject(projects, '/repos/boot/.ai/cezar/worktrees/abc-123')?.id).toBe('boot');
  });

  it('ignores a project whose root is missing or not a git repo', () => {
    const projects = [project('gone', '/repos/gone', { status: 'missing' })];
    expect(matchProject(projects, '/repos/gone/src')).toBeUndefined();
  });

  it('returns nothing outside every registered project (the caller falls back to boot)', () => {
    expect(matchProject([project('boot', '/repos/boot')], '/tmp')).toBeUndefined();
  });
});

describe('inTaskWorktree', () => {
  it('recognises a cezar task worktree and paths below it', () => {
    expect(inTaskWorktree('/repos/boot/.ai/cezar/worktrees/59c07a97-7ff6')).toBe(true);
    expect(inTaskWorktree('/repos/boot/.ai/cezar/worktrees/59c07a97-7ff6/packages/web')).toBe(true);
  });

  it('does not fire on the repo itself or on look-alike paths', () => {
    expect(inTaskWorktree('/repos/boot')).toBe(false);
    expect(inTaskWorktree('/repos/boot/.ai/cezar/worktrees')).toBe(false);
    expect(inTaskWorktree('/repos/boot/.ai/cezar/worktreesX/abc')).toBe(false);
  });
});
