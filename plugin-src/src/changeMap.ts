import { clamp } from './dom.ts';
import { changeMarkers } from './changeMapModel.ts';
import type { ChangeMarker } from './changeMapModel.ts';
import type { Session } from './session.ts';

export interface ChangeMapPane {
  side: 'a' | 'b';
  container: HTMLElement;
  scroller: HTMLElement;
  content: HTMLElement | null;
  /** Pixel offsets when the pane can measure off-screen content; otherwise line estimates. */
  range(marker: ChangeMarker): { top: number; bottom: number } | null;
  navigate(marker: ChangeMarker): void;
}

/** A fixed overview beside the native scrollbar; it never enters the document's content. */
export class ChangeMap {
  private pane: ChangeMapPane;
  private session: Session | null = null;
  private element: HTMLElement;
  private viewport: HTMLElement;
  private markers: Array<{ marker: ChangeMarker; button: HTMLButtonElement }> = [];
  private lineCount = 1;
  private observer: ResizeObserver;
  private frame: number | null = null;
  private win: Window;
  private onScroll = (): void => this.updateViewport();
  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.pane.scroller.scrollTop += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.pane.scroller.clientHeight : 1);
  };

  constructor(pane: ChangeMapPane) {
    this.pane = pane;
    this.win = pane.container.ownerDocument.defaultView!;
    this.element = pane.container.createDiv({ cls: 'lgd-change-map', attr: {
      role: 'navigation', 'aria-label': `Change map: ${pane.side === 'a' ? 'base version' : 'compared version'}`,
    } });
    this.viewport = this.element.createDiv({ cls: 'lgd-change-map-viewport', attr: { 'aria-hidden': 'true' } });
    this.element.onclick = event => {
      if ((event.target as Element).closest('button')) return;
      const rect = this.element.getBoundingClientRect();
      pane.scroller.scrollTop = clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1) * pane.scroller.scrollHeight - pane.scroller.clientHeight / 2;
    };
    this.element.addEventListener('wheel', this.onWheel, { passive: false });
    pane.scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.observer = new ResizeObserver(() => this.refresh());
    for (const el of new Set([pane.container, pane.scroller, pane.content].filter((el): el is HTMLElement => !!el))) this.observer.observe(el);
  }

  update(session: Session, pane: ChangeMapPane): void {
    this.pane = pane;
    if (this.session !== session) {
      this.session = session;
      for (const { button } of this.markers) button.remove();
      this.lineCount = (pane.side === 'a' ? session.baseText : session.currentText).split('\n').length;
      this.markers = changeMarkers(session.rows, pane.side).map(marker => {
        const label = `${marker.kind === 'ins' ? 'Added' : marker.kind === 'del' ? 'Removed' : 'Modified'} block · line ${marker.lineStart + 1}`;
        const color = marker.kind === 'del' || (marker.kind === 'mod' && pane.side === 'a') ? 'deletion' : 'addition';
        const button = this.element.createEl('button', { cls: `lgd-change-map-marker is-${color}`, attr: {
          type: 'button', title: label, 'aria-label': label, 'data-row-index': String(marker.row),
        } });
        button.onclick = event => { event.stopPropagation(); this.pane.navigate(marker); };
        return { marker, button };
      });
    }
    this.refresh();
  }

  /** Geometry work is coalesced; scrolling only moves the small viewport indicator. */
  refresh(): void {
    if (this.frame !== null) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = null;
      const { container, scroller } = this.pane;
      const box = scroller.getBoundingClientRect(), root = container.getBoundingClientRect();
      this.element.style.top = `${box.top - root.top}px`;
      this.element.style.right = `${Math.max(0, root.right - box.right) + Math.max(12, scroller.offsetWidth - scroller.clientWidth)}px`;
      this.element.style.height = `${scroller.clientHeight}px`;
      const height = Math.max(1, scroller.scrollHeight), track = scroller.clientHeight;
      for (const { marker, button } of this.markers) {
        const range = this.pane.range(marker);
        const top = range?.top ?? marker.lineStart / this.lineCount * height;
        const bottom = range?.bottom ?? (marker.lineEnd + (marker.missing ? 0 : 1)) / this.lineCount * height;
        const pixels = clamp(Math.max(4, (bottom - top) / height * track), 4, Math.max(4, track));
        button.style.top = `${clamp(top / height * track, 0, Math.max(0, track - pixels))}px`;
        button.style.height = `${pixels}px`;
      }
      this.updateViewport();
    });
  }

  private updateViewport(): void {
    const { scroller } = this.pane;
    const height = Math.max(1, scroller.scrollHeight);
    this.viewport.style.top = `${clamp(scroller.scrollTop / height * 100, 0, 100)}%`;
    this.viewport.style.height = `${Math.min(100, scroller.clientHeight / height * 100)}%`;
  }

  destroy(): void {
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.pane.scroller.removeEventListener('scroll', this.onScroll);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.remove();
  }
}
