import { ItemView, Scope, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import { resolveGitAsync } from './git.ts';
import type { CommitInfo } from './git.ts';
import { HistoryCache, HistoryController, historyStatus } from './history.ts';
import type { HistoryState } from './history.ts';

export const HISTORY_VIEW_TYPE = 'live-git-diff-history';
export interface HistoryReviewState {
  openingFile: string | null;
  active: { filePath: string; left: string; right: string } | null;
  error: string | null;
}
export interface HistoryViewHost {
  historyCache: HistoryCache;
  settings: { logLimit: number };
  compareHistory(filePath: string, commits: readonly CommitInfo[]): void | Promise<void>;
  historyReviewState(): HistoryReviewState;
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
  private selectionEl: HTMLElement | null = null;
  private compareEl: HTMLButtonElement | null = null;
  private clearEl: HTMLButtonElement | null = null;
  private activeReviewEl: HTMLElement | null = null;
  private renderedFile: string | null = null;
  private rows = new Map<string, HTMLButtonElement>();
  constructor(leaf: WorkspaceLeaf, host: HistoryViewHost) {
    super(leaf); this.host = host;
    this.controller = new HistoryController(host.historyCache, (file, signal) => {
      const current = this.app.vault.getAbstractFileByPath(file.path);
      if (!(current instanceof TFile)) return Promise.reject(new Error('The note is no longer available.'));
      return resolveGitAsync(this.app, current, signal);
    }, () => host.settings.logLimit, state => this.renderState(state));
    this.scope = new Scope(this.app.scope);
    this.scope.register(['Mod'], 'Enter', event => {
      if (!this.contentEl.contains(this.contentEl.ownerDocument.activeElement) || event.isComposing) return;
      if (!event.repeat) void this.applySelection();
      return false;
    });
  }
  getViewType(): string { return HISTORY_VIEW_TYPE; }
  getDisplayText(): string { return 'Git History'; }
  getIcon(): string { return 'history'; }
  async onOpen(): Promise<void> {
    const root = this.contentEl; root.empty(); root.addClass('lgd-history');
    const heading = root.createDiv({ cls: 'lgd-history-heading' });
    this.fileTitleEl = heading.createDiv({ cls: 'lgd-history-file', text: 'Git History' });
    this.refreshEl = heading.createEl('button', { cls: 'clickable-icon lgd-history-refresh', attr: { type: 'button', 'aria-label': 'Refresh history', title: 'Refresh history' } });
    setIcon(this.refreshEl, 'refresh-cw'); this.refreshEl.onclick = () => { void this.controller.refresh(); };
    this.queryEl = root.createEl('input', { cls: 'lgd-history-filter', type: 'search', placeholder: 'Filter loaded commits', attr: { 'aria-label': 'Filter loaded commits' } });
    this.queryEl.oninput = () => this.renderState(this.controller.state);
    root.createDiv({ cls: 'lgd-history-help', text: 'Click to select one version. Ctrl/Cmd+click selects two. Then choose Compare.' });
    this.hintEl = root.createDiv({ cls: 'lgd-history-hint', attr: { role: 'status', 'aria-live': 'polite' } });
    this.listEl = root.createDiv({ cls: 'lgd-history-list', attr: { role: 'listbox', 'aria-label': 'File versions', 'aria-multiselectable': 'true' } });
    this.listEl.addEventListener('keydown', event => this.keydown(event));
    this.moreEl = root.createEl('button', { cls: 'lgd-history-more', text: 'Load more', attr: { type: 'button' } });
    this.moreEl.onclick = () => { void this.controller.refresh(true); };
    const actions = root.createDiv({ cls: 'lgd-history-actions' });
    this.selectionEl = actions.createDiv({ cls: 'lgd-history-selection', attr: { 'aria-live': 'polite' } });
    this.compareEl = actions.createEl('button', { cls: 'mod-cta lgd-history-compare', text: 'Compare', attr: { type: 'button', title: 'Compare selected versions (Ctrl/Cmd+Enter)' } });
    this.compareEl.onclick = () => { void this.applySelection(); };
    this.clearEl = actions.createEl('button', { cls: 'lgd-history-clear', text: 'Clear selection', attr: { type: 'button' } });
    this.clearEl.onclick = () => this.controller.clearSelection();
    this.activeReviewEl = actions.createDiv({ cls: 'lgd-history-active', attr: { role: 'status', 'aria-live': 'polite' } });
    this.footerEl = root.createDiv({ cls: 'lgd-history-footer', attr: { role: 'status', 'aria-live': 'polite' } });
    this.renderState(this.controller.state);
  }
  async onClose(): Promise<void> { this.controller.dispose(); this.host.historyViewClosed?.(); }
  async setFile(file: TFile | null): Promise<void> { await this.controller.setFile(file ? { path: file.path, name: file.name } : null); }
  clearSelection(filePath?: string): void { this.controller.clearSelection(filePath); }

  private async applySelection(): Promise<void> {
    if (this.host.historyReviewState().openingFile) return;
    const request = this.controller.comparisonRequest(); if (!request) return;
    const file = this.controller.state.file;
    try { await this.host.compareHistory(request.filePath, request.commits); }
    catch (error) {
      if (this.controller.state.file === file && this.hintEl) this.hintEl.setText(`Unable to open comparison: ${(error as Error).message || error}`);
    }
    this.updateComparisonState();
  }

  updateComparisonState(): void {
    const { selected, unavailable } = this.controller.state, review = this.host.historyReviewState();
    const count = selected.length;
    this.selectionEl?.setText(count ? `Selected: ${selected.map(commit => commit.shortSha).join(' → ')}${count === 1 ? ' → Working tree' : ''}` : 'Select one or two versions.');
    if (this.compareEl) {
      this.compareEl.setText(review.openingFile ? 'Opening comparison…' : count === 1 ? 'Compare with Working Tree' : count === 2 ? 'Compare Selected Versions' : 'Compare');
      this.compareEl.disabled = !!review.openingFile || unavailable || count === 0;
    }
    if (this.clearEl) this.clearEl.disabled = count === 0;
    const active = review.active;
    this.activeReviewEl?.setText(review.openingFile ? `Opening: ${review.openingFile}` : review.error ? `Comparison failed: ${review.error}` :
      active ? `Comparing: ${active.filePath}\n${active.left} ↔ ${active.right}` : 'No comparison open.');
    this.activeReviewEl?.toggleClass('lgd-error', !!review.error);
  }

  private keydown(event: KeyboardEvent): void {
    if (event.isComposing || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) return;
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
    this.fileTitleEl.setText(state.file?.name || 'Git History'); this.fileTitleEl.setAttr('title', state.file?.path || 'Git History');
    if (this.refreshEl) this.refreshEl.disabled = !state.file || state.loading || state.unavailable;
    if (this.queryEl) this.queryEl.disabled = !state.file;
    this.footerEl.setText(historyStatus(state)); this.footerEl.setAttr('title', state.error || '');
    this.footerEl.toggleClass('lgd-error', !!state.error); list.setAttr('aria-busy', String(state.loading));
    this.hintEl?.setText(state.unavailable ? state.error || '' : state.hint || '');
    this.updateComparisonState();
    if (this.moreEl) { this.moreEl.hidden = !state.entry?.hasMore || state.unavailable; this.moreEl.disabled = state.loading; }

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
      row.disabled = state.unavailable;
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
    if (!commits.length) list.createDiv({ cls: 'lgd-history-empty', text: !state.file ? 'Choose Git History on a Markdown file to view its versions.' :
      state.loading && !state.entry ? 'Loading versions…' : query ? 'No loaded versions match.' : state.error && !state.entry ? 'Git history is unavailable.' : 'This file has no committed versions.' });
    if (anchor?.parentElement === list) list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    else list.scrollTop = scroll;
    if (focusSha && this.rows.get(focusSha)?.parentElement === list) this.rows.get(focusSha)?.focus({ preventScroll: true });
  }
}
