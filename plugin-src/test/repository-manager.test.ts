import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { App } from 'obsidian';
import type { GitContext } from '../src/git.ts';
import { createChange, getChangeDetails, getRepositoryStatus, listRepositoryHistory, repositoryAnchor, resolveRepositoryDirectory } from '../src/repositoryManager.ts';
import { repositoryAiContext } from '../src/aiContext.ts';

function fixture(backend: 'git' | 'jj' = 'git', colocate = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgd-manager-'));
  const run = (tool: string, args: string[]) => execFileSync(tool, args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const git = (...args: string[]) => run('git', ['-C', dir, ...args]);
  const jj = (...args: string[]) => run('jj', ['--no-pager', '--color=never', '--config', 'user.name="QA"', '--config', 'user.email="qa@localhost"', '-R', dir, ...args]);
  git('init'); git('config', 'user.name', 'QA'); git('config', 'user.email', 'qa@localhost'); git('config', 'commit.gpgsign', 'false');
  if (backend === 'jj') {
    if (colocate) run('jj', ['git', 'init', '--colocate', dir]);
    else { fs.rmSync(path.join(dir, '.git'), { recursive: true }); run('jj', ['git', 'init', '--no-colocate', dir]); }
    jj('config', 'set', '--repo', 'user.name', 'QA'); jj('config', 'set', '--repo', 'user.email', 'qa@localhost');
  }
  const ctx: GitContext = { abs: dir, rel: '', root: backend === 'jj' ? jj('git', 'root') : dir, backend, workspaceRoot: backend === 'jj' ? dir : undefined };
  const write = (name: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
  const clean = () => { assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('lgd-manager-')); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, git, jj, ctx, write, clean };
}

for (const backend of ['git', 'jj'] as const) test(`AI evidence includes only selected changes and rejects stale content (${backend})`, async () => {
  const f = fixture(backend);
  try {
    f.write('story.md', '# Story\n\nReviewed acceptance criterion.\n');
    f.write('private.md', 'Unrelated content that must not be sent.');
    if (backend === 'git') { f.git('add','story.md'); f.write('story.md','# Story\n\nReviewed acceptance criterion.\n\nEdited after staging.\n'); }
    const status = await getRepositoryStatus(f.ctx);
    const evidence = await repositoryAiContext(f.ctx, {paths:['story.md'],token:status.token}, async file => fs.readFileSync(path.join(f.dir,file),'utf8'));
    assert.match(evidence, /Reviewed acceptance criterion/); assert.doesNotMatch(evidence, /private.md|Unrelated content/);
    if (backend === 'git') assert.match(evidence,/Edited after staging/);
    await createChange(f.ctx, ['story.md'], 'Reviewed story', status.token);
    const sha = backend === 'jj' ? f.jj('log','-G','-r','@-','-T','commit_id') : f.git('rev-parse','HEAD');
    const committed = await repositoryAiContext(f.ctx, {sha}, async () => { throw new Error('A committed explanation must not read working files.'); });
    assert.match(committed,/Reviewed acceptance criterion/); assert.doesNotMatch(committed,/Unrelated content/);
    await assert.rejects(repositoryAiContext(f.ctx, {paths:['private.md'],token:status.token}, async () => ''), /Files changed/);
  } finally { f.clean(); }
});

test('selective Git changes preserve unrelated staged content and support literal new paths, deletion and rename', async () => {
  const f = fixture();
  try {
    f.write('note.md', 'first'); f.write('other.md', 'first'); f.write('deleted.md', 'gone');
    f.git('add', '.'); f.git('commit', '-m', 'initial');
    f.write('note.md', 'reviewed'); f.write('other.md', 'staged'); f.git('add', 'other.md');
    f.write('other.md', 'unstaged'); f.write('[draft] -- note.md', 'new'); fs.unlinkSync(path.join(f.dir, 'deleted.md'));
    let status = await getRepositoryStatus(f.ctx);
    await createChange(f.ctx, ['note.md', '[draft] -- note.md', 'deleted.md'], 'Reviewed scope', status.token);
    assert.equal(f.git('show', 'HEAD:note.md'), 'reviewed');
    assert.equal(f.git('show', 'HEAD:other.md'), 'first');
    assert.equal(f.git('show', ':other.md'), 'staged');
    assert.equal(fs.readFileSync(path.join(f.dir, 'other.md'), 'utf8'), 'unstaged');
    assert.equal(f.git('show', 'HEAD:[draft] -- note.md'), 'new');
    const details = await getChangeDetails(f.ctx, f.git('rev-parse', 'HEAD'));
    assert.deepEqual(details.files.map(file => [file.path, file.status]).sort(), [['[draft] -- note.md', 'A'], ['deleted.md', 'D'], ['note.md', 'M']].sort());
    f.git('mv', 'note.md', 'renamed.md'); status = await getRepositoryStatus(f.ctx);
    assert.equal(status.files.find(file => file.path === 'renamed.md')?.oldPath, 'note.md');
    await createChange(f.ctx, ['renamed.md'], 'Rename story', status.token);
    assert.equal(f.git('show', 'HEAD:renamed.md'), 'reviewed');
    assert.equal(f.git('show', ':other.md'), 'staged');
    assert.equal((await getChangeDetails(f.ctx, f.git('rev-parse', 'HEAD'))).files[0].oldPath, 'note.md');
  } finally { f.clean(); }
});

test('Git unborn repository and stale content tokens, including untracked files', async () => {
  const f = fixture();
  try {
    assert.deepEqual((await listRepositoryHistory(f.ctx, { offset: 0, limit: 10 })).changes, []);
    f.write('a.md', 'one'); f.write('b.md', 'two');
    const initial = await getRepositoryStatus(f.ctx);
    f.write('a.md', 'three');
    await assert.rejects(createChange(f.ctx, ['a.md'], 'First change', initial.token), /Files changed/);
    const status = await getRepositoryStatus(f.ctx);
    await createChange(f.ctx, ['a.md'], 'First change', status.token);
    assert.equal(f.git('ls-tree', '--name-only', 'HEAD'), 'a.md');
    assert.equal(f.git('status', '--porcelain'), '?? b.md');
    assert.equal((await getChangeDetails(f.ctx, f.git('rev-parse', 'HEAD'))).files[0].status, 'A');
    f.write('a.md', 'four'); const modified = await getRepositoryStatus(f.ctx); f.write('a.md', 'five');
    await assert.rejects(createChange(f.ctx, ['a.md'], 'Changed again', modified.token), /Files changed/);
  } finally { f.clean(); }
});

test('failed Git commit restores temporary intent-to-add entries and preserves other staging', async () => {
  const f = fixture();
  try {
    f.write('a.md', 'one'); f.git('add', '.'); f.git('commit', '-m', 'initial');
    f.write('a.md', 'two'); f.git('add', 'a.md'); f.write('new.md', 'new');
    f.write('.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
    const before = f.git('status', '--porcelain');
    await assert.rejects(createChange(f.ctx, ['new.md'], 'Rejected', (await getRepositoryStatus(f.ctx)).token));
    assert.equal(f.git('status', '--porcelain'), before);
    assert.equal(f.git('show', ':a.md'), 'two');
  } finally { f.clean(); }
});

test('Git history traverses all branches, folder scopes and immutable page anchors', async () => {
  const f = fixture();
  try {
    f.write('folder/a.md', 'one'); f.git('add', '.'); f.git('commit', '-m', 'first');
    const first = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-b', 'another'); f.write('folder/a.md', 'branch'); f.git('commit', '-am', 'branch');
    const branch = f.git('rev-parse', 'HEAD');
    f.git('checkout', '--detach', first); f.write('outside.md', 'other'); f.git('add', '.'); f.git('commit', '-m', 'detached');
    const anchor = await repositoryAnchor(f.ctx);
    const page1 = await listRepositoryHistory(f.ctx, { offset: 0, limit: 1, anchor });
    assert.equal(page1.hasMore, true);
    f.write('outside.md', 'newer'); f.git('commit', '-am', 'later');
    const rest = await listRepositoryHistory(f.ctx, { offset: 1, limit: 10, anchor });
    assert.equal(page1.changes.length + rest.changes.length, 3);
    const scoped = await listRepositoryHistory(f.ctx, { offset: 0, limit: 10, path: 'folder', anchor });
    assert.deepEqual(new Set(scoped.changes.map(change => change.sha)), new Set([first, branch]));
    assert.equal(new Set([...page1.changes, ...rest.changes].map(change => change.sha)).size, 3);
    const app = { vault: { adapter: { getFullPath: (value: string) => path.join(f.dir, value) } } } as unknown as App;
    const ctx = await resolveRepositoryDirectory(app, 'folder');
    assert.equal(ctx.rel, 'folder'); assert.equal(ctx.backend, 'git');
  } finally { f.clean(); }
});

for (const colocate of [true, false]) test(`JJ selected changes preserve working files and change identity, with pinned history (colocated=${colocate})`, async () => {
  const f = fixture('jj', colocate);
  try {
    f.write('folder/[story].md', 'reviewed'); f.write('other.md', 'pending');
    const status = await getRepositoryStatus(f.ctx);
    assert.deepEqual(status.files.map(file => file.path).sort(), ['folder/[story].md', 'other.md']);
    const changeId = f.jj('log', '-G', '-r', '@', '-T', 'change_id');
    await createChange(f.ctx, ['folder/[story].md'], 'Story accepted', status.token);
    assert.equal(f.jj('log', '-G', '-r', '@-', '-T', 'change_id'), changeId);
    assert.notEqual(f.jj('log', '-G', '-r', '@', '-T', 'change_id'), changeId);
    assert.equal(f.jj('file', 'list', '-r', '@-').replace(/\\/g, '/'), 'folder/[story].md');
    assert.equal(fs.readFileSync(path.join(f.dir, 'other.md'), 'utf8'), 'pending');
    const remaining = await getRepositoryStatus(f.ctx);
    assert.deepEqual(remaining.files.map(file => file.path), ['other.md']);
    const sha = f.jj('log', '-G', '-r', '@-', '-T', 'commit_id');
    const details = await getChangeDetails(f.ctx, sha);
    assert.equal(details.change.subject, 'Story accepted');
    assert.deepEqual(details.files.map(file => [file.path, file.status]), [['folder/[story].md', 'A']]);
    const anchor = await repositoryAnchor(f.ctx);
    const history = await listRepositoryHistory(f.ctx, { offset: 0, limit: 1, anchor });
    assert.equal(history.hasMore, true);
    f.write('other.md', 'changed while browsing'); f.jj('util', 'snapshot');
    const same = await listRepositoryHistory(f.ctx, { offset: 0, limit: 1, anchor });
    assert.deepEqual(history.changes, same.changes);
    const scoped = await listRepositoryHistory(f.ctx, { offset: 0, limit: 10, path: 'folder', anchor });
    assert.deepEqual(scoped.changes.map(change => change.sha), [sha]);
    await assert.rejects(createChange(f.ctx, ['other.md'], 'Stale', remaining.token), /Files changed/);
    const app = { vault: { adapter: { getFullPath: (value: string) => path.join(f.dir, value) } } } as unknown as App;
    const folder = await resolveRepositoryDirectory(app, 'folder'); assert.equal(folder.backend, 'jj'); assert.equal(folder.rel, 'folder');
  } finally { f.clean(); }
});
