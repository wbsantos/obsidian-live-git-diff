import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { App, TFile } from 'obsidian';
import { GitError, fileLog, readBaseAt, resolveGit, resolveRef } from '../src/git.ts';

/** Real repositories and directory links; junctions need no Windows symlink privilege. */
function fixture(t: test.TestContext) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lgd-resolve-'));
  t.after(() => {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('lgd-resolve-'));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, 'repo');
  const vault = path.join(temp, 'vault');
  const config = path.join(temp, 'empty.gitconfig');
  const hooks = path.join(temp, 'empty-hooks');
  fs.writeFileSync(config, '');
  fs.mkdirSync(hooks);
  fs.mkdirSync(root);
  fs.mkdirSync(vault);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config },
  });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  const rel = 'Função/Projeto com espaços/canônico/subpasta/uma nota.md';
  const text = '# Histórico\n\nConteúdo original.\n';
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
  fs.writeFileSync(path.join(root, 'root note.md'), text);
  git('add', '-A');
  git('-c', 'core.hooksPath=' + hooks, 'commit', '-q', '-m', 'Initial notes');
  const link = (target: string, alias: string) =>
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const app = (base: string, fullPath = true) => ({
    vault: { adapter: fullPath
      ? { getFullPath: (p: string) => path.join(base, p) }
      : { basePath: base } },
  }) as unknown as App;
  const file = (p: string) => ({ path: p }) as TFile;
  const check = (base: string, vaultRel: string, expectedRel = rel, fullPath = true,
                 expectedRoot = root) => {
    const ctx = resolveGit(app(base, fullPath), file(vaultRel));
    assert.equal(fs.realpathSync(ctx.root), fs.realpathSync(expectedRoot));
    assert.equal(ctx.rel, expectedRel);
    assert.equal(readBaseAt(ctx.root, ctx.rel, resolveRef(ctx.root, 'HEAD')).text, text);
    const history = fileLog(ctx.root, ctx.rel);
    assert.equal(history.length, 1);
    assert.equal(history[0].path, expectedRel, 'history preserves accented filenames');
    return ctx;
  };
  return { temp, root, vault, rel, link, app, file, check, git };
}

test('resolveGit: vault at the repository root, including a file at the root', (t) => {
  const f = fixture(t);
  f.check(f.root, f.rel);
  f.check(f.root, 'root note.md', 'root note.md');
});

test('resolveGit: vault nested in a repository, with either adapter API', (t) => {
  const f = fixture(t);
  const base = path.join(f.root, 'Função', 'Projeto com espaços');
  f.check(base, 'canônico/subpasta/uma nota.md');
  f.check(base, 'canônico/subpasta/uma nota.md', f.rel, false);
});

test('resolveGit: vault outside Git with a linked folder and nested, accented paths', (t) => {
  const f = fixture(t);
  f.link(path.join(f.root, 'Função', 'Projeto com espaços', 'canônico'), path.join(f.vault, 'alias'));
  f.check(f.vault, 'alias/subpasta/uma nota.md');
});

test('resolveGit: a link to the repository root works with the basePath fallback', (t) => {
  const f = fixture(t);
  f.link(f.root, path.join(f.vault, 'repo-alias'));
  f.check(f.vault, 'repo-alias/root note.md', 'root note.md', false);
});

test('resolveGit: the target repository wins over an unrelated vault repository', (t) => {
  const f = fixture(t);
  execFileSync('git', ['-C', f.vault, 'init', '-q']);
  f.link(f.root, path.join(f.vault, 'repo-alias'));
  f.check(f.vault, 'repo-alias/' + f.rel);
});

test('resolveGit: different linked folders resolve their own repositories', (t) => {
  const f = fixture(t);
  const worktree = path.join(f.temp, 'linked-worktree');
  f.git('worktree', 'add', '--detach', worktree, 'HEAD');
  f.link(f.root, path.join(f.vault, 'first'));
  f.link(worktree, path.join(f.vault, 'second'));
  f.check(f.vault, 'first/' + f.rel);
  f.check(f.vault, 'second/' + f.rel, f.rel, true, worktree);
});

test('resolveGit: a note outside Git still reports an explicit error', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.vault, 'local.md'), 'local');
  assert.throws(() => resolveGit(f.app(f.vault), f.file('local.md')),
    (e: Error) => e instanceof GitError && /Not inside a git repository/.test(e.message));
});

test('linked folder history: an accented filename survives a rename', (t) => {
  const f = fixture(t);
  const before = resolveRef(f.root, 'HEAD');
  const renamed = f.rel.replace('uma nota.md', 'nota renomeada.md');
  f.git('mv', f.rel, renamed);
  f.git('commit', '-q', '-m', 'Rename note');
  f.link(f.root, path.join(f.vault, 'alias'));
  const ctx = resolveGit(f.app(f.vault), f.file('alias/' + renamed));
  const old = readBaseAt(ctx.root, ctx.rel, before);
  assert.equal(old.path, f.rel);
  assert.equal(old.renamedFrom, f.rel);
  assert.match(old.text, /Conteúdo original/);
});
