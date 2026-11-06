import type { Row } from './session.ts';
/** Source positions include blank lines between blocks; interpolate those gaps too. */
export function noteScrollTarget(rows: Row[], line: number, resolve: (row: Row, fraction: number) => number | null): number | null {
  if (!Number.isFinite(line)) return null;
  let previous: Row | null = null;
  for (const row of rows) {
    const block = row.b;
    if (!block) continue;
    if (line < block.lineStart) {
      const lo = previous ? resolve(previous, 1) : 0, hi = resolve(row, 0);
      if (lo === null || hi === null) return null;
      const start = previous?.b ? previous.b.lineEnd + 1 : 0;
      const fraction = Math.max(0, Math.min(1, (line - start) / Math.max(1, block.lineStart - start)));
      return lo + (hi - lo) * fraction;
    }
    if (line <= block.lineEnd + 1) return resolve(row, (line - block.lineStart) / (block.lineEnd - block.lineStart + 1));
    previous = row;
  }
  return previous ? resolve(previous, 1) : null;
}
