import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workerViolations } from '../tools/worker-security.mjs';
test('worker is audited before embedding and has no network, DOM, dynamic code or Node imports', () => {
  const source = fs.readFileSync(new URL('../../worker-audit.js', import.meta.url), 'utf8');
  assert.deepEqual(workerViolations(source), []);
  for (const extra of ['fetch("remote")', 'new WebSocket("remote")', 'eval("x")', 'new Function("x")', 'require("fs")', 'document.body', 'importScripts("x")']) {
    assert.ok(workerViolations(source + '\n' + extra).length > 0, extra);
  }
});
test('editor dispatch sites contain presentation effects only', () => {
  const source = fs.readFileSync(new URL('../src/editor.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /editor\.cm|\.cm\b|\.prototype\s*=/);
  const calls = [...source.matchAll(/view\.dispatch\(\{([^\n]+)/g)];
  assert.equal(calls.length, 2);
  for (const call of calls) { assert.match(call[1], /effects:/); assert.doesNotMatch(call[1], /changes:|selection:|annotations:/); }
});
