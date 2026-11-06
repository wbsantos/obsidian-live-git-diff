/**
 * git.ts — the only place this plugin talks to the outside world.
 *
 * Everything here READS. `git show` and `git rev-parse` are the entire surface; no
 * command that can alter a repository is reachable from this module, and nothing in
 * the plugin imports a filesystem module at all (tools/check-invariant.mjs asserts
 * that as a capability check, which is stronger than grepping for method names).
 */
import { execFile, execFileSync } from 'child_process';
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

/** One commit from a file's history, as shown in the picker and the base pane header. */
export interface CommitInfo {
  /** Abbreviated sha, for display. */
  shortSha: string;
  /** Full sha. This is what gets pinned — an abbreviation can become ambiguous. */
  sha: string;
  /** Relative age from git's `%ar`, e.g. "8 days ago". */
  relative: string;
  /** Absolute local time from git's `%ad`, e.g. "Jul 7, 2:10 PM". */
  date: string;
  /** Commit subject (first line). */
  subject: string;
  /** Author name displayed in the file history. */
  author?: string;
  /**
   * The file's path AS OF this commit. Differs from the current path across a rename,
   * which is why it is captured here rather than assumed — see `fileLog`.
   */
  path: string;
}

/**
 * Field and record separators for git's --format: ASCII US (0x1f) between fields, RS
 * (0x1e) before each record.
 *
 * WHY NOT TABS AND NEWLINES: a commit subject can contain a tab, and `--name-only`
 * appends its own lines after the format string. US/RS are the control codes that mean
 * exactly this, and neither can occur in a subject or a path — so the parse needs no
 * escaping rules and has no ambiguity.
 *
 * WHY NOT NUL (0x00) AS THE RECORD SEPARATOR, which is git's own convention (-z) and
 * the obvious choice: **node refuses to spawn a process with a NUL in any argv element**
 * ("The argument 'args[5]' must be a string without null bytes"). It works when you type
 * it into a shell, which is exactly how it survived a manual probe and then failed on
 * the first real call. RS is the correct byte that also survives the transport.
 */
const US = '\x1f';
const RS = '\x1e';

/**
 * How every commit time this plugin shows a human is formatted.
 *
 * AM/PM, LOCAL, leading zeros stripped: "Jul 7, 2:10 PM".
 * Use portable %d / %I and strip padding in parseCommitFields. The GNU %-d / %-I
 * extensions crash Git for Windows when it formats a commit date.
 *
 * NO TIMEZONE CONVERSION, and no %Z. git already emits the committer's LOCAL time, so
 * the value is correct as-is; adding a conversion would be the bug. %Z was tried and
 * renders EMPTY here (leaving a trailing space), so it is deliberately omitted — the
 * time is local and unambiguous in context.
 *
 * ISO timestamps are for machines. The alignment report (JSON) keeps one; nothing a
 * person reads does.
 */
const HUMAN_DATE = 'format:%b %d, %I:%M %p';

/** shortSha, sha, relative, absolute, subject — the fields every CommitInfo needs. */
const COMMIT_FIELDS = ['%h', '%H', '%ar', '%ad', '%s', '%an'].join(US);

function parseCommitFields(line: string, path: string): CommitInfo | null {
  const [shortSha, sha, relative, date, subject, author] = line.split(US);
  if (!sha) return null;
  return { shortSha, sha, relative, date: date.replace(/(^|\s)0(\d)/g, '$1$2'),
    subject: subject || '(no subject)', author: author || '', path };
}

/**
 * Run git with argv (never a shell string — paths here contain spaces).
 *
 * argv form is also why a ref/branch name from settings cannot become a shell
 * injection: it is an argument, not a fragment of a command line.
 *
 * ARGV IS NOT THE WHOLE STORY. An argv element that begins with '-' is still read by
 * GIT as an OPTION — a separate class from shell injection, and one the arg array does
 * nothing about. So the constraint every caller below holds to is: A REF MUST NEVER BE
 * PARSEABLE AS AN OPTION. `--end-of-options` (git >= 2.24) is what enforces it, and it
 * goes in front of every ref this module hands to git, resolved or not.
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
  let prefix: string;
  try {
    [root, prefix] = git(['-C', dir, 'rev-parse', '--show-toplevel', '--show-prefix']).split(/\r?\n/);
  } catch (e: unknown) {
    throw new GitError(`Not inside a git repository (${dir}).\n${(e as Error).message}`);
  }
  // Git resolves directory symlinks/junctions when entering dir. Its prefix is
  // already relative to the target repository and POSIX-separated; path.relative
  // would instead compare that real root with the vault's logical alias path.
  const rel = prefix + path.basename(abs);
  if (!rel || rel.startsWith('..')) {
    throw new GitError(`File resolves outside its git root:\n  file: ${abs}\n  root: ${root}`);
  }
  return { abs, root, rel };
}

/** Current HEAD sha of a repo. */
export function headSha(root: string): string {
  try {
    // 'HEAD' is a literal and could never be option-shaped — but a rule with an
    // exception is not a rule, so this site carries --end-of-options like every other.
    return git(['-C', root, 'rev-parse', '--end-of-options', 'HEAD']).trim();
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
 *
 * `--end-of-options` is not decoration either. THIS is the ref that arrives from
 * settings — i.e. from the vault's data.json, which in a shared or downloaded vault was
 * not necessarily written by the person now reading the note. Without it, git parses a
 * ref beginning with '-' as an option instead of a revision. That is the argument-
 * injection class, and it is ALSO a plain bug: `-x` is a ref name git will happily
 * create, and this function could not resolve it (`fatal: Needed a single revision`).
 */
export function resolveRef(root: string, ref: string): string {
  const wanted = String(ref || '').trim();
  if (!wanted) throw new GitError('Base ref is empty. Set one in the plugin settings.');
  try {
    return git(['-C', root, 'rev-parse', '--verify', '--end-of-options', `${wanted}^{commit}`]).trim();
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
    // `sha` is already resolved by resolveRef, so --end-of-options here is defence in
    // depth rather than a live hole. It is in anyway: the rule is that no ref reaches
    // git argv without it, and a rule with an exception is not a rule — the next caller
    // to pass this an unresolved ref should not be the one who discovers that.
    return git(['-C', root, 'cat-file', '--end-of-options', 'blob', `${sha}:${rel}`]);
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

/**
 * Commit metadata for any ref. Feeds the base pane header.
 *
 * Needed because a sha alone is meaningless once the base is arbitrary: "base d308280"
 * cannot answer "which version am I looking at?", but
 * `base d308280 · "apply review round 1" · 7 hours ago` can.
 */
export function commitInfoFor(root: string, ref: string): CommitInfo {
  let out: string;
  try {
    // --end-of-options: the signature says `ref`, and a parameter named ref is a ref —
    // today's only caller happens to hand it a resolved sha, but the guard belongs to
    // the contract, not to the current caller.
    out = git([
      '-C', root, 'show', '-s',
      `--format=${COMMIT_FIELDS}`,
      `--date=${HUMAN_DATE}`,
      '--end-of-options', ref,
    ]);
  } catch (e: unknown) {
    throw new GitError(`Cannot read commit ${ref}:\n${(e as Error).message}`);
  }
  const info = parseCommitFields(out.split('\n')[0], '');
  if (!info) throw new GitError(`Cannot read commit ${ref}: git returned no usable output.`);
  return info;
}

/**
 * The commits that touched `rel`, most recent first — the picker's list.
 *
 * `--follow` so history survives a RENAME, and `--name-only` because that is what makes
 * each entry carry the file's path AS OF that commit. Verified against a repo with a
 * real rename in it: the same call yields both the list and the rename map, so resolving
 * "what was this file called at that commit?" costs no extra git invocation.
 *
 * Empty result = the file has never been committed (it is untracked). That is a
 * meaningful answer, not an error, and the caller says so in words.
 *
 * THE ONE CALL IN THIS FILE WITH NO `--end-of-options`, deliberately: it passes git no
 * ref at all, and its only user-derived argument is a PATHSPEC, which the `--` already
 * terminates options for. `--end-of-options` before a `--` would be noise; after it,
 * it would be read as a literal path.
 */
export function fileLog(root: string, rel: string, limit = 50): CommitInfo[] {
  let out: string;
  try {
    out = git([
      // Keep accented paths readable instead of Git's quoted octal byte escapes.
      '-c', 'core.quotepath=false', '-C', root, 'log',
      '--follow',
      '--name-only',
      `--format=${RS}${COMMIT_FIELDS}`,
      `--date=${HUMAN_DATE}`,
      '-n', String(limit),
      '--', rel,
    ]);
  } catch (e: unknown) {
    throw new GitError(`Cannot read the history of ${rel}:\n${(e as Error).message}`);
  }

  const commits: CommitInfo[] = [];
  for (const record of out.split(RS)) {
    if (!record.trim()) continue;
    const lines = record.split('\n');
    // Everything after the format line is --name-only output: a blank line, then the
    // path(s). A merge commit can list none, in which case fall back to the current
    // path — the commit should still be selectable.
    const path = lines.slice(1).map((l) => l.trim()).find((l) => l.length > 0) || rel;
    const info = parseCommitFields(lines[0], path);
    if (info) commits.push(info);
  }
  return commits;
}

/**
 * Read `rel` as it existed at `sha`, following renames.
 *
 * WHY THIS IS NOT JUST `showAt`. A chosen commit may predate a rename, and
 * `git show <old-sha>:<current-path>` fails there with "exists on disk, but not in
 * <sha>" — which, rendered as an empty base pane, reads as "the whole file is new".
 * That is the wrong-but-plausible failure this codebase works hardest to avoid, so the
 * rename is resolved instead: the file's --follow history already knows what the path
 * was at that commit.
 *
 * The two ways this legitimately fails are told apart in words, because "you picked a
 * commit from before this file existed" and "this file has never been committed" want
 * completely different reactions from the reader.
 */
export function readBaseAt(
  root: string,
  rel: string,
  sha: string
): { text: string; path: string; renamedFrom: string | null } {
  try {
    return { text: showAt(root, sha, rel), path: rel, renamedFrom: null };
  } catch (e: unknown) {
    // Fall through to the rename/absent analysis below.
    const history = fileLog(root, rel, 500);

    if (!history.length) {
      throw new GitError(
        `Not tracked in git:\n  ${rel}\n\n` +
        `This file has no commits at all, so there is no earlier version to compare ` +
        `against. Commit it first.`
      );
    }

    const hit = history.find((c) => c.sha === sha || (sha.length >= 7 && c.sha.startsWith(sha)));
    if (hit && hit.path !== rel) {
      // The picked commit IS in this file's history — it just knew the file by a
      // different name. Read it under that name.
      return { text: showAt(root, sha, hit.path), path: hit.path, renamedFrom: hit.path };
    }
    if (hit) {
      // In history, same path, yet `show` failed: not a rename. Surface git verbatim.
      throw e instanceof GitError ? e : new GitError(String((e as Error).message));
    }

    const oldest = history[history.length - 1];
    throw new GitError(
      `This file did not exist at ${sha.slice(0, 7)}.\n  ${rel}\n\n` +
      `Its earliest commit is ${oldest.shortSha} (${oldest.date}) — ${oldest.subject}\n` +
      `Pick that commit or a later one. (If you expected it here, the commit may be on ` +
      `a branch that is not an ancestor of this file's history.)`
    );
  }
}

/** Asynchronous, read-only Git transport for interactive actions and history. */
function gitAsync(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      windowsHide: true, timeout: 30_000, signal,
    }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout); return; }
      if (error.code === 'ENOENT') { reject(new GitError('git not found on PATH. Is git installed?')); return; }
      reject(new GitError(String(stderr || error.message || 'git failed').trim()));
    });
  });
}

export async function resolveGitAsync(app: App, file: TFile, signal?: AbortSignal): Promise<GitContext> {
  const abs = absPathOf(app, file), dir = path.dirname(abs);
  let output: string;
  try { output = await gitAsync(['-C', dir, 'rev-parse', '--show-toplevel', '--show-prefix'], signal); }
  catch (e) { throw new GitError(`Not inside a git repository (${dir}).\n${(e as Error).message}`); }
  const [root, prefix] = output.split(/\r?\n/), rel = prefix + path.basename(abs);
  if (!root || !rel || rel.startsWith('..')) throw new GitError(`File resolves outside its git root: ${abs}`);
  return { abs, root, rel };
}

export async function resolveRefAsync(root: string, ref: string, signal?: AbortSignal): Promise<string> {
  const wanted = String(ref || '').trim();
  if (!wanted) throw new GitError('Base ref is empty. Set one in the plugin settings.');
  try { return (await gitAsync(['-C', root, 'rev-parse', '--verify', '--end-of-options', `${wanted}^{commit}`], signal)).trim(); }
  catch (e) { throw new GitError(`Cannot resolve base ref "${wanted}" in this repository.\n${(e as Error).message}`); }
}

export async function showAtAsync(root: string, sha: string, rel: string, signal?: AbortSignal): Promise<string> {
  try { return await gitAsync(['-C', root, 'cat-file', '--end-of-options', 'blob', `${sha}:${rel}`], signal); }
  catch (e) { throw new GitError(`Cannot read ${rel} at ${sha.slice(0, 7)}. The file may not exist at this version.\n${(e as Error).message}`); }
}

export async function commitInfoForAsync(root: string, ref: string, signal?: AbortSignal): Promise<CommitInfo> {
  const output = await gitAsync(['-C', root, 'show', '-s', `--format=${COMMIT_FIELDS}`,
    `--date=${HUMAN_DATE}`, '--end-of-options', ref], signal);
  const info = parseCommitFields(output.split('\n')[0], '');
  if (!info) throw new GitError(`Cannot read commit ${ref}: git returned no usable output.`);
  return info;
}

export interface FileLogOptions { head?: string; signal?: AbortSignal }
/** A larger prefix of the SAME pinned history is requested for each page, retaining rename context. */
export async function fileLogAsync(root: string, rel: string, limit = 50, options: FileLogOptions = {}): Promise<CommitInfo[]> {
  const count = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
  const head = options.head || await resolveRefAsync(root, 'HEAD', options.signal);
  let output: string;
  try {
    output = await gitAsync(['--literal-pathspecs', '-c', 'core.quotepath=false', '-C', root, 'log',
      '--follow', '--name-status', '-z', `--format=${RS}${COMMIT_FIELDS}`,
      `--date=${HUMAN_DATE}`, '-n', String(count), '--end-of-options', head, '--', rel], options.signal);
  } catch (e) { throw new GitError(`Cannot read the history of ${rel}:\n${(e as Error).message}`); }
  const commits: CommitInfo[] = [];
  let currentPath = rel;
  for (const record of output.split(RS)) {
    if (!record.trim()) continue;
    const parts = record.split('\0'), line = parts.shift() || '';
    const info = parseCommitFields(line.replace(/\r?\n$/, ''), currentPath);
    if (!info) continue;
    // With --follow Git emits one file change. -z preserves spaces and tabs in its names.
    const status = (parts.shift() || '').replace(/^\r?\n/, '');
    if (status.startsWith('R') || status.startsWith('C')) {
      const before = parts.shift(), after = parts.shift();
      if (after) info.path = after;
      if (before) currentPath = before;
    } else if (parts[0]) { info.path = parts[0]; currentPath = parts[0]; }
    commits.push(info);
  }
  return commits;
}

export async function readBaseAtAsync(root: string, rel: string, sha: string, signal?: AbortSignal, pathAtCommit?: string): Promise<{ text: string; path: string; renamedFrom: string | null }> {
  if (pathAtCommit) return { text: await showAtAsync(root, sha, pathAtCommit, signal), path: pathAtCommit, renamedFrom: pathAtCommit === rel ? null : pathAtCommit };
  try { return { text: await showAtAsync(root, sha, rel, signal), path: rel, renamedFrom: null }; }
  catch (original) {
    if (signal?.aborted) throw original;
    const history = await fileLogAsync(root, rel, 500, { signal });
    const hit = history.find(commit => commit.sha === sha || (sha.length >= 7 && commit.sha.startsWith(sha)));
    if (hit && hit.path !== rel) return { text: await showAtAsync(root, sha, hit.path, signal), path: hit.path, renamedFrom: hit.path };
    if (!history.length) throw new GitError(`Not tracked in git: ${rel}. This file has no commits to compare against.`);
    if (hit) throw original;
    throw new GitError(`This file did not exist at ${sha.slice(0, 7)}: ${rel}. Choose a version in this file's history.\n${(original as Error).message}`);
  }
}
