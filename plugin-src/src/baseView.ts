import { Component, ItemView, MarkdownRenderer, WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import { CLS, ATTR_ROW } from './panes.ts';
import { unwrapCharMarks, applyRowMarks } from './charmarks.ts';
import type { Session } from './session.ts';
export const VIEW_TYPE = 'live-git-diff-base';
export interface BaseViewHost {
  session: Session | null; sync: { enabled: boolean; attach(): void }; closeReview(): void;
  snapshotClosed?(view: GitBaseView): void;
  swapSides?(): void;
  presentationWarning?(): string | null;
}

/** Historical DOM is reused while the note/commit/options remain fixed. */
export class GitBaseView extends ItemView {
  side: 'a' | 'b' = 'a';
  private host: BaseViewHost;
  bodyEl: HTMLElement | null = null;
  endPadEl: HTMLElement | null = null;
  blockEls = new Map<number, HTMLElement>();
  spacerEls = new Map<number, HTMLElement>();
  private cache = new Map<number, { element: HTMLElement; content: HTMLElement; note: HTMLElement; rendered: Promise<void> }>();
  private renderKey = '';
  private generation = 0;
  private component: Component | null = null;
  private statusEl: HTMLElement | null = null;
  private syncBadgeEl: HTMLElement | null = null;
  private sizer: HTMLElement | null = null;
  constructor(leaf: WorkspaceLeaf, host: BaseViewHost, side: 'a' | 'b' = 'a') { super(leaf); this.host = host; this.side = side; }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.host.session ? `${this.side === 'a' ? 'Base' : 'Compared'}: ${this.host.session.fileName}` : 'Git version'; }
  getIcon(): string { return 'git-compare'; }
  getState(): Record<string, unknown> { return { side: this.side }; }
  async setState(state: { side?: string }, result: ViewStateResult): Promise<void> {
    this.side = state?.side === 'b' ? 'b' : 'a'; await super.setState(state, result); await this.render();
  }
  async onOpen(): Promise<void> {
    this.addAction('x', 'Close comparison', () => this.host.closeReview());
    await this.render();
  }
  updateSyncBadge(): void { this.syncBadgeEl?.setText(this.host.sync.enabled ? ' · Scroll sync on' : ' · Scroll sync off'); }
  updateStatus(): void {
    const s = this.host.session;
    if (!s || !this.statusEl) return;
    const simplified = s.rows.some(row => row.simplified);
    this.statusEl.setText(s.error || (s.status === 'updating' ? 'Updating comparison…' :
      `${s.counts.changed} changed blocks${simplified ? ' · Some details simplified' : ''}${this.host.presentationWarning?.() ? ' · ' + this.host.presentationWarning() : ''}`));
    this.statusEl.toggleClass('lgd-error', !!s.error);
    this.bodyEl?.setAttr('aria-busy', String(s.status === 'updating'));
    if (s.status !== 'ready') for (const entry of this.cache.values()) {
      entry.element.removeClass(CLS.mod, CLS.del, CLS.ins); unwrapCharMarks(entry.content); entry.note.setText('');
    }
  }
  async render(): Promise<void> {
    const s = this.host.session, generation = ++this.generation;
    if (!s) { this.contentEl.empty(); this.contentEl.createDiv({ cls: 'lgd-empty', text: 'Open a comparison to review this file.' }); return; }
    const endpoint = s.endpoints[this.side === 'a' ? 0 : 1];
    const key = JSON.stringify([s.filePath, endpoint, this.side, s.breaks]);
    if (this.renderKey !== key || !this.bodyEl) {
      this.renderKey = key;
      this.component?.unload();
      this.component = new Component(); this.component.load();
      const root = this.contentEl; root.empty(); root.addClass('lgd-view'); root.dataset.lgdSide = this.side;
      this.cache.clear(); this.blockEls.clear();
      const header = root.createDiv({ cls: 'lgd-header' });
      header.createDiv({ cls: 'lgd-title', text: s.fileName });
      const sub = header.createDiv({ cls: 'lgd-sub' });
      const commit = endpoint.kind === 'commit' ? endpoint.commit : null;
      sub.createSpan({ cls: 'lgd-sha', text: endpoint.kind === 'commit' ? `${this.side === 'a' ? 'Base' : 'Compared'} ${endpoint.sha.slice(0, 7)} · ${endpoint.label}` : 'Current document' });
      if (commit) {
        sub.createSpan({ cls: 'lgd-subject', text: ' · ' + commit.subject });
        sub.createSpan({ cls: 'lgd-age', text: ' · ' + commit.relative, attr: { title: commit.date } });
      }
      if (endpoint.path !== s.rel) sub.createSpan({ cls: 'lgd-renamed', text: ' · Historical path: ' + endpoint.path });
      if (s.endpoints[1].kind === 'commit') {
        const swap = header.createEl('button', { text: 'Swap sides', cls: 'lgd-swap' });
        swap.addEventListener('click', () => this.host.swapSides?.());
      }
      this.statusEl = header.createDiv({ cls: 'lgd-sub', attr: { role: 'status', 'aria-live': 'polite' } });
      this.syncBadgeEl = header.createDiv({ cls: 'lgd-sync' }); this.updateSyncBadge();
      this.bodyEl = root.createDiv({ cls: 'lgd-body markdown-preview-view markdown-rendered' });
      this.sizer = this.bodyEl.createDiv({ cls: 'markdown-preview-sizer markdown-preview-section' });
    }
    this.updateStatus();
    if (s.status !== 'ready' || !this.sizer || !this.component) return;
    const references = this.side === 'a' ? s.baseReferences : s.currentReferences;
    const sourcePath = s.filePath.replace(/[^/]+$/, '__live_git_diff_history__.md');
    this.blockEls.clear();
    let batchStart = performance.now();
    for (const row of this.side === 'a' ? s.baseRows : s.noteRows) {
      if (generation !== this.generation || this.host.session !== s || s.status !== 'ready') return;
      const block = row[this.side]!;
      let entry = this.cache.get(block.sourceStart);
      if (!entry) {
        const element = this.sizer.createDiv({ cls: CLS.block });
        const content = element.createDiv({ cls: 'lgd-content' });
        const note = element.createDiv({ cls: 'lgd-explanation' });
        entry = { element, content, note, rendered: Promise.resolve() }; this.cache.set(block.sourceStart, entry);
        if (block.type === 'properties' || block.type === 'reference' || block.conservative?.startsWith('Plugin-generated content')) {
          content.createEl('pre').createEl('code', { text: block.text });
        } else {
          entry.rendered = MarkdownRenderer.render(this.app, block.text + (references ? '\n\n' + references : ''), content, sourcePath, this.component);
        }
      }
      await entry.rendered;
      if (entry.content.firstElementChild) entry.element.addClass('el-' + entry.content.firstElementChild.tagName.toLowerCase());
      if (generation !== this.generation || this.host.session !== s || s.status !== 'ready') return;
      entry.element.setAttr(ATTR_ROW, String(row.idx));
      entry.element.setAttr('data-line-start', String(block.lineStart));
      entry.element.setAttr('data-line-end', String(block.lineEnd));
      entry.element.removeClass(CLS.mod, CLS.del, CLS.ins, CLS.same);
      entry.element.toggleClass(CLS.nblock, this.side === 'b');
      entry.element.addClass(CLS[row.kind]);
      const oppositeRows = row.tableRows?.filter(change => change.kind === (this.side === 'a' ? 'ins' : 'del')).length || 0;
      const tableNote = oppositeRows ? `${oppositeRows} ${oppositeRows === 1 ? 'row' : 'rows'} ${this.side === 'a' ? 'added in the compared version' : 'removed from the base version'}.` : '';
      entry.note.setText([row.structural || block.conservative, tableNote, row.simplified ? 'Details simplified; this block is still marked as changed.' : ''].filter(Boolean).join(' '));
      unwrapCharMarks(entry.content); applyRowMarks(row, entry.content, this.side);
      this.blockEls.set(row.idx, entry.element);
      if (performance.now() - batchStart >= 8) {
        await new Promise<void>(resolve => setTimeout(resolve, 0)); batchStart = performance.now();
      }
    }
    if (!this.endPadEl?.isConnected) this.endPadEl = this.sizer.createDiv({ cls: CLS.endpad });
    this.endPadEl.style.height = '60vh';
    this.host.sync.attach();
  }
  async onClose(): Promise<void> {
    this.generation++; this.component?.unload(); this.component = null;
    this.bodyEl = null; this.cache.clear(); this.blockEls.clear();
    this.host.snapshotClosed?.(this);
  }
  scrollToLine(line: number): void {
    if (!this.bodyEl) return;
    const rows = this.side === 'a' ? this.host.session?.baseRows : this.host.session?.noteRows;
    const row = rows?.find(r => r[this.side]!.lineEnd >= line) || rows?.at(-1);
    const block = row?.[this.side], el = row && this.blockEls.get(row.idx);
    if (!block || !el) return;
    const fraction = Math.max(0, Math.min(1, (line - block.lineStart) / (block.lineEnd - block.lineStart + 1)));
    this.bodyEl.scrollTop += el.getBoundingClientRect().top - this.bodyEl.getBoundingClientRect().top + fraction * el.offsetHeight;
  }
}
