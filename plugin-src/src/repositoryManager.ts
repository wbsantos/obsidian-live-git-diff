import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as path from 'path';
import type { App, TFile } from 'obsidian';
import type { GitContext } from './git.ts';
import { resolveRepository, withRepositoryMutation } from './repository.ts';

export interface RepositoryChange {
  sha: string; shortSha: string; changeId?: string; subject: string; author: string;
  date: string; description?: string; parents?: string[];
}
export interface RepositoryFile { path: string; oldPath?: string; status: string }
export interface RepositoryStatus { files: RepositoryFile[]; token: string; description?: string }
export interface RepositoryPage { changes: RepositoryChange[]; hasMore: boolean; anchor?: string }
export interface RepositoryHistoryOptions { path?: string; offset: number; limit: number; anchor?: string }

function command(binary: string, cwd: string, args: string[], signal?: AbortSignal, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (error, out, err) => error ? reject(new Error(String(err || error.message).trim())) : resolve(out));
    // stdin pathspecs avoid Windows' command-line length limit and quote filenames exactly.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
const git = (ctx: GitContext, args: string[], signal?: AbortSignal, input?: string): Promise<string> =>
  command('git', ctx.root, ['--literal-pathspecs', '-C', ctx.root, ...args], signal, input);
const jj = (ctx: GitContext, args: string[], signal?: AbortSignal, mutate = false): Promise<string> =>
  command('jj', ctx.workspaceRoot!, [...(mutate ? [] : ['--ignore-working-copy']), '--no-pager', '--color=never', '-R', ctx.workspaceRoot!, ...args], signal);
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
function validPath(value: string, empty = false): string {
  if ((empty && value === '') || (value && !value.includes('\0') && !value.includes('\\') && !path.posix.isAbsolute(value) &&
    !/^[a-z]:/i.test(value) && !value.split('/').some(part => part === '..' || part === '.' || part === ''))) return value;
  throw new Error('Choose a path inside this repository.');
}
function validSha(value: string): string {
  if (!/^[0-9a-f]{40,64}$/.test(value)) throw new Error('Invalid change identifier.');
  return value;
}

/** The sentinel is resolved as a path only; it is never created or read. */
export async function resolveRepositoryDirectory(app: App, vaultPath: string, signal?: AbortSignal): Promise<GitContext> {
  validPath(vaultPath, true);
  const ctx = await resolveRepository(app, { path: [vaultPath, '.repository-directory-context'].filter(Boolean).join('/') } as TFile, signal);
  return { ...ctx, abs: path.dirname(ctx.abs), rel: path.posix.dirname(ctx.rel) === '.' ? '' : path.posix.dirname(ctx.rel) };
}

async function head(ctx: GitContext, signal?: AbortSignal): Promise<string> {
  // rev-parse --quiet has the same empty result for an unborn and a detached unborn HEAD.
  try { return (await git(ctx, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal)).trim(); }
  catch (error) { if (signal?.aborted) throw error; if (/^Command failed:/.test(String((error as Error).message))) return ''; throw error; }
}

/** A complete immutable query anchor, including other branches and detached HEAD. */
export async function repositoryAnchor(ctx: GitContext, signal?: AbortSignal): Promise<string> {
  if (ctx.backend === 'jj') {
    return withRepositoryMutation(ctx, async () => {
      await jj(ctx, ['util', 'snapshot'], signal, true);
      const operation = (await jj(ctx, ['op', 'log', '-G', '-n', '1', '-T', 'id'], signal)).trim();
      if (!/^[0-9a-f]+$/.test(operation)) throw new Error('Unable to identify the repository state.');
      return `jj:${operation}`;
    });
  }
  const [refs, current] = await Promise.all([
    git(ctx, ['for-each-ref', '--format=%(objectname)'], signal), head(ctx, signal),
  ]);
  return `git:${[...new Set([...refs.split(/\s+/), current].filter(Boolean))].sort().join(',')}`;
}

const gitFormat = '%H%x00%h%x00%s%x00%an%x00%aI%x00%B%x00%P%x00';
function gitChanges(output: string): RepositoryChange[] {
  const fields = output.split('\0'), changes: RepositoryChange[] = [];
  for (let i = 0; i + 6 < fields.length; i += 7) {
    const sha = fields[i].trim(); if (!sha) continue;
    changes.push({ sha, shortSha: fields[i + 1], subject: fields[i + 2] || '(no description)', author: fields[i + 3],
      date: fields[i + 4], description: fields[i + 5].trimEnd(), parents: fields[i + 6].split(' ').filter(Boolean) });
  }
  return changes;
}
const jjFields = '"sha" => commit_id, "changeId" => change_id, "subject" => description.first_line(), "description" => description, "author" => author.name(), "date" => committer.timestamp().format("%Y-%m-%dT%H:%M:%S%:z"), "parents" => parents.map(|p| p.commit_id())';
const jjTemplate = `json({${jjFields}}) ++ "\\n"`;
function jjChanges(output: string): RepositoryChange[] {
  return output.split(/\r?\n/).filter(Boolean).map(line => {
    const value = JSON.parse(line) as RepositoryChange;
    return { ...value, shortSha: value.sha.slice(0, 8), subject: value.subject || '(no description)' };
  });
}
export async function listRepositoryHistory(ctx: GitContext, options: RepositoryHistoryOptions, signal?: AbortSignal): Promise<RepositoryPage> {
  const { offset, limit } = options, scope = validPath(options.path || '', true);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Invalid history page.');
  const anchor = options.anchor ?? await repositoryAnchor(ctx, signal);
  let changes: RepositoryChange[];
  if (ctx.backend === 'jj') {
    if (!/^jj:[0-9a-f]+$/.test(anchor)) throw new Error('Invalid repository state.');
    // JJ has no skip option. Its bounded prefix is cached by the caller, while the operation pins paging.
    changes = jjChanges(await jj(ctx, ['--at-operation', anchor.slice(3), 'log', '-G', '-r', 'all() ~ root()',
      '-n', String(offset + limit + 1), '-T', jjTemplate, ...(scope ? ['--', `root:${JSON.stringify(scope)}`] : [])], signal)).slice(offset);
  } else {
    if (!/^git:(?:[0-9a-f]{40,64}(?:,[0-9a-f]{40,64})*)?$/.test(anchor)) throw new Error('Invalid repository state.');
    const refs = anchor.slice(4).split(',').filter(Boolean);
    changes = refs.length ? gitChanges(await git(ctx, ['log', '--topo-order', '--no-show-signature', `--skip=${offset}`,
      `--max-count=${limit + 1}`, `--format=${gitFormat}`, '--end-of-options', ...refs, '--', ...(scope ? [scope] : [])], signal)) : [];
  }
  return { changes: changes.slice(0, limit), hasMore: changes.length > limit, anchor };
}

function nameStatus(output: string): RepositoryFile[] {
  const fields = output.split('\0'), files: RepositoryFile[] = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++], first = fields[i++];
    if (status.startsWith('R') || status.startsWith('C')) files.push({ status: status[0], oldPath: first, path: fields[i++] });
    else files.push({ status: status[0], path: first });
  }
  return files;
}
const jjFileTemplate = 'json({"path" => path, "oldPath" => source.path(), "status" => if(source.conflict() || target.conflict(), "U", status_char)}) ++ "\\n"';
function jjFiles(output: string): RepositoryFile[] {
  return output.split(/\r?\n/).filter(Boolean).map(line => {
    const value = JSON.parse(line) as RepositoryFile;
    return { ...value, oldPath: value.oldPath === value.path ? undefined : value.oldPath };
  });
}
export async function getChangeDetails(ctx: GitContext, sha: string, signal?: AbortSignal): Promise<{ change: RepositoryChange; files: RepositoryFile[] }> {
  validSha(sha);
  if (ctx.backend === 'jj') {
    const [metadata, files] = await Promise.all([
      jj(ctx, ['log', '-G', '-r', sha, '-T', jjTemplate], signal),
      jj(ctx, ['diff', '-r', sha, '-T', jjFileTemplate], signal),
    ]);
    const change = jjChanges(metadata)[0]; if (!change) throw new Error('Change is no longer available.');
    return { change, files: jjFiles(files) };
  }
  const change = gitChanges(await git(ctx, ['show', '-s', '--no-show-signature', `--format=${gitFormat}`, '--end-of-options', sha], signal))[0];
  if (!change) throw new Error('Change is no longer available.');
  // First-parent diff is explicit for merges, instead of Git's empty combined summary.
  const files = nameStatus(await git(ctx, change.parents?.length ?
    ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', change.parents[0], sha, '--'] :
    ['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', '-z', '-M', sha, '--'], signal));
  return { change, files };
}

function porcelain(output: string): RepositoryFile[] {
  const entries = output.split('\0'), files: RepositoryFile[] = [];
  for (let i = 0; i < entries.length && entries[i];) {
    const entry = entries[i++], xy = entry.slice(0, 2), file: RepositoryFile = { path: entry.slice(3), status: 'M' };
    if (xy.includes('R') || xy.includes('C')) file.oldPath = entries[i++];
    file.status = xy.includes('U') || xy === 'AA' || xy === 'DD' ? 'U' : xy === '??' ? 'A' :
      xy.includes('R') ? 'R' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : xy.includes('C') ? 'C' : 'M';
    files.push(file);
  }
  return files;
}
async function statusInsideQueue(ctx: GitContext, signal?: AbortSignal): Promise<RepositoryStatus> {
  if (ctx.backend === 'jj') {
    await jj(ctx, ['util', 'snapshot'], signal, true);
    const [metadata, files] = await Promise.all([
      jj(ctx, ['log', '-G', '-r', '@', '-T', jjTemplate], signal),
      jj(ctx, ['diff', '-r', '@', '-T', jjFileTemplate], signal),
    ]);
    const change = jjChanges(metadata)[0];
    return { files: jjFiles(files), token: change.sha, description: change.description || '' };
  }
  const [current, branch, raw, staged, unstaged] = await Promise.all([
    head(ctx, signal), git(ctx, ['symbolic-ref', '--quiet', 'HEAD'], signal).catch(error => { if (signal?.aborted) throw error; return ''; }),
    git(ctx, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal),
    git(ctx, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary'], signal),
    git(ctx, ['diff', '--no-ext-diff', '--no-textconv', '--binary'], signal),
  ]);
  const files = porcelain(raw);
  const untracked = raw.split('\0').filter(item => item.startsWith('?? ')).map(item => item.slice(3));
  // hash-object does not write without -w. New files are included in the stale-selection check.
  const hashes: string[] = [];
  for (let i = 0; i < untracked.length; i += 40)
    hashes.push(await git(ctx, ['hash-object', '--no-filters', '--', ...untracked.slice(i, i + 40)], signal));
  return { files, token: digest([current, branch, raw, staged, unstaged, ...hashes].join('\0')) };
}
export async function getRepositoryStatus(ctx: GitContext, signal?: AbortSignal): Promise<RepositoryStatus> {
  return withRepositoryMutation(ctx, () => statusInsideQueue(ctx, signal));
}

export async function createChange(ctx: GitContext, paths: string[], description: string, expectedToken: string): Promise<void> {
  if (!description.trim() || description.includes('\0')) throw new Error('Enter a change description.');
  const selected = [...new Set(paths.map(value => validPath(value)))];
  if (!selected.length) throw new Error('Select at least one file.');
  await withRepositoryMutation(ctx, async () => {
    const status = await statusInsideQueue(ctx);
    if (status.token !== expectedToken) throw new Error('Files changed since this list was loaded. Refresh and review the selection.');
    if (status.files.some(file => file.status === 'U')) throw new Error('Resolve conflicts before creating a change.');
    const available = new Map(status.files.map(file => [file.path, file]));
    if (selected.some(value => !available.has(value))) throw new Error('The selected files are no longer pending. Refresh the list.');
    const completePaths = [...new Set(selected.flatMap(value => {
      const file = available.get(value)!;
      return file.oldPath && file.status === 'R' ? [value, file.oldPath] : [value];
    }))];
    if (ctx.backend === 'jj') {
      if ((await jj(ctx, ['log', '-G', '-r', '@', '-T', 'conflict'])).trim() === 'true')
        throw new Error('Resolve conflicts before creating a change.');
      const filesets = completePaths.map(value => `root-file:${JSON.stringify(value)}`);
      // A single fileset union keeps selection semantics literal. No editor is launched.
      if (filesets.join(' | ').length > 24000) throw new Error('Select fewer files for this change.');
      await jj(ctx, ['commit', '-m', description, '--', filesets.join(' | ')], undefined, true);
      return;
    }
    // Refuse an in-progress merge even if all conflicts have already been resolved.
    let merging = false;
    try { merging = !!(await git(ctx, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).trim(); } catch { /* no merge */ }
    if (merging) throw new Error('Finish the current merge before creating a selected change.');
    const raw = await git(ctx, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const newPaths = raw.split('\0').filter(item => item.startsWith('?? ')).map(item => item.slice(3)).filter(value => selected.includes(value));
    const previousHead = await head(ctx);
    try {
      if (newPaths.length) await git(ctx, ['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'], undefined, newPaths.join('\0') + '\0');
      await git(ctx, ['commit', '--only', '-m', description, '--pathspec-from-file=-', '--pathspec-file-nul'], undefined, completePaths.join('\0') + '\0');
    } catch (error) {
      // Only entries that were untracked before this operation are rolled back. Other staging is untouched.
      if (newPaths.length && await head(ctx) === previousHead) {
        try { await git(ctx, ['update-index', '--force-remove', '-z', '--stdin'], undefined, newPaths.join('\0') + '\0'); }
        catch (cleanup) { throw new Error(`${error}\nUnable to clear temporary staging: ${cleanup}`); }
      }
      throw error;
    }
  });
}

/** Small, literal path queries for AI evidence; binary payloads and external diff drivers are excluded. */
export async function changePatch(ctx: GitContext, sha: string, file: RepositoryFile, signal?: AbortSignal): Promise<string> {
  validSha(sha); validPath(file.path); if (file.oldPath) validPath(file.oldPath);
  if (ctx.backend === 'jj') return jj(ctx, ['diff', '--git', '-r', sha, '--', `root-file:${JSON.stringify(file.path)}`, ...(file.oldPath ? [`root-file:${JSON.stringify(file.oldPath)}`] : [])], signal);
  return git(ctx, ['show', '--format=', '--first-parent', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', sha, '--', file.path, ...(file.oldPath ? [file.oldPath] : [])], signal);
}
export async function pendingPatch(ctx: GitContext, file: RepositoryFile, signal?: AbortSignal): Promise<string> {
  validPath(file.path); if (file.oldPath) validPath(file.oldPath);
  if (ctx.backend === 'jj') return jj(ctx, ['diff', '--git', '-r', '@', '--', `root-file:${JSON.stringify(file.path)}`, ...(file.oldPath ? [`root-file:${JSON.stringify(file.oldPath)}`] : [])], signal);
  const current = await head(ctx, signal);
  // With no parent, a selected added file is committed from disk, including edits after staging.
  if (!current && file.status === 'A') return '';
  return git(ctx, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', ...(current ? [current] : ['--cached']), '--', file.path, ...(file.oldPath ? [file.oldPath] : [])], signal);
}
