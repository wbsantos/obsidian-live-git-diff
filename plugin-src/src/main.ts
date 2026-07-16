/**
 * Live Git Diff — side-by-side RENDERED review of a note against its git version.
 *
 * THE SHAPE, AND WHY IT IS ASYMMETRIC
 * -----------------------------------
 * LEFT  pane: a custom read-only ItemView rendering the git base version, fetched into
 *             memory with `git show`. Never lands on disk. (baseView.ts)
 * RIGHT pane: the REAL note in a NORMAL markdown leaf, decorated only by adding CSS
 *             classes to block containers via a markdown post-processor.
 *
 * The right pane being a real note leaf is the entire reason annotation plugins and TTS
 * keep working — they attach to a real file with a real sourcePath. The unlock that
 * makes the asymmetry legal: comments are only ever needed on the CURRENT side, so the
 * old version needs no getSectionInfo() and no annotation support.
 *
 * READ-ONLY INVARIANT
 * -------------------
 * This plugin never alters any note. Its entire effect on the world is: spawn `git` to
 * read text, read note text, build DOM, add CSS classes, and persist its own settings
 * to the plugin's config file. It imports no filesystem module at all.
 *
 * Two consequences worth stating, because they look odd on purpose:
 *  1. The invariant is checked by grepping the BUILT bundle for WRITE METHODS, not for
 *     the filesystem handle. An earlier draft dodged a handle-shaped grep by
 *     destructuring; that made the check pass by phrasing rather than by fact, so the
 *     check was narrowed instead. The one thing used from the vault adapter is
 *     absolute-path resolution — pure string math, no I/O. See tools/check-invariant.mjs.
 *  2. Rails/highlights are CSS only (backgrounds, ::before bars). We never touch text
 *     nodes or inject text inside a rendered block — doing so silently breaks
 *     annotation plugins' anchors. charmarks.ts asserts that at runtime.
 */
import {
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from 'obsidian';

import { CharMarkLayer, unwrapCharMarks } from './charmarks.ts';
import { findPreviewScroller, topmostVisible } from './dom.ts';
import { GitBaseView, VIEW_TYPE } from './baseView.ts';
import { GitError, headSha, resolveGit, resolveRef, showAt } from './git.ts';
import { ATTR_ROW, CLS } from './panes.ts';
import type { BasePaneLike, NotePane } from './panes.ts';
import { buildSession, errorSession } from './session.ts';
import type { Row, Session } from './session.ts';
import { ScrollSync } from './sync.ts';
import type { SyncHost } from './sync.ts';
import { ViewZones } from './viewzones.ts';
import {
  DEFAULT_SETTINGS,
  LiveGitDiffSettingTab,
  applyColors,
  clearColors,
  mergeSettings,
  persistSettings,
} from './settings.ts';
import type { LiveGitDiffSettings } from './settings.ts';
import * as log from './log.ts';

export default class LiveGitDiffPlugin extends Plugin implements SyncHost {
  settings: LiveGitDiffSettings = DEFAULT_SETTINGS;

  /** In-memory only; deliberately never persisted. Close Obsidian and it is gone. */
  session: Session | null = null;

  zones!: ViewZones;
  sync!: ScrollSync;
  private charMarks!: CharMarkLayer;

  /**
   * Note-pane section element -> its source line range.
   * WeakMap because the reading view DISCARDS and recreates section elements as you
   * scroll; a strong Map would pin dead DOM for the life of the session.
   */
  private noteLines: WeakMap<HTMLElement, { lineStart: number; lineEnd: number }> = new WeakMap();

  /** Warn about a missing scroller once per session, not once per frame. */
  private warnedNoScroller = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.zones = new ViewZones(this);
    this.sync = new ScrollSync(this);
    this.charMarks = new CharMarkLayer(this);

    // A debounced zone refresh means content above the viewport may have moved under
    // the reader; re-anchor so the correction reads as invisible rather than as a jump.
    this.zones.onAfterDebouncedRefresh = () => {
      if (this.sync.enabled && !this.sync.busy) this.sync.syncNoteToBase();
    };
    this.charMarks.onHeightChange = () => this.zones.scheduleRefresh();

    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new GitBaseView(leaf, this));
    this.addSettingTab(new LiveGitDiffSettingTab(this.app, this));

    /* ---- commands -------------------------------------------------------- *
     * Sentence case, and NOT prefixed with the plugin name: Obsidian prefixes it
     * automatically in the command palette, so "Live Git Diff: Live Git Diff: …" is
     * what you get if you add it yourself. */
    this.addCommand({
      id: 'open-review',
      name: 'Open git diff review for this file',
      callback: () => void this.openReview(),
    });
    this.addCommand({
      id: 'close-review',
      name: 'Close review',
      callback: () => this.closeReview(),
    });
    this.addCommand({
      id: 'refresh-review',
      name: 'Refresh review (re-pin the base version)',
      callback: () => void this.openReview(true),
    });
    this.addCommand({
      id: 'toggle-scroll-sync',
      name: 'Toggle scroll sync',
      callback: () => this.toggleSync(),
    });
    this.addCommand({
      id: 'copy-alignment-report',
      name: 'Copy alignment report to clipboard',
      callback: () => void this.reportAlignment(),
    });

    // NOTE pane decoration. Classes only — never text.
    this.registerMarkdownPostProcessor((el, ctx) => {
      try {
        const session = this.session;
        if (!session || session.error) return;
        // Guard: also excludes our own base-pane renders, which pass ''.
        if (!ctx.sourcePath || ctx.sourcePath !== session.filePath) return;

        const info = ctx.getSectionInfo(el);
        if (!info) return; // not a top-level section (or not preview) — skip, never throw

        // ANCHOR TAP. Every section gets tagged, not just changed ones: scroll sync needs
        // to find the topmost visible block whatever its kind, and 'same' blocks are the
        // overwhelming majority of anchors (261 of 271 on the test doc).
        el.addClass(CLS.nblock);
        this.noteLines.set(el, { lineStart: info.lineStart, lineEnd: info.lineEnd });

        // Resolve the row ONCE and stamp it on the element. Everything downstream
        // (view-zone padding, height harvest, per-tick refresh) then reads an attribute
        // instead of re-running the O(rows) overlap search. That is what keeps per-tick
        // work proportional to what's RENDERED rather than to the document — on a
        // 312-block diff the scanning form would run ~300 overlap tests per visible
        // block, per frame.
        const row = this.rowForNoteRange(info.lineStart, info.lineEnd);
        if (row) el.setAttr(ATTR_ROW, String(row.idx));

        // DELETION VIEW ZONE. Re-applied here, not just once after the base renders,
        // because reading-view sections are recycled: a block scrolled out and back
        // returns as a fresh element with our inline style gone. The post-processor is
        // the hook that fires on every such re-render, so treating it as the single place
        // zones get written makes them self-healing rather than a one-shot that silently
        // decays as the reader scrolls.
        if (row) this.zones.styleDelPad(el);

        const kind = row ? row.kind : this.kindForRange(session, info.lineStart, info.lineEnd);
        if (kind === 'ins') {
          el.addClass(CLS.ins);
          // INSERTION VIEW ZONE HEIGHT TAP — the one moment we are guaranteed to hold an
          // 'ins' block's element. See ViewZones.harvestInsHeight.
          if (row) this.zones.harvestInsHeight(row, el);
        } else if (kind === 'mod') {
          el.addClass(CLS.mod);
          // WORD-LEVEL MARKS. Here, not at base-render time, because this is the first
          // moment both rendered texts exist. Re-runs on every recycle and is idempotent
          // (it unwraps its own spans first).
          if (row) this.charMarks.apply(row, el);
        }
      } catch (e) {
        // A post-processor that throws breaks the whole preview render. Never.
        log.error('post-processor error', e);
      }
    });

    // The note pane's scroller is replaced when the view re-renders or the leaf changes;
    // re-attaching is cheap and idempotent (attach detaches first).
    this.registerEvent(this.app.workspace.on('layout-change', () => this.sync.attach()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.sync.attach()));
    // A resize changes where the note pane WRAPS, so every cached view-zone height is
    // suspect. We can only re-measure what is currently rendered; the rest correct
    // themselves as they scroll back through the post-processor. Debounced because
    // 'resize' fires per animation frame of a drag.
    this.registerEvent(this.app.workspace.on('resize', () => this.zones.scheduleRefresh()));
    // The scroll listeners are attached MANUALLY rather than with registerDomEvent, and
    // this is the justification: they must MOVE between elements mid-session (both panes
    // are re-created on re-render), and registerDomEvent has no way to unregister one
    // listener early — it only cleans up at unload, so every re-attach would leak another
    // listener onto a dead element. ScrollSync.detach() owns the bookkeeping; this
    // `register` hook guarantees it still runs on unload.
    this.register(() => this.sync.dispose());
    this.register(() => this.zones.dispose());
  }

  onunload(): void {
    this.sync.dispose();
    this.zones.dispose();
    // Unloading the plugin must leave no trace in the note pane either.
    try { this.clearNoteDecorations(); } catch { /* workspace already torn down */ }
    clearColors();
    this.session = null;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  /* ---------------------------------------------------------------- *
   * settings                                                          *
   * ---------------------------------------------------------------- */

  async loadSettings(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
    log.setDebug(this.settings.debug);
    applyColors(this.settings);
  }

  async saveSettings(): Promise<void> {
    await persistSettings(this);
    log.setDebug(this.settings.debug);
    applyColors(this.settings);
  }

  /* ---------------------------------------------------------------- *
   * pane handles (PaneHost)                                           *
   * ---------------------------------------------------------------- */

  /**
   * The NOTE pane (pane A): the real markdown leaf showing this session's file in
   * READING view, plus the element that actually scrolls it.
   */
  notePane(): NotePane | null {
    const session = this.session;
    if (!session || session.error) return null;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      if (!view.file || view.file.path !== session.filePath) continue;
      // Decorations and getSectionInfo only exist in reading view — so does sync.
      if (typeof view.getMode === 'function' && view.getMode() !== 'preview') continue;
      const scroller = findPreviewScroller(view);
      if (!scroller) {
        if (!this.warnedNoScroller) {
          this.warnedNoScroller = true;
          log.warn(
            `could not identify the reading-view scroll container for ${session.filePath} — ` +
            'scroll sync from the note pane is disabled. Expected a scrollable `.markdown-preview-view`.'
          );
        }
        return null;
      }
      return { view: view as unknown as NotePane['view'], scroller };
    }
    return null;
  }

  /** The BASE pane (pane B) view instance, if open. */
  baseView(): BasePaneLike | null {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof GitBaseView) return leaf.view;
    }
    return null;
  }

  /** The BASE pane's scrolling element. */
  basePane(): HTMLElement | null {
    const v = this.baseView();
    const body = v && v.bodyEl;
    return body && body.isConnected ? body : null;
  }

  /**
   * The base-pane element standing in for `rowIdx` — a real block, or the VIEW ZONE
   * that occupies the place a real block would have.
   *
   * THE SINGLE RESOLVER, and the reason the anchor is exact.
   *
   * Before view zones existed, only paired rows had a base element; a topmost-visible
   * 'ins' row resolved to nothing and sync fell through to the interpolating estimate,
   * which was measured up to 340px off. It wasn't the interpolation misbehaving; it was
   * the interpolation being asked a question it can only estimate.
   *
   * A spacer sits at exactly the position its row's content occupies in the note's
   * reading order, so aligning an inserted note block to its spacer is not an
   * approximation — it is the same answer a real block would give. Every note row now
   * has a counterpart here, which makes interpolation a guard rather than a path.
   *
   * NOTE the zero-height case is still CORRECT, not merely tolerable: a spacer whose
   * height hasn't been harvested yet is 0px tall but is still in the right PLACE, so the
   * anchor lands exactly; only the blocks below it stay off until the height is known.
   * Strictly better than interpolating, at every stage of the harvest.
   */
  baseElFor(rowIdx: number): HTMLElement | null {
    const view = this.baseView();
    if (!view) return null;
    const el = (view.blockEls && view.blockEls.get(rowIdx)) ||
               (view.spacerEls && view.spacerEls.get(rowIdx));
    return el && el.isConnected ? el : null;
  }

  /* ---------------------------------------------------------------- *
   * row lookup (SyncHost)                                             *
   * ---------------------------------------------------------------- */

  noteLineInfo(el: HTMLElement): { lineStart: number; lineEnd: number } | undefined {
    return this.noteLines.get(el);
  }

  /** Note-pane section line range -> the row it belongs to (best line overlap). */
  rowForNoteRange(lineStart: number, lineEnd: number): Row | null {
    const session = this.session;
    if (!session) return null;
    let best: Row | null = null;
    let bestOverlap = 0;
    for (const row of session.noteRows) {
      if (!row.b) continue;
      const overlap = Math.min(lineEnd, row.b.lineEnd) - Math.max(lineStart, row.b.lineStart) + 1;
      if (overlap > bestOverlap) { bestOverlap = overlap; best = row; }
    }
    return bestOverlap > 0 ? best : null;
  }

  /**
   * Best-overlap lookup from an Obsidian section's line range to a pair kind.
   * Obsidian's sectioning and our block splitting agree in the common case but are not
   * guaranteed identical (lists, callouts), so we match by maximum line overlap rather
   * than requiring exact range equality. test/grain-oracle.test.ts is what keeps that
   * "common case" honest.
   */
  private kindForRange(session: Session, lineStart: number, lineEnd: number): string | null {
    let best: Session['curMap'][number] | null = null;
    let bestOverlap = 0;
    for (const b of session.curMap) {
      const overlap = Math.min(lineEnd, b.lineEnd) - Math.max(lineStart, b.lineStart) + 1;
      if (overlap > bestOverlap) { bestOverlap = overlap; best = b; }
    }
    return bestOverlap > 0 && best ? best.kind : null;
  }

  /* ---------------------------------------------------------------- *
   * review lifecycle                                                  *
   * ---------------------------------------------------------------- */

  toggleSync(): void {
    this.sync.enabled = !this.sync.enabled;
    const v = this.baseView();
    if (v instanceof GitBaseView) v.updateSyncBadge();
    new Notice(`Scroll sync ${this.sync.enabled ? 'on' : 'off'}`);
    // Snap the panes back together immediately so ON is visibly different from OFF.
    if (this.sync.enabled) this.sync.syncNoteToBase();
  }

  /**
   * Resolve which commit to use as the base, honouring the settings.
   * Returns the sha plus a human LABEL — "HEAD" and "main" are different answers to
   * "what am I looking at?", and a sha alone cannot tell them apart in the header.
   */
  private resolveBase(root: string): { sha: string; label: string } {
    if (this.settings.baseRefMode === 'named-ref') {
      const ref = this.settings.baseRef;
      return { sha: resolveRef(root, ref), label: ref };
    }
    return { sha: headSha(root), label: 'HEAD' };
  }

  /** Open (or re-pin) a review for the active markdown file. */
  async openReview(repin = false): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('No active file.');
      return;
    }
    if (!(file instanceof TFile) || file.extension !== 'md') {
      new Notice('Not a markdown file.');
      return;
    }

    try {
      const ctx = resolveGit(this.app, file);
      // Pin the base ONCE per review session (or on explicit re-pin). See session.ts.
      const keep =
        !repin && this.session && this.session.filePath === file.path && !this.session.error
          ? { sha: this.session.sha, label: this.session.baseRefLabel }
          : null;
      const base = keep || this.resolveBase(ctx.root);

      const baseText = showAt(ctx.root, base.sha, ctx.rel);
      const currentText = await this.app.vault.cachedRead(file); // read-only

      this.session = buildSession(file, baseText, ctx, base.sha, base.label, currentText);
      // Row indices are session-local: a re-pin re-pairs everything, so yesterday's
      // heights and word-ranges would be filed under today's unrelated rows. Drop them.
      this.zones.reset();
      this.charMarks.reset();
      this.warnedNoScroller = false;
      new Notice(
        `Base ${this.session.shortSha} (${base.label}) · ${this.session.counts.changed} changed block(s)`
      );
    } catch (e) {
      const msg = e instanceof GitError ? e.message : `Unexpected error:\n${(e as Error).message}`;
      // Loud, and explicit in the pane — an empty base pane must never be the only
      // signal, because it is indistinguishable from "everything is new".
      this.session = errorSession(file, msg);
      this.zones.reset();
      this.charMarks.reset();
      // The error render returns before the base pane is built, so the rAF that normally
      // recomputes zones never runs. Without this, a failed re-pin would leave the
      // PREVIOUS session's gaps padding the note with nothing to justify them — a
      // wrong-but-plausible state, which is the class of failure this codebase works
      // hardest to avoid.
      this.clearNoteDecorations();
      new Notice(String(msg).split('\n')[0], 8000);
      log.error('open review failed', e);
    }

    await this.revealView();
    this.rerenderPreviews();
    // The note pane's sections are re-created by rerenderPreviews above, so its scroller
    // may be new; the base pane's body certainly is.
    this.sync.attach();
  }

  closeReview(): void {
    this.sync.detach();
    // BEFORE dropping the session: clearNoteDecorations walks live note elements, and the
    // padding is ours to remove. Leaving it would strand phantom gaps in the reader's
    // note with no review open to explain them.
    this.clearNoteDecorations();
    this.session = null;
    this.zones.reset();
    this.charMarks.reset();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    this.rerenderPreviews();
    new Notice('Review closed.');
  }

  /**
   * Hand the note pane's blocks back exactly as we found them — zone padding removed AND
   * our word-mark spans unwrapped.
   *
   * Reading-view sections are recycled rather than rebuilt on command, so closing a
   * review must actively undo both: otherwise the note keeps phantom gaps where
   * deletions used to be and highlighted words with no review open to explain them. The
   * unwrap matters more than the padding — spans left behind are spans the next session
   * would treat as pre-existing content.
   */
  private clearNoteDecorations(): void {
    this.zones.reset();
    this.charMarks.reset();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      const scroller = view ? findPreviewScroller(view) : null;
      if (!scroller) continue;
      for (const el of Array.from(scroller.querySelectorAll<HTMLElement>(`.${CLS.nblock}`))) {
        el.style.paddingBottom = '';
        el.style.paddingTop = '';
        unwrapCharMarks(el);
      }
    }
  }

  /**
   * Show the base pane beside the active note.
   *
   * CHOICE: `getLeaf('split', 'vertical')` — a real editor-area split, full height, same
   * width class as the note. The left SIDEBAR (getLeftLeaf) is genuinely on the left but
   * is a narrow utility rail; rendered prose is unreadable in it, and side-by-side
   * reading is the entire point.
   * TRADE-OFF: Obsidian places a new split AFTER the active leaf, so the base pane lands
   * to the RIGHT of the note by default. Drag its tab across once to swap. See README
   * "Known limitations".
   */
  private async revealView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = existing[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf('split', 'vertical');
      await leaf.setViewState({ type: VIEW_TYPE, active: false });
    }
    this.app.workspace.revealLeaf(leaf);
    for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (l.view instanceof GitBaseView) await l.view.render();
    }
  }

  /** Force preview panes to re-run post-processors so decorations refresh. */
  private rerenderPreviews(): void {
    this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
      try {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.previewMode &&
            typeof view.previewMode.rerender === 'function') {
          view.previewMode.rerender(true);
        }
      } catch (e) {
        log.error('rerender failed', e);
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * alignment diagnostic                                              *
   * ---------------------------------------------------------------- */

  /**
   * Put the CURRENT alignment of the two panes on the clipboard as JSON, so alignment
   * can be checked with a number instead of an opinion.
   *
   * THE CLIPBOARD, NOT A FILE. The spike wrote this to a hardcoded scratch path with a
   * synchronous filesystem write — fine for a spike, wrong for a shipped plugin twice
   * over: it hardcoded one machine's directory, and it meant the bundle contained a real
   * file write, so the read-only gate needed a carve-out for it. Deleting the write
   * deleted the carve-out: the plugin now imports no filesystem module at all, which is
   * a capability the gate can check rather than a promise it has to trust. The feature
   * lost nothing — paste the report wherever you want it.
   *
   * `deltaPx` is the money field: for the note pane's topmost visible block, how far its
   * counterpart in the base pane sits from where it "should" be. 0 = the two blocks' tops
   * are the same distance below their viewport tops.
   */
  private async reportAlignment(): Promise<void> {
    const session = this.session;
    if (!session || session.error) {
      new Notice('No active review session to report on.');
      return;
    }
    const note = this.notePane();
    const base = this.basePane();
    const view = this.baseView();

    const snip = (t: string | null | undefined): string =>
      String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, 60);

    let notePart: Record<string, unknown> = { found: false };
    let noteRow: Row | null = null;
    let noteOffsetPx: number | null = null;
    if (note) {
      const hit = topmostVisible(
        note.scroller,
        note.scroller.querySelectorAll<HTMLElement>(`.${CLS.nblock}`)
      );
      const info = hit ? this.noteLines.get(hit.el) : null;
      noteRow = info ? this.rowForNoteRange(info.lineStart, info.lineEnd) : null;
      if (hit) noteOffsetPx = hit.rect.top - note.scroller.getBoundingClientRect().top;
      notePart = {
        found: !!hit,
        renderedBlocksInDom: note.scroller.querySelectorAll(`.${CLS.nblock}`).length,
        scrollTop: note.scroller.scrollTop,
        topBlock: hit && info ? {
          lineStart: info.lineStart,
          lineEnd: info.lineEnd,
          text60: snip(noteRow && noteRow.b ? noteRow.b.text : ''),
          fractionScrolledThroughBlock: Number(hit.frac.toFixed(3)),
          offsetFromViewportTopPx: Number((noteOffsetPx as number).toFixed(1)),
          rowIndex: noteRow ? noteRow.idx : null,
          kind: noteRow ? noteRow.kind : null,
        } : null,
      };
    }

    let basePart: Record<string, unknown> = { found: false };
    let baseRow: Row | null = null;
    if (base && view) {
      const hit = topmostVisible(base, base.querySelectorAll<HTMLElement>(`.${CLS.block}`));
      baseRow = hit ? session.rows[Number(hit.el.getAttribute(ATTR_ROW))] : null;
      basePart = {
        found: !!hit,
        blocks: view.blockEls.size,
        scrollTop: base.scrollTop,
        topBlock: hit && baseRow && baseRow.a ? {
          lineStart: baseRow.a.lineStart,
          lineEnd: baseRow.a.lineEnd,
          text60: snip(baseRow.a.text),
          fractionScrolledThroughBlock: Number(hit.frac.toFixed(3)),
          offsetFromViewportTopPx: Number(
            (hit.rect.top - base.getBoundingClientRect().top).toFixed(1)
          ),
          rowIndex: baseRow.idx,
          kind: baseRow.kind,
        } : null,
      };
    }

    // Where does the note-pane top block's counterpart ACTUALLY sit in the base pane?
    // The measurement must follow the same resolver sync uses, or the report grades a
    // different mechanism than the one that ran. `noteRow.paired` was the old gate; it
    // reported null for every 'ins' row — i.e. it went quiet on exactly the rows that
    // drifted most, which is how a 340px anchor error stayed invisible in a diagnostic
    // whose whole job was to surface it.
    let deltaPx: number | null = null;
    let deltaNote = 'no base-side counterpart at all — interpolated region';
    if (noteRow && base && view && noteOffsetPx != null) {
      const el = this.baseElFor(noteRow.idx);
      if (el) {
        const baseOffsetPx = el.getBoundingClientRect().top - base.getBoundingClientRect().top;
        deltaPx = Number((baseOffsetPx - noteOffsetPx).toFixed(1));
        deltaNote = '0 = counterpart blocks sit at the same depth in both viewports; ' +
                    '+ = base pane block sits lower than the note pane block' +
                    (noteRow.paired ? '' : ' (counterpart is a view zone, not a block)');
      }
    }

    const zoneStats = this.zones.stats();
    const report = {
      generatedAt: new Date().toISOString(),
      plugin: this.manifest.version,
      file: session.filePath,
      baseSha: session.shortSha,
      baseRef: session.baseRefLabel,
      counts: session.counts,
      syncEnabled: this.sync.enabled,
      lastNoteScrollApi: this.sync.lastScrollApi,
      // View-zone coverage. `knownHeights` climbs toward `total` as the reader scrolls
      // the note pane past each insertion — so a low ratio here EXPLAINS a residual
      // drift rather than leaving it a mystery.
      viewZones: zoneStats.ins,
      // The other direction: space reserved in the NOTE pane for deleted base blocks.
      // Exact by construction (the base pane is fully rendered), so these should be
      // stable from the first render — if reservedPx is 0 while the diff reports
      // deletions, the padding never landed and that is the bug.
      delZones: zoneStats.del,
      // Word-level marks. `maxBaseHeightDeltaPx` and `reverts` must both be 0 — see
      // CharMarkLayer.
      charMarks: this.charMarks.stats(session.rows.filter((r) => r.kind === 'mod').length),
      panes: {
        // Design-doc naming: pane A = the real note, pane B = our git-base ItemView.
        A_note: notePart,
        B_base: basePart,
      },
      pairing: {
        noteTopRowKind: noteRow ? noteRow.kind : null,
        baseTopRowKind: baseRow ? baseRow.kind : null,
        sameRow: !!(noteRow && baseRow && noteRow.idx === baseRow.idx),
        notePaired: noteRow ? noteRow.paired : null,
      },
      deltaPx,
      deltaNote,
    };

    const json = JSON.stringify(report, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      new Notice(`Alignment report copied (deltaPx=${deltaPx == null ? 'n/a' : deltaPx})`, 6000);
    } catch (e) {
      // Never swallow it: if the clipboard is unavailable the report still has to reach
      // the user, and the console always exists.
      log.warn('clipboard unavailable — report follows', e);
      console.log(json);
      new Notice('Clipboard unavailable — alignment report logged to the console.', 8000);
    }
    log.debug('alignment report', report);
  }
}
