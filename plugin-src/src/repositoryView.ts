import { ItemView, Menu, Notice, Scope, WorkspaceLeaf, setIcon, type ViewStateResult } from 'obsidian';
import type { GitContext } from './git.ts';
import { snapshotWorkspace } from './repository.ts';
import { createChange, getChangeDetails, getRepositoryStatus } from './repositoryManager.ts';
import { errorMessage } from './errors.ts';
import { FILE_HISTORY_ICON, REPOSITORY_HISTORY_ICON } from './icons.ts';
import { repositorySyncState } from './repositoryRemote.ts';
import type { RepositorySyncState } from './repositoryRemote.ts';
import type { RepositoryChange, RepositoryFile, RepositoryPage, RepositoryStatus } from './repositoryManager.ts';

export const REPOSITORY_VIEW_TYPE = 'live-git-diff-repository';
export { REPOSITORY_HISTORY_ICON } from './icons.ts';
export type RepositoryRoute =
  | { kind: 'log'; context: GitContext; path?: string }
  | { kind: 'details'; context: GitContext; sha: string }
  | { kind: 'changes'; context: GitContext; paths?: string[] };

export interface RepositoryViewHost {
  settings: { logLimit: number; pendingChangesView?: 'tree' | 'list' };
  saveSettings?(): Promise<void>;
  loadRepositoryHistory(context: GitContext, path: string | undefined, offset: number, limit: number, signal?: AbortSignal): Promise<RepositoryPage>;
  navigateRepository(route: RepositoryRoute): Promise<void>;
  openRepositoryFile(context: GitContext, path: string, revision?: string): Promise<void>;
  openRepositoryNote?(context: GitContext, path: string): Promise<void>;
  navigationBack(): void;
  navigationForward(): void;
  navigationState(): { back: boolean; forward: boolean };
  repositoryChanged(context: GitContext): Promise<void>;
  generateDescription?(context: GitContext, paths: string[], token: string, signal: AbortSignal): Promise<string>;
  explainRepository?(context: GitContext, options: { sha?: string; paths?: string[]; token?: string }): Promise<void>;
  syncRepository?(context: GitContext, action: 'push' | 'pull', revision?: string): Promise<void>;
}

interface VisitState {
  query: string;
  scroll: number;
  collapsed: Set<string>;
  selected: Set<string>;
  description: string;
  initialized: boolean;
  pages: number;
}
interface FileTree { folders: Map<string, FileTree>; files: RepositoryFile[]; path: string }
const statusName = (status: string): string => ({ A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict', '?': 'Added', T: 'Type changed' }[status[0]] || status);
const identity = (ctx: GitContext): string => `${ctx.backend || 'git'}\n${ctx.workspaceRoot || ctx.root}`;
const routeKey = (route: RepositoryRoute): string => `${identity(route.context)}\n${route.kind}\n${route.kind === 'details' ? route.sha : route.kind === 'log' ? route.path || '' : ''}`;
const displayDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/** Repository navigation is shared with file history; only this view owns its drafts. */
export class GitRepositoryView extends ItemView {
  private host: RepositoryViewHost;
  private route: RepositoryRoute | null = null;
  private visits = new Map<string, VisitState>();
  private state: VisitState | null = null;
  private job: AbortController | null = null;
  private generation = 0;
  private closed = false;
  private loading = false;
  private mutating = false;
  private remoteAction: 'push' | 'pull' | null = null;
  private error = '';
  private changes: RepositoryChange[] = [];
  private anchor: string | undefined;
  private hasMore = false;
  private details: { change: RepositoryChange; files: RepositoryFile[] } | null = null;
  private status: RepositoryStatus | null = null;
  private pendingCount = 0;
  private syncState: RepositorySyncState = { synced: [], warning: '' };
  private body: HTMLElement | null = null;
  private footer: HTMLElement | null = null;
  private back: HTMLButtonElement | null = null;
  private forward: HTMLButtonElement | null = null;
  private createButton: HTMLButtonElement | null = null;
  private selectionLabel: HTMLElement | null = null;
  private query: HTMLInputElement | null = null;
  private more: HTMLButtonElement | null = null;
  private aiJob: AbortController | null = null;
  private aiButton: HTMLButtonElement | null = null;
  private folderSelections = new Map<HTMLInputElement, readonly RepositoryFile[]>();

  constructor(leaf: WorkspaceLeaf, host: RepositoryViewHost) {
    super(leaf); this.host = host;
    this.scope = new Scope(this.app.scope);
    this.scope.register(['Mod'], 'Enter', event => {
      if (event.isComposing || !this.contentEl.contains(this.contentEl.ownerDocument.activeElement)) return;
      if (this.route?.kind === 'changes' && !event.repeat) void this.submit();
      return false;
    });
  }
  get currentRoute(): RepositoryRoute | null { return this.route; }
  getViewType(): string { return REPOSITORY_VIEW_TYPE; }
  getDisplayText(): string { return 'Repository'; }
  getIcon(): string { return REPOSITORY_HISTORY_ICON; }
  async onOpen(): Promise<void> { this.closed = false; this.contentEl.addClass('lgd-repository'); this.render(); }
  async onClose(): Promise<void> { this.rememberScroll(); this.closed = true; this.job?.abort(); this.aiJob?.abort(); this.generation++; }
  getState(): Record<string, unknown> { return this.route ? { route: this.route } : {}; }
  async setState(state: { route?: RepositoryRoute } | null, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    if (state?.route) await this.setRoute(state.route);
  }

  async setRoute(route: RepositoryRoute): Promise<void> {
    this.aiJob?.abort();
    this.rememberScroll();
    this.job?.abort(); this.generation++;
    this.route = route;
    const key = routeKey(route);
    let state = this.visits.get(key);
    if (!state) {
      state = { query: '', scroll: 0, collapsed: new Set(), selected: new Set(), description: '', initialized: false, pages: 1 };
      this.visits.set(key, state);
      // Keep drafts, but bound navigation memory during long review sessions.
      if (this.visits.size > 60) {
        const evict = [...this.visits.keys()].find(candidate => candidate !== key && !candidate.includes('\nchanges\n'));
        if (evict) this.visits.delete(evict);
      }
    }
    this.state = state;
    this.changes = []; this.anchor = undefined; this.details = null; this.status = null; this.hasMore = false; this.error = '';
    this.pendingCount = 0; this.syncState = { synced: [], warning: '' };
    await this.loadRoute(false, route.kind === 'changes' ? route.paths : undefined);
  }
  async refresh(): Promise<void> { if (!this.mutating) { this.rememberScroll(); await this.loadRoute(false); } }
  updateNavigation(): void {
    const nav = this.host.navigationState();
    if (this.back) this.back.disabled = !nav.back || this.mutating;
    if (this.forward) this.forward.disabled = !nav.forward || this.mutating;
  }
  private rememberScroll(): void { if (this.state && this.body) this.state.scroll = this.body.scrollTop; }
  private async run(action: () => void | Promise<void>): Promise<void> {
    try { await action(); }
    catch (error) { if (!this.closed) { this.error = errorMessage(error); this.updateFooter(); } }
  }
  private navigate(route: RepositoryRoute): void { if (!this.mutating) void this.run(() => this.host.navigateRepository(route)); }
  private actionButton(parent: HTMLElement, icon: string, label: string, action: () => void): HTMLButtonElement {
    const button = parent.createEl('button', { cls: 'clickable-icon', attr: { type: 'button', 'aria-label': label, title: label } });
    setIcon(button, icon); button.onclick = action; return button;
  }

  private async loadRoute(append: boolean, requestedPaths?: string[]): Promise<void> {
    const route = this.route, state = this.state;
    if (!route || !state || this.closed) return;
    this.job?.abort(); const job = this.job = new AbortController(), generation = ++this.generation;
    const current = (): boolean => !this.closed && generation === this.generation;
    this.loading = true; this.error = '';
    if (!append) this.render(); else this.updateFooter();
    try {
      if (route.kind === 'log') {
        const limit = Math.min(200, Math.max(10, this.host.settings.logLimit));
        let pages = append ? 1 : state.pages;
        const accumulated = append ? [...this.changes] : [];
        let anchor = append ? this.anchor : undefined, restarted = false;
        let hasMore = false;
        for (let index = 0; index < pages; index++) {
          const page = await this.host.loadRepositoryHistory(route.context, route.path, accumulated.length, limit, job.signal);
          if (!current()) return;
          // External commits or snapshots can move page boundaries between requests.
          // Restart against the new anchor instead of silently skipping/duplicating rows.
          if (accumulated.length && anchor && page.anchor && anchor !== page.anchor) {
            if (restarted) throw new Error('Repository changed while loading history. Refresh to continue.');
            accumulated.length = 0; state.pages = 1; pages = 1; index = -1; anchor = undefined; restarted = true;
            continue;
          }
          anchor = page.anchor;
          accumulated.push(...page.changes); hasMore = page.hasMore;
          if (!hasMore) break;
        }
        this.changes = accumulated; this.hasMore = hasMore; this.anchor = anchor;
        const [pending, sync] = await Promise.all([
          getRepositoryStatus(route.context, job.signal),
          repositorySyncState(route.context, accumulated.map(change => change.sha), job.signal),
        ]);
        if (!current()) return;
        this.pendingCount = pending.files.length; this.syncState = sync;
        if (append && !restarted) state.pages++;
      } else if (route.kind === 'details') {
        const result = await getChangeDetails(route.context, route.sha, job.signal);
        if (!current()) return;
        this.details = result;
      } else {
        const result = await getRepositoryStatus(route.context, job.signal);
        if (!current()) return;
        this.status = result;
        const existing = new Set(result.files.map(file => file.path));
        state.selected = new Set([...state.selected].filter(path => existing.has(path)));
        if (!state.initialized && !state.description) state.description = result.description || '';
        if (requestedPaths?.length) {
          state.selected.clear();
          for (const file of result.files) if (requestedPaths.some(path => file.path === path || file.path.startsWith(path.replace(/\/$/, '') + '/'))) state.selected.add(file.path);
        }
        state.initialized = true;
      }
    } catch (error) { if (current() && !job.signal.aborted) this.error = errorMessage(error); }
    finally {
      if (current()) { this.loading = false; this.render(); }
    }
  }

  private render(): void {
    if (this.closed) return;
    const root = this.contentEl; root.empty();
    this.query = null; this.more = null; this.createButton = null; this.selectionLabel = null; this.aiButton = null;
    const heading = root.createDiv({ cls: 'lgd-repository-heading' });
    this.back = this.actionButton(heading, 'arrow-left', 'Back', () => this.host.navigationBack());
    this.forward = this.actionButton(heading, 'arrow-right', 'Forward', () => this.host.navigationForward());
    const route = this.route;
    const title = route?.kind === 'changes' ? 'VCS Pending Changes' : route?.kind === 'details' ? 'Change details' : route?.path ? route.path.split('/').pop()! : 'Repository history';
    heading.createDiv({ cls: 'lgd-repository-title', text: title, attr: { title: route?.kind === 'log' && route.path ? route.path : title } });
    if (route) {
      if (route.kind !== 'log' || route.path) this.actionButton(heading, REPOSITORY_HISTORY_ICON, 'Repository history', () => this.navigate({ kind: 'log', context: route.context }));
      if (route.kind !== 'changes') this.actionButton(heading, 'git-commit-horizontal', 'VCS Pending Changes', () => this.navigate({ kind: 'changes', context: route.context }));
      if (route.kind === 'changes' && route.context.backend === 'jj') this.actionButton(heading, 'camera', 'Snapshot working copy', () => { void this.snapshot(); });
      if (this.host.syncRepository) {
        this.actionButton(heading, 'download', 'Pull', () => { void this.remote('pull'); }).disabled = this.loading || this.mutating;
        this.actionButton(heading, 'upload', 'Push', () => { void this.remote('push'); }).disabled = this.loading || this.mutating;
      }
      const refresh = this.actionButton(heading, 'refresh-cw', 'Refresh', () => { void this.refresh(); }); refresh.disabled = this.loading || this.mutating;
      const context = route.kind === 'log' && route.path ? route.path : (route.context.workspaceRoot || route.context.root).replace(/\\/g, '/').split('/').pop() || 'Repository';
      const location = root.createDiv({ cls: 'lgd-repository-location', text: context, attr: { title: route.context.workspaceRoot || route.context.root } });
      heading.oncontextmenu = location.oncontextmenu = event => this.remoteMenu(event);
    }
    if (route?.kind === 'log' || route?.kind === 'changes') {
      const filter = route.kind === 'changes' ? root.createDiv({ cls: 'lgd-repository-filter-row' }) : root;
      this.query = filter.createEl('input', { cls: 'lgd-history-filter', type: 'search', placeholder: route.kind === 'log' ? 'Filter loaded changes' : 'Filter files', attr: { 'aria-label': route.kind === 'log' ? 'Filter loaded changes' : 'Filter files' } });
      this.query.value = this.state?.query || '';
      this.query.oninput = () => { if (this.state) this.state.query = this.query!.value; this.renderBody(); };
      if (route.kind === 'changes') {
        const layout = filter.createDiv({ cls: 'lgd-repository-layout' });
        const label = layout.createEl('label', { text: 'View' });
        const select = label.createEl('select', { cls: 'dropdown', attr: { 'aria-label': 'Pending files view' } });
        select.createEl('option', { text: 'File Tree', attr: { value: 'tree' } });
        select.createEl('option', { text: 'File List', attr: { value: 'list' } });
        select.value = this.host.settings.pendingChangesView || 'tree';
        select.disabled = this.loading || this.mutating;
        select.onchange = () => {
          this.host.settings.pendingChangesView = select.value === 'list' ? 'list' : 'tree';
          this.renderBody(); this.updateSelection();
          if (this.host.saveSettings) void this.run(() => this.host.saveSettings!());
        };
      }
    }
    this.body = root.createDiv({ cls: 'lgd-repository-body' });
    this.body.addEventListener('keydown', event => this.moveFocus(event));
    this.renderBody();
    if (route?.kind === 'log' && this.hasMore) {
      this.more = root.createEl('button', { cls: 'lgd-history-more', text: 'Load more', attr: { type: 'button' } });
      this.more.onclick = () => { this.rememberScroll(); void this.loadRoute(true); };
    }
    if (route?.kind === 'changes' && this.state) this.renderComposer(root, this.state);
    this.footer = root.createDiv({ cls: 'lgd-history-footer', attr: { role: 'status', 'aria-live': 'polite' } });
    this.updateFooter(); this.updateNavigation();
    this.body.scrollTop = this.state?.scroll || 0;
    this.setMutationDisabled();
  }

  private renderBody(): void {
    const body = this.body, route = this.route, state = this.state;
    if (!body) return;
    const scroll = body.scrollTop; body.empty();
    this.folderSelections.clear();
    const query = state?.query.trim().toLocaleLowerCase() || '';
    if (route?.kind === 'log') {
      body.setAttr('role', 'list'); body.setAttr('aria-label', 'Repository changes');
      if (this.pendingCount) {
        const row = body.createDiv({ cls: 'lgd-repository-history-row', attr: { role: 'listitem' } });
        const pending = row.createEl('button', { cls: 'lgd-repository-change', attr: { type: 'button', 'data-sync': 'pending' } });
        pending.createDiv({ cls: 'lgd-history-subject', text: 'Uncommitted changes' });
        pending.createDiv({ cls: 'lgd-history-meta', text: `${this.pendingCount} pending ${this.pendingCount === 1 ? 'file' : 'files'} · Open VCS Pending Changes` });
        pending.onclick = () => this.navigate({ kind: 'changes', context: route.context });
      }
      const synced = new Set(this.syncState.synced);
      const changes = this.changes.filter(change => [change.subject, change.sha, change.changeId || '', change.author, change.date].some(value => value.toLocaleLowerCase().includes(query)));
      for (const change of changes) {
        const row = body.createDiv({ cls: 'lgd-repository-history-row', attr: { role: 'listitem' } });
        const remote = this.syncState.remote;
        const sync = synced.has(change.sha) ? 'synced' : 'unsynced';
        const description = this.syncState.warning || (sync === 'synced' ? `Synced with ${remote}` : `Not synced with ${remote}`);
        const button = row.createEl('button', { cls: 'lgd-repository-change', attr: { type: 'button', 'data-sync': sync, title: description, 'aria-label': `${change.subject || '(no description)'} · ${description}` } });
        button.createDiv({ cls: 'lgd-history-subject', text: change.subject || '(no description)' });
        button.createDiv({ cls: 'lgd-history-meta', text: `${(change.changeId || change.shortSha).slice(0, 10)} · ${change.author || 'Unknown author'}` });
        button.createDiv({ cls: 'lgd-history-date', text: displayDate(change.date), attr: { title: change.date } });
        button.onclick = () => this.navigate({ kind: 'details', context: route.context, sha: change.sha });
        row.oncontextmenu = event => {
          event.preventDefault();
          const menu = new Menu();
          menu.addItem(item => item.setTitle('Change details').setIcon('git-commit-horizontal').onClick(() => this.navigate({ kind: 'details', context: route.context, sha: change.sha })));
          if (this.host.syncRepository && this.syncState.remote && !this.syncState.warning && sync === 'unsynced')
            menu.addItem(item => item.setTitle('Sync up to here').setIcon('upload').setDisabled(this.loading || this.mutating)
              .onClick(() => this.remote('push', change.sha)));
          if (this.host.explainRepository) menu.addItem(item => item.setTitle('Explain').setIcon('sparkles')
            .onClick(() => this.run(() => this.host.explainRepository!(route.context, { sha: change.sha }))));
          menu.addItem(item => item.setTitle('Copy change ID').setIcon('copy').onClick(() => this.run(() => body.ownerDocument.defaultView!.navigator.clipboard.writeText(change.changeId || change.sha))));
          menu.showAtMouseEvent(event);
        };
      }
      if (!changes.length && !this.pendingCount) this.empty(this.loading ? 'Loading changes…' : query ? 'No loaded changes match.' : this.error ? '' : 'No changes.');
    } else if (route?.kind === 'details' && this.details) {
      body.removeAttribute('role'); body.removeAttribute('aria-label');
      const { change, files } = this.details;
      const info = body.createDiv({ cls: 'lgd-repository-details' });
      info.oncontextmenu = event => {
        if (!this.host.explainRepository) return;
        event.preventDefault(); const menu = new Menu();
        menu.addItem(item => item.setTitle('Explain').setIcon('sparkles').onClick(() => this.run(() => this.host.explainRepository!(route.context, { sha: route.sha }))));
        menu.showAtMouseEvent(event);
      };
      info.createDiv({ cls: 'lgd-history-subject', text: change.description || change.subject || '(no description)' });
      info.createDiv({ cls: 'lgd-history-meta', text: change.changeId || change.sha });
      info.createDiv({ cls: 'lgd-history-date', text: `${change.author || 'Unknown author'} · ${displayDate(change.date)}`, attr: { title: change.date } });
      if (change.parents?.length) {
        const parents = info.createDiv({ cls: 'lgd-repository-parents' });
        for (const sha of change.parents) {
          const parent = parents.createEl('button', { cls: 'lgd-repository-parent', text: sha.slice(0, 8), attr: { type: 'button', title: 'Parent change', 'aria-label': `Parent change ${sha.slice(0, 8)}` } });
          parent.onclick = () => this.navigate({ kind: 'details', context: route.context, sha });
        }
      }
      this.renderFiles(body, files, false, route);
      if (!files.length) this.empty('No changed files.');
    } else if (route?.kind === 'changes' && this.status) {
      body.removeAttribute('role'); body.removeAttribute('aria-label');
      const files = this.status.files.filter(file => [file.path, file.oldPath || ''].some(path => path.toLocaleLowerCase().includes(query)));
      this.renderFiles(body, files, true, route);
      if (!files.length) this.empty(query ? 'No files match.' : 'Working copy is clean.');
    } else this.empty(this.loading ? 'Loading…' : this.error ? '' : 'Repository');
    body.scrollTop = scroll;
  }
  private empty(text: string): void { if (text) this.body?.createDiv({ cls: 'lgd-history-empty', text }); }

  private renderFiles(container: HTMLElement, files: RepositoryFile[], selecting: boolean, route: RepositoryRoute): void {
    const root: FileTree = { folders: new Map(), files: [], path: '' };
    const flat = selecting && this.host.settings.pendingChangesView === 'list';
    for (const file of files) {
      let node = root;
      const parts = flat ? [] : file.path.split('/').slice(0, -1);
      for (const part of parts) {
        if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [], path: node.path ? `${node.path}/${part}` : part });
        node = node.folders.get(part)!;
      }
      node.files.push(file);
    }
    const tree = container.createDiv({ cls: flat ? 'lgd-repository-tree lgd-repository-list' : 'lgd-repository-tree', attr: { role: 'group', 'aria-label': selecting ? 'Pending files' : 'Affected files' } });
    const renderNode = (parent: HTMLElement, node: FileTree): void => {
      for (const [name, child] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
        const group = parent.createEl('details', { cls: 'lgd-repository-folder' });
        group.open = !this.state?.collapsed.has(child.path);
        group.ontoggle = () => { if (group.open) this.state?.collapsed.delete(child.path); else this.state?.collapsed.add(child.path); };
        const summary = group.createEl('summary');
        const descendants = (selecting ? this.status?.files || [] : files).filter(file => file.path.startsWith(child.path + '/'));
        if (selecting) {
          const all = descendants.length > 0 && descendants.every(file => this.state?.selected.has(file.path));
          const some = descendants.some(file => this.state?.selected.has(file.path));
          const checkbox = summary.createEl('input', { type: 'checkbox', attr: { 'aria-label': `Include folder ${child.path}`, title: 'Include all files in this folder, including filtered files' } });
          checkbox.checked = all; checkbox.indeterminate = some && !all; checkbox.disabled = this.mutating;
          this.folderSelections.set(checkbox, descendants);
          checkbox.onclick = event => {
            event.preventDefault(); event.stopPropagation();
            if (this.mutating || this.route !== route) return;
            const all = descendants.every(file => this.state?.selected.has(file.path));
            for (const file of descendants) { if (all) this.state?.selected.delete(file.path); else this.state?.selected.add(file.path); }
            this.renderBody(); this.updateSelection();
          };
        }
        const icon = summary.createSpan({ cls: 'lgd-repository-folder-icon' }); setIcon(icon, 'folder');
        summary.createSpan({ text: name });
        summary.oncontextmenu = event => {
          event.preventDefault(); event.stopPropagation(); const menu = new Menu();
          menu.addItem(item => item.setTitle('VCS History').setIcon(REPOSITORY_HISTORY_ICON).onClick(() => this.navigate({ kind: 'log', context: route.context, path: child.path })));
          if (this.host.explainRepository) menu.addItem(item => item.setTitle('Explain').setIcon('sparkles').onClick(() => this.run(() => this.host.explainRepository!(route.context,
            { sha: route.kind === 'details' ? route.sha : undefined, paths: descendants.map(file => file.path), token: selecting ? this.status?.token : undefined }))));
          if (selecting) {
            menu.addSeparator();
            const all = descendants.every(file => this.state?.selected.has(file.path));
            menu.addItem(item => item.setTitle(all ? 'Deselect folder' : 'Select folder').setIcon(all ? 'square' : 'square-check').onClick(() => {
              if (this.mutating || this.route !== route) return;
              for (const file of descendants) { if (all) this.state?.selected.delete(file.path); else this.state?.selected.add(file.path); }
              this.renderBody(); this.updateSelection();
            }));
          }
          menu.showAtMouseEvent(event);
        };
        renderNode(group.createDiv({ cls: 'lgd-repository-folder-content' }), child);
      }
      for (const file of [...node.files].sort((a, b) => flat ? a.path.split('/').pop()!.localeCompare(b.path.split('/').pop()!) || a.path.localeCompare(b.path) : a.path.localeCompare(b.path))) {
        const row = parent.createDiv({ cls: 'lgd-repository-file', attr: { title: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path } });
        if (selecting) {
          const checkbox = row.createEl('input', { type: 'checkbox', attr: { 'aria-label': `Include ${file.path}` } });
          checkbox.checked = !!this.state?.selected.has(file.path); checkbox.disabled = this.mutating;
          checkbox.onchange = () => { if (checkbox.checked) this.state?.selected.add(file.path); else this.state?.selected.delete(file.path); this.updateSelection(); };
        }
        const name = row.createEl('button', { cls: 'lgd-repository-filename', attr: { type: 'button', title: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path } });
        name.createSpan({ cls: 'lgd-repository-filename-text', text: file.path.split('/').pop() });
        const folderPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
        if (selecting && folderPath) name.createSpan({ cls: 'lgd-repository-file-path', text: folderPath });
        const revision = route.kind === 'details' ? route.sha : undefined;
        name.onclick = () => { if (!this.mutating) void this.run(() => this.host.openRepositoryFile(route.context, file.path, revision)); };
        row.createSpan({ cls: 'lgd-repository-status', text: file.status[0] === '?' ? 'A' : file.status[0], attr: { title: statusName(file.status), 'aria-label': statusName(file.status), 'data-status': file.status[0] } });
        if (file.oldPath && !selecting) row.createDiv({ cls: 'lgd-repository-old-path', text: file.oldPath });
        row.oncontextmenu = event => {
          event.preventDefault(); event.stopPropagation(); const menu = new Menu();
          menu.addItem(item => item.setTitle('VCS History').setIcon(FILE_HISTORY_ICON).onClick(() => this.run(() => this.host.openRepositoryFile(route.context, file.path, revision))));
          if (this.host.explainRepository) menu.addItem(item => item.setTitle('Explain').setIcon('sparkles').onClick(() => this.run(() => this.host.explainRepository!(route.context,
            { sha: revision, paths: [file.path], token: selecting ? this.status?.token : undefined }))));
          const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : undefined;
          menu.addItem(item => item.setTitle('Folder history').setIcon('folder-clock').onClick(() => this.navigate({ kind: 'log', context: route.context, path: folder })));
          if (this.host.openRepositoryNote && !file.status.startsWith('D')) menu.addItem(item => item.setTitle('Open file').setIcon('file').onClick(() => this.run(() => this.host.openRepositoryNote!(route.context, file.path))));
          menu.addSeparator();
          menu.addItem(item => item.setTitle('Copy path').setIcon('copy').onClick(() => this.run(() => container.ownerDocument.defaultView!.navigator.clipboard.writeText(file.path))));
          menu.showAtMouseEvent(event);
        };
      }
    };
    renderNode(tree, root);
  }

  private renderComposer(root: HTMLElement, state: VisitState): void {
    const composer = root.createDiv({ cls: 'lgd-repository-composer' });
    const selection = composer.createDiv({ cls: 'lgd-repository-selection' });
    const all = selection.createEl('input', { type: 'checkbox', attr: { 'aria-label': 'Select all files' } });
    all.onchange = () => {
      if (this.mutating) return;
      if (all.checked) for (const file of this.status?.files || []) state.selected.add(file.path);
      else state.selected.clear();
      this.renderBody(); this.updateSelection();
    };
    this.selectionLabel = selection.createSpan();
    selection.oncontextmenu = event => {
      if (!this.host.explainRepository || !this.route || !state.selected.size) return;
      event.preventDefault(); const menu = new Menu(), context = this.route.context, paths = [...state.selected], token = this.status?.token;
      menu.addItem(item => item.setTitle('Explain selected changes').setIcon('sparkles').onClick(() => this.run(() => this.host.explainRepository!(context, { paths, token }))));
      menu.showAtMouseEvent(event);
    };
    if (this.host.generateDescription) {
      this.aiButton = this.actionButton(selection, 'sparkles', 'Generate description', () => { if (this.aiJob) this.aiJob.abort(); else void this.generateDescription(); });
    }
    const description = composer.createEl('textarea', { cls: 'lgd-repository-description', placeholder: 'Description', attr: { 'aria-label': 'Change description', rows: '3' } });
    description.value = state.description;
    description.oninput = () => { state.description = description.value; this.updateSelection(); };
    this.createButton = composer.createEl('button', { cls: 'mod-cta', text: 'Create change', attr: { type: 'button', title: 'Create change (Ctrl/Cmd+Enter)' } });
    this.createButton.onclick = () => { void this.submit(); };
    this.updateSelection();
  }
  private updateSelection(): void {
    const count = this.state?.selected.size || 0, total = this.status?.files.length || 0;
    this.selectionLabel?.setText(`${count} / ${total} files`);
    const all = this.contentEl.querySelector<HTMLInputElement>('.lgd-repository-selection input');
    if (all) { all.checked = total > 0 && count === total; all.indeterminate = count > 0 && count < total; all.disabled = this.mutating || this.loading || !total; }
    for (const [checkbox, files] of this.folderSelections) {
      const selected = files.filter(file => this.state?.selected.has(file.path)).length;
      checkbox.checked = files.length > 0 && selected === files.length;
      checkbox.indeterminate = selected > 0 && selected < files.length;
      checkbox.disabled = this.mutating || this.loading;
    }
    if (this.createButton) this.createButton.disabled = this.mutating || this.loading || !this.status || !count || !this.state?.description.trim();
    if (this.aiButton) this.aiButton.disabled = !this.aiJob && (this.mutating || this.loading || !count);
  }
  private updateFooter(): void {
    const route = this.route;
    const remoteStatus = this.remoteAction === 'push' ? 'Pushing…' : this.remoteAction === 'pull' ? 'Pulling…' : '';
    const text = this.error || (remoteStatus || (this.aiJob ? 'Generating description…' : this.mutating ? 'Saving…' : this.loading ? 'Loading…' : route?.kind === 'log' ? `${this.changes.length} commits · ${this.syncState.warning || this.syncState.remote || 'No upstream'}` : route?.kind === 'details' && this.details ? `${this.details.files.length} files` : ''));
    this.footer?.setText(this.error ? `Error: ${this.error}` : text); this.footer?.toggleClass('lgd-error', !!this.error); this.footer?.toggle(!!text);
    if (this.error && this.footer) {
      this.footer.setAttr('role', 'alert');
      const copy = this.footer.createEl('button', { cls: 'lgd-repository-error-copy', text: 'Copy error', attr: { type: 'button' } });
      const detail = this.error;
      copy.onclick = () => { void this.contentEl.ownerDocument.defaultView!.navigator.clipboard.writeText(detail).catch(() => new Notice('Unable to copy the error. Select and copy its text.')); };
    } else this.footer?.setAttr('role', 'status');
    this.body?.setAttr('aria-busy', String(this.loading || this.mutating));
    if (this.more) this.more.disabled = this.loading || this.mutating;
    this.updateSelection();
  }
  private setMutationDisabled(): void {
    if (this.mutating) for (const input of Array.from(this.contentEl.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('button,input,textarea,select'))) input.disabled = true;
    this.updateNavigation(); this.updateFooter();
    if (this.aiJob && this.aiButton) this.aiButton.disabled = false;
  }
  private async generateDescription(): Promise<void> {
    const route = this.route, state = this.state, status = this.status;
    if (this.mutating || this.loading || !route || !state?.selected.size || !status || !this.host.generateDescription) return;
    const job = this.aiJob = new AbortController();
    this.mutating = true; this.error = '';
    if (this.aiButton) { setIcon(this.aiButton, 'x'); this.aiButton.setAttr('title', 'Cancel generation'); this.aiButton.setAttr('aria-label', 'Cancel generation'); }
    this.setMutationDisabled();
    try {
      const description = await this.host.generateDescription(route.context, [...state.selected], status.token, job.signal);
      if (!job.signal.aborted && !this.closed && this.route === route) state.description = description;
    } catch (error) { if (!job.signal.aborted && this.route === route) this.error = errorMessage(error); }
    finally {
      if (this.aiJob === job) { this.aiJob = null; this.mutating = false; if (!this.closed) this.render(); }
    }
  }
  private async submit(): Promise<void> {
    const route = this.route, state = this.state, status = this.status;
    if (this.closed || this.mutating || this.loading || route?.kind !== 'changes' || !state?.selected.size || !state.description.trim() || !status) return;
    this.rememberScroll(); this.mutating = true; this.error = ''; this.setMutationDisabled();
    const paths = [...state.selected], description = state.description;
    let saved = false;
    try {
      await createChange(route.context, paths, description, status.token);
      saved = true; state.description = ''; state.selected.clear();
      await this.host.repositoryChanged(route.context);
      if (!this.closed) new Notice('Change created.');
    } catch (error) {
      if (!this.closed && this.route === route) this.error = saved ? `Change created. Refresh failed: ${errorMessage(error)}` : errorMessage(error);
    } finally {
      this.mutating = false;
      if (!this.closed) {
        if (this.route === route && saved && !this.error) await this.loadRoute(false);
        else this.render();
      }
    }
  }
  private async snapshot(): Promise<void> {
    const route = this.route;
    if (this.closed || this.mutating || this.loading || route?.context.backend !== 'jj') return;
    this.rememberScroll(); this.mutating = true; this.error = ''; this.setMutationDisabled();
    try {
      await snapshotWorkspace(route.context); await this.host.repositoryChanged(route.context);
      if (!this.closed) new Notice('Snapshot saved.');
    } catch (error) { if (!this.closed && this.route === route) this.error = errorMessage(error); }
    finally {
      this.mutating = false;
      if (!this.closed) { if (this.route === route && !this.error) await this.loadRoute(false); else this.render(); }
    }
  }
  private remoteMenu(event: MouseEvent): void {
    if (!this.route || !this.host.syncRepository) return;
    event.preventDefault(); event.stopPropagation();
    const menu = new Menu(), disabled = this.loading || this.mutating;
    menu.addItem(item => item.setTitle('Pull').setIcon('download').setDisabled(disabled).onClick(() => this.remote('pull')));
    menu.addItem(item => item.setTitle('Push').setIcon('upload').setDisabled(disabled).onClick(() => this.remote('push')));
    menu.showAtMouseEvent(event);
  }
  private async remote(action: 'push' | 'pull', revision?: string): Promise<void> {
    const route = this.route;
    if (this.closed || this.loading || this.mutating || !route) return;
    if (!this.host.syncRepository) return;
    this.rememberScroll(); this.mutating = true; this.remoteAction = action; this.error = ''; this.setMutationDisabled();
    try {
      await this.host.syncRepository(route.context, action, revision);
    } catch (error) {
      if (!this.closed && this.route === route) this.error = errorMessage(error);
    } finally {
      this.mutating = false; this.remoteAction = null;
      if (!this.closed) {
        if (this.route === route) {
          const operationError = this.error;
          await this.loadRoute(false);
          if (operationError && this.route === route) { this.error = operationError; this.updateFooter(); }
        }
        else this.render();
      }
    }
  }
  private moveFocus(event: KeyboardEvent): void {
    if (event.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const controls = Array.from(this.body?.querySelectorAll<HTMLElement>('button,input,summary') || []).filter(element => !element.closest('details:not([open]) .lgd-repository-folder-content'));
    const index = controls.indexOf(event.target as HTMLElement);
    const destination = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : event.key === 'ArrowDown' ? Math.min(controls.length - 1, index + 1) : Math.max(0, index - 1);
    if (controls[destination]) { event.preventDefault(); controls[destination].focus(); }
  }
}
