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
export interface RemoteResult { message: string; attention?: boolean }
export interface RepositorySyncOutcome { action: 'push' | 'pull'; message: string; attention: boolean }
export interface RepositoryRemoteHealth {
  kind: 'ready' | 'ahead' | 'behind' | 'diverged' | 'conflict' | 'blocked' | 'untracked' | 'unknown';
  summary: string;
  target?: RemoteTarget;
  ahead: number;
  behind: number;
  hints: string[];
  refs: Array<{ name: string; sha: string; conflicted?: boolean }>;
  conflicts: string[];
  files: string[];
}

class CommandError extends Error {
  readonly code?: string | number;
  readonly output: string;
  readonly interrupted: boolean;
  constructor(message: string, code?: string | number, output = '', interrupted = false) {
    super(message); this.code = code; this.output = output; this.interrupted = interrupted;
  }
}
function command(tool: string, cwd: string, args: string[], signal?: AbortSignal, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(tool, args, {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, signal,
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_MERGE_AUTOEDIT: 'no', SSH_ASKPASS_REQUIRE: 'never' },
    }, (error, out, err) => error ? reject(new CommandError(String(err || out || error.message).trim(), error.code ?? undefined, out,
      !!error.killed || error.name === 'AbortError')) : resolve(out));
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

interface Bookmark { name: string; remote: string | null; sha: string | null; conflict: boolean; tracked: boolean; targets: string[] }
async function bookmarks(ctx: GitContext, signal?: AbortSignal): Promise<Bookmark[]> {
  // Serializing normal_target inside json() errors for a conflicted/deleted ref,
  // even behind if(). Render optional commit IDs as a separate, lazy template.
  const template = 'json({"name" => name, "remote" => remote, "conflict" => conflict, "tracked" => tracked}) ++ "\\t" ++ added_targets.map(|c| if(c, c.commit_id(), "")).join(",") ++ "\\n"';
  return lines(await jj(ctx, ['bookmark', 'list', '--all-remotes', '-T', template], signal)).map(line => {
    const [metadata, ids = ''] = line.split('\t');
    if (!metadata.startsWith('{')) throw new Error(`Unable to read Jujutsu bookmark state: ${metadata}`);
    const ref = JSON.parse(metadata) as Bookmark, targets = ids.split(',').filter(Boolean);
    return { ...ref, targets, sha: !ref.conflict && targets.length === 1 ? targets[0] : null };
  });
}

/** Uses local configuration only. Opening the panel never starts a network request. */
export async function getRepositoryRemotes(ctx: GitContext, signal?: AbortSignal): Promise<RepositoryRemotes> {
  const remotes = lines(await git(ctx, ['remote'], signal));
  if (ctx.backend === 'jj') {
    const refs = await bookmarks(ctx, signal);
    const branches = [...new Set(refs.filter(ref => ref.remote !== 'git').map(ref => ref.name))].sort();
    const ancestors = new Set(lines(await jj(ctx, ['log', '-G', '-r', 'heads((bookmarks() | remote_bookmarks()) & ancestors(@))', '-T', 'commit_id ++ "\\n"'], signal)));
    const nearby = refs.filter(ref => ref.targets.some(sha => ancestors.has(sha)) && ref.remote !== 'git');
    const names = new Set(nearby.map(ref => ref.name));
    const allTracked = refs.filter(ref => ref.remote && ref.remote !== 'git' && ref.tracked && remotes.includes(ref.remote));
    const tracked = allTracked.filter(ref => names.has(ref.name));
    const unique = [...new Map(tracked.map(ref => [`${ref.remote}\0${ref.name}`, { remote: ref.remote!, branch: ref.name }])).values()];
    // A colocated workspace can already have valid Git upstream configuration
    // before JJ has imported that relationship as a tracked remote bookmark.
    if (!unique.length && await git(ctx, ['rev-parse', '--is-bare-repository'], signal) === 'false') {
      const configured = await getRepositoryRemotes({ ...ctx, backend: 'git' }, signal);
      if (configured.currentBranch && names.has(configured.currentBranch) && configured.suggested)
        return { remotes, branches, suggested: configured.suggested };
      // JJ can detach Git HEAD when committing. The corresponding local branch
      // still owns its upstream; use it only when the nearby configuration is unique.
      const upstreams = lines(await git(ctx, ['for-each-ref', '--format=%(refname:short)%00%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads'], signal))
        .map(line => line.split('\0'))
        .filter(([name, remote, ref]) => names.has(name) && remotes.includes(remote) && ref?.startsWith('refs/heads/'))
        .map(([, remote, ref]) => ({ remote, branch: ref.slice(11) }));
      const choices = [...new Map(upstreams.map(target => [`${target.remote}\0${target.branch}`, target])).values()];
      if (choices.length === 1) return { remotes, branches, suggested: choices[0] };
    }
    // Tracking survives divergence and conflicted bookmark targets. An unrelated second
    // tracked destination remains ambiguous; never guess a branch from its name.
    const fallback = [...new Map(allTracked.map(ref => [`${ref.remote}\0${ref.name}`, { remote: ref.remote!, branch: ref.name }])).values()];
    return { remotes, branches, suggested: unique.length === 1 ? unique[0] : !unique.length && fallback.length === 1 ? fallback[0] : undefined };
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
  if (!options.suggested && ctx.backend !== 'jj') {
    const operation = await gitOperation(ctx, signal);
    if (operation) throw new Error(`Finish or abort the current ${operation} before syncing. Its state was preserved.`);
  }
  if (!options.suggested) throw new Error(ctx.backend === 'jj'
    ? 'No unique tracked remote bookmark. Configure tracking in Jujutsu before syncing.'
    : 'The current branch has no remote upstream. Configure tracking in Git before syncing.');
  return options.suggested;
}

async function gitOperation(ctx: GitContext, signal?: AbortSignal): Promise<string | undefined> {
  const status = await git(ctx, ['status', '--untracked-files=no'], signal);
  if (/rebase in progress|currently rebasing/i.test(status)) return 'rebase';
  if (/currently cherry-picking/i.test(status)) return 'cherry-pick';
  if (/currently reverting/i.test(status)) return 'revert';
  if (/unmerged paths|still merging/i.test(status)) return 'merge';
  return undefined;
}

/** Local diagnostics remain available even when syncing cannot choose or update a branch. */
export async function repositoryRemoteHealth(ctx: GitContext, signal?: AbortSignal): Promise<RepositoryRemoteHealth> {
  const health: RepositoryRemoteHealth = { kind: 'unknown', summary: 'Remote status unavailable', ahead: 0, behind: 0,
    hints: [], refs: [], conflicts: [], files: [] };
  try {
    const options = await getRepositoryRemotes(ctx, signal), target = health.target = options.suggested;
    let local = '', incoming = '', operation: string | undefined, bookmarkIssue = false, needsAlignment = false, unrelated = false;
    if (ctx.backend === 'jj') {
      const [refs, working, conflicts] = await Promise.all([
        bookmarks(ctx, signal),
        jj(ctx, ['log', '-G', '-r', '@', '-T', 'json({"sha" => commit_id, "parents" => parents.map(|c| c.commit_id()), "files" => conflicted_files.map(|f| f.path())})'], signal),
        jj(ctx, ['log', '-G', '-r', `conflicts() & (ancestors(@)${target ? ` | ancestors(bookmarks(exact:${quote(target.branch)}))` : ''})`, '-T', 'commit_id ++ "\\n"'], signal),
      ]);
      const current = JSON.parse(working) as { sha: string; parents: string[]; files: string[] };
      health.files = current.files; health.conflicts = lines(conflicts);
      if (current.parents.length === 1) local = current.parents[0];
      else operation = 'merge with multiple working-copy parents';
      if (local) health.refs.push({ name: 'Workcopy parent', sha: local });
      for (const ref of refs.filter(ref => !ref.remote)) for (const sha of ref.targets)
        health.refs.push({ name: ref.name, sha, conflicted: ref.conflict });
      if (target) {
        const bookmark = refs.find(ref => ref.name === target.branch && !ref.remote);
        const remote = refs.find(ref => ref.name === target.branch && ref.remote === target.remote);
        bookmarkIssue = !!bookmark?.conflict || !!remote?.conflict;
        if (remote) for (const sha of remote.targets)
          health.refs.push({ name: `${remote.remote}/${remote.name}`, sha, conflicted: remote.conflict });
        incoming = remote?.sha || '';
        needsAlignment = !bookmark?.sha || (incoming === local && bookmark.sha !== local);
      }
    } else {
      const [head, activeOperation, files] = await Promise.all([
        gitHead(ctx, signal), gitOperation(ctx, signal), git(ctx, ['diff', '--name-only', '--diff-filter=U', '-z'], signal, true),
      ]);
      local = head; operation = activeOperation; health.files = files.split('\0').filter(Boolean);
      if (local) health.refs.push({ name: options.currentBranch || 'Detached HEAD', sha: local });
      if (options.trackingRef) incoming = await optional(git(ctx, ['rev-parse', '--verify', '--quiet', options.trackingRef], signal));
      if (target && incoming) health.refs.push({ name: `${target.remote}/${target.branch}`, sha: incoming });
      if (!options.currentBranch && !operation) operation = 'detached HEAD';
    }
    if (local && incoming) {
      try {
        const counts = /^0+$/.test(local) ? `0 ${await git(ctx, ['rev-list', '--count', incoming], signal)}` :
          await git(ctx, ['rev-list', '--left-right', '--count', `${local}...${incoming}`], signal);
        [health.ahead, health.behind] = counts.split(/\s+/).map(Number);
      } catch (error) {
        if (!(error instanceof CommandError) || !/no merge base/i.test(error.message)) throw error;
        unrelated = true;
        const counts = await Promise.all([git(ctx, ['rev-list', '--count', `${incoming}..${local}`], signal),
          git(ctx, ['rev-list', '--count', `${local}..${incoming}`], signal)]);
        [health.ahead, health.behind] = counts.map(Number);
      }
    }
    if (health.ahead && health.behind && !unrelated)
      unrelated = !await optional(git(ctx, ['merge-base', local, incoming], signal));
    const destination = target ? `${target.remote}/${target.branch}` : 'remote';
    if (operation) {
      health.kind = 'blocked'; health.summary = `${operation === 'detached HEAD' ? 'Detached HEAD' : `Unfinished ${operation}`} · sync needs attention`;
      health.hints.push(operation === 'detached HEAD' ? 'Switch to the intended local branch before syncing.' :
        'Finish or abort the current operation in your VCS, then refresh this panel. Push and Pull preserve that operation.');
    } else if (health.conflicts.length || health.files.length) {
      health.kind = 'conflict'; health.summary = 'Unresolved file conflicts';
      health.hints.push('Open VCS Pending Changes to inspect conflicted files. Resolve them before syncing; conflicts in an earlier change must be resolved in that change.');
    } else if (!target) {
      health.kind = 'untracked'; health.summary = ctx.backend === 'jj' ? 'No unique tracked remote bookmark' : 'No remote upstream configured';
      health.hints.push('Configure the intended upstream in your VCS. Multiple tracked destinations require a bookmark related to the Workcopy.');
    } else if (!incoming) {
      health.kind = 'blocked'; health.summary = `Tracked reference unavailable · ${destination}`;
      health.hints.push('Pull to refresh the tracked reference. If the remote branch was removed, configure its replacement in your VCS.');
    } else if (unrelated) {
      health.kind = 'blocked'; health.summary = `Local and remote history have no common ancestor · ${destination}`;
      health.hints.push('Inspect this remote rewrite or unrelated branch in your VCS before integrating it. The local histories are retained.');
    } else if (bookmarkIssue) {
      health.kind = 'conflict'; health.summary = `Bookmark targets conflict · ${destination}`;
      health.hints.push('Pull can reconcile a single unpublished local line and realign the tracked bookmark. Independent branches or published rewrites require VCS resolution first.');
    } else if (health.ahead && health.behind) {
      health.kind = 'diverged'; health.summary = `Diverged · ${health.ahead} local / ${health.behind} incoming · ${destination}`;
      health.hints.push(ctx.backend === 'jj' ? 'Pull can rebase a single unpublished local line when all changes apply cleanly, then align the bookmark. Shared branches and unresolved conflicts are preserved for manual resolution.' :
        'Integrate the two histories with a Git merge or rebase, then retry. Pull fetches updates but only fast-forwards the local branch.');
    } else if (needsAlignment) {
      health.kind = 'blocked'; health.summary = `Bookmark needs alignment · ${destination}`;
      health.hints.push('Pull will align the bookmark with the latest finalized change when all of its targets are accounted for. Pending Workcopy edits stay unpublished.');
    } else {
      health.kind = health.ahead ? 'ahead' : health.behind ? 'behind' : 'ready';
      health.summary = `${destination} · ${health.ahead ? `${health.ahead} local to push` : health.behind ? `${health.behind} incoming to pull` : 'Up to date'}`;
    }
    return health;
  } catch (error) {
    if (signal?.aborted) throw error;
    health.hints.push(String((error as Error).message || error));
    return health;
  }
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

/** Preview each replay in Git's object database, without changing files, refs, or JJ history. */
async function previewJjRebase(ctx: GitContext, incoming: string, working: string, target: RemoteTarget, signal?: AbortSignal): Promise<{ root: string; rewritten: Set<string>; count: number }> {
  const chain = lines(await git(ctx, ['rev-list', '--reverse', '--parents', `${incoming}..${working}`], signal)).map(line => line.split(' '));
  if (!chain.length) throw new Error('The working change is no longer available. Refresh before pulling.');
  if (chain.length > 1 && !await optional(git(ctx, ['merge-base', incoming, working], signal)))
    throw new Error('The local and remote histories have no common ancestor. Inspect this remote rewrite or unrelated branch in your VCS before integrating it.');
  const rewritten = new Set(chain.map(([sha]) => sha));
  for (let i = 0; i < chain.length; i++) if (chain[i].length > 2 || (i && chain[i][1] !== chain[i - 1][0]))
    throw new Error('Local history has independent branches or merges. Integrate those histories with Jujutsu, then retry Pull.');
  const set = [...rewritten].join(' | ');
  const [shared, descendants, refs] = await Promise.all([
    jj(ctx, ['log', '-G', '-r', `(${set}) & (immutable() | ancestors(remote_bookmarks()))`, '-n', '1', '-T', 'commit_id'], signal),
    jj(ctx, ['log', '-G', '-r', `(${chain[0][0]}::) ~ (${set})`, '-n', '1', '-T', 'commit_id'], signal),
    bookmarks(ctx, signal),
  ]);
  if (shared) throw new Error('Local history includes published or immutable changes. Reconcile that shared history in your VCS before pulling.');
  if (descendants || refs.some(ref => !ref.remote && ref.name !== target.branch && ref.targets.some(sha => rewritten.has(sha))))
    throw new Error('Local changes also belong to another branch. Integrate those histories with Jujutsu, then retry Pull.');
  const incomingPaths = (chain[0][1]
    ? await git(ctx, ['diff', '--name-only', '-z', '--no-renames', chain[0][1], incoming, '--'], signal, true)
    : await git(ctx, ['ls-tree', '-r', '--name-only', '-z', incoming], signal, true)).split('\0').filter(Boolean);
  let parent = incoming;
  for (const [sha, previous] of chain) {
    const changes = lines(await jj(ctx, ['diff', '-r', sha, '-T', 'json({"path" => path, "source" => source.path(), "status" => status_char}) ++ "\\n"'], signal))
      .map(line => JSON.parse(line) as { path: string; source: string; status: string });
    // Git and JJ do not resolve every rename identically. Keep the original
    // pending-file protection and require explicit resolution for overlapping renames.
    const overlap = changes.find(change => (sha === working || change.status === 'R' || change.status === 'C') &&
      incomingPaths.some(path => overlaps(change.path, path) || overlaps(change.source, path)));
    if (overlap) throw new Error(`Incoming changes overlap ${sha === working ? 'pending files' : 'a local rename'}: ${overlap.path}. Resolve or finalize those edits before pulling. The Workcopy was preserved.`);
    const base = previous || await git(ctx, ['mktree'], signal, false, '');
    let merged: string;
    try { merged = await git(ctx, ['merge-tree', '--write-tree', '--name-only', '-z', `--merge-base=${base}`, parent, sha], signal, true); }
    catch (error) {
      if (error instanceof CommandError && error.code === 1) {
        const fields = error.output.split('\0'), end = fields.indexOf('', 1);
        const names = fields.slice(1, end < 0 ? 9 : Math.min(end, 9)).join(', ');
        throw new Error(sha === working
          ? `Incoming changes overlap pending files${names ? ': ' + names : ''}. Create a change or resolve those edits before pulling. The Workcopy was preserved.`
          : `Incoming changes conflict with local history${names ? ': ' + names : ''}. Local history and Workcopy were preserved. Resolve the divergence with your VCS, then retry Pull.`);
      }
      throw error;
    }
    const tree = merged.split('\0')[0].trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('Unable to preview the incoming changes safely. Integrate them with your VCS.');
    parent = await git(ctx, ['-c', 'user.name=Change Review', '-c', 'user.email=change-review@localhost', '-c', 'commit.gpgsign=false',
      'commit-tree', tree, '-p', parent], signal, false, 'Change Review integration preview\n');
  }
  return { root: chain[0][0], rewritten, count: chain.length - 1 };
}

async function alignJjBookmark(ctx: GitContext, target: RemoteTarget, tip: string, rewritten: Set<string>, signal?: AbortSignal): Promise<void> {
  const local = (await bookmarks(ctx, signal)).find(ref => ref.name === target.branch && !ref.remote);
  const working = await jj(ctx, ['log', '-G', '-r', '@', '-T', 'commit_id'], signal);
  for (const sha of local?.targets || []) if (sha !== working && !rewritten.has(sha) && !await isAncestor(ctx, sha, tip, signal))
    throw new Error(`Bookmark ${target.branch} has an independent target at ${sha.slice(0, 8)}. Its history was preserved; reconcile the bookmark in Jujutsu before syncing.`);
  // Moving off an empty/pending @ or a commit just rewritten by this Pull is intentional.
  // The working-copy change is retained, and no remote is moved backwards.
  await jj(ctx, ['bookmark', 'set', target.branch, '-r', tip, '--allow-backwards'], signal, true);
  await jj(ctx, ['bookmark', 'track', exact(target.branch), '--remote', exact(target.remote)], signal, true);
}

/** Pushes only committed/finalized changes. Explicit non-forced refspecs ignore push.default and mirror settings. */
export async function pushRepository(ctx: GitContext, target: RemoteTarget, signal?: AbortSignal, revision?: string): Promise<RemoteResult> {
  return withRepositoryMutation(ctx, async () => {
    await validateTarget(ctx, target, signal);
    if (revision && !/^[0-9a-f]{40,64}$/.test(revision)) throw new Error('Invalid change identifier.');
    let sha: string;
    let keepLocalBookmark = false;
    if (ctx.backend === 'jj') {
      await jj(ctx, ['util', 'snapshot'], signal, true);
      const tip = await workingParent(ctx, signal);
      if (/^0+$/.test(tip)) throw new Error('Create a change before pushing.');
      sha = revision || tip;
      if (!await isAncestor(ctx, sha, tip, signal)) throw new Error('The selected change is not an ancestor of the latest finalized change.');
      const local = (await bookmarks(ctx, signal)).find(ref => ref.name === target.branch && !ref.remote);
      if (local?.conflict) throw new Error('The tracked bookmark has conflicting targets. Pull to reconcile it before pushing.');
      const working = await jj(ctx, ['log', '-G', '-r', '@', '-T', 'commit_id'], signal);
      if (local?.sha && local.sha !== working && !await isAncestor(ctx, local.sha, tip, signal)) throw new Error('The selected branch is not an ancestor of the latest finalized change. Pull to inspect and reconcile its targets.');
      keepLocalBookmark = !!local?.sha && local.sha !== working && await isAncestor(ctx, sha, local.sha, signal);
      const conflicts = await jj(ctx, ['log', '-G', '-r', `ancestors(${sha}) & conflicts()`, '-n', '1', '-T', 'commit_id'], signal);
      if (conflicts) throw new Error('Resolve conflicts before pushing.');
    } else {
      const operation = await gitOperation(ctx, signal);
      if (operation) throw new Error(`Finish or abort the current ${operation} before pushing. Its state was preserved.`);
      await gitBranch(ctx, signal);
      const tip = await gitHead(ctx, signal);
      if (!tip) throw new Error('Create a change before pushing.');
      sha = revision || tip;
      if (!await isAncestor(ctx, sha, tip, signal)) throw new Error('The selected change is not an ancestor of the current branch.');
    }
    // JJ's native push permits rewrites. Git transport guarantees a fast-forward at the server,
    // including races after our checks, while still using JJ's backing Git store and credentials.
    try {
      await git(ctx, ['-c', `remote.${target.remote}.mirror=false`, 'push', '--porcelain', '--no-force', '--no-follow-tags',
        '--recurse-submodules=no', '--', target.remote, `${sha}:refs/heads/${target.branch}`], signal);
    } catch (error) {
      if (error instanceof CommandError && error.interrupted)
        throw new Error('Push was interrupted. The remote may already have accepted the changes. Pull or inspect the remote before retrying.\n' + error.message);
      throw error;
    }
    if (ctx.backend === 'jj') {
      try {
        await jj(ctx, ['git', 'import']);
        if (!keepLocalBookmark) {
          const tip = await workingParent(ctx);
          await alignJjBookmark(ctx, target, revision ? tip : sha, new Set());
        }
        const refs = await bookmarks(ctx);
        if (refs.some(ref => ref.name === target.branch && ref.remote === target.remote))
          await jj(ctx, ['bookmark', 'track', exact(target.branch), '--remote', exact(target.remote)], undefined, true);
      } catch (error) { return { message: `Push to ${target.remote}/${target.branch} succeeded. Local tracking needs attention; refresh and retry Pull.\n${String((error as Error).message)}`, attention: true }; }
    }
    return { message: `Pushed to ${target.remote}/${target.branch}.` };
  });
}

/** Git fast-forwards. JJ also reconciles one private linear history after a conflict-free preview. */
export async function pullRepository(ctx: GitContext, target: RemoteTarget, signal?: AbortSignal): Promise<RemoteResult> {
  return withRepositoryMutation(ctx, async () => {
    await validateTarget(ctx, target, signal);
    if (ctx.backend !== 'jj') {
      const operation = await gitOperation(ctx, signal);
      if (operation) throw new Error(`Finish or abort the current ${operation} before pulling. Its state was preserved.`);
      const branch = await gitBranch(ctx, signal);
      const before = await gitHead(ctx, signal);
      await git(ctx, ['fetch', '--no-tags', '--no-recurse-submodules', '--', target.remote, `refs/heads/${target.branch}`], signal);
      const incoming = await git(ctx, ['rev-parse', '--verify', 'FETCH_HEAD'], signal);
      if (before && !await isAncestor(ctx, before, incoming, signal)) {
        if (await isAncestor(ctx, incoming, before, signal)) return { message: `Already up to date with ${target.remote}/${target.branch}.` };
        throw new Error(`Fetched ${target.remote}/${target.branch}. ${divergent().message} Merge or rebase the local branch, then retry. No local commits or files were changed.`);
      }
      if (await gitBranch(ctx, signal) !== branch || await gitHead(ctx, signal) !== before)
        throw new Error('Fetched updates, but the local branch changed during Pull. Refresh before retrying.');
      try { await git(ctx, ['-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-edit', '--no-autostash', '--no-overwrite-ignore', incoming], signal); }
      catch (error) { throw new Error(`Fetched ${target.remote}/${target.branch}, but the incoming changes were not integrated.\n${String((error as Error).message)}`); }
      return { message: before === incoming ? `Already up to date with ${target.remote}/${target.branch}.` : `Pulled from ${target.remote}/${target.branch}.` };
    }

    await jj(ctx, ['util', 'snapshot'], signal, true);
    await workingParent(ctx, signal);
    const initialRefs = await bookmarks(ctx, signal);
    if (await jj(ctx, ['log', '-G', '-r', '(@:: ~ @) | (ancestors(@) & conflicts())', '-n', '1', '-T', 'commit_id'], signal))
      throw new Error('Finish the current change or resolve its conflicts before pulling.');
    await jj(ctx, ['git', 'fetch', '--remote', exact(target.remote), '--branch', exact(target.branch)], signal, true);
    let integrated = false;
    try {
      const incoming = await jj(ctx, ['log', '-G', '-r', remoteRev(target), '-T', 'commit_id'], signal);
      if (!/^[0-9a-f]{40,64}$/.test(incoming)) throw new Error('The remote branch is absent or has conflicting targets. Inspect its tracking in Jujutsu.');
      const previousRemote = initialRefs.find(ref => ref.name === target.branch && ref.remote === target.remote)?.sha;
      if (previousRemote && !await isAncestor(ctx, previousRemote, incoming, signal))
        throw new Error('The remote branch was rewritten. Inspect the old and new histories in your VCS before integrating them.');
      const before = await workingParent(ctx, signal);
      const working = await jj(ctx, ['log', '-G', '-r', '@', '-T', 'commit_id'], signal);
      const local = (await bookmarks(ctx, signal)).find(ref => ref.name === target.branch && !ref.remote);
      for (const sha of local?.targets || []) if (sha !== working && !await isAncestor(ctx, sha, before, signal) && !await isAncestor(ctx, sha, incoming, signal))
        throw new Error('The selected bookmark has finalized changes beyond the working change. Reconcile that independent branch in Jujutsu.');
      let rewritten = new Set<string>(), count = 0;
      const ahead = await isAncestor(ctx, incoming, before, signal);
      if (!ahead) {
        const affected = /^0+$/.test(before) ? (await git(ctx, ['ls-tree', '-r', '--name-only', '-z', incoming], signal, true)).split('\0').filter(Boolean) :
          (await git(ctx, ['diff', '--name-only', '-z', '--no-renames', before, incoming, '--'], signal, true)).split('\0').filter(Boolean);
        await protectUntrackedJjFiles(ctx, affected, signal);
        const operation = await jj(ctx, ['op', 'log', '-G', '-n', '1', '-T', 'id'], signal);
        const plan = await previewJjRebase(ctx, incoming, working, target, signal);
        // Detect an external edit/rebase during the preview before changing the actual workspace.
        if (await jj(ctx, ['log', '-G', '-r', '@', '-T', 'commit_id'], signal) !== working ||
            await jj(ctx, ['log', '-G', '-r', remoteRev(target), '-T', 'commit_id'], signal) !== incoming ||
            await jj(ctx, ['op', 'log', '-G', '-n', '1', '-T', 'id'], signal) !== operation)
          throw new Error('The repository changed during Pull. Refresh before retrying.');
        await jj(ctx, ['rebase', '-s', plan.root, '-o', incoming], signal, true);
        integrated = true; rewritten = plan.rewritten; count = plan.count;
        if (await jj(ctx, ['log', '-G', '-r', 'ancestors(@) & conflicts()', '-n', '1', '-T', 'commit_id'], signal))
          throw new Error('Integration produced file conflicts. Inspect VCS Pending Changes and the marked history entries before syncing again.');
      }
      await alignJjBookmark(ctx, target, await workingParent(ctx, signal), rewritten, signal);
      return { message: `${ahead ? 'Already up to date with' : 'Pulled from'} ${target.remote}/${target.branch}.` +
        (count ? ` Rebased ${count} local ${count === 1 ? 'change' : 'changes'} and preserved Workcopy.` : '') + ` Aligned bookmark ${target.branch} with the latest finalized change.` };
    } catch (error) {
      throw new Error(`Fetched ${target.remote}/${target.branch}. ${integrated ? 'The Workcopy was rebased, but synchronization needs attention.' : 'Integration stopped; local history and Workcopy were preserved.'}\n${String((error as Error).message)}`);
    }
  });
}
