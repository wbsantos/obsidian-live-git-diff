import { ItemView, Menu, setIcon } from 'obsidian';
import { errorMessage } from './errors.ts';
export const EXPLAIN_VIEW_TYPE = 'live-git-diff-explain';

/** A disposable, non-interactive reading panel. Each request owns its process lifetime. */
export class ExplainView extends ItemView {
  private job: AbortController | null = null;
  private generation = 0;
  private closed = false;
  getViewType(): string { return EXPLAIN_VIEW_TYPE; }
  getDisplayText(): string { return 'Explain'; }
  getIcon(): string { return 'sparkles'; }
  async onOpen(): Promise<void> { this.closed = false; this.contentEl.addClass('lgd-explain'); }
  async onClose(): Promise<void> { this.closed = true; this.generation++; this.job?.abort(); }
  async explain(title: string, load: (signal: AbortSignal) => Promise<string>): Promise<void> {
    this.job?.abort(); const job = this.job = new AbortController(), generation = ++this.generation;
    const root = this.contentEl; root.empty();
    root.oncontextmenu = null;
    const header = root.createDiv({ cls: 'lgd-explain-heading' });
    header.createDiv({ cls: 'lgd-explain-title', text: title });
    const close = header.createEl('button', { cls: 'clickable-icon', attr: { title: 'Close Explain panel', 'aria-label': 'Close Explain panel' } });
    setIcon(close, 'x'); close.onclick = () => { this.job?.abort(); void this.leaf.detach(); };
    const cancel = header.createEl('button', { cls: 'clickable-icon', attr: { title: 'Cancel generation', 'aria-label': 'Cancel generation' } });
    setIcon(cancel, 'square'); cancel.onclick = () => job.abort();
    const body = root.createDiv({ cls: 'lgd-explain-text', text: 'Preparing explanation…', attr: { role: 'status', 'aria-live': 'polite' } });
    try {
      const result = await load(job.signal);
      if (this.closed || generation !== this.generation) return;
      body.setText(result); cancel.remove();
      root.oncontextmenu = event => {
        event.preventDefault(); const menu = new Menu();
        menu.addItem(item => item.setTitle('Copy explanation').setIcon('copy').onClick(() => root.ownerDocument.defaultView!.navigator.clipboard.writeText(result)));
        menu.addItem(item => item.setTitle('Explain again').setIcon('sparkles').onClick(() => this.explain(title, load)));
        menu.showAtMouseEvent(event);
      };
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      body.setText(job.signal.aborted ? 'Cancelled.' : errorMessage(error)); body.toggleClass('lgd-error', !job.signal.aborted); cancel.remove();
    }
  }
}
