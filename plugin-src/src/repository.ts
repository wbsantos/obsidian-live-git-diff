import { execFile } from 'child_process';
import * as path from 'path';
import type { App, TFile } from 'obsidian';
import { absPathOf, resolveGitAsync, resolveRefAsync, fileLogAsync, readBaseAtAsync, commitInfoForAsync } from './git.ts';
import type { GitContext, CommitInfo } from './git.ts';

export const WORKCOPY = 'workcopy';
export const SNAPSHOT_DELAY = 15_000;
export const workcopy = (rel: string): CommitInfo => ({kind:'workcopy', sha:WORKCOPY, shortSha:'Workcopy', subject:'Workcopy', path:rel, date:'', relative:'Live document'});
function jj(root: string, args: string[], signal?: AbortSignal, snapshot = false, discover = false): Promise<string> {
  return new Promise((resolve, reject) => execFile('jj', [...(snapshot ? [] : ['--ignore-working-copy']), '--no-pager', '--color=never', ...(discover ? [] : ['-R', root]), ...args],
    {cwd:root, encoding:'utf8', windowsHide:true, timeout:30_000, maxBuffer:64*1024*1024, signal}, (error, out, err) => error ? reject(new Error(String(err || error.message))) : resolve(out)));
}
const queues = new Map<string, Promise<unknown>>();
/** Serialize all plugin mutations, including background snapshots, per repository. */
export async function withRepositoryMutation<T>(ctx: GitContext, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(ctx.root) || Promise.resolve();
  const job = previous.catch(() => {}).then(run);
  queues.set(ctx.root, job);
  try { return await job; } finally { if (queues.get(ctx.root) === job) queues.delete(ctx.root); }
}
function gitRead(root:string,args:string[],signal?:AbortSignal):Promise<string> {
  return new Promise((resolve,reject)=>execFile('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,timeout:30_000,maxBuffer:64*1024*1024,signal},(error,out,err)=>error?reject(new Error(String(err||error.message))):resolve(out)));
}
export async function snapshotWorkspace(ctx: GitContext, signal?: AbortSignal): Promise<void> {
  if (ctx.backend !== 'jj') return;
  const root = ctx.workspaceRoot!;
  await withRepositoryMutation(ctx, async () => { if (signal?.aborted) throw new Error('Snapshot cancelled'); await jj(root, ['util','snapshot'], signal, true); });
}
/** Skip automatic snapshots when this note matches its last recorded version. */
export async function snapshotNote(ctx: GitContext, signal?: AbortSignal): Promise<boolean> {
  if (ctx.backend !== 'jj') return false;
  return withRepositoryMutation(ctx, async () => {
    if (signal?.aborted) throw new Error('Snapshot cancelled');
    const sha = (await jj(ctx.workspaceRoot!, ['log','-G','-r','@','-T','commit_id'], signal)).trim();
    const [tree, hash] = await Promise.all([
      gitRead(ctx.root, ['--literal-pathspecs','ls-tree','-z',sha,'--',ctx.rel], signal),
      gitRead(ctx.root, ['hash-object','--no-filters','--',ctx.abs], signal),
    ]);
    const stored = tree.match(/^\d+ blob ([0-9a-f]+)\t/)?.[1];
    if (stored === hash.trim()) return false;
    await jj(ctx.workspaceRoot!, ['util','snapshot'], signal, true);
    return true;
  });
}
export async function resolveRepository(app: App, file: TFile, signal?: AbortSignal): Promise<GitContext> {
  const abs = absPathOf(app, file), dir = path.dirname(abs);
  let workspaceRoot: string;
  // -R requires a workspace root; discovery must search upward from the file's folder.
  try { workspaceRoot = (await jj(dir, ['root'], signal, false, true)).trim(); }
  catch (error) {
    if (signal?.aborted) throw error;
    if (!/no jj repo|not.*jj repo|ENOENT|not found/i.test(String(error))) throw error;
    return {...await resolveGitAsync(app, file, signal), backend:'git'};
  }
  const root = (await jj(workspaceRoot, ['git','root'], signal)).trim();
  // A colocated Git resolver also resolves physical Windows junctions for us.
  let rel = path.relative(workspaceRoot, abs).replace(/\\/g,'/');
  try {
    const git=await resolveGitAsync(app,file,signal);
    if(path.resolve(git.root).toLowerCase()!==path.resolve(workspaceRoot).toLowerCase() && path.resolve(git.root).toLowerCase().startsWith(path.resolve(workspaceRoot).toLowerCase()+path.sep)) return {...git,backend:'git'};
    rel=git.rel;
  } catch { /* non-colocated JJ workspace */ }
  if (rel.startsWith('../') || path.isAbsolute(rel)) throw new Error('Note resolves outside the JJ workspace.');
  return {abs, root, rel, backend:'jj', workspaceRoot};
}
const fields = (c = 'self.') => `"sha" => ${c}commit_id(), "changeId" => ${c}change_id(), "subject" => ${c}description().first_line(), "author" => ${c}author().name(), "date" => ${c}committer().timestamp().local().format("%b %d, %H:%M:%S"), "relative" => ${c}committer().timestamp().ago()`;
function records(out: string): CommitInfo[] { return out.split(/\r?\n/).filter(Boolean).map(line => { const c = JSON.parse(line); return {...c, date:c.operationDate || c.date, sha:String(c.sha), changeId:String(c.changeId), shortSha:String(c.sha).slice(0,8), subject:c.subject || '(no description)', path:'', kind:'commit'}; }); }
export async function repositoryHead(ctx: GitContext, signal?: AbortSignal): Promise<string> {
  if (ctx.backend === 'jj') {
    await snapshotNote(ctx, signal);
    return (await jj(ctx.workspaceRoot!, ['log','-G','-r','@','-T','commit_id'], signal)).trim();
  }
  try { return await resolveRefAsync(ctx.root,'HEAD',signal); }
  catch (error) { if (/unknown revision|Needed a single revision|bad revision|not a valid object/i.test(String(error))) return ''; throw error; }
}
export async function repositoryLog(ctx: GitContext, head: string, limit: number, signal?: AbortSignal): Promise<CommitInfo[]> {
  const wc = workcopy(ctx.rel);
  if (!head) return [wc];
  const log = await fileLogAsync(ctx.root,ctx.rel,limit,{head,signal});
  if (ctx.backend !== 'jj') {
    const changed = await gitRead(ctx.root, ['--literal-pathspecs','diff','--no-ext-diff','--no-textconv','--name-only','-z',head,'--',ctx.rel], signal);
    if (log.length && !changed) {
      Object.assign(wc, { currentSha: head, headCommit: log[0] });
      return [wc,...log.slice(1)];
    }
    return [wc,...log];
  }
  const ids = [...new Set([head,...log.map(c=>c.sha)])];
  const meta = records(await jj(ctx.workspaceRoot!, ['log','-G','-r',ids.join('|'),'-T',`json({${fields()}}) ++ "\\n"`],signal));
  const current = meta.find(c=>c.sha===head)!;
  Object.assign(wc,{changeId:current.changeId,currentSha:head,subject:current.subject === '(no description)' ? 'Workcopy' : current.subject});
  const history = log.filter(c=>c.sha!==head).map(c=>({...c,...meta.find(m=>m.sha===c.sha),path:c.path}));
  const changed = await jj(ctx.workspaceRoot!, ['diff','-r',head,'--summary','--',`root-file:${JSON.stringify(ctx.rel)}`], signal);
  if (history.length && !changed.trim()) {
    wc.headCommit = history.shift();
  }
  return [wc,...history];
}
export async function revisionInfo(ctx: GitContext, sha: string, signal?: AbortSignal): Promise<CommitInfo> {
  if(sha.startsWith('-')) throw new Error('Invalid revision.');
  if (ctx.backend !== 'jj') return commitInfoForAsync(ctx.root,sha,signal);
  const result = records(await jj(ctx.workspaceRoot!, ['log','-G','-r',sha,'-T',`json({${fields()}}) ++ "\\n"`],signal));
  if (result.length !== 1) throw new Error('Choose a single JJ revision.');
  return result[0];
}
export async function resolveRevision(ctx: GitContext, ref: string, signal?: AbortSignal): Promise<string> {
  if (ctx.backend !== 'jj') return resolveRefAsync(ctx.root,ref,signal);
  return (await revisionInfo(ctx,ref==='HEAD' ? '@-' : ref==='HEAD~1' ? '@--' : ref,signal)).sha;
}
/** Pin HEAD for a dirty note, or HEAD's direct parent for a clean note. */
export async function previousReviewBase(ctx: GitContext, signal?: AbortSignal, workingText?: string): Promise<{ sha: string; label: string }> {
  const head = await resolveRevision(ctx, 'HEAD', signal);
  const status = ctx.backend === 'jj'
    ? await jj(ctx.workspaceRoot!, ['diff', '-r', '@', '--summary', '--', `root-file:${JSON.stringify(ctx.rel)}`], signal)
    : await gitRead(ctx.root, ['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ctx.rel], signal);
  let dirty = !!status.trim();
  if (!dirty && workingText !== undefined) {
    const base = await readBaseAtAsync(ctx.root, ctx.rel, head, signal);
    const normalize = (text: string): string => text.replace(/\r\n?/g, '\n');
    dirty = normalize(base.text) !== normalize(workingText);
  }
  if (dirty) return { sha: head, label: 'HEAD' };
  try {
    const sha = await resolveRevision(ctx, ctx.backend === 'jj' ? `${head}-` : `${head}^`, signal);
    return { sha, label: 'HEAD~1' };
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('HEAD has no single previous commit to compare against. Choose a version explicitly.');
  }
}
export async function readRevision(ctx: GitContext, commit: CommitInfo, signal?: AbortSignal): Promise<{text:string;path:string;renamedFrom:string|null}> {
  if (commit.absent) return {text:'',path:commit.path,renamedFrom:null};
  try { return await readBaseAtAsync(ctx.root,ctx.rel,commit.sha,signal,commit.path || undefined); }
  catch(error) {
    if(signal?.aborted) throw error;
    const rel=commit.path || ctx.rel;
    const listing=await gitRead(ctx.root,['--literal-pathspecs','ls-tree','-z',commit.sha,'--',rel],signal);
    if(listing) throw error;
    return {text:'',path:rel,renamedFrom:null};
  }
}
export async function evolution(ctx: GitContext, parent: CommitInfo, limit: number, signal?: AbortSignal): Promise<{commits:CommitInfo[];hasMore:boolean}> {
  if (ctx.backend !== 'jj') return {commits:[],hasMore:false};
  const start = parent.kind==='workcopy' ? parent.currentSha! : parent.sha;
  // Imported Git commits have no associated operation. Commit timestamps exist for both origins.
  const entries = records(await jj(ctx.workspaceRoot!, ['evolog','-G','-r',start,'-n',String(limit+1),'-T',`json({${fields('self.commit().')}}) ++ "\\n"`],signal));
  const versions:CommitInfo[] = [];
  let last: string | undefined;
  let previous:CommitInfo|undefined, trackedPath=parent.path || ctx.rel;
  for (const item of entries.slice(0,limit)) {
    let text:string;
    if(previous) {
      const diff=(await gitRead(ctx.root,['diff','--name-status','-z','-M',item.sha,previous.sha],signal)).split('\0');
      for(let i=0;i<diff.length;) { const status=diff[i++];if(status.startsWith('R')) { const before=diff[i++],after=diff[i++];if(after===trackedPath) trackedPath=before; } else i++; }
    }
    try { const read=await readBaseAtAsync(ctx.root,trackedPath,item.sha,signal,trackedPath); text=read.text; item.path=read.path; }
    catch (error) {
      if (signal?.aborted) throw error;
      // Explicitly verify absence; transport/read failures must not masquerade as empty files.
      const listing=await jj(ctx.workspaceRoot!,['file','list','-r',item.sha,'--',`root-file:${JSON.stringify(trackedPath)}`],signal);
      if (listing.trim()) throw error;
      item.absent=true;item.path=trackedPath;text='\0absent';
    }
    if (text !== last && (parent.kind==='workcopy' || item.sha!==start)) versions.push({...item,snapshot:true,groupId:parent.sha});
    last=text;
    previous=item;
  }
  return {commits:versions,hasMore:entries.length>limit};
}
