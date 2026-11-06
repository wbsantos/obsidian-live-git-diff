import type { EditorView } from '@codemirror/view';
import type { PairRow } from './diff/mddiff.ts';
import { tablePresentation, type TableRowPresentation } from './editorPresentation.ts';

const CELL_CLASSES = ['lgd-table-cell-ins', 'lgd-table-cell-del', 'lgd-table-cell-detail'];

/** Match source identity, not text or viewport order (tables may be repeated). */
export function tableAtRange(rows: PairRow[], from: number, to: number): PairRow | null {
  const matches = rows.filter(row => {
    const block = row.b;
    if (block?.type !== 'table') return false;
    return from === to ? block.sourceStart <= from && from <= block.sourceEnd
      : from <= block.sourceStart && to >= block.sourceEnd;
  });
  return matches.length === 1 ? matches[0] : null;
}

/** Only our attributes/classes are removed. Native cells, editors and selection stay intact. */
export function clearTableCell(cell: HTMLElement): void {
  cell.classList.remove(...CELL_CLASSES);
  cell.removeAttribute('data-lgd-table-row');
  cell.removeAttribute('data-lgd-table-column');
}

export function paintTableRow(tr: HTMLTableRowElement, change: TableRowPresentation, side: 'a' | 'b'): void {
  tr.classList.add('lgd-rowchanged');
  for (let column = 0; column < tr.cells.length; column++) {
    const cell = tr.cells[column];
    cell.classList.add(side === 'a' ? 'lgd-table-cell-del' : 'lgd-table-cell-ins');
    cell.classList.toggle('lgd-table-cell-detail', change.columns.includes(column));
    cell.setAttribute('data-lgd-table-row', String(change.index));
    cell.setAttribute('data-lgd-table-column', String(column));
  }
}

interface TableTarget { table: HTMLTableElement; row: PairRow }
interface Measurements { generation: number; targets: TableTarget[]; failed: number }

/**
 * Native Live Preview tables are replacement widgets. Source-line decorations
 * cannot paint their rows, and their public Markdown postprocessor has no section
 * info. Locate their DOM through the registered EditorView and its public posAtDOM
 * API, then add presentation classes only. This adapter deliberately owns no editor.
 */
export class NativeTablePresentation {
  private rows: PairRow[] | null = null;
  private generation = 0;
  private revision = -1;
  private marked = new Set<HTMLTableRowElement>();
  private observer: MutationObserver | null = null;
  private frame: number | null = null;
  private disposed = false;
  private issue: string | null = null;

  private view: EditorView;
  private report?: (message: string | null) => void;
  constructor(view: EditorView, report?: (message: string | null) => void) { this.view = view; this.report = report; }

  update(rows: PairRow[] | null, revision: number): void {
    if (rows !== this.rows || revision !== this.revision) {
      this.generation++;
      this.clear();
      this.rows = rows;
      this.revision = revision;
    }
    const active = !!rows?.some(row => row.b?.type === 'table' && row.kind !== 'same');
    if (!active) {
      this.observer?.disconnect(); this.observer = null;
      this.setIssue(null);
      this.view.dom.removeAttribute('data-lgd-table-mapped');
      this.view.dom.removeAttribute('data-lgd-table-failed');
      this.view.dom.removeAttribute('data-lgd-table-revision');
      return;
    }
    if (!this.observer) {
      const win = this.view.dom.ownerDocument.defaultView!;
      this.observer = new win.MutationObserver(() => this.schedule());
      // Ignore our class/attribute changes, but follow cell editing and recycled widgets.
      this.observer.observe(this.view.contentDOM, { childList: true, subtree: true });
    }
    this.schedule();
  }

  schedule(): void {
    if (this.disposed || !this.rows || this.frame !== null) return;
    this.frame = this.view.dom.ownerDocument.defaultView!.requestAnimationFrame(() => {
      this.frame = null;
      if (this.disposed || !this.rows) return;
      this.view.requestMeasure({ key: this, read: () => this.measure(), write: result => this.paint(result) });
    });
  }

  private measure(): Measurements {
    const result: Measurements = { generation: this.generation, targets: [], failed: 0 };
    if (!this.rows) return result;
    for (const widget of Array.from(this.view.contentDOM.querySelectorAll<HTMLElement>('.cm-table-widget'))) {
      // Embedded notes or another editor's tables do not belong to this document.
      if (widget.closest('.cm-editor') !== this.view.dom) continue;
      let from: number, to: number;
      try {
        from = this.view.posAtDOM(widget, 0);
        to = this.view.posAtDOM(widget, widget.childNodes.length);
      } catch { result.failed++; continue; }
      if (to < from) [from, to] = [to, from];
      const row = tableAtRange(this.rows, from, to);
      if (!row) {
        if (this.rows.some(r => r.kind !== 'same' && r.b?.type === 'table' && from <= r.b.sourceEnd && to >= r.b.sourceStart)) result.failed++;
        continue;
      }
      if (row.kind === 'same') continue;
      const table = widget.querySelector<HTMLTableElement>('table');
      const cells = row.b!.cells;
      if (!table || !cells || table.rows.length !== cells.length ||
          Array.from(table.rows).some((tr, index) => tr.cells.length !== cells[index].length)) {
        result.failed++; continue;
      }
      result.targets.push({ table, row });
    }
    return result;
  }

  private paint(result: Measurements): void {
    if (this.disposed || result.generation !== this.generation || !this.rows) return;
    this.clear();
    for (const { table, row } of result.targets) {
      for (const change of tablePresentation(row, 'b')) {
        const tr = table.rows[change.index];
        if (!tr) continue;
        paintTableRow(tr, change, 'b');
        this.marked.add(tr);
      }
    }
    this.view.dom.setAttribute('data-lgd-table-mapped', String(result.targets.length));
    this.view.dom.setAttribute('data-lgd-table-failed', String(result.failed));
    this.view.dom.setAttribute('data-lgd-table-revision', String(this.revision));
    this.setIssue(result.failed ? 'Unable to highlight some table changes.' : null);
  }

  private setIssue(message: string | null): void {
    if (message === this.issue) return;
    this.issue = message; this.report?.(message);
  }

  private clear(): void {
    for (const tr of this.marked) {
      tr.classList.remove('lgd-rowchanged');
      for (const cell of Array.from(tr.cells)) clearTableCell(cell);
    }
    this.marked.clear();
  }

  destroy(): void {
    this.disposed = true; this.generation++;
    this.observer?.disconnect(); this.observer = null;
    if (this.frame !== null) this.view.dom.ownerDocument.defaultView!.cancelAnimationFrame(this.frame);
    this.frame = null; this.rows = null; this.clear(); this.setIssue(null);
    this.view.dom.removeAttribute('data-lgd-table-mapped');
    this.view.dom.removeAttribute('data-lgd-table-failed');
    this.view.dom.removeAttribute('data-lgd-table-revision');
  }
}
