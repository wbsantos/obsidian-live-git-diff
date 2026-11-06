/**
 * grain-oracle.test.ts — does our block splitter agree with OBSIDIAN's sectioning?
 *
 * WHY THIS TEST IS DIFFERENT FROM THE REST
 * ----------------------------------------
 * Every other test here checks our code against our intent. This one checks our code
 * against an EXTERNAL ground truth we do not control and cannot read the source of.
 *
 * The reason it matters: scroll sync only holds if a base-pane block and its note-pane
 * counterpart have the same height. Obsidian renders the note pane, so ITS idea of where
 * one block ends and the next begins is the only one that counts. When our splitter
 * merges two things Obsidian sections separately, the base pane has one element where
 * the note has two, the pair measures differently, and everything below it drifts.
 * That is not hypothetical — it is the bug this oracle was built after:
 *
 *     Obsidian: 308 sections     Our splitter: 270 blocks     (a real 767-line doc)
 *
 * All 38 of the gap were one pattern: a paragraph immediately followed by a list.
 * One rule closed it, and mid-document drift went from 40px to 0px.
 *
 * HOW THE ORACLE IS OBTAINED
 * --------------------------
 * `metadataCache.getFileCache(file).sections` from a RUNNING Obsidian, captured by
 * tools/capture-sections.mjs over the remote debugging port and committed as
 * test/fixtures/obsidian-sections.json.
 *
 * We deliberately do NOT reimplement Obsidian's sectioner to compare against. That would
 * only prove our splitter agrees with our own second guess — a fake oracle, which is
 * worse than no oracle because it reports green.
 *
 * WHEN THE FIXTURE IS ABSENT
 * --------------------------
 * The test SKIPS, loudly, naming the command that produces it — and it FAILS instead of
 * skipping when LGD_REQUIRE_ORACLE=1, which .github/workflows/ci.yml sets. So the gap can
 * never quietly become permanent in the one place that runs on every push, but the
 * decision to demand it lives in a file a human reads, rather than being implied by a
 * CI=true that some unrelated environment might also set.
 *
 * A skipped test that prints why is honest; a test that invents an oracle to stay green
 * is the vacuous pass this whole codebase is allergic to.
 *
 * NOTE: once the fixture is committed, this test needs NO Obsidian — it is a pure
 * comparison against captured data, so CI runs it for real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { blocks } from '../src/diff/mddiff.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(HERE, 'fixtures', 'corpus-head.md');
const ORACLE = path.join(HERE, 'fixtures', 'obsidian-sections.json');

interface OracleSection {
  type: string;
  startLine: number;
  endLine: number;
}
interface Oracle {
  obsidianApiVersion: string | null;
  sourceSha256: string;
  sectionCount: number;
  sections: OracleSection[];
}

const CAPTURE_HINT =
  'Capture it with:\n' +
  '    1. relaunch Obsidian:  open -a Obsidian --args --remote-debugging-port=9222\n' +
  '    2. cp test/fixtures/corpus-head.md /path/to/AnyVault/\n' +
  '    3. open that note, then: npm run capture-oracle -- --window "AnyVault" --file "corpus-head.md"\n' +
  '  See tools/capture-sections.mjs for the full rationale.';

const required = process.env.LGD_REQUIRE_ORACLE === '1';
const present = fs.existsSync(ORACLE);

test('extended Obsidian oracle: headings, continued lists, properties, fences and references', () => {
  const text = fs.readFileSync(path.join(HERE, 'fixtures', 'extended-structure.md'), 'utf8');
  const oracle: Oracle = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'obsidian-extended-sections.json'), 'utf8'));
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'), oracle.sourceSha256);
  assert.deepEqual(blocks(text).map(b => [b.lineStart, b.lineEnd]), oracle.sections.map(s => [s.startLine, s.endLine]));
});

test('grain oracle: our block boundaries match Obsidian\'s sections', { skip: !present && !required }, () => {
  if (!present) {
    // Only reachable when `required` — otherwise the skip above short-circuits.
    assert.fail(
      `The grain oracle fixture is missing: ${path.relative(process.cwd(), ORACLE)}\n` +
      `  LGD_REQUIRE_ORACLE=1 is set, so a missing oracle is a failure, not a skip —\n` +
      `  the whole point is that it cannot quietly go unverified.\n  ${CAPTURE_HINT}`
    );
  }

  const oracle: Oracle = JSON.parse(fs.readFileSync(ORACLE, 'utf8'));
  const text = fs.readFileSync(CORPUS, 'utf8');

  // ANTI-STALENESS. An oracle captured from different bytes describes a different
  // document, and comparing against it is worse than not comparing at all.
  const sha = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  assert.equal(
    sha,
    oracle.sourceSha256,
    'The oracle was captured from a DIFFERENT version of corpus-head.md — it is stale.\n' +
    `  oracle sha256: ${oracle.sourceSha256}\n  corpus sha256: ${sha}\n  Re-capture it.\n  ${CAPTURE_HINT}`
  );

  const ours = blocks(text);

  // Compare START LINES. A start line is where a block boundary IS, so a disagreement
  // means exactly one of two things — we merged what Obsidian split, or we split what
  // Obsidian merged — and the two lists below name which.
  const oursStarts = new Set(ours.map((b) => b.lineStart));
  const theirsStarts = new Set(oracle.sections.map((s) => s.startLine));

  const weMerged = [...theirsStarts].filter((l) => !oursStarts.has(l)).sort((a, b) => a - b);
  const weSplit = [...oursStarts].filter((l) => !theirsStarts.has(l)).sort((a, b) => a - b);

  const lines = text.split('\n');
  const show = (nums: number[]): string =>
    nums.map((n) => `      line ${n}: ${JSON.stringify((lines[n] || '').slice(0, 64))}`).join('\n');

  const detail =
    `\n  Obsidian sections: ${oracle.sections.length}   our blocks: ${ours.length}` +
    (weMerged.length
      ? `\n\n  MERGED — Obsidian starts a section here and we do not (we glued two blocks\n` +
        `  together; the base pane will render one element where the note renders two,\n` +
        `  and everything below this point drifts):\n${show(weMerged)}`
      : '') +
    (weSplit.length
      ? `\n\n  SPLIT — we start a block here and Obsidian does not (we cut one of its\n` +
        `  sections in half; the note pane has no counterpart for one of our blocks):\n${show(weSplit)}`
      : '') +
    `\n\n  Captured from Obsidian API version ${oracle.obsidianApiVersion}.` +
    `\n  If Obsidian changed its sectioning, re-capture the oracle and adjust mddiff.blocks().\n`;

  assert.deepEqual({ merged: weMerged, split: weSplit }, { merged: [], split: [] }, detail);
});

test('grain oracle: fixture integrity (shape, not content)', { skip: !present }, () => {
  // Runs whenever the fixture exists. Catches a hand-edited or truncated oracle — which
  // would otherwise be indistinguishable from a real disagreement and send someone
  // hunting a splitter bug that isn't there.
  const oracle: Oracle = JSON.parse(fs.readFileSync(ORACLE, 'utf8'));
  assert.ok(Array.isArray(oracle.sections), 'sections is an array');
  assert.ok(oracle.sections.length > 0, 'the oracle is not empty');
  assert.equal(oracle.sectionCount, oracle.sections.length, 'the declared count matches');
  assert.match(oracle.sourceSha256, /^[0-9a-f]{64}$/, 'sourceSha256 is a sha256');
  for (const s of oracle.sections) {
    assert.equal(typeof s.type, 'string');
    assert.ok(Number.isInteger(s.startLine) && s.startLine >= 0, 'startLine is a line number');
    assert.ok(s.endLine >= s.startLine, 'endLine is not before startLine');
  }
  const starts = oracle.sections.map((s) => s.startLine);
  assert.deepEqual([...starts].sort((a, b) => a - b), starts, 'sections are in document order');
});

/**
 * The property the oracle exists to protect, asserted WITHOUT the oracle.
 *
 * This is not a substitute for the oracle and does not pretend to be: it cannot discover
 * a NEW grain disagreement, because it only knows the one we already found. What it does
 * is make the specific 38-block regression impossible to reintroduce on a machine that
 * has never run Obsidian — which is every CI runner.
 */
test('grain rule: the paragraph->list split survives on the real corpus', () => {
  const text = fs.readFileSync(CORPUS, 'utf8');
  const ours = blocks(text);
  const merged = ours.filter((b) => {
    const ls = b.text.split('\n');
    // A block that contains a list-item line preceded by a NON-list line is a block we
    // glued together across the boundary Obsidian sections at.
    return ls.some((l, i) => i > 0 && /^\s*(?:[-*+]|\d+[.)])\s/.test(l) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(ls[i - 1]));
  });
  assert.deepEqual(
    merged.map((b) => `line ${b.lineStart}: ${b.text.slice(0, 48)}`),
    [],
    'no block glues a paragraph to the list that follows it'
  );
});
