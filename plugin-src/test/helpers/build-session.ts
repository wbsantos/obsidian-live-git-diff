import { blocks, pair } from '../../src/diff/mddiff.ts';
import type { Block } from '../../src/diff/mddiff.ts';
import { sessionFromRows } from '../../src/session.ts';
import type { Session, Row, BasePin } from '../../src/session.ts';
export function buildSession(
  file: { path: string; name: string },
  baseText: string,
  ctx: { root: string; rel: string },
  pin: BasePin,
  currentText: string
): Session {
  const headBlocks: Block[] = blocks(baseText);
  const curBlocks: Block[] = blocks(currentText);
  const rows = pair(headBlocks, curBlocks) as Row[];

  return sessionFromRows(file, baseText, ctx, pin, currentText, rows);
}


