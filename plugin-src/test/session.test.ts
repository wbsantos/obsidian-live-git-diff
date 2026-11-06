/**
 * session.test.ts — the review session, and the architectural invariant underneath it.
 *
 * THE INVARIANT THIS FILE EXISTS FOR: whichever base version is chosen, the NOTE side of
 * the diff is always the real file's text, verbatim.
 *
 * That is not a stylistic preference — it is the property the entire design is built to
 * protect. The right-hand pane must be the actual file in an actual markdown leaf,
 * because that is the only way annotation and text-to-speech plugins stay attached: they
 * key off a real sourcePath. The moment the note pane becomes a synthetic document
 * (which is what diffing two arbitrary commits against *each other* would require), they
 * all detach and the plugin loses its reason to exist.
 *
 * Making the base ref selectable is therefore safe precisely BECAUSE it only ever moves
 * one side. These tests pin that: the base can be anything; the note side does not move.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { blocks } from '../src/diff/mddiff.ts';
import { errorSession } from '../src/session.ts';
import { buildSession } from './helpers/build-session.ts';
import type { BasePin, Row } from '../src/session.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => fs.readFileSync(path.join(HERE, 'fixtures', f), 'utf8');

const FILE = { path: 'notes/doc.md', name: 'doc.md' };
const CTX = { root: '/repo', rel: 'notes/doc.md' };

const pin = (sha: string, label: string): BasePin => ({
  sha,
  label,
  commit: {
    shortSha: sha.slice(0, 7),
    sha,
    relative: '7 hours ago',
    date: 'Jul 15, 4:11 PM',
    subject: 'apply review round 1',
    path: 'notes/doc.md',
  },
  readAs: null,
});

const CURRENT = read('corpus-head.md');
const BASE = read('corpus-base.md');

/* ------------------------------------------------------------------ *
 * THE ARCHITECTURAL INVARIANT                                         *
 * ------------------------------------------------------------------ */

test('the NOTE side is exactly the real file, block for block', () => {
  const s = buildSession(FILE, BASE, CTX, pin('a'.repeat(40), 'HEAD'), CURRENT);
  const realBlocks = blocks(CURRENT);
  assert.deepEqual(
    s.noteRows.map((r) => r.b!.text),
    realBlocks.map((b) => b.text),
    'every block of the real file appears on the note side, in order, unmodified'
  );
  assert.deepEqual(
    s.noteRows.map((r) => [r.b!.lineStart, r.b!.lineEnd]),
    realBlocks.map((b) => [b.lineStart, b.lineEnd]),
    'and its line ranges are the REAL file\'s lines — what the note pane will be decorated by'
  );
});

test('the note side does NOT move when the base changes', () => {
  // The whole point of making the base ref selectable. Three different bases, same file.
  const bases = [
    BASE,
    '# Field Guide to Kitchen Fermentation\n\nA completely different earlier draft.\n',
    '',
  ];
  const expected = blocks(CURRENT).map((b) => b.text);

  for (const [i, baseText] of bases.entries()) {
    const s = buildSession(FILE, baseText, CTX, pin(String(i).repeat(40), `base-${i}`), CURRENT);
    assert.deepEqual(
      s.noteRows.map((r) => r.b!.text),
      expected,
      `base #${i} changed the note side — the real-file invariant is broken`
    );
  }
});

test('an empty base makes every note block an insertion — and still the real file', () => {
  // The degenerate base (a commit from before the file had content). Even here the note
  // side must be the file, not a reconstruction.
  const s = buildSession(FILE, '', CTX, pin('b'.repeat(40), 'empty'), CURRENT);
  assert.ok(s.rows.every((r) => r.kind === 'ins'), 'all insertions');
  assert.deepEqual(s.noteRows.map((r) => r.b!.text), blocks(CURRENT).map((b) => b.text));
});

test('an empty note yields deletions only, and does not throw', () => {
  const s = buildSession(FILE, BASE, CTX, pin('c'.repeat(40), 'HEAD'), '');
  assert.ok(s.rows.length > 0);
  assert.ok(s.rows.every((r) => r.kind === 'del'));
  assert.deepEqual(s.noteRows, [], 'no note rows at all — nothing to align, correctly');
});

test('curMap describes the REAL file\'s lines (what the note pane is keyed on)', () => {
  const s = buildSession(FILE, BASE, CTX, pin('d'.repeat(40), 'HEAD'), CURRENT);
  const realBlocks = blocks(CURRENT);
  assert.equal(s.curMap.length, realBlocks.length);
  assert.deepEqual(s.curMap.map((m) => m.lineStart), realBlocks.map((b) => b.lineStart));
  assert.equal(s.curLastLine, realBlocks[realBlocks.length - 1].lineEnd);
});

/* ------------------------------------------------------------------ *
 * the pin                                                             *
 * ------------------------------------------------------------------ */

test('the session carries the pin: sha, label, and the commit for the header', () => {
  const sha = 'e'.repeat(40);
  const s = buildSession(FILE, BASE, CTX, pin(sha, 'HEAD~3'), CURRENT);
  assert.equal(s.sha, sha, 'the FULL sha is pinned — an abbreviation can become ambiguous');
  assert.equal(s.shortSha, sha.slice(0, 7));
  assert.equal(s.baseRefLabel, 'HEAD~3');
  assert.equal(s.baseCommit!.subject, 'apply review round 1', 'the header can name the version');
  assert.equal(s.baseCommit!.relative, '7 hours ago');
  assert.equal(s.baseReadAs, null);
});

test('a renamed base records the path it was read under', () => {
  const p = { ...pin('f'.repeat(40), 'HEAD~9'), readAs: 'docs/old-name.md' };
  const s = buildSession(FILE, BASE, CTX, p, CURRENT);
  assert.equal(s.baseReadAs, 'docs/old-name.md', 'so the header can say "was docs/old-name.md"');
});

test('errorSession is a REAL session carrying the message, never null', () => {
  // An empty base pane must never be the only signal: "no base" and "the whole file is
  // new" look identical on screen, and the second reading is wrong-but-plausible.
  const s = errorSession(FILE, 'This file did not exist at abc1234.');
  assert.equal(s.error, 'This file did not exist at abc1234.');
  assert.equal(s.filePath, FILE.path);
  assert.deepEqual(s.rows, []);
  assert.equal(s.baseCommit, null);
  assert.equal(s.counts.changed, 0);
});

/* ------------------------------------------------------------------ *
 * the per-pane anchor index — what scroll sync resolves against       *
 * ------------------------------------------------------------------ */

const idx = buildSession(FILE, BASE, CTX, pin('9'.repeat(40), 'HEAD'), CURRENT);

test('rows are indexed, and paired means present in BOTH panes', () => {
  idx.rows.forEach((r, i) => assert.equal(r.idx, i, 'idx is the row\'s position'));
  for (const r of idx.rows) {
    assert.equal(r.paired, !!(r.a && r.b));
    if (r.kind === 'same' || r.kind === 'mod') assert.ok(r.paired, `${r.kind} is paired`);
    if (r.kind === 'ins' || r.kind === 'del') assert.ok(!r.paired, `${r.kind} is unpaired`);
  }
});

test('each pane indexes only the rows that EXIST in it', () => {
  // A 'del' row does not exist in the note pane; an 'ins' row does not exist in the base
  // pane. Positions are per-pane document order, which is what the anchor math assumes.
  assert.deepEqual(idx.noteRows, idx.rows.filter((r) => r.b));
  assert.deepEqual(idx.baseRows, idx.rows.filter((r) => r.a));
  idx.noteRows.forEach((r, i) => assert.equal(r.pn!.pos, i));
  idx.baseRows.forEach((r, i) => assert.equal(r.pb!.pos, i));
  assert.ok(idx.rows.filter((r) => r.kind === 'del').every((r) => r.pn === undefined),
    'a deleted row has no note-pane index');
  assert.ok(idx.rows.filter((r) => r.kind === 'ins').every((r) => r.pb === undefined),
    'an inserted row has no base-pane index');
});

test('prev/next point at the nearest PAIRED rows — the interpolation anchors', () => {
  for (const r of idx.noteRows) {
    const prev = r.pn!.prev;
    const next = r.pn!.next;
    if (prev) {
      assert.ok(prev.paired, 'prev is an anchor');
      assert.ok(prev.pn!.pos < r.pn!.pos, 'and it is before us');
    }
    if (next) {
      assert.ok(next.paired, 'next is an anchor');
      assert.ok(next.pn!.pos > r.pn!.pos, 'and it is after us');
    }
  }
});

test('run position is set for UNPAIRED rows only, and counts the run correctly', () => {
  // sync.ts guards against these being undefined, because a paired row reaching the
  // interpolation path computed (undefined + frac) / undefined = NaN, and
  // `scrollTop = NaN` silently snaps the pane to the top.
  for (const r of idx.noteRows) {
    if (r.paired) {
      assert.equal(r.pn!.runIdx, undefined, 'a paired row is never interpolated');
      assert.equal(r.pn!.runLen, undefined);
    } else {
      assert.ok(typeof r.pn!.runIdx === 'number', 'an unpaired row knows its place in its run');
      assert.ok(r.pn!.runLen! > 0);
      assert.ok(r.pn!.runIdx! < r.pn!.runLen!, 'runIdx is within runLen');
    }
  }
});

test('a run of consecutive unpaired rows is numbered 0..n-1 with a constant length', () => {
  const runs: Row[][] = [];
  let cur: Row[] = [];
  for (const r of idx.noteRows) {
    if (r.paired) { if (cur.length) runs.push(cur); cur = []; }
    else cur.push(r);
  }
  if (cur.length) runs.push(cur);
  assert.ok(runs.length > 0, 'the corpus has at least one insertion run');
  for (const run of runs) {
    assert.deepEqual(run.map((r) => r.pn!.runIdx), run.map((_, i) => i));
    assert.ok(run.every((r) => r.pn!.runLen === run.length));
  }
});

test('counts agree with the rows', () => {
  assert.equal(idx.counts.blocks, blocks(BASE).length);
  assert.equal(idx.counts.curBlocks, blocks(CURRENT).length);
  assert.equal(idx.counts.changed, idx.rows.filter((r) => r.kind !== 'same').length);
});

