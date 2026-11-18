import type { Row } from './session.ts';

export interface ChangeMarker {
  row: number;
  kind: 'ins' | 'del' | 'mod';
  lineStart: number;
  lineEnd: number;
  /** An insertion/deletion also has a navigation point on the side where it is absent. */
  missing: boolean;
}

/** Include changes on both sides, even when a version is empty or a block is absent. */
export function changeMarkers(rows: readonly Row[], side: 'a' | 'b'): ChangeMarker[] {
  const nextLine = new Map<number, number>();
  let next = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const block = rows[i][side];
    if (block) next = block.lineStart;
    nextLine.set(i, next);
  }
  const markers: ChangeMarker[] = [];
  let previousEnd = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], block = row[side];
    const line = block?.lineStart ?? Math.max(previousEnd, nextLine.get(i) || 0);
    if (row.kind !== 'same') markers.push({ row: row.idx, kind: row.kind,
      lineStart: line, lineEnd: block?.lineEnd ?? line, missing: !block });
    if (block) previousEnd = block.lineEnd + 1;
  }
  return markers;
}
