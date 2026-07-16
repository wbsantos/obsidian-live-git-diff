/**
 * invariant.test.ts — does the read-only gate actually catch anything?
 *
 * A GATE NOBODY HAS SEEN FAIL IS NOT KNOWN TO WORK. This is not a rhetorical point in
 * this repo: the spike's read-only check passed for its entire life WITHOUT EVER READING
 * THE FILE, because NUL bytes in the hand-written bundle made grep treat it as binary
 * and skip it. Every run was green. Nothing was verified.
 *
 * So these tests plant real violations in a COPY of the built bundle and assert the gate
 * goes red for each one — and, just as importantly, that it stays green for a comment
 * that merely NAMES a write method, because a gate that punishes documentation ends up
 * undocumented.
 *
 * Requires the bundle to exist: run `npm run build` first. `npm run ci` does both.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GATE = path.join(ROOT, 'tools', 'check-invariant.mjs');
const BUNDLE = path.resolve(ROOT, '..', 'plugin-dist', 'main.js');

const built = fs.existsSync(BUNDLE);

interface GateResult {
  code: number;
  out: string;
}

/** Run the gate against an arbitrary bundle file. */
function runGate(bundlePath: string): GateResult {
  const r = spawnSync(process.execPath, [GATE, '--bundle', bundlePath], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: (r.stdout || '') + (r.stderr || '') };
}

/** Copy the real bundle, mutate it, run the gate on the copy, clean up. */
function withPlantedBundle(mutate: (original: Buffer) => Buffer | string, fn: (r: GateResult) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgd-gate-'));
  const copy = path.join(dir, 'main.js');
  try {
    const planted = mutate(fs.readFileSync(BUNDLE));
    fs.writeFileSync(copy, planted);
    fn(runGate(copy));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const append = (s: string) => (orig: Buffer): string => orig.toString('utf8') + '\n' + s + '\n';

test('gate: the real bundle passes', { skip: !built && 'run `npm run build` first' }, () => {
  const r = runGate(BUNDLE);
  assert.equal(r.code, 0, `the gate should pass on the shipped bundle:\n${r.out}`);
  assert.match(r.out, /RESULT: PASS/);
  assert.match(r.out, /cannot write to a note/);
});

test('gate: a missing bundle is a failure, not a pass', () => {
  const r = runGate(path.join(os.tmpdir(), 'definitely-not-a-bundle-' + Date.now() + '.js'));
  assert.equal(r.code, 1, 'absent bundle must not be silently green');
});

/* ------------------------------------------------------------------ *
 * planted violations — one per class of write                         *
 * ------------------------------------------------------------------ */

const PLANTS: Array<[string, string, RegExp]> = [
  ['vault.modify( — rewriting a note', 'async function evil(v, f) { await v.vault.modify(f, "gotcha"); }', /vault\.modify\(/],
  ['vault.create( — creating a note', 'async function evil(v) { await v.vault.create("x.md", "gotcha"); }', /vault\.create\(/],
  ['vault.delete( — deleting a note', 'async function evil(v, f) { await v.vault.delete(f); }', /vault\.delete\(/],
  ['adapter.write( — writing under the vault', 'async function evil(a) { await a.adapter.write("x.md", "gotcha"); }', /adapter\.write\(/],
  ['editor.replaceRange( — editing the open note', 'function evil(e) { e.editor.replaceRange("gotcha", 0, 1); }', /editor\.replaceRange\(/],
  ['processFrontMatter( — rewriting frontmatter', 'function evil(fm, f) { fm.processFrontMatter(f, () => {}); }', /processFrontMatter\(/],
  ['writeFileSync( — a node filesystem write', 'function evil(fs2) { fs2.writeFileSync("/tmp/x", "gotcha"); }', /writeFileSync\(/],
  ['createWriteStream( — opening a file for writing', 'function evil(fs2) { return fs2.createWriteStream("/tmp/x"); }', /createWriteStream\(/],
];

for (const [label, code, expected] of PLANTS) {
  test(`gate: catches ${label}`, { skip: !built && 'run `npm run build` first' }, () => {
    withPlantedBundle(append(code), (r) => {
      assert.equal(r.code, 1, `the gate MUST fail when the bundle contains: ${code}\n${r.out}`);
      assert.match(r.out, /RESULT: FAIL/);
      assert.match(r.out, expected, 'and it must name the pattern it found');
    });
  });
}

test('gate: catches an imported filesystem module', { skip: !built && 'run `npm run build` first' }, () => {
  // The capability check. Even with no banned method name present, importing fs is a
  // write capability and must be refused.
  withPlantedBundle(append('const sneaky = require("node:fs");'), (r) => {
    assert.equal(r.code, 1, `importing fs must fail the gate:\n${r.out}`);
    assert.match(r.out, /imports no filesystem module/);
  });
});

test('gate: catches innerHTML assignment', { skip: !built && 'run `npm run build` first' }, () => {
  withPlantedBundle(append('function evil(el) { el.innerHTML = "<b>x</b>"; }'), (r) => {
    assert.equal(r.code, 1, `innerHTML must fail the gate:\n${r.out}`);
    assert.match(r.out, /innerHTML/);
  });
});

/* ------------------------------------------------------------------ *
 * THE DEFECT THAT MOTIVATED THE WHOLE GATE                            *
 * ------------------------------------------------------------------ */

test('gate: catches a NUL byte (the exact defect that made the old check vacuous)', { skip: !built && 'run `npm run build` first' }, () => {
  // A NUL made `grep` classify the bundle as binary and silently decline to search it,
  // so every read-only assertion "passed" without reading a line. This gate reads the
  // bytes itself and refuses to proceed on a file it cannot trust as text.
  withPlantedBundle((orig) => Buffer.concat([orig, Buffer.from([0x00]), Buffer.from('\n')]), (r) => {
    assert.equal(r.code, 1, `a NUL byte must fail the gate:\n${r.out}`);
    assert.match(r.out, /NUL/);
  });
});

test('gate: catches invalid UTF-8', { skip: !built && 'run `npm run build` first' }, () => {
  withPlantedBundle((orig) => Buffer.concat([orig, Buffer.from([0xff, 0xfe, 0x0a])]), (r) => {
    assert.equal(r.code, 1, `invalid UTF-8 must fail the gate:\n${r.out}`);
    assert.match(r.out, /UTF-8|replacement/i);
  });
});

test('gate: a NUL byte fails EVEN IF nothing else is wrong', { skip: !built && 'run `npm run build` first' }, () => {
  // The precise historical failure: the file was otherwise clean, so a naive check
  // reported success. Unreadable must never mean clean.
  withPlantedBundle((orig) => Buffer.concat([Buffer.from([0x00]), orig]), (r) => {
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.out, /RESULT: PASS/, 'an unreadable bundle is never a pass');
  });
});

/* ------------------------------------------------------------------ *
 * the convention: prose is allowed, calls are not                     *
 * ------------------------------------------------------------------ */

test('gate: a COMMENT naming a write method does not fail the build', { skip: !built && 'run `npm run build` first' }, () => {
  // Load-bearing. The gate's first ever run failed on its own authors' comments, which
  // would have taught everyone to delete the explanations. Patterns match calls (name +
  // open paren); prose names methods bare. This test pins that convention so a future
  // "tightening" of the patterns has to break a test to break the docs.
  const prose = [
    '// This plugin never calls vault.modify or vault.create, and imports no fs, so',
    '// writeFileSync and appendFileSync are unreachable. See docs/ARCHITECTURE.md.',
  ].join('\n');
  withPlantedBundle(append(prose), (r) => {
    assert.equal(r.code, 0, `prose describing the invariant must not fail it:\n${r.out}`);
    assert.match(r.out, /RESULT: PASS/);
  });
});
