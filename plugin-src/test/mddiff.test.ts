/**
 * mddiff.test.ts — the block splitter and the block pairer.
 *
 * Ported from the spike's spikes/test-mddiff.js, with one deliberate change: the spike
 * ran against two git revisions of a real 767-line document in ANOTHER repository, and
 * cross-checked against a python reference implementation. Both dependencies are gone:
 *
 *  - The corpus is now a fixture IN this repo (test/fixtures/corpus-{base,head}.md),
 *    so the tests are hermetic — no git, no sibling checkout, no network, and the
 *    expected values cannot drift when someone edits an unrelated document.
 *  - The python cross-check is gone with the python. Its job (does our JS agree with the
 *    reference?) is now done by asserting the corpus edits we deliberately planted.
 *
 * Every expected number below was READ OFF the implementation's actual output and then
 * checked by hand against the fixture, not guessed. If one changes, the diff behaviour
 * changed — that is the point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MOD_MIN_SIMILARITY,
  blocks,
  norm,
  opcodes,
  pair,
  similarity,
} from '../src/diff/mddiff.ts';
import type { PairKind, PairRow } from '../src/diff/mddiff.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => fs.readFileSync(path.join(HERE, 'fixtures', f), 'utf8');

const srcA = read('corpus-base.md');
const srcB = read('corpus-head.md');
const A = blocks(srcA);
const B = blocks(srcB);
const rows = pair(A, B);

const kindOf = (r: PairRow): PairKind => r.kind;
const textOf = (r: PairRow, side: 'a' | 'b'): string => (r[side] ? r[side]!.text : '');
const find = (kind: PairKind, needle: string): PairRow[] =>
  rows.filter((r) => {
    if (r.kind !== kind) return false;
    const side = kind === 'ins' ? r.b : r.a;
    return !!side && side.text.includes(needle);
  });

/* ------------------------------------------------------------------ *
 * the splitter                                                        *
 * ------------------------------------------------------------------ */

test('blocks: line ranges round-trip to the source and are monotonic', () => {
  // THE structural invariant. Every downstream mechanism — the base pane's line map,
  // the note pane's overlap lookup, the scroll anchor — assumes a block's line range
  // names exactly the lines its text came from. A splitter that is off by one here is
  // a plugin that decorates the wrong paragraph.
  const lines = srcA.split('\n');
  A.forEach((b, i) => {
    assert.ok(b.lineStart >= 0, `block ${i} lineStart >= 0`);
    assert.ok(b.lineEnd >= b.lineStart, `block ${i} lineEnd >= lineStart`);
    assert.ok(b.lineEnd < lines.length, `block ${i} lineEnd within the file`);
    assert.equal(
      lines.slice(b.lineStart, b.lineEnd + 1).join('\n'),
      b.text,
      `block ${i} text round-trips to its own line range`
    );
    if (i > 0) {
      assert.ok(b.lineStart > A[i - 1].lineEnd, `block ${i} starts after block ${i - 1} ends`);
    }
  });
});

test('blocks: a blank line separates blocks', () => {
  const b = blocks('one\n\ntwo\n\nthree');
  assert.equal(b.length, 3);
  assert.deepEqual(b.map((x) => x.text), ['one', 'two', 'three']);
});

test('blocks: a fenced code block is ONE block even with blank lines inside', () => {
  // The fence rule exists because a blank line inside ``` is CONTENT, not a separator.
  // Splitting there produces two half-fences, each of which renders as garbage.
  const b = blocks('para\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter');
  assert.equal(b.length, 3);
  assert.ok(b[1].text.startsWith('```js'));
  assert.ok(b[1].text.endsWith('```'));
  assert.ok(b[1].text.includes('const b = 2;'), 'content after the blank line stayed in the fence');
});

test('blocks: the real fixture keeps its fenced block whole', () => {
  const fenced = A.filter((b) => b.text.startsWith('```'));
  assert.equal(fenced.length, 1, 'exactly one fenced block in the base corpus');
  assert.ok(fenced[0].text.includes('\n\n'), 'it really does contain a blank line');
  assert.ok(fenced[0].text.includes('80% accuracy'), 'and the text after that blank line');
});

test('blocks: a paragraph immediately followed by a list splits into TWO blocks', () => {
  // THE GRAIN RULE. This is the highest-value assertion in the file.
  //
  // Obsidian's renderer sections a list separately from a paragraph that precedes it
  // with no blank line. Our original "run of non-blank lines" grain merged them, which
  // meant a merged base block was ONE element where the note had TWO — different
  // heights, and every block below it drifted. Measured on a real 767-line document:
  // 308 Obsidian sections vs 270 of our blocks, and all 38 of the gap were exactly this
  // pattern. Fixing it took mid-document drift from 40px to 0px.
  //
  // test/grain-oracle.test.ts is what proves the rule matches OBSIDIAN. This test only
  // proves the rule still fires — it is the cheap regression guard that runs everywhere.
  const bullet = blocks('Three things to check:\n- one\n- two');
  assert.equal(bullet.length, 2, 'paragraph + bullet list');
  assert.equal(bullet[0].text, 'Three things to check:');
  assert.equal(bullet[1].text, '- one\n- two');

  const ordered = blocks('The order of operations:\n1. weigh\n2. salt');
  assert.equal(ordered.length, 2, 'paragraph + ordered list');
  assert.equal(ordered[0].text, 'The order of operations:');

  // ...and the rule must NOT fire between two list items, or every list becomes N blocks.
  const list = blocks('- one\n- two\n- three');
  assert.equal(list.length, 1, 'a list is not split item-by-item');
});

test('blocks: the fixture exercises the grain rule on real content', () => {
  const intro = A.find((b) => b.text === 'Three things to check before you walk away:');
  assert.ok(intro, 'the paragraph is its own block, not merged with the list below it');
  const list = A.find((b) => b.text.startsWith('- The vegetables are under the brine.'));
  assert.ok(list, 'and the list is its own block');
  assert.equal(list!.lineStart, intro!.lineEnd + 1, 'they are adjacent — no blank line between them');
});

test('blocks: degenerate inputs do not throw', () => {
  assert.deepEqual(blocks(''), []);
  assert.deepEqual(blocks('\n\n\n'), []);
  assert.deepEqual(blocks(null), []);
  assert.deepEqual(blocks(undefined), []);
  assert.equal(blocks('only one line').length, 1);
});

/* ------------------------------------------------------------------ *
 * similarity                                                          *
 * ------------------------------------------------------------------ */

test('similarity: bounds and degenerate cases', () => {
  assert.equal(similarity('a b c', 'a b c'), 1, 'identical');
  assert.equal(similarity('', ''), 1, 'two empties are identical');
  assert.equal(similarity('a', ''), 0, 'one empty is nothing alike');
  assert.equal(similarity('a b', 'c d'), 0, 'disjoint');
  const s = similarity('the quick brown fox', 'the quick brown dog');
  assert.ok(s > 0.5 && s < 1, `partial overlap lands strictly between: ${s}`);
});

test('similarity: multiset semantics — a repeated token cannot inflate the score', () => {
  // Set semantics would score this 1.0 (both sides use only the token "a") and a
  // block of "a" x3 would be reported as a modification of a block of "a" x1.
  const s = similarity('a a a', 'a');
  assert.equal(s, 0.5, '2*1/(3+1) = 0.5, not 1.0');
});

test('similarity: word order is evidence for alignment', () => {
  assert.equal(similarity('one two three', 'three two one'), 1 / 3);
});

/* ------------------------------------------------------------------ *
 * opcodes                                                             *
 * ------------------------------------------------------------------ */

test('opcodes: equal / delete / insert / replace shapes', () => {
  assert.deepEqual(opcodes(['a', 'b'], ['a', 'b']), [['equal', 0, 2, 0, 2]]);
  assert.deepEqual(opcodes(['a', 'b'], ['a']), [['equal', 0, 1, 0, 1], ['delete', 1, 2, 1, 1]]);
  assert.deepEqual(opcodes(['a'], ['a', 'b']), [['equal', 0, 1, 0, 1], ['insert', 1, 1, 1, 2]]);
  // A delete-run adjacent to an insert-run must coalesce into ONE replace run — that is
  // what gives `pair` the chance to test the two sides for similarity.
  assert.deepEqual(opcodes(['a', 'x'], ['a', 'y']), [['equal', 0, 1, 0, 1], ['replace', 1, 2, 1, 2]]);
  assert.deepEqual(opcodes([], []), []);
});

test('opcodes: ranges are half-open and tile the inputs exactly', () => {
  const Aa = ['a', 'b', 'c', 'd', 'e'];
  const Bb = ['a', 'x', 'c', 'y', 'z'];
  const ops = opcodes(Aa, Bb);
  let i = 0;
  let j = 0;
  for (const [, i1, i2, j1, j2] of ops) {
    assert.equal(i1, i, 'A ranges are contiguous');
    assert.equal(j1, j, 'B ranges are contiguous');
    i = i2;
    j = j2;
  }
  assert.equal(i, Aa.length, 'A fully covered');
  assert.equal(j, Bb.length, 'B fully covered');
});

/* ------------------------------------------------------------------ *
 * pairing — against the planted corpus edits                          *
 * ------------------------------------------------------------------ */

test('pair: the corpus produces the expected shape', () => {
  const counts: Record<PairKind, number> = { same: 0, mod: 0, del: 0, ins: 0 };
  rows.forEach((r) => counts[kindOf(r)]++);
  assert.deepEqual(counts, { same: 41, mod: 2, del: 4, ins: 5 });
  assert.equal(A.length, 47, 'base blocks');
  assert.equal(B.length, 48, 'head blocks');
});

test('pair: every block from both sides appears exactly once, in order', () => {
  // A row list that silently drops a block would render a diff that is missing text —
  // the worst possible failure for a review tool, and an invisible one.
  assert.deepEqual(rows.filter((r) => r.a).map((r) => r.a!.lineStart), A.map((b) => b.lineStart));
  assert.deepEqual(rows.filter((r) => r.b).map((r) => r.b!.lineStart), B.map((b) => b.lineStart));
});

test('pair: planted deletions show up as del', () => {
  assert.equal(find('del', 'Scope note').length, 1, "the 'Scope note' callout was removed");
  assert.equal(find('del', 'Reading lens:').length, 1, "the 'Reading lens' callout was removed");
  assert.equal(find('del', '## Reading Lens').length, 1, 'and so was its heading');
});

test('pair: planted insertion shows up as ins', () => {
  const hits = find('ins', 'Most teams ferment by the calendar');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].a, null, 'an ins row has no base side');
});

test('pair: planted trailing insertion run shows up as a run of ins at EOF', () => {
  const tail = rows.slice(-3);
  assert.deepEqual(tail.map(kindOf), ['ins', 'ins', 'ins']);
  assert.ok(textOf(tail[0], 'b').includes('Appendix: Brine Table'));
});

test('pair: a small edit to a paragraph is a MOD, not a delete+add', () => {
  // The word-level mark layer only runs on 'mod' rows, so this classification is what
  // makes a one-word change readable as a one-word change.
  const mods = rows.filter((r) => r.kind === 'mod');
  const para = mods.find((r) => textOf(r, 'b').includes('Most people ferment by looking at the jar'));
  assert.ok(para, 'the four-days -> five-days paragraph paired as mod');
  assert.ok(textOf(para!, 'a').includes('about four days'), 'base side has the old wording');
  assert.ok(textOf(para!, 'b').includes('about five days'), 'note side has the new wording');
});

test('pair: a one-cell table edit is a MOD (the whole table is one block)', () => {
  const mods = rows.filter((r) => r.kind === 'mod');
  const table = mods.find((r) => textOf(r, 'b').includes('| Ferment |'));
  assert.ok(table, 'the table paired as mod');
  assert.ok(textOf(table!, 'a').includes('| Kimchi | 4C | 12-15C | 20C |'));
  assert.ok(textOf(table!, 'b').includes('| Kimchi | 4C | 10-15C | 20C |'));
});

test('pair: no mod row pairs blocks below the similarity threshold', () => {
  // The gate that stops two unrelated paragraphs being drawn as "this became that".
  const bad = rows.filter(
    (r) => r.kind === 'mod' && similarity(norm(r.a!.text), norm(r.b!.text)) < MOD_MIN_SIMILARITY
  );
  assert.deepEqual(bad, []);
});

test('pair: a wholly rewritten block becomes del + ins, NOT mod', () => {
  // The other half of the threshold's job, and the reason it is a threshold rather than
  // "any replace run is a mod".
  const crock = find('del', 'A crock costs two hundred dollars');
  const vessels = find('ins', 'Fermentation vessels have become a status object');
  assert.equal(crock.length, 1, 'the old sentence is a deletion');
  assert.equal(vessels.length, 1, 'the new sentence is an insertion');
  const sim = similarity(norm(crock[0].a!.text), norm(vessels[0].b!.text));
  assert.ok(sim < MOD_MIN_SIMILARITY, `and they really are dissimilar (${sim.toFixed(3)})`);
});

test('pair: del rows precede their paired ins rows within a replace run', () => {
  // The `pending` mechanism in `pair`. It keeps a rewritten region reading as
  // "here is what went, here is what came" rather than interleaving the two.
  const delIdx = rows.findIndex((r) => r.kind === 'del' && textOf(r, 'a').includes('A crock costs'));
  const insIdx = rows.findIndex((r) => r.kind === 'ins' && textOf(r, 'b').includes('Fermentation vessels'));
  assert.ok(delIdx >= 0 && insIdx >= 0);
  assert.ok(delIdx < insIdx, 'the deletion is emitted before the insertion');
});

test('pair: identical inputs produce all-same and zero changes', () => {
  const same = pair(A, A);
  assert.equal(same.length, A.length);
  assert.ok(same.every((r) => r.kind === 'same'));
});

test('pair: degenerate sides', () => {
  assert.ok(pair(A, []).every((r) => r.kind === 'del'), 'everything deleted');
  assert.ok(pair([], B).every((r) => r.kind === 'ins'), 'everything inserted');
  assert.deepEqual(pair([], []), []);
});

test('pair: is deterministic', () => {
  // The row list keys the view-zone cache and the word-mark cache by index. A pairing
  // that varied between runs would file measurements under the wrong rows.
  assert.deepEqual(pair(blocks(srcA), blocks(srcB)), rows);
});

/* ------------------------------------------------------------------ *
 * cost                                                                *
 * ------------------------------------------------------------------ */

test('pair: cost is sane on the corpus', () => {
  // The pairer is O(n*m) in blocks. This is not a benchmark — it is a tripwire for an
  // accidental quadratic-in-CHARACTERS regression, which would freeze Obsidian's
  // renderer on a large note (the failure that killed an earlier HTML-in-note approach).
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) pair(blocks(srcA), blocks(srcB));
  const ms = (performance.now() - t0) / 20;
  assert.ok(ms < 100, `blocks+pair averaged ${ms.toFixed(1)}ms (budget 100ms)`);
});

/**
 * Row order must never contradict the note's own document order.
 *
 * The 'replace' branch defers insert rows to the end of the run so del/ins stay grouped.
 * When a 'mod' lands between a del and its deferred ins, that deferral used to emit the
 * mod BEFORE text that is physically above it — rows carried note-side lines
 * 294, 295, 303, 301. The base pane renders in ROW order and the note in DOCUMENT order,
 * so the panes disagreed by the height of the deferred block: a paired block, word-marks
 * present on both sides, sitting 249px out of line. It read as an alignment bug and was an
 * ordering one.
 */
test('rows never claim an order the note contradicts (deferred ins vs mod)', () => {
  // Two blocks replaced: the first rewritten past recognition (-> del + ins), the second
  // only edited (-> mod). Exactly the shape from the reference corpus at line 299.
  const base = [
    '# H',
    '',
    'The principle: make fallback bidirectional and expand the triggers to include timeouts.',
    '',
    'Observed incident: a provider outage caused fifty two minutes of chat unavailability.',
  ].join('\n');
  const cur = [
    '# H',
    '',
    'Two fixes carry the weight here: symmetry, and treating timeouts as a fallback trigger.',
    '',
    'Observed incident: a provider outage caused fifty two minutes of chat unavailability today.',
  ].join('\n');

  const rows = pair(blocks(base), blocks(cur));
  const noteLines = rows.filter((r) => r.b).map((r) => r.b!.lineStart);
  for (let i = 1; i < noteLines.length; i++) {
    assert.ok(noteLines[i] > noteLines[i - 1],
      `note-side line ${noteLines[i]} appears after ${noteLines[i - 1]} in row order — ` +
      `the rows disagree with the file, and the panes will too. Order: ${noteLines.join(', ')}`);
  }
  const baseLines = rows.filter((r) => r.a).map((r) => r.a!.lineStart);
  for (let i = 1; i < baseLines.length; i++) {
    assert.ok(baseLines[i] > baseLines[i - 1], 'base-side order must be ascending too');
  }
});
