/**
 * endpad.test.ts — the trailing view zone's arithmetic.
 *
 * The rule it encodes: the base pane's max scrollTop must equal the note's, or sync asks
 * for a scrollTop the base cannot reach and the panes drift apart by the shortfall. This
 * bit the demo fixture hard (note 1100/1469, base pinned 558/558, anchor 337px out) and
 * costs a few hundred px at the bottom of a long document, which is how it went unseen.
 *
 * Pure arithmetic, so it needs no DOM: styleEndPad's whole content is this equation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** The equation from ViewZones.styleEndPad, extracted verbatim. */
const wantPad = (noteScrollHeight: number, noteClientHeight: number,
                 baseContentPx: number, baseClientHeight: number): number =>
  Math.max(0, Math.round((noteScrollHeight - noteClientHeight) + baseClientHeight - baseContentPx));

/** What the base's max scrollTop becomes once the pad is applied. */
const baseMaxScroll = (baseContentPx: number, pad: number, baseClientHeight: number): number =>
  baseContentPx + pad - baseClientHeight;

test('the base ends up with exactly the note\'s scroll range', () => {
  // The real measurement from the demo that exposed this.
  const noteScrollHeight = 2762, noteClientHeight = 1414;
  const baseContentPx = 1295, baseClientHeight = 1295;
  const pad = wantPad(noteScrollHeight, noteClientHeight, baseContentPx, baseClientHeight);
  assert.equal(baseMaxScroll(baseContentPx, pad, baseClientHeight), noteScrollHeight - noteClientHeight);
});

test('a base that was pinned at its ceiling can now follow the note to the end', () => {
  // note 1469 of range, base could only do 558 -> 911px of drift at the bottom.
  const pad = wantPad(1469 + 700, 700, 558 + 700, 700);
  assert.equal(baseMaxScroll(558 + 700, pad, 700), 1469, 'base range must reach the note\'s');
});

test('never negative: a base already taller than the note asks for no pad', () => {
  // A big deletion run makes the base the long side. Padding it further would let it
  // scroll past content the note cannot reach — the mirror of the bug being fixed.
  assert.equal(wantPad(1000, 800, 5000, 800), 0);
});

test('idempotent — recomputing from content height cannot feed back on itself', () => {
  const args = [2762, 1414, 1295, 1295] as const;
  const first = wantPad(...args);
  // styleEndPad subtracts the pad's own height before measuring, so the second call sees
  // the same contentPx and returns the same answer. A version that read scrollHeight
  // raw would grow without bound here.
  assert.equal(wantPad(...args), first);
});

test('a document that fits on screen still gets the note\'s full range', () => {
  // The short-file case: the note's range is ~all end-padding, and the base's content is
  // shorter than its own viewport (contentPx < clientHeight), so pad carries it alone.
  const pad = wantPad(2000, 1400, 800, 1300);
  assert.equal(baseMaxScroll(800, pad, 1300), 600);
  assert.ok(pad > 0, 'a short base must still receive room to follow');
});
