import test from 'node:test';
import assert from 'node:assert/strict';
import { blocks, pair } from '../src/diff/mddiff.ts';
import { reviewRegions, tablePresentation } from '../src/editorPresentation.ts';
import { tableAtRange } from '../src/nativeTablePresentation.ts';

const before = '# Table\n\n| ID | Value |\n| --- | --- |\n| V14 | Existing |';
const after = '# Table\n\n| ID  | Value    |\n| --- | -------- |\n| V14 | Existing |\n| V15 | Added    |';
test('added table row has a source range and current-side presentation; unchanged header is excluded', () => {
  const rows = pair(blocks(before), blocks(after)), row = rows.find(r => r.b?.type === 'table')!;
  assert.deepEqual(tablePresentation(row, 'a'), []);
  assert.deepEqual(tablePresentation(row, 'b'), [{ index: 2, kind: 'ins', columns: [0, 1] }]);
  const source = row.b!.tableRows![2];
  assert.equal(after.slice(source.sourceStart, source.sourceEnd), '| V15 | Added    |');
  const regions = reviewRegions(rows);
  assert.equal(regions.length, 1); assert.equal(regions[0].gutter, false);
  assert.equal(regions[0].block.lineStart, 5); assert.equal(regions[0].row.kind, 'ins');
});
test('table padding alone has no visual changes; removing V15 paints only the reference', () => {
  assert.ok(pair(blocks(before), blocks(after.split('\n').slice(0,-1).join('\n'))).every(r=>r.kind==='same'));
  const row = pair(blocks(after), blocks(before)).find(r=>r.a?.type==='table')!;
  assert.deepEqual(tablePresentation(row,'b'),[]);
  assert.deepEqual(tablePresentation(row,'a'),[{index:2,kind:'del',columns:[0,1]}]);
});
test('cell content and link target changes paint their rows even without removed visible words',()=>{
  const a='| Name | Value |\n| --- | --- |\n| Keep | Stable |\n| Target | [same](old) |';
  const b=a.replace('(old)','(new)'); const row=pair(blocks(a),blocks(b))[0];
  assert.equal(row.kind,'mod');
  for(const side of ['a','b'] as const) assert.deepEqual(tablePresentation(row,side),[{index:2,kind:'mod',columns:[1]}]);
});
test('table alignment changes remain visible and header cannot match a body row',()=>{
  const a='| A | B |\n| --- | --- |\n| A | B |';
  const row=pair(blocks(a),blocks(a.replace('| --- | --- |','| ---: | --- |')))[0];
  assert.equal(row.kind,'mod');assert.deepEqual(tablePresentation(row,'b').map(r=>r.index),[0,1]);
});
test('repeated tables map by source position, never by shared text',()=>{
  const source=after+'\n\n'+after;
  const rows=pair(blocks(before+'\n\n'+before),blocks(source));
  const tables=rows.filter(r=>r.b?.type==='table');assert.equal(tables.length,2);
  for(const row of tables){assert.equal(tableAtRange(rows,row.b!.sourceStart,row.b!.sourceStart),row);assert.equal(tableAtRange(rows,row.b!.sourceStart,row.b!.sourceEnd),row);}
  assert.equal(tableAtRange(rows,0,source.length),null);
});
test('simplified table refinement still paints changed rows',()=>{
  const row=pair(blocks(before),blocks(after))[1]; row.simplified=true;
  assert.deepEqual(tablePresentation(row,'b').map(r=>r.index),[2]);
  row.tableRows=undefined;row.cells=undefined;
  assert.equal(tablePresentation(row,'b').length,3);
});
