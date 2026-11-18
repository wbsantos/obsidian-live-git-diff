import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getRepositoryRemotes, trackedRemote, repositorySyncState, pushRepository, pullRepository } from '../src/repositoryRemote.ts';
import { createChange, getRepositoryStatus } from '../src/repositoryManager.ts';

import { remoteFixture as fixture } from './helpers/remote-fixture.ts';

const target = { remote: 'origin', branch: 'main' };
const cases = [['git', true], ['jj', true], ['jj', false]] as const;

for (const [backend, colocate] of cases) test(`history sync colors reflect the configured remote ancestry before and after push (${backend}, colocated=${colocate})`, async () => {
  const f=fixture(backend,colocate);
  try {
    const initial=f.remoteHead();
    assert.deepEqual(await trackedRemote(f.ctx),target);
    f.write('note.md','Local change\n');
    await createChange(f.ctx,['note.md'],'Local change',(await getRepositoryStatus(f.ctx)).token);
    const current=backend==='git'?f.git('rev-parse','HEAD'):f.jj('log','-G','-r','@-','-T','commit_id');
    const before=await repositorySyncState(f.ctx,[current,initial]);
    assert.equal(before.remote,'origin/main');assert.equal(before.warning,undefined);
    assert.deepEqual(before.synced,[initial]);
    await pushRepository(f.ctx,await trackedRemote(f.ctx));
    assert.deepEqual(new Set((await repositorySyncState(f.ctx,[current,initial])).synced),new Set([current,initial]));
  } finally {f.clean();}
});

test('remote discovery follows a differently named upstream and never guesses origin when tracking is absent',async()=>{
  const f=fixture();
  try {
    f.git('branch','-m','local-review');
    assert.deepEqual(await trackedRemote(f.ctx),target,'upstream branch is main, not local-review');
    f.git('branch','--unset-upstream');
    assert.equal((await getRepositoryRemotes(f.ctx)).suggested,undefined);
    await assert.rejects(trackedRemote(f.ctx),/no remote upstream/);
    const sync=await repositorySyncState(f.ctx,[f.git('rev-parse','HEAD')]);
    assert.deepEqual(sync.synced,[]);assert.match(sync.warning!,/No remote upstream/);
  } finally {f.clean();}
});

test('a colocated workspace without Git upstream does not infer another branch destination',async()=>{
  const f=fixture('jj',true);
  try {
    f.git('branch','--unset-upstream');
    await assert.rejects(trackedRemote(f.ctx),/No unique tracked remote bookmark/);
  } finally {f.clean();}
});

for (const [backend, colocate] of cases) {
  const label = `${backend}, colocated=${colocate}`;
  test(`Remote discovery infers existing tracking without network (${label})`, async () => {
    const f = fixture(backend, colocate);
    try {
      const actual = await getRepositoryRemotes(f.ctx);
      assert.deepEqual(actual.remotes, ['origin']); assert.ok(actual.branches.includes('main'));
      assert.deepEqual(actual.suggested, target);
    } finally { f.clean(); }
  });

  test(`Push publishes finalized changes and preserves pending edits (${label})`, async () => {
    const f = fixture(backend, colocate);
    try {
      f.write('note.md', 'Reviewed note\n');
      await createChange(f.ctx, ['note.md'], 'Reviewed', (await getRepositoryStatus(f.ctx)).token);
      const finalized = backend === 'jj' ? f.jj('log', '-G', '-r', '@-', '-T', 'commit_id') : f.git('rev-parse', 'HEAD');
      f.write('pending.md', 'Still reviewing\n');
      const currentChange = backend === 'jj' ? f.jj('log', '-G', '-r', '@', '-T', 'change_id') : '';
      assert.match((await pushRepository(f.ctx, target)).message, /Pushed to origin\/main/);
      assert.equal(f.remoteHead(), finalized); assert.equal(f.read('pending.md'), 'Still reviewing\n');
      if (backend === 'jj') {
        assert.equal(f.jj('log', '-G', '-r', 'main', '-T', 'commit_id'), finalized);
        assert.equal(f.jj('log', '-G', '-r', '@', '-T', 'change_id'), currentChange);
      }
      assert.deepEqual((await getRepositoryStatus(f.ctx)).files.map(file => file.path), ['pending.md']);
    } finally { f.clean(); }
  });

  test(`Partial push publishes only through the selected change and preserves later work (${label})`, async () => {
    const f = fixture(backend, colocate);
    try {
      f.write('first.md', 'First review\n');
      await createChange(f.ctx, ['first.md'], 'First review', (await getRepositoryStatus(f.ctx)).token);
      const first = backend === 'jj' ? f.jj('log', '-G', '-r', '@-', '-T', 'commit_id') : f.git('rev-parse', 'HEAD');
      f.write('second.md', 'Second review\n');
      await createChange(f.ctx, ['second.md'], 'Second review', (await getRepositoryStatus(f.ctx)).token);
      const second = backend === 'jj' ? f.jj('log', '-G', '-r', '@-', '-T', 'commit_id') : f.git('rev-parse', 'HEAD');
      if (backend === 'jj') f.jj('bookmark', 'set', 'main', '-r', second);
      f.write('pending.md', 'Pending work\n');
      await pushRepository(f.ctx, target, undefined, first);
      assert.equal(f.remoteHead(), first);
      assert.equal(backend === 'jj' ? f.jj('log', '-G', '-r', '@-', '-T', 'commit_id') : f.git('rev-parse', 'HEAD'), second);
      if (backend === 'jj') assert.equal(f.jj('log', '-G', '-r', 'main', '-T', 'commit_id'), second);
      assert.equal(f.read('pending.md'), 'Pending work\n');
      const state = await repositorySyncState(f.ctx, [first, second]);
      assert.deepEqual(state.synced, [first]);
      await pushRepository(f.ctx, target);
      assert.equal(f.remoteHead(), second);
    } finally { f.clean(); }
  });

  test(`Partial push rejects unrelated and stale changes without overwriting the remote (${label})`, async () => {
    const f = fixture(backend, colocate);
    try {
      f.write('first.md', 'First review\n');
      await createChange(f.ctx, ['first.md'], 'First review', (await getRepositoryStatus(f.ctx)).token);
      const first = backend === 'jj' ? f.jj('log', '-G', '-r', '@-', '-T', 'commit_id') : f.git('rev-parse', 'HEAD');
      f.write('second.md', 'Second review\n');
      await createChange(f.ctx, ['second.md'], 'Second review', (await getRepositoryStatus(f.ctx)).token);
      const second = backend === 'jj' ? f.jj('log', '-G', '-r', '@-', '-T', 'commit_id') : f.git('rev-parse', 'HEAD');
      await pushRepository(f.ctx, target, undefined, second);
      f.peer('pull', '--ff-only');
      const unrelated = f.publish('other.md', 'Other branch\n');
      f.run('git', ['--git-dir', backend === 'jj' && !colocate ? f.ctx.root : path.join(f.local, '.git'), 'fetch', 'origin']);
      await assert.rejects(pushRepository(f.ctx, target, undefined, unrelated), /not an ancestor/i);
      await assert.rejects(pushRepository(f.ctx, target, undefined, first), /rejected|non-fast-forward|fetch first|not an ancestor/i);
      await assert.rejects(pushRepository(f.ctx, target, undefined, 'HEAD'), /Invalid change identifier/);
      assert.equal(f.remoteHead(), unrelated);
    } finally { f.clean(); }
  });

  test(`Pull fast-forwards and preserves disjoint pending edits (${label})`, async () => {
    const f = fixture(backend, colocate);
    try {
      f.write('pending.md', 'Still reviewing\n');
      const currentChange = backend === 'jj' ? f.jj('log', '-G', '-r', '@', '-T', 'change_id') : '';
      const incoming = f.publish('note.md', 'Peer improved the note\n');
      assert.match((await pullRepository(f.ctx, target)).message, /Pulled from origin\/main/);
      assert.ok((await repositorySyncState(f.ctx,[incoming])).synced.includes(incoming),'the fetched commit is shown as synchronized after Pull');
      assert.equal(f.read('note.md'), 'Peer improved the note\n'); assert.equal(f.read('pending.md'), 'Still reviewing\n');
      assert.equal(backend === 'jj' ? f.jj('log', '-G', '-r', '@-', '-T', 'commit_id') : f.git('rev-parse', 'HEAD'), incoming);
      if (backend === 'jj') assert.equal(f.jj('log', '-G', '-r', '@', '-T', 'change_id'), currentChange);
      assert.match((await pullRepository(f.ctx, target)).message, /Already up to date/);
    } finally { f.clean(); }
  });

  test(`Divergent remote is preserved while local integration follows the backend (${label})`, async () => {
    const f = fixture(backend, colocate);
    try {
      f.write('note.md', 'Local review\n');
      await createChange(f.ctx, ['note.md'], 'Local review', (await getRepositoryStatus(f.ctx)).token);
      const before = backend === 'jj' ? f.jj('log', '-G', '-r', '@-', '-T', 'commit_id') : f.git('rev-parse', 'HEAD');
      const incoming = f.publish('other.md', 'Remote review\n');
      await assert.rejects(pushRepository(f.ctx, target), /rejected|fetch first|non-fast-forward/i);
      if (backend === 'jj') {
        assert.match((await pullRepository(f.ctx, target)).message, /Rebased 1 local change/);
        assert.equal(f.read('other.md'), 'Remote review\n');
      } else await assert.rejects(pullRepository(f.ctx, target), /diverged/);
      assert.equal(f.remoteHead(), incoming); assert.equal(f.read('note.md'), 'Local review\n');
      if (backend !== 'jj') assert.equal(f.git('rev-parse', 'HEAD'), before);
    } finally { f.clean(); }
  });

  test(`Pull refuses overlapping pending edits (${label})`, async () => {
    const f = fixture(backend, colocate);
    try {
      f.write('note.md', 'Pending local text\n');
      const before = backend === 'jj' ? f.jj('log', '-G', '-r', '@-', '-T', 'commit_id') : f.git('rev-parse', 'HEAD');
      f.publish('note.md', 'Incoming remote text\n');
      await assert.rejects(pullRepository(f.ctx, target), /overlap|overwritten/i);
      assert.equal(f.read('note.md'), 'Pending local text\n');
      assert.equal(backend === 'jj' ? f.jj('log', '-G', '-r', '@-', '-T', 'commit_id') : f.git('rev-parse', 'HEAD'), before);
      if (backend === 'jj') assert.equal(f.jj('log', '-G', '-r', '@', '-T', 'conflict'), 'false');
    } finally { f.clean(); }
  });
}

test('Only the selected remote branch is pushed despite mirror/followTags configuration', async () => {
  const f = fixture();
  try {
    f.git('config', 'remote.origin.mirror', 'true'); f.git('config', 'push.followTags', 'true');
    f.git('tag', '-a', 'private-tag', '-m', 'Do not publish'); f.git('branch', 'private-branch');
    await pushRepository(f.ctx, { remote: 'origin', branch: 'backup/notes' });
    const refs = f.run('git', ['--git-dir', f.remote, 'for-each-ref', '--format=%(refname)']);
    assert.match(refs, /refs\/heads\/backup\/notes/); assert.doesNotMatch(refs, /private-/);
  } finally { f.clean(); }
});

test('Invalid target and detached Git HEAD cannot mutate remotes', async () => {
  const f = fixture();
  try {
    const before = f.remoteHead();
    await assert.rejects(pushRepository(f.ctx, { remote: 'missing', branch: 'main' }), /configured remote/);
    await assert.rejects(pushRepository(f.ctx, { remote: 'origin', branch: ':refs/heads/main' }), /valid remote branch/);
    await assert.rejects(pullRepository(f.ctx, { remote: '--all', branch: 'main' }), /configured remote/);
    f.git('checkout', '--detach');
    await assert.rejects(pushRepository(f.ctx, target), /local branch/);
    await assert.rejects(pullRepository(f.ctx, target), /local branch/);
    assert.equal(f.remoteHead(), before);
  } finally { f.clean(); }
});

for (const [backend, colocate] of cases) test(`Pull protects ignored files (${backend}, colocated=${colocate})`, async () => {
  const f = fixture(backend, colocate);
  try {
    f.write('.gitignore', 'private.md\n');
    await createChange(f.ctx, ['.gitignore'], 'Ignore local file', (await getRepositoryStatus(f.ctx)).token);
    await pushRepository(f.ctx, target);
    f.peer('pull', '--ff-only');
    f.write('private.md', 'Local ignored text\n');
    f.write('private.md', 'Incoming text\n', f.other);
    f.peer('add', '--force', 'private.md'); f.peer('commit', '-m', 'Track shared file'); f.peer('push', 'origin', 'main');
    const before = backend === 'jj' ? f.jj('log', '-G', '-r', '@-', '-T', 'commit_id') : f.git('rev-parse', 'HEAD');
    await assert.rejects(pullRepository(f.ctx, target), /overlap|overwritten/i);
    assert.equal(f.read('private.md'), 'Local ignored text\n');
    assert.equal(backend === 'jj' ? f.jj('log', '-G', '-r', '@-', '-T', 'commit_id') : f.git('rev-parse', 'HEAD'), before);
    fs.unlinkSync(path.join(f.local, 'private.md'));
    await pullRepository(f.ctx, target);
    assert.equal(f.read('private.md'), 'Incoming text\n');
  } finally { f.clean(); }
});

test('JJ retains the tracked remote when a local bookmark advances ahead of it', async () => {
  const f = fixture('jj');
  try {
    f.jj('git', 'remote', 'rename', 'origin', 'backup');
    f.jj('git', 'remote', 'add', 'origin', f.remote);
    f.jj('bookmark', 'track', 'main', '--remote', 'backup');
    f.write('note.md', 'Next review\n');
    await createChange(f.ctx, ['note.md'], 'Next review', (await getRepositoryStatus(f.ctx)).token);
    f.jj('bookmark', 'set', 'main', '-r', '@-');
    assert.deepEqual((await getRepositoryRemotes(f.ctx)).suggested, { remote: 'backup', branch: 'main' });
  } finally { f.clean(); }
});

test('JJ protects a pending rename source and leading-space paths, then permits a retry', async () => {
  const f = fixture('jj');
  try {
    f.write(' leading.md', 'Before\n');
    await createChange(f.ctx, [' leading.md'], 'Add leading-space note', (await getRepositoryStatus(f.ctx)).token);
    await pushRepository(f.ctx, target); f.peer('pull', '--ff-only');
    fs.renameSync(path.join(f.local, ' leading.md'), path.join(f.local, 'renamed.md'));
    f.publish(' leading.md', 'Incoming\n');
    await assert.rejects(pullRepository(f.ctx, target), /overlap/);
    assert.equal(f.read('renamed.md'), 'Before\n');
    assert.equal(f.jj('log', '-G', '-r', '@', '-T', 'conflict'), 'false');
    fs.renameSync(path.join(f.local, 'renamed.md'), path.join(f.local, ' leading.md'));
    await pullRepository(f.ctx, target);
    assert.equal(f.read(' leading.md'), 'Incoming\n');
  } finally { f.clean(); }
});
