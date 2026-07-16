/**
 * table-marks.test.ts — char marks must never land as a child of table structure.
 *
 * Anchored to a real defect (2026-07-16). A `<tr>` is display:table-row, and CSS wraps any
 * non-cell child of a table row in an ANONYMOUS TABLE CELL. wrapRanges inserts its span
 * into the text node's own parent, so wrapping the whitespace between two `<td>`s created
 * a phantom COLUMN and shoved that row's real cells sideways. Observed on a 5-row table:
 * rows 0-2 were `th,th,th` / `td,td,td` while the two CHANGED rows read
 * `td,span,td,span,td,span`. Only changed rows carry marks, so the table came apart along
 * exactly the rows the diff touched.
 *
 * The textContent invariant cannot catch it — re-parenting whitespace leaves textContent
 * byte-identical, so the assertion passed while the table was visibly wrecked. Placement
 * bug, not a text bug.
 *
 * This imports the REAL predicate rather than re-declaring it: deleting the function body
 * must fail this file. (A sibling test in this suite was caught asserting a re-declared
 * equation against itself, which no implementation change could ever break.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isTableStructureWhitespace } from '../src/charmarks.ts';

/** The only surface the predicate touches: a text node's immediate parent's tagName. */
const textNodeIn = (tagName: string | null) =>
  ({ parentElement: tagName === null ? null : { tagName } }) as unknown as Text;

test('whitespace directly inside table structure is skipped — it would become a phantom cell', () => {
  for (const tag of ['TR', 'TABLE', 'THEAD', 'TBODY', 'TFOOT']) {
    assert.equal(isTableStructureWhitespace(textNodeIn(tag)), true,
      `text directly under <${tag.toLowerCase()}> has nowhere legal to be wrapped`);
  }
});

test('real cell content stays markable — the whole point of checking the IMMEDIATE parent', () => {
  // A <td>'s text is content, and a span inside a cell is an ordinary inline. If this
  // returned true, tables would lose word-level marks entirely — fixing the layout by
  // deleting the feature.
  for (const tag of ['TD', 'TH']) {
    assert.equal(isTableStructureWhitespace(textNodeIn(tag)), false);
  }
});

test('ordinary prose parents are unaffected', () => {
  for (const tag of ['P', 'LI', 'STRONG', 'EM', 'A', 'H2', 'BLOCKQUOTE', 'SPAN']) {
    assert.equal(isTableStructureWhitespace(textNodeIn(tag)), false);
  }
});

test('a detached text node has no parent and is not table structure', () => {
  assert.equal(isTableStructureWhitespace(textNodeIn(null)), false);
});
