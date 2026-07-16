/**
 * dom.ts — small geometry helpers shared by the sync + view-zone layers.
 * No Obsidian imports: these are plain DOM measurements.
 */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Scroll-space offset of `el` inside scroll container `box`.
 * Deliberately rect-based rather than offsetTop: offsetTop is relative to the
 * nearest POSITIONED ancestor, which is neither pane's scroller today and would
 * silently start lying the moment someone adds `position:relative` to a wrapper.
 */
export function offsetIn(box: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
}

export function maxScroll(box: HTMLElement): number {
  return Math.max(0, box.scrollHeight - box.clientHeight);
}

/** A view-ish object with the containers a markdown view may expose. */
interface ScrollerHost {
  previewMode?: { containerEl?: HTMLElement };
  contentEl?: HTMLElement;
  containerEl?: HTMLElement;
}

/**
 * Find the element that actually scrolls a markdown reading view.
 * Feature-detected, never assumed: attaching to the wrong element yields zero scroll
 * events and a plugin that looks "enabled but dead". Returns null (caller warns).
 */
export function findPreviewScroller(view: unknown): HTMLElement | null {
  const v = view as ScrollerHost;
  const roots: HTMLElement[] = [];
  if (v.previewMode && v.previewMode.containerEl) roots.push(v.previewMode.containerEl);
  if (v.contentEl) roots.push(v.contentEl);
  if (v.containerEl) roots.push(v.containerEl);

  const scrollable = (el: HTMLElement | null): boolean => {
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
    const cands: HTMLElement[] = [];
    if (root.classList && root.classList.contains('markdown-preview-view')) cands.push(root);
    cands.push(...Array.from(root.querySelectorAll<HTMLElement>('.markdown-preview-view')));
    cands.push(...Array.from(root.querySelectorAll<HTMLElement>('.markdown-reading-view')));
    for (const c of cands) if (scrollable(c)) return c;
  }
  return null;
}

/**
 * Topmost VISIBLE block of a pane, plus how far its top sits ABOVE the viewport
 * top as a fraction of its own height.
 *
 * "Topmost visible" = first element in document order whose bottom is below the
 * container's top edge. Only rendered elements are considered — which is the whole
 * point: in the note pane the un-rendered ones do not exist to be considered.
 */
export interface TopHit {
  el: HTMLElement;
  rect: DOMRect;
  frac: number;
}

export function topmostVisible(
  container: HTMLElement,
  els: ArrayLike<HTMLElement>
): TopHit | null {
  const top = container.getBoundingClientRect().top;
  for (const el of Array.from(els)) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom > top + 1) {
      const frac = rect.height > 0 ? clamp((top - rect.top) / rect.height, 0, 1) : 0;
      return { el, rect, frac };
    }
  }
  return null;
}
