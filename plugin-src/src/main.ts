import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf, editorInfoField } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { GitBaseView, VIEW_TYPE } from './baseView.ts';
import { GitError, commitInfoFor, fileLog, readBaseAt, resolveGit, resolveRef } from './git.ts';
import type { GitContext } from './git.ts';
import { CommitPickerModal } from './refPicker.ts';
import { sessionFromRows, errorSession, RevisionGate } from './session.ts';
import type { Row, Session, Revision } from './session.ts';
import { ComparisonWorker } from './workerClient.ts';
import { editorPath, publish, reviewExtension } from './editor.ts';
import { ScrollSync } from './sync.ts';
import { ViewZones } from './viewzones.ts';
import { CharMarkLayer, unwrapCharMarks } from './charmarks.ts';
import { findPreviewScroller } from './dom.ts';
import { ATTR_ROW, CLS, setNoteKind } from './panes.ts';
import type { NotePane } from './panes.ts';
import { DEFAULT_SETTINGS, LiveGitDiffSettingTab, applyColors, clearColors, mergeSettings, persistSettings } from './settings.ts';
import type { LiveGitDiffSettings } from './settings.ts';
import * as log from './log.ts';

/** All document edits belong to Obsidian. Publish presentation effects only. */
export default class LiveGitDiffPlugin extends Plugin {
  settings: LiveGitDiffSettings = DEFAULT_SETTINGS;
  session: Session | null = null;
  zones!: ViewZones;
  sync!: ScrollSync;
  private marks!: CharMarkLayer;
  private worker = new ComparisonWorker();
  private revisions = new RevisionGate();
  private editors = new Set<EditorView>();
  private preferredEditor: EditorView | null = null;
  private reviewLeaf: WorkspaceLeaf | null = null;
  private noteLines = new WeakMap<HTMLElement, { lineStart: number; lineEnd: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private opening = 0;
  private disposed = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.zones = new ViewZones(this); this.sync = new ScrollSync(this); this.marks = new CharMarkLayer(this);
    this.registerEditorExtension(reviewExtension(this));
    this.registerView(VIEW_TYPE, leaf => new GitBaseView(leaf, this));
    this.addSettingTab(new LiveGitDiffSettingTab(this.app, this));
    const command = (id: string, name: string, run: () => void, review = false): void => {
      this.addCommand({ id, name, checkCallback: checking => {
        const allowed = review ? !!this.session : this.app.workspace.getActiveFile()?.extension === 'md';
        if (allowed && !checking) run(); return allowed;
      } });
    };
    command('open-review', 'Open git diff review for this file', () => { void this.openReview(); });
    command('open-review-against-ref', 'Open review against a version…', () => this.pickBaseAndOpen());
    command('refresh-review', 'Refresh review (re-pin the base version)', () => { void this.openReview({ repin: true }); });
    command('close-review', 'Close review', () => this.closeReview(), true);
    command('toggle-scroll-sync', 'Toggle scroll sync', () => this.toggleSync(), true);
    command('copy-alignment-report', 'Copy alignment report to clipboard', () => { void this.reportAlignment(); }, true);
    command('refresh-annotations', 'Refresh annotations in the note pane', () => this.rerenderPreviews(), true);
    this.registerMarkdownPostProcessor((element, context) => {
      if (element.closest('.lgd-view') || context.sourcePath !== this.session?.filePath) return;
      const info = context.getSectionInfo(element); if (info) this.decorateNoteSection(element, info);
    });
    const layout = (): void => {
      this.sync.attach();
      queueMicrotask(() => {
        if (!this.disposed) {
          this.publishEditorMarks();
          // Obsidian may reuse a reading view whose old marks were cleared while editing.
          this.decorateNotePaneInPlace();
        }
      });
      if (this.session) void this.checkBreaks();
    };
    this.registerEvent(this.app.workspace.on('layout-change', layout));
    this.registerEvent(this.app.workspace.on('active-leaf-change', layout));
    this.registerEvent(this.app.workspace.on('resize', () => this.sync.attach()));
    this.registerEvent(this.app.vault.on('modify', file => { if (file instanceof TFile && file.path === this.session?.filePath) void this.externalChange(file); }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (oldPath !== this.session?.filePath) return;
      this.invalidate();
      if (this.session) { this.session.error = `Nota renomeada para ${file.path}. Reabra a revisão.`; this.session.status = 'error'; }
      this.baseView()?.updateStatus();
    }));
    this.registerEvent(this.app.vault.on('delete', file => { if (file.path === this.session?.filePath) this.closeReview(); }));
    this.register(() => this.worker.dispose()); this.register(() => this.sync.dispose());
  }
  onunload(): void {
    this.disposed = true; this.opening++; this.revisions.close();
    if (this.timer) clearTimeout(this.timer);
    this.worker.dispose(); this.sync.dispose(); this.clearNoteDecorations();
    this.session = null; this.publishEditorMarks(); this.zones.dispose(); clearColors();
  }
  async loadSettings(): Promise<void> {
    this.settings = mergeSettings(await this.loadData()); log.setDebug(this.settings.debug); applyColors(this.settings);
  }
  async saveSettings(): Promise<void> {
    await persistSettings(this); log.setDebug(this.settings.debug); applyColors(this.settings);
  }
  editorAttached(view: EditorView): void {
    this.editors.add(view);
    queueMicrotask(() => { if (!this.disposed && this.editors.has(view)) { this.publishEditorMarks(); this.sync?.attach(); } });
  }
  editorDetached(view: EditorView): void {
    this.editors.delete(view);
    if (this.preferredEditor === view) this.preferredEditor = null;
    queueMicrotask(() => { if (!this.disposed) this.sync?.attach(); });
  }
  editorChanged(view: EditorView, path: string): void {
    if (path === this.session?.filePath) { this.preferredEditor = view; this.requestUpdate(); }
  }
  editorGeometryChanged(): void { /* Public scroll anchors are measured on demand. */ }
  private currentEditor(path = this.session?.filePath): EditorView | null {
    if (this.preferredEditor && this.editors.has(this.preferredEditor) && editorPath(this.preferredEditor) === path) return this.preferredEditor;
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    const candidates = [...this.editors].filter(view => editorPath(view) === path);
    return candidates.find(v => v.state.field(editorInfoField, false)?.editor === active?.editor) ||
      candidates.find(v => this.reviewLeaf?.view.containerEl.contains(v.dom)) || candidates[0] || null;
  }
  private publishEditorMarks(): void {
    const s = this.session;
    for (const view of this.editors) {
      const reviewing = !!s && editorPath(view) === s.filePath;
      publish(view, s?.status === 'ready' && !s.error && reviewing
        ? { filePath: s.filePath, revision: s.revision, text: s.currentText, rows: s.rows } : null, reviewing);
    }
  }
  private invalidate(): Revision | null {
    this.worker.cancel(); if (this.timer) clearTimeout(this.timer); this.timer = null;
    const identity = this.revisions.next();
    if (this.session && identity) {
      this.session.revision = identity.revision; this.session.status = 'updating'; this.session.error = null;
    }
    this.sync.detach(); this.clearNoteDecorations(); this.baseView()?.updateStatus();
    queueMicrotask(() => { if (!this.disposed) this.publishEditorMarks(); });
    return identity;
  }
  private requestUpdate(): void {
    if (!this.session?.sha) return;
    const identity = this.invalidate();
    if (identity) this.timer = setTimeout(() => { this.timer = null; void this.updateComparison(identity); }, 300);
  }
  private async externalChange(file: TFile): Promise<void> {
    const session = this.session;
    try {
      const saved = await this.app.vault.read(file);
      // A save of the already compared live buffer does not invalidate a correct result.
      if (session === this.session && saved !== session?.currentText) this.requestUpdate();
    } catch (error) {
      if (session === this.session) {
        this.invalidate();
        if (this.session) { this.session.status = 'error'; this.session.error = (error as Error).message; }
        this.baseView()?.updateStatus();
      }
    }
  }
  private async readBreaks(): Promise<boolean> {
    const path = `${this.app.vault.configDir}/app.json`;
    if (!await this.app.vault.adapter.exists(path)) return true;
    const config = JSON.parse(await this.app.vault.adapter.read(path)) as { strictLineBreaks?: boolean };
    return !config.strictLineBreaks;
  }
  private async checkBreaks(): Promise<void> {
    const session = this.session; if (!session?.sha) return;
    try {
      const breaks = await this.readBreaks();
      if (session === this.session && breaks !== session.breaks) { session.breaks = breaks; this.requestUpdate(); }
    } catch (error) { log.warn('Could not read line-break settings', error); }
  }
  private async updateComparison(identity: Revision): Promise<void> {
    const previous = this.session;
    if (!previous || !this.revisions.accepts(identity)) return;
    try {
      const file = this.app.vault.getAbstractFileByPath(identity.filePath);
      if (!(file instanceof TFile)) throw new Error('A nota não está mais disponível.');
      const currentText = this.currentEditor(identity.filePath)?.state.doc.toString() ?? await this.app.vault.read(file);
      if (!this.revisions.accepts(identity)) return;
      const result = await this.worker.compare({ identity, baseText: previous.baseText, currentText, options: { breaks: previous.breaks } });
      if (!this.revisions.accepts(identity)) return;
      this.session = sessionFromRows(file, previous.baseText, { root: previous.root, rel: previous.rel },
        { sha: previous.sha, label: previous.baseRefLabel, commit: previous.baseCommit, readAs: previous.baseReadAs },
        currentText, result.rows || [], identity.revision, previous.breaks);
      this.session.baseReferences = result.baseReferences || '';
      await this.baseView()?.render();
      if (!this.revisions.accepts(identity)) return;
      this.publishEditorMarks(); this.decorateNotePaneInPlace(); this.sync.attach(); this.sync.syncNoteToBase();
    } catch (error) {
      if (!this.revisions.accepts(identity) || (error as Error).name === 'AbortError') return;
      if (this.session) { this.session.error = `Falha na comparação: ${(error as Error).message}`; this.session.status = 'error'; }
      this.baseView()?.updateStatus();
    }
  }
  private resolveBase(ctx: GitContext): { sha: string; label: string } {
    const mode = this.settings.baseRefMode;
    if (mode === 'file-prev') {
      const commits = fileLog(ctx.root, ctx.rel, 2);
      if (commits.length < 2) throw new GitError('A nota precisa de dois commits para comparar com a versão anterior.');
      return { sha: commits[1].sha, label: 'previous version' };
    }
    const ref = mode === 'custom' ? this.settings.baseRef : mode === 'head~1' ? 'HEAD~1' : 'HEAD';
    return { sha: resolveRef(ctx.root, ref), label: ref };
  }
  private pickBaseAndOpen(): void {
    const file = this.app.workspace.getActiveFile(); if (!file) return;
    try {
      const ctx = resolveGit(this.app, file), commits = fileLog(ctx.root, ctx.rel, this.settings.logLimit);
      if (!commits.length) { new Notice('A nota não possui commits.'); return; }
      const modal = new CommitPickerModal(this.app, file.name, commits, c => { void this.openReview({ ref: c.sha, label: c.shortSha, file }); });
      modal.currentPath = ctx.rel; modal.open();
    } catch (error) { new Notice((error as Error).message); }
  }
  async openReview(opts: { repin?: boolean; ref?: string; label?: string; file?: TFile } = {}): Promise<void> {
    const file = opts.file || this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') { new Notice('Abra uma nota Markdown.'); return; }
    const opening = ++this.opening;
    const keep = !opts.repin && !opts.ref && this.session?.filePath === file.path && this.session.sha
      ? { sha: this.session.sha, label: this.session.baseRefLabel } : null;
    this.worker.cancel(); this.revisions.close(); if (this.timer) clearTimeout(this.timer);
    this.clearNoteDecorations(); this.sync.detach();
    this.reviewLeaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf || null; this.preferredEditor = null;
    try {
      const noteView = this.reviewLeaf?.view;
      if (noteView instanceof MarkdownView && noteView.file?.path === file.path) {
        const state = noteView.getState();
        if (noteView.getMode() !== 'source' || state.source !== false) {
          await this.reviewLeaf!.setViewState({ type: 'markdown', state: { ...state, mode: 'source', source: false }, active: true });
        }
      }
      if (opening !== this.opening) return;
      const ctx = resolveGit(this.app, file);
      const base = keep || (opts.ref ? { sha: resolveRef(ctx.root, opts.ref), label: opts.label || opts.ref } : this.resolveBase(ctx));
      const read = readBaseAt(ctx.root, ctx.rel, base.sha), commit = commitInfoFor(ctx.root, base.sha);
      const breaks = await this.readBreaks(); if (opening !== this.opening) return;
      this.session = sessionFromRows(file, read.text, ctx, { ...base, commit, readAs: read.renamedFrom }, '', [], 0, breaks);
      this.session.status = 'updating';
      const identity = this.revisions.begin(file.path, base.sha);
      this.publishEditorMarks(); await this.revealView();
      if (opening === this.opening) await this.updateComparison(identity);
    } catch (error) {
      if (opening !== this.opening) return;
      this.session = errorSession(file, (error as Error).message);
      this.publishEditorMarks(); await this.revealView(); new Notice((error as Error).message);
    }
  }
  closeReview(): void {
    this.opening++; this.revisions.close(); this.worker.dispose(); if (this.timer) clearTimeout(this.timer);
    this.sync.detach(); this.clearNoteDecorations(); this.session = null;
    this.publishEditorMarks(); this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
  private async revealView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.createLeafBySplit(this.reviewLeaf || this.app.workspace.getLeaf(false), 'vertical', true);
      await leaf.setViewState({ type: VIEW_TYPE, active: false });
    }
    await this.baseView()?.render();
  }
  notePane(): NotePane | null {
    const session = this.session;
    if (!session || session.error || session.status !== 'ready') return null;
    const cm = this.currentEditor(), owner = cm?.state.field(editorInfoField, false);
    if (cm && owner instanceof MarkdownView && owner.getMode() === 'source' && cm.dom.isConnected) return { view: owner, scroller: cm.scrollDOM, editorView: cm };
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file?.path !== session.filePath || view.getMode() !== 'preview') continue;
      const scroller = findPreviewScroller(view); if (scroller) return { view, scroller };
    }
    return null;
  }
  baseView(): GitBaseView | null {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    return view instanceof GitBaseView ? view : null;
  }
  basePane(): HTMLElement | null { return this.baseView()?.bodyEl || null; }
  baseElFor(index: number): HTMLElement | null { return this.baseView()?.blockEls.get(index) || null; }
  noteLineInfo(element: HTMLElement): { lineStart: number; lineEnd: number } | undefined { return this.noteLines.get(element); }
  rowForNoteRange(start: number, end: number): Row | null {
    let best: Row | null = null, overlap = 0;
    for (const row of this.session?.noteRows || []) {
      const block = row.b!, n = Math.min(end, block.lineEnd) - Math.max(start, block.lineStart) + 1;
      if (n > overlap) { overlap = n; best = row; }
    }
    return best;
  }
  private decorateNoteSection(element: HTMLElement, info: { lineStart: number; lineEnd: number }): void {
    if (this.session?.status !== 'ready' || this.session.error) return;
    const row = this.rowForNoteRange(info.lineStart, info.lineEnd);
    element.addClass(CLS.nblock); this.noteLines.set(element, info);
    if (row) element.setAttr(ATTR_ROW, String(row.idx));
    setNoteKind(element, row?.kind || null);
    if (row?.kind === 'mod') this.marks.apply(row, element);
  }
  /** Reading mode only. Editing uses exclusively the public CodeMirror extension. */
  private readingSections(view: MarkdownView): Array<{ el: HTMLElement; info: { lineStart: number; lineEnd: number } }> {
    const renderer = (view.previewMode as unknown as { renderer?: { sections?: Array<{ el: HTMLElement; rendered?: boolean }>; getSectionInfo?: (el: HTMLElement) => { lineStart: number; lineEnd: number } | null } }).renderer;
    if (!renderer?.sections || !renderer.getSectionInfo) return [];
    return renderer.sections.flatMap(s => {
      const info = s.el && s.rendered !== false ? renderer.getSectionInfo!(s.el) : null;
      return info ? [{ el: s.el, info }] : [];
    });
  }
  private decorateNotePaneInPlace(): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === this.session?.filePath && view.getMode() === 'preview') {
        for (const section of this.readingSections(view)) this.decorateNoteSection(section.el, section.info);
      }
    }
  }
  private clearNoteDecorations(): void {
    this.marks?.reset(); this.zones?.reset();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view; if (!(view instanceof MarkdownView)) continue;
      const elements = new Set([...this.readingSections(view).map(s => s.el), ...Array.from(view.containerEl.querySelectorAll<HTMLElement>(`.${CLS.nblock}`))]);
      for (const el of elements) if (el.hasClass(CLS.nblock)) {
        unwrapCharMarks(el); setNoteKind(el, null); el.removeClass(CLS.nblock); el.removeAttribute(ATTR_ROW);
      }
    }
  }
  toggleSync(): void { this.sync.enabled = !this.sync.enabled; this.baseView()?.updateSyncBadge(); }
  private rerenderPreviews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === this.session?.filePath) view.previewMode.rerender(true);
    }
  }
  private async reportAlignment(): Promise<void> {
    const s = this.session; if (!s) return;
    const report = { file: s.filePath, sha: s.sha, revision: s.revision, status: s.status, counts: s.counts,
      simplified: s.rows.filter(row => row.simplified).length, scrollApi: this.sync.lastScrollApi,
      editor: !!this.notePane()?.editorView, error: s.error };
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); new Notice('Relatório copiado.'); }
    catch { log.warn('Clipboard unavailable', report); new Notice('Relatório disponível no console.'); }
  }
}
