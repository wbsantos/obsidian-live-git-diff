import { ComparisonHeader } from './comparisonHeader.ts';
import { ChangeMap } from './changeMap.ts';
import type { ChangeMapPane } from './changeMap.ts';
import type { Session } from './session.ts';

/** Owns only temporary comparison UI. Closing a review restores the native note layout. */
export class ComparisonChrome {
  private live: { container: HTMLElement; header: ComparisonHeader } | null = null;
  private maps = new Map<HTMLElement, ChangeMap>();
  private headers: ComparisonHeader[] = [];
  private observer: ResizeObserver | null = null;
  private frame: number | null = null;

  update(session: Session | null, liveContainer: HTMLElement | null, headers: ComparisonHeader[], panes: ChangeMapPane[], synced: boolean, warning?: string | null): void {
    if (!session) { this.reset(); return; }
    if (this.live?.container !== liveContainer) {
      this.removeLive();
      if (liveContainer) {
        liveContainer.addClass('lgd-live-review');
        const header = new ComparisonHeader(liveContainer, () => {});
        liveContainer.prepend(header.element);
        this.live = { container: liveContainer, header };
      }
    }
    this.live?.header.update(session, 'b', synced, warning);
    const nextHeaders = [...headers, ...(this.live ? [this.live.header] : [])];
    if (nextHeaders.length !== this.headers.length || nextHeaders.some((header, i) => header !== this.headers[i])) {
      for (const header of this.headers) header.element.style.removeProperty('min-height');
      this.headers = nextHeaders;
      this.observer?.disconnect();
      this.observer = new ResizeObserver(() => this.refresh());
      for (const header of this.headers) this.observer.observe(header.content);
    }
    const active = new Set(panes.map(pane => pane.scroller));
    for (const [scroller, map] of this.maps) if (!active.has(scroller)) { map.destroy(); this.maps.delete(scroller); }
    for (const pane of panes) {
      let map = this.maps.get(pane.scroller);
      if (!map) { map = new ChangeMap(pane); this.maps.set(pane.scroller, map); }
      map.update(session, pane);
    }
    this.refresh();
  }

  refresh(): void {
    if (this.frame !== null || (!this.headers.length && !this.maps.size)) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      const height = Math.ceil(Math.max(0, ...this.headers.map(header => header.naturalHeight())));
      for (const header of this.headers) {
        const value = `${height}px`;
        if (header.element.style.minHeight !== value) header.element.style.minHeight = value;
      }
      for (const map of this.maps.values()) map.refresh();
    });
  }

  private removeLive(): void {
    this.live?.header.element.remove();
    this.live?.container.removeClass('lgd-live-review');
    this.live = null;
  }

  reset(): void {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.observer?.disconnect(); this.observer = null;
    for (const header of this.headers) header.element.style.removeProperty('min-height');
    this.headers = [];
    this.removeLive();
    for (const map of this.maps.values()) map.destroy();
    this.maps.clear();
  }
}
