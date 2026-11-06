import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRequest } from '../src/diff/worker.ts';
test('historical comparison returns each document reference context independently',()=>{
  const result=compareRequest({identity:{epoch:1,filePath:'test.md',sha:'a..b',revision:0},
    baseText:'[label][id]\n\n[id]: /old',currentText:'[label][id]\n\n[id]: /new',options:{}});
  assert.match(result.baseReferences!,/\/old/);assert.match(result.currentReferences!,/\/new/);
  assert.ok(result.rows!.some(r=>r.kind!=='same'));
});
