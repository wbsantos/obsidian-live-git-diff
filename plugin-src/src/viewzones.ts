/**
 * viewzones.ts — reserved blank space that keeps the two panes level.
 *
 * WHY THEY EXIST. Paired blocks measure IDENTICALLY in the two panes (that is what
 * matching Obsidian's block grain bought us), so the only remaining drift comes from
 * UNPAIRED RUNS between two paired anchors: an 'ins' run makes the note taller by
 * exactly its own height, a 'del' run makes the base taller by exactly its own
 * height, and the next anchor lands off by that amount. VS Code solves this with
 * "view zones" — blank reserved space on whichever side is short, with both sides'
 * real content always shown at full size. It does NOT collapse deletions, and neither
 * do we.
 *
 * We own one pane and merely decorate the other, so each direction needs a different
 * technique:
 *
 *   'ins' (note has it, base doesn't) -> `.lgd-spacer`, a real empty element in the
 *      BASE pane. We own that DOM, so we can inject. Its height must come from the
 *      note-side block, which may not be rendered — hence the lazy harvest into
 *      `insHeights`. Unknown => 0px => no worse than having no zone at all.
 *
 *   'del' (base has it, note doesn't) -> padding-bottom on the note block PRECEDING
 *      the run. We cannot inject here (the reading view calls setChildrenInPlace()
 *      every tick and rips out added elements) — but we are already allowed to restyle
 *      an element it owns, and growing an existing block reserves space just as well
 *      as inserting a new one. Heights here are EXACT: the base pane is fully rendered.
 *
 * Measured effect on a 312-block / 94-change diff: median worst drift 126px -> 24px,
 * max 340px -> 48px, and the anchor became exact at 5 of 6 sample positions.
 */
import { CLS, ATTR_ROW } from './panes.ts';
import type { PaneHost } from './panes.ts';
import type { Row } from './session.ts';
import * as log from './log.ts';

export class ViewZones {
  private host: PaneHost;

  /**
   * INSERTION ZONES. row.idx of an 'ins' row -> the rendered height of its NOTE-side
   * block, in px.
   *
   * Why a cache and not a measurement: the note pane is virtualised, so at any moment
   * most 'ins' blocks are simply absent from the DOM and have no height to read.
   * Heights are therefore harvested opportunistically — whenever a block passes
   * through the post-processor, and from whatever is rendered on each sync tick — and
   * remembered afterwards, even once the reading view discards the element. A strong
   * Map is right here (unlike `noteLines`) because the key is a row index, not a DOM
   * node: it pins a number, not dead DOM.
   *
   * Unknown => the zone stays 0px => today's exact behaviour. This structure can only
   * remove drift, never add it.
   */
  insHeights: Map<number, number> = new Map();

  /**
   * DELETION ZONES. row.idx of a NOTE-side row -> px of reserved space to hang BELOW
   * it, standing in for the run of 'del' blocks that follows it in the base.
   *
   * Unlike `insHeights` these are EXACT and known up front: the base pane is our own
   * un-virtualised DOM, every block is rendered, so the run's height is a plain sum of
   * rects. No lazy harvest, no estimation.
   */
  private delPadBottom: Map<number, number> = new Map();

  /**
   * Same, for the one run that cannot hang below anything: a 'del' run at the very top
   * of the file, before any note block exists to follow. It hangs ABOVE the first note
   * block instead.
   */
  private delPadTop: Map<number, number> = new Map();

  /** Debounce token for `scheduleRefresh`. */
  private refreshPending = false;
  private refreshTimer: number | null = null;

  /** Called after a debounced refresh so the panes re-anchor. Set by the plugin. */
  onAfterDebouncedRefresh: (() => void) | null = null;

  constructor(host: PaneHost) {
    this.host = host;
  }

  /** Drop every cached height. Row indices are session-local — see `openReview`. */
  reset(): void {
    this.insHeights = new Map();
    this.delPadBottom = new Map();
    this.delPadTop = new Map();
  }

  dispose(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.refreshPending = false;
  }

  /** Height reserved for one 'ins' row's zone. 0 when not yet harvested. */
  insHeight(idx: number): number {
    const h = this.insHeights.get(idx);
    return h && h > 0 ? h : 0;
  }

  /** Push cached heights onto the base pane's zones. Cheap; idempotent. */
  applySpacerHeights(): void {
    const view = this.host.baseView();
    if (!view || !view.spacerEls) return;
    for (const [idx, el] of view.spacerEls) {
      const px = this.insHeight(idx) + 'px';
      // Compare before assigning: writing an identical value still dirties layout,
      // and this runs on every sync tick.
      if (el.style.height !== px) el.style.height = px;
    }
  }

  /**
   * Re-measure the 'ins' blocks the note pane happens to have rendered RIGHT NOW.
   *
   * Bounded by what is on screen (a dozen or so elements), not by the document, so
   * this is safe to call per sync tick. Blocks off screen keep whatever height they
   * were last seen at — a remembered height is strictly better than no height, and a
   * wrong-by-a-few-px remembered height is strictly better than a 0 that leaves the
   * whole run's worth of drift in place.
   *
   * @returns true if any cached height changed
   */
  measureRenderedInsHeights(): boolean {
    const session = this.host.session;
    if (!session || session.error) return false;
    const note = this.host.notePane();
    if (!note) return false;
    let changed = false;
    const sel = `.${CLS.ins}.${CLS.nblock}[${ATTR_ROW}]`;
    for (const el of Array.from(note.scroller.querySelectorAll<HTMLElement>(sel))) {
      const idx = Number(el.getAttribute(ATTR_ROW));
      if (!isFinite(idx)) continue;
      const row = session.rows[idx];
      if (!row || row.kind !== 'ins') continue;
      // SUBTRACT OUR OWN ZONES. The rect includes padding, and an 'ins' block may ALSO
      // be carrying a deletion zone (it is a perfectly ordinary candidate for "the note
      // block preceding a del run"). Measuring the padded height would reserve the
      // deletion's pixels a second time in the base pane — the two mechanisms would
      // feed each other, and each pass would grow the error. What we want is the
      // block's own content height, so take the padding back out.
      const h = el.getBoundingClientRect().height
        - (this.delPadBottom.get(idx) || 0)
        - (this.delPadTop.get(idx) || 0);
      if (!(h > 0)) continue;
      if (this.insHeights.get(idx) !== h) {
        this.insHeights.set(idx, h);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Harvest one 'ins' block's height at the single moment we are guaranteed to hold
   * its element: as the reading view renders the section. The reading view will later
   * throw that element away. This tap is the only way to learn about blocks that are
   * NOT currently on screen.
   *
   * The read here can be stale-by-a-frame (images/embeds settle after render) and is
   * taken before any zone padding is applied, which is why `measureRenderedInsHeights`
   * re-measures — and subtracts padding — on each tick.
   */
  harvestInsHeight(row: Row, el: HTMLElement): void {
    const h = el.getBoundingClientRect().height;
    if (h > 0) this.insHeights.set(row.idx, h);
    this.scheduleRefresh();
  }

  /**
   * Refresh BOTH directions of view zone. @returns true if anything moved.
   *
   * ORDER IS DELIBERATE. Insertion zones are measured from note blocks whose padding
   * comes from deletion zones, and deletion zones are measured from base blocks whose
   * positions come from insertion zones — so the two are mutually dependent and the
   * sequence has to break the cycle rather than chase it:
   *   1. measure 'ins' heights, subtracting any deletion padding already on the block
   *      (so what we read is content height, independent of our own zones);
   *   2. push those heights into the base pane's spacers;
   *   3. re-sum the del runs from the base pane, which has now settled;
   *   4. write that back to the note pane's padding.
   * Each step reads a quantity the later steps can't perturb, so this converges in one
   * pass instead of oscillating. Verified: hammering one scroll position 8x holds at
   * 2616px ins zones / 120px del pads — converges in one pass, no growth.
   *
   * PER-TICK COST. This is called from every sync tick, so the steady state — nothing
   * new learned — must be nearly free: one querySelectorAll over the RENDERED 'ins'
   * blocks and a rect each. Steps 3-4 walk all rows and force a layout flush to read
   * base rects, so they run only when a height actually moved (or on the debounced
   * `force` path). Unconditionally re-summing here would put an O(rows) scan plus a
   * forced reflow on every frame of every scroll — invisible on the 10-block diff this
   * was built against, and 312 rows deep on the one it now has to survive.
   *
   * @param force recompute the deletion zones even if nothing moved — for the cases
   *   where BASE heights changed without any 'ins' height changing (a resize, a base
   *   re-render).
   */
  refresh(force?: boolean): boolean {
    const changed = this.measureRenderedInsHeights();
    if (changed) this.applySpacerHeights();
    if (changed || force) {
      // Del-run heights are read from base blocks, whose layout step 2 may have moved.
      // Re-summing is what keeps deletion zones true after a wrap change; it is a walk
      // of the rows plus a rect per 'del' block (25 on the big diff), not per block.
      this.computeDelPads();
      this.applyDelPads();
    }
    return changed;
  }

  /**
   * Debounced refresh for the events that are NOT a scroll tick (a section rendering,
   * a resize). Trailing-edge: a resize drag fires continuously and only the final
   * geometry is worth measuring.
   */
  scheduleRefresh(): void {
    if (this.refreshPending) return;
    this.refreshPending = true;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshPending = false;
      this.refreshTimer = null;
      try {
        // force: this path exists for the events that change BASE geometry (resize, a
        // fresh base render) without necessarily moving any 'ins' height.
        this.refresh(true);
        if (this.onAfterDebouncedRefresh) this.onAfterDebouncedRefresh();
      } catch (e) {
        log.error('spacer refresh failed', e);
      }
    }, 150);
  }

  /**
   * Compute the DELETION view zones: for every run of consecutive 'del' rows, how much
   * space the NOTE pane must reserve to stay level with the base.
   *
   * The mirror of `insHeights`, and the easy direction: the base pane is ours and
   * un-virtualised — every block is rendered — so a run's height is an exact sum of
   * rects, known as soon as the base view finishes rendering. Nothing is estimated,
   * nothing needs harvesting over time.
   *
   * ATTACHMENT: a run's height hangs off the note block that immediately PRECEDES it in
   * note order — the last row carrying a `b` before the run starts. That block's bottom
   * edge sits exactly where the deleted text would have begun, so growing it downward
   * opens the gap in the right place.
   *
   * LEADING-RUN EDGE CASE: a file beginning with deleted blocks has no preceding note
   * block. That run hangs off the FIRST note block as padding-TOP instead (`delPadTop`)
   * — same pixels, same place on screen, expressed from the only side of the only
   * element available.
   */
  computeDelPads(): void {
    const session = this.host.session;
    const view = this.host.baseView();
    this.delPadBottom = new Map();
    this.delPadTop = new Map();
    if (!session || session.error || !view || !view.blockEls) return;

    let carry = 0;                  // height of the del run currently being walked
    let lastNoteRow: Row | null = null; // last row that exists in the note pane

    const flush = (): void => {
      if (carry <= 0) return;
      if (lastNoteRow) {
        // += rather than =: two del runs separated only by rows absent from the note
        // pane would otherwise overwrite each other. (Can't happen today — an 'ins' row
        // carries a `b` and so updates lastNoteRow — but the sum is the honest form and
        // costs nothing.)
        this.delPadBottom.set(
          lastNoteRow.idx,
          (this.delPadBottom.get(lastNoteRow.idx) || 0) + carry
        );
      } else {
        const first = session.noteRows[0];
        if (first) {
          this.delPadTop.set(first.idx, (this.delPadTop.get(first.idx) || 0) + carry);
        }
        // else: the note has no blocks at all (whole file deleted). Nothing to hang the
        // padding on — and nothing to align either. Correctly dropped.
      }
      carry = 0;
    };

    for (const row of session.rows) {
      if (row.kind === 'del') {
        const el = view.blockEls.get(row.idx);
        if (el && el.isConnected) carry += el.getBoundingClientRect().height;
        continue;
      }
      flush(); // the run, if any, ended at the row before this one
      if (row.b) lastNoteRow = row;
    }
    flush(); // a run that ends at EOF
  }

  /**
   * Write the deletion zones onto the note pane's rendered blocks.
   *
   * WHY THIS IS ALLOWED given we cannot inject into the note pane: we are not
   * injecting. The reading view recycles its section elements and calls
   * sizerEl.setChildrenInPlace() every scroll tick, which rips out any element we ADD —
   * but it does not object to us restyling an element it already owns. Growing an
   * existing block IS a view zone; it just isn't a new node.
   *
   * PADDING, NOT MARGIN — load-bearing. Padding is inside the border box, so the rect
   * Obsidian's own measureSection() reads already includes it and its virtual-display
   * math (sizer min-height, section offsets) stays true. A margin lives OUTSIDE the
   * box: the reading view would measure each block at its unpadded height, disagree
   * with real layout by the sum of every zone above, and mis-place sections — trading
   * our drift for its drift.
   *
   * No text nodes, no textContent, no wrapper, no pseudo-content — an inline style on
   * an element the renderer already owns, safe for the side-comments plugin's anchors
   * by exactly the same argument as the diff classes.
   *
   * Bounded by RENDERED blocks (a screenful), not by the document: the row index is
   * read off the element's own data attribute, never re-derived by scanning rows.
   */
  applyDelPads(): void {
    const note = this.host.notePane();
    if (!note) return;
    for (const el of Array.from(
      note.scroller.querySelectorAll<HTMLElement>(`.${CLS.nblock}[${ATTR_ROW}]`)
    )) {
      this.styleDelPad(el);
    }
  }

  /** Apply (or clear) one note block's zone padding. Idempotent. */
  styleDelPad(el: HTMLElement): void {
    const idx = Number(el.getAttribute(ATTR_ROW));
    if (!isFinite(idx)) return;
    const bottom = this.delPadBottom.get(idx) || 0;
    const top = this.delPadTop.get(idx) || 0;
    const bpx = bottom > 0 ? bottom + 'px' : '';
    const tpx = top > 0 ? top + 'px' : '';
    // Compare before writing: this runs per section render and per refresh, and an
    // identical assignment still invalidates layout.
    if (el.style.paddingBottom !== bpx) el.style.paddingBottom = bpx;
    if (el.style.paddingTop !== tpx) el.style.paddingTop = tpx;
  }

  /** Diagnostic snapshot for the alignment report. */
  stats(): {
    ins: { total: number; knownHeights: number; reservedPx: number };
    del: { delRows: number; runs: number; reservedPx: number; leadingRunPx: number };
  } {
    const session = this.host.session;
    const insRows = session ? session.rows.filter((r) => r.kind === 'ins') : [];
    let reserved = 0;
    for (const r of insRows) reserved += this.insHeight(r.idx);
    const delValues = [...this.delPadBottom.values(), ...this.delPadTop.values()];
    return {
      ins: {
        total: insRows.length,
        knownHeights: insRows.filter((r) => this.insHeights.has(r.idx)).length,
        reservedPx: Number(reserved.toFixed(1)),
      },
      del: {
        delRows: session ? session.rows.filter((r) => r.kind === 'del').length : 0,
        runs: this.delPadBottom.size + this.delPadTop.size,
        reservedPx: Number(delValues.reduce((a, b) => a + b, 0).toFixed(1)),
        leadingRunPx: Number(
          [...this.delPadTop.values()].reduce((a, b) => a + b, 0).toFixed(1)
        ),
      },
    };
  }
}
