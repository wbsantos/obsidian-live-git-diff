import { execFile } from 'child_process';
import type { GitContext } from './git.ts';
import { withRepositoryMutation } from './repository.ts';

export interface RemoteTarget { remote: string; branch: string }
export interface RepositoryRemotes {
  remotes: string[];
  branches: string[];
  suggested?: RemoteTarget;
  currentBranch?: string;
  trackingRef?: string;
}
export interface RepositorySyncState { synced: string[]; remote?: string; warning?: string }
export interface RemoteResult { message: string }

class CommandError extends Error {
  readonly code?: string | number;
  constructor(message: string, code?: string | number) { super(message); this.code = code; }
}
function command(tool: string, cwd: string, args: string[], signal?: AbortSignal, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(tool, args, {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_MERGE_AUTOEDIT: 'no', SSH_ASKPASS_REQUIRE: 'never' },
    }, (error, out, err) => error ? reject(new CommandError(String(err || error.message).trim(), error.code ?? undefined)) : resolve(out));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
const git = (ctx: GitContext, args: string[], signal?: AbortSignal, raw = false, input?: string): Promise<string> =>
  command('git', ctx.root, ['-C', ctx.root, ...args], signal, input).then(value => raw ? value : value.trim());
const jj = (ctx: GitContext, args: string[], signal?: AbortSignal, mutate = false): Promise<string> =>
  command('jj', ctx.workspaceRoot!, [...(mutate ? [] : ['--ignore-working-copy']), '--no-pager', '--color=never',
    '--config', 'git.abandon-unreachable-commits=false', '-R', ctx.workspaceRoot!, ...args], signal).then(value => value.trim());
async function optional(run: Promise<string>): Promise<string> {
  try { return await run; } catch (error) { if (error instanceof CommandError && error.code === 1) return ''; throw error; }
}
const lines = (value: string): string[] => value.split(/\r?\n/).filter(Boolean);
const exact = (value: string): string => `exact:${value}`;
const quote = (value: string): string => JSON.stringify(value);
const remoteRev = (target: RemoteTarget): string => `remote_bookmarks(exact:${quote(target.branch)}, exact:${quote(target.remote)})`;
const divergent = (): Error => new Error('Local and remote changes have diverged. Resolve the history with your VCS before syncing.');

interface Bookmark { name: string; remote: string | null; sha: string | null; conflict: boolean; tracked: boolean }
async function bookmarks(ctx: GitContext, signal?: AbortSignal): Promise<Bookmark[]> {
  const template = 'json({"name" => name, "remote" => remote, "sha" => if(!conflict && present, normal_target.commit_id(), ""), "conflict" => conflict, "tracked" => tracked}) ++ "\\n"';
  return lines(await jj(ctx, ['bookmark', 'list', '--all-remotes', '-T', template], signal)).map(line => JSON.parse(line) as Bookmark);
}

/** Uses local configuration only. Opening the panel never starts a network request. */
export async function getRepositoryRemotes(ctx: GitContext, signal?: AbortSignal): Promise<RepositoryRemotes> {
  const remotes = lines(await git(ctx, ['remote'], signal));
  if (ctx.backend === 'jj') {
    const refs = await bookmarks(ctx, signal);
    const branches = [...new Set(refs.filter(ref => ref.remote !== 'git').map(ref => ref.name))].sort();
    const ancestors = new Set(lines(await jj(ctx, ['log', '-G', '-r', 'heads((bookmarks() | remote_bookmarks()) & ancestors(@-))', '-T', 'commit_id ++ "\\n"'], signal)));
    const nearby = refs.filter(ref => !ref.conflict && ref.sha && ancestors.has(ref.sha) && ref.remote !== 'git');
    const names = new Set(nearby.map(ref => ref.name));
    const tracked = refs.filter(ref => names.has(ref.name) && !ref.conflict && ref.remote && ref.tracked && remotes.includes(ref.remote));
    const unique = [...new Map(tracked.map(ref => [`${ref.remote}\0${ref.name}`, { remote: ref.remote!, branch: ref.name }])).values()];
    // A colocated workspace can already have valid Git upstream configuration
    // before JJ has imported that relationship as a tracked remote bookmark.
    if (!unique.length && await git(ctx, ['rev-parse', '--is-bare-repository'], signal) === 'false') {
      const configured = await getRepositoryRemotes({ ...ctx, backend: 'git' }, signal);
      if (configured.currentBranch)
        return { remotes, branches, suggested: names.has(configured.currentBranch) ? configured.suggested : undefined };
      // JJ can detach Git HEAD when committing. The corresponding local branch
      // still owns its upstream; use it only when the nearby configuration is unique.
      const upstreams = lines(await git(ctx, ['for-each-ref', '--format=%(refname:short)%00%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads'], signal))
        .map(line => line.split('\0'))
        .filter(([name, remote, ref]) => names.has(name) && remotes.includes(remote) && ref?.startsWith('refs/heads/'))
        .map(([, remote, ref]) => ({ remote, branch: ref.slice(11) }));
      const choices = [...new Map(upstreams.map(target => [`${target.remote}\0${target.branch}`, target])).values()];
      if (choices.length === 1) return { remotes, branches, suggested: choices[0] };
    }
    return { remotes, branches, suggested: unique.length === 1 ? unique[0] : undefined };
  }
  const currentBranch = await optional(git(ctx, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal));
  const refs = lines(await git(ctx, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], signal));
  const branches = [...new Set(refs.flatMap(ref => {
    if (ref.startsWith('refs/heads/')) return [ref.slice(11)];
    const remote = remotes.find(name => ref.startsWith(`refs/remotes/${name}/`));
    const name = remote ? ref.slice(`refs/remotes/${remote}/`.length) : '';
    return name && name !== 'HEAD' ? [name] : [];
  }))].sort();
  let suggested: RemoteTarget | undefined;
  let trackingRef: string | undefined;
  if (currentBranch) {
    const upstream = (await git(ctx, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)', `refs/heads/${currentBranch}`], signal)).split('\0');
    if (remotes.includes(upstream[0]) && upstream[1]?.startsWith('refs/heads/')) {
      suggested = { remote: upstream[0], branch: upstream[1].slice(11) }; trackingRef = upstream[2] || undefined;
    }
    if (!branches.includes(currentBranch)) branches.push(currentBranch);
  }
  return { remotes, branches, currentBranch: currentBranch || undefined, suggested, trackingRef };
}

/** Sync follows VCS tracking, never a second configuration maintained by the plugin. */
export async function trackedRemote(ctx: GitContext, signal?: AbortSignal): Promise<RemoteTarget> {
  const options = await getRepositoryRemotes(ctx, signal);
  if (!options.suggested) throw new Error(ctx.backend === 'jj'
    ? 'No unique tracked remote bookmark. Configure tracking in Jujutsu before syncing.'
    : 'The current branch has no remote upstream. Configure tracking in Git before syncing.');
  return options.suggested;
}

/** Color only proven ancestors of the tracked remote tip green. No network access. */
export async function repositorySyncState(ctx: GitContext, revisions: string[], signal?: AbortSignal): Promise<RepositorySyncState> {
  const ids = [...new Set(revisions)];
  if (ids.some(id => !/^[0-9a-f]{40,64}$/.test(id))) throw new Error('Invalid change identifier.');
  let remote: string | undefined;
  try {
    const options = await getRepositoryRemotes(ctx, signal), target = options.suggested;
    if (!target) return { synced: [], warning: ctx.backend === 'jj' ? 'No unique tracked remote bookmark' : 'No remote upstream configured' };
    remote = `${target.remote}/${target.branch}`;
    if (ctx.backend === 'jj') {
      const tip = await jj(ctx, ['log', '-G', '-r', remoteRev(target), '-T', 'commit_id'], signal);
      if (!/^[0-9a-f]{40,64}$/.test(tip)) throw new Error('The tracked remote bookmark is unavailable.');
      const synced: string[] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const set = ids.slice(offset, offset + 100).join(' | ');
        synced.push(...lines(await jj(ctx, ['log', '-G', '-r', `(${set}) & ancestors(${tip})`, '-T', 'commit_id ++ "\\n"'], signal)));
      }
      return { synced, remote };
    }
    if (!options.trackingRef) throw new Error('The upstream tracking reference is unavailable.');
    const tip = await git(ctx, ['rev-parse', '--verify', '--end-of-options', `${options.trackingRef}^{commit}`], signal);
    if (!ids.length) return { synced: [], remote };
    // Feeding revisions on stdin also works for long, paginated histories on Windows.
    const unsynced = new Set(lines(await git(ctx, ['rev-list', '--stdin'], signal, false, [...ids, `^${tip}`].join('\n') + '\n')));
    return { synced: ids.filter(id => !unsynced.has(id)), remote };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { synced: [], remote, warning: `Remote status unavailable: ${String((error as Error).message || error)}` };
  }
}

async function validateTarget(ctx: GitContext, target: RemoteTarget, signal?: AbortSignal): Promise<void> {
  if (!target.remote || target.remote.startsWith('-') || /[\0\r\n]/.test(target.remote) ||
      !(await git(ctx, ['remote'], signal)).split(/\r?\n/).includes(target.remote)) throw new Error('Choose a configured remote.');
  if (!target.branch || target.branch.startsWith('-') || /[\0\r\n]/.test(target.branch)) throw new Error('Enter a valid remote branch.');
  try { await git(ctx, ['check-ref-format', `refs/heads/${target.branch}`], signal); }
  catch (error) { if (signal?.aborted) throw error; throw new Error('Enter a valid remote branch.'); }
}
async function gitHead(ctx: GitContext, signal?: AbortSignal): Promise<string> {
  return optional(git(ctx, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal));
}
async function isAncestor(ctx: GitContext, before: string, after: string, signal?: AbortSignal): Promise<boolean> {
  if (before === after || /^0+$/.test(before)) return true;
  try { await git(ctx, ['merge-base', '--is-ancestor', before, after], signal); return true; }
  catch (error) { if (error instanceof CommandError && error.code === 1) return false; throw error; }
}
async function workingParent(ctx: GitContext, signal?: AbortSignal): Promise<string> {
  const parents = lines(await jj(ctx, ['log', '-G', '-r', '@-', '-T', 'commit_id ++ "\\n"'], signal));
  if (parents.length !== 1) throw new Error('Finish the current merge before syncing.');
  return parents[0];
}
async function gitBranch(ctx: GitContext, signal?: AbortSignal): Promise<string> {
  const branch = await optional(git(ctx, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal));
  if (!branch) throw new Error('Switch to a local branch before syncing.');
  return branch;
}

const overlaps = (left: string, right: string): boolean => {
  // Be conservative on case-insensitive Windows filesystems as well as exact paths.
  if (process.platform === 'win32') { left = left.toLocaleLowerCase(); right = right.toLocaleLowerCase(); }
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
};
async function protectUntrackedJjFiles(ctx: GitContext, affected: string[], signal?: AbortSignal): Promise<void> {
  if (!affected.length) return;
  const tracked = new Set(lines(await jj(ctx, ['file', 'list', '-r', '@', '-T', 'json(path) ++ "\\n"'], signal))
    .map(line => JSON.parse(line) as string));
  // JJ can leave ignored, oversized or explicitly untracked files out of snapshots.
  // Ask Git only about affected subtrees (including blocking ancestor files). Its
  // backing index may be empty, so subtract files already recorded by JJ itself.
  const scopes = [...new Set(affected.map(file => file.split('/')[0]))];
  for (let offset = 0; offset < scopes.length; offset += 40) {
    const existing = (await git(ctx, ['-C', ctx.workspaceRoot!, `--git-dir=${ctx.root}`, '--literal-pathspecs', `--work-tree=${ctx.workspaceRoot!}`, 'ls-files', '--others', '-z',
      '--', ...scopes.slice(offset, offset + 40)], signal, true)).split('\0').filter(Boolean);
    if (existing.some(file => !tracked.has(file) && affected.some(changed => overlaps(file, changed))))
      throw new Error('Incoming changes overlap untracked or ignored files. Move or record those files before pulling.');
  }
}

/** Pushes only committed/finalized changes. Explicit non-forced refspecs ignore push.default and mirror settings. */
export async function pushRepository(ctx: GitContext, target: RemoteTarget, signal?: AbortSignal): Promise<RemoteResult> {
  return withRepositoryMutation(ctx, async () => {
    await validateTarget(ctx, target, signal);
    let sha: string;
    if (ctx.backend === 'jj') {
      await jj(ctx, ['util', 'snapshot'], signal, true);
      sha = await workingParent(ctx, signal);
      if (/^0+$/.test(sha)) throw new Error('Create a change before pushing.');
      const local = (await bookmarks(ctx, signal)).find(ref => ref.name === target.branch && !ref.remote);
      if (local?.conflict) throw divergent();
      if (local?.sha && !await isAncestor(ctx, local.sha, sha, signal)) throw new Error('The selected branch is not an ancestor of the latest finalized change.');
      const conflicts = await jj(ctx, ['log', '-G', '-r', `ancestors(${sha}) & conflicts()`, '-n', '1', '-T', 'commit_id'], signal);
      if (conflicts) throw new Error('Resolve conflicts before pushing.');
    } else {
      await gitBranch(ctx, signal);
      sha = await gitHead(ctx, signal);
      if (!sha) throw new Error('Create a change before pushing.');
    }
    // JJ's native push permits rewrites. Git transport guarantees a fast-forward at the server,
    // including races after our checks, while still using JJ's backing Git store and credentials.
    await git(ctx, ['-c', `remote.${target.remote}.mirror=false`, 'push', '--porcelain', '--no-force', '--no-follow-tags',
      '--recurse-submodules=no', '--', target.remote, `${sha}:refs/heads/${target.branch}`], signal);
    if (ctx.backend === 'jj') {
      try {
        await jj(ctx, ['git', 'import']);
        await jj(ctx, ['bookmark', 'set', target.branch, '-r', sha], undefined, true);
        const refs = await bookmarks(ctx);
        if (refs.some(ref => ref.name === target.branch && ref.remote === target.remote))
          await jj(ctx, ['bookmark', 'track', exact(target.branch), '--remote', exact(target.remote)], undefined, true);
      } catch (error) { throw new Error(`Push succeeded, but local branch tracking needs attention: ${String((error as Error).message)}`); }
    }
    return { message: `Pushed to ${target.remote}/${target.branch}.` };
  });
}

/** Fetches the chosen branch and fast-forwards; never merges, stashes, or rewrites finalized changes. */
export async function pullRepository(ctx: GitContext, target: RemoteTarget, signal?: AbortSignal): Promise<RemoteResult> {
  return withRepositoryMutation(ctx, async () => {
    await validateTarget(ctx, target, signal);
    if (ctx.backend !== 'jj') {
      await gitBranch(ctx, signal);
      const before = await gitHead(ctx, signal);
      if (await optional(git(ctx, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], signal))) throw new Error('Finish the current merge before pulling.');
      await git(ctx, ['fetch', '--no-tags', '--no-recurse-submodules', '--', target.remote, `refs/heads/${target.branch}`], signal);
      const incoming = await git(ctx, ['rev-parse', '--verify', 'FETCH_HEAD'], signal);
      if (before && !await isAncestor(ctx, before, incoming, signal)) {
        if (await isAncestor(ctx, incoming, before, signal)) return { message: `Already up to date with ${target.remote}/${target.branch}.` };
        throw divergent();
      }
      await git(ctx, ['-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-edit', '--no-autostash', '--no-overwrite-ignore', incoming], signal);
      return { message: before === incoming ? `Already up to date with ${target.remote}/${target.branch}.` : `Pulled from ${target.remote}/${target.branch}.` };
    }

    await jj(ctx, ['util', 'snapshot'], signal, true);
    const before = await workingParent(ctx, signal);
    const initialRefs = await bookmarks(ctx, signal);
    if (initialRefs.some(ref => ref.name === target.branch && ref.conflict)) throw divergent();
    const local = initialRefs.find(ref => ref.name === target.branch && !ref.remote);
    if (local?.sha && !await isAncestor(ctx, local.sha, before, signal) && !await isAncestor(ctx, before, local.sha, signal))
      throw new Error('The selected branch is not an ancestor of the working change.');
    if (await jj(ctx, ['log', '-G', '-r', '(@:: ~ @) | (@ & conflicts())', '-n', '1', '-T', 'commit_id'], signal))
      throw new Error('Finish the current change or resolve its conflicts before pulling.');
    await jj(ctx, ['git', 'fetch', '--remote', exact(target.remote), '--branch', exact(target.branch)], signal, true);
    const incoming = await jj(ctx, ['log', '-G', '-r', remoteRev(target), '-T', 'commit_id'], signal);
    if (!incoming) throw new Error('The remote branch was not found.');
    if (local?.sha && !await isAncestor(ctx, local.sha, incoming, signal) && !await isAncestor(ctx, local.sha, before, signal))
      throw new Error('The selected branch has finalized changes beyond the working change.');
    if (!await isAncestor(ctx, before, incoming, signal)) {
      if (await isAncestor(ctx, incoming, before, signal)) return { message: `Already up to date with ${target.remote}/${target.branch}.` };
      throw divergent();
    }
    if (before !== incoming) {
      // A conservative overlap check keeps pending edits intact without creating conflict markers.
      const pending = lines(await jj(ctx, ['diff', '-r', '@', '-T', 'json({"path" => path, "source" => source.path()}) ++ "\\n"'], signal))
        .flatMap(line => { const entry = JSON.parse(line) as { path: string; source: string }; return [entry.path, entry.source]; });
      const affected = /^0+$/.test(before) ? (await git(ctx, ['ls-tree', '-r', '--name-only', '-z', incoming], signal, true)).split('\0').filter(Boolean) :
        (await git(ctx, ['diff', '--name-only', '-z', '--no-renames', before, incoming, '--'], signal, true)).split('\0').filter(Boolean);
      if (pending.some(file => affected.some(changed => overlaps(file, changed))))
        throw new Error('Incoming changes overlap pending files. Create a change or finish reviewing those files before pulling.');
      await protectUntrackedJjFiles(ctx, affected, signal);
      await jj(ctx, ['rebase', '-r', '@', '-o', incoming], signal, true);
    }
    await jj(ctx, ['bookmark', 'set', target.branch, '-r', incoming], signal, true);
    await jj(ctx, ['bookmark', 'track', exact(target.branch), '--remote', exact(target.remote)], signal, true);
    return { message: before === incoming ? `Already up to date with ${target.remote}/${target.branch}.` : `Pulled from ${target.remote}/${target.branch}.` };
  });
}
