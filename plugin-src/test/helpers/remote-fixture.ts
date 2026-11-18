import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { GitContext } from '../../src/git.ts';

export function remoteFixture(backend: 'git' | 'jj' = 'git', colocate = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgd-remote-'));
  const local = path.join(dir, 'local'), remote = path.join(dir, 'remote.git'), other = path.join(dir, 'other');
  const run = (tool: string, args: string[], cwd = dir) => execFileSync(tool, args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  }).trim();
  const git = (...args: string[]) => run('git', ['-C', local, ...args]);
  const peer = (...args: string[]) => run('git', ['-C', other, ...args]);
  const jj = (...args: string[]) => run('jj', ['--no-pager', '--color=never', '--config', 'user.name="QA"', '--config', 'user.email="qa@localhost"', '-R', local, ...args]);
  run('git', ['init', '--bare', '--initial-branch=main', remote]);
  run('git', ['-c', 'core.autocrlf=false', 'clone', remote, local]);
  git('config', 'user.name', 'QA'); git('config', 'user.email', 'qa@localhost'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(local, 'note.md'), 'Initial note\n');
  git('add', '.'); git('commit', '-m', 'Initial'); git('push', '-u', 'origin', 'main');
  run('git', ['-c', 'core.autocrlf=false', 'clone', remote, other]);
  peer('config', 'user.name', 'QA'); peer('config', 'user.email', 'qa@localhost'); peer('config', 'commit.gpgsign', 'false'); peer('config', 'core.autocrlf', 'false');
  if (backend === 'jj') {
    if (colocate) run('jj', ['git', 'init', '--colocate', local]);
    else {
      const isolated = path.join(dir, 'isolated');
      run('jj', ['git', 'clone', '--no-colocate', remote, isolated]);
      // Keep cleanup confined to our verified temporary root; Git clone was only a seed.
      assert.equal(path.dirname(local), dir); fs.rmSync(local, { recursive: true }); fs.renameSync(isolated, local);
    }
    jj('config', 'set', '--repo', 'user.name', 'QA'); jj('config', 'set', '--repo', 'user.email', 'qa@localhost');
  }
  const ctx: GitContext = { abs: local, rel: '', root: backend === 'jj' ? jj('git', 'root') : local, backend, workspaceRoot: backend === 'jj' ? local : undefined };
  const write = (name: string, content: string, cwd = local) => { fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true }); fs.writeFileSync(path.join(cwd, name), content); };
  const publish = (name: string, content: string) => { write(name, content, other); peer('add', '.'); peer('commit', '-m', 'Peer update'); peer('push', 'origin', 'main'); return peer('rev-parse', 'HEAD'); };
  const read = (name: string) => fs.readFileSync(path.join(local, name), 'utf8');
  const remoteHead = () => run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main']);
  const clean = () => { assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('lgd-remote-')); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, local, other, remote, ctx, run, git, peer, jj, write, publish, read, remoteHead, clean };
}
