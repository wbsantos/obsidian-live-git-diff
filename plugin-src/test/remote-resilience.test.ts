import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteFixture } from './helpers/remote-fixture.ts';
import { createChange, getRepositoryStatus } from '../src/repositoryManager.ts';
import { trackedRemote, pullRepository, pushRepository, repositoryRemoteHealth } from '../src/repositoryRemote.ts';

const target = { remote: 'origin', branch: 'main' };

test('JJ combines clean edits in the same note across multiple local changes and preserves pending work', async () => {
  const f = remoteFixture('jj', false);
  try {
    const original = 'Title\n\nFirst paragraph.\n\nMiddle paragraph.\n\nLast paragraph.\n';
    f.write('note.md', original);
    await createChange(f.ctx, ['note.md'], 'Shared base', (await getRepositoryStatus(f.ctx)).token);
    await pushRepository(f.ctx, target); f.peer('pull', '--ff-only');
    f.write('note.md', original.replace('First paragraph.', 'Locally improved first paragraph.'));
    await createChange(f.ctx, ['note.md'], 'Improve first paragraph', (await getRepositoryStatus(f.ctx)).token);
    f.write('local.md', 'Second local change\n');
    await createChange(f.ctx, ['local.md'], 'Second local change', (await getRepositoryStatus(f.ctx)).token);
    const changes = f.jj('log', '-G', '-r', 'main@origin..@-', '-T', 'change_id ++ "\\n"').split('\n');
    f.write('pending.md', 'Still reviewing\n');
    const working = f.jj('log', '-G', '-r', '@', '-T', 'change_id');
    const incoming = f.publish('note.md', original.replace('Last paragraph.', 'Remotely improved last paragraph.'));
    assert.match((await pullRepository(f.ctx, target)).message, /Rebased 2 local changes/);
    assert.equal(f.read('note.md'), original.replace('First paragraph.', 'Locally improved first paragraph.').replace('Last paragraph.', 'Remotely improved last paragraph.'));
    assert.deepEqual(new Set(f.jj('log', '-G', '-r', `${incoming}..@-`, '-T', 'change_id ++ "\\n"').split('\n')), new Set(changes));
    assert.equal(f.jj('log', '-G', '-r', '@', '-T', 'change_id'), working);
    assert.equal(f.read('pending.md'), 'Still reviewing\n');
    assert.equal(f.jj('log', '-G', '-r', 'main', '-T', 'commit_id'), f.jj('log', '-G', '-r', '@-', '-T', 'commit_id'));
  } finally { f.clean(); }
});

for (const colocate of [false, true]) test(`JJ reconciles a collaborator bookmark conflict and keeps tracking (colocated=${colocate})`, async () => {
  const f = remoteFixture('jj', colocate);
  try {
    f.jj('bookmark', 'track', 'main', '--remote', 'origin');
    f.write('local.md', 'Local contribution\n');
    await createChange(f.ctx, ['local.md'], 'Local contribution', (await getRepositoryStatus(f.ctx)).token);
    f.jj('bookmark', 'set', 'main', '-r', '@-');
    const working = f.jj('--ignore-working-copy', 'log', '-G', '-r', '@', '-T', 'change_id');
    const incoming = f.publish('remote.md', 'Collaborator contribution\n');
    f.jj('git', 'fetch', '--remote', 'origin');
    assert.equal(f.jj('bookmark', 'list', 'main', '-T', 'if(!remote, conflict)'), 'true');
    assert.deepEqual(await trackedRemote(f.ctx), target);
    const conflicted = await repositoryRemoteHealth(f.ctx);
    assert.equal(conflicted.kind, 'conflict');
    assert.deepEqual([conflicted.ahead, conflicted.behind], [1, 1]);
    assert.equal(conflicted.refs.filter(ref => ref.name === 'main' && ref.conflicted).length, 2);
    await pullRepository(f.ctx, target);
    assert.equal(f.jj('bookmark', 'list', 'main', '-T', 'if(!remote, conflict)'), 'false');
    assert.equal(f.jj('log', '-G', '-r', 'main', '-T', 'commit_id'), f.jj('log', '-G', '-r', '@-', '-T', 'commit_id'));
    assert.equal(f.jj('log', '-G', '-r', '@', '-T', 'change_id'), working);
    assert.equal(f.read('local.md'), 'Local contribution\n');
    assert.equal(f.read('remote.md'), 'Collaborator contribution\n');
    assert.equal(f.remoteHead(), incoming, 'Pull must not publish local work');
    const recovered = await repositoryRemoteHealth(f.ctx);
    assert.equal(recovered.kind, 'ahead');
    assert.deepEqual([recovered.ahead, recovered.behind], [1, 0]);
    await pushRepository(f.ctx, await trackedRemote(f.ctx));
    assert.equal(f.remoteHead(), f.jj('log', '-G', '-r', '@-', '-T', 'commit_id'));
  } finally { f.clean(); }
});

test('JJ Pull repairs a lagging bookmark after an external rebase, even when already up to date', async () => {
  const f = remoteFixture('jj', false);
  try {
    f.write('local.md', 'Local contribution\n');
    await createChange(f.ctx, ['local.md'], 'Local contribution', (await getRepositoryStatus(f.ctx)).token);
    f.publish('remote.md', 'Collaborator contribution\n');
    f.jj('git', 'fetch', '--remote', 'origin');
    f.jj('rebase', '-b', '@', '-o', 'main@origin');
    const tip = f.jj('log', '-G', '-r', '@-', '-T', 'commit_id');
    assert.notEqual(f.jj('log', '-G', '-r', 'main', '-T', 'commit_id'), tip);
    assert.match((await pullRepository(f.ctx, await trackedRemote(f.ctx))).message, /Already up to date.*Aligned bookmark/);
    assert.equal(f.jj('log', '-G', '-r', 'main', '-T', 'commit_id'), tip);
    assert.equal(f.read('local.md'), 'Local contribution\n');
    await pushRepository(f.ctx, target);
    assert.equal(f.remoteHead(), tip);
  } finally { f.clean(); }
});

test('JJ previews conflicting local history without changing commits or producing conflict markers', async () => {
  const f = remoteFixture('jj', false);
  try {
    f.write('note.md', 'Local incompatible text\n');
    await createChange(f.ctx, ['note.md'], 'Local contribution', (await getRepositoryStatus(f.ctx)).token);
    const working = f.jj('log', '-G', '-r', '@', '-T', 'commit_id');
    const incoming = f.publish('note.md', 'Remote incompatible text\n');
    await assert.rejects(pullRepository(f.ctx, target), /Fetched origin\/main[\s\S]*conflict with local history[\s\S]*note.md/);
    assert.equal(f.jj('log', '-G', '-r', '@', '-T', 'commit_id'), working);
    assert.equal(f.jj('log', '-G', '-r', 'ancestors(@) & conflicts()', '-T', 'commit_id'), '');
    assert.equal(f.read('note.md'), 'Local incompatible text\n');
    assert.equal(f.remoteHead(), incoming);
    assert.equal((await repositoryRemoteHealth(f.ctx)).kind, 'diverged');
    assert.deepEqual(await trackedRemote(f.ctx), target, 'the refused Pull must not strand tracking');
    f.jj('rebase', '-b', '@', '-o', 'main@origin');
    const conflicted = await repositoryRemoteHealth(f.ctx);
    assert.equal(conflicted.kind, 'conflict');
    assert.deepEqual(conflicted.files, ['note.md']);
    assert.ok(conflicted.conflicts.length > 0);
    const status = await getRepositoryStatus(f.ctx);
    assert.ok(status.files.some(file => file.path === 'note.md' && file.status === 'U'), 'inherited conflicts remain visible even in an empty Workcopy change');
    await assert.rejects(createChange(f.ctx, ['note.md'], 'Cannot finalize conflicts', status.token), /Resolve conflicts/);
  } finally { f.clean(); }
});

test('JJ preserves independent topic descendants instead of rebasing them implicitly', async () => {
  const f = remoteFixture('jj', false);
  try {
    f.write('local.md', 'Local contribution\n');
    await createChange(f.ctx, ['local.md'], 'Local contribution', (await getRepositoryStatus(f.ctx)).token);
    f.jj('new', '--no-edit', '-r', '@-', '-m', 'Independent topic');
    f.jj('bookmark', 'set', 'topic', '-r', 'heads(@-::) ~ @');
    const before = f.jj('log', '-G', '-r', '@', '-T', 'commit_id');
    f.publish('remote.md', 'Collaborator contribution\n');
    await assert.rejects(pullRepository(f.ctx, target), /independent branches|another branch/);
    assert.equal(f.jj('log', '-G', '-r', '@', '-T', 'commit_id'), before);
    assert.equal(f.read('local.md'), 'Local contribution\n');
    assert.ok((await repositoryRemoteHealth(f.ctx)).refs.some(ref => ref.name === 'topic'), 'independent bookmarks stay visible in the timeline');
  } finally { f.clean(); }
});

test('JJ stops after fetching a rewritten remote instead of replaying published history', async () => {
  const f = remoteFixture('jj', false);
  try {
    f.write('local.md', 'Published local contribution\n');
    await createChange(f.ctx, ['local.md'], 'Published', (await getRepositoryStatus(f.ctx)).token);
    await pushRepository(f.ctx, target);
    const before = f.jj('log', '-G', '-r', '@', '-T', 'commit_id');
    f.write('peer.md', 'Rewritten peer history\n', f.other); f.peer('add', '.'); f.peer('commit', '-m', 'Rewrite remote'); f.peer('push', '--force', 'origin', 'main');
    await assert.rejects(pullRepository(f.ctx, target), /Fetched origin\/main[\s\S]*remote branch was rewritten/);
    assert.equal(f.jj('log', '-G', '-r', '@', '-T', 'commit_id'), before);
    assert.equal(f.read('local.md'), 'Published local contribution\n');
    assert.deepEqual(await trackedRemote(f.ctx), target);
  } finally { f.clean(); }
});

test('JJ can restore a deleted tracked local bookmark without losing its destination', async () => {
  const f = remoteFixture('jj', false);
  try {
    f.jj('bookmark', 'delete', 'main');
    assert.deepEqual(await trackedRemote(f.ctx), target);
    assert.equal((await repositoryRemoteHealth(f.ctx)).kind, 'blocked');
    await pullRepository(f.ctx, target);
    assert.equal(f.jj('log', '-G', '-r', 'main', '-T', 'commit_id'), f.remoteHead());
  } finally { f.clean(); }
});

test('JJ refuses unrelated histories after a rewrite was fetched outside the plugin', async () => {
  const f = remoteFixture('jj', false);
  try {
    f.write('local.md', 'Unpublished contribution\n');
    await createChange(f.ctx, ['local.md'], 'Local contribution', (await getRepositoryStatus(f.ctx)).token);
    const unrelated = f.peer('commit-tree', f.peer('rev-parse', 'HEAD^{tree}'), '-m', 'Unrelated root');
    f.peer('push', '--force', 'origin', `${unrelated}:refs/heads/main`);
    f.jj('git', 'fetch', '--remote', 'origin');
    const working = f.jj('log', '-G', '-r', '@', '-T', 'commit_id');
    await assert.rejects(pullRepository(f.ctx, await trackedRemote(f.ctx)), /no common ancestor/);
    assert.equal(f.jj('log', '-G', '-r', '@', '-T', 'commit_id'), working);
    assert.equal(f.read('local.md'), 'Unpublished contribution\n');
    assert.equal(f.remoteHead(), unrelated);
  } finally { f.clean(); }
});

test('JJ status reads preserve local ancestors after an external Git fetch rewrites remote refs', async () => {
  const f = remoteFixture('jj', true);
  try {
    f.jj('bookmark', 'track', 'main', '--remote', 'origin');
    f.write('local.md', 'Unpublished contribution\n');
    await createChange(f.ctx, ['local.md'], 'Local contribution', (await getRepositoryStatus(f.ctx)).token);
    const before = f.jj('log', '-G', '-r', '@', '-T', 'commit_id');
    const unrelated = f.peer('commit-tree', f.peer('rev-parse', 'HEAD^{tree}'), '-m', 'Unrelated root');
    f.peer('push', '--force', 'origin', `${unrelated}:refs/heads/main`);
    f.run('git', ['-C', f.ctx.root, 'fetch', 'origin']);
    await getRepositoryStatus(f.ctx);
    assert.equal(f.jj('--config', 'git.abandon-unreachable-commits=false', 'log', '-G', '-r', '@', '-T', 'commit_id'), before);
    assert.equal(f.read('note.md'), 'Initial note\n');
    assert.equal(f.read('local.md'), 'Unpublished contribution\n');
    const health = await repositoryRemoteHealth(f.ctx);
    assert.equal(health.kind, 'blocked', JSON.stringify(health));
    assert.match(health.summary, /no common ancestor/);
  } finally { f.clean(); }
});

test('JJ Push excludes pending content when the bookmark points directly at Workcopy', async () => {
  const f = remoteFixture('jj', false);
  try {
    f.write('local.md', 'Reviewed contribution\n');
    await createChange(f.ctx, ['local.md'], 'Reviewed', (await getRepositoryStatus(f.ctx)).token);
    const finalized = f.jj('log', '-G', '-r', '@-', '-T', 'commit_id');
    f.write('pending.md', 'Still reviewing\n'); f.jj('util', 'snapshot'); f.jj('bookmark', 'set', 'main', '-r', '@');
    const working = f.jj('log', '-G', '-r', '@', '-T', 'change_id');
    await pushRepository(f.ctx, target);
    assert.equal(f.remoteHead(), finalized);
    assert.equal(f.jj('log', '-G', '-r', 'main', '-T', 'commit_id'), finalized);
    assert.equal(f.jj('log', '-G', '-r', '@', '-T', 'change_id'), working);
    assert.equal(f.read('pending.md'), 'Still reviewing\n');
  } finally { f.clean(); }
});

for (const operation of ['merge', 'rebase'] as const) test(`Git keeps an unfinished ${operation} intact and explains it`, async () => {
  const f = remoteFixture();
  try {
    f.write('note.md', 'Local incompatible text\n');
    await createChange(f.ctx, ['note.md'], 'Local contribution', (await getRepositoryStatus(f.ctx)).token);
    f.publish('note.md', 'Remote incompatible text\n'); f.git('fetch', 'origin');
    assert.throws(() => f.git(operation, ...(operation === 'merge' ? ['--no-edit'] : []), 'origin/main'));
    const contents = f.read('note.md'), head = f.git('rev-parse', 'HEAD');
    const health = await repositoryRemoteHealth(f.ctx);
    assert.equal(health.kind, 'blocked'); assert.match(health.summary, new RegExp(operation));
    assert.deepEqual(health.files, ['note.md']);
    await assert.rejects(pullRepository(f.ctx, target), new RegExp(`current ${operation}`));
    await assert.rejects(pushRepository(f.ctx, target), new RegExp(`current ${operation}`));
    assert.equal(f.read('note.md'), contents); assert.equal(f.git('rev-parse', 'HEAD'), head);
  } finally { f.clean(); }
});
