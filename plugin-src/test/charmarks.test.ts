/**
 * charmarks.test.ts — the word-level range math.
 *
 * This covers the PURE half of charmarks.ts (tokenize / wordDiffRanges / coalesce).
 * The DOM half (wrapRanges) is not unit-tested here: its correctness condition is
 * "el.textContent is byte-identical before and after", and it ASSERTS exactly that at
 * runtime and self-reverts if it ever trips — with the count surfaced in the alignment
 * report as `charMarks.reverts`, which must be 0. A jsdom test would prove the assertion
 * fires in jsdom; the runtime assertion proves it in the browser the user actually has.
 * See docs/ARCHITECTURE.md "The textContent invariant".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAR_MAX_CHANGED_FRACTION,
  changedFraction,
  coalesceRanges,
  isWsTok,
  keyTok,
  tokenize,
  wordDiffRanges,
} from '../src/charmarks.ts';
import type { CharRange } from '../src/charmarks.ts';

/** Pull the marked substrings back out, which is what the spans will actually cover. */
const slice = (s: string, ranges: CharRange[]): string[] => ranges.map(([a, b]) => s.slice(a, b));

test('tokenize: offsets are exact and reconstruct the input', () => {
  const s = 'the  quick\nbrown fox';
  const { toks, offs } = tokenize(s);
  assert.equal(toks.join(''), s, 'tokens concatenate back to the input');
  toks.forEach((t, i) => {
    assert.equal(s.slice(offs[i], offs[i] + t.length), t, `token ${i} sits at its offset`);
  });
});

test('tokenize: degenerate inputs', () => {
  assert.deepEqual(tokenize('').toks, ['']);
  assert.deepEqual(tokenize(null).toks, ['']);
  assert.equal(tokenize('   ').toks.join(''), '   ');
});

test('isWsTok / keyTok: all whitespace compares equal', () => {
  assert.ok(isWsTok(' '));
  assert.ok(isWsTok('\n  \t'));
  assert.ok(isWsTok(''));
  assert.ok(!isWsTok('word'));
  // THE REFLOW RULE: a paragraph rewrapped at a different width changes newlines into
  // spaces. Rendered HTML collapses both, so the reader sees no change — and neither
  // should the diff. Without this, re-wrapping a paragraph marks every word in it.
  assert.equal(keyTok('\n'), keyTok(' '));
  assert.equal(keyTok('word'), 'word');
});

test('changedFraction: counts words, ignores whitespace', () => {
  const { toks } = tokenize('a b c');           // [a, ' ', b, ' ', c]
  assert.equal(changedFraction(toks, [true, false, false, false, false]), 1 / 3);
  assert.equal(changedFraction(toks, [false, true, false, true, false]), 0, 'whitespace does not count');
  assert.equal(changedFraction(tokenize('').toks, [false]), 0, 'no words = 0, never NaN');
});

test('wordDiffRanges: identical text produces no marks', () => {
  assert.equal(wordDiffRanges('the quick brown fox', 'the quick brown fox'), null);
});

test('wordDiffRanges: a single changed word marks exactly that word', () => {
  const a = 'diverge for about four days, which is';
  const b = 'diverge for about five days, which is';
  const r = wordDiffRanges(a, b);
  assert.ok(r, 'a change was found');
  assert.deepEqual(slice(a, r!.a), ['four']);
  assert.deepEqual(slice(b, r!.b), ['five']);
});

test('wordDiffRanges: ranges never begin or end on whitespace', () => {
  // A range that ended on a trailing space would paint a stripe into the margin with
  // nothing in it.
  const a = 'alpha beta gamma delta';
  const b = 'alpha BETA GAMMA delta';
  const r = wordDiffRanges(a, b)!;
  for (const [s, e] of r.b) {
    assert.ok(!/^\s/.test(b.slice(s, e)), 'no leading whitespace');
    assert.ok(!/\s$/.test(b.slice(s, e)), 'no trailing whitespace');
  }
});

test('wordDiffRanges: adjacent changed words coalesce into ONE range', () => {
  const a = 'alpha beta gamma delta';
  const b = 'alpha BETA GAMMA delta';
  const r = wordDiffRanges(a, b)!;
  assert.equal(r.b.length, 1, 'bridged across the space between them');
  assert.deepEqual(slice(b, r.b), ['BETA GAMMA']);
});

test('wordDiffRanges: an unchanged word between two changes ENDS the run', () => {
  const a = 'one two three four five';
  const b = 'ONE two THREE four FIVE';
  const r = wordDiffRanges(a, b)!;
  assert.deepEqual(slice(b, r.b), ['ONE', 'THREE', 'FIVE']);
});

test('wordDiffRanges: a pure insertion marks only the new words', () => {
  const a = 'keep this';
  const b = 'keep brand new this';
  const r = wordDiffRanges(a, b)!;
  assert.deepEqual(slice(b, r.b), ['brand new']);
  assert.deepEqual(r.a, [], 'nothing to mark on the base side');
});

test('wordDiffRanges: reflowing a paragraph is NOT a change', () => {
  const a = 'the quick brown fox\njumps over the lazy dog';
  const b = 'the quick brown\nfox jumps over the lazy dog';
  assert.equal(wordDiffRanges(a, b), null, 'newline vs space is invisible to the reader');
});

test('wordDiffRanges: a near-total rewrite is SUPPRESSED', () => {
  // Marking ~everything is noise on top of a wash that already says "this changed".
  const a = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
  const b = 'one two three four five six seven eight nine ten';
  assert.equal(wordDiffRanges(a, b), null);
});

test('wordDiffRanges: suppression respects the documented threshold', () => {
  // 10 words, 2 changed = 0.2 changed — well under the 0.8 threshold, so marks stay.
  const a = 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10';
  const b = 'w1 w2 w3 w4 w5 w6 w7 w8 X9 X10';
  const r = wordDiffRanges(a, b);
  assert.ok(r, 'a light edit keeps its marks');
  assert.equal(CHAR_MAX_CHANGED_FRACTION, 0.8, 'the threshold is the documented one');
});

test('wordDiffRanges: ranges are ordered, non-overlapping, and within bounds', () => {
  const a = 'one two three four five six seven eight';
  const b = 'one TWO three FOUR five six SEVEN eight';
  const r = wordDiffRanges(a, b)!;
  for (const [side, text] of [[r.a, a], [r.b, b]] as Array<[CharRange[], string]>) {
    let last = -1;
    for (const [s, e] of side) {
      assert.ok(s >= 0 && e <= text.length, 'within bounds');
      assert.ok(s < e, 'non-empty');
      assert.ok(s >= last, 'ordered and non-overlapping');
      last = e;
    }
  }
});

test('coalesceRanges: a marked whitespace token alone produces nothing', () => {
  // Whitespace can be marked by the LCS, but a range must start on a real word.
  const T = tokenize('a b');                 // [a, ' ', b]
  assert.deepEqual(coalesceRanges(T, [false, true, false]), []);
});

test('wordDiffRanges: empty sides do not throw', () => {
  assert.doesNotThrow(() => wordDiffRanges('', ''));
  assert.doesNotThrow(() => wordDiffRanges('', 'something new'));
  assert.doesNotThrow(() => wordDiffRanges('something old', ''));
});
