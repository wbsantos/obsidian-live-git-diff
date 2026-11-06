import type { Block, PairRow } from './diff/mddiff.ts';

export interface ReviewRegion { block: Block; row: PairRow; gutterOnly: boolean }

/** Shared list refinement drives the native editor as well as both reading panes. */
export function reviewRegions(rows: PairRow[]): ReviewRegion[] {
  return rows.flatMap(row => {
    if (!row.b || row.kind === 'same') return [];
    if (row.items && !row.simplified && !row.listStructureChanged) return reviewRegions(row.items);
    const block = row.b;
    return [{ block, row, gutterOnly: block.type === 'table' || !!block.conservative || /!\[\[|!\[/.test(block.text) }];
  });
}
