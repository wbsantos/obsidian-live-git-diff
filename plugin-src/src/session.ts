/**
 * session.ts — the in-memory review session.
 *
 * A session is built once per review (or per explicit re-pin) and is NEVER persisted:
 * no data file, no cache on disk, nothing in the vault. Close the review or quit
 * Obsidian and it is gone, which is the intended blast radius for a thing whose only
 * job is to describe two texts to each other.
 */
import type { PairRow, PairKind } from './diff/mddiff.ts';

import type { CommitInfo } from './git.ts';

/**
 * Per-pane index for one row: where it sits in that pane's document order, the
 * nearest PAIRED row either side of it, and — for unpaired rows — its position
 * within its run of unpaired rows. Those last two are what let us interpolate across
 * an insertion/deletion region without measuring blocks that may not be rendered.
 */
export interface SideIndex {
  pos: number;
  prev: Row | null;
  next: Row | null;
  /** Only set for UNPAIRED rows — a paired row is never interpolated. */
  runIdx?: number;
  runLen?: number;
}

/** A diff row, annotated with everything scroll sync needs. */
export interface Row extends PairRow {
  idx: number;
  paired: boolean;
  /** Index within the NOTE pane's order. Present iff the row exists there (`b`). */
  pn?: SideIndex;
  /** Index within the BASE pane's order. Present iff the row exists there (`a`). */
  pb?: SideIndex;
}

export interface Session {
  revision: number;
  status: 'updating' | 'ready' | 'error';
  currentText: string;
  baseText: string;
  baseReferences: string;
  breaks: boolean;
  filePath: string;
  fileName: string;
  sha: string;
  shortSha: string;
  /** Human label for where the base came from: 'HEAD', 'main', 'v1.2', a picked sha… */
  baseRefLabel: string;
  /**
   * Subject + age of the pinned commit, for the header.
   * Load-bearing once the base is arbitrary: `base d308280` cannot answer "which version
   * am I looking at?" — `base d308280 · "apply review round 1" · 7 hours ago` can.
   */
  baseCommit: CommitInfo | null;
  /**
   * The path the base was read under, when a rename means it differs from the note's
   * current path. null = same path. Surfaced so a base pane that legitimately shows a
   * file under an old name says so, rather than looking like a bug.
   */
  baseReadAs: string | null;
  root: string;
  rel: string;
  rows: Row[];
  /** Rows present in the note pane (pane A), in its order. */
  noteRows: Row[];
  /** Rows present in the base pane (pane B), in its order. */
  baseRows: Row[];
  /**
   * Last 0-indexed line of the current file's last block — the clamp target when a
   * trailing insertion has no following paired anchor.
   */
  curLastLine: number;
  curMap: Array<{ kind: PairKind; lineStart: number; lineEnd: number }>;
  counts: { blocks: number; curBlocks: number; changed: number };
  error: string | null;
}

/**
 * Annotate one pane's ordered row list with the anchor data scroll-sync needs.
 *
 * `list` is the subsequence of rows VISIBLE in that pane (a 'del' row simply does not
 * exist in the note pane; an 'ins' row does not exist in the base pane), so positions
 * here are that pane's document order.
 */
function indexSide(list: Row[], K: 'pn' | 'pb'): void {
  let lastPaired: Row | null = null;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    r[K] = { pos: i, prev: lastPaired, next: null };
    if (r.paired) lastPaired = r;
  }
  let nextPaired: Row | null = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    const side = r[K];
    if (side) side.next = nextPaired;
    if (r.paired) nextPaired = r;
  }
  let i = 0;
  while (i < list.length) {
    if (list[i].paired) { i++; continue; }
    let j = i;
    while (j < list.length && !list[j].paired) j++;
    for (let k = i; k < j; k++) {
      const side = list[k][K];
      if (side) { side.runIdx = k - i; side.runLen = j - i; }
    }
    i = j;
  }
}

/**
 * Build a review session, pinning the base sha ONCE.
 *
 * Why pinned: commits land WHILE a review is in progress (this plugin was built for
 * reviewing a doc an agent is still editing). If we diffed against a live HEAD, the
 * diff would silently shrink toward zero as commits land, and the review would appear
 * to "finish itself". The base sha is captured by the caller and every later
 * `git show` uses it. Re-pinning is an explicit user command.
 */
export interface BasePin {
  sha: string;
  label: string;
  commit: CommitInfo | null;
  /** Set only when a rename means the base was read under a different path. */
  readAs: string | null;
}

/** Production comparisons arrive from the worker; building indexes performs no diff. */
export function sessionFromRows(
  file: { path: string; name: string }, baseText: string,
  ctx: { root: string; rel: string }, pin: BasePin, currentText: string,
  input: PairRow[], revision = 0, breaks = false
): Session {
  const rows = input as Row[];
  const headBlocks = rows.flatMap(r => r.a ? [r.a] : []);
  const curBlocks = rows.flatMap(r => r.b ? [r.b] : []);

  // Line map for the RIGHT pane: only rows that exist in the current file.
  const curMap: Session['curMap'] = [];
  for (const row of rows) {
    if (!row.b) continue;
    curMap.push({ kind: row.kind, lineStart: row.b.lineStart, lineEnd: row.b.lineEnd });
  }

  const changed = rows.filter((r) => r.kind !== 'same').length;

  // ---- scroll-sync anchor index -------------------------------------------
  // A row is an ANCHOR only if it exists in BOTH panes ('same' or 'mod'). 'ins' and
  // 'del' rows are the drift-prone regions and are handled by interpolation.
  const noteRows: Row[] = [];
  const baseRows: Row[] = [];
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
    revision, status: 'ready', currentText, baseText, baseReferences: '', breaks,
    filePath: file.path,
    fileName: file.name,
    sha: pin.sha,
    shortSha: pin.sha.slice(0, 7),
    baseRefLabel: pin.label,
    baseCommit: pin.commit,
    baseReadAs: pin.readAs,
    root: ctx.root,
    rel: ctx.rel,
    rows,
    noteRows,
    baseRows,
    curLastLine: curBlocks.length ? curBlocks[curBlocks.length - 1].lineEnd : 0,
    curMap,
    counts: { blocks: headBlocks.length, curBlocks: curBlocks.length, changed },
    error: null,
  };
}

/**
 * The session shape used when the base could not be fetched.
 *
 * A REAL session object, not null, and the error is carried IN it — because an empty
 * base pane must never be the only signal. "No base text" and "the whole file is new"
 * look identical on screen, and the second one is wrong-but-plausible, which is the
 * class of failure this codebase works hardest to avoid.
 */
export function errorSession(file: { path: string; name: string }, msg: string): Session {
  return {
    revision: 0, status: 'error', currentText: '', baseText: '', baseReferences: '', breaks: false,
    filePath: file.path,
    fileName: file.name,
    sha: '',
    shortSha: '',
    baseRefLabel: '',
    baseCommit: null,
    baseReadAs: null,
    root: '',
    rel: '',
    rows: [],
    noteRows: [],
    baseRows: [],
    curLastLine: 0,
    curMap: [],
    counts: { blocks: 0, curBlocks: 0, changed: 0 },
    error: msg,
  };
}

export interface Revision { epoch: number; filePath: string; sha: string; revision: number }
/** Identity is independent of worker cancellation, protecting every async boundary. */
export class RevisionGate {
  private epoch = 0;
  private active: Revision | null = null;
  begin(filePath: string, sha: string): Revision {
    this.active = { epoch: ++this.epoch, filePath, sha, revision: 0 };
    return this.active;
  }
  next(): Revision | null {
    if (this.active) this.active = { ...this.active, revision: this.active.revision + 1 };
    return this.active;
  }
  accepts(value: Revision): boolean {
    const a = this.active;
    return !!a && a.epoch === value.epoch && a.filePath === value.filePath && a.sha === value.sha && a.revision === value.revision;
  }
  close(): void { this.active = null; this.epoch++; }
}

