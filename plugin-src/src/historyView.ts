import { ItemView, Menu, Scope, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
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
  historyActiveFile(): TFile | null;
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
  private headingEl: HTMLElement | null = null;
  private followEl: HTMLButtonElement | null = null;
  private contextEl: HTMLElement | null = null;
  private connectorEl: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private applying = false;
  private closed = false;
  private activeReviewEl: HTMLElement | null = null;
  private renderedFile: string | null = null;
  private rows = new Map<string, HTMLElement>();
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
    this.headingEl = heading;
    this.contextEl = heading.createSpan({ cls: 'lgd-history-context', attr: { role: 'status', 'aria-live': 'polite' } });
    this.fileTitleEl = heading.createDiv({ cls: 'lgd-history-file', text: 'Git History' });
    this.refreshEl = heading.createEl('button', { cls: 'clickable-icon lgd-history-refresh', attr: { type: 'button', 'aria-label': 'Refresh history', title: 'Refresh history' } });
    setIcon(this.refreshEl, 'refresh-cw'); this.refreshEl.onclick = () => { void this.controller.refresh(); };
    this.followEl = heading.createEl('button', { cls: 'clickable-icon lgd-history-follow', attr: { type: 'button', 'aria-label': 'Show history for active note', title: 'Show history for active note' } });
    setIcon(this.followEl, 'locate-fixed');
    this.followEl.onclick = () => { const file = this.host.historyActiveFile(); if (file) void this.setFile(file); };
    this.queryEl = root.createEl('input', { cls: 'lgd-history-filter', type: 'search', placeholder: 'Filter loaded commits', attr: { 'aria-label': 'Filter loaded commits' } });
    this.queryEl.oninput = () => this.renderState(this.controller.state);
    this.hintEl = root.createDiv({ cls: 'lgd-history-hint', attr: { role: 'status', 'aria-live': 'polite' } });
    this.listEl = root.createDiv({ cls: 'lgd-history-list', attr: { role: 'listbox', 'aria-label': 'File versions', 'aria-multiselectable': 'true' } });
    this.listEl.addEventListener('keydown', event => this.keydown(event));
    this.connectorEl = this.listEl.createDiv({ cls: 'lgd-history-connector', attr: { 'aria-hidden': 'true' } });
    this.connectorEl.hidden = true;
    const Resize = this.contentEl.ownerDocument.defaultView?.ResizeObserver;
    if (Resize) {
      this.resizeObserver = new Resize(() => this.updateConnector());
      this.resizeObserver.observe(this.listEl);
    }
    this.moreEl = root.createEl('button', { cls: 'lgd-history-more', text: 'Load more', attr: { type: 'button' } });
    this.moreEl.onclick = () => { void this.controller.refresh(true); };
    const actions = root.createDiv({ cls: 'lgd-history-actions' });
    this.selectionEl = actions.createDiv({ cls: 'lgd-history-selection', attr: { 'aria-live': 'polite' } });
    this.activeReviewEl = actions.createDiv({ cls: 'lgd-history-active', attr: { role: 'status', 'aria-live': 'polite' } });
    this.footerEl = root.createDiv({ cls: 'lgd-history-footer', attr: { role: 'status', 'aria-live': 'polite' } });
    this.renderState(this.controller.state);
  }
  async onClose(): Promise<void> { this.closed = true; this.resizeObserver?.disconnect(); this.controller.dispose(); this.host.historyViewClosed?.(); }
  async setFile(file: TFile | null): Promise<void> { await this.controller.setFile(file ? { path: file.path, name: file.name } : null); }
  clearSelection(filePath?: string): void { this.controller.clearSelection(filePath); }

  private async applySelection(): Promise<void> {
    if (this.closed || this.applying || this.host.historyReviewState().openingFile) return;
    const request = this.controller.comparisonRequest(); if (!request) return;
    const file = this.controller.state.file;
    this.applying = true; this.updateComparisonState();
    try { await this.host.compareHistory(request.filePath, request.commits); }
    catch (error) {
      if (this.controller.state.file === file && this.hintEl) this.hintEl.setText(`Unable to open comparison: ${(error as Error).message || error}`);
    }
    finally { this.applying = false; if (!this.closed) this.updateComparisonState(); }
  }

  private compareCommits(shas: readonly string[]): void {
    if (this.closed || this.applying || this.host.historyReviewState().openingFile) return;
    if (this.controller.setSelection(shas)) void this.applySelection();
  }

  private contextMenu(event: MouseEvent, commit: CommitInfo): void {
    event.preventDefault(); event.stopPropagation();
    const { file, selected, unavailable } = this.controller.state;
    if (!file || unavailable || this.closed) return;
    // The file object identifies this visit, including A → B → A while a menu is open.
    const current = (): boolean => !this.closed && this.controller.state.file === file && !this.controller.state.unavailable;
    const menu = new Menu();
    menu.addItem(item => item.setTitle('Compare with worktree').setIcon('git-compare')
      .setDisabled(this.applying || !!this.host.historyReviewState().openingFile)
      .onClick(() => { if (current()) this.compareCommits([commit.sha]); }));
    for (const other of selected.filter(item => item.sha !== commit.sha)) {
      menu.addItem(item => item.setTitle(`Compare with Selected “${other.shortSha} · ${other.subject}”`).setIcon('git-compare')
        .setDisabled(this.applying || !!this.host.historyReviewState().openingFile)
        .onClick(() => { if (current()) this.compareCommits([commit.sha, other.sha]); }));
    }
    menu.addSeparator();
    menu.addItem(item => item.setTitle('Clear Selections').setIcon('list-x').setDisabled(!selected.length)
      .onClick(() => { if (current()) this.controller.clearSelection(); }));
    menu.showAtMouseEvent(event);
  }

  updateActiveFile(): void {
    const file = this.host.historyActiveFile(), history = this.controller.state.file;
    const status = file && history && !this.controller.state.unavailable ? (file.path === history.path ? 'match' : 'different') : 'neutral';
    const label = status === 'match' ? 'History matches the active note' : status === 'different' ? `History is for another note. Active note: ${file!.path}` : 'No active note to match with this history';
    this.headingEl?.setAttr('data-note-context', status);
    this.contextEl?.setAttr('aria-label', label); this.contextEl?.setAttr('title', label);
    if (this.followEl) this.followEl.hidden = !file || (file.path === history?.path && !this.controller.state.unavailable);
  }

  private updateConnector(): void {
    const line = this.connectorEl, list = this.listEl;
    if (!line || !list) return;
    const buttons = this.controller.state.selected.map(commit => this.rows.get(commit.sha))
      .filter(row => row?.parentElement === list).map(row => row!.querySelector<HTMLButtonElement>('.lgd-history-compare')!);
    line.hidden = buttons.length !== 2;
    if (line.hidden) return;
    const bounds = list.getBoundingClientRect(), rects = buttons.map(button => button.getBoundingClientRect()).sort((a, b) => a.top - b.top);
    line.style.top = `${rects[0].top + rects[0].height / 2 - bounds.top + list.scrollTop}px`;
    line.style.left = `${rects[0].left + rects[0].width / 2 - bounds.left + list.scrollLeft}px`;
    line.style.height = `${rects[1].top + rects[1].height / 2 - rects[0].top - rects[0].height / 2}px`;
  }

  updateComparisonState(): void {
    const { selected, unavailable } = this.controller.state, review = this.host.historyReviewState();
    const count = selected.length;
    this.selectionEl?.setText(count ? `Selected: ${selected.map(commit => commit.shortSha).join(' → ')}${count === 1 ? ' → Working tree' : ''}` : 'Select one or two versions.');
    for (const row of this.rows.values()) {
      const button = row.querySelector<HTMLButtonElement>('.lgd-history-compare');
      if (!button) continue;
      const label = review.openingFile || this.applying ? 'Opening comparison…' : count === 1 ? 'Compare with Working Tree (Ctrl/Cmd+Enter)' : 'Compare Selected Versions (Ctrl/Cmd+Enter)';
      button.setAttr('title', label); button.setAttr('aria-label', label);
      button.disabled = this.applying || !!review.openingFile || unavailable || count === 0;
    }
    const active = review.active;
    this.activeReviewEl?.setText(review.openingFile ? `Opening: ${review.openingFile}` : review.error ? `Comparison failed: ${review.error}` :
      active ? `Comparing: ${active.filePath}\n${active.left} ↔ ${active.right}` : 'No comparison open.');
    this.activeReviewEl?.toggleClass('lgd-error', !!review.error);
    this.updateActiveFile();
  }

  private keydown(event: KeyboardEvent): void {
    if (event.isComposing || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) return;
    const buttons = Array.from(this.listEl?.querySelectorAll<HTMLButtonElement>('button[data-commit]') || []);
    const target = event.target as HTMLElement, index = buttons.indexOf(target.closest('button') as HTMLButtonElement);
    if (target.closest('.lgd-history-compare')) return;
    if ((event.key === 'Enter' || event.key === ' ') && index >= 0) {
      event.preventDefault(); event.stopPropagation();
      this.controller.select(buttons[index].dataset.commit!); return;
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
      this.resizeObserver?.disconnect(); this.resizeObserver?.observe(list);
      this.renderedFile = state.file?.path || null; this.rows.clear(); list.empty();
      if (this.connectorEl) list.appendChild(this.connectorEl);
      list.scrollTop = 0;
      if (this.queryEl) this.queryEl.value = '';
    }
    this.fileTitleEl.setText(state.file?.name || 'Git History'); this.fileTitleEl.setAttr('title', state.file?.path || 'Git History');
    if (this.refreshEl) this.refreshEl.disabled = !state.file || state.loading || state.unavailable;
    if (this.queryEl) this.queryEl.disabled = !state.file;
    this.footerEl.setText(historyStatus(state)); this.footerEl.setAttr('title', state.error || '');
    this.footerEl.toggleClass('lgd-error', !!state.error); list.setAttr('aria-busy', String(state.loading));
    this.hintEl?.setText(state.unavailable ? state.error || '' : state.hint || '');
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
    const compareSha = focused?.closest<HTMLElement>('.lgd-history-row')?.dataset.commit;
    const active = new Set(commits.map(commit => commit.sha));
    for (const [sha, row] of this.rows) if (!active.has(sha)) row.remove();
    for (const empty of Array.from(list.querySelectorAll('.lgd-history-empty'))) empty.remove();
    for (const [index, commit] of commits.entries()) {
      let row = this.rows.get(commit.sha);
      if (!row) {
        row = list.ownerDocument.createElement('div'); row.className = 'lgd-history-row';
        row.dataset.commit = commit.sha; row.setAttr('role', 'none');
        const content = row.createEl('button', { cls: 'lgd-history-commit', attr: { type: 'button', role: 'option', 'data-commit': commit.sha } });
        content.onclick = event => { if (event.detail < 2) this.controller.select(commit.sha); };
        content.ondblclick = event => { event.preventDefault(); this.compareCommits([commit.sha]); };
        row.oncontextmenu = event => this.contextMenu(event, commit);
        content.createDiv({ cls: 'lgd-history-subject', text: commit.subject });
        content.createDiv({ cls: 'lgd-history-meta', text: `${commit.shortSha} · ${commit.author || 'Unknown author'}` });
        content.createDiv({ cls: 'lgd-history-date', text: `${commit.date} · ${commit.relative}` });
        const compare = row.createEl('button', { cls: 'clickable-icon lgd-history-compare', attr: { type: 'button' } });
        setIcon(compare, 'git-compare');
        compare.onclick = event => { event.stopPropagation(); void this.applySelection(); };
        compare.ondblclick = event => { event.preventDefault(); event.stopPropagation(); };
        this.rows.set(commit.sha, row);
        this.resizeObserver?.observe(row);
      }
      const selected = state.selected.some(item => item.sha === commit.sha);
      const content = row.querySelector<HTMLButtonElement>('.lgd-history-commit')!;
      content.disabled = state.unavailable;
      content.setAttr('aria-selected', String(selected)); row.toggleClass('is-selected', selected);
      row.querySelector<HTMLButtonElement>('.lgd-history-compare')!.hidden = !selected;
      content.setAttr('title', `${commit.subject}\n${commit.sha}\n${commit.path}`);
      const renamed = state.entry && commit.path !== state.entry.context.rel;
      let rename = row.querySelector<HTMLElement>('.lgd-history-renamed');
      if (renamed) {
        if (!rename) rename = content.createDiv({ cls: 'lgd-history-renamed' });
        rename.setText(`Previous path: ${commit.path}`);
      } else rename?.remove();
      // Avoid moving existing rows: double-clicks and keyboard focus must survive selection renders.
      if (list.children[index + 1] !== row) list.insertBefore(row, list.children[index + 1] || null);
    }
    if (!commits.length) list.createDiv({ cls: 'lgd-history-empty', text: !state.file ? 'Choose Git History on a Markdown file to view its versions.' :
      state.loading && !state.entry ? 'Loading versions…' : query ? 'No loaded versions match.' : state.error && !state.entry ? 'Git history is unavailable.' : 'This file has no committed versions.' });
    if (anchor?.parentElement === list) list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    else list.scrollTop = scroll;
    const focusRow = this.rows.get(focusSha || compareSha || '');
    if (focusRow?.parentElement === list) focusRow.querySelector<HTMLButtonElement>(focusSha ? '.lgd-history-commit' : '.lgd-history-compare')?.focus({ preventScroll: true });
    this.updateComparisonState(); this.updateConnector();
  }
}
