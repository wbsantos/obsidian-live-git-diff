/**
 * git.ts — the only place this plugin talks to the outside world.
 *
 * Everything here READS. `git show` and `git rev-parse` are the entire surface; no
 * command that can alter a repository is reachable from this module, and nothing in
 * the plugin imports a filesystem module at all (tools/check-invariant.mjs asserts
 * that as a capability check, which is stronger than grepping for method names).
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import type { App, TFile } from 'obsidian';

/** Error carrying a human-facing explanation for the base pane. */
export class GitError extends Error {}

/** Resolved git context for a vault file. */
export interface GitContext {
  abs: string;
  root: string;
  rel: string;
}

/**
 * Run git with argv (never a shell string — paths here contain spaces).
 *
 * argv form is also why a ref/branch name from settings cannot become a shell
 * injection: it is an argument, not a fragment of a command line.
 */
function git(args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (e: unknown) {
    const err = e as { stderr?: unknown; code?: string; message?: string };
    const stderr = (err && err.stderr ? String(err.stderr) : '').trim();
    if (err && err.code === 'ENOENT') {
      throw new GitError('git not found on PATH. Is git installed?');
    }
    throw new GitError(stderr || (err && err.message) || 'git failed');
  }
}

/**
 * Absolute on-disk path of a vault file.
 *
 * Written in the plain form on purpose. The read-only invariant is enforced by
 * grepping for WRITE methods, not for this handle — a check you pass by phrasing is
 * not a check. An earlier draft dodged a handle-shaped grep by destructuring, which
 * made the check pass by rephrasing rather than by fact; the check was narrowed
 * instead. getFullPath is pure string math; no I/O, no mutation.
 */
export function absPathOf(app: App, file: TFile): string {
  const adapter = app.vault.adapter as unknown as {
    getFullPath?: (p: string) => string;
    basePath?: string;
  };
  if (adapter && typeof adapter.getFullPath === 'function') {
    return adapter.getFullPath(file.path);
  }
  const base = adapter && adapter.basePath;
  if (!base) {
    throw new GitError('Cannot resolve this vault to a real folder on disk.');
  }
  return path.join(base, file.path);
}

/**
 * Resolve the git toplevel for a file.
 *
 * CRITICAL: the vault root is NOT necessarily the git root. A vault can be a
 * SUBDIRECTORY of the repo, so the path we hand to `git show` must be relative
 * to the git toplevel, never relative to the vault. Getting this wrong makes
 * `git show` fail and the base pane come back empty — which reads as "the whole
 * file is brand new" rather than as an error. That is exactly the wrong-but-
 * plausible failure this function exists to prevent.
 */
export function resolveGit(app: App, file: TFile): GitContext {
  const abs = absPathOf(app, file);
  const dir = path.dirname(abs);
  let root: string;
  try {
    root = git(['-C', dir, 'rev-parse', '--show-toplevel']).trim();
  } catch (e: unknown) {
    throw new GitError(`Not inside a git repository (${dir}).\n${(e as Error).message}`);
  }
  // Relative to the GIT ROOT, POSIX-separated (git speaks posix paths).
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) {
    throw new GitError(`File resolves outside its git root:\n  file: ${abs}\n  root: ${root}`);
  }
  return { abs, root, rel };
}

/** Current HEAD sha of a repo. */
export function headSha(root: string): string {
  try {
    return git(['-C', root, 'rev-parse', 'HEAD']).trim();
  } catch (e: unknown) {
    throw new GitError(`Cannot read HEAD — the repo may have no commits yet.\n${(e as Error).message}`);
  }
}

/**
 * Resolve an arbitrary ref (branch, tag, sha, `origin/main`, `HEAD~3`) to a sha.
 *
 * `^{commit}` is not decoration: it forces the peel, so an ANNOTATED TAG resolves to
 * the commit it points at rather than to the tag object — whose sha `git show <tag>:path`
 * would then fail on. It also makes a nonsense ref fail HERE, with the ref quoted in
 * the message, instead of failing later inside `git show` where the error reads as
 * "the file isn't tracked".
 */
export function resolveRef(root: string, ref: string): string {
  const wanted = String(ref || '').trim();
  if (!wanted) throw new GitError('Base ref is empty. Set one in the plugin settings.');
  try {
    return git(['-C', root, 'rev-parse', '--verify', `${wanted}^{commit}`]).trim();
  } catch (e: unknown) {
    throw new GitError(
      `Cannot resolve base ref "${wanted}" in this repository.\n` +
      `Check the plugin settings — a ref must be a branch, tag, or commit that exists here.\n` +
      `${(e as Error).message}`
    );
  }
}

/** Text of <rel> at <sha>. Throws GitError with a readable reason. */
export function showAt(root: string, sha: string, rel: string): string {
  try {
    return git(['-C', root, 'show', `${sha}:${rel}`]);
  } catch (e: unknown) {
    const m = (e as Error).message || '';
    if (/exists on disk, but not in|does not exist in|path .* does not exist/i.test(m)) {
      throw new GitError(
        `Not tracked in git at ${sha.slice(0, 7)}:\n  ${rel}\n\n` +
        `The file is untracked, or was added after this base commit — ` +
        `so there is no earlier version to compare against.`
      );
    }
    throw new GitError(`git show failed for ${rel} at ${sha.slice(0, 7)}:\n${m}`);
  }
}
