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
const { blocks, pair } = (function () {
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



  return { blocks: blocks, pair: pair, norm: norm, similarity: similarity };
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
      if (!row.a) continue; // 'ins' rows have no base-side block
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
  }

  updateSyncBadge() {
    if (!this.syncBadgeEl) return;
    this.syncBadgeEl.setText(this.plugin.syncEnabled ? ' · sync on' : ' · sync off');
  }

  async onClose() {
    this.bodyEl = null;
    this.blockEls = new Map();
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

        const kind = this.kindForRange(session, info.lineStart, info.lineEnd);
        if (kind === 'ins') el.addClass('sp2a-ins');
        else if (kind === 'mod') el.addClass('sp2a-mod');
      } catch (e) {
        // A post-processor that throws breaks the whole preview render. Never.
        console.error('[spike2b] post-processor error', e);
      }
    });

    // The note pane's scroller is replaced when the view re-renders or the leaf
    // changes; re-attaching is cheap and idempotent (attach detaches first).
    this.registerEvent(this.app.workspace.on('layout-change', () => this.attachScrollSync()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.attachScrollSync()));
    // Belt and braces: registerDomEvent can't be individually unregistered, and these
    // listeners must move between elements mid-session — hence manual attach/detach
    // with an explicit unload hook rather than registerDomEvent.
    this.register(() => this.detachScrollSync());
  }

  onunload() {
    this.detachScrollSync();
    if (this.syncTimer) window.clearTimeout(this.syncTimer);
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

    if (row.paired) {
      const el = view.blockEls.get(row.idx);
      if (!el) return null;
      return clamp(offsetIn(base, el) + frac * el.offsetHeight, 0, maxScroll(base));
    }

    const prev = row.pnPrev;
    const next = row.pnNext;
    const prevEl = prev ? view.blockEls.get(prev.idx) : null;
    const nextEl = next ? view.blockEls.get(next.idx) : null;
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
    if (row.paired) {
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
    const baseView = this.baseView();
    const baseEl = baseView && baseView.blockEls ? baseView.blockEls.get(row.idx) : null;
    if (baseEl && baseEl.isConnected) {
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

    const hit = this.topmostVisible(base, base.querySelectorAll('.sp2a-block'));
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
    let deltaPx = null;
    let deltaNote = 'unpaired note block — interpolated region, no exact counterpart';
    if (noteRow && noteRow.paired && base && view && noteOffsetPx != null) {
      const el = view.blockEls.get(noteRow.idx);
      if (el) {
        const baseOffsetPx = el.getBoundingClientRect().top - base.getBoundingClientRect().top;
        deltaPx = Number((baseOffsetPx - noteOffsetPx).toFixed(1));
        deltaNote = '0 = counterpart blocks sit at the same depth in both viewports; ' +
                    '+ = base pane block sits lower than the note pane block';
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      file: session.filePath,
      baseSha: session.shortSha,
      counts: session.counts,
      syncEnabled: this.syncEnabled,
      lastNoteScrollApi: this.lastScrollApi,
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
    this.session = null;
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
