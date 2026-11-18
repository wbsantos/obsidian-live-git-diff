import { MarkdownView, Notice, Plugin, TFile, TFolder, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import type { TAbstractFile } from 'obsidian';
import * as path from 'path';
import { absPathOf } from './git.ts';
import { RepositoryCache } from './repositoryCache.ts';
import { GitRepositoryView, REPOSITORY_VIEW_TYPE } from './repositoryView.ts';
import { FILE_HISTORY_ICON, REPOSITORY_HISTORY_ICON } from './icons.ts';
import type { RepositoryRoute } from './repositoryView.ts';
import { resolveRepositoryDirectory } from './repositoryManager.ts';
import { trackedRemote, pushRepository, pullRepository } from './repositoryRemote.ts';
import { NavigationTrail } from './navigation.ts';
import { ExplainView, EXPLAIN_VIEW_TYPE } from './explainView.ts';
import { runAi, boundedContext } from './ai.ts';
import { repositoryAiContext, documentContext, comparisonContext } from './aiContext.ts';
import { errorMessage } from './errors.ts';
import type { EditorView } from '@codemirror/view';
import { GitBaseView, VIEW_TYPE } from './baseView.ts';
import type { CommitInfo, GitContext } from './git.ts';
import { GitHistoryView, HISTORY_VIEW_TYPE } from './historyView.ts';
import type { HistoryReviewState } from './historyView.ts';
import { HistoryCache } from './history.ts';
import { registerFileMenus } from './contextMenus.ts';
import { sessionFromRows, errorSession, RevisionGate } from './session.ts';
import type { Row, Session, Revision } from './session.ts';
import { ComparisonWorker } from './workerClient.ts';
import { editorPath, publish, reviewExtension, scrollEditorToLine } from './editor.ts';
import { ComparisonChrome } from './comparisonChrome.ts';
import type { ChangeMapPane } from './changeMap.ts';
import type { ChangeMarker } from './changeMapModel.ts';
import { ScrollSync } from './sync.ts';
import { ViewZones } from './viewzones.ts';
import { CharMarkLayer, unwrapCharMarks } from './charmarks.ts';
import { findPreviewScroller } from './dom.ts';
import { ATTR_ROW, CLS, setNoteKind } from './panes.ts';
import type { NotePane } from './panes.ts';
import { DEFAULT_SETTINGS, LiveGitDiffSettingTab, applyColors, clearColors, mergeSettings, persistSettings } from './settings.ts';
import type { LiveGitDiffSettings } from './settings.ts';
import * as log from './log.ts';
import { resolveRepository, resolveRevision, previousReviewBase, revisionInfo, snapshotWorkspace, snapshotNote, readRevision, SNAPSHOT_DELAY } from './repository.ts';

type NavigationRoute = RepositoryRoute | { kind: 'file'; filePath: string; context?: GitContext; revision?: string };

/** Note editing belongs to Obsidian; explicit VCS actions have independent lifetimes. */
export default class LiveGitDiffPlugin extends Plugin {
  settings: LiveGitDiffSettings = DEFAULT_SETTINGS;
  session: Session | null = null;
  historyCache = new HistoryCache();
  repositoryCache = new RepositoryCache(() => this.scheduleCacheSave());
  private navigation = new NavigationTrail<NavigationRoute>(route => JSON.stringify(route.kind === 'file'
    ? [route.kind, route.filePath, route.revision] : [route.kind, route.context.root, route.kind === 'details' ? route.sha : route.kind === 'log' ? route.path : route.paths]));
  private cacheSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private navigationRequest = 0;
  private explainRequest = 0;
  private remoteJobs = new Map<string, AbortController>();
  private historicalContext: GitContext | null = null;
  zones!: ViewZones;
  sync!: ScrollSync;
  private marks!: CharMarkLayer;
  private comparisonChrome = new ComparisonChrome();
  private worker = new ComparisonWorker();
  private revisions = new RevisionGate();
  private editors = new Set<EditorView>();
  private preferredEditor: EditorView | null = null;
  private reviewLeaf: WorkspaceLeaf | null = null;
  private participants = new Map<WorkspaceLeaf, { type: string; path?: string; side?: 'a' | 'b' }>();
  private actions = new Map<MarkdownView, { compare: HTMLElement; history: HTMLElement; repository: HTMLElement }>();
  private tableIssues = new Map<EditorView, string>();
  private noteLines = new WeakMap<HTMLElement, { lineStart: number; lineEnd: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private gitJob: AbortController | null = null;
  private opening = 0;
  private openingFile: string | null = null;
  private historyOpening = 0;
  private historyCreation: Promise<void> | null = null;
  private snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private snapshotWorkspaces = new Map<string, GitContext>();
  private snapshotRibbon: HTMLElement | null = null;
  private snapshotRibbonContext: GitContext | null = null;
  private snapshotRibbonTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotRibbonRequest = 0;
  private snapshotRibbonBusy = false;
  private quitting = false;
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
    this.registerView(REPOSITORY_VIEW_TYPE, leaf => new GitRepositoryView(leaf, this));
    this.registerView(EXPLAIN_VIEW_TYPE, leaf => new ExplainView(leaf));
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
    this.addCommand({ id: 'repository-history', name: 'Open repository history', callback: () => { void this.openRepository(); } });
    this.addCommand({ id: 'repository-changes', name: 'Open VCS Pending Changes', callback: () => { void this.openChanges(); } });
    for (const action of ['push', 'pull'] as const) this.addCommand({ id: `repository-${action}`,
      name: action === 'push' ? 'Push to remote' : 'Pull from remote', callback: () => { void this.syncCurrentRepository(action); } });
    this.addRibbonIcon?.(REPOSITORY_HISTORY_ICON, 'Repository history', () => { void this.openRepository(); });
    this.snapshotRibbon = this.addRibbonIcon?.('camera', 'Snapshot working copy (entire repository)', () => { void this.snapshotCurrentWorkspace(); }) || null;
    this.snapshotRibbon?.addClass('lgd-snapshot-action');
    if (this.snapshotRibbon) this.snapshotRibbon.hidden = true;
    this.registerEvent(this.app.workspace.on('quit', tasks => {
      if (this.quitting) return;
      this.quitting = true;
      for (const timer of this.snapshotTimers.values()) clearTimeout(timer);
      this.snapshotTimers.clear();
      if (this.snapshotRibbonTimer) clearTimeout(this.snapshotRibbonTimer);
      // Capture panel contexts before Obsidian unloads their views. The quit task
      // must remain valid even if plugin teardown happens before it finishes.
      for (const leaf of this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)) {
        const context = (leaf.view as GitHistoryView).controller.state.entry?.context;
        if (context) this.rememberSnapshotWorkspace(context);
      }
      for (const leaf of this.app.workspace.getLeavesOfType(REPOSITORY_VIEW_TYPE)) {
        const context = (leaf.view as GitRepositoryView).currentRoute?.context;
        if (context) this.rememberSnapshotWorkspace(context);
      }
      const active = this.app.workspace.getActiveFile();
      tasks.add(() => this.snapshotBeforeQuit(active));
    }));
    this.registerMarkdownPostProcessor((element, context) => {
      if (element.closest('.lgd-view') || context.sourcePath !== this.session?.filePath) return;
      const info = context.getSectionInfo(element); if (info) this.decorateNoteSection(element, info);
      // Postprocessors may run before the section is attached to its leaf.
      this.scheduleReadingPaint();
    });
    this.registerEvent(this.app.workspace.on('layout-change', () => this.scheduleLayout()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => { this.scheduleLayout(); this.scheduleSnapshotRibbonUpdate(); }));
    this.registerEvent(this.app.workspace.on('file-open', () => { this.scheduleLayout(); this.scheduleSnapshotRibbonUpdate(); }));
    this.registerEvent(this.app.workspace.on('resize', () => this.sync.attach()));
    this.registerEvent(this.app.vault.on('modify', file => {
      if(file instanceof TFile && (file.path===this.session?.filePath || file.path===this.historyView()?.controller.state.file?.path)) {
        void this.scheduleSavedSnapshot(file);
      }
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
      this.scheduleLayout();
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      const contains = (path?: string): boolean => !!path && (path === file.path || path.startsWith(file.path + '/'));
      if (contains(this.session?.filePath) || contains(this.openingFile || undefined)) this.closeReview();
      const view = this.historyView();
      if (contains(view?.controller.state.file?.path)) view!.controller.fileUnavailable();
      this.scheduleLayout();
    }));
    this.app.workspace.onLayoutReady(() => {
      if (!this.disposed) {
        if (!this.session) this.app.workspace.detachLeavesOfType(VIEW_TYPE);
        this.scheduleLayout();
        this.scheduleSnapshotRibbonUpdate();
      }
    });
  }
  onunload(): void {
    for (const job of this.remoteJobs.values()) job.abort();
    if (this.cacheSaveTimer) { clearTimeout(this.cacheSaveTimer); this.cacheSaveTimer = null; void persistSettings(this).catch(error => log.warn('Unable to save history cache', error)); }
    for(const timer of this.snapshotTimers.values()) clearTimeout(timer);this.snapshotTimers.clear();
    if (this.snapshotRibbonTimer) clearTimeout(this.snapshotRibbonTimer);
    this.snapshotRibbonRequest++;
    this.disposed = true; this.closeReview(); this.historyCache.dispose();
    this.app.workspace.detachLeavesOfType(HISTORY_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(REPOSITORY_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(EXPLAIN_VIEW_TYPE);
    for (const buttons of this.actions.values()) { buttons.compare.remove(); buttons.history.remove(); buttons.repository.remove(); }
    this.actions.clear(); this.sync.dispose(); this.zones.dispose(); clearColors();
  }
  private async scheduleSavedSnapshot(file: TFile): Promise<void> {
    try {
      const ctx=await resolveRepository(this.app,file);
      this.rememberSnapshotWorkspace(ctx);
      if(ctx.backend!=='jj' || this.disposed || this.quitting) return;
      const key=ctx.workspaceRoot! + '\0' + ctx.rel;
      clearTimeout(this.snapshotTimers.get(key));
      this.snapshotTimers.set(key,setTimeout(()=>{this.snapshotTimers.delete(key);void this.snapshotSavedNote(file);},SNAPSHOT_DELAY));
    } catch(error) { log.warn('Unable to schedule snapshot',error); }
  }
  private async snapshotSavedNote(file: TFile): Promise<void> {
    if(this.disposed || this.quitting) return;
    try {
      const ctx=await resolveRepository(this.app,file);
      this.rememberSnapshotWorkspace(ctx);
      if(ctx.backend!=='jj' || this.disposed || this.quitting) return;
      if (!await snapshotNote(ctx)) return;
      if(!this.disposed && this.historyView()?.controller.state.entry?.context.workspaceRoot===ctx.workspaceRoot) await this.historyView()?.controller.refresh();
    } catch(error) {
      log.warn('Unable to snapshot saved note',error);
      if(this.historyView()?.controller.state.file?.path===file.path) this.historyView()?.controller.reportError(`Unable to snapshot saved note: ${error}`);
    }
  }
  private rememberSnapshotWorkspace(context: GitContext): void {
    if (context.backend !== 'jj' || !context.workspaceRoot) return;
    const root = path.resolve(context.workspaceRoot);
    this.snapshotWorkspaces.set(process.platform === 'win32' ? root.toLowerCase() : root, context);
  }
  private async resolveSnapshotContext(): Promise<GitContext> {
    const view = this.app.workspace.activeLeaf?.view;
    const file = this.app.workspace.getActiveFile();
    const context = view instanceof GitRepositoryView && view.currentRoute ? view.currentRoute.context
      : view instanceof GitHistoryView && view.controller.state.entry ? view.controller.state.entry.context
      : file ? await resolveRepository(this.app, file)
      : await resolveRepositoryDirectory(this.app, '');
    this.rememberSnapshotWorkspace(context);
    return context;
  }
  private scheduleSnapshotRibbonUpdate(): void {
    if (!this.snapshotRibbon || this.disposed || this.quitting) return;
    if (this.snapshotRibbonTimer) clearTimeout(this.snapshotRibbonTimer);
    this.snapshotRibbonTimer = setTimeout(() => { this.snapshotRibbonTimer = null; void this.updateSnapshotRibbon(); }, 150);
  }
  private async updateSnapshotRibbon(): Promise<void> {
    const request = ++this.snapshotRibbonRequest;
    try {
      const context = await this.resolveSnapshotContext();
      if (request !== this.snapshotRibbonRequest || this.disposed || this.quitting) return;
      this.snapshotRibbonContext = context.backend === 'jj' ? context : null;
    } catch { if (request === this.snapshotRibbonRequest) this.snapshotRibbonContext = null; }
    if (request === this.snapshotRibbonRequest && this.snapshotRibbon) this.snapshotRibbon.hidden = !this.snapshotRibbonContext;
  }
  private async snapshotCurrentWorkspace(): Promise<void> {
    if (this.snapshotRibbonBusy || this.disposed || this.quitting) return;
    this.snapshotRibbonBusy = true; this.snapshotRibbon?.setAttr('aria-busy', 'true');
    let progress: Notice | undefined;
    try {
      const context = await this.resolveSnapshotContext();
      if (context.backend !== 'jj') { new Notice('Snapshots are only available in Jujutsu workspaces.'); return; }
      progress = new Notice('Snapshotting the entire Jujutsu workspace…', 0);
      await snapshotWorkspace(context);
      if (!this.disposed && !this.quitting) {
        await this.repositoryChanged(context);
        if (this.repositoryView()?.currentRoute?.context.root === context.root) await this.repositoryView()?.refresh();
        new Notice('Workspace snapshot saved.');
      }
    } catch (error) { log.warn('Unable to snapshot workspace', error); if (!this.disposed && !this.quitting) new Notice(`Unable to snapshot workspace: ${errorMessage(error)}`, 10_000); }
    finally { progress?.hide(); this.snapshotRibbonBusy = false; this.snapshotRibbon?.setAttr('aria-busy', 'false'); }
  }
  private async snapshotBeforeQuit(active: TFile | null): Promise<void> {
    // Always discover the vault's repository, even when no note/history is open.
    // A vault may be a subdirectory of its JJ workspace; snapshotWorkspace has no fileset.
    const candidates = [resolveRepositoryDirectory(this.app, '')];
    if (active) candidates.push(resolveRepository(this.app, active));
    for (const result of await Promise.allSettled(candidates)) {
      if (result.status === 'fulfilled') this.rememberSnapshotWorkspace(result.value);
      else log.debug('No snapshot workspace could be resolved at quit', result.reason);
    }
    await Promise.all([...this.snapshotWorkspaces.values()].map(async context => {
      try { await snapshotWorkspace(context); }
      catch (error) {
        log.warn('Unable to snapshot workspace before quit', context.workspaceRoot, error);
        new Notice(`Unable to snapshot before closing: ${errorMessage(error)}`, 10_000);
      }
    }));
  }
  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = mergeSettings(data); this.repositoryCache.hydrate(data?.repositoryHistoryCache);
    log.setDebug(this.settings.debug); applyColors(this.settings);
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
  historyActiveFile(): TFile | null {
    // Obsidian excludes sidebars and includes pop-outs when resolving the content leaf.
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (!leaf) return null;
    let alive = false;
    this.app.workspace.iterateAllLeaves(candidate => { if (candidate === leaf) alive = true; });
    if (!alive) return null;
    const view = leaf.view, participant = this.participants.get(leaf);
    const file = view instanceof MarkdownView ? view.file :
      view instanceof GitBaseView && participant?.type === VIEW_TYPE && participant.side === view.side && this.session
        ? this.app.vault.getAbstractFileByPath(this.session.filePath) : null;
    return file instanceof TFile && file.extension === 'md' && this.app.vault.getAbstractFileByPath(file.path) === file ? file : null;
  }
  private scheduleLayout(): void {
    if (this.disposed) return;
    if (this.layoutPending) return;
    this.layoutPending = true;
    queueMicrotask(() => {
      this.layoutPending = false; if (this.disposed) return;
      this.checkParticipants(); this.updateActions(); this.publishEditorMarks();
      this.watchReadingPane(); this.decorateNotePaneInPlace(); this.sync.attach();
      this.historyView()?.updateActiveFile();
      if (this.session) void this.checkBreaks();
    });
  }
  private updateActions(): void {
    const views = new Set(this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView));
    for (const [view, buttons] of this.actions) if (!views.has(view)) {
      buttons.compare.remove(); buttons.history.remove(); buttons.repository.remove(); this.actions.delete(view);
    }
    for (const view of views) {
      let buttons = this.actions.get(view);
      if (!buttons || !view.containerEl.contains(buttons.compare)) {
        buttons?.compare.remove(); buttons?.history.remove(); buttons?.repository.remove();
        buttons = {
          compare: view.addAction('git-compare', 'Compare', () => {
            if (this.participants.has(view.leaf)) this.closeReview();
            else if (view.file) void this.openReview({ file: view.file, leaf: view.leaf });
          }),
          history: view.addAction(FILE_HISTORY_ICON, 'VCS History', () => { void this.openHistory(view.file); }),
          repository: view.addAction(REPOSITORY_HISTORY_ICON, 'Repository history', () => { void this.openRepository(view.file || undefined); }),
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
  private repositoryView(): GitRepositoryView | null {
    const view = this.app.workspace.getLeavesOfType(REPOSITORY_VIEW_TYPE)[0]?.view;
    return view instanceof GitRepositoryView ? view : null;
  }
  navigationState(): { back: boolean; forward: boolean } { return this.navigation.state; }
  navigationBack(): void { const route = this.navigation.back(); if (route) void this.showNavigation(route); }
  navigationForward(): void { const route = this.navigation.forward(); if (route) void this.showNavigation(route); }
  private updateNavigation(): void { this.historyView()?.updateNavigation?.(); this.repositoryView()?.updateNavigation(); }
  private async showNavigation(route: NavigationRoute): Promise<void> {
    const request = ++this.navigationRequest;
    try {
      if (route.kind === 'file') {
        const file = this.app.vault.getAbstractFileByPath(route.filePath);
        if (file instanceof TFile) await this.openHistory(file, false);
        else if (route.context && route.revision) {
          await this.openHistory(null, false);
          if (request === this.navigationRequest) await this.historyView()?.setHistoricalFile(route.filePath, route.context, route.revision);
        } else throw new Error('The file is no longer available.');
      } else {
        let view = this.repositoryView();
        if (!view) {
          const leaf = this.app.workspace.getRightLeaf(false); if (!leaf) return;
          await leaf.setViewState({ type: REPOSITORY_VIEW_TYPE, active: true });
          view = leaf.view instanceof GitRepositoryView ? leaf.view : null;
        }
        if (request !== this.navigationRequest || this.disposed || !view) return;
        await this.app.workspace.revealLeaf(view.leaf);
        if (request !== this.navigationRequest || this.disposed) return;
        await view.setRoute(route);
      }
    } catch (error) { if (request === this.navigationRequest) new Notice(`Unable to navigate: ${(error as Error).message}`); }
    if (request === this.navigationRequest) this.updateNavigation();
  }
  async navigateRepository(route: RepositoryRoute): Promise<void> {
    this.rememberSnapshotWorkspace(route.context);
    this.navigation.push(route); await this.showNavigation(route);
  }
  private async contextRepository(target?: TAbstractFile | null): Promise<GitContext> {
    if (target instanceof TFile) return resolveRepository(this.app, target);
    if (target instanceof TFolder) return resolveRepositoryDirectory(this.app, target.path);
    const current = this.navigation.current;
    if (current && current.kind !== 'file') return current.context;
    const file = this.contextFile();
    return file ? resolveRepository(this.app, file) : resolveRepositoryDirectory(this.app, '');
  }
  async openRepository(target?: TAbstractFile): Promise<void> {
    try {
      const context = await this.contextRepository(target);
      await this.navigateRepository({ kind: 'log', context, path: target instanceof TFolder ? context.rel || undefined : undefined });
    } catch (error) { new Notice(`Unable to open repository history: ${(error as Error).message}`); }
  }
  async openChanges(target?: TAbstractFile): Promise<void> {
    try {
      const context = await this.contextRepository(target);
      await this.navigateRepository({ kind: 'changes', context, paths: target && context.rel ? [context.rel] : undefined });
    } catch (error) { new Notice(`Unable to open pending changes: ${(error as Error).message}`); }
  }
  async openChangeDetails(context: GitContext, sha: string): Promise<void> { await this.navigateRepository({ kind: 'details', context, sha }); }
  async openRepositoryHistory(context: GitContext): Promise<void> { await this.navigateRepository({ kind: 'log', context }); }
  private repositoryVaultPath(context: GitContext, relative: string): string {
    // Reconstruct the logical root as well as the physical Git root, preserving vault junctions.
    const root = path.resolve(context.abs, ...context.rel.split('/').filter(Boolean).map(() => '..'));
    const vault = absPathOf(this.app, { path: '' } as TFile);
    const result = path.relative(vault, path.resolve(root, relative)).replace(/\\/g, '/');
    if (result === '..' || result.startsWith('../') || path.isAbsolute(result)) throw new Error('This file is outside the vault.');
    return result;
  }
  async openRepositoryFile(context: GitContext, relative: string, revision?: string): Promise<void> {
    try {
      const filePath = this.repositoryVaultPath(context, relative);
      const file = this.app.vault.getAbstractFileByPath(filePath);
      const archivedContext = { ...context, rel: relative, abs: absPathOf(this.app, { path: filePath } as TFile) };
      if (!(file instanceof TFile) && !revision) throw new Error('The file is no longer available. Open it from a change.');
      const route: NavigationRoute = { kind: 'file', filePath, context: archivedContext, revision };
      this.navigation.push(route); await this.showNavigation(route);
    } catch (error) { new Notice((error as Error).message); }
  }
  async openRepositoryNote(context: GitContext, relative: string): Promise<void> {
    try {
      const file = this.app.vault.getAbstractFileByPath(this.repositoryVaultPath(context, relative));
      if (!(file instanceof TFile)) throw new Error('The file is no longer available in the vault.');
      await this.app.workspace.getLeaf('tab').openFile(file);
    } catch (error) { new Notice((error as Error).message); }
  }
  loadRepositoryHistory(context: GitContext, folder: string | undefined, offset: number, limit: number, signal?: AbortSignal) {
    return this.repositoryCache.load(context, folder, offset, limit, signal);
  }
  async repositoryChanged(context: GitContext): Promise<void> {
    this.repositoryCache.invalidate(context.root);
    const history = this.historyView();
    if (history?.controller.state.entry?.context.root === context.root) await history.controller.refresh();
  }
  private async remoteContext(): Promise<GitContext> {
    const view = this.app.workspace.activeLeaf?.view;
    if (view instanceof GitRepositoryView && view.currentRoute) return view.currentRoute.context;
    if (view instanceof GitHistoryView && view.controller.state.entry) return view.controller.state.entry.context;
    const file = this.app.workspace.getActiveFile();
    return this.contextRepository(file || undefined);
  }
  private async syncCurrentRepository(action: 'push' | 'pull'): Promise<void> {
    try { await this.syncRepository(await this.remoteContext(), action); }
    catch (error) { if (!this.disposed) new Notice((error as Error).message, 10_000); }
  }
  async syncRepository(context: GitContext, action: 'push' | 'pull', revision?: string): Promise<void> {
    if (this.remoteJobs.has(context.root)) throw new Error('A remote operation is already running.');
    const job = new AbortController(); this.remoteJobs.set(context.root, job);
    let progress: Notice | undefined, started = false;
    try {
      const target = await trackedRemote(context, job.signal);
      if (job.signal.aborted || this.disposed) return;
      progress = new Notice(`${action === 'push' ? 'Pushing to' : 'Pulling from'} ${target.remote}/${target.branch}…`, 0);
      started = true;
      const result = action === 'push'
        ? await pushRepository(context, target, job.signal, revision)
        : await pullRepository(context, target, job.signal);
      if (!this.disposed) new Notice(result.message);
    } finally {
      progress?.hide(); this.remoteJobs.delete(context.root);
      // Fetch can update refs even when integration is refused; refresh caches in both cases.
      if (started && !this.disposed) {
        await this.repositoryChanged(context).catch(error => log.warn('Unable to refresh after remote operation', error));
        if (this.repositoryView()?.currentRoute?.context.root === context.root)
          await this.repositoryView()?.refresh();
      }
    }
  }
  private scheduleCacheSave(): void {
    if (this.disposed || this.cacheSaveTimer) return;
    this.cacheSaveTimer = setTimeout(() => {
      this.cacheSaveTimer = null;
      void persistSettings(this).catch(error => log.warn('Unable to save history cache', error));
    }, 1000);
  }
  async resetHistoryCache(): Promise<void> {
    this.repositoryCache.clear();
    await persistSettings(this);
    await this.repositoryView()?.refresh();
    await this.historyView()?.controller.refresh();
  }
  /** Used only for a live note already opened by Obsidian's file-history view. */
  private async readRepositoryVaultWorking(context: GitContext, relative: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(this.repositoryVaultPath(context, relative));
    if (!(file instanceof TFile)) throw new Error('The file is not available in this vault.');
    if (file.stat.size > 1_048_576) return '[Large file content omitted.]';
    return this.app.vault.read(file);
  }
  async generateDescription(context: GitContext, paths: string[], token: string, signal: AbortSignal): Promise<string> {
    const settings = { ...this.settings.ai.description };
    const evidence = await repositoryAiContext(context, { paths, token }, signal);
    return runAi(settings, evidence, 'description', signal);
  }
  private async showExplain(title: string, prepare: (signal: AbortSignal) => Promise<string>): Promise<void> {
    const request = ++this.explainRequest;
    try {
      let view = this.app.workspace.getLeavesOfType(EXPLAIN_VIEW_TYPE)[0]?.view;
      if (!(view instanceof ExplainView)) {
        const leaf = this.app.workspace.getRightLeaf(true); if (!leaf) return;
        await leaf.setViewState({ type: EXPLAIN_VIEW_TYPE, active: true }); view = leaf.view;
      }
      if (!(view instanceof ExplainView) || this.disposed || request !== this.explainRequest) return;
      await this.app.workspace.revealLeaf(view.leaf);
      const settings = { ...this.settings.ai.explain };
      await view.explain(title, async signal => runAi(settings, await prepare(signal), 'explain', signal));
    } catch (error) { new Notice(`Unable to explain: ${(error as Error).message}`); }
  }
  async explainFile(file: TFile): Promise<void> {
    await this.showExplain(file.path, async () => documentContext(file.path,
      this.liveNoteText(file.path) ?? (file.stat.size > 1_048_576 ? '[Large file content omitted.]' : await this.app.vault.read(file))));
  }
  async explainRepository(context: GitContext, options: { sha?: string; paths?: string[]; token?: string }): Promise<void> {
    await this.showExplain(options.paths?.length === 1 ? options.paths[0] : options.sha ? `Change ${options.sha.slice(0, 8)}` : 'Pending changes',
      signal => repositoryAiContext(context, options, signal));
  }
  async explainHistory(filePath: string, context: GitContext, commits: readonly CommitInfo[]): Promise<void> {
    const captured = commits.map(commit => ({ ...commit }));
    await this.showExplain(captured.length === 2 ? `${filePath} · ${captured.map(c => c.shortSha).join(' → ')}` : filePath, async signal => {
      const read = async (commit: CommitInfo): Promise<string> => commit.kind === 'workcopy'
        ? this.liveNoteText(filePath) ?? await this.readRepositoryVaultWorking(context, context.rel)
        : (await readRevision(context, commit, signal)).text;
      if (captured.length === 1) return documentContext(`${filePath} at ${captured[0].shortSha}`, boundedContext(await read(captured[0])));
      const [before, after] = await Promise.all(captured.map(read));
      return comparisonContext(filePath, before, after, captured[0].shortSha, captured[1].shortSha);
    });
  }
  historyReviewState(): HistoryReviewState {
    const s = this.session;
    return { openingFile: this.openingFile, error: s?.error || null,
      active: s?.sha && !s.error ? { filePath: s.filePath, left: s.sha.slice(0, 7),
        right: s.endpoints[1].kind === 'commit' ? s.endpoints[1].sha.slice(0, 7) : 'Working tree' } : null };
  }
  async openHistory(file: TFile | null = this.contextFile(), record = true): Promise<void> {
    const navigationRequest = record ? ++this.navigationRequest : this.navigationRequest;
    if (record && file) this.navigation.push({ kind: 'file', filePath: file.path });
    const request = ++this.historyOpening;
    if (!this.historyCreation && !this.historyView()) {
      const leaf = this.app.workspace.getRightLeaf(false); if (!leaf) return;
      this.historyCreation = leaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true });
    }
    if (this.historyCreation) {
      const creation = this.historyCreation;
      try { await creation; }
      finally { if (this.historyCreation === creation) this.historyCreation = null; }
    }
    if (this.disposed || request !== this.historyOpening || navigationRequest !== this.navigationRequest) return;
    const view = this.historyView();
    if (!view) return;
    for (const leaf of this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)) if (leaf !== view.leaf) leaf.detach();
    void view.setFile(file); await this.app.workspace.revealLeaf(view.leaf); this.updateNavigation();
  }
  async compareHistory(filePath: string, commits: readonly CommitInfo[]): Promise<void> {
    if (this.openingFile) return;
    if (commits.length !== 2 || commits[0].sha===commits[1].sha) throw new Error('Select two distinct versions to compare.');
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!filePath.toLowerCase().endsWith('.md')) throw new Error('Comparison is available for Markdown files.');
    if (!(file instanceof TFile)) {
      const history = this.historyView()?.controller.state;
      if (history?.file?.path !== filePath || !history.file.historicalHead || !history.entry || commits.some(c => c.kind === 'workcopy')) throw new Error('The note is no longer available.');
      await this.openHistorical({ path: filePath, name: history.file.name } as TFile, commits[0], commits[1], history.entry.context);
      return;
    }
    const ctx=await resolveRepository(this.app,file);await snapshotNote(ctx);
    const historical=commits.filter(c=>c.kind!=='workcopy');
    if(historical.length===1) await this.openReview({file,ref:historical[0].sha,label:historical[0].shortSha,commit:historical[0]});
    else await this.openHistorical(file,commits[0],commits[1]);
  }
  swapSides(): void {
    const s = this.session;
    const [left, right] = s?.endpoints || [];
    const file = s && this.app.vault.getAbstractFileByPath(s.filePath);
    if (s && left?.kind === 'commit' && right?.kind === 'commit' && left.commit && right.commit) {
      const historical = this.historicalContext;
      if (file instanceof TFile || historical) void this.openHistorical(file instanceof TFile ? file : { path: s.filePath, name: s.fileName } as TFile, right.commit, left.commit, historical || undefined);
    }
  }
  private liveNoteText(filePath: string): string | undefined {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    const view = active?.file?.path === filePath ? active : this.app.workspace.getLeavesOfType('markdown')
      .map(leaf => leaf.view).find((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === filePath && view.getMode() === 'source');
    return view?.getMode() === 'source' ? view.editor.getValue() : undefined;
  }
  async historyWorkcopyText(filePath: string): Promise<string | undefined> {
    const live = this.liveNoteText(filePath);
    if (live !== undefined) return live;
    const file = this.app.vault.getAbstractFileByPath(filePath);
    return file instanceof TFile ? this.app.vault.read(file) : undefined;
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
  editorGeometryChanged(): void { this.comparisonChrome.refresh(); }
  comparisonRendered(): void { this.updateComparisonChrome(); }
  editorTablePresentationIssue(view: EditorView, message: string | null): void {
    if (message) this.tableIssues.set(view, message); else this.tableIssues.delete(view);
    for (const snapshot of this.snapshotViews()) snapshot.updateStatus();
    this.updateComparisonChrome();
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
    this.updateComparisonChrome();
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
      const available = this.app.vault.getAbstractFileByPath(identity.filePath);
      if (!(available instanceof TFile) && !this.isHistoricalPair()) throw new Error('The note is no longer available.');
      const file = available instanceof TFile ? available : { path: previous.filePath, name: previous.fileName } as TFile;
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
  private async resolveBase(ctx: GitContext, signal: AbortSignal, workingText?: string): Promise<{ sha: string; label: string }> {
    const mode = this.settings.baseRefMode;
    if (mode === 'file-prev') {
      return previousReviewBase(ctx, signal, workingText);
    }
    const ref = mode === 'custom' ? this.settings.baseRef : mode === 'head~1' ? 'HEAD~1' : 'HEAD';
    return { sha: await resolveRevision(ctx, ref, signal), label: ref };
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
      const ctx = await resolveRepository(this.app, file, signal);
      this.rememberSnapshotWorkspace(ctx);
      await snapshotNote(ctx,signal);
      const base = keep || (opts.ref ? { sha: await resolveRevision(ctx, opts.ref, signal), label: opts.label || opts.ref } : await this.resolveBase(ctx, signal, this.liveNoteText(file.path) ?? undefined));
      const [read, commit, breaks] = await Promise.all([readRevision(ctx, {...(opts.commit || {shortSha:base.sha.slice(0,8),subject:'',relative:'',date:'',path:ctx.rel}),sha:base.sha}, signal), revisionInfo(ctx, base.sha, signal), this.readBreaks()]);
      if (opening !== this.opening) return;
      this.session = sessionFromRows(file, read.text, ctx, { ...base, commit, readAs: read.renamedFrom }, '', [], 0, breaks);
      this.session.status = 'updating';
      const identity = this.revisions.begin(file.path, base.sha);
      this.creating = true; this.publishEditorMarks(); await this.createSnapshot('a', this.reviewLeaf);
      if (opening === this.opening) { this.creating = false; this.checkParticipants(); await this.updateComparison(identity); }
    } catch (error) { await this.openingError(error, file, opening); }
    finally { if (opening === this.opening) { this.openingFile = null; this.creating = false; this.checkParticipants(); this.updateActions(); this.historyView()?.updateComparisonState(); } }
  }
  private async openHistorical(file: TFile, left: CommitInfo, right: CommitInfo, context?: GitContext): Promise<void> {
    this.closeReview(); const opening = ++this.opening; this.creating = true; this.openingFile = file.path;
    this.historyView()?.updateComparisonState();
    const signal = (this.gitJob = new AbortController()).signal;
    try {
      const ctx = context || await resolveRepository(this.app, file, signal);
      this.historicalContext = ctx;
      const [a, b, breaks] = await Promise.all([readRevision(ctx,left,signal), readRevision(ctx,right,signal), this.readBreaks()]);
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
    this.comparisonChrome.reset();
    this.historicalContext = null;
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
  private updateComparisonChrome(): void {
    const session = this.session, snapshots = this.snapshotViews();
    const live = session?.endpoints[1].kind === 'worktree' && this.reviewLeaf?.view instanceof MarkdownView
      && this.reviewLeaf.view.file?.path === session.filePath ? this.reviewLeaf.view.contentEl : null;
    const panes: ChangeMapPane[] = [];
    if (session?.status === 'ready' && !session.error) {
      for (const view of snapshots) if (view.bodyEl) {
        const scroller = view.bodyEl;
        panes.push({ side: view.side, container: view.contentEl, scroller, content: scroller.firstElementChild as HTMLElement | null,
          range: marker => {
            const element = view.blockEls.get(marker.row) || view.spacerEls.get(marker.row);
            if (!element) {
              const top = view.offsetForLine(marker.lineStart);
              return top === null ? null : { top, bottom: top };
            }
            const rect = element.getBoundingClientRect();
            const top = rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
            return { top, bottom: top + rect.height };
          },
          navigate: marker => this.navigateComparisonChange(view.side, marker),
        });
      }
      const note = live && this.notePane();
      if (note) {
        const editor = note.editorView, scroller = note.scroller;
        panes.push({ side: 'b', container: live, scroller,
          content: editor?.contentDOM || scroller.querySelector<HTMLElement>('.markdown-preview-sizer'),
          range: marker => {
            if (!editor) return null; // Reading mode virtualizes off-screen blocks: keep stable source-line estimates.
            const doc = editor.state.doc;
            const first = editor.lineBlockAt(doc.line(Math.min(doc.lines, marker.lineStart + 1)).from);
            const last = editor.lineBlockAt(doc.line(Math.min(doc.lines, marker.lineEnd + 1)).from);
            const offset = editor.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
            return { top: first.top + offset, bottom: (marker.missing ? first.top : last.bottom) + offset };
          },
          navigate: marker => this.navigateComparisonChange('b', marker),
        });
      }
    }
    this.comparisonChrome.update(session, live, snapshots.flatMap(view => view.header ? [view.header] : []), panes,
      this.sync?.enabled ?? true, this.presentationWarning());
  }
  private navigateComparisonChange(side: 'a' | 'b', marker: ChangeMarker): void {
    const row = this.session?.rows[marker.row];
    // On an absent side, the other document holds the actual change being requested.
    if (marker.missing && this.sync.enabled && row) {
      if (side === 'b' && row.a) { this.baseView()?.scrollToLine(row.a.lineStart); this.sync.syncBaseToNote(); return; }
      if (side === 'a' && row.b) { this.scrollComparedToLine(row.b.lineStart); return; }
    }
    if (side === 'a') this.baseView()?.scrollToLine(marker.lineStart);
    else this.scrollComparedToLine(marker.lineStart);
  }
  private scrollComparedToLine(line: number): void {
    const note = this.notePane();
    if (note?.editorView) scrollEditorToLine(note.editorView, line);
    else if (note?.scrollToLine) note.scrollToLine(line);
    // Explicit navigation must wait for unmeasured Reading-mode sections to render.
    // The public ephemeral-state API retries that jump; continuous sync stays on applyScroll.
    else if (note?.view.setEphemeralState) note.view.setEphemeralState({ line: Math.round(line) });
    else if (note) this.sync.applyNoteScroll(note.view, line);
  }
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
  toggleSync(): void {
    this.sync.enabled = !this.sync.enabled;
    for (const view of this.snapshotViews()) view.updateSyncBadge();
    this.updateComparisonChrome();
  }
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
