/**
 * charmarks.ts — word-level diff marks (VS Code's .char-insert / .char-delete layer).
 *
 * Two layers, exactly as VS Code's rendered-markdown diff does it:
 *   whole-block wash  -> .lgd-ins / .lgd-mod / .lgd-del
 *   changed WORDS     -> .lgd-char-ins / .lgd-char-del    (this module)
 *
 * The worker compares structural Markdown and refines its visible text. This layer
 * maps those ranges into Obsidian's rendered DOM, including inline code. Rendering
 * never defines equality; if text cannot be mapped, the block indicator survives.
 *
 * THE INVARIANT (spike 1 proved the safety, so this only has to preserve it):
 * `el.textContent` must be BYTE-IDENTICAL before and after wrapping. Characters may
 * be re-parented; not one may be added, removed, or reordered. The side-comments
 * plugin stores SOURCE-TEXT offsets and resolves them with a TreeWalker(SHOW_TEXT)
 * cumulative-length walk, which is invariant under splitting and wrapping precisely
 * because textContent's concatenation order is untouched. Adding so much as a "+"
 * marker would silently move every anchor after it. `wrapRanges` asserts this and
 * reverts rather than trusting the reasoning.
 *
 * DOM-LAZY BY DESIGN: nothing here touches `document` at module scope, and the
 * string half (tokenize/wordDiffRanges/coalesceRanges) is pure. That is what lets
 * test/charmarks.test.ts exercise the real range math in plain node, without a DOM.
 */
import { opcodes } from './diff/sequence.ts';
import { CLS } from './panes.ts';
import type { PaneHost } from './panes.ts';
import type { Row } from './session.ts';
import type { PairRow } from './diff/mddiff.ts';
import { tablePresentation } from './editorPresentation.ts';
import { clearTableCell, paintTableRow } from './nativeTablePresentation.ts';
import * as log from './log.ts';

/**
 * Above this fraction of changed words, marks are suppressed and the block keeps
 * only its wash. Marking ~everything is noise on top of a tint that already says
 * "this block changed" — VS Code effectively does the same.
 */
export const CHAR_MAX_CHANGED_FRACTION = 0.8;

/** Marker attribute identifying OUR spans, for idempotent unwrapping. */
export const CHAR_MARK_ATTR = 'data-lgd-char';

/** A [start, end) character range into a block's textContent. */
export type CharRange = [number, number];

/** Changed-word ranges for the two sides of one 'mod' row. */
export interface CharRanges {
  a: CharRange[];
  b: CharRange[];
}

interface Tokenized {
  toks: string[];
  offs: number[];
}

/** Split into words AND the whitespace between them (both kept, offsets exact). */
export function tokenize(text: string | null | undefined): Tokenized {
  const toks = String(text == null ? '' : text).match(/[\p{L}\p{M}\p{N}_]+|\s+|[^\s\p{L}\p{M}\p{N}_]/gu) || [''];
  const offs: number[] = [];
  let o = 0;
  for (const t of toks) { offs.push(o); o += t.length; }
  return { toks, offs };
}

export function isWsTok(t: string): boolean {
  return t === '' || /^\s+$/.test(t);
}

/**
 * Compare-key for a token. All whitespace collapses to a single space so that a
 * reflowed line (newline vs space) is not reported as a change — we are diffing what
 * the reader SEES, and rendered HTML collapses whitespace anyway.
 */
export function keyTok(t: string): string {
  return isWsTok(t) ? ' ' : t;
}

/** Fraction of NON-whitespace tokens that are marked. 0 when there are none. */
export function changedFraction(toks: string[], mark: boolean[]): number {
  let total = 0;
  let hit = 0;
  for (let i = 0; i < toks.length; i++) {
    if (isWsTok(toks[i])) continue;
    total++;
    if (mark[i]) hit++;
  }
  return total ? hit / total : 0;
}

/**
 * Marked tokens -> character ranges, coalesced.
 *
 * Ranges START and END on a real word: a run bridges ACROSS whitespace (marked or
 * not) so "the quick brown" becomes one span rather than three, but never begins or
 * ends on whitespace — a trailing marked space would paint a stripe into the margin
 * with nothing in it. Fewer, tighter spans also means less DOM churn per re-render.
 */
export function coalesceRanges(T: Tokenized, mark: boolean[]): CharRange[] {
  const out: CharRange[] = [];
  let i = 0;
  while (i < mark.length) {
    if (!mark[i] || isWsTok(T.toks[i])) { i++; continue; }
    let last = i;
    let k = i;
    while (k < mark.length) {
      if (mark[k] && !isWsTok(T.toks[k])) { last = k; k++; continue; }
      if (isWsTok(T.toks[k])) { k++; continue; } // bridge the gap, don't end on it
      break;                                     // an unchanged WORD ends the run
    }
    out.push([T.offs[i], T.offs[last] + T.toks[last].length]);
    i = k;
  }
  return out;
}

/**
 * Word-level diff of two rendered strings.
 * Reuses the block differ's `opcodes` (same LCS, different granularity) rather than
 * introducing a second diff algorithm with its own edge cases to learn.
 * @returns ranges for both sides, or null meaning "suppress marks for this block"
 */
export function wordDiffRanges(ta: string, tb: string): CharRanges | null {
  const A = tokenize(ta);
  const B = tokenize(tb);
  const ops = opcodes(A.toks.map(keyTok), B.toks.map(keyTok));
  const markA = new Array<boolean>(A.toks.length).fill(false);
  const markB = new Array<boolean>(B.toks.length).fill(false);
  for (const op of ops) {
    if (op[0] === 'equal') continue;
    for (let i = op[1]; i < op[2]; i++) markA[i] = true;
    for (let j = op[3]; j < op[4]; j++) markB[j] = true;
  }
  // Either side being ~entirely rewritten means the marks would cover the block.
  if (changedFraction(A.toks, markA) > CHAR_MAX_CHANGED_FRACTION ||
      changedFraction(B.toks, markB) > CHAR_MAX_CHANGED_FRACTION) {
    return null;
  }
  const a = coalesceRanges(A, markA);
  const b = coalesceRanges(B, markB);
  if (!a.length && !b.length) return null;
  return { a, b };
}

/**
 * Is this text node somewhere we must not split?
 * Code fences and math render their own internal structure; splitting a
 * token inside them is a confound at best and visibly wrong at worst. Their text
 * still COUNTS toward offsets (textContent includes it) — it is only skipped for
 * wrapping. Getting that distinction backwards would shift every later range.
 */
function inSkippedContext(node: Node, root: Element): boolean {
  for (let p = node.parentNode; p && p !== root; p = p.parentNode) {
    if (p.nodeType !== 1) continue;
    const pe = p as Element;
    const tag = pe.tagName;
    // Inline code is visible content. Excluding CODE hid endpoint/identifier changes.
    if (tag === 'PRE' || tag === 'SVG' || tag === 'MJX-CONTAINER') return true;
    if (pe.classList && (pe.classList.contains('math') || pe.classList.contains('MathJax'))) return true;
  }
  return false;
}

/**
 * Is this text node the formatting whitespace BETWEEN a table's cells?
 *
 * A `<tr>` is display:table-row, and CSS wraps any NON-CELL child of a table row in an
 * ANONYMOUS TABLE CELL. So wrapping the newline that sits between two `<td>`s does not
 * produce an invisible span — it produces an extra COLUMN, shoving every real cell in
 * that row sideways. Only CHANGED rows get marks, so a table comes apart along exactly
 * the rows the diff touched, which reads as "this plugin mangles tables".
 *
 * Observed on a 5-row table (2026-07-16): rows 0-2 `th,th,th` / `td,td,td`, while the two
 * changed rows read `td,span,td,span,td,span` — three phantom columns each.
 *
 * The textContent invariant CANNOT catch this. Re-parenting whitespace into a span leaves
 * el.textContent byte-identical, so the assertion passes while the layout is visibly
 * wrong. This is a PLACEMENT bug, not a text bug, and it needs its own guard.
 *
 * Checks the IMMEDIATE parent, not the ancestor chain: text inside a `<td>` is real
 * content and must stay markable — it is only text whose direct parent is table
 * STRUCTURE that has nowhere legal to live.
 */
export function isTableStructureWhitespace(t: Text): boolean {
  const p = t.parentElement;
  if (!p) return false;
  const tag = p.tagName;
  return tag === 'TR' || tag === 'TABLE' || tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT';
}

interface TextEntry {
  node: Text;
  start: number;
  end: number;
  skip: boolean;
}

/**
 * Every text node under `root`, with its cumulative textContent offsets.
 * Document order from a TreeWalker IS textContent's concatenation order — the same
 * substrate the side-comments plugin resolves against, which is why offsets computed
 * here mean the same thing to it.
 */
function collectTextNodes(root: Element): TextEntry[] {
  const doc = root.ownerDocument;
  // 4 = NodeFilter.SHOW_TEXT, spelled numerically: NodeFilter is a window global and
  // Obsidian pop-out windows are separate documents with their own.
  const walker = doc.createTreeWalker(root, 4, null);
  const out: TextEntry[] = [];
  let off = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const len = t.nodeValue ? t.nodeValue.length : 0;
    // Skipped entries STAY in the list carrying their offsets — that is the whole point
    // of the flag. Dropping them would shift every later range by their length.
    out.push({
      node: t,
      start: off,
      end: off + len,
      skip: inSkippedContext(t, root) || isTableStructureWhitespace(t),
    });
    off += len;
  }
  return out;
}

/**
 * Remove our spans, returning their characters to the parent. Idempotent.
 * `normalize()` merges the adjacent text nodes back together — it changes node
 * structure, never characters, so the cumulative-offset walk is unaffected.
 */
function presentationRoot(el: Element): HTMLElement {
  return (el.classList.contains('lgd-content') && el.parentElement?.classList.contains(CLS.block) ? el.parentElement : el) as HTMLElement;
}

export function unwrapCharMarks(el: Element): number {
  // Row washes are DERIVED from the marks, so they go when the marks go. Left behind, a
  // recycled block would keep yesterday's rows colored with nothing explaining why.
  (el as HTMLElement).removeClass(CLS.rowwise);
  presentationRoot(el).classList.remove(CLS.rowwise, 'lgd-itemwise');
  for (const item of Array.from(el.querySelectorAll('.lgd-item-changed'))) item.classList.remove('lgd-item-changed');
  for (const tr of Array.from(el.querySelectorAll('tr.' + CLS.rowchanged))) {
    (tr as HTMLElement).removeClass(CLS.rowchanged);
  }
  for (const cell of Array.from(el.querySelectorAll<HTMLElement>('.lgd-table-cell-ins,.lgd-table-cell-del'))) clearTableCell(cell);
  const marks = el.querySelectorAll('[' + CHAR_MARK_ATTR + ']');
  for (const span of Array.from(marks)) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }
  if (marks.length) el.normalize();
  return marks.length;
}

/**
 * Wash a table's CHANGED ROWS instead of the whole block. VS Code's shape, and the reason
 * is legibility rather than taste.
 *
 * Obsidian draws cell borders as a 0.55px line in #e0e0e0. Wash the whole table and every
 * border in it disappears into the tint — the diff reads as one colored slab with no grid,
 * which is worse than no highlight at all because the table stops being a table. VS Code
 * never does this: it colors only the rows the diff touched, so every unchanged row keeps
 * a white background and the grid survives.
 *
 * The signal is already in hand: apply() has just marked the changed WORDS, so a <tr> that
 * contains one of our spans is a row the diff touched. No second diff, no row-pairing
 * problem — the word ranges already answered it.
 *
 * @returns true if any row was marked, i.e. the caller should switch this block to
 *          row-wise washing. False for a non-table block, or a table whose marks are
 *          suppressed — both keep the ordinary block wash, which is the honest fallback:
 *          "something in here changed" is still true, and still visible.
 */
/** Translate worker ranges only when rendered text agrees; plugin output never defines equality. */
function renderedRanges(source: string, rendered: string, ranges: CharRange[]): CharRange[] {
  const positions = (text: string): number[] => {
    const result: number[] = [];
    for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) result.push(i);
    return result;
  };
  if (source.replace(/\s/g, '') !== rendered.replace(/\s/g, '')) return [];
  const a = positions(source), b = positions(rendered);
  const output: CharRange[] = [];
  for (const [start, end] of ranges) {
    const lo = a.findIndex(p => p >= start), hi = a.findIndex(p => p >= end);
    const last = (hi < 0 ? a.length : hi) - 1;
    if (lo >= 0 && last >= lo) output.push([b[lo], b[last] + 1]);
  }
  return output;
}

export function applyRowMarks(row: PairRow, element: HTMLElement, side: 'a' | 'b'): number {
  const block = row[side];
  if (!block || row.kind === 'same') return 0;
  const cls = side === 'a' ? CLS.charDel : CLS.charIns;
  let count = 0;
  if (block.cells) {
    const table = element.matches('table') ? element as HTMLTableElement : element.querySelector<HTMLTableElement>('table');
    if (!table || table.rows.length !== block.cells.length || Array.from(table.rows).some((tr, i) => tr.cells.length !== block.cells![i].length)) return 0;
    for (const change of tablePresentation(row, side)) {
      const tr = table.rows[change.index]; if (tr) paintTableRow(tr, change, side);
    }
    if (!row.simplified && !block.conservative) for (const change of row.cells || []) {
      const index = side === 'a' ? change.rowA : change.rowB;
      const cell = table.rows[index]?.cells[change.column], text = block.cells[index]?.[change.column]?.text;
      if (cell && text !== undefined) count += Math.max(0, wrapRanges(cell, renderedRanges(text, cell.textContent || '', change.detail[side]), cls));
    }
    presentationRoot(element).classList.add(CLS.rowwise);
    return count;
  }
  if (row.kind !== 'mod' || row.simplified || block.conservative) return 0;
  if (block.items && row.items && !row.listStructureChanged) {
    const list = element.matches('ul,ol') ? element : element.querySelector('ul,ol');
    const items = list ? Array.from(list.children).filter(child => child.tagName === 'LI') : [];
    // A renderer/plugin may replace the list. Keep the block indicator if it cannot be mapped.
    if (items.length !== block.items.length) return 0;
    presentationRoot(element).classList.add('lgd-itemwise');
    for (const change of row.items) {
      if (change.kind === 'same' || !change[side]) continue;
      const index = block.items.findIndex(item => item.sourceStart === change[side]!.sourceStart);
      const item = items[index] as HTMLElement | undefined;
      if (!item) continue;
      item.classList.add('lgd-item-changed');
      count += applyRowMarks(change, item, side);
    }
  } else if (row.detail) {
    count = Math.max(0, wrapRanges(element, renderedRanges(block.visibleText, element.textContent || '', row.detail[side]), cls));
  }
  return count;
}

/**
 * Wrap `ranges` (offsets into el.textContent) in `<span class=cls>`.
 *
 * NOT `Range.surroundContents()`: it throws whenever a range partially selects a
 * non-Text node, which is the normal case here — a changed phrase routinely spans
 * `plain **bold** more` (three text nodes, one of them inside an <strong>).
 * Instead: split each overlapping text node at the boundaries and wrap only the
 * middle. Splits are applied BACK TO FRONT within a node so the earlier offsets we
 * still have to use stay valid.
 *
 * NO `id` attributes — side-comments' extractContents() can CLONE an ancestor when a
 * comment mark partially crosses one of our spans, and a duplicated id would be a
 * genuine corruption. Classes and data-attrs clone harmlessly.
 *
 * @returns spans created, or -1 if the invariant tripped (already reverted)
 */
export function wrapRanges(el: Element, ranges: CharRange[], cls: string): number {
  if (!ranges || !ranges.length) return 0;
  const before = el.textContent;
  const nodes = collectTextNodes(el);
  let made = 0;

  for (const entry of nodes) {
    if (entry.skip) continue;
    const subs: CharRange[] = [];
    for (const r of ranges) {
      const s = Math.max(r[0], entry.start);
      const e = Math.min(r[1], entry.end);
      if (e > s) subs.push([s - entry.start, e - entry.start]);
    }
    if (!subs.length) continue;
    subs.sort((x, y) => x[0] - y[0]);

    // `cur` always holds the still-unprocessed PREFIX of the original node.
    const cur = entry.node;
    for (let k = subs.length - 1; k >= 0; k--) {
      const s = subs[k][0];
      const e = subs[k][1];
      if (e < (cur.nodeValue ? cur.nodeValue.length : 0)) cur.splitText(e); // shear off the tail
      const mid = s > 0 ? cur.splitText(s) : cur;                           // isolate [s,e)
      const span = el.ownerDocument.createElement('span');
      span.className = cls;
      span.setAttribute(CHAR_MARK_ATTR, '1');
      if (mid.parentNode) mid.parentNode.insertBefore(span, mid);
      span.appendChild(mid);                                               // re-parent, never re-create
      made++;
    }
  }

  // THE ASSERTION. This is not defensive padding: it is how a text-corruption bug
  // announces itself instead of silently poisoning the user's comment anchors — a
  // failure that would otherwise surface days later as "my comments moved".
  if (el.textContent !== before) {
    // log.error, not log.debug: this must NOT be behind the debug toggle. It means text
    // integrity failed, which is the one thing that could silently damage a user's
    // annotation anchors — they need to see it whether or not they opted into logging.
    log.error(
      'char-mark wrapping altered textContent — reverting. This is a bug; ' +
      'marks are disabled for this block rather than risk annotation anchors.',
      { cls, beforeLen: before ? before.length : 0, afterLen: el.textContent ? el.textContent.length : 0 }
    );
    unwrapCharMarks(el);
    return -1;
  }
  return made;
}

/* ------------------------------------------------------------------ *
 * the stateful layer                                                  *
 * ------------------------------------------------------------------ */

/**
 * Applies word-level marks to 'mod' rows, and measures whether doing so was safe.
 *
 * The two numbers this class exists to produce (both surfaced in the alignment report):
 *  - `heightDeltaMax` MUST be 0. Inline spans with a background should not change
 *    layout — but "should not" is the premise the view zones are built on, and a base
 *    block that grows when marked would desync every zone below it. So it is measured,
 *    not asserted.
 *  - `revertCount` MUST be 0. Non-zero means the textContent invariant tripped and
 *    marks were pulled from a block to protect annotation anchors.
 * Measured on a 94-change diff: 43/43 mod rows marked, 225 spans, 0 suppressed,
 * reverts 0, maxBaseHeightDeltaPx 0.
 */
export class CharMarkLayer {
  private host: PaneHost;

  /**
   * row.idx -> ranges, or null meaning "suppressed".
   * Cached because the ranges are a pure function of the two RENDERED texts, which do
   * not change for the life of a session — while the post-processor that needs them
   * re-fires every time a section recycles. `undefined` = not yet computed, `null` =
   * computed and deliberately empty. That distinction is load-bearing: without it a
   * suppressed block is re-diffed on every recycle forever.
   */
  private ranges: Map<number, CharRanges | null> = new Map();

  heightDeltaMax = 0;
  heightChangedBlocks = 0;
  spanCount = 0;
  revertCount = 0;

  /** Called when wrapping DID change a block's height, so zones can be re-derived. */
  onHeightChange: (() => void) | null = null;

  constructor(host: PaneHost) {
    this.host = host;
  }

  reset(): void {
    this.ranges = new Map();
    this.heightDeltaMax = 0;
    this.heightChangedBlocks = 0;
    this.spanCount = 0;
    this.revertCount = 0;
  }

  /**
   * Word-level marks for one 'mod' row: `.lgd-char-del` on the base block's changed
   * words, `.lgd-char-ins` on the note block's.
   *
   * WHY BOTH SIDES ARE DRIVEN FROM THE NOTE'S POST-PROCESSOR: the diff needs BOTH
   * rendered texts, and the note side is the one that may not exist yet. The base block
   * is always rendered (our pane, un-virtualised), so the moment the note block shows up
   * is the earliest moment either side can be marked. A 'mod' block whose note
   * counterpart never renders simply stays unmarked — invisible by construction, since
   * you can only see marks on screen.
   *
   * The base side is guarded by "does it already carry spans?" rather than by the range
   * cache: a base RE-RENDER hands us fresh, unwrapped elements while the cache stays
   * warm, and keying off the cache would leave the base permanently bare.
   */
  apply(row: Row, noteEl: HTMLElement): void {
    const baseEl = this.host.baseView()?.blockEls.get(row.idx)?.querySelector<HTMLElement>('.lgd-content');
    if (baseEl) { unwrapCharMarks(baseEl); this.spanCount += applyRowMarks(row, baseEl, 'a'); }
    unwrapCharMarks(noteEl);
    this.spanCount += applyRowMarks(row, noteEl, 'b');
  }
  /** Diagnostic snapshot for the alignment report. */
  stats(modRows: number): Record<string, number> {
    let suppressed = 0;
    for (const v of this.ranges.values()) if (!v) suppressed++;
    return {
      modRows,
      computed: this.ranges.size,
      suppressed,
      spans: this.spanCount,
      maxBaseHeightDeltaPx: Number(this.heightDeltaMax.toFixed(2)),
      blocksWithHeightChange: this.heightChangedBlocks,
      reverts: this.revertCount,
      suppressAboveChangedFraction: CHAR_MAX_CHANGED_FRACTION,
    };
  }
}


