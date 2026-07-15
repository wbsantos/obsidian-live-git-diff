'use strict';
/**
 * test-mddiff.js — proves mddiff.js against two real versions of a real doc.
 * Run: node test-mddiff.js
 */
var cp = require('child_process');
var md = require('./mddiff');

var REPO = '/path/to/a/local/git/repo';
var PATH = 'docs/reference-corpus.md';
var REF_A = 'badc0de';
var REF_B = 'HEAD';

function show(ref) {
  return cp.execFileSync('git', ['-C', REPO, 'show', ref + ':' + PATH],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

var failures = [];
function assert(ok, msg) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + msg);
  if (!ok) failures.push(msg);
}
function prev(blk, n) {
  if (!blk) return '(none)';
  var t = blk.text.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

var srcA = show(REF_A), srcB = show(REF_B);
var t0 = Date.now();
var A = md.blocks(srcA), B = md.blocks(srcB);
var rows = md.pair(A, B);
var ms = Date.now() - t0;

console.log('=== BLOCK COUNTS ===');
console.log('A (' + REF_A + '): ' + A.length + ' blocks, ' + srcA.split('\n').length + ' source lines');
console.log('B (' + REF_B + '): ' + B.length + ' blocks, ' + srcB.split('\n').length + ' source lines');
console.log('blocks+pair took ' + ms + ' ms');

var counts = { same: 0, mod: 0, del: 0, ins: 0 };
rows.forEach(function (r) { counts[r.kind]++; });
var changed = rows.length - counts.same;
console.log('\n=== PAIR SUMMARY ===');
console.log('rows: ' + rows.length + '  same=' + counts.same + ' mod=' + counts.mod +
            ' del=' + counts.del + ' ins=' + counts.ins + '  (changed=' + changed + ')');

console.log('\n=== FIRST 12 NON-SAME ROWS ===');
rows.filter(function (r) { return r.kind !== 'same'; }).slice(0, 12).forEach(function (r, i) {
  console.log(String(i + 1).padStart(2) + ' [' + r.kind.toUpperCase().padEnd(4) + '] ' +
              'A@' + (r.a ? r.a.lineStart : '-') + ': ' + prev(r.a, 60));
  console.log('              B@' + (r.b ? r.b.lineStart : '-') + ': ' + prev(r.b, 60));
});

console.log('\n=== ASSERTIONS ===');
assert(A.length > 200 && B.length > 200, 'total blocks reasonable (>200): A=' + A.length + ' B=' + B.length);

// line ranges must be sane and monotonic
var linesA = srcA.split('\n');
var sane = A.every(function (b, i) {
  return b.lineStart >= 0 && b.lineEnd >= b.lineStart && b.lineEnd < linesA.length &&
         linesA.slice(b.lineStart, b.lineEnd + 1).join('\n') === b.text &&
         (i === 0 || b.lineStart > A[i - 1].lineEnd);
});
assert(sane, 'block line ranges round-trip to the source and are monotonic');

function findRow(kind, needle) {
  return rows.filter(function (r) {
    var side = kind === 'ins' ? r.b : r.a;
    return r.kind === kind && side && side.text.indexOf(needle) !== -1;
  });
}
assert(findRow('del', 'Fermentation field guide').length === 1,
  "known deletion #1 — 'Fermentation field guide' callout appears as 'del'");
assert(findRow('del', 'Reading lens').length === 1,
  "known deletion #2 — 'Reading lens' callout appears as 'del'");
assert(findRow('ins', 'Most guides rate a batch').length === 1,
  "'Most guides rate a batch' paragraph appears as 'ins'");

var badMods = rows.filter(function (r) {
  return r.kind === 'mod' &&
    md.similarity(md.norm(r.a.text), md.norm(r.b.text)) < md.MOD_MIN_SIMILARITY;
});
assert(badMods.length === 0, "no 'mod' row pairs blocks with similarity < 0.5 (found " + badMods.length + ')');

var lowest = rows.filter(function (r) { return r.kind === 'mod'; })
  .map(function (r) { return md.similarity(md.norm(r.a.text), md.norm(r.b.text)); })
  .sort(function (x, y) { return x - y; })[0];
console.log('  info    lowest mod similarity: ' + (lowest === undefined ? 'n/a' : lowest.toFixed(3)));

console.log('\n=== CROSS-CHECK vs PYTHON REFERENCE ===');
var pyOut = '';
try {
  pyOut = cp.execSync('python3 ' + REPO + '/scripts/render-preview.py ' + REPO +
    ' ' + REF_A + ' ' + REF_B + ' ' + PATH + ' /tmp/xcheck.html 2>&1', { encoding: 'utf8' }).trim();
} catch (e) { pyOut = 'python reference FAILED: ' + (e.stdout || e.message); }
console.log('  python: ' + pyOut);
var m = pyOut.match(/(\d+) aligned blocks, (\d+) changed/);
if (m) {
  var pyAligned = +m[1], pyChanged = +m[2];
  console.log('  js    : ' + rows.length + ' aligned blocks, ' + changed + ' changed');
  console.log('  delta : aligned ' + (rows.length - pyAligned) + ', changed ' + (changed - pyChanged));
  if (Math.abs(changed - pyChanged) > 6) {
    console.log('  !! DIVERGENCE: changed-count gap > 6 vs the Python reference — investigate.');
  } else {
    console.log('  OK: changed-count within tolerance of the Python reference.');
  }
} else {
  console.log('  !! could not parse python reference output');
}

console.log('\n' + (failures.length ? 'RESULT: FAIL (' + failures.length + ')' : 'RESULT: ALL ASSERTIONS PASS'));
process.exit(failures.length ? 1 : 0);
