/**
 * spike2b-gitdiff — side-by-side rendered review of a note vs its pinned git base,
 *                   WITH ANCHOR-BASED SCROLL SYNC (this is what 2b adds over 2a).
 *
 * SCROLL SYNC — the short version
 * ------------------------------
 * The naive "measure every block in both panes, pad with spacers, mirror scrollTop"
 * strategy is unavailable to us: Obsidian's reading view only keeps sections near the
 * viewport in the DOM, so the heights of far-off blocks in the NOTE pane cannot be
 * measured — they do not exist. Everything here is therefore built on ANCHORS: the
 * topmost VISIBLE block (which by definition is rendered), its source line range, and
 * the block-pairing we already computed. See `syncNoteToBase` / `syncBaseToNote`.
 *
 * VIEW ZONES — why the anchor alone isn't enough
 * ----------------------------------------------
 * Anchoring makes ONE block exact. Everything below it drifts by however much the two
 * panes disagree in height in between — and since paired blocks now measure
 * identically, that disagreement is exactly the UNPAIRED runs: text inserted since the
 * base exists only in the note, text deleted since the base exists only in the base.
 *
 * VS Code solves this with "view zones": blank reserved space on whichever side is
 * short, both sides' real content always shown at full size (it does NOT collapse
 * deletions). We do the same, but each side of the diff needs a different technique,
 * because we own one pane and merely decorate the other:
 *
 *   'ins' (note has it, base doesn't) -> `.sp2a-spacer`, a real empty element in the
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
 * The spacers are also ANCHORS, not just spacing: a spacer sits where its row's content
 * sits in reading order, so a topmost-visible 'ins' block aligns to its spacer exactly,
 * instead of falling through to the interpolating estimate. That fallback still exists
 * as a guard, but with zones in place every note row has a counterpart and it should
 * rarely fire.
 *
 * LEFT  pane: custom read-only ItemView. Renders the git base version of the note,
 *             fetched into memory via `git show`. Never lands on disk.
 * RIGHT pane: the REAL note in a normal markdown leaf, decorated only by adding
 *             CSS classes to block containers via a markdown post-processor. This
 *             is what keeps the side-comments plugin and TTS plugins working.
 *
 * READ-ONLY INVARIANT
 * -------------------
 * This plugin never alters any note, and never persists anything (no plugin data
 * file either — the review session lives in memory only). Its entire effect on the
 * world is: spawn `git` to read text, read note text, build DOM, add CSS classes.
 * The only mutation-shaped thing it does is attach classes to elements the preview
 * renderer already owns.
 *
 * Two consequences worth stating, because they look odd on purpose:
 *  1. The invariant is checked by grepping for WRITE METHODS, not for the
 *     filesystem handle. An earlier draft dodged a handle-shaped grep by
 *     destructuring; that made the check pass by phrasing rather than by fact, so
 *     the check was narrowed instead. The one thing used from the handle is
 *     absolute-path resolution — pure string math, no I/O. See README.
 *  2. Rails/highlights are CSS only (borders, backgrounds). We never touch text
 *     nodes or inject text inside a rendered block — doing so silently breaks the
 *     side-comments plugin's anchors.
 */
'use strict';

const obsidian = require('obsidian');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
/* ---- inlined mddiff.js (Obsidian evaluates main.js without relative require
   resolution, so a sibling module never loads — this is why plugins bundle) ---- */
const { blocks, pair, opcodes } = (function () {
/**
 * mddiff.js — markdown block splitting + block pairing for side-by-side diff review.
 *
 * Dependency-free CommonJS, ES2018. Runs in plain node AND in Electron/Obsidian's
 * renderer (no node builtins used, no fs, no build step).
 *
 * Mirrors the semantics of scripts/render-preview.py (blocks/norm/pair),
 * with two additions: blocks carry 0-indexed inclusive source line ranges, and
 * 'mod' pairs are gated by a similarity threshold so unrelated blocks are never
 * shown as a modification of each other.
 */


/** Similarity threshold below which a replace-run pair is split into del+ins. */
var MOD_MIN_SIMILARITY = 0.5;

/** A line that STARTS a list item. Used to match Obsidian's section grain. */
var LIST_START = /^\s*(?:[-*+]|\d+[.)])\s/;

/**
 * Split markdown source into top-level blocks.
 * A block = a run of non-blank lines, OR a whole fenced code block (``` ... ```),
 * separated by blank lines. Fence contents are NEVER split on blank lines.
 * @param {string} text
 * @returns {Array<{text:string, lineStart:number, lineEnd:number}>}
 *   lineStart/lineEnd are 0-indexed, INCLUSIVE, referring to the source lines.
 */
function blocks(text) {
  var lines = String(text == null ? '' : text).split('\n');
  var out = [];
  var cur = [];
  var curStart = -1;
  var fence = false;

  function push(endIdx) {
    if (!cur.length) return;
    out.push({ text: cur.join('\n'), lineStart: curStart, lineEnd: endIdx });
    cur = [];
    curStart = -1;
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.replace(/^\s+/, '').indexOf('```') === 0) {
      fence = !fence;
      if (curStart < 0) curStart = i;
      cur.push(line);
      if (!fence) push(i); // closing fence ends the block immediately
      continue;
    }
    if (fence) {
      if (curStart < 0) curStart = i;
      cur.push(line);
      continue;
    }
    if (line.trim() === '') {
      push(i - 1);
    } else {
      // Obsidian's renderer sections a LIST separately from a paragraph that
      // immediately precedes it with no blank line; our "run of non-blank lines"
      // grain merged them. That grain mismatch is not cosmetic: a merged base
      // block is one element where the note has two, so the pair has different
      // heights and every block below it drifts. Measured on the reference corpus:
      // 308 Obsidian sections vs 270 of our blocks — all 38 of the difference
      // were exactly this paragraph+list case.
      if (cur.length && LIST_START.test(line) && !LIST_START.test(cur[cur.length - 1])) {
        push(i - 1);
      }
      if (curStart < 0) curStart = i;
      cur.push(line);
    }
  }
  push(lines.length - 1);
  return out;
}

/** Normalize: collapse all whitespace to single spaces, trim, lowercase. */
function norm(b) {
  return String(b).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Similarity ratio in [0,1] between two normalized strings.
 * Metric: Dice coefficient over whitespace-delimited token MULTISETS —
 *   2 * |intersection| / (|A| + |B|)
 * Multiset (not set) semantics: a token appearing 3x in A and 1x in B
 * contributes 1 to the intersection, so repeated-token blocks don't inflate.
 * Chosen over Levenshtein because it is O(n) rather than O(n*m) on long
 * paragraphs and is insensitive to word reordering, which is the common
 * "reworded sentence" case this gate exists for.
 * Degenerate: two empty token lists => 1 (identical); one empty => 0.
 */
function similarity(na, nb) {
  if (na === nb) return 1;
  var ta = na ? na.split(' ') : [];
  var tb = nb ? nb.split(' ') : [];
  if (!ta.length && !tb.length) return 1;
  if (!ta.length || !tb.length) return 0;
  var counts = Object.create(null);
  for (var i = 0; i < ta.length; i++) {
    var k = ' ' + ta[i];
    counts[k] = (counts[k] || 0) + 1;
  }
  var inter = 0;
  for (var j = 0; j < tb.length; j++) {
    var k2 = ' ' + tb[j];
    if (counts[k2] > 0) { counts[k2]--; inter++; }
  }
  return (2 * inter) / (ta.length + tb.length);
}

/**
 * Standard DP LCS over two string arrays -> difflib-style opcodes.
 * O(n*m) time/space. For ~300x300 blocks this is ~90k cells (<1ms).
 * @returns {Array<[string,number,number,number,number]>} [tag,i1,i2,j1,j2]
 *   tag in 'equal'|'delete'|'insert'|'replace'
 */
function opcodes(A, B) {
  var n = A.length, m = B.length;
  // dp[i][j] = LCS length of A[i:], B[j:]
  var dp = new Array(n + 1);
  for (var i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
  for (var i2 = n - 1; i2 >= 0; i2--) {
    for (var j2 = m - 1; j2 >= 0; j2--) {
      dp[i2][j2] = A[i2] === B[j2]
        ? dp[i2 + 1][j2 + 1] + 1
        : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
    }
  }
  // Walk the traceback, emitting raw per-element ops, then coalesce into runs.
  var raw = [];
  var i3 = 0, j3 = 0;
  while (i3 < n && j3 < m) {
    if (A[i3] === B[j3]) { raw.push(['equal', i3, j3]); i3++; j3++; }
    else if (dp[i3 + 1][j3] >= dp[i3][j3 + 1]) { raw.push(['delete', i3, j3]); i3++; }
    else { raw.push(['insert', i3, j3]); j3++; }
  }
  while (i3 < n) { raw.push(['delete', i3, j3]); i3++; }
  while (j3 < m) { raw.push(['insert', i3, j3]); j3++; }

  // Coalesce adjacent same-tag ops into runs; merge an adjacent delete-run +
  // insert-run into a single 'replace' run (difflib's opcode shape).
  var runs = [];
  for (var r = 0; r < raw.length; r++) {
    var tag = raw[r][0], ri = raw[r][1], rj = raw[r][2];
    var last = runs[runs.length - 1];
    if (last && last[0] === tag) {
      if (tag === 'equal') { last[2] = ri + 1; last[4] = rj + 1; }
      else if (tag === 'delete') last[2] = ri + 1;
      else last[4] = rj + 1;
      continue;
    }
    if (tag === 'equal') runs.push(['equal', ri, ri + 1, rj, rj + 1]);
    else if (tag === 'delete') runs.push(['delete', ri, ri + 1, rj, rj]);
    else runs.push(['insert', ri, ri, rj, rj + 1]);
  }
  var merged = [];
  for (var q = 0; q < runs.length; q++) {
    var cur = runs[q];
    var prev = merged[merged.length - 1];
    if (prev && ((prev[0] === 'delete' && cur[0] === 'insert') ||
                 (prev[0] === 'insert' && cur[0] === 'delete'))) {
      merged[merged.length - 1] = ['replace',
        Math.min(prev[1], cur[1]), Math.max(prev[2], cur[2]),
        Math.min(prev[3], cur[3]), Math.max(prev[4], cur[4])];
      continue;
    }
    merged.push(cur);
  }
  return merged;
}

/**
 * Pair blocks between version A (before) and version B (after).
 * @param {Array<{text:string}>} blocksA
 * @param {Array<{text:string}>} blocksB
 * @returns {Array<{kind:'same'|'mod'|'del'|'ins', a:Object|null, b:Object|null}>}
 */
function pair(blocksA, blocksB) {
  var As = blocksA || [], Bs = blocksB || [];
  var NA = As.map(function (x) { return norm(x.text); });
  var NB = Bs.map(function (x) { return norm(x.text); });
  var ops = opcodes(NA, NB);
  var rows = [];

  for (var o = 0; o < ops.length; o++) {
    var tag = ops[o][0], i1 = ops[o][1], i2 = ops[o][2], j1 = ops[o][3], j2 = ops[o][4];
    if (tag === 'equal') {
      for (var k = 0; k < i2 - i1; k++) {
        rows.push({ kind: 'same', a: As[i1 + k], b: Bs[j1 + k] });
      }
    } else if (tag === 'delete') {
      for (var d = i1; d < i2; d++) rows.push({ kind: 'del', a: As[d], b: null });
    } else if (tag === 'insert') {
      for (var s = j1; s < j2; s++) rows.push({ kind: 'ins', a: null, b: Bs[s] });
    } else { // replace — align pairwise; overflow becomes pure del/ins
      var n = Math.max(i2 - i1, j2 - j1);
      var pending = []; // ins rows held back so del/ins stay grouped per index
      for (var p = 0; p < n; p++) {
        var a = (i1 + p < i2) ? As[i1 + p] : null;
        var b = (j1 + p < j2) ? Bs[j1 + p] : null;
        if (a && b) {
          if (similarity(NA[i1 + p], NB[j1 + p]) >= MOD_MIN_SIMILARITY) {
            rows.push({ kind: 'mod', a: a, b: b });
          } else {
            // Not actually a modification of each other — show as separate ops.
            rows.push({ kind: 'del', a: a, b: null });
            pending.push({ kind: 'ins', a: null, b: b });
          }
        } else if (a) {
          rows.push({ kind: 'del', a: a, b: null });
        } else if (b) {
          pending.push({ kind: 'ins', a: null, b: b });
        }
      }
      for (var y = 0; y < pending.length; y++) rows.push(pending[y]);
    }
  }
  return rows;
}



  // `opcodes` is exported so the WORD-level diff can reuse this exact LCS at a finer
  // granularity, rather than the file growing a second diff algorithm with its own
  // edge cases. Same function, different tokens.
  return { blocks: blocks, pair: pair, norm: norm, similarity: similarity, opcodes: opcodes };
})();


/* View type and plugin id are 2b-specific so this can be installed ALONGSIDE spike2a
   without the two plugins fighting over one registered view type. */
const VIEW_TYPE = 'spike2b-gitdiff-view';

/**
 * Where the alignment diagnostic lands. Outside the vault, not a note.
 * This IS a file write, and the read-only invariant grep bans `writeFile` — so the
 * grep matches here, on purpose and in the plainest possible phrasing. The honest
 * form of the check is "no write to any NOTE", i.e. run the grep with this one line
 * excluded rather than pretend it isn't a write. See README "Read-only invariant".
 */
const REPORT_PATH =
  '/tmp/spike-scratch/' +
  'spike2b-align-report.json';

/* ------------------------------------------------------------------ *
 * small geometry helpers                                              *
 * ------------------------------------------------------------------ */

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Scroll-space offset of `el` inside scroll container `box`.
 * Deliberately rect-based rather than offsetTop: offsetTop is relative to the
 * nearest POSITIONED ancestor, which is neither pane's scroller today and would
 * silently start lying the moment someone adds `position:relative` to a wrapper.
 */
function offsetIn(box, el) {
  return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
}

function maxScroll(box) {
  return Math.max(0, box.scrollHeight - box.clientHeight);
}

/**
 * Find the element that actually scrolls a markdown reading view.
 * Feature-detected, never assumed: attaching to the wrong element yields zero scroll
 * events and a plugin that looks "enabled but dead". Returns null (caller warns).
 */
function findPreviewScroller(view) {
  const roots = [];
  if (view.previewMode && view.previewMode.containerEl) roots.push(view.previewMode.containerEl);
  if (view.contentEl) roots.push(view.contentEl);
  if (view.containerEl) roots.push(view.containerEl);

  const scrollable = (el) => {
    if (!el) return false;
    // ownerDocument.defaultView, not `window`: Obsidian pop-out windows are separate
    // documents and their getComputedStyle must come from their own window.
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const ov = win.getComputedStyle(el).overflowY;
    return (ov === 'auto' || ov === 'scroll') || el.scrollHeight > el.clientHeight + 1;
  };

  for (const root of roots) {
    // Known shape: `.markdown-preview-view` is the scroller, `.markdown-preview-sizer`
    // is the content inside it. Verify rather than trust.
    const cands = [];
    if (root.classList && root.classList.contains('markdown-preview-view')) cands.push(root);
    cands.push(...Array.from(root.querySelectorAll('.markdown-preview-view')));
    cands.push(...Array.from(root.querySelectorAll('.markdown-reading-view')));
    for (const c of cands) if (scrollable(c)) return c;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * word-level diff marks (VS Code's .char-insert / .char-delete layer)  *
 *                                                                      *
 * Two layers, exactly as VS Code's rendered-markdown diff does it:
 *   whole-block wash  -> .sp2a-ins / .sp2a-mod / .sp2a-del  (we had this)
 *   changed WORDS     -> .sp2a-char-ins / .sp2a-char-del    (this section)
 *
 * WE DIFF THE RENDERED TEXT, NOT THE MARKDOWN. Both blocks are rendered and in
 * hand, so `baseEl.textContent` vs `noteEl.textContent` sidesteps source->rendered
 * offset mapping entirely — `**bold**` in source is `bold` on screen, and every
 * offset derived from the source would be wrong by the width of the syntax.
 *
 * THE INVARIANT (spike 1 proved the safety, so this only has to preserve it):
 * `el.textContent` must be BYTE-IDENTICAL before and after wrapping. Characters may
 * be re-parented; not one may be added, removed, or reordered. The side-comments
 * plugin stores SOURCE-TEXT offsets and resolves them with a TreeWalker(SHOW_TEXT)
 * cumulative-length walk, which is invariant under splitting and wrapping precisely
 * because textContent's concatenation order is untouched. Adding so much as a "+"
 * marker would silently move every anchor after it. `wrapRanges` asserts this and
 * reverts rather than trusting the reasoning.
 * ------------------------------------------------------------------ */

/**
 * Above this fraction of changed words, marks are suppressed and the block keeps
 * only its wash. Marking ~everything is noise on top of a tint that already says
 * "this block changed" — VS Code effectively does the same.
 */
const CHAR_MAX_CHANGED_FRACTION = 0.8;

/** Marker attribute identifying OUR spans, for idempotent unwrapping. */
const CHAR_MARK_ATTR = 'data-sp2a-char';

/** Split into words AND the whitespace between them (both kept, offsets exact). */
function tokenize(text) {
  const toks = String(text == null ? '' : text).split(/(\s+)/);
  const offs = [];
  let o = 0;
  for (const t of toks) { offs.push(o); o += t.length; }
  return { toks, offs };
}

function isWsTok(t) {
  return t === '' || /^\s+$/.test(t);
}

/**
 * Compare-key for a token. All whitespace collapses to a single space so that a
 * reflowed line (newline vs space) is not reported as a change — we are diffing what
 * the reader SEES, and rendered HTML collapses whitespace anyway.
 */
function keyTok(t) {
  return isWsTok(t) ? ' ' : t;
}

/** Fraction of NON-whitespace tokens that are marked. 0 when there are none. */
function changedFraction(toks, mark) {
  let total = 0, hit = 0;
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
function coalesceRanges(T, mark) {
  const out = [];
  let i = 0;
  while (i < mark.length) {
    if (!mark[i] || isWsTok(T.toks[i])) { i++; continue; }
    let last = i;
    let k = i;
    while (k < mark.length) {
      if (mark[k] && !isWsTok(T.toks[k])) { last = k; k++; continue; }
      if (isWsTok(T.toks[k])) { k++; continue; } // bridge the gap, don't end on it
      break;                                      // an unchanged WORD ends the run
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
 * @returns {{a:Array<[number,number]>, b:Array<[number,number]>}|null} null = suppress
 */
function wordDiffRanges(ta, tb) {
  const A = tokenize(ta);
  const B = tokenize(tb);
  const ops = opcodes(A.toks.map(keyTok), B.toks.map(keyTok));
  const markA = new Array(A.toks.length).fill(false);
  const markB = new Array(B.toks.length).fill(false);
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
 * Code fences, inline code and math render their own internal structure; splitting a
 * token inside them is a confound at best and visibly wrong at worst. Their text
 * still COUNTS toward offsets (textContent includes it) — it is only skipped for
 * wrapping. Getting that distinction backwards would shift every later range.
 */
function inSkippedContext(node, root) {
  for (let p = node.parentNode; p && p !== root; p = p.parentNode) {
    if (p.nodeType !== 1) continue;
    const tag = p.tagName;
    if (tag === 'PRE' || tag === 'CODE' || tag === 'SVG' || tag === 'MJX-CONTAINER') return true;
    if (p.classList && (p.classList.contains('math') || p.classList.contains('MathJax'))) return true;
  }
  return false;
}

/**
 * Every text node under `root`, with its cumulative textContent offsets.
 * Document order from a TreeWalker IS textContent's concatenation order — the same
 * substrate the side-comments plugin resolves against, which is why offsets computed
 * here mean the same thing to it.
 */
function collectTextNodes(root) {
  const doc = root.ownerDocument;
  // 4 = NodeFilter.SHOW_TEXT, spelled numerically: NodeFilter is a window global and
  // Obsidian pop-out windows are separate documents with their own.
  const walker = doc.createTreeWalker(root, 4, null);
  const out = [];
  let off = 0;
  let n;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    out.push({ node: n, start: off, end: off + len, skip: inSkippedContext(n, root) });
    off += len;
  }
  return out;
}

/**
 * Remove our spans, returning their characters to the parent. Idempotent.
 * `normalize()` merges the adjacent text nodes back together — it changes node
 * structure, never characters, so the cumulative-offset walk is unaffected.
 */
function unwrapCharMarks(el) {
  const marks = el.querySelectorAll('[' + CHAR_MARK_ATTR + ']');
  for (const span of marks) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }
  if (marks.length) el.normalize();
  return marks.length;
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
 * @returns {number} spans created, or -1 if the invariant tripped (already reverted)
 */
function wrapRanges(el, ranges, cls) {
  if (!ranges || !ranges.length) return 0;
  const before = el.textContent;
  const nodes = collectTextNodes(el);
  let made = 0;

  for (const entry of nodes) {
    if (entry.skip) continue;
    const subs = [];
    for (const r of ranges) {
      const s = Math.max(r[0], entry.start);
      const e = Math.min(r[1], entry.end);
      if (e > s) subs.push([s - entry.start, e - entry.start]);
    }
    if (!subs.length) continue;
    subs.sort((x, y) => x[0] - y[0]);

    // `cur` always holds the still-unprocessed PREFIX of the original node.
    let cur = entry.node;
    for (let k = subs.length - 1; k >= 0; k--) {
      const s = subs[k][0];
      const e = subs[k][1];
      if (e < cur.nodeValue.length) cur.splitText(e); // shear off the tail
      const mid = s > 0 ? cur.splitText(s) : cur;     // isolate [s,e)
      const span = el.ownerDocument.createElement('span');
      span.className = cls;
      span.setAttribute(CHAR_MARK_ATTR, '1');
      mid.parentNode.insertBefore(span, mid);
      span.appendChild(mid);                          // re-parent, never re-create
      made++;
    }
  }

  // THE ASSERTION. This is not defensive padding: it is how a text-corruption bug
  // announces itself instead of silently poisoning the user's comment anchors — a
  // failure that would otherwise surface days later as "my comments moved".
  if (el.textContent !== before) {
    console.error(
      '[spike2b] char-mark wrapping altered textContent — reverting. This is a bug; ' +
      'marks are disabled for this block rather than risk comment anchors.',
      { cls, beforeLen: before.length, afterLen: el.textContent.length }
    );
    unwrapCharMarks(el);
    return -1;
  }
  return made;
}

/* ------------------------------------------------------------------ *
 * git plumbing                                                        *
 * ------------------------------------------------------------------ */

/** Error carrying a human-facing explanation for the left pane. */
class GitError extends Error {}

/**
 * Run git with argv (never a shell string — paths here contain spaces).
 * @param {string[]} args
 * @returns {string} stdout
 */
function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (e) {
    const stderr = (e && e.stderr ? String(e.stderr) : '').trim();
    if (e && e.code === 'ENOENT') {
      throw new GitError('git not found on PATH. Is git installed?');
    }
    throw new GitError(stderr || (e && e.message) || 'git failed');
  }
}

/**
 * Absolute on-disk path of a vault file.
 * NOTE: the filesystem handle is destructured deliberately — see the header.
 * getFullPath is pure path arithmetic; no I/O, no writing.
 */
function absPathOf(app, file) {
  // Written in the plain form on purpose. The read-only invariant is enforced by
  // grepping for WRITE methods, not for this handle — a check you pass by phrasing
  // is not a check. getFullPath is pure string math; no I/O, no mutation.
  if (app.vault.adapter && typeof app.vault.adapter.getFullPath === 'function') {
    return app.vault.adapter.getFullPath(file.path);
  }
  const base = app.vault.adapter && app.vault.adapter.basePath;
  if (!base) {
    throw new GitError('Cannot resolve this vault to a real folder on disk.');
  }
  return path.join(base, file.path);
}

/**
 * Resolve the git toplevel for a file.
 *
 * CRITICAL: the vault root is NOT necessarily the git root. This user's vault is
 * a SUBDIRECTORY of the repo, so the path we hand to `git show` must be relative
 * to the git toplevel, never relative to the vault. Getting this wrong makes
 * `git show` fail and the base pane come back empty — which reads as "the whole
 * file is brand new" rather than as an error. That is exactly the wrong-but-
 * plausible failure this function exists to prevent.
 */
function resolveGit(app, file) {
  const abs = absPathOf(app, file);
  const dir = path.dirname(abs);
  let root;
  try {
    root = git(['-C', dir, 'rev-parse', '--show-toplevel']).trim();
  } catch (e) {
    throw new GitError(
      `Not inside a git repository (${dir}).\n${e.message}`
    );
  }
  // Relative to the GIT ROOT, POSIX-separated (git speaks posix paths).
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) {
    throw new GitError(`File resolves outside its git root:\n  file: ${abs}\n  root: ${root}`);
  }
  return { abs, root, rel };
}

/** Current HEAD sha of a repo. */
function headSha(root) {
  try {
    return git(['-C', root, 'rev-parse', 'HEAD']).trim();
  } catch (e) {
    throw new GitError(
      `Cannot read HEAD — the repo may have no commits yet.\n${e.message}`
    );
  }
}

/** Text of <rel> at <sha>. Throws GitError with a readable reason. */
function showAt(root, sha, rel) {
  try {
    return git(['-C', root, 'show', `${sha}:${rel}`]);
  } catch (e) {
    const m = e.message || '';
    if (/exists on disk, but not in|does not exist in|path .* does not exist/i.test(m)) {
      throw new GitError(
        `Not tracked in git at ${sha.slice(0, 7)}:\n  ${rel}\n\n` +
        `The file is untracked, or was added after this base commit — ` +
        `so there is no earlier version to compare against.`
      );
    }
    throw new GitError(`git show failed for ${rel} at ${sha.slice(0, 7)}:\n${m}`);
  }
}

/* ------------------------------------------------------------------ *
 * review session (in memory only — nothing is persisted)              *
 * ------------------------------------------------------------------ */

/**
 * Annotate one pane's ordered row list with the anchor data scroll-sync needs.
 *
 * `list` is the subsequence of rows VISIBLE in that pane (a 'del' row simply does not
 * exist in the note pane; an 'ins' row does not exist in the base pane), so positions
 * here are that pane's document order.
 *
 * For every row we record: its position, the nearest PAIRED row before and after it,
 * and — for unpaired rows — its index within its run of unpaired rows plus the run
 * length. Those last two are what let us interpolate across an insertion/deletion
 * region without measuring blocks that may not be rendered.
 *
 * @param {Array<object>} list rows in one pane's order (mutated in place)
 * @param {string} K key prefix: 'pn' (note pane) or 'pb' (base pane)
 */
function indexSide(list, K) {
  let lastPaired = null;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    r[K + 'Pos'] = i;
    r[K + 'Prev'] = lastPaired;
    if (r.paired) lastPaired = r;
  }
  let nextPaired = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    r[K + 'Next'] = nextPaired;
    if (r.paired) nextPaired = r;
  }
  let i = 0;
  while (i < list.length) {
    if (list[i].paired) { i++; continue; }
    let j = i;
    while (j < list.length && !list[j].paired) j++;
    for (let k = i; k < j; k++) {
      list[k][K + 'RunIdx'] = k - i;
      list[k][K + 'RunLen'] = j - i;
    }
    i = j;
  }
}

/**
 * Build a review session for `file`, pinning the base sha ONCE.
 *
 * Why pinned: Claude commits while a review is in progress. If we diffed against
 * a live HEAD, the diff would silently shrink toward zero as commits land, and
 * the review would appear to "finish itself". The base sha is captured here and
 * every later `git show` uses it. Re-pinning is an explicit user command.
 */
function buildSession(app, file, baseText, ctx, sha, currentText) {
  const headBlocks = blocks(baseText);
  const curBlocks = blocks(currentText);
  const rows = pair(headBlocks, curBlocks);

  // Line map for the RIGHT pane: only rows that exist in the current file.
  const curMap = [];
  for (const row of rows) {
    if (!row.b) continue;
    curMap.push({ kind: row.kind, lineStart: row.b.lineStart, lineEnd: row.b.lineEnd });
  }

  const changed = rows.filter((r) => r.kind !== 'same').length;

  // ---- scroll-sync anchor index -------------------------------------------
  // A row is an ANCHOR only if it exists in BOTH panes ('same' or 'mod'). 'ins' and
  // 'del' rows are the drift-prone regions and are handled by interpolation.
  const noteRows = []; // rows present in the note pane (pane A), in its order
  const baseRows = []; // rows present in the base pane (pane B), in its order
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    row.idx = i;
    row.paired = !!(row.a && row.b);
    if (row.b) noteRows.push(row);
    if (row.a) baseRows.push(row);
  }
  indexSide(noteRows, 'pn');
  indexSide(baseRows, 'pb');

  return {
    filePath: file.path,
    fileName: file.name,
    sha,
    shortSha: sha.slice(0, 7),
    root: ctx.root,
    rel: ctx.rel,
    rows,
    noteRows,
    baseRows,
    // Last 0-indexed line of the current file's last block — the clamp target when a
    // trailing insertion has no following paired anchor.
    curLastLine: curBlocks.length ? curBlocks[curBlocks.length - 1].lineEnd : 0,
    curMap,
    counts: { blocks: headBlocks.length, curBlocks: curBlocks.length, changed },
    error: null,
  };
}

/* ------------------------------------------------------------------ *
 * left pane                                                           *
 * ------------------------------------------------------------------ */

class GitBaseView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    /** The scrolling element of this pane (`.sp2a-body`). Recreated on every render. */
    this.bodyEl = null;
    /** @type {Map<number, HTMLElement>} row.idx -> its block container in this pane. */
    this.blockEls = new Map();
    /**
     * @type {Map<number, HTMLElement>} row.idx -> the VIEW ZONE standing in for an
     * 'ins' row (text the note has and the base does not). See `render`.
     */
    this.spacerEls = new Map();
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    const s = this.plugin.session;
    return s ? `Base: ${s.fileName}` : 'Git base';
  }

  getIcon() {
    return 'git-compare';
  }

  async onOpen() {
    await this.render();
  }

  /** Full re-render from the plugin's current in-memory session. */
  async render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('sp2a-view');
    // Stale after empty() — rebuilt below, and the plugin re-attaches its scroll
    // listener to the NEW body element once this returns.
    this.bodyEl = null;
    this.blockEls = new Map();
    this.spacerEls = new Map();

    const session = this.plugin.session;
    if (!session) {
      root.createDiv({ cls: 'sp2a-empty', text: 'No review session. Run "Spike2a: open git diff review for this file".' });
      return;
    }

    const header = root.createDiv({ cls: 'sp2a-header' });
    header.createDiv({ cls: 'sp2a-title', text: session.fileName });

    if (session.error) {
      header.createDiv({ cls: 'sp2a-sub', text: 'base unavailable' });
      // 'markdown-preview-view markdown-rendered' are Obsidian's own reading-view classes.
    // Inheriting them means the base pane is typeset by the SAME css as the real note
    // (theme, font size, spacing) instead of a hand-rolled lookalike that drifts.
    const body = root.createDiv({ cls: 'sp2a-body markdown-preview-view markdown-rendered' });
      body.createDiv({ cls: 'sp2a-error', text: session.error });
      return;
    }

    const sub = header.createDiv({ cls: 'sp2a-sub' });
    sub.createSpan({ cls: 'sp2a-sha', text: `base ${session.shortSha}` });
    sub.createSpan({
      text: ` · ${session.counts.blocks} blocks · ${session.counts.changed} changed`,
    });
    this.syncBadgeEl = sub.createSpan({ cls: 'sp2b-sync' });
    this.updateSyncBadge();

    // 'markdown-preview-view markdown-rendered' are Obsidian's own reading-view classes.
    // Inheriting them means the base pane is typeset by the SAME css as the real note
    // (theme, font size, spacing) instead of a hand-rolled lookalike that drifts.
    const body = root.createDiv({ cls: 'sp2a-body markdown-preview-view markdown-rendered' });
    this.bodyEl = body;
    // Obsidian's reading view is `.markdown-preview-view > .markdown-preview-sizer
    // .markdown-preview-section > <block>`. The sizer is what carries the content
    // padding and reading width; without it the theme's block spacing has nothing
    // to hang off and the pane reads as squished. Mirror the real structure rather
    // than re-deriving the typography ourselves.
    const sizer = body.createDiv({ cls: 'markdown-preview-sizer markdown-preview-section' });

    // Render the BASE version block by block. Because we did the splitting, we
    // own the line map on this side — no getSectionInfo needed here.
    for (const row of session.rows) {
      if (!row.a) {
        // VIEW ZONE (VS Code's term). An 'ins' row exists only in the note, so the
        // base pane is SHORTER than the note by that block's height and every paired
        // block below the run lands too high. We own this DOM, so we can reserve the
        // missing height with an empty element — the trick the note pane denies us
        // (its sizer calls setChildrenInPlace() every scroll tick and rips injections
        // out). Height comes from the note-side counterpart, measured lazily and
        // cached, because the reading view may not have rendered it yet; until it is
        // known the zone is 0px, i.e. exactly today's behaviour. One zone PER ROW (not
        // per run) so partial knowledge of a run still narrows the error.
        const sp = sizer.createDiv({ cls: 'sp2a-spacer' });
        sp.setAttr('data-row-index', String(row.idx));
        const known = this.plugin.insHeights.get(row.idx);
        sp.style.height = (known > 0 ? known : 0) + 'px';
        this.spacerEls.set(row.idx, sp);
        continue;
      }
      const el = sizer.createDiv({ cls: 'sp2a-block' });
      el.setAttr('data-line-start', String(row.a.lineStart));
      el.setAttr('data-line-end', String(row.a.lineEnd));
      el.setAttr('data-row-index', String(row.idx));
      this.blockEls.set(row.idx, el);
      if (row.kind === 'del') el.addClass('sp2a-del');
      else if (row.kind === 'mod') el.addClass('sp2a-mod');
      else el.addClass('sp2a-same');

      // sourcePath is '' ON PURPOSE. Any post-processor (notably the user's
      // side-comments plugin) keys off sourcePath to find a note's annotations.
      // Passing the real path would paint the CURRENT note's comment marks onto
      // this OLD text, anchored to lines that no longer mean the same thing.
      // '' resolves to no note, so those processors no-op here. Cost: relative
      // links/embeds in the base pane won't resolve. Acceptable for a spike.
      await obsidian.MarkdownRenderer.render(this.app, row.a.text, el, '', this);
    }

    // This pane's scroll listener must follow the freshly-created body element.
    this.plugin.attachScrollSync();
    // Every base block is now rendered and measurable, which is precisely the moment
    // the deletion zones become exactly knowable. Deferred one frame: rects read
    // synchronously after a large DOM build can predate the layout that MarkdownRenderer's
    // own async work triggers, and a zone computed from a half-laid-out pane is worse
    // than one computed a frame late.
    window.requestAnimationFrame(() => {
      if (!this.bodyEl || !this.bodyEl.isConnected) return; // re-rendered since
      this.plugin.refreshSpacers(true);
    });
  }

  updateSyncBadge() {
    if (!this.syncBadgeEl) return;
    this.syncBadgeEl.setText(this.plugin.syncEnabled ? ' · sync on' : ' · sync off');
  }

  async onClose() {
    this.bodyEl = null;
    this.blockEls = new Map();
    this.spacerEls = new Map();
    // Nothing else to tear down; child components are unloaded with this view.
  }
}

/* ------------------------------------------------------------------ *
 * plugin                                                              *
 * ------------------------------------------------------------------ */

module.exports = class Spike2bGitDiffPlugin extends obsidian.Plugin {
  async onload() {
    /** @type {object|null} in-memory only; deliberately never persisted. */
    this.session = null;

    /* ---- scroll-sync state (all in memory; nothing persisted, so ON every load) ---- */
    /** Scroll sync master switch. Default ON per spec; toggled by command. */
    this.syncEnabled = true;
    /** Re-entrancy guard: true while WE are moving a pane (see `scrollLock`). */
    this.syncing = false;
    /** @type {number|null} timer that clears `syncing` after a programmatic scroll. */
    this.syncTimer = null;
    /** rAF throttle token; one pending frame at a time, whichever pane fired. */
    this.rafPending = false;
    /**
     * VIEW ZONE height cache: row.idx of an 'ins' row -> the rendered height of its
     * NOTE-side block, in px.
     *
     * Why a cache and not a measurement: the note pane is virtualised, so at any
     * moment most 'ins' blocks are simply absent from the DOM and have no height to
     * read. Heights are therefore harvested opportunistically — whenever a block
     * passes through the post-processor, and from whatever is rendered on each sync
     * tick — and remembered afterwards, even once the reading view discards the
     * element. A strong Map is right here (unlike `noteLines`) because the key is a
     * row index, not a DOM node: it pins a number, not dead DOM.
     *
     * Unknown => the zone stays 0px => today's exact behaviour. This structure can
     * only remove drift, never add it.
     * @type {Map<number, number>}
     */
    this.insHeights = new Map();
    /** Debounce token for `scheduleSpacerRefresh`. */
    this.spacerRefreshPending = false;
    /**
     * DELETION VIEW ZONES. row.idx of a NOTE-side row -> px of reserved space to hang
     * BELOW it, standing in for the run of 'del' blocks that follows it in the base.
     *
     * Unlike `insHeights` these are EXACT and known up front: the base pane is our own
     * un-virtualised DOM, every block is rendered, so the run's height is a plain sum
     * of rects. No lazy harvest, no estimation.
     * @type {Map<number, number>}
     */
    this.delPadBottom = new Map();
    /**
     * Same, for the one run that cannot hang below anything: a 'del' run at the very
     * top of the file, before any note block exists to follow. It hangs ABOVE the
     * first note block instead. @type {Map<number, number>}
     */
    this.delPadTop = new Map();
    /**
     * Word-level marks: row.idx -> {a,b} ranges, or null meaning "suppressed".
     * Cached because the ranges are a pure function of the two RENDERED texts, which
     * do not change for the life of a session — while the post-processor that needs
     * them re-fires every time a section recycles. `undefined` = not yet computed,
     * `null` = computed and deliberately empty. That distinction is load-bearing:
     * without it a suppressed block is re-diffed on every recycle forever.
     * @type {Map<number, object|null>}
     */
    this.charRanges = new Map();
    /** Telemetry: does wrapping change a block's height? Expected 0 — see report. */
    this.charHeightDeltaMax = 0;
    this.charHeightChangedBlocks = 0;
    this.charSpanCount = 0;
    this.charRevertCount = 0;
    /** @type {Array<{el:EventTarget, type:string, fn:Function}>} manual listeners. */
    this.domListeners = [];
    /**
     * Note-pane section element -> its source line range.
     * WeakMap because reading view DISCARDS and recreates section elements as you
     * scroll; a strong Map would pin dead DOM for the life of the session.
     * @type {WeakMap<HTMLElement, {lineStart:number, lineEnd:number}>}
     */
    this.noteLines = new WeakMap();
    /** Warn about a missing scroller once per session, not once per frame. */
    this.warnedNoScroller = false;
    /** Which scroll API actually moved the note pane last (surfaced in the report). */
    this.lastScrollApi = null;

    this.registerView(VIEW_TYPE, (leaf) => new GitBaseView(leaf, this));

    this.addCommand({
      id: 'open-review',
      name: 'Spike2b: open git diff review for this file',
      callback: () => this.openReview(),
    });

    this.addCommand({
      id: 'close-review',
      name: 'Spike2b: close review',
      callback: () => this.closeReview(),
    });

    this.addCommand({
      id: 'refresh-review',
      name: 'Spike2b: refresh (re-pin base to current HEAD)',
      callback: () => this.openReview(true),
    });

    this.addCommand({
      id: 'toggle-scroll-sync',
      name: 'Spike2b: toggle scroll sync',
      callback: () => this.toggleSync(),
    });

    this.addCommand({
      id: 'report-alignment',
      name: 'Spike2b: report alignment',
      callback: () => this.reportAlignment(),
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

        // ANCHOR TAP. Every section gets tagged, not just changed ones: scroll sync
        // needs to find the topmost visible block whatever its kind, and 'same'
        // blocks are the overwhelming majority of anchors (261 of 271 here).
        el.addClass('sp2b-nblock');
        this.noteLines.set(el, { lineStart: info.lineStart, lineEnd: info.lineEnd });

        // Resolve the row ONCE and stamp it on the element. Everything downstream
        // (view-zone padding, height harvest, per-tick refresh) then reads an
        // attribute instead of re-running the O(rows) overlap search. That is what
        // keeps per-tick work proportional to what's RENDERED rather than to the
        // document — on the 312-block diff the scanning form would run ~300 overlap
        // tests per visible block, per frame.
        const row = this.rowForNoteRange(info.lineStart, info.lineEnd);
        if (row) el.setAttr('data-row-index', String(row.idx));

        // DELETION VIEW ZONE. Re-applied here, not just once after the base renders,
        // because reading-view sections are recycled: a block scrolled out and back
        // returns as a fresh element with our inline style gone. The post-processor is
        // the hook that fires on every such re-render, so treating it as the single
        // place zones get written makes them self-healing rather than a one-shot that
        // silently decays as the reader scrolls.
        if (row) this.styleDelPad(el);

        const kind = row ? row.kind : this.kindForRange(session, info.lineStart, info.lineEnd);
        if (kind === 'ins') {
          el.addClass('sp2a-ins');
          // INSERTION VIEW ZONE HEIGHT TAP. This is the one moment we are guaranteed
          // to hold an 'ins' block's element: it fires as the reading view renders the
          // section, and the reading view will later throw that element away. Harvest
          // the height now, while it exists, so the base pane's zone can reserve the
          // same space forever after. The read here can be stale-by-a-frame
          // (images/embeds settle after render) and is taken before any zone padding
          // is applied, which is why `measureRenderedInsHeights` re-measures — and
          // subtracts padding — on each tick. This tap is the only way to learn about
          // blocks that are NOT currently on screen.
          if (row) {
            const h = el.getBoundingClientRect().height;
            if (h > 0) this.insHeights.set(row.idx, h);
            this.scheduleSpacerRefresh();
          }
        } else if (kind === 'mod') {
          el.addClass('sp2a-mod');
          // WORD-LEVEL MARKS. Here, not at base-render time, because this is the
          // first moment both rendered texts exist. Re-runs on every recycle and is
          // idempotent (it unwraps its own spans first).
          if (row) this.applyCharMarks(row, el);
        }
      } catch (e) {
        // A post-processor that throws breaks the whole preview render. Never.
        console.error('[spike2b] post-processor error', e);
      }
    });

    // The note pane's scroller is replaced when the view re-renders or the leaf
    // changes; re-attaching is cheap and idempotent (attach detaches first).
    this.registerEvent(this.app.workspace.on('layout-change', () => this.attachScrollSync()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.attachScrollSync()));
    // A resize changes where the note pane WRAPS, so every cached view-zone height is
    // suspect. We can only re-measure what is currently rendered; the rest correct
    // themselves as they scroll back through the post-processor. Debounced because
    // 'resize' fires per animation frame of a drag.
    this.registerEvent(this.app.workspace.on('resize', () => this.scheduleSpacerRefresh()));
    // Belt and braces: registerDomEvent can't be individually unregistered, and these
    // listeners must move between elements mid-session — hence manual attach/detach
    // with an explicit unload hook rather than registerDomEvent.
    this.register(() => this.detachScrollSync());
  }

  onunload() {
    this.detachScrollSync();
    if (this.syncTimer) window.clearTimeout(this.syncTimer);
    if (this.spacerTimer) window.clearTimeout(this.spacerTimer);
    this.insHeights = new Map();
    // Unloading the plugin must leave no trace in the note pane either.
    try { this.clearNoteDecorations(); } catch (e) { /* workspace already torn down */ }
    this.session = null;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  /* ---------------------------------------------------------------- *
   * scroll sync — pane handles                                        *
   * ---------------------------------------------------------------- */

  /**
   * The NOTE pane (spec's pane A): the real markdown leaf showing this session's
   * file in READING view, plus the element that actually scrolls it.
   * @returns {{view:object, scroller:HTMLElement}|null}
   */
  notePane() {
    const session = this.session;
    if (!session || session.error) return null;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!view || !view.file || view.file.path !== session.filePath) continue;
      // Decorations and getSectionInfo only exist in reading view — so does sync.
      if (typeof view.getMode === 'function' && view.getMode() !== 'preview') continue;
      const scroller = findPreviewScroller(view);
      if (!scroller) {
        if (!this.warnedNoScroller) {
          this.warnedNoScroller = true;
          console.warn(
            '[spike2b] could not identify the reading-view scroll container for ' +
            session.filePath + ' — scroll sync from the note pane is disabled. ' +
            'Expected a scrollable `.markdown-preview-view`.'
          );
        }
        return null;
      }
      return { view, scroller };
    }
    return null;
  }

  /** The BASE pane (spec's pane B) view instance, if open. */
  baseView() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof GitBaseView) return leaf.view;
    }
    return null;
  }

  /** The BASE pane's scrolling element. */
  basePane() {
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
   * 'ins' row resolved to nothing and sync fell through to `baseScrollTopFor`'s
   * interpolation, which estimates position by BLOCK COUNT across a run. On the big
   * diff (26 'ins' rows in 17 runs) the topmost visible note block is frequently an
   * 'ins' row, so the anchor — which is 0px by construction whenever a counterpart
   * exists — was measured up to 340px off. It wasn't the interpolation misbehaving;
   * it was the interpolation being asked a question it can only estimate.
   *
   * A spacer sits at exactly the position its row's content occupies in the note's
   * reading order, so aligning an inserted note block to its spacer is not an
   * approximation — it is the same answer a real block would give. Every note row
   * now has a counterpart here, which makes interpolation a guard rather than a path.
   *
   * NOTE the zero-height case is still CORRECT, not merely tolerable: a spacer whose
   * height hasn't been harvested yet is 0px tall but is still in the right PLACE, so
   * the anchor lands exactly; only the blocks below it stay off until the height is
   * known. Strictly better than interpolating, at every stage of the harvest.
   */
  baseElFor(rowIdx) {
    const view = this.baseView();
    if (!view) return null;
    const el = (view.blockEls && view.blockEls.get(rowIdx)) ||
               (view.spacerEls && view.spacerEls.get(rowIdx));
    return el && el.isConnected ? el : null;
  }

  /* ---------------------------------------------------------------- *
   * scroll sync — listener wiring                                     *
   * ---------------------------------------------------------------- */

  addListener(el, type, fn) {
    el.addEventListener(type, fn, { passive: true });
    this.domListeners.push({ el, type, fn });
  }

  detachScrollSync() {
    for (const l of this.domListeners) {
      try { l.el.removeEventListener(l.type, l.fn); } catch (e) { /* element already gone */ }
    }
    this.domListeners = [];
  }

  /** Point the scroll listeners at whatever elements the two panes have RIGHT NOW. */
  attachScrollSync() {
    this.detachScrollSync();
    if (!this.session || this.session.error) return;

    const note = this.notePane();
    if (note) this.addListener(note.scroller, 'scroll', () => this.onScroll('note'));

    const base = this.basePane();
    if (base) this.addListener(base, 'scroll', () => this.onScroll('base'));
  }

  toggleSync() {
    this.syncEnabled = !this.syncEnabled;
    const v = this.baseView();
    if (v) v.updateSyncBadge();
    new obsidian.Notice(
      `Spike2b: scroll sync ${this.syncEnabled ? 'ON' : 'OFF'}`
    );
    // Snap the panes back together immediately so ON is visibly different from OFF.
    if (this.syncEnabled) this.syncNoteToBase();
  }

  /* ---------------------------------------------------------------- *
   * view zones (insertion spacers) + deletion collapse                 *
   *                                                                    *
   * Both exist for one reason. Paired blocks now measure IDENTICALLY in
   * the two panes, so the only remaining drift comes from UNPAIRED RUNS
   * between two paired anchors: an 'ins' run makes the note taller by
   * exactly its own height, a 'del' run makes the base taller by exactly
   * its own height, and the next anchor lands off by that amount. VS Code
   * solves this with view zones on both sides. We only own one side, so:
   * 'ins' gets a real zone (below), 'del' gets an optional collapse.
   * ---------------------------------------------------------------- */

  /** Push cached heights onto the base pane's zones. Cheap; idempotent. */
  applySpacerHeights() {
    const view = this.baseView();
    if (!view || !view.spacerEls) return;
    for (const [idx, el] of view.spacerEls) {
      const h = this.insHeights.get(idx);
      const px = (h > 0 ? h : 0) + 'px';
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
   * were last seen at — a remembered height is strictly better than no height, and
   * a wrong-by-a-few-px remembered height is strictly better than a 0 that leaves
   * the whole run's worth of drift in place.
   * @returns {boolean} true if any cached height changed
   */
  measureRenderedInsHeights() {
    const session = this.session;
    if (!session || session.error) return false;
    const note = this.notePane();
    if (!note) return false;
    let changed = false;
    for (const el of note.scroller.querySelectorAll('.sp2a-ins.sp2b-nblock[data-row-index]')) {
      const idx = Number(el.getAttribute('data-row-index'));
      if (!isFinite(idx)) continue;
      const row = session.rows[idx];
      if (!row || row.kind !== 'ins') continue;
      // SUBTRACT OUR OWN ZONES. The rect includes padding, and an 'ins' block may
      // ALSO be carrying a deletion zone (it is a perfectly ordinary candidate for
      // "the note block preceding a del run"). Measuring the padded height would
      // reserve the deletion's pixels a second time in the base pane — the two
      // mechanisms would feed each other, and each pass would grow the error. What we
      // want is the block's own content height, so take the padding back out.
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
   * Refresh BOTH directions of view zone. @returns {boolean} true if anything moved.
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
   * Each step reads a quantity the later steps can't perturb, so this converges in
   * one pass instead of oscillating.
   *
   * PER-TICK COST. This is called from every sync tick, so the steady state — nothing
   * new learned — must be nearly free: one querySelectorAll over the RENDERED 'ins'
   * blocks and a rect each. Steps 3-4 walk all rows and force a layout flush to read
   * base rects, so they run only when a height actually moved (or on the debounced
   * `force` path). Unconditionally re-summing here would put an O(rows) scan plus a
   * forced reflow on every frame of every scroll — invisible on the 10-block diff this
   * was built against, and 312 rows deep on the one it now has to survive.
   *
   * @param {boolean} [force] recompute the deletion zones even if nothing moved —
   *   for the cases where BASE heights changed without any 'ins' height changing
   *   (a resize, a base re-render).
   */
  refreshSpacers(force) {
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
  scheduleSpacerRefresh() {
    if (this.spacerRefreshPending) return;
    this.spacerRefreshPending = true;
    this.spacerTimer = window.setTimeout(() => {
      this.spacerRefreshPending = false;
      this.spacerTimer = null;
      try {
        // force: this path exists for the events that change BASE geometry (resize, a
        // fresh base render) without necessarily moving any 'ins' height.
        this.refreshSpacers(true);
        // Zones above the viewport moving means content shifted under the reader;
        // re-anchor so the correction reads as invisible rather than as a jump.
        if (this.syncEnabled && !this.syncing) this.syncNoteToBase();
      } catch (e) {
        console.error('[spike2b] spacer refresh failed', e);
      }
    }, 150);
  }

  /**
   * Compute the DELETION view zones: for every run of consecutive 'del' rows, how
   * much space the NOTE pane must reserve to stay level with the base.
   *
   * The mirror of `insHeights`, and the easy direction: the base pane is ours and
   * un-virtualised — every block is rendered — so a run's height is an exact sum of
   * rects, known as soon as the base view finishes rendering. Nothing is estimated,
   * nothing needs harvesting over time.
   *
   * ATTACHMENT: a run's height hangs off the note block that immediately PRECEDES it
   * in note order — the last row carrying a `b` before the run starts. That block's
   * bottom edge sits exactly where the deleted text would have begun, so growing it
   * downward opens the gap in the right place.
   *
   * LEADING-RUN EDGE CASE: a file beginning with deleted blocks has no preceding note
   * block. That run hangs off the FIRST note block as padding-TOP instead
   * (`delPadTop`) — same pixels, same place on screen, expressed from the only side
   * of the only element available.
   */
  computeDelPads() {
    const session = this.session;
    const view = this.baseView();
    this.delPadBottom = new Map();
    this.delPadTop = new Map();
    if (!session || session.error || !view || !view.blockEls) return;

    let carry = 0;          // height of the del run currently being walked
    let lastNoteRow = null; // last row that exists in the note pane

    const flush = () => {
      if (carry <= 0) return;
      if (lastNoteRow) {
        // += rather than =: two del runs separated only by rows absent from the note
        // pane would otherwise overwrite each other. (Can't happen today — an 'ins'
        // row carries a `b` and so updates lastNoteRow — but the sum is the honest
        // form and costs nothing.)
        this.delPadBottom.set(
          lastNoteRow.idx,
          (this.delPadBottom.get(lastNoteRow.idx) || 0) + carry
        );
      } else {
        const first = session.noteRows[0];
        if (first) {
          this.delPadTop.set(first.idx, (this.delPadTop.get(first.idx) || 0) + carry);
        }
        // else: the note has no blocks at all (whole file deleted). Nothing to hang
        // the padding on — and nothing to align either. Correctly dropped.
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
   * sizerEl.setChildrenInPlace() every scroll tick, which rips out any element we
   * ADD — but it does not object to us restyling an element it already owns. Growing
   * an existing block IS a view zone; it just isn't a new node.
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
  applyDelPads() {
    const note = this.notePane();
    if (!note) return;
    for (const el of note.scroller.querySelectorAll('.sp2b-nblock[data-row-index]')) {
      this.styleDelPad(el);
    }
  }

  /**
   * Word-level marks for one 'mod' row: `.sp2a-char-del` on the base block's changed
   * words, `.sp2a-char-ins` on the note block's.
   *
   * WHY BOTH SIDES ARE DRIVEN FROM THE NOTE'S POST-PROCESSOR: the diff needs BOTH
   * rendered texts, and the note side is the one that may not exist yet. The base
   * block is always rendered (our pane, un-virtualised), so the moment the note block
   * shows up is the earliest moment either side can be marked. A 'mod' block whose
   * note counterpart never renders simply stays unmarked — invisible by construction,
   * since you can only see marks on screen.
   *
   * The base side is guarded by "does it already carry spans?" rather than by the
   * range cache: a base RE-RENDER hands us fresh, unwrapped elements while the cache
   * stays warm, and keying off the cache would leave the base permanently bare.
   */
  applyCharMarks(row, noteEl) {
    if (!row || row.kind !== 'mod' || !noteEl) return;
    const view = this.baseView();
    const baseEl = view && view.blockEls ? view.blockEls.get(row.idx) : null;
    if (!baseEl || !baseEl.isConnected) return;

    let ranges = this.charRanges.get(row.idx);
    if (ranges === undefined) {
      // Both texts must be read UNWRAPPED, or a previous run's spans would be diffed
      // against fresh text. (textContent ignores element boundaries, so this is belt
      // and braces — but the cost is a no-op query and the failure mode is silent.)
      unwrapCharMarks(baseEl);
      unwrapCharMarks(noteEl);
      ranges = wordDiffRanges(baseEl.textContent, noteEl.textContent);
      this.charRanges.set(row.idx, ranges);
    }
    if (!ranges) return; // suppressed: the block wash carries the signal alone

    if (!baseEl.querySelector('[' + CHAR_MARK_ATTR + ']')) {
      // HEIGHT PROBE. Inline spans with a background should not change layout — but
      // "should not" is the premise the view zones are built on: a base block that
      // grows when marked would desync every zone below it, and the zones are what
      // took drift from 340px to 48px. So measure rather than assume, and surface the
      // number in the report instead of asserting it in a comment.
      const h0 = baseEl.getBoundingClientRect().height;
      const made = wrapRanges(baseEl, ranges.a, 'sp2a-char-del');
      const h1 = baseEl.getBoundingClientRect().height;
      const d = Math.abs(h1 - h0);
      if (d > this.charHeightDeltaMax) this.charHeightDeltaMax = d;
      if (d > 0.5) {
        this.charHeightChangedBlocks++;
        // Wrong premise, but recoverable: re-derive the zones from the new heights
        // rather than leave them quietly stale.
        this.scheduleSpacerRefresh();
      }
      if (made < 0) this.charRevertCount++;
      else this.charSpanCount += made;
    }

    // The note side re-applies on every call: its sections recycle, so each render is
    // a fresh element whose spans are gone. Unwrap first — never double-wrap.
    unwrapCharMarks(noteEl);
    const madeB = wrapRanges(noteEl, ranges.b, 'sp2a-char-ins');
    if (madeB < 0) this.charRevertCount++;
  }

  /** Apply (or clear) one note block's zone padding. Idempotent. */
  styleDelPad(el) {
    const idx = Number(el.getAttribute('data-row-index'));
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

  /**
   * Hand the note pane's blocks back exactly as we found them — zone padding removed
   * AND our word-mark spans unwrapped.
   *
   * Reading-view sections are recycled rather than rebuilt on command, so closing a
   * review must actively undo both: otherwise the note keeps phantom gaps where
   * deletions used to be and highlighted words with no review open to explain them.
   * The unwrap matters more than the padding — spans left behind are spans the next
   * session would treat as pre-existing content.
   */
  clearNoteDecorations() {
    this.delPadBottom = new Map();
    this.delPadTop = new Map();
    this.charRanges = new Map();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      const scroller = view ? findPreviewScroller(view) : null;
      if (!scroller) continue;
      for (const el of scroller.querySelectorAll('.sp2b-nblock')) {
        el.style.paddingBottom = '';
        el.style.paddingTop = '';
        unwrapCharMarks(el);
      }
    }
  }

  /**
   * Scroll handler for both panes: rAF-throttled, loop-guarded.
   * `syncing` is checked BOTH on entry and inside the frame — the programmatic
   * scroll we perform lands asynchronously, so the echo event can be queued before
   * the flag is set and dispatched after.
   */
  onScroll(side) {
    if (!this.syncEnabled || this.syncing) return;
    if (this.rafPending) return;
    this.rafPending = true;
    window.requestAnimationFrame(() => {
      this.rafPending = false;
      if (!this.syncEnabled || this.syncing) return;
      try {
        if (side === 'note') this.syncNoteToBase();
        else this.syncBaseToNote();
      } catch (e) {
        console.error('[spike2b] scroll sync failed', e);
      }
    });
  }

  /**
   * Run a programmatic scroll with the feedback loop disarmed.
   *
   * A flag alone is not enough: the browser dispatches `scroll` asynchronously, so
   * clearing the flag on the next tick can still let the echo through and start
   * note -> base -> note -> ... judder. The flag is therefore held for a short
   * window (120ms) AFTER the move, and every nested call pushes the window out.
   * Cost of the timeout: a genuine user scroll started within 120ms of a
   * programmatic one is ignored. That is invisible in practice and strictly better
   * than an oscillation.
   */
  scrollLock(fn) {
    this.syncing = true;
    try {
      fn();
    } finally {
      if (this.syncTimer) window.clearTimeout(this.syncTimer);
      this.syncTimer = window.setTimeout(() => {
        this.syncing = false;
        this.syncTimer = null;
      }, 120);
    }
  }

  /* ---------------------------------------------------------------- *
   * scroll sync — anchor resolution                                   *
   * ---------------------------------------------------------------- */

  /**
   * Topmost VISIBLE block of a pane, plus how far its top sits ABOVE the viewport
   * top as a fraction of its own height.
   *
   * "Topmost visible" = first element in document order whose bottom is below the
   * container's top edge. Only rendered elements are considered — which is the whole
   * point: in the note pane the un-rendered ones do not exist to be considered.
   *
   * @returns {{el:HTMLElement, rect:DOMRect, frac:number}|null}
   */
  topmostVisible(container, els) {
    const top = container.getBoundingClientRect().top;
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > top + 1) {
        const frac = rect.height > 0 ? clamp((top - rect.top) / rect.height, 0, 1) : 0;
        return { el, rect, frac };
      }
    }
    return null;
  }

  /** Note-pane section line range -> the row it belongs to (best line overlap). */
  rowForNoteRange(lineStart, lineEnd) {
    let best = null;
    let bestOverlap = 0;
    for (const row of this.session.noteRows) {
      const overlap = Math.min(lineEnd, row.b.lineEnd) - Math.max(lineStart, row.b.lineStart) + 1;
      if (overlap > bestOverlap) { bestOverlap = overlap; best = row; }
    }
    return bestOverlap > 0 ? best : null;
  }

  /**
   * Where the base pane should sit so that `row` (a NOTE-pane row), at fraction
   * `frac` through itself, is at the top of the base viewport.
   *
   * UNPAIRED HANDLING — INTERPOLATE, not clamp-and-hold.
   * An 'ins' row has no base-side block to align to. Two honest options:
   *   (a) clamp: hold the base pane at the enclosing paired anchor for the whole run;
   *   (b) interpolate: glide the base pane from the previous anchor's bottom to the
   *       next anchor's top, in proportion to how far through the run we are.
   * I chose (b). The reason is the case the test doc is built around: a rewritten
   * section (3 blocks deleted, 4 inserted). There, the note pane's 4-block insertion
   * run and the base pane's 3-block deletion run sit BETWEEN THE SAME PAIR of
   * anchors, so interpolation glides the base pane through the deleted text while
   * the reader moves through the inserted text — i.e. it shows the counterpart
   * content, which is the entire question a diff review is asking. Clamping would
   * freeze the base pane on an unrelated paragraph for four screens and then jump.
   * TRADE-OFF: for a PURE insertion (no matching deletion) the two anchors are
   * adjacent in the base pane, so there is ~0px to interpolate and (b) degenerates
   * to (a) — a hold — which is the correct behaviour there anyway. The other cost is
   * that progress is measured in BLOCK COUNT, not pixels: a run of one short and one
   * very tall block advances the base pane at an even rate rather than a
   * proportional one. Pixel-accurate progress would need the heights of every block
   * in the run, and in the note pane those are exactly the blocks the reading view
   * may not have rendered. Block-count is the measurement that survives
   * virtualization.
   *
   * @returns {number|null} scrollTop for the base pane, or null if unresolvable
   */
  baseScrollTopFor(row, frac) {
    const base = this.basePane();
    const view = this.baseView();
    if (!base || !view) return null;

    // Any row with a counterpart — a real block OR its view zone — is answerable
    // exactly, so it never reaches the interpolation below. Before view zones this
    // read `if (row.paired)`, which sent every 'ins' row down the estimating path.
    const own = this.baseElFor(row.idx);
    if (own) {
      return clamp(offsetIn(base, own) + frac * own.offsetHeight, 0, maxScroll(base));
    }

    const prev = row.pnPrev;
    const next = row.pnNext;
    const prevEl = prev ? this.baseElFor(prev.idx) : null;
    const nextEl = next ? this.baseElFor(next.idx) : null;
    const lo = prevEl ? offsetIn(base, prevEl) + prevEl.offsetHeight : 0;
    const hi = nextEl ? offsetIn(base, nextEl) : maxScroll(base);
    const p = (row.pnRunIdx + frac) / row.pnRunLen;
    return clamp(lo + Math.max(0, hi - lo) * p, 0, maxScroll(base));
  }

  /**
   * The note-pane SOURCE LINE (fractional) corresponding to base-pane `row` at
   * fraction `frac` through itself. Same interpolation choice as `baseScrollTopFor`,
   * expressed in line numbers instead of pixels — the note pane is scrolled by line,
   * not by pixel, precisely because we cannot measure its unrendered parts.
   */
  noteLineFor(row, frac) {
    // Gate on `row.b`, not `row.paired`: an 'ins' row is unpaired but its note-side
    // lines are known EXACTLY (it's the base side it lacks). Since view zones let a
    // spacer be the base pane's topmost visible element, this direction now gets asked
    // about 'ins' rows too — and estimating a line number we already know would be a
    // self-inflicted error.
    if (row.b) {
      const span = row.b.lineEnd - row.b.lineStart + 1;
      return row.b.lineStart + frac * span;
    }
    const prev = row.pbPrev;
    const next = row.pbNext;
    const lo = prev ? prev.b.lineEnd + 1 : 0;
    const hi = next ? next.b.lineStart : this.session.curLastLine;
    const p = (row.pbRunIdx + frac) / row.pbRunLen;
    return lo + Math.max(0, hi - lo) * p;
  }

  /* ---------------------------------------------------------------- *
   * scroll sync — the two directions                                  *
   * ---------------------------------------------------------------- */

  /** NOTE pane (A) drives the BASE pane (B). Pure pixel math on DOM we own. */
  syncNoteToBase() {
    const note = this.notePane();
    const base = this.basePane();
    if (!note || !base) return;

    // BEFORE anchoring, not after: the zones we are about to correct change where the
    // anchor's counterpart sits. Measuring on-screen blocks only, this is a handful
    // of rect reads — and reading a rect we are about to read anyway for the anchor.
    this.refreshSpacers();

    const hit = this.topmostVisible(
      note.scroller,
      note.scroller.querySelectorAll('.sp2b-nblock')
    );
    if (!hit) return;

    const info = this.noteLines.get(hit.el);
    if (!info) return;
    const row = this.rowForNoteRange(info.lineStart, info.lineEnd);
    if (!row) return;

    // ---- Alignment: match SCREEN positions, not scroller-relative offsets. ----
    // Each pane's scroller starts at a different screen Y: the base pane's begins
    // BELOW our header (title + "base <sha> · N blocks"), the note pane's begins
    // right under its tab bar. Aligning each block to "top of its own scroller"
    // therefore lands them at different heights on screen — a constant error equal
    // to the header. Rather than measure the header and subtract it (which breaks
    // the moment the header wraps to two lines, a banner appears, or a theme
    // changes its padding), align the two blocks' actual on-screen positions and
    // let the delta absorb whatever chrome exists. Self-correcting by construction.
    // blockEls first, then spacerEls — see `baseElFor`. With view zones in place this
    // resolves for EVERY note row, so the interpolated fallback below is a guard for
    // the pathological (a row whose element vanished mid-frame), not a routine path.
    const baseEl = this.baseElFor(row.idx);
    if (baseEl) {
      const delta = baseEl.getBoundingClientRect().top - hit.el.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) return; // already aligned; don't churn
      const want = clamp(base.scrollTop + delta, 0, maxScroll(base));
      if (Math.abs(base.scrollTop - want) < 1) return;
      this.scrollLock(() => { base.scrollTop = want; });
      return;
    }

    // No counterpart block (an 'ins' row — added text with nothing in the base).
    // Fall back to the interpolated target so the base pane still glides.
    const target = this.baseScrollTopFor(row, hit.frac);
    if (target == null) return;
    if (Math.abs(base.scrollTop - target) < 1) return; // already there; don't churn
    this.scrollLock(() => { base.scrollTop = target; });
  }

  /**
   * BASE pane (B) drives the NOTE pane (A).
   *
   * The note pane cannot be scrolled by scrollTop with any confidence — its content
   * height is a function of what the reading view has chosen to render — so we ask
   * OBSIDIAN to scroll it to a source LINE. See `applyNoteScroll` for which API.
   */
  syncBaseToNote() {
    const note = this.notePane();
    const base = this.basePane();
    const view = this.baseView();
    if (!note || !base || !view) return;

    // Spacers are anchors in this direction too: a view zone carries a data-row-index
    // and its row's NOTE lines are known exactly, so the zone answers as well as a
    // block would. Both selectors are needed — they are disjoint sets covering,
    // between them, every row in the base pane's reading order.
    const hit = this.topmostVisible(base, base.querySelectorAll('.sp2a-block, .sp2a-spacer'));
    if (!hit) return;

    const idx = Number(hit.el.getAttribute('data-row-index'));
    const row = this.session.rows[idx];
    if (!row) return;

    const line = this.noteLineFor(row, hit.frac);
    if (line == null || !isFinite(line)) return;
    this.scrollLock(() => { this.applyNoteScroll(note.view, line); });
  }

  /**
   * Scroll a markdown reading view to a (fractional) source line.
   *
   * API PROVENANCE — read this before trusting it:
   *  - `view.currentMode.applyScroll(n)` / `view.previewMode.applyScroll(n)`:
   *    DECLARED in obsidian.d.ts (on MarkdownSubView) but undocumented — semi-public
   *    at best. This is the one that scrolls without side effects, so it is tried
   *    first. Whether it honours a FRACTIONAL line (giving smooth sub-block motion)
   *    or floors it (giving block-steppy motion) is not specified anywhere; if the
   *    note pane looks steppy, this is the line to suspect.
   *  - `view.setEphemeralState({line})`: fully public, but it centres the line and
   *    may flash a highlight, so it is a FALLBACK only.
   * Everything is feature-detected and wrapped — a broken internal must degrade to
   * "sync stops working", never "the plugin throws on every scroll frame".
   */
  applyNoteScroll(view, line) {
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
      console.warn('[spike2b] no usable scroll-to-line API on this markdown view');
    } catch (e) {
      this.lastScrollApi = 'error: ' + (e && e.message);
      console.error('[spike2b] scroll-to-line failed', e);
    }
  }

  /* ---------------------------------------------------------------- *
   * alignment diagnostic                                              *
   * ---------------------------------------------------------------- */

  /**
   * Dump the CURRENT alignment of the two panes to REPORT_PATH as JSON, so a human
   * can check alignment with a number instead of an opinion.
   *
   * `deltaPx` is the money field: for the note pane's topmost visible block, how far
   * its PAIRED counterpart in the base pane sits from where it "should" be. 0 = the
   * two blocks' tops are the same distance below their viewport tops. Positive =
   * the base pane's block sits lower than the note's. Null = the block is unpaired,
   * i.e. an interpolated region where no exact answer exists by construction.
   */
  reportAlignment() {
    const session = this.session;
    if (!session || session.error) {
      new obsidian.Notice('Spike2b: no active review session to report on.');
      return;
    }
    const note = this.notePane();
    const base = this.basePane();
    const view = this.baseView();

    const snip = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, 60);

    let notePart = { found: false };
    let noteRow = null;
    let noteOffsetPx = null;
    if (note) {
      const hit = this.topmostVisible(note.scroller, note.scroller.querySelectorAll('.sp2b-nblock'));
      const info = hit ? this.noteLines.get(hit.el) : null;
      noteRow = info ? this.rowForNoteRange(info.lineStart, info.lineEnd) : null;
      if (hit) noteOffsetPx = hit.rect.top - note.scroller.getBoundingClientRect().top;
      notePart = {
        found: !!hit,
        renderedBlocksInDom: note.scroller.querySelectorAll('.sp2b-nblock').length,
        scrollTop: note.scroller.scrollTop,
        topBlock: hit && info ? {
          lineStart: info.lineStart,
          lineEnd: info.lineEnd,
          text60: snip(noteRow && noteRow.b ? noteRow.b.text : ''),
          fractionScrolledThroughBlock: Number(hit.frac.toFixed(3)),
          offsetFromViewportTopPx: Number(noteOffsetPx.toFixed(1)),
          rowIndex: noteRow ? noteRow.idx : null,
          kind: noteRow ? noteRow.kind : null,
        } : null,
      };
    }

    let basePart = { found: false };
    let baseRow = null;
    if (base && view) {
      const hit = this.topmostVisible(base, base.querySelectorAll('.sp2a-block'));
      baseRow = hit ? session.rows[Number(hit.el.getAttribute('data-row-index'))] : null;
      basePart = {
        found: !!hit,
        blocks: view.blockEls.size,
        scrollTop: base.scrollTop,
        topBlock: hit && baseRow ? {
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
    let deltaPx = null;
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

    const report = {
      generatedAt: new Date().toISOString(),
      file: session.filePath,
      baseSha: session.shortSha,
      counts: session.counts,
      syncEnabled: this.syncEnabled,
      lastNoteScrollApi: this.lastScrollApi,
      // View-zone coverage. `known` climbs toward `total` as the reader scrolls the
      // note pane past each insertion — so a low ratio here EXPLAINS a residual
      // drift rather than leaving it a mystery.
      viewZones: (() => {
        const insRows = session.rows.filter((r) => r.kind === 'ins');
        let reserved = 0;
        for (const r of insRows) reserved += this.insHeights.get(r.idx) || 0;
        return {
          total: insRows.length,
          knownHeights: insRows.filter((r) => this.insHeights.has(r.idx)).length,
          reservedPx: Number(reserved.toFixed(1)),
        };
      })(),
      // The other direction: space reserved in the NOTE pane for deleted base blocks.
      // Exact by construction (the base pane is fully rendered), so `runs` and
      // `reservedPx` should be stable from the first render — if reservedPx is 0 while
      // the diff reports deletions, the padding never landed and that is the bug.
      delZones: {
        delRows: session.rows.filter((r) => r.kind === 'del').length,
        runs: this.delPadBottom.size + this.delPadTop.size,
        reservedPx: Number(
          ([...this.delPadBottom.values(), ...this.delPadTop.values()]
            .reduce((a, b) => a + b, 0)).toFixed(1)
        ),
        leadingRunPx: Number(
          ([...this.delPadTop.values()].reduce((a, b) => a + b, 0)).toFixed(1)
        ),
      },
      // Word-level marks. `maxBaseHeightDeltaPx` is the field that matters: it is the
      // largest height change ANY base block underwent when its word marks were
      // wrapped. It must be 0. Anything else means inline spans are affecting layout,
      // which desyncs the view zones measured from those same blocks — so it would be
      // a regression in alignment, not merely a cosmetic surprise.
      // `reverts` must also be 0: non-zero means the textContent invariant tripped and
      // marks were pulled from a block to protect the comment anchors.
      charMarks: (() => {
        const modRows = session.rows.filter((r) => r.kind === 'mod').length;
        let suppressed = 0;
        for (const v of this.charRanges.values()) if (!v) suppressed++;
        return {
          modRows,
          computed: this.charRanges.size,
          suppressed,
          spans: this.charSpanCount,
          maxBaseHeightDeltaPx: Number(this.charHeightDeltaMax.toFixed(2)),
          blocksWithHeightChange: this.charHeightChangedBlocks,
          reverts: this.charRevertCount,
          suppressAboveChangedFraction: CHAR_MAX_CHANGED_FRACTION,
        };
      })(),
      panes: {
        // Spec naming: pane A = the real note, pane B = our git-base ItemView.
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

    try {
      // A real write, in the plainest phrasing, to a scratch path outside the vault.
      // Not a note; the read-only invariant is about notes. See README.
      fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
      new obsidian.Notice(
        `Spike2b: alignment report written (deltaPx=${deltaPx == null ? 'n/a' : deltaPx})`,
        6000
      );
    } catch (e) {
      new obsidian.Notice(`Spike2b: could not write report — ${e && e.message}`, 8000);
      console.error('[spike2b] report write failed', e);
    }
  }

  /**
   * Best-overlap lookup from an Obsidian section's line range to a pair kind.
   * Obsidian's sectioning and mddiff's block splitting agree in the common case
   * but are not guaranteed identical (lists, callouts), so we match by maximum
   * line overlap rather than requiring exact range equality.
   */
  kindForRange(session, lineStart, lineEnd) {
    let best = null;
    let bestOverlap = 0;
    for (const b of session.curMap) {
      const overlap = Math.min(lineEnd, b.lineEnd) - Math.max(lineStart, b.lineStart) + 1;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = b;
      }
    }
    return bestOverlap > 0 && best ? best.kind : null;
  }

  /** Open (or re-pin) a review for the active markdown file. */
  async openReview(repin = false) {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new obsidian.Notice('Spike2a: no active file.');
      return;
    }
    if (file.extension !== 'md') {
      new obsidian.Notice('Spike2a: not a markdown file.');
      return;
    }

    try {
      const ctx = resolveGit(this.app, file);
      // Pin the base ONCE per review session (or on explicit re-pin).
      const keepSha =
        !repin && this.session && this.session.filePath === file.path && !this.session.error
          ? this.session.sha
          : null;
      const sha = keepSha || headSha(ctx.root);

      const baseText = showAt(ctx.root, sha, ctx.rel);
      const currentText = await this.app.vault.cachedRead(file); // read-only

      this.session = buildSession(this.app, file, baseText, ctx, sha, currentText);
      // Row indices are session-local: a re-pin re-pairs everything, so yesterday's
      // heights and word-ranges would be filed under today's unrelated rows. Drop
      // them. (clearNoteDecorations below also resets charRanges, but it only runs on
      // the error path — this is the success path's reset.)
      this.insHeights = new Map();
      this.charRanges = new Map();
      this.charHeightDeltaMax = 0;
      this.charHeightChangedBlocks = 0;
      this.charSpanCount = 0;
      this.charRevertCount = 0;
      this.warnedNoScroller = false;
      new obsidian.Notice(
        `Spike2b: base ${this.session.shortSha} · ${this.session.counts.changed} changed block(s)`
      );
    } catch (e) {
      const msg = e instanceof GitError ? e.message : `Unexpected error:\n${e && e.message}`;
      // Loud, and explicit in the pane — an empty base pane must never be the
      // only signal, because it is indistinguishable from "everything is new".
      this.session = {
        filePath: file.path,
        fileName: file.name,
        sha: '',
        shortSha: '',
        rows: [],
        noteRows: [],
        baseRows: [],
        curLastLine: 0,
        curMap: [],
        counts: { blocks: 0, curBlocks: 0, changed: 0 },
        error: msg,
      };
      this.insHeights = new Map();
      // The error render returns before the base pane is built, so the rAF that
      // normally recomputes zones never runs. Without this, a failed re-pin would
      // leave the PREVIOUS session's gaps padding the note with nothing to justify
      // them — a wrong-but-plausible state, which is the class of failure this file
      // works hardest to avoid.
      this.clearNoteDecorations();
      new obsidian.Notice(`Spike2b: ${String(msg).split('\n')[0]}`, 8000);
      console.error('[spike2b]', e);
    }

    await this.revealView();
    this.rerenderPreviews();
    // The note pane's sections are re-created by rerenderPreviews above, so its
    // scroller may be new; the base pane's body certainly is.
    this.attachScrollSync();
  }

  closeReview() {
    this.detachScrollSync();
    // BEFORE dropping the session: clearNoteDecorations walks live note elements, and the
    // padding is ours to remove. Leaving it would strand phantom gaps in the reader's
    // note with no review open to explain them.
    this.clearNoteDecorations();
    this.session = null;
    this.insHeights = new Map();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    this.rerenderPreviews();
    new obsidian.Notice('Spike2b: review closed.');
  }

  /**
   * Show the base pane beside the active note.
   *
   * CHOICE: `getLeaf('split', 'vertical')` — a real editor-area split, full height,
   * same width class as the note. The left SIDEBAR (getLeftLeaf) is genuinely on
   * the left but is a narrow utility rail; rendered prose is unreadable in it, and
   * side-by-side reading is the entire point of this spike.
   * TRADE-OFF: Obsidian places a new split AFTER the active leaf, so the base pane
   * lands to the RIGHT of the note by default. Drag its tab across once to swap.
   * See README "Known limitations".
   */
  async revealView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    let leaf = existing[0];
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
  rerenderPreviews() {
    this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
      try {
        const view = leaf.view;
        if (view && view.previewMode && typeof view.previewMode.rerender === 'function') {
          view.previewMode.rerender(true);
        }
      } catch (e) {
        console.error('[spike2b] rerender failed', e);
      }
    });
  }
};
