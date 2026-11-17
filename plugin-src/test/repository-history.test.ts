import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { App, TFile } from 'obsidian';
import { evolution, repositoryHead, repositoryLog, resolveRepository, snapshotNote } from '../src/repository.ts';

function fixture(backend: 'git' | 'jj') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgd-history-regression-'));
  const run = (binary: string, args: string[]) => execFileSync(binary, args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
  const git = (...args: string[]) => run('git', args);
  const jj = (...args: string[]) => run('jj', ['--ignore-working-copy', '--no-pager', '--color=never', ...args]);
  const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
  git('init', '-q'); git('config', 'user.name', 'QA'); git('config', 'user.email', 'qa@localhost');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  write('note.md', 'original\n'); write('other.md', 'other\n'); git('add', '.'); git('commit', '-qm', 'Original Git commit');
  const imported = git('rev-parse', 'HEAD');
  if (backend === 'jj') { run('jj', ['git', 'init']); jj('config', 'set', '--repo', 'user.name', 'QA'); jj('config', 'set', '--repo', 'user.email', 'qa@localhost'); }
  const app = { vault: { adapter: { getFullPath: (rel: string) => path.join(dir, rel) } } } as unknown as App;
  const context = () => resolveRepository(app, { path: 'note.md' } as TFile);
  const cleanup = () => { assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('lgd-history-regression-')); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, git, jj, write, imported, context, cleanup };
}

for (const backend of ['git', 'jj'] as const) test(`clean file combines Workcopy and HEAD; edits restore distinct versions (${backend})`, async () => {
  const f = fixture(backend);
  try {
    const ctx = await f.context();
    const clean = await repositoryLog(ctx, await repositoryHead(ctx), 30);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].kind, 'workcopy');
    assert.equal(clean[0].headCommit?.sha, f.imported);
    assert.equal(clean[0].headCommit?.subject, 'Original Git commit');
    f.write('note.md', 'changed\n');
    const dirty = await repositoryLog(ctx, await repositoryHead(ctx), 30);
    assert.equal(dirty[0].headCommit, undefined);
    assert.equal(dirty[1].sha, f.imported);
    f.write('note.md', 'original\n');
    const restored = await repositoryLog(ctx, await repositoryHead(ctx), 30);
    assert.equal(restored.length, 1);
    assert.equal(restored[0].headCommit?.sha, f.imported);
  } finally { f.cleanup(); }
});

test('imported Git commits have no JJ operation but their evolution remains readable', async () => {
  const f = fixture('jj');
  try {
    const ctx = await f.context();
    const log = await repositoryLog(ctx, await repositoryHead(ctx), 30);
    const result = await evolution(ctx, log[0].headCommit!, 30);
    assert.deepEqual(result, { commits: [], hasMore: false });
    // Description-only rewrites also visit the imported predecessor, without adding a duplicate note version.
    f.jj('--ignore-immutable', 'describe', '-r', f.imported, '-m', 'Updated description');
    const sha = f.jj('log', '-G', '-r', '@-', '-T', 'commit_id');
    const rewritten = await evolution(ctx, { ...log[0].headCommit!, sha }, 30);
    assert.deepEqual(rewritten, { commits: [], hasMore: false });
  } finally { f.cleanup(); }
});

test('automatic note snapshots skip unchanged content and unrelated workspace edits', async () => {
  const f = fixture('jj');
  try {
    const ctx = await f.context();
    const operation = () => f.jj('op', 'log', '-G', '-n', '1', '-T', 'id');
    const before = operation();
    f.write('other.md', 'unrelated edit\n');
    assert.equal(await snapshotNote(ctx), false);
    await repositoryHead(ctx);
    assert.equal(operation(), before);
    assert.equal(f.jj('file', 'show', '-r', '@', 'other.md'), 'other');
    f.write('note.md', 'changed\n');
    assert.equal(await snapshotNote(ctx), true);
    assert.equal(f.jj('file', 'show', '-r', '@', 'note.md'), 'changed');
    const saved = operation();
    assert.equal(await snapshotNote(ctx), false);
    await Promise.all([snapshotNote(ctx), snapshotNote(ctx)]);
    assert.equal(operation(), saved);
    const newContext = { ...ctx, rel: 'new.md', abs: path.join(f.dir, 'new.md') };
    f.write('new.md', '');
    assert.equal(await snapshotNote(newContext), true, 'new empty files must be snapshotted');
  } finally { f.cleanup(); }
});
