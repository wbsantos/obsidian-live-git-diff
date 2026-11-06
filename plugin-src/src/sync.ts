/**
 * sync.ts — anchor-based scroll sync between the note pane and the base pane.
 *
 * THE CONSTRAINT THAT SHAPES EVERYTHING HERE. The naive "measure every block in both
 * panes, pad with spacers, mirror scrollTop" strategy is unavailable to us: Obsidian's
 * reading view only keeps sections near the viewport in the DOM (confirmed live: 45 of
 * 271 blocks rendered; off-screen sections are .detach()ed and read back as zeros), so
 * the heights of far-off blocks in the NOTE pane cannot be measured — they do not
 * exist. Equal-height + mirrored scrollTop is therefore structurally impossible, not
 * merely difficult.
 *
 * Everything is built on ANCHORS instead: the topmost VISIBLE block (which by
 * definition is rendered), its source line range, and the block pairing we already
 * computed. Line-space is the currency, never pixels — that is what Obsidian itself
 * uses for its editor<->preview sync, for exactly the same reason.
 *
 * Measured: anchor 0px at 5 of 6 sample positions, median worst drift 24px, max 48px
 * on a 94-change diff.
 */
import { clamp, maxScroll, offsetIn, topmostVisible } from './dom.ts';
import { CLS, ATTR_ROW } from './panes.ts';
import type { MarkdownViewLike, PaneHost } from './panes.ts';
import type { Row } from './session.ts';
import type { ViewZones } from './viewzones.ts';
import * as log from './log.ts';
import { editorTopLine, scrollEditorToLine } from './editor.ts';
import { noteScrollTarget } from './scrollModel.ts';

export interface SyncHost extends PaneHost {
  zones: ViewZones;
  /** Note-pane section line range -> the row it belongs to (best line overlap). */
  rowForNoteRange(lineStart: number, lineEnd: number): Row | null;
  /** The line range we tagged onto a note section at post-process time. */
  noteLineInfo(el: HTMLElement): { lineStart: number; lineEnd: number } | undefined;
}

interface Listener {
  el: EventTarget;
  type: string;
  fn: EventListener;
}

export class ScrollSync {
  private host: SyncHost;

  /** Master switch. Default ON; toggled by command. Never persisted — a review is a session. */
  enabled = true;
  /**
   * Which pane WE are currently moving, if any — see `scrollLock`. Null when idle.
   * DIRECTIONAL on purpose: an echo arrives on the pane we moved, never on the other one,
   * so blocking both is what made the base lag behind a live scroll.
   */
  private syncingSide: 'note' | 'base' | null = null;
  /** Timer that clears `syncing` after a programmatic scroll. */
  private syncTimer: number | null = null;
  /** rAF throttle token; one pending frame at a time, whichever pane fired. */
  private rafPending = false;
  /**
   * Manual listeners. registerDomEvent can't be individually unregistered and these
   * must MOVE between elements mid-session, hence manual attach/detach.
   */
  private domListeners: Listener[] = [];
  /** Which scroll API actually moved the note pane last (surfaced in the report). */
  lastScrollApi: string | null = null;

  constructor(host: SyncHost) {
    this.host = host;
  }

  /* ---------------------------------------------------------------- *
   * listener wiring                                                   *
   * ---------------------------------------------------------------- */

  private addListener(el: EventTarget, type: string, fn: EventListener): void {
    el.addEventListener(type, fn, { passive: true });
    this.domListeners.push({ el, type, fn });
  }

  detach(): void {
    for (const l of this.domListeners) {
      try { l.el.removeEventListener(l.type, l.fn); } catch { /* element already gone */ }
    }
    this.domListeners = [];
  }

  /** Point the scroll listeners at whatever elements the two panes have RIGHT NOW. */
  attach(): void {
    this.detach();
    const session = this.host.session;
    if (!session || session.error || session.status !== 'ready') return;

    const note = this.host.notePane();
    if (note) this.addListener(note.scroller, 'scroll', () => this.onScroll('note'));

    const base = this.host.basePane();
    if (base) this.addListener(base, 'scroll', () => this.onScroll('base'));
  }

  dispose(): void {
    this.detach();
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }

  /**
   * Scroll handler for both panes: rAF-throttled, loop-guarded.
   * `syncing` is checked BOTH on entry and inside the frame — the programmatic scroll
   * we perform lands asynchronously, so the echo event can be queued before the flag
   * is set and dispatched after.
   */
  private onScroll(side: 'note' | 'base'): void {
    if (!this.enabled) return;
    // Ignore only OUR OWN ECHO, and only on the pane we moved. A scroll on the OTHER pane
    // is the reader, and dropping it is what made the base fall behind: the lock used to
    // be direction-blind, so every event on both panes was discarded for 120ms after each
    // programmatic move. Under a continuous scroll that meant sync ran once per window and
    // the base trailed by however far the reader had travelled — ~300-600px at a flick,
    // snapping into place the moment they stopped. Measured: the anchor was off at 33 of
    // 60 wheel steps, worst 624px, and 0px once settled.
    if (this.syncingSide === side) return;
    if (this.rafPending) return;
    this.rafPending = true;
    window.requestAnimationFrame(() => {
      this.rafPending = false;
      if (!this.enabled || this.syncingSide === side) return;
      try {
        if (side === 'note') this.syncNoteToBase();
        else this.syncBaseToNote();
      } catch (e) {
        log.error('scroll sync failed', e);
      }
    });
  }

  /**
   * Run a programmatic scroll with the feedback loop disarmed.
   *
   * A flag alone is not enough: the browser dispatches `scroll` asynchronously, so
   * clearing the flag on the next tick can still let the echo through and start
   * note -> base -> note -> ... judder. Obsidian's own one-shot boolean has the mirror
   * problem — it swallows the next real scroll when a programmatic scroll emits zero
   * events. So the flag is a TIME-BASED owner token: held for a short window (120ms)
   * AFTER the move, and every nested call pushes the window out.
   *
   * `side` is the pane being MOVED, and it is what makes the window affordable. An earlier
   * version held the token against BOTH panes and reasoned: "a genuine user scroll started
   * within 120ms of a programmatic one is ignored — that is invisible in practice." It is
   * not invisible. Under a continuous scroll EVERY window overlaps the reader's next
   * event, so sync ran at most once per 120ms and the base trailed by however far they had
   * moved — 300-600px at a flick, snapping true the instant they stopped. The oscillation
   * this guards against is note -> base -> note, which can only arrive as an echo on the
   * pane we just moved; the other pane's events are always the reader's, and they must get
   * through.
   */
  private scrollLock(side: 'note' | 'base', fn: () => void): void {
    this.syncingSide = side;
    try {
      fn();
    } finally {
      if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
      this.syncTimer = window.setTimeout(() => {
        this.syncingSide = null;
        this.syncTimer = null;
      }, 120);
    }
  }

  /** True while a programmatic scroll is in flight — callers must not re-anchor. */
  get busy(): boolean {
    return this.syncingSide !== null;
  }

  /* ---------------------------------------------------------------- *
   * anchor resolution                                                 *
   * ---------------------------------------------------------------- */

  /**
   * Where the base pane should sit so that `row` (a NOTE-pane row), at fraction `frac`
   * through itself, is at the top of the base viewport.
   *
   * UNPAIRED HANDLING — INTERPOLATE, not clamp-and-hold.
   * An 'ins' row has no base-side block to align to. Two honest options:
   *   (a) clamp: hold the base pane at the enclosing paired anchor for the whole run;
   *   (b) interpolate: glide the base pane from the previous anchor's bottom to the
   *       next anchor's top, in proportion to how far through the run we are.
   * We chose (b), for the case the test doc is built around: a rewritten section
   * (3 blocks deleted, 4 inserted). There, the note pane's 4-block insertion run and
   * the base pane's 3-block deletion run sit BETWEEN THE SAME PAIR of anchors, so
   * interpolation glides the base pane through the deleted text while the reader moves
   * through the inserted text — i.e. it shows the counterpart content, which is the
   * entire question a diff review is asking. Clamping would freeze the base pane on an
   * unrelated paragraph for four screens and then jump.
   *
   * TRADE-OFF: for a PURE insertion (no matching deletion) the two anchors are adjacent
   * in the base pane, so there is ~0px to interpolate and (b) degenerates to (a) — a
   * hold — which is the correct behaviour there anyway. The other cost is that progress
   * is measured in BLOCK COUNT, not pixels: a run of one short and one very tall block
   * advances the base pane at an even rate rather than a proportional one.
   * Pixel-accurate progress would need the heights of every block in the run, and in
   * the note pane those are exactly the blocks the reading view may not have rendered.
   * Block-count is the measurement that survives virtualization.
   *
   * @returns scrollTop for the base pane, or null if unresolvable
   */
  baseScrollTopFor(row: Row, frac: number): number | null {
    const base = this.host.basePane();
    const view = this.host.baseView();
    if (!base || !view) return null;

    // Any row with a counterpart — a real block OR its view zone — is answerable
    // exactly, so it never reaches the interpolation below. Before view zones this read
    // `if (row.paired)`, which sent every 'ins' row down the estimating path.
    const own = this.host.baseElFor(row.idx);
    if (own) {
      return clamp(offsetIn(base, own) + frac * own.offsetHeight, 0, maxScroll(base));
    }

    const side = row.pn;
    if (!side) return null;
    const prev = side.prev;
    const next = side.next;
    const prevEl = prev ? this.host.baseElFor(prev.idx) : null;
    const nextEl = next ? this.host.baseElFor(next.idx) : null;
    const lo = prevEl ? offsetIn(base, prevEl) + prevEl.offsetHeight : 0;
    const hi = nextEl ? offsetIn(base, nextEl) : maxScroll(base);
    // GUARD ADDED AT PORT TIME (the spike lacked it). runIdx/runLen are only populated
    // for UNPAIRED rows, so a PAIRED row that reaches here — possible when the base
    // pane is mid-re-render and its element momentarily has no counterpart — computed
    // (undefined + frac) / undefined = NaN, and `base.scrollTop = NaN` silently snaps
    // the pane to 0. Refusing to answer leaves the pane where it is, which is the
    // correct behaviour for "I don't know".
    if (side.runIdx === undefined || !side.runLen) return null;
    const p = (side.runIdx + frac) / side.runLen;
    const target = clamp(lo + Math.max(0, hi - lo) * p, 0, maxScroll(base));
    return isFinite(target) ? target : null;
  }

  /**
   * The note-pane SOURCE LINE (fractional) corresponding to base-pane `row` at fraction
   * `frac` through itself. Same interpolation choice as `baseScrollTopFor`, expressed
   * in line numbers instead of pixels — the note pane is scrolled by line, not by
   * pixel, precisely because we cannot measure its unrendered parts.
   */
  noteLineFor(row: Row, frac: number): number | null {
    // Gate on `row.b`, not `row.paired`: an 'ins' row is unpaired but its note-side
    // lines are known EXACTLY (it's the base side it lacks). Since view zones let a
    // spacer be the base pane's topmost visible element, this direction now gets asked
    // about 'ins' rows too — and estimating a line number we already know would be a
    // self-inflicted error.
    if (row.b) {
      const span = row.b.lineEnd - row.b.lineStart + 1;
      return row.b.lineStart + frac * span;
    }
    const session = this.host.session;
    if (!session) return null;
    const side = row.pb;
    if (!side) return null;
    const prev = side.prev;
    const next = side.next;
    const lo = prev && prev.b ? prev.b.lineEnd + 1 : 0;
    const hi = next && next.b ? next.b.lineStart : session.curLastLine;
    // Same NaN guard as baseScrollTopFor — see there.
    if (side.runIdx === undefined || !side.runLen) return null;
    const p = (side.runIdx + frac) / side.runLen;
    const line = lo + Math.max(0, hi - lo) * p;
    return isFinite(line) ? line : null;
  }

  /* ---------------------------------------------------------------- *
   * the two directions                                                *
   * ---------------------------------------------------------------- */

  /** NOTE pane (A) drives the BASE pane (B). Pure pixel math on DOM we own. */
  syncNoteToBase(): void {
    const note = this.host.notePane();
    const base = this.host.basePane();
    if (!note || !base) return;

    // BEFORE anchoring, not after: the zones we are about to correct change where the
    // anchor's counterpart sits. Measuring on-screen blocks only, this is a handful of
    // rect reads — and reading a rect we are about to read anyway for the anchor.
    if (note.editorView) {
      const line = editorTopLine(note.editorView);
      const target = noteScrollTarget(this.host.session?.noteRows || [], line, (row, fraction) => this.baseScrollTopFor(row, fraction));
      if (target !== null && Math.abs(base.scrollTop - target) >= 1) this.scrollLock('base', () => { base.scrollTop = target; });
      return;
    }

    const hit = topmostVisible(
      note.scroller,
      note.scroller.querySelectorAll<HTMLElement>(`.${CLS.nblock}`)
    );
    if (!hit) return;

    const info = this.host.noteLineInfo(hit.el);
    if (!info) return;
    const row = this.host.rowForNoteRange(info.lineStart, info.lineEnd);
    if (!row) return;

    // ---- Alignment: match SCREEN positions, not scroller-relative offsets. ----
    // Each pane's scroller starts at a different screen Y: the base pane's begins BELOW
    // our header (title + "base <sha> · N blocks"), the note pane's begins right under
    // its tab bar. Aligning each block to "top of its own scroller" therefore lands them
    // at different heights on screen — a constant error equal to the header. Rather than
    // measure the header and subtract it (which breaks the moment the header wraps to
    // two lines, a banner appears, or a theme changes its padding), align the two
    // blocks' actual on-screen positions and let the delta absorb whatever chrome
    // exists. Self-correcting by construction.
    //
    // With view zones in place `baseElFor` resolves for EVERY note row, so the
    // interpolated fallback below is a guard for the pathological (a row whose element
    // vanished mid-frame), not a routine path.
    const baseEl = this.host.baseElFor(row.idx);
    if (baseEl) {
      const delta = baseEl.getBoundingClientRect().top - hit.el.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) return; // already aligned; don't churn
      const want = clamp(base.scrollTop + delta, 0, maxScroll(base));
      if (Math.abs(base.scrollTop - want) < 1) return;
      this.scrollLock('base', () => { base.scrollTop = want; });
      return;
    }

    // No counterpart block (an 'ins' row — added text with nothing in the base).
    // Fall back to the interpolated target so the base pane still glides.
    const target = this.baseScrollTopFor(row, hit.frac);
    if (target == null) return;
    if (Math.abs(base.scrollTop - target) < 1) return; // already there; don't churn
    this.scrollLock('base', () => { base.scrollTop = target; });
  }

  /**
   * BASE pane (B) drives the NOTE pane (A).
   *
   * The note pane cannot be scrolled by scrollTop with any confidence — its content
   * height is a function of what the reading view has chosen to render — so we ask
   * OBSIDIAN to scroll it to a source LINE. See `applyNoteScroll` for which API.
   */
  syncBaseToNote(): void {
    const note = this.host.notePane();
    const base = this.host.basePane();
    const view = this.host.baseView();
    const session = this.host.session;
    if (!note || !base || !view || !session) return;

    // Spacers are anchors in this direction too: a view zone carries a data-row-index
    // and its row's NOTE lines are known exactly, so the zone answers as well as a
    // block would. Both selectors are needed — they are disjoint sets covering, between
    // them, every row in the base pane's reading order.
    const hit = topmostVisible(
      base,
      base.querySelectorAll<HTMLElement>(`.${CLS.block}, .${CLS.spacer}`)
    );
    if (!hit) return;

    const idx = Number(hit.el.getAttribute(ATTR_ROW));
    const row = session.rows[idx];
    if (!row) return;

    const line = this.noteLineFor(row, hit.frac);
    if (line == null || !isFinite(line)) return;
    this.scrollLock('note', () => {
      if (note.editorView) { scrollEditorToLine(note.editorView, line); this.lastScrollApi = 'EditorView.scrollIntoView'; }
      else if (note.scrollToLine) { note.scrollToLine(line); this.lastScrollApi = 'historical anchors'; }
      else this.applyNoteScroll(note.view, line);
    });
  }

  /**
   * Scroll a markdown reading view to a (fractional) source line.
   *
   * API PROVENANCE — read this before trusting it:
   *  - `view.currentMode.applyScroll(n)` / `view.previewMode.applyScroll(n)`:
   *    DECLARED in obsidian.d.ts (on MarkdownSubView) but undocumented — semi-public at
   *    best. This is the one that scrolls without side effects, so it is tried first.
   *    It also SILENTLY NO-OPS when sections are unmeasured. Whether it honours a
   *    FRACTIONAL line (giving smooth sub-block motion) or floors it (giving
   *    block-steppy motion) is not specified anywhere; if the note pane looks steppy,
   *    this is the line to suspect.
   *  - `view.setEphemeralState({line})`: fully public, but it centres the line and may
   *    flash a highlight, so it is a FALLBACK only.
   * Everything is feature-detected and wrapped — a broken internal must degrade to
   * "sync stops working", never "the plugin throws on every scroll frame".
   */
  applyNoteScroll(view: MarkdownViewLike, line: number): void {
    try {
      if (view.currentMode && typeof view.currentMode.applyScroll === 'function') {
        view.currentMode.applyScroll(line);
        this.lastScrollApi = 'currentMode.applyScroll';
        return;
      }
      if (view.previewMode && typeof view.previewMode.applyScroll === 'function') {
        view.previewMode.applyScroll(line);
        this.lastScrollApi = 'previewMode.applyScroll';
        return;
      }
      if (typeof view.setEphemeralState === 'function') {
        view.setEphemeralState({ line: Math.round(line) });
        this.lastScrollApi = 'setEphemeralState';
        return;
      }
      this.lastScrollApi = 'none-available';
      log.warn('no usable scroll-to-line API on this markdown view');
    } catch (e) {
      this.lastScrollApi = 'error: ' + (e && (e as Error).message);
      log.error('scroll-to-line failed', e);
    }
  }
}
