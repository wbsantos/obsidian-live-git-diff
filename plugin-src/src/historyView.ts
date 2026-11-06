import { ItemView, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import { resolveGitAsync } from './git.ts';
import type { CommitInfo } from './git.ts';
import { HistoryCache, HistoryController, historyStatus } from './history.ts';
import type { HistoryState } from './history.ts';

export const HISTORY_VIEW_TYPE = 'live-git-diff-history';
export interface HistoryViewHost {
  historyCache: HistoryCache;
  settings: { logLimit: number };
  compareHistory(filePath: string, commits: CommitInfo[]): void | Promise<void>;
  historyViewClosed?(): void;
}

/** A native sidebar. Git results are accepted by its controller, never by DOM callbacks. */
export class GitHistoryView extends ItemView {
  readonly controller: HistoryController;
  private host: HistoryViewHost;
  private fileTitleEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private footerEl: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;
  private refreshEl: HTMLButtonElement | null = null;
  private moreEl: HTMLButtonElement | null = null;
  private queryEl: HTMLInputElement | null = null;
  private renderedFile: string | null = null;
  private rows = new Map<string, HTMLButtonElement>();
  constructor(leaf: WorkspaceLeaf, host: HistoryViewHost) {
    super(leaf); this.host = host;
    this.controller = new HistoryController(host.historyCache, (file, signal) => {
      const current = this.app.vault.getAbstractFileByPath(file.path);
      if (!(current instanceof TFile)) return Promise.reject(new Error('The note is no longer available.'));
      return resolveGitAsync(this.app, current, signal);
    }, () => host.settings.logLimit, state => this.renderState(state), (path, selected) => {
      const epochFile = this.controller.state.file;
      void Promise.resolve(host.compareHistory(path, selected)).catch(error => {
        if (this.controller.state.file !== epochFile || !this.hintEl) return;
        this.hintEl.setText('Unable to open comparison'); this.hintEl.setAttr('title', String((error as Error).message || error));
      });
    });
  }
  getViewType(): string { return HISTORY_VIEW_TYPE; }
  getDisplayText(): string { return 'Git history'; }
  getIcon(): string { return 'history'; }
  async onOpen(): Promise<void> {
    const root = this.contentEl; root.empty(); root.addClass('lgd-history');
    const heading = root.createDiv({ cls: 'lgd-history-heading' });
    this.fileTitleEl = heading.createDiv({ cls: 'lgd-history-file', text: 'Git history' });
    this.refreshEl = heading.createEl('button', { cls: 'clickable-icon lgd-history-refresh', attr: { type: 'button', 'aria-label': 'Refresh history', title: 'Refresh history' } });
    setIcon(this.refreshEl, 'refresh-cw'); this.refreshEl.onclick = () => { void this.controller.refresh(); };
    this.queryEl = root.createEl('input', { cls: 'lgd-history-filter', type: 'search', placeholder: 'Filter loaded commits', attr: { 'aria-label': 'Filter loaded commits' } });
    this.queryEl.oninput = () => this.renderState(this.controller.state);
    root.createDiv({ cls: 'lgd-history-help', text: 'Click a version to compare with the current note. Ctrl/Cmd+click selects two versions.' });
    this.hintEl = root.createDiv({ cls: 'lgd-history-hint', attr: { role: 'status', 'aria-live': 'polite' } });
    this.listEl = root.createDiv({ cls: 'lgd-history-list', attr: { role: 'listbox', 'aria-label': 'File versions', 'aria-multiselectable': 'true' } });
    this.listEl.addEventListener('keydown', event => this.keydown(event));
    this.moreEl = root.createEl('button', { cls: 'lgd-history-more', text: 'Load more', attr: { type: 'button' } });
    this.moreEl.onclick = () => { void this.controller.refresh(true); };
    this.footerEl = root.createDiv({ cls: 'lgd-history-footer', attr: { role: 'status', 'aria-live': 'polite' } });
    this.renderState(this.controller.state);
  }
  async onClose(): Promise<void> { this.controller.dispose(); this.host.historyViewClosed?.(); }
  async setFile(file: TFile | null): Promise<void> { await this.controller.setFile(file ? { path: file.path, name: file.name } : null); }
  clearSelection(filePath?: string): void { this.controller.clearSelection(filePath); }

  private keydown(event: KeyboardEvent): void {
    const buttons = Array.from(this.listEl?.querySelectorAll<HTMLButtonElement>('button[data-commit]') || []);
    const target = event.target as HTMLElement, index = buttons.indexOf(target.closest('button') as HTMLButtonElement);
    if ((event.key === 'Enter' || event.key === ' ') && index >= 0) {
      event.preventDefault(); event.stopPropagation();
      this.controller.select(buttons[index].dataset.commit!, event.ctrlKey || event.metaKey); return;
    }
    const destination = event.key === 'ArrowDown' ? Math.min(buttons.length - 1, index + 1) :
      event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
    if (destination !== null && buttons[destination]) { event.preventDefault(); event.stopPropagation(); buttons[destination].focus(); }
  }

  private renderState(state: HistoryState): void {
    const list = this.listEl;
    if (!list || !this.footerEl || !this.fileTitleEl) return;
    const changedFile = this.renderedFile !== (state.file?.path || null);
    if (changedFile) {
      this.renderedFile = state.file?.path || null; this.rows.clear(); list.empty(); list.scrollTop = 0;
      if (this.queryEl) this.queryEl.value = '';
    }
    this.fileTitleEl.setText(state.file?.name || 'Git history'); this.fileTitleEl.setAttr('title', state.file?.path || 'Git history');
    if (this.refreshEl) this.refreshEl.disabled = !state.file || state.loading;
    if (this.queryEl) this.queryEl.disabled = !state.file;
    this.footerEl.setText(historyStatus(state)); this.footerEl.setAttr('title', state.error || '');
    this.footerEl.toggleClass('lgd-error', !!state.error); list.setAttr('aria-busy', String(state.loading));
    this.hintEl?.setText(state.hint || (state.selected.length === 2 ? 'Comparing two historical versions' : state.selected.length === 1 ? 'Comparing with the current note' : ''));
    if (this.moreEl) { this.moreEl.hidden = !state.entry?.hasMore; this.moreEl.disabled = state.loading; }

    const query = (this.queryEl?.value || '').trim().toLowerCase();
    const visible = [...(state.entry?.commits || [])];
    for (const commit of state.selected) if (!visible.some(item => item.sha === commit.sha)) visible.push(commit);
    const commits = visible.filter(commit => [commit.sha, commit.subject, commit.author || '', commit.relative, commit.date].some(value => value.toLowerCase().includes(query)));
    const top = list.getBoundingClientRect().top;
    const anchor = [...this.rows.values()].find(row => row.parentElement === list && row.getBoundingClientRect().bottom > top);
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
    const scroll = list.scrollTop;
    const focused = list.ownerDocument.activeElement as HTMLElement | null;
    const focusSha = focused?.closest<HTMLButtonElement>('button[data-commit]')?.dataset.commit;
    const active = new Set(commits.map(commit => commit.sha));
    for (const [sha, row] of this.rows) if (!active.has(sha)) row.remove();
    for (const empty of Array.from(list.querySelectorAll('.lgd-history-empty'))) empty.remove();
    for (const commit of commits) {
      let row = this.rows.get(commit.sha);
      if (!row) {
        row = list.ownerDocument.createElement('button'); row.type = 'button'; row.className = 'lgd-history-commit';
        row.dataset.commit = commit.sha; row.setAttr('role', 'option');
        row.onclick = event => this.controller.select(commit.sha, event.ctrlKey || event.metaKey);
        row.createDiv({ cls: 'lgd-history-subject', text: commit.subject });
        row.createDiv({ cls: 'lgd-history-meta', text: `${commit.shortSha} · ${commit.author || 'Unknown author'}` });
        row.createDiv({ cls: 'lgd-history-date', text: `${commit.date} · ${commit.relative}` });
        this.rows.set(commit.sha, row);
      }
      const selected = state.selected.some(item => item.sha === commit.sha);
      row.setAttr('aria-selected', String(selected)); row.toggleClass('is-selected', selected);
      row.setAttr('title', `${commit.subject}\n${commit.sha}\n${commit.path}`);
      const renamed = state.entry && commit.path !== state.entry.context.rel;
      let rename = row.querySelector<HTMLElement>('.lgd-history-renamed');
      if (renamed) {
        if (!rename) rename = row.createDiv({ cls: 'lgd-history-renamed' });
        rename.setText(`Previous path: ${commit.path}`);
      } else rename?.remove();
      list.appendChild(row);
    }
    if (!commits.length) list.createDiv({ cls: 'lgd-history-empty', text: !state.file ? 'Open a Markdown note to view its history.' :
      state.loading && !state.entry ? 'Loading versions…' : query ? 'No loaded versions match.' : state.error && !state.entry ? 'Git history is unavailable.' : 'This file has no committed versions.' });
    if (anchor?.parentElement === list) list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    else list.scrollTop = scroll;
    if (focusSha && this.rows.get(focusSha)?.parentElement === list) this.rows.get(focusSha)?.focus({ preventScroll: true });
  }
}
