import type { Block, PairKind, PairRow } from './diff/mddiff.ts';

export interface ReviewRegion { block: Block; row: PairRow; gutterOnly: boolean; gutter?: boolean }

export interface TableRowPresentation {
  index: number;
  kind: Exclude<PairKind, 'same'>;
  columns: number[];
}

/** A row can change without removed words (a link destination or an inserted cell).
 * Painting is driven by semantic row states, never by the presence of word spans. */
export function tablePresentation(row: PairRow, side: 'a' | 'b'): TableRowPresentation[] {
  const block = row[side];
  if (row.kind === 'same' || !block?.cells) return [];
  const indexOf = (r: { rowA: number; rowB: number }): number => side === 'a' ? r.rowA : r.rowB;
  if (row.kind === 'mod' && row.tableRows && !block.conservative) {
    return row.tableRows.flatMap(change => {
      const index = indexOf(change);
      if (change.kind === 'same' || index < 0) return [];
      const columns = change.kind === 'mod'
        ? (row.cells || []).filter(cell => indexOf(cell) === index).map(cell => cell.column)
        : (block.cells![index] || []).map((_, column) => column);
      return [{ index, kind: change.kind, columns }];
    });
  }
  // Compatibility with cached/test rows produced before explicit row states.
  if (row.kind === 'mod' && row.cells && !row.simplified && !block.conservative) {
    const indexes = [...new Set(row.cells.map(indexOf).filter(index => index >= 0))];
    return indexes.map(index => ({ index, kind: 'mod', columns: row.cells!.filter(cell => indexOf(cell) === index).map(cell => cell.column) }));
  }
  return block.cells.map((cells, index) => ({ index, kind: row.kind as Exclude<PairKind, 'same'>, columns: cells.map((_, column) => column) }));
}

/** Shared list refinement drives the native editor as well as both reading panes. */
export function reviewRegions(rows: PairRow[]): ReviewRegion[] {
  return rows.flatMap(row => {
    if (!row.b || row.kind === 'same') return [];
    if (row.items && !row.simplified && !row.listStructureChanged) return reviewRegions(row.items);
    const block = row.b;
    if (block.type === 'table' && block.tableRows?.length) {
      return tablePresentation(row, 'b').flatMap(change => {
        const source = block.tableRows![change.index];
        if (!source) return [];
        const part: Block = { ...block, ...source, text: block.text.slice(source.sourceStart - block.sourceStart, source.sourceEnd - block.sourceStart),
          cells: undefined, tableRows: undefined };
        // A gutter cannot express a row inside a native table widget: Obsidian
        // places it next to the header. The native DOM adapter paints true cells;
        // line decorations cover source mode without that misleading marker.
        return [{ block: part, row: { ...row, kind: change.kind, sourceDetail: undefined }, gutterOnly: false, gutter: false }];
      });
    }
    return [{ block, row, gutterOnly: !!block.conservative || /!\[\[|!\[/.test(block.text), gutter: block.type !== 'table' }];
  });
}
