import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { GitBaseView, VIEW_TYPE } from './baseView.ts';
import { GitError, commitInfoForAsync, fileLogAsync, readBaseAtAsync, resolveGitAsync, resolveRefAsync } from './git.ts';
import type { CommitInfo, GitContext } from './git.ts';
import { GitHistoryView, HISTORY_VIEW_TYPE } from './historyView.ts';
import type { HistoryReviewState } from './historyView.ts';
import { HistoryCache } from './history.ts';
import { registerFileMenus } from './contextMenus.ts';
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

/** All edits belong to Obsidian. Git reads and presentation have independent lifetimes. */
export default class LiveGitDiffPlugin extends Plugin {
  settings: LiveGitDiffSettings = DEFAULT_SETTINGS;
  session: Session | null = null;
  historyCache = new HistoryCache();
  zones!: ViewZones;
  sync!: ScrollSync;
  private marks!: CharMarkLayer;
  private worker = new ComparisonWorker();
  private revisions = new RevisionGate();
  private editors = new Set<EditorView>();
  private preferredEditor: EditorView | null = null;
  private reviewLeaf: WorkspaceLeaf | null = null;
  private participants = new Map<WorkspaceLeaf, { type: string; path?: string; side?: 'a' | 'b' }>();
  private actions = new Map<MarkdownView, { compare: HTMLElement; history: HTMLElement }>();
  private tableIssues = new Map<EditorView, string>();
  private noteLines = new WeakMap<HTMLElement, { lineStart: number; lineEnd: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private gitJob: AbortController | null = null;
  private opening = 0;
  private openingFile: string | null = null;
  private historyOpening = 0;
  private creating = false;
  private disposed = false;
  private layoutPending = false;
  private previewObserver: MutationObserver | null = null;
  private previewRoot: HTMLElement | null = null;
  private previewFrame: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.zones = new ViewZones(this); this.sync = new ScrollSync(this); this.marks = new CharMarkLayer(this);
    this.registerEditorExtension(reviewExtension(this));
    this.registerView(VIEW_TYPE, leaf => new GitBaseView(leaf, this, this.participants.get(leaf)?.side));
    this.registerView(HISTORY_VIEW_TYPE, leaf => new GitHistoryView(leaf, this));
    registerFileMenus(this, this);
    this.addSettingTab(new LiveGitDiffSettingTab(this.app, this));
    const command = (id: string, name: string, run: () => void, review = false): void => {
      this.addCommand({ id, name, checkCallback: checking => {
        const allowed = review ? !!this.session : !!this.contextFile();
        if (allowed && !checking) run(); return allowed;
      } });
    };
    command('open-review', 'Open git diff review for this file', () => { void this.openReview(); });
    command('open-review-against-ref', 'Open review against a version…', () => { void this.openHistory(); });
    command('refresh-review', 'Refresh review (re-pin the base version)', () => { void this.openReview({ repin: true }); });
    command('close-review', 'Close review', () => this.closeReview(), true);
    command('toggle-scroll-sync', 'Toggle scroll sync', () => this.toggleSync(), true);
    command('copy-alignment-report', 'Copy alignment report to clipboard', () => { void this.reportAlignment(); }, true);
    command('refresh-annotations', 'Refresh annotations in the note pane', () => this.rerenderPreviews(), true);
    this.registerMarkdownPostProcessor((element, context) => {
      if (element.closest('.lgd-view') || context.sourcePath !== this.session?.filePath) return;
      const info = context.getSectionInfo(element); if (info) this.decorateNoteSection(element, info);
      // Postprocessors may run before the section is attached to its leaf.
      this.scheduleReadingPaint();
    });
    this.registerEvent(this.app.workspace.on('layout-change', () => this.scheduleLayout()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleLayout()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleLayout()));
    this.registerEvent(this.app.workspace.on('resize', () => this.sync.attach()));
    this.registerEvent(this.app.vault.on('modify', file => {
      if (!this.isHistoricalPair() && file instanceof TFile && file.path === this.session?.filePath) void this.externalChange(file);
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      const contains = (path?: string): boolean => !!path && (path === oldPath || path.startsWith(oldPath + '/'));
      if (contains(this.session?.filePath) || contains(this.openingFile || undefined)) this.closeReview();
      const view = this.historyView(), path = view?.controller.state.file?.path;
      if (path && contains(path)) {
        const renamed = this.app.vault.getAbstractFileByPath(file.path + path.slice(oldPath.length));
        if (renamed instanceof TFile) void view!.setFile(renamed);
      }
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      const contains = (path?: string): boolean => !!path && (path === file.path || path.startsWith(file.path + '/'));
      if (contains(this.session?.filePath) || contains(this.openingFile || undefined)) this.closeReview();
      const view = this.historyView();
      if (contains(view?.controller.state.file?.path)) view!.controller.fileUnavailable();
    }));
    this.app.workspace.onLayoutReady(() => {
      if (!this.disposed) {
        if (!this.session) this.app.workspace.detachLeavesOfType(VIEW_TYPE);
        this.scheduleLayout();
      }
    });
  }
  onunload(): void {
    this.disposed = true; this.closeReview(); this.historyCache.dispose();
    this.app.workspace.detachLeavesOfType(HISTORY_VIEW_TYPE);
    for (const buttons of this.actions.values()) { buttons.compare.remove(); buttons.history.remove(); }
    this.actions.clear(); this.sync.dispose(); this.zones.dispose(); clearColors();
  }
  async loadSettings(): Promise<void> {
    this.settings = mergeSettings(await this.loadData()); log.setDebug(this.settings.debug); applyColors(this.settings);
  }
  async saveSettings(): Promise<void> {
    await persistSettings(this); log.setDebug(this.settings.debug); applyColors(this.settings);
  }
  private isHistoricalPair(): boolean { return this.session?.endpoints[1].kind === 'commit'; }
  private contextFile(): TFile | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (active?.extension === 'md') return active;
    const leaf = this.app.workspace.activeLeaf;
    const path = leaf?.view instanceof GitBaseView ? this.session?.filePath : this.historyView()?.controller.state.file?.path;
    const file = path ? this.app.vault.getAbstractFileByPath(path) : this.app.workspace.getActiveFile();
    return file instanceof TFile && file.extension === 'md' ? file : null;
  }
  private scheduleLayout(): void {
    if (this.layoutPending || this.disposed) return;
    this.layoutPending = true;
    queueMicrotask(() => {
      this.layoutPending = false; if (this.disposed) return;
      this.checkParticipants(); this.updateActions(); this.publishEditorMarks();
      this.watchReadingPane(); this.decorateNotePaneInPlace(); this.sync.attach();
      if (this.session) void this.checkBreaks();
    });
  }
  private updateActions(): void {
    const views = new Set(this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView));
    for (const [view, buttons] of this.actions) if (!views.has(view)) {
      buttons.compare.remove(); buttons.history.remove(); this.actions.delete(view);
    }
    for (const view of views) {
      let buttons = this.actions.get(view);
      if (!buttons || !view.containerEl.contains(buttons.compare)) {
        buttons?.compare.remove(); buttons?.history.remove();
        buttons = {
          compare: view.addAction('git-compare', 'Compare', () => {
            if (this.participants.has(view.leaf)) this.closeReview();
            else if (view.file) void this.openReview({ file: view.file, leaf: view.leaf });
          }),
          history: view.addAction('history', 'Git History', () => { void this.openHistory(view.file); }),
        };
        buttons.compare.addClass('lgd-compare-action'); buttons.history.addClass('lgd-history-action'); this.actions.set(view, buttons);
      }
      const closing = this.participants.has(view.leaf);
      setIcon(buttons.compare, closing ? 'x' : 'git-compare'); setTooltip(buttons.compare, closing ? 'Close comparison' : 'Compare');
      buttons.compare.setAttr('aria-label', closing ? 'Close comparison' : 'Compare');
    }
  }
  private scheduleReadingPaint(): void {
    if (this.disposed || this.previewFrame !== null) return;
    this.previewFrame = window.requestAnimationFrame(() => {
      this.previewFrame = null;
      if (!this.disposed) { this.watchReadingPane(); this.decorateNotePaneInPlace(); }
    });
  }
  private watchReadingPane(): void {
    const view = this.reviewLeaf?.view;
    const root = !this.isHistoricalPair() && this.session?.status === 'ready' && view instanceof MarkdownView && view.getMode() === 'preview' ? view.containerEl : null;
    if (root === this.previewRoot) return;
    this.previewObserver?.disconnect(); this.previewObserver = null; this.previewRoot = root;
    if (root) {
      this.previewObserver = new MutationObserver(records => {
        // Our word spans change children inside marked sections. Do not observe ourselves.
        if (records.some(record => !(record.target instanceof Element) || !record.target.closest('.lgd-nblock'))) this.scheduleReadingPaint();
      });
      this.previewObserver.observe(root, { childList: true, subtree: true });
    }
  }
  private checkParticipants(): void {
    if (this.creating || !this.participants.size) return;
    const alive = new Set<WorkspaceLeaf>(); this.app.workspace.iterateAllLeaves(leaf => { alive.add(leaf); });
    for (const [leaf, expected] of this.participants) {
      if (!alive.has(leaf) || leaf.view.getViewType() !== expected.type ||
          (expected.path && (!(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== expected.path)) ||
          (expected.side && (!(leaf.view instanceof GitBaseView) || leaf.view.side !== expected.side))) {
        this.closeReview(); return;
      }
    }
  }
  snapshotClosed(view: GitBaseView): void {
    if (!this.creating && this.participants.has(view.leaf)) this.closeReview(view.leaf);
  }
  private historyView(): GitHistoryView | null {
    const view = this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)[0]?.view;
    return view instanceof GitHistoryView ? view : null;
  }
  historyReviewState(): HistoryReviewState {
    const s = this.session;
    return { openingFile: this.openingFile, error: s?.error || null,
      active: s?.sha && !s.error ? { filePath: s.filePath, left: s.sha.slice(0, 7),
        right: s.endpoints[1].kind === 'commit' ? s.endpoints[1].sha.slice(0, 7) : 'Working tree' } : null };
  }
  async openHistory(file: TFile | null = this.contextFile()): Promise<void> {
    const request = ++this.historyOpening;
    let view = this.historyView();
    if (!view) {
      const leaf = this.app.workspace.getRightLeaf(false); if (!leaf) return;
      await leaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true });
      view = this.historyView();
    }
    if (view && !this.disposed && request === this.historyOpening) { void view.setFile(file); await this.app.workspace.revealLeaf(view.leaf); }
  }
  async compareHistory(filePath: string, commits: readonly CommitInfo[]): Promise<void> {
    if (this.openingFile) return;
    if (commits.length < 1 || commits.length > 2) throw new Error('Select one or two versions to compare.');
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new Error('The note is no longer available.');
    if (commits.length === 1) await this.openReview({ file, ref: commits[0].sha, label: commits[0].shortSha, commit: commits[0] });
    else await this.openHistorical(file, commits[0], commits[1]);
  }
  swapSides(): void {
    const s = this.session;
    const [left, right] = s?.endpoints || [];
    const file = s && this.app.vault.getAbstractFileByPath(s.filePath);
    if (file instanceof TFile && left?.kind === 'commit' && right?.kind === 'commit' && left.commit && right.commit)
      void this.openHistorical(file, right.commit, left.commit);
  }
  editorAttached(view: EditorView): void {
    this.editors.add(view);
    queueMicrotask(() => { if (!this.disposed && this.editors.has(view)) { this.publishEditorMarks(); this.sync?.attach(); } });
  }
  editorDetached(view: EditorView): void {
    this.editors.delete(view); this.tableIssues.delete(view);
    if (this.preferredEditor === view) this.preferredEditor = null;
    this.scheduleLayout();
  }
  editorChanged(view: EditorView, path: string): void {
    if (!this.isHistoricalPair() && path === this.session?.filePath && this.isReviewEditor(view)) {
      this.preferredEditor = view; this.requestUpdate();
    }
  }
  editorGeometryChanged(): void { /* Anchors are measured on demand. */ }
  editorTablePresentationIssue(view: EditorView, message: string | null): void {
    if (message) this.tableIssues.set(view, message); else this.tableIssues.delete(view);
    for (const snapshot of this.snapshotViews()) snapshot.updateStatus();
  }
  presentationWarning(): string | null { return this.tableIssues.size ? 'Unable to highlight some table changes.' : null; }
  private isReviewEditor(view: EditorView): boolean {
    // Cell editors inherit the same file identity. Their document is only one cell,
    // so neither comparison input nor the document gutter may belong to them.
    return !!this.reviewLeaf?.view.containerEl.contains(view.dom) &&
      !view.dom.parentElement?.closest('.cm-editor, .markdown-embed');
  }
  private currentEditor(path = this.session?.filePath): EditorView | null {
    // Obsidian may retain a hidden editor buffer while Reading view receives an external update.
    if (this.isHistoricalPair() || !(this.reviewLeaf?.view instanceof MarkdownView) || this.reviewLeaf.view.getMode() !== 'source') return null;
    const candidates = [...this.editors].filter(view => editorPath(view) === path && this.isReviewEditor(view));
    return this.preferredEditor && candidates.includes(this.preferredEditor) ? this.preferredEditor : candidates[0] || null;
  }
  private publishEditorMarks(): void {
    const s = this.session;
    for (const view of this.editors) {
      const reviewing = !!s && !this.isHistoricalPair() && editorPath(view) === s.filePath && this.isReviewEditor(view);
      publish(view, s?.status === 'ready' && !s.error && reviewing
        ? { filePath: s.filePath, revision: s.revision, text: s.currentText, rows: s.rows } : null, reviewing);
    }
  }
  private invalidate(): Revision | null {
    this.worker.cancel(); if (this.timer) clearTimeout(this.timer); this.timer = null;
    const identity = this.revisions.next();
    if (this.session && identity) { this.session.revision = identity.revision; this.session.status = 'updating'; this.session.error = null; }
    this.sync.detach(); this.clearNoteDecorations();
    for (const view of this.snapshotViews()) view.updateStatus();
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
      if (session === this.session && saved !== session?.currentText) this.requestUpdate();
    } catch (error) {
      if (session === this.session) {
        this.invalidate(); if (this.session) { this.session.status = 'error'; this.session.error = (error as Error).message; }
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
      if (!(file instanceof TFile)) throw new Error('The note is no longer available.');
      const currentText = this.isHistoricalPair() ? previous.currentText : this.currentEditor(identity.filePath)?.state.doc.toString() ?? await this.app.vault.read(file);
      if (!this.revisions.accepts(identity)) return;
      const result = await this.worker.compare({ identity, baseText: previous.baseText, currentText, options: { breaks: previous.breaks } });
      if (!this.revisions.accepts(identity)) return;
      this.session = sessionFromRows(file, previous.baseText, { root: previous.root, rel: previous.rel },
        { sha: previous.sha, label: previous.baseRefLabel, commit: previous.baseCommit, readAs: previous.baseReadAs },
        currentText, result.rows || [], identity.revision, previous.breaks);
      this.session.endpoints = previous.endpoints;
      this.session.baseReferences = result.baseReferences || ''; this.session.currentReferences = result.currentReferences || '';
      for (const view of this.snapshotViews()) await view.render();
      if (!this.revisions.accepts(identity)) return;
      this.publishEditorMarks(); this.watchReadingPane(); this.decorateNotePaneInPlace(); this.sync.attach(); this.sync.syncNoteToBase(); this.updateActions();
    } catch (error) {
      if (!this.revisions.accepts(identity) || (error as Error).name === 'AbortError') return;
      if (this.session) { this.session.error = `Comparison failed: ${(error as Error).message}`; this.session.status = 'error'; }
      for (const view of this.snapshotViews()) view.updateStatus();
    }
  }
  private async resolveBase(ctx: GitContext, signal: AbortSignal): Promise<{ sha: string; label: string }> {
    const mode = this.settings.baseRefMode;
    if (mode === 'file-prev') {
      const commits = await fileLogAsync(ctx.root, ctx.rel, 2, { signal });
      if (commits.length < 2) throw new GitError('This note needs two commits to compare with its previous version.');
      return { sha: commits[1].sha, label: 'previous version' };
    }
    const ref = mode === 'custom' ? this.settings.baseRef : mode === 'head~1' ? 'HEAD~1' : 'HEAD';
    return { sha: await resolveRefAsync(ctx.root, ref, signal), label: ref };
  }
  private async noteLeaf(file: TFile, preferred?: WorkspaceLeaf): Promise<WorkspaceLeaf> {
    const active = preferred || this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
    if (active?.view instanceof MarkdownView && active.view.file?.path === file.path) return active;
    const existing = this.app.workspace.getLeavesOfType('markdown').find(leaf => leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path);
    if (existing) return existing;
    const leaf = this.app.workspace.getLeaf('tab'); await leaf.openFile(file); return leaf;
  }
  async openReview(opts: { repin?: boolean; ref?: string; label?: string; file?: TFile; leaf?: WorkspaceLeaf; commit?: CommitInfo } = {}): Promise<void> {
    const file = opts.file || this.contextFile();
    if (!file || file.extension !== 'md') { new Notice('Open a Markdown note.'); return; }
    const keep = !opts.repin && !opts.ref && !this.isHistoricalPair() && this.session?.filePath === file.path && this.session.sha
      ? { sha: this.session.sha, label: this.session.baseRefLabel } : null;
    this.closeReview(); const opening = ++this.opening; this.creating = true; this.openingFile = file.path;
    this.historyView()?.updateComparisonState();
    const signal = (this.gitJob = new AbortController()).signal;
    try {
      this.reviewLeaf = await this.noteLeaf(file, opts.leaf);
      if (opening !== this.opening) return;
      await this.app.workspace.revealLeaf(this.reviewLeaf);
      if (opening !== this.opening) return;
      this.participants.set(this.reviewLeaf, { type: 'markdown', path: file.path });
      this.creating = false; this.checkParticipants(); this.updateActions();
      const ctx = await resolveGitAsync(this.app, file, signal);
      const base = keep || (opts.ref ? { sha: await resolveRefAsync(ctx.root, opts.ref, signal), label: opts.label || opts.ref } : await this.resolveBase(ctx, signal));
      const [read, commit, breaks] = await Promise.all([readBaseAtAsync(ctx.root, ctx.rel, base.sha, signal, opts.commit?.path), commitInfoForAsync(ctx.root, base.sha, signal), this.readBreaks()]);
      if (opening !== this.opening) return;
      this.session = sessionFromRows(file, read.text, ctx, { ...base, commit, readAs: read.renamedFrom }, '', [], 0, breaks);
      this.session.status = 'updating';
      const identity = this.revisions.begin(file.path, base.sha);
      this.creating = true; this.publishEditorMarks(); await this.createSnapshot('a', this.reviewLeaf);
      if (opening === this.opening) { this.creating = false; this.checkParticipants(); await this.updateComparison(identity); }
    } catch (error) { await this.openingError(error, file, opening); }
    finally { if (opening === this.opening) { this.openingFile = null; this.creating = false; this.checkParticipants(); this.updateActions(); this.historyView()?.updateComparisonState(); } }
  }
  private async openHistorical(file: TFile, left: CommitInfo, right: CommitInfo): Promise<void> {
    this.closeReview(); const opening = ++this.opening; this.creating = true; this.openingFile = file.path;
    this.historyView()?.updateComparisonState();
    const signal = (this.gitJob = new AbortController()).signal;
    try {
      const ctx = await resolveGitAsync(this.app, file, signal);
      const [a, b, breaks] = await Promise.all([readBaseAtAsync(ctx.root, ctx.rel, left.sha, signal, left.path || undefined), readBaseAtAsync(ctx.root, ctx.rel, right.sha, signal, right.path || undefined), this.readBreaks()]);
      if (opening !== this.opening) return;
      this.session = sessionFromRows(file, a.text, ctx, { sha: left.sha, label: left.shortSha, commit: left, readAs: a.renamedFrom }, b.text, [], 0, breaks);
      this.session.endpoints[1] = { kind: 'commit', sha: right.sha, label: right.shortSha, path: b.path, commit: right };
      this.session.status = 'updating';
      const identity = this.revisions.begin(file.path, `${left.sha}..${right.sha}`);
      const rightLeaf = this.app.workspace.getLeaf('tab');
      this.participants.set(rightLeaf, { type: VIEW_TYPE, side: 'b' });
      await rightLeaf.setViewState({ type: VIEW_TYPE, state: { side: 'b' }, active: true });
      if (opening !== this.opening) return;
      await this.createSnapshot('a', rightLeaf);
      if (opening === this.opening) { this.creating = false; this.checkParticipants(); await this.updateComparison(identity); }
    } catch (error) { await this.openingError(error, file, opening); }
    finally { if (opening === this.opening) { this.openingFile = null; this.creating = false; this.checkParticipants(); this.updateActions(); this.historyView()?.updateComparisonState(); } }
  }
  private async openingError(error: unknown, file: TFile, opening: number): Promise<void> {
    if (opening !== this.opening || (error as Error).name === 'AbortError') return;
    const message = (error as Error).message; new Notice(message);
    this.session = errorSession(file, message); this.publishEditorMarks();
    if (!this.baseView()) { this.creating = true; await this.createSnapshot('a', this.reviewLeaf || this.app.workspace.getLeaf(false)); }
    for (const view of this.snapshotViews()) await view.render();
  }
  closeReview(closingLeaf?: WorkspaceLeaf): void {
    this.opening++; this.openingFile = null; this.creating = false; this.gitJob?.abort(); this.gitJob = null; this.revisions.close(); this.worker.dispose();
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.sync?.detach(); this.clearNoteDecorations();
    this.previewObserver?.disconnect(); this.previewObserver = null; this.previewRoot = null;
    if (this.previewFrame !== null) window.cancelAnimationFrame(this.previewFrame); this.previewFrame = null;
    const generated = new Set([...this.participants].filter(([, value]) => value.type === VIEW_TYPE).map(([leaf]) => leaf));
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) generated.add(leaf);
    this.participants.clear(); this.session = null; this.reviewLeaf = null; this.preferredEditor = null; this.tableIssues.clear();
    this.publishEditorMarks();
    for (const leaf of generated) if (leaf !== closingLeaf && leaf.view instanceof GitBaseView) leaf.detach();
    this.historyView()?.updateComparisonState();
    if (!this.disposed) this.updateActions();
  }
  private async createSnapshot(side: 'a' | 'b', anchor: WorkspaceLeaf): Promise<void> {
    const leaf = this.app.workspace.createLeafBySplit(anchor, 'vertical', side === 'a');
    this.participants.set(leaf, { type: VIEW_TYPE, side });
    await leaf.setViewState({ type: VIEW_TYPE, state: { side }, active: false });
  }
  private snapshotViews(): GitBaseView[] {
    return [...this.participants.keys()].map(leaf => leaf.view).filter((view): view is GitBaseView => view instanceof GitBaseView);
  }
  notePane(): NotePane | null {
    const session = this.session;
    if (!session || session.error || session.status !== 'ready') return null;
    if (this.isHistoricalPair()) {
      const view = this.snapshotViews().find(view => view.side === 'b');
      return view?.bodyEl ? { view: {}, scroller: view.bodyEl, scrollToLine: line => view.scrollToLine(line) } : null;
    }
    const view = this.reviewLeaf?.view;
    if (!(view instanceof MarkdownView) || view.file?.path !== session.filePath) return null;
    const cm = this.currentEditor();
    if (cm && view.getMode() === 'source' && cm.dom.isConnected) return { view, scroller: cm.scrollDOM, editorView: cm };
    if (view.getMode() === 'preview') { const scroller = findPreviewScroller(view); if (scroller) return { view, scroller }; }
    return null;
  }
  baseView(): GitBaseView | null { return this.snapshotViews().find(view => view.side === 'a') || null; }
  basePane(): HTMLElement | null { return this.baseView()?.bodyEl || null; }
  baseElFor(index: number): HTMLElement | null { return this.baseView()?.blockEls.get(index) || null; }
  noteLineInfo(element: HTMLElement): { lineStart: number; lineEnd: number } | undefined {
    if (element.closest('.lgd-view[data-lgd-side="b"]') && element.dataset.lineStart !== undefined)
      return { lineStart: Number(element.dataset.lineStart), lineEnd: Number(element.dataset.lineEnd) };
    return this.noteLines.get(element);
  }
  rowForNoteRange(start: number, end: number): Row | null {
    let best: Row | null = null, overlap = 0;
    for (const row of this.session?.noteRows || []) {
      const block = row.b!, n = Math.min(end, block.lineEnd) - Math.max(start, block.lineStart) + 1;
      if (n > overlap) { overlap = n; best = row; }
    }
    return best;
  }
  private decorateNoteSection(element: HTMLElement, info: { lineStart: number; lineEnd: number }): void {
    if (this.isHistoricalPair() || this.session?.status !== 'ready' || this.session.error || !this.reviewLeaf?.view.containerEl.contains(element)) return;
    const row = this.rowForNoteRange(info.lineStart, info.lineEnd);
    element.addClass(CLS.nblock); this.noteLines.set(element, info);
    if (row) element.setAttr(ATTR_ROW, String(row.idx));
    setNoteKind(element, row?.kind || null);
    if (row && row.kind !== 'same') this.marks.apply(row, element);
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
      if (!this.isHistoricalPair() && leaf === this.reviewLeaf && view instanceof MarkdownView && view.file?.path === this.session?.filePath && view.getMode() === 'preview') {
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
  toggleSync(): void { this.sync.enabled = !this.sync.enabled; for (const view of this.snapshotViews()) view.updateSyncBadge(); }
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
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); new Notice('Alignment report copied.'); }
    catch { log.warn('Clipboard unavailable', report); new Notice('Alignment report is available in the console.'); }
  }
}
