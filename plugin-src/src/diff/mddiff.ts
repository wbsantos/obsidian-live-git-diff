/**
 * mddiff.ts — markdown block splitting + block pairing for side-by-side diff review.
 *
 * Dependency-free and DOM-free: this module runs in plain node (so it is unit-testable
 * without Obsidian) AND in Electron's renderer. Nothing here imports `obsidian`, which
 * is deliberate — it is what lets test/mddiff.test.ts exercise the real code rather
 * than a copy of it.
 *
 * Mirrors the semantics of the render-preview.py reference (blocks/norm/pair),
 * with two additions: blocks carry 0-indexed inclusive source line ranges, and
 * 'mod' pairs are gated by a similarity threshold so unrelated blocks are never
 * shown as a modification of each other.
 */

/** Similarity threshold below which a replace-run pair is split into del+ins. */
export const MOD_MIN_SIMILARITY = 0.5;

/** A line that STARTS a list item. Used to match Obsidian's section grain. */
const LIST_START = /^\s*(?:[-*+]|\d+[.)])\s/;

/** One top-level block of markdown source, with its INCLUSIVE 0-indexed line range. */
export interface Block {
  text: string;
  lineStart: number;
  lineEnd: number;
}

export type PairKind = 'same' | 'mod' | 'del' | 'ins';

/** One row of the aligned side-by-side diff. `a` = base side, `b` = current side. */
export interface PairRow {
  kind: PairKind;
  a: Block | null;
  b: Block | null;
}

export type OpTag = 'equal' | 'delete' | 'insert' | 'replace';
/** difflib-style opcode: [tag, i1, i2, j1, j2] — half-open ranges. */
export type Opcode = [OpTag, number, number, number, number];

/**
 * Split markdown source into top-level blocks.
 * A block = a run of non-blank lines, OR a whole fenced code block (``` ... ```),
 * separated by blank lines. Fence contents are NEVER split on blank lines.
 *
 * lineStart/lineEnd are 0-indexed, INCLUSIVE, referring to the source lines.
 */
export function blocks(text: string | null | undefined): Block[] {
  const lines = String(text == null ? '' : text).split('\n');
  const out: Block[] = [];
  let cur: string[] = [];
  let curStart = -1;
  let fence = false;

  function push(endIdx: number): void {
    if (!cur.length) return;
    out.push({ text: cur.join('\n'), lineStart: curStart, lineEnd: endIdx });
    cur = [];
    curStart = -1;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
      //
      // THIS RULE IS THE ONE THE GRAIN ORACLE TEST EXISTS TO POLICE. Obsidian's
      // sectioning is closed-source and is the ground truth here; agreement is a
      // measurement (test/grain-oracle.test.ts against a captured
      // metadataCache.getFileCache().sections snapshot), never an argument.
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
export function norm(b: string): string {
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
export function similarity(na: string, nb: string): number {
  if (na === nb) return 1;
  const ta = na ? na.split(' ') : [];
  const tb = nb ? nb.split(' ') : [];
  if (!ta.length && !tb.length) return 1;
  if (!ta.length || !tb.length) return 0;
  const counts: Record<string, number> = Object.create(null);
  for (let i = 0; i < ta.length; i++) {
    const k = ' ' + ta[i];
    counts[k] = (counts[k] || 0) + 1;
  }
  let inter = 0;
  for (let j = 0; j < tb.length; j++) {
    const k2 = ' ' + tb[j];
    if (counts[k2] > 0) {
      counts[k2]--;
      inter++;
    }
  }
  return (2 * inter) / (ta.length + tb.length);
}

/**
 * Standard DP LCS over two string arrays -> difflib-style opcodes.
 * O(n*m) time/space. For ~300x300 blocks this is ~90k cells (<1ms).
 *
 * Exported so the WORD-level diff can reuse this exact LCS at a finer granularity,
 * rather than the codebase growing a second diff algorithm with its own edge cases.
 * Same function, different tokens.
 */
export function opcodes(A: string[], B: string[]): Opcode[] {
  const n = A.length;
  const m = B.length;
  // dp[i][j] = LCS length of A[i:], B[j:]
  const dp: Int32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
  for (let i2 = n - 1; i2 >= 0; i2--) {
    for (let j2 = m - 1; j2 >= 0; j2--) {
      dp[i2][j2] = A[i2] === B[j2]
        ? dp[i2 + 1][j2 + 1] + 1
        : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
    }
  }
  // Walk the traceback, emitting raw per-element ops, then coalesce into runs.
  const raw: Array<[OpTag, number, number]> = [];
  let i3 = 0;
  let j3 = 0;
  while (i3 < n && j3 < m) {
    if (A[i3] === B[j3]) {
      raw.push(['equal', i3, j3]);
      i3++;
      j3++;
    } else if (dp[i3 + 1][j3] >= dp[i3][j3 + 1]) {
      raw.push(['delete', i3, j3]);
      i3++;
    } else {
      raw.push(['insert', i3, j3]);
      j3++;
    }
  }
  while (i3 < n) { raw.push(['delete', i3, j3]); i3++; }
  while (j3 < m) { raw.push(['insert', i3, j3]); j3++; }

  // Coalesce adjacent same-tag ops into runs; merge an adjacent delete-run +
  // insert-run into a single 'replace' run (difflib's opcode shape).
  const runs: Opcode[] = [];
  for (let r = 0; r < raw.length; r++) {
    const tag = raw[r][0];
    const ri = raw[r][1];
    const rj = raw[r][2];
    const last = runs[runs.length - 1];
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
  const merged: Opcode[] = [];
  for (let q = 0; q < runs.length; q++) {
    const cur = runs[q];
    const prev = merged[merged.length - 1];
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
 */
export function pair(blocksA: Block[], blocksB: Block[]): PairRow[] {
  const As = blocksA || [];
  const Bs = blocksB || [];
  const NA = As.map((x) => norm(x.text));
  const NB = Bs.map((x) => norm(x.text));
  const ops = opcodes(NA, NB);
  const rows: PairRow[] = [];

  for (let o = 0; o < ops.length; o++) {
    const tag = ops[o][0];
    const i1 = ops[o][1];
    const i2 = ops[o][2];
    const j1 = ops[o][3];
    const j2 = ops[o][4];
    if (tag === 'equal') {
      for (let k = 0; k < i2 - i1; k++) {
        rows.push({ kind: 'same', a: As[i1 + k], b: Bs[j1 + k] });
      }
    } else if (tag === 'delete') {
      for (let d = i1; d < i2; d++) rows.push({ kind: 'del', a: As[d], b: null });
    } else if (tag === 'insert') {
      for (let s = j1; s < j2; s++) rows.push({ kind: 'ins', a: null, b: Bs[s] });
    } else { // replace — align pairwise; overflow becomes pure del/ins
      const n = Math.max(i2 - i1, j2 - j1);
      const pending: PairRow[] = []; // ins rows held back so del/ins stay grouped per index
      for (let p = 0; p < n; p++) {
        const a = (i1 + p < i2) ? As[i1 + p] : null;
        const b = (j1 + p < j2) ? Bs[j1 + p] : null;
        if (a && b) {
          if (similarity(NA[i1 + p], NB[j1 + p]) >= MOD_MIN_SIMILARITY) {
            // FLUSH FIRST. Held-back inserts sit ABOVE this pair in the note (their
            // b-side lines are all < this one's), and a 'mod' is anchored to a real note
            // block. Emitting the mod ahead of them would claim a row order the note
            // itself contradicts — and the base pane renders in ROW order while the note
            // renders in DOCUMENT order, so the two panes disagree by exactly the height
            // of whatever was deferred past it. Measured: rows carried note lines
            // 294, 295, 303, 301 — 303 before 301 — and the paired block it belonged to
            // sat 249px out of line, with its word-marks intact on both sides, which is
            // what made it look like an alignment bug rather than an ordering one.
            for (let q = 0; q < pending.length; q++) rows.push(pending[q]);
            pending.length = 0;
            rows.push({ kind: 'mod', a, b });
          } else {
            // Not actually a modification of each other — show as separate ops.
            rows.push({ kind: 'del', a, b: null });
            pending.push({ kind: 'ins', a: null, b });
          }
        } else if (a) {
          rows.push({ kind: 'del', a, b: null });
        } else if (b) {
          pending.push({ kind: 'ins', a: null, b });
        }
      }
      for (let y = 0; y < pending.length; y++) rows.push(pending[y]);
    }
  }
  return rows;
}
