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

/** The base pane's view, reduced to what the other modules actually touch. */
export interface BasePaneLike {
  /** The scrolling element of this pane. Recreated on every render. */
  bodyEl: HTMLElement | null;
  /** row.idx -> its block container in this pane. */
  blockEls: Map<number, HTMLElement>;
  /** row.idx -> the VIEW ZONE standing in for an 'ins' row. */
  spacerEls: Map<number, HTMLElement>;
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
