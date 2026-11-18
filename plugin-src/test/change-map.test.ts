import test from 'node:test';
import assert from 'node:assert/strict';
import { blocks, pair } from '../src/diff/mddiff.ts';
import { changeMarkers } from '../src/changeMapModel.ts';
import type { Row } from '../src/session.ts';

const compare = (a: string, b: string): Row[] => pair(blocks(a), blocks(b)).map((row, idx) => ({ ...row, idx, paired: !!row.a && !!row.b }));

test('the overview includes every changed row on both sides, including missing blocks', () => {
  const rows = compare('Keep this.\n\nOld paragraph about the contract.\n\nOnly in the old version.',
    'Only in the new version.\n\nKeep this.\n\nNew paragraph about the contract.');
  assert.ok(rows.some(row => row.kind === 'ins'));
  assert.ok(rows.some(row => row.kind === 'del'));
  assert.ok(rows.some(row => row.kind === 'mod'));
  for (const side of ['a', 'b'] as const) {
    const markers = changeMarkers(rows, side);
    assert.deepEqual(markers.map(marker => marker.row), rows.filter(row => row.kind !== 'same').map(row => row.idx));
    for (const marker of markers) {
      const block = rows[marker.row][side];
      assert.equal(marker.missing, !block);
      if (block) assert.deepEqual([marker.lineStart, marker.lineEnd], [block.lineStart, block.lineEnd]);
      assert.ok(marker.lineStart >= 0);
      assert.ok(marker.lineEnd >= marker.lineStart);
    }
  }
});

test('added and removed blocks have navigation points at the beginning, middle and end', () => {
  const rows = compare('Deleted first.\n\nAnchor one.\n\nDeleted middle.\n\nAnchor two.\n\nDeleted last.',
    'Anchor one.\n\nAnchor two.');
  const markers = changeMarkers(rows, 'b');
  assert.deepEqual(markers.map(marker => [marker.kind, marker.lineStart, marker.missing]), [
    ['del', 0, true], ['del', 2, true], ['del', 3, true],
  ]);
  const reversed = compare('Anchor one.\n\nAnchor two.',
    'Inserted first.\n\nAnchor one.\n\nInserted middle.\n\nAnchor two.\n\nInserted last.');
  assert.deepEqual(changeMarkers(reversed, 'a').map(marker => [marker.kind, marker.lineStart, marker.missing]), [
    ['ins', 0, true], ['ins', 2, true], ['ins', 3, true],
  ]);
});

test('empty and unchanged versions produce valid overview markers', () => {
  assert.deepEqual(changeMarkers(compare('Same.', 'Same.'), 'a'), []);
  assert.deepEqual(changeMarkers(compare('', ''), 'b'), []);
  for (const [a, b, side] of [['', 'Added.', 'a'], ['Removed.', '', 'b']] as const) {
    const markers = changeMarkers(compare(a, b), side);
    assert.equal(markers.length, 1);
    assert.deepEqual([markers[0].lineStart, markers[0].lineEnd, markers[0].missing], [0, 0, true]);
  }
});
