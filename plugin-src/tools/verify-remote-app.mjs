/** Native Obsidian push/pull QA using a local bare remote in the isolated scratch vault.
 * Run after installing the current build into the vault from repository-qa-latest.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connect } from './cdp.mjs';

const manifest = JSON.parse(fs.readFileSync('../.npm-cache/repository-qa-latest.json', 'utf8'));
const vault = path.resolve(manifest.vault), scratch = path.dirname(vault);
assert.ok(path.basename(scratch).startsWith('review-qa-'), 'Use only an isolated review QA vault.');
assert.equal(path.basename(vault), 'vault');
const bare = path.join(scratch, 'remote-backup.git');
const output = path.resolve('../docs/screenshots/repository');
const run = (binary, args, cwd = vault) => execFileSync(binary, args, {
  cwd, encoding: 'utf8', windowsHide: true, timeout: 30000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const jj = (...args) => run('jj', ['--no-pager', '--color=never', ...args]);
const git = (cwd, ...args) => run('git', ['-c', 'commit.gpgsign=false', ...args], cwd);
const c = await connect(manifest.port);
const e = code => c.evaluate(`const p=app.plugins.plugins['live-git-diff'];${code}`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let attempt = 0; attempt < 300; attempt++) { if (await e(`return ${code}`)) return; await pause(100); }
  throw new Error('Timed out: ' + code);
}
async function shot(name) {
  await pause(350);
  const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data, 'base64'));
  console.log('Captured ' + name);
}
async function contextMenu() {
  await e(`const element=p.repositoryView().contentEl.querySelector('.lgd-repository-location');
    const box=element.getBoundingClientRect();element.dispatchEvent(new MouseEvent('contextmenu',
      {bubbles:true,cancelable:true,clientX:box.left+24,clientY:box.bottom}));return true;`);
  await until("Array.from(document.querySelectorAll('.menu-item-title')).some(item=>item.textContent==='Remote settings')");
}

try {
  assert.equal(path.resolve(await c.evaluate('return app.vault.adapter.basePath;')), vault);
  await until('!!p');
  assert.equal(await e("return typeof p.syncRepository"), 'function', 'Install the current remote feature build first.');
  if (!fs.existsSync(bare)) git(scratch, 'init', '--bare', '--initial-branch=main', bare);
  const remotes = jj('git', 'remote', 'list');
  const existing = remotes.split(/\r?\n/).find(line => line.startsWith('backup '));
  if (existing) assert.equal(path.resolve(existing.slice('backup '.length).trim()), bare, 'Do not replace an unrelated remote.');
  else jj('git', 'remote', 'add', 'backup', bare);

  fs.mkdirSync(output, { recursive: true });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1560, height: 1080, deviceScaleFactor: 1, mobile: false });
  await e(`const window=require('@electron/remote').getCurrentWindow();
    window.webContents.setBackgroundThrottling(false);window.webContents.setZoomFactor(1);
    document.querySelector('.modal-close-button')?.click();
    document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');
    p.closeReview();app.workspace.detachLeavesOfType('live-git-diff-explain');
    const file=app.vault.getAbstractFileByPath('Stories/Approval.md');
    const leaf=app.workspace.getLeavesOfType('markdown')[0] || app.workspace.getLeaf('tab');
    await leaf.openFile(file);await leaf.setViewState({type:'markdown',state:{file:file.path,mode:'preview'},active:true});
    app.workspace.leftSplit.expand();app.workspace.leftSplit.setSize(240);
    app.workspace.rightSplit.expand();app.workspace.rightSplit.setSize(460);
    await p.openRepository(file);return true;`);
  assert.equal(await e('return p.repositoryView().currentRoute.context.backend'), 'jj');
  assert.equal(await e('return p.repositoryView().error'), '');
  await contextMenu();
  await e("Array.from(document.querySelectorAll('.menu-item-title')).find(item=>item.textContent==='Remote settings').click();return true;");
  await until("document.querySelector('.modal-title')?.textContent==='Remote'");
  await e(`const remote=document.querySelector('.modal [aria-label="Remote"]'),branch=document.querySelector('.modal [aria-label="Branch"]');
    remote.value='backup';remote.dispatchEvent(new Event('change',{bubbles:true}));
    branch.value='main';branch.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
  await shot('remote-settings');
  await e("Array.from(document.querySelectorAll('.modal button')).find(button=>button.textContent==='Save').click();return true;");
  await until("!document.querySelector('.modal')&&!p.repositoryView().mutating");
  assert.ok(await e("return Object.values(p.settings.remoteTargets).some(target=>target.remote==='backup'&&target.branch==='main')"));

  const approval = fs.readFileSync(path.join(vault, 'Stories/Approval.md'), 'utf8');
  const changeId = jj('--ignore-working-copy', 'log', '-G', '-r', '@', '-T', 'change_id');
  const finalized = jj('--ignore-working-copy', 'log', '-G', '-r', '@-', '-T', 'commit_id');
  await e("p.repositoryView().contentEl.querySelector('[aria-label=\"Push\"]').click();return true;");
  await until('!p.repositoryView().mutating&&!p.repositoryView().loading&&!p.remoteJobs.size');
  assert.equal(await e('return p.repositoryView().error'), '');
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), finalized);
  assert.equal(fs.readFileSync(path.join(vault, 'Stories/Approval.md'), 'utf8'), approval);
  assert.equal(jj('--ignore-working-copy', 'log', '-G', '-r', '@', '-T', 'change_id'), changeId);
  await until("!document.querySelector('.notice')");
  await contextMenu();
  assert.deepEqual(await e("return Array.from(document.querySelectorAll('.menu-item-title')).map(item=>item.textContent).filter(value=>['Push','Pull','Remote settings'].includes(value))"), ['Pull', 'Push', 'Remote settings']);
  await shot('remote-actions');
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  const peer = fs.mkdtempSync(path.join(scratch, 'remote-peer-'));
  git(scratch, 'clone', '--branch', 'main', bare, peer);
  git(peer, 'config', 'user.name', 'Review QA'); git(peer, 'config', 'user.email', 'qa@example.test');
  git(peer, 'config', 'core.autocrlf', 'false'); git(peer, 'config', 'core.hooksPath', path.join(peer, '.qa-no-hooks'));
  const remoteText = '# Remote backup\n\nReview updates shared by the occasional contributor.\n\nRevision ' + Date.now() + '.\n';
  fs.writeFileSync(path.join(peer, 'Remote backup.md'), remoteText);
  git(peer, 'add', '--', 'Remote backup.md'); git(peer, 'commit', '-m', 'Share review updates from remote');
  const incoming = git(peer, 'rev-parse', 'HEAD'); git(peer, 'push', 'origin', 'main');
  await e("p.repositoryView().contentEl.querySelector('[aria-label=\"Pull\"]').click();return true;");
  await until('!p.repositoryView().mutating&&!p.repositoryView().loading&&!p.remoteJobs.size');
  assert.equal(await e('return p.repositoryView().error'), '');
  assert.equal(jj('--ignore-working-copy', 'log', '-G', '-r', '@-', '-T', 'commit_id'), incoming);
  assert.equal(jj('--ignore-working-copy', 'log', '-G', '-r', '@', '-T', 'change_id'), changeId);
  assert.equal(fs.readFileSync(path.join(vault, 'Stories/Approval.md'), 'utf8'), approval);
  assert.equal(fs.readFileSync(path.join(vault, 'Remote backup.md'), 'utf8'), remoteText);
  await until("!!app.vault.getAbstractFileByPath('Remote backup.md')");
  assert.ok(await e("return p.repositoryView().changes.some(change=>change.sha===" + JSON.stringify(incoming) + ")"));
  console.log('Native Obsidian: remote configuration persisted, finalized change pushed, remote contribution pulled, pending story and working change preserved, history refreshed.');
  console.log(output);
} finally { c.close(); }
