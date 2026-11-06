import test from 'node:test';
import assert from 'node:assert/strict';
import { blocks, pair, boundedOpcodes, textDetail, similarity } from '../src/diff/mddiff.ts';
import { RevisionGate } from '../src/session.ts';
import type { Row } from '../src/session.ts';
import { noteScrollTarget } from '../src/scrollModel.ts';
import { ComparisonWorker, type WorkerLike } from '../src/workerClient.ts';
import { compareRequest, type CompareRequest, type CompareResponse } from '../src/diff/worker.ts';

const compare = (a: string, b: string, breaks = false) => pair(blocks(a, { breaks }), blocks(b, { breaks }));
const equal = (a: string, b: string, breaks = false) => compare(a, b, breaks).every(row => row.kind === 'same');

test('scroll anchors interpolate blank lines, including leading and trailing whitespace', () => {
  const rows = pair(blocks('\n\na\n\n\n\nb'), blocks('\n\na\n\n\n\nb')).map((r, idx) => ({ ...r, idx, paired: true })) as Row[];
  const resolve = (row: Row, fraction: number) => row.idx * 200 + fraction * 100;
  assert.equal(noteScrollTarget(rows, 2.5, resolve), 50);
  assert.equal(noteScrollTarget(rows, 3, resolve), 100);
  assert.equal(noteScrollTarget(rows, 4.5, resolve), 150);
  assert.equal(noteScrollTarget(rows, 6, resolve), 200);
  assert.equal(noteScrollTarget(rows, 9, resolve), 300);
  assert.equal(noteScrollTarget([], 0, resolve), null);
});

test('insertion before two edited paragraphs produces three changes', () => {
  const a = 'Primeiro parágrafo sobre o contrato original.\n\nSegundo parágrafo sobre a entrega prevista.';
  const b = 'Aviso novo e independente.\n\nPrimeiro parágrafo sobre o contrato revisado.\n\nSegundo parágrafo sobre a entrega atualizada.';
  assert.deepEqual(compare(a, b).map(row => row.kind), ['ins', 'mod', 'mod']);
});
test('visual equivalence: markers, entities, EOLs, soft wrapping, headings, code fences', () => {
  for (const [a, b] of [ ['*texto*', '_texto_'], ['**texto**', '__texto__'], ['&amp; &#38;', '& &amp;'],
    ['one\r\ntwo', 'one two'], ['# Título #', 'Título\n======'], ['```js\nx\n```', '~~~js\nx\n~~~'],
    ['- item\n- outro', '* item\n* outro'] ]) assert.ok(equal(a, b), `${a} / ${b}`);
});
test('significant differences never become no changes', () => {
  for (const [a, b] of [ ['Texto 1', 'texto 1'], ['Texto 1', 'Texto 2'], ['texto', '*texto*'],
    ['[site](https://a.test)', '[site](https://b.test)'], ['- a\n- b', '- a\n  - b'],
    ['- [ ] tarefa', '- [x] tarefa'], ['```py\n  f()\n```', '```py\nf()\n```'],
    ['# heading', '## heading'], ['[[a|igual]]', '[[b|igual]]'], ['![[a]]', '![[b]]'],
    ['> [!note] Título\n> Texto', '> [!warning] Título\n> Texto'],
    ['---\ntag: a\n---\ntexto', '---\ntag: b\n---\ntexto'], ['a\u00a0b', 'a b'] ]) {
    assert.ok(!equal(a, b), `${a} / ${b}`);
  }
});
test('vault line-break setting controls soft breaks without hiding hard breaks', () => {
  assert.ok(equal('a\nb', 'a b'));
  assert.ok(!equal('a\nb', 'a b', true));
  assert.ok(!equal('a  \nb', 'a b'));
});
test('references resolve using definitions after the block', () => {
  const rows = compare('[mesmo][ref]\n\n[ref]: /old', '[mesmo][ref]\n\n[ref]: /new');
  assert.equal(rows[0].kind, 'mod'); assert.ok(rows[0].structural);
});
test('structural ranges: adjacent titles, continuation, nested lists, long and tilde fences', () => {
  const source = '# A\n## B\ntexto\n\n- item\n  continuação\n  - filho\n\n~~~~js\nx\n~~~\n\ny\n~~~~\n\nfim';
  const result = blocks(source);
  assert.deepEqual(result.map(b => b.type), ['heading', 'heading', 'paragraph', 'list', 'code', 'paragraph']);
  assert.ok(result[4].text.includes('\n\ny'));
  for (const block of result) assert.equal(source.slice(block.sourceStart, block.sourceEnd), block.text);
});
test('tables ignore formatting delimiters and compare cells without pipe evidence', () => {
  assert.ok(equal('| A | B |\n|---|---|\n| x | y |', 'A|B\n----|----\nx|y'));
  const rows = compare('| A | B |\n|---|---|\n| x | y |', '| A | B |\n|---|---|\n| x | z |');
  assert.equal(rows[0].kind, 'mod');
  assert.ok(rows[0].cells?.some(c => c.rowA === 1 && c.column === 1));
  assert.ok(compare('| az | bz |\n|---|---|\n| cz | dz |', '| qu | ru |\n|---|---|\n| su | tu |').every(r => r.kind !== 'mod'));
});
test('sequence similarity distinguishes reordered words and repeated content', () => {
  assert.equal(similarity('one two three', 'three two one'), 1 / 3);
  assert.equal(similarity('a a a', 'a'), 0.5);
});
test('word refinement separates Unicode words and punctuation', () => {
  const a = 'ação: café 👩‍💻, já!', b = 'ação; chá 👩‍💻, já!';
  const d = textDetail(a, b);
  assert.deepEqual(d.a.map(([s, e]) => a.slice(s, e)), [': café']);
  assert.deepEqual(d.b.map(([s, e]) => b.slice(s, e)), ['; chá']);
});
test('large token block removes common prefix/suffix before bounded refinement', () => {
  const a = Array.from({ length: 2500 }, (_, i) => `palavra${i}`).join(' ');
  const b = a.replace('palavra1250', 'alterada1250');
  const start = performance.now(), d = textDetail(a, b);
  assert.equal(d.simplified, false); assert.equal(d.a.length, 1);
  assert.ok(performance.now() - start < 1000);
});
test('exhausted budgets and >200-block gaps retain changes with explicit simplification', () => {
  const result = boundedOpcodes(['a', 'b'], ['c', 'd'], { maxEditLength: 0 });
  assert.ok(result.simplified); assert.equal(result.ops[0][0], 'replace');
  const rows = compare(Array.from({ length: 201 }, (_, i) => `antigo ${i}`).join('\n\n'), Array.from({ length: 201 }, (_, i) => `novo ${i}`).join('\n\n'));
  assert.ok(rows.some(r => r.simplified)); assert.ok(rows.every(r => r.kind !== 'same'));
});
test('random repeated blocks preserve every source block exactly once and in order', () => {
  let seed = 981;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  for (let n = 0; n < 100; n++) {
    const make = () => Array.from({ length: random() % 25 }, () => `repetido ${random() % 8}`).join('\n\n');
    const a = blocks(make()), b = blocks(make()), rows = pair(a, b);
    assert.deepEqual(rows.flatMap(r => r.a ? [r.a] : []), a);
    assert.deepEqual(rows.flatMap(r => r.b ? [r.b] : []), b);
    for (const row of rows) if (row.kind === 'same') assert.equal(row.a!.visualKey, row.b!.visualKey);
  }
});
test('revision identity rejects old edits, notes, pins and closed sessions', () => {
  const gate = new RevisionGate(), first = gate.begin('a.md', 'sha');
  const second = gate.next()!;
  assert.ok(!gate.accepts(first)); assert.ok(gate.accepts(second));
  gate.begin('b.md', 'sha'); assert.ok(!gate.accepts(second));
  const newer = gate.begin('a.md', 'other'); gate.close(); assert.ok(!gate.accepts(newer));
});
test('worker cancellation rejects superseded promises; caches historical analysis', async () => {
  const workers: Array<WorkerLike & { request?: CompareRequest; terminated: boolean }> = [];
  const client = new ComparisonWorker(() => {
    const w: WorkerLike & { request?: CompareRequest; terminated: boolean } = {
      onmessage: null, onerror: null, terminated: false,
      postMessage(r) { this.request = r; }, terminate() { this.terminated = true; },
    }; workers.push(w); return w;
  });
  const request: CompareRequest = { identity: { epoch: 1, revision: 1, filePath: 'a', sha: 'sha' }, baseText: 'one', currentText: 'two', options: {} };
  const first = client.compare(request), rejected = assert.rejects(first, { name: 'AbortError' });
  const second = client.compare({ ...request, identity: { ...request.identity, revision: 2 } });
  await rejected; assert.ok(workers[0].terminated);
  const result = compareRequest(workers[1].request!);
  workers[0].onmessage?.({ data: compareRequest(request) } as MessageEvent<CompareResponse>);
  workers[1].onmessage?.({ data: result } as MessageEvent<CompareResponse>);
  await second;
  const third = client.compare({ ...request, identity: { ...request.identity, revision: 3 } });
  assert.ok(workers[2].request?.baseBlocks); assert.equal(workers[2].request?.baseText, '');
  workers[2].onmessage?.({ data: compareRequest(workers[2].request!) } as MessageEvent<CompareResponse>);
  await third; client.dispose();
});

test('incomplete worker responses fail explicitly instead of claiming no changes', async () => {
  const worker: WorkerLike = { onmessage: null, onerror: null, postMessage() {}, terminate() {} };
  const client = new ComparisonWorker(() => worker);
  const identity = { epoch: 1, revision: 1, filePath: 'a', sha: 'sha' };
  const pending = client.compare({ identity, baseText: 'a', currentText: 'b', options: {} });
  worker.onmessage?.({ data: { identity } } as MessageEvent<CompareResponse>);
  await assert.rejects(pending, /Incomplete/);
  client.dispose();
});
