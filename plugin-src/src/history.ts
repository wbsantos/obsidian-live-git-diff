import { repositoryHead, repositoryLog, evolution, workcopy, WORKCOPY } from './repository.ts';
import type { CommitInfo, GitContext } from './git.ts';
import { fileLogAsync } from './git.ts';

export interface HistoryFile { path: string; name: string; historicalHead?: string }
export interface HistoryEntry {
  key: string;
  context: GitContext;
  head: string;
  commits: CommitInfo[];
  limit: number;
  hasMore: boolean;
  lastSyncedAt: number;
  generation: number;
}
export interface HistoryLoader {
  head(context: GitContext, signal: AbortSignal): Promise<string>;
  log(context: GitContext, head: string, limit: number, signal: AbortSignal): Promise<CommitInfo[]>;
}
const defaultLoader: HistoryLoader = {
  head: repositoryHead,
  log: repositoryLog,
};

export function historyKey(context: GitContext): string {
  // Git has already resolved directory junctions. Windows root paths are case-insensitive;
  // the repository-relative name retains its spelling for Git's tree lookup.
  const root = context.root.replace(/\\/g, '/').replace(/\/$/, '');
  return JSON.stringify([/^[A-Za-z]:\//.test(root) ? root.toLowerCase() : root, context.rel, context.backend || 'git', context.workspaceRoot || '']);
}

/** Cache completion never publishes UI events: only the requesting view may accept a result. */
export class HistoryCache {
  private entries = new Map<string, HistoryEntry>();
  private aliases = new Map<string, { key: string; generation: number }>();
  private counter = 0;
  private lifetime = new AbortController();
  private loader: HistoryLoader;
  private now: () => number;
  constructor(loader: HistoryLoader = defaultLoader, now: () => number = Date.now) { this.loader = loader; this.now = now; }
  get signal(): AbortSignal { return this.lifetime.signal; }
  nextRequest(): number { return ++this.counter; }
  forFile(filePath: string): HistoryEntry | undefined { return this.entries.get(this.aliases.get(filePath)?.key || ''); }
  forContext(context: GitContext): HistoryEntry | undefined { return this.entries.get(historyKey(context)); }
  async read(filePath: string, context: GitContext, generation: number, limit: number, pinnedHead?: string, historical = false): Promise<HistoryEntry> {
    const key = historyKey(context) + (historical ? `@${pinnedHead}` : ''), alias = this.aliases.get(filePath);
    if (!alias || generation >= alias.generation) this.aliases.set(filePath, { key, generation });
    const head = pinnedHead || await this.loader.head(context, this.signal);
    const found = historical ? await fileLogAsync(context.root, context.rel, limit + 1, { head, signal: this.signal })
      : await this.loader.log(context, head, limit + 1, this.signal);
    const unique = found.filter((commit, index) => found.findIndex(other => other.sha === commit.sha) === index);
    const entry: HistoryEntry = { key, context, head, commits: unique.slice(0, limit), limit,
      hasMore: unique.length > limit, lastSyncedAt: this.now(), generation };
    const previous = this.entries.get(key);
    if (!this.signal.aborted && (!previous || generation > previous.generation)) this.entries.set(key, entry);
    return entry;
  }
  dispose(): void { this.lifetime.abort(); this.entries.clear(); this.aliases.clear(); }
}

export interface HistoryState {
  file: HistoryFile | null;
  entry?: HistoryEntry;
  loading: boolean;
  error: string | null;
  selected: CommitInfo[];
  hint: string | null;
  unavailable: boolean;
  expanded?: Record<string, { commits: CommitInfo[]; loading: boolean; limit: number; hasMore: boolean; error?: string }>;
}
export interface HistoryComparisonRequest {
  readonly filePath: string;
  readonly commits: readonly Readonly<CommitInfo>[];
}
export type HistoryResolver = (file: HistoryFile, signal: AbortSignal) => Promise<GitContext>;

/** One panel visit has an epoch, independently of file identity and Git request ordering. */
export class HistoryController {
  state: HistoryState = { file: null, loading: false, error: null, selected: [], hint: null, unavailable: false };
  private epoch = 0;
  private request = 0;
  private closed = false;
  private cache: HistoryCache;
  private resolve: HistoryResolver;
  private pageSize: () => number;
  private changed: (state: HistoryState) => void;
  constructor(cache: HistoryCache, resolve: HistoryResolver, pageSize: () => number,
    changed: (state: HistoryState) => void) {
    this.cache = cache; this.resolve = resolve; this.pageSize = pageSize; this.changed = changed;
  }
  async setFile(file: HistoryFile | null): Promise<void> {
    if (this.closed || (!this.state.unavailable && (file?.path || null) === (this.state.file?.path || null) && file?.historicalHead === this.state.file?.historicalHead)) return;
    this.epoch++;
    this.state = { file, entry: file && !file.historicalHead ? this.cache.forFile(file.path) : undefined,
      loading: false, error: null, selected: file && !file.historicalHead ? [workcopy(file.path)] : [], hint: null, unavailable: false, expanded: {} };
    this.emit();
    if (file) await this.refresh();
  }
  async refresh(more = false): Promise<void> {
    const file = this.state.file;
    if (!file || this.closed || this.state.unavailable || (more && (this.state.loading || !this.state.entry?.hasMore))) return;
    const epoch = this.epoch, request = this.cache.nextRequest(), previous = this.state.entry;
    this.request = request;
    const pageSize = Math.max(1, Math.floor(this.pageSize()) || 50);
    const limit = more ? (previous?.limit || pageSize) + pageSize : Math.max(previous?.limit || 0, pageSize);
    this.state = { ...this.state, loading: true, error: null, hint: null }; this.emit();
    const current = (): boolean => !this.closed && epoch === this.epoch && request === this.request && file.path === this.state.file?.path;
    try {
      const context = more && previous ? previous.context : await this.resolve(file, this.cache.signal);
      // Continue even when the panel moved to another note: that original note still gets its cache.
      const entry = await this.cache.read(file.historicalHead ? `${file.path}@${file.historicalHead}` : file.path, context, request, limit,
        file.historicalHead || (more ? previous?.head : undefined), !!file.historicalHead);
      if (!current()) return;
      const oldWorkcopy = this.state.entry?.commits.find(c=>c.kind==='workcopy');
      const newWorkcopy = entry.commits.find(c=>c.kind==='workcopy');
      let selected = this.state.selected.map(c=>c.kind==='workcopy' && newWorkcopy ? newWorkcopy : c);
      const opened = Object.keys(this.state.expanded || {});
      selected=selected.map(c=>{
        if(c.kind==='workcopy' || !c.changeId || entry.commits.some(item=>item.sha===c.sha))return c;
        const parent=entry.commits.find(item=>item.changeId===c.changeId);
        if(!parent)return c;
        if(!opened.includes(parent.sha))opened.push(parent.sha);
        return {...c,groupId:parent.sha,snapshot:true};
      });
      if (newWorkcopy?.changeId && newWorkcopy.changeId !== oldWorkcopy?.changeId && !opened.includes(WORKCOPY)) opened.push(WORKCOPY);
      this.state = { ...this.state, entry, selected, loading: false, error: null }; this.emit();
      for (const sha of opened) if (entry.context.backend==='jj') await this.expand(sha, true);

    } catch (error) {
      if (!current()) return;
      this.state = { ...this.state, loading: false, error: (error as Error).message || String(error) }; this.emit();
    }
  }
  select(sha: string): void {
    if (!this.state.file || this.closed || this.state.unavailable) return;
    const commit = this.available().find(item => item.sha === sha);
    if (!commit) return;
    let selected = this.state.selected;
    if (selected.some(item => item.sha === sha)) selected = selected.filter(item => item.sha !== sha);
    else if (selected.length === 2 && selected.some(c=>c.kind==='workcopy')) selected = [selected.find(c=>c.kind==='workcopy')!,commit];
    else if (selected.length === 2) {
      this.state = { ...this.state, hint: 'Select up to two versions. Deselect a version first.' }; this.emit(); return;
    } else selected = [...selected, commit];
    this.setSelection(selected.map(item => item.sha));
  }
  /** Explicit actions replace the draft atomically, without intermediate toggle states. */
  setSelection(shas: readonly string[]): boolean {
    if (!this.state.file || this.closed || this.state.unavailable || shas.length > 2) return false;
    const available = this.available();
    const commits = [...new Set(shas)].map(sha => available.find(item => item.sha === sha));
    if (commits.some(commit => !commit)) return false;
    // The file history is newest first. The lower row is the earlier version, on the left.
    const order = this.available();
    const selected = (commits as CommitInfo[]).sort((a, b) => a.kind==='workcopy' ? 1 : b.kind==='workcopy' ? -1 : order.findIndex(item => item.sha === b.sha) - order.findIndex(item => item.sha === a.sha));
    this.state = { ...this.state, selected, hint: null }; this.emit();
    return true;
  }
  available(): CommitInfo[] {
    const commits: CommitInfo[] = [];
    for (const parent of this.state.entry?.commits || []) {
      commits.push(parent);
      commits.push(...(this.state.expanded?.[parent.sha]?.commits || []));
    }
    for (const selected of this.state.selected) if (!commits.some(c=>c.sha===selected.sha)) commits.push(selected);
    return commits;
  }
  doubleSelect(sha: string): boolean {
    if (!this.state.selected.some(c=>c.sha===sha)) this.select(sha);
    return this.state.selected.some(c=>c.sha===sha);
  }
  reportError(error: string): void {
    if(this.closed) return;
    this.state={...this.state,error,loading:false};this.emit();
  }
  async expand(sha: string, refresh = false, more = false): Promise<void> {
    const entry=this.state.entry, file=this.state.file, epoch=this.epoch;
    if (!entry || entry.context.backend!=='jj' || this.closed) return;
    const parent=entry.commits.find(c=>c.sha===sha); if(!parent) return;
    const old=this.state.expanded?.[sha];
    if(old && !refresh && !more) {
      const expanded={...this.state.expanded};delete expanded[sha];
      this.state={...this.state,expanded,selected:this.state.selected.filter(c=>c.groupId!==sha)};this.emit();return;
    }
    const limit=more ? (old?.limit || this.pageSize())+this.pageSize() : old?.limit || this.pageSize();
    const pending={commits:old?.commits || [],loading:true,limit,hasMore:false};
    this.state={...this.state,expanded:{...this.state.expanded,[sha]:pending}};this.emit();
    try {
      const result=await evolution(entry.context,parent,limit,this.cache.signal);
      if(this.closed || epoch!==this.epoch || file!==this.state.file || this.state.expanded?.[sha]!==pending) return;
      for(const pinned of this.state.selected.filter(c=>c.groupId===sha)) if(!result.commits.some(c=>c.sha===pinned.sha))result.commits.push(pinned);
      this.state={...this.state,expanded:{...this.state.expanded,[sha]:{...result,loading:false,limit}}};this.emit();
    } catch(error) {
      if(this.closed || epoch!==this.epoch || file!==this.state.file || this.state.expanded?.[sha]!==pending) return;
      this.state={...this.state,expanded:{...this.state.expanded,[sha]:{...pending,loading:false,error:String(error)}}};this.emit();
    }
  }
  /** Selection is a draft. Only an explicit action takes a detached, immutable request. */
  comparisonRequest(): HistoryComparisonRequest | null {
    const { file, selected, unavailable } = this.state;
    if (this.closed || !file || unavailable || selected.length !== 2) return null;
    return Object.freeze({ filePath: file.path, commits: Object.freeze(selected.map(commit => Object.freeze({ ...commit }))) });
  }
  fileUnavailable(): void {
    if (this.closed || !this.state.file) return;
    this.epoch++;
    this.state = { ...this.state, unavailable: true, loading: false, selected: [], hint: null,
      error: 'The file is no longer available. Choose another file with VCS History.' };
    this.emit();
  }
  clearSelection(filePath?: string): void {
    if (filePath && this.state.file?.path !== filePath) return;
    if (this.state.selected.length) { this.state = { ...this.state, selected: [], hint: null }; this.emit(); }
  }
  private emit(): void { if (!this.closed) this.changed(this.state); }
  dispose(): void { this.closed = true; this.epoch++; }
}

export function historyStatus(state: HistoryState): string {
  const stamp = state.entry?.lastSyncedAt;
  const date = stamp === undefined ? null : new Date(stamp);
  const time = date ? [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0')).join(':') : '';
  const synced = date ? `Last synced at ${time}` : '';
  if (state.unavailable) return ['File is no longer available', synced].filter(Boolean).join(' · ');
  if (state.loading) return ['Loading file history…', synced].filter(Boolean).join(' · ');
  if (state.error) return ['Unable to refresh file history', synced].filter(Boolean).join(' · ');
  return synced || (state.file ? 'No file history loaded' : 'Choose a file with VCS History');
}
