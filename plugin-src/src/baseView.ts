import { Component, ItemView, MarkdownRenderer, WorkspaceLeaf } from 'obsidian';
import { CLS, ATTR_ROW } from './panes.ts';
import { unwrapCharMarks, applyRowMarks } from './charmarks.ts';
import type { Session } from './session.ts';
export const VIEW_TYPE = 'live-git-diff-base';
export interface BaseViewHost { session: Session | null; sync: { enabled: boolean; attach(): void }; closeReview(): void }

/** Historical DOM is reused while the note/commit/options remain fixed. */
export class GitBaseView extends ItemView {
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
  constructor(leaf: WorkspaceLeaf, host: BaseViewHost) { super(leaf); this.host = host; }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.host.session ? `Base: ${this.host.session.fileName}` : 'Git base'; }
  getIcon(): string { return 'git-compare'; }
  async onOpen(): Promise<void> { await this.render(); }
  updateSyncBadge(): void { this.syncBadgeEl?.setText(this.host.sync.enabled ? ' · rolagem sincronizada' : ' · rolagem livre'); }
  updateStatus(): void {
    const s = this.host.session;
    if (!s || !this.statusEl) return;
    const simplified = s.rows.some(row => row.simplified);
    this.statusEl.setText(s.error || (s.status === 'updating' ? 'Atualizando comparação…' :
      `${s.counts.changed} blocos alterados${simplified ? ' · detalhamento simplificado em alguns trechos' : ''}`));
    this.statusEl.toggleClass('lgd-error', !!s.error);
    this.bodyEl?.setAttr('aria-busy', String(s.status === 'updating'));
    if (s.status !== 'ready') for (const entry of this.cache.values()) {
      entry.element.removeClass(CLS.mod, CLS.del); unwrapCharMarks(entry.content); entry.note.setText('');
    }
  }
  async render(): Promise<void> {
    const s = this.host.session, generation = ++this.generation;
    if (!s) { this.contentEl.empty(); this.contentEl.createDiv({ cls: 'lgd-empty', text: 'Abra uma revisão para comparar a nota.' }); return; }
    const key = JSON.stringify([s.filePath, s.sha, s.breaks]);
    if (this.renderKey !== key || !this.bodyEl) {
      this.renderKey = key;
      this.component?.unload();
      this.component = new Component(); this.component.load();
      const root = this.contentEl; root.empty(); root.addClass('lgd-view');
      this.cache.clear(); this.blockEls.clear();
      const header = root.createDiv({ cls: 'lgd-header' });
      header.createDiv({ cls: 'lgd-title', text: s.fileName });
      const sub = header.createDiv({ cls: 'lgd-sub' });
      sub.createSpan({ cls: 'lgd-sha', text: `Base ${s.shortSha} · ${s.baseRefLabel}` });
      if (s.baseCommit) {
        sub.createSpan({ cls: 'lgd-subject', text: ' · ' + s.baseCommit.subject });
        sub.createSpan({ cls: 'lgd-age', text: ' · ' + s.baseCommit.relative, attr: { title: s.baseCommit.date } });
      }
      if (s.baseReadAs) sub.createSpan({ cls: 'lgd-renamed', text: ' · caminho anterior: ' + s.baseReadAs });
      this.statusEl = header.createDiv({ cls: 'lgd-sub', attr: { role: 'status', 'aria-live': 'polite' } });
      this.syncBadgeEl = header.createDiv({ cls: 'lgd-sync' }); this.updateSyncBadge();
      this.bodyEl = root.createDiv({ cls: 'lgd-body markdown-preview-view markdown-rendered' });
      this.sizer = this.bodyEl.createDiv({ cls: 'markdown-preview-sizer markdown-preview-section' });
    }
    this.updateStatus();
    if (s.status !== 'ready' || !this.sizer || !this.component) return;
    const references = s.baseReferences;
    const sourcePath = s.filePath.replace(/[^/]+$/, '__live_git_diff_history__.md');
    this.blockEls.clear();
    let batchStart = performance.now();
    for (const row of s.baseRows) {
      if (generation !== this.generation || this.host.session !== s || s.status !== 'ready') return;
      const block = row.a!;
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
      entry.element.removeClass(CLS.mod, CLS.del, CLS.same);
      entry.element.addClass(row.kind === 'del' ? CLS.del : row.kind === 'mod' ? CLS.mod : CLS.same);
      entry.note.setText([row.structural || block.conservative, row.simplified ? 'Detalhamento simplificado; o bloco continua marcado como alterado.' : ''].filter(Boolean).join(' '));
      unwrapCharMarks(entry.content); applyRowMarks(row, entry.content, 'a');
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
  }
}
