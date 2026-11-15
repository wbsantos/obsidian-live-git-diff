import test from 'node:test';
import assert from 'node:assert/strict';
import { NavigationTrail } from '../src/navigation.ts';

test('repository, folder, change and file visits share a bounded trail and truncate forward branches', () => {
  const trail = new NavigationTrail<string>(value => value, 4);
  for (const route of ['repo', 'folder', 'change:a', 'file', 'change:b']) trail.push(route);
  assert.equal(trail.back(), 'file');
  assert.equal(trail.back(), 'change:a');
  assert.equal(trail.forward(), 'file');
  trail.push('folder:b');
  assert.equal(trail.forward(), undefined);
  assert.equal(trail.back(), 'file');
  assert.equal(trail.back(), 'change:a');
  assert.equal(trail.back(), 'folder');
  assert.equal(trail.back(), undefined);
  trail.push('folder');
  assert.equal(trail.back(), undefined);
});
