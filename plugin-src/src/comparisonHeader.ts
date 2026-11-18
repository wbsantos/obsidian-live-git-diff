import type { Session } from './session.ts';

/** The same review details sit above snapshots and the temporary live-note panel. */
export class ComparisonHeader {
  readonly element: HTMLElement;
  readonly content: HTMLElement;
  private title: HTMLElement;
  private version: HTMLElement;
  private status: HTMLElement;
  private sync: HTMLElement;
  private swap: HTMLButtonElement;
  private versionKey = '';

  constructor(container: HTMLElement, swapSides: () => void) {
    this.element = container.createDiv({ cls: 'lgd-header' });
    this.content = this.element.createDiv({ cls: 'lgd-header-content' });
    this.title = this.content.createDiv({ cls: 'lgd-title' });
    this.version = this.content.createDiv({ cls: 'lgd-sub' });
    this.swap = this.content.createEl('button', { text: 'Swap sides', cls: 'lgd-swap' });
    this.swap.onclick = swapSides;
    this.status = this.content.createDiv({ cls: 'lgd-sub', attr: { role: 'status', 'aria-live': 'polite' } });
    this.sync = this.content.createDiv({ cls: 'lgd-sync' });
  }

  update(session: Session, side: 'a' | 'b', synced: boolean, warning?: string | null): void {
    const endpoint = session.endpoints[side === 'a' ? 0 : 1];
    const key = JSON.stringify([session.fileName, session.rel, endpoint, side]);
    if (key !== this.versionKey) {
      this.versionKey = key;
      this.title.setText(session.fileName);
      this.version.empty();
      const commit = endpoint.kind === 'commit' ? endpoint.commit : null;
      this.version.createSpan({ cls: 'lgd-sha', text: endpoint.kind === 'commit'
        ? `${side === 'a' ? 'Base' : 'Compared'} ${endpoint.sha.slice(0, 7)} · ${endpoint.label}` : 'Workcopy · Live document' });
      if (commit) {
        this.version.createSpan({ cls: 'lgd-subject', text: ' · ' + commit.subject });
        this.version.createSpan({ cls: 'lgd-age', text: ' · ' + commit.relative, attr: { title: commit.date } });
      }
      if (endpoint.path !== session.rel && endpoint.kind === 'commit')
        this.version.createSpan({ cls: 'lgd-renamed', text: ' · Historical path: ' + endpoint.path });
      this.swap.hidden = session.endpoints[1].kind !== 'commit';
    }
    const simplified = session.rows.some(row => row.simplified);
    const text = session.error || (session.status === 'updating' ? 'Updating comparison…' :
      `${session.counts.changed} changed blocks${simplified ? ' · Some details simplified' : ''}${warning ? ' · ' + warning : ''}`);
    if (this.status.textContent !== text) this.status.setText(text);
    this.status.toggleClass('lgd-error', !!session.error);
    this.updateSync(synced);
  }

  updateSync(synced: boolean): void {
    const text = synced ? ' · Scroll sync on' : ' · Scroll sync off';
    if (this.sync.textContent !== text) this.sync.setText(text);
  }

  naturalHeight(): number {
    const style = this.element.ownerDocument.defaultView!.getComputedStyle(this.element);
    return this.content.getBoundingClientRect().height + parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  }
}
