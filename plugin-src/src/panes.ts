/**
 * panes.ts — the contracts the two panes expose to each other.
 *
 * These interfaces exist so viewzones.ts / sync.ts / baseView.ts can be separate
 * modules without importing the plugin class (and each other) in a cycle. They are
 * STRUCTURAL: main.ts satisfies `PaneHost` by having the methods, not by declaring it.
 *
 * The naming follows the design doc: pane A = the real note, pane B = our git-base
 * ItemView.
 */
import type { Session } from './session.ts';

/** CSS class + attribute names, in one place so styles.css and TS cannot drift. */
export const CLS = {
  /** A block in the BASE pane (ours). */
  block: 'lgd-block',
  /** A view zone in the BASE pane, standing in for an 'ins' row. */
  spacer: 'lgd-spacer',
  /** The TRAILING view zone: the base pane's stand-in for Obsidian's scroll-past-end room. */
  endpad: 'lgd-endpad',
  /** A section in the NOTE pane that we have tagged (every section, not just changed). */
  nblock: 'lgd-nblock',
  ins: 'lgd-ins',
  del: 'lgd-del',
  mod: 'lgd-mod',
  same: 'lgd-same',
  charIns: 'lgd-char-ins',
  charDel: 'lgd-char-del',
} as const;

/** Row index stamped on both panes' elements, so lookups never rescan the row list. */
export const ATTR_ROW = 'data-row-index';

/**
 * The kind classes we own on a NOTE-pane section. Deletions never appear here — they are
 * view zones, not blocks — so a note block is only ever 'ins', 'mod', or unmarked.
 */
export const NOTE_KIND_CLASSES: readonly string[] = [CLS.ins, CLS.mod];

/** The DOM surface setNoteKind touches, narrowed so it is testable without a jsdom. */
interface ClassTarget {
  classList: { add(c: string): void; remove(c: string): void };
}

/**
 * Put a note block in EXACTLY the kind this session says — never merely add to it.
 *
 * Reading-view sections are recycled, not rebuilt, so an element can arrive still wearing
 * the PREVIOUS review's wash. A conditional `addClass` can only ever put paint on; nothing
 * takes it off. Re-pinning onto a base with fewer changes therefore left every stale 'ins'
 * block green underneath a header that correctly read "0 changed" — a diff that no longer
 * existed, rendered convincingly (bug, 2026-07-15).
 *
 * Removing before adding is what makes this a SET rather than an accumulate. It touches
 * only the two classes we own, so side-comments' marks and Obsidian's own classes on the
 * same element are left alone.
 */
export function setNoteKind(el: ClassTarget, kind: string | null): void {
  for (const c of NOTE_KIND_CLASSES) el.classList.remove(c);
  if (kind === 'ins') el.classList.add(CLS.ins);
  else if (kind === 'mod') el.classList.add(CLS.mod);
}

/** The base pane's view, reduced to what the other modules actually touch. */
export interface BasePaneLike {
  /** The scrolling element of this pane. Recreated on every render. */
  bodyEl: HTMLElement | null;
  /** row.idx -> its block container in this pane. */
  blockEls: Map<number, HTMLElement>;
  /** row.idx -> the VIEW ZONE standing in for an 'ins' row. */
  spacerEls: Map<number, HTMLElement>;
  /** The trailing view zone. Null before the first render. See ViewZones.styleEndPad. */
  endPadEl: HTMLElement | null;
}

/** A markdown view, reduced to the scroll APIs we feature-detect. */
export interface MarkdownViewLike {
  currentMode?: { applyScroll?: (line: number) => void };
  previewMode?: { applyScroll?: (line: number) => void; rerender?: (full?: boolean) => void };
  setEphemeralState?: (state: unknown) => void;
}

export interface NotePane {
  view: MarkdownViewLike;
  scroller: HTMLElement;
}

/** What the zone + sync layers need from the plugin. */
export interface PaneHost {
  session: Session | null;
  notePane(): NotePane | null;
  baseView(): BasePaneLike | null;
  basePane(): HTMLElement | null;
  /**
   * The base-pane element standing in for `rowIdx` — a real block, or the VIEW ZONE
   * that occupies the place a real block would have. THE SINGLE RESOLVER.
   */
  baseElFor(rowIdx: number): HTMLElement | null;
}
