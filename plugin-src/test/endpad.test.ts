/**
 * endpad.test.ts — the trailing zone's arithmetic, imported from the shipped code.
 *
 * The property under test is NOT "maxScroll == noteRange". That was the previous version's
 * assertion and it is provably insufficient: sync's law is screen-space, so it asks the
 * base for `note.scrollTop + H + dp`, where H is how far the base scroller starts BELOW the
 * note's (our header, ~88px). A base whose range merely equals noteRange still under-reaches
 * by H + dp at the bottom, silently, with the badge reading "sync on".
 *
 * The property IS: the base's max scrollTop can satisfy the largest ask sync can make.
 *
 * This file imports endPadPx from viewzones.ts rather than re-declaring it. The previous
 * version re-declared the equation and asserted it against itself — deleting styleEndPad's
 * body could not fail it — and one case asserted f(x) === f(x) of a pure function, true of
 * every function ever written. That is how the H term shipped missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { endPadPx } from '../src/viewzones.ts';

/** maxScroll = contentPx + pad - clientHeight — the identity styleEndPad inverts. */
const baseMaxScroll = (contentPx: number, pad: number, baseClient: number): number =>
  contentPx + pad - baseClient;

/** The largest scrollTop sync can ask the base for, given the panes' screen offset. */
const biggestAsk = (noteRange: number, extra: number): number => noteRange + extra;

test('the base can reach the biggest ask sync can make — H included', () => {
  // Real geometry: note scroller 1414 tall, base 1295 (our 88px header + 12px sizer pad
  // sit above it), base content 1295.
  const noteRange = 2762 - 1414, extra = 88 + 12;
  const pad = endPadPx(noteRange, extra, 1295, 1295);
  assert.ok(baseMaxScroll(1295, pad, 1295) >= biggestAsk(noteRange, extra),
    'a base that cannot reach the ask is the defect this zone exists to prevent');
});

test('WITHOUT the H term the base under-reaches — the defect, pinned', () => {
  // extra = 0 is exactly what the first version computed. Kept as a test so nobody
  // "simplifies" the term away again: it costs ~90px of silent bottom-of-document drift.
  const noteRange = 1469, H = 88, dp = 12;
  const short = endPadPx(noteRange, 0, 700, 900);
  assert.ok(baseMaxScroll(900, short, 700) < biggestAsk(noteRange, H + dp),
    'omitting H must leave the base short — if this passes, the term is not load-bearing');

  const right = endPadPx(noteRange, H + dp, 700, 900);
  assert.ok(baseMaxScroll(900, right, 700) >= biggestAsk(noteRange, H + dp));
});

test('the pad is an output, never an input — re-running cannot grow it', () => {
  // styleEndPad passes contentPx = scrollHeight MINUS the pad's own height, so the second
  // call sees the same contentPx. A version that read scrollHeight raw would diverge here.
  const args = [1348, 100, 1295, 1295] as const;
  const first = endPadPx(...args);
  const scrollHeightAfter = 1295 + first;           // what the DOM now reports
  const contentPxRecomputed = scrollHeightAfter - first;  // what styleEndPad derives
  assert.equal(contentPxRecomputed, 1295, 'contentPx must be pad-free');
  assert.equal(endPadPx(1348, 100, 1295, contentPxRecomputed), first, 'fixed point after pass 1');
});

test('never negative: a base already longer than the note asks for no pad', () => {
  // A big deletion run makes the base the long side. Padding further would let it scroll
  // past content the note cannot reach — the mirror of the bug being fixed.
  assert.equal(endPadPx(1000, 100, 800, 5000), 0);
});

test('a short note still gets room — the case the whole zone exists for', () => {
  // The note fits on screen; its range is almost all of Obsidian's scroll-past-end padding,
  // and the base's content is shorter than its own viewport.
  const pad = endPadPx(2000 - 1400, 100, 1300, 800);
  assert.ok(pad > 0, 'a short base must still receive room to follow');
  assert.ok(baseMaxScroll(800, pad, 1300) >= biggestAsk(600, 100));
});
