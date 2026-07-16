/**
 * panes.test.ts — setNoteKind: the note block wears THIS session's kind, never a past one.
 *
 * Anchored to a real bug (2026-07-15): re-pinning a review onto a base with fewer changes
 * left the note fully green while the header correctly read "0 changed". Reading-view
 * sections are recycled rather than rebuilt, so the previous session's `lgd-ins` rode back
 * in on the same elements, and the post-processor's conditional `addClass` had no removal
 * path to take it off. A stale diff rendered convincingly is the exact failure class this
 * codebase works hardest to avoid, so the set-don't-accumulate rule gets a test.
 *
 * No jsdom: setNoteKind touches only `classList.add/remove`, so a Set-backed stub covers
 * the whole surface honestly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CLS, NOTE_KIND_CLASSES, setNoteKind } from '../src/panes.ts';

const fakeEl = (...initial: string[]) => {
  const s = new Set(initial);
  return {
    classList: {
      add: (c: string) => { s.add(c); },
      remove: (c: string) => { s.delete(c); },
    },
    has: (c: string) => s.has(c),
    all: () => [...s].sort(),
  };
};

test('setNoteKind: applies the kind this session says', () => {
  const ins = fakeEl();
  setNoteKind(ins, 'ins');
  assert.equal(ins.has(CLS.ins), true);
  assert.equal(ins.has(CLS.mod), false);

  const mod = fakeEl();
  setNoteKind(mod, 'mod');
  assert.equal(mod.has(CLS.mod), true);
  assert.equal(mod.has(CLS.ins), false);
});

test('setNoteKind: a recycled ins block that is now unchanged loses its wash (THE BUG)', () => {
  const el = fakeEl(CLS.nblock, CLS.ins); // came back from the previous review still green
  setNoteKind(el, 'same');
  assert.equal(el.has(CLS.ins), false, 'stale ins wash must not survive a re-pin');
  assert.equal(el.has(CLS.mod), false);
});

test('setNoteKind: switches kind rather than stacking both', () => {
  const el = fakeEl(CLS.ins);
  setNoteKind(el, 'mod');
  assert.equal(el.has(CLS.ins), false, 'ins and mod on one block would paint two states');
  assert.equal(el.has(CLS.mod), true);
});

test('setNoteKind: null strips every kind class — the teardown contract', () => {
  for (const stale of NOTE_KIND_CLASSES) {
    const el = fakeEl(stale);
    setNoteKind(el, null);
    assert.equal(el.has(stale), false, `${stale} must be removable on close`);
  }
});

test('setNoteKind: leaves classes we do not own alone', () => {
  // side-comments marks the same elements. Scrubbing its classes would break the review
  // loop this plugin exists to serve.
  const el = fakeEl(CLS.nblock, 'side-comments-mark', 'el-p', CLS.ins);
  setNoteKind(el, 'same');
  assert.deepEqual(el.all(), ['el-p', CLS.nblock, 'side-comments-mark'].sort());
});

test('setNoteKind: idempotent — same kind twice is the same DOM', () => {
  const el = fakeEl(CLS.nblock);
  setNoteKind(el, 'ins');
  const once = el.all();
  setNoteKind(el, 'ins');
  assert.deepEqual(el.all(), once);
});
