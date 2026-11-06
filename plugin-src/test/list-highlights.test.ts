import test from 'node:test';
import assert from 'node:assert/strict';
import { blocks, pair } from '../src/diff/mddiff.ts';
import { reviewRegions } from '../src/editorPresentation.ts';

const before = [
  '- Chama `GET documentos/simplificado`, por número da proposta.',
  '- Devolve por arquivo: identificador único, identificador de armazenamento, nome do arquivo, código e descrição do tipo.',
  '- Cada documento é gravado com `DCTIPO = SISTEMA_INTEGRADO`. O sistema integrado do documento é o da proposta (`TPROPOSTAINTEGRADA`), sem coluna própria.',
  '- Proposta sem documentos (HTTP 400, `SEM_DOCUMENTOS`) vira **lista vazia**, não erro.',
  '- O endpoint **não devolve conteúdo**, e o cliente nunca chama o endpoint de download.',
].join('\n');
const after = [
  '- Chama `GET documentos/completo` (endpoint **completo**, que informa o checklist), por número da proposta. Rotina de permissão: `CONSDOCANXPRP`.',
  '- O retorno é aninhado: `CheckLists[]` → `Itens[]` → `Arquivos[]`. O cliente achata uma lista com uma linha por arquivo e item.',
  '- O **item do checklist** é identificado pelo par `CodigoChecklist` + `SequencialChecklist`.',
  '- O Core associa o arquivo ao item **pelo tipo do documento**.',
  '- **Limitação aceita:** um arquivo cujo tipo não está no checklist não é devolvido nem espelhado.',
  '- Cada documento é gravado com `DCTIPO = SISTEMA_INTEGRADO`. O sistema integrado do documento é o da proposta (`TPROPOSTAINTEGRADA`), sem coluna própria.',
  '- Proposta sem arquivos no GED (HTTP 400, `SEM_DOCUMENTOS`) vira **lista vazia**, não erro. Uma resposta de sucesso sem `CheckLists` também vira lista vazia.',
  '- O espelho guarda **só o par de identificadores do item**.',
  '- O endpoint **não devolve conteúdo**, e o cliente nunca chama o endpoint de download.',
].join('\n');

test('expanded list preserves unchanged items and refines the changed endpoint', () => {
  const rows = pair(blocks(before), blocks(after));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'mod');
  const items = rows[0].items!;
  assert.deepEqual(items.filter(r => r.kind === 'same').map(r => r.b!.lineStart), [5, 8]);
  const endpoint = items.find(r => r.b?.lineStart === 0)!;
  assert.equal(endpoint.kind, 'mod');
  assert.ok(endpoint.detail!.a.some(([s, e]) => endpoint.a!.visibleText.slice(s, e).includes('simplificado')));
  assert.ok(endpoint.detail!.b.some(([s, e]) => endpoint.b!.visibleText.slice(s, e).includes('completo')));
  assert.deepEqual(items.flatMap(r => r.a ? [r.a.text] : []), before.split('\n'));
  assert.deepEqual(items.flatMap(r => r.b ? [r.b.text] : []), after.split('\n'));
});

test('editor highlights all changed list items without coloring preserved ones', () => {
  const regions = reviewRegions(pair(blocks(before), blocks(after)));
  assert.deepEqual(regions.map(r => r.block.lineStart), [0, 1, 2, 3, 4, 6, 7]);
});

test('list continuations and nested content retain exact source ranges', () => {
  const source = '- primeiro\n  continuação\n  - filho\n    outro trecho\n- segundo';
  const list = blocks(source)[0];
  assert.deepEqual(list.items!.map(item => [item.lineStart, item.lineEnd]), [[0, 3], [4, 4]]);
  for (const item of list.items!) assert.equal(source.slice(item.sourceStart, item.sourceEnd), item.text);
  const changed = source.replace('outro trecho', 'trecho alterado');
  const rows = pair(blocks(source), blocks(changed));
  assert.equal(rows[0].items![0].kind, 'mod');
  assert.equal(rows[0].items![1].kind, 'same');
  assert.equal(reviewRegions(rows)[0].block.lineEnd, 3);
});

test('list syntax equivalence remains equal; numbering and nesting changes remain visible', () => {
  assert.equal(pair(blocks('- *texto*\n- outro'), blocks('* _texto_\n* outro'))[0].kind, 'same');
  for (const [a, b] of [['1. item\n2. outro', '3. item\n4. outro'], ['- item\n- outro', '- item\n  - outro']]) {
    const rows = pair(blocks(a), blocks(b));
    assert.ok(rows.some(r => r.kind !== 'same'));
    assert.ok(reviewRegions(rows).length);
  }
});

test('deleted-only items keep an old-side signal without coloring unchanged current items', () => {
  const rows = pair(blocks('- alpha\n- beta\n- gamma'), blocks('- alpha\n- gamma'));
  assert.equal(rows[0].kind, 'mod');
  assert.equal(rows[0].items!.filter(r => r.kind === 'del')[0].a!.visibleText, 'beta');
  assert.equal(reviewRegions(rows).length, 0);
});

test('unrelated lists and repeated items never lose or duplicate content', () => {
  const a = blocks('- alpha one\n- alpha one\n- retained value\n- omega old'), b = blocks('- alpha one\n- retained value\n- retained value\n- omega new');
  const rows = pair(a, b);
  for (const row of rows) if (row.items) {
    assert.deepEqual(row.items.flatMap(r => r.a ? [r.a] : []), row.a!.items);
    assert.deepEqual(row.items.flatMap(r => r.b ? [r.b] : []), row.b!.items);
    for (const item of row.items) if (item.kind === 'same') assert.equal(item.a!.visualKey, item.b!.visualKey);
  }
  assert.ok(pair(blocks('- a apple\n- b banana'), blocks('- x xerox\n- y yellow')).every(r => r.kind !== 'same'));
});
