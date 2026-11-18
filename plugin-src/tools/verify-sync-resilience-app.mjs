/** Native UI recovery checks. All VCS mutations use disposable local repositories. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.mjs';
import { remoteFixture } from '../test/helpers/remote-fixture.ts';
import { createChange, getRepositoryStatus } from '../src/repositoryManager.ts';

const config = JSON.parse(fs.readFileSync('../.npm-cache/jj-app-qa/manifest.json', 'utf8'));
assert.ok(path.resolve(config.vault).startsWith(path.resolve('../.npm-cache') + path.sep));
const output = path.resolve('../.npm-cache/sync-resilience-ui'); fs.mkdirSync(output, { recursive: true });
const cdp = await connect(config.port), fixtures = [], results = [];
const e = code => cdp.evaluate(`const p=app.plugins.plugins['live-git-diff'];${code}`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, value) => { assert.ok(value, name); results.push(name); console.log('PASS ' + name); };
async function until(expression) {
  for (let i = 0; i < 600; i++) { if (await e(`return ${expression};`)) return; await pause(100); }
  throw new Error('Timed out: ' + expression);
}
async function shot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data, 'base64'));
}
async function navigate(fixture) {
  await e(`await p.navigateRepository({kind:'log',context:${JSON.stringify(fixture.ctx)}});app.workspace.rightSplit.expand();app.workspace.rightSplit.setSize(470);`);
  await until(`!p.repositoryView().loading&&!!p.repositoryView().remoteHealth`);
}
async function action(name) {
  await e(`p.repositoryView().contentEl.querySelector('[aria-label="${name}"]').click();`);
  await until(`!p.repositoryView().mutating&&!p.repositoryView().loading&&!p.remoteJobs.size`);
}

try {
  assert.equal(path.resolve(await e('return app.vault.adapter.getBasePath();')), path.resolve(config.vault));
  await e(`p.closeReview();await app.plugins.disablePlugin('live-git-diff');`);
  for (const name of ['main.js', 'styles.css', 'manifest.json']) fs.copyFileSync(path.resolve('../plugin-dist', name), path.join(config.vault, '.obsidian/plugins/live-git-diff', name));
  await cdp.evaluate(`await app.plugins.loadManifests();await app.plugins.enablePlugin('live-git-diff');require('@electron/remote').getCurrentWindow().webContents.setBackgroundThrottling(false);`);
  await e(`window.__syncErrors=[];window.addEventListener('error',event=>window.__syncErrors.push(event.message));
    window.addEventListener('unhandledrejection',event=>window.__syncErrors.push(String(event.reason)));
    document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  const jj = remoteFixture('jj', false); fixtures.push(jj);
  jj.write('local.md', 'Local contribution\n');
  await createChange(jj.ctx, ['local.md'], 'Local contribution', (await getRepositoryStatus(jj.ctx)).token);
  jj.jj('bookmark', 'set', 'main', '-r', '@-'); jj.publish('remote.md', 'Collaborator contribution\n'); jj.jj('git', 'fetch', '--remote', 'origin');
  await navigate(jj);
  check('Conflicted bookmarks keep the timeline visible and show both targets', await e(`const v=p.repositoryView();return v.remoteHealth.kind==='conflict'&&v.contentEl.querySelectorAll('.lgd-repository-ref[data-conflict="true"]').length>=2&&v.contentEl.querySelectorAll('.lgd-repository-change').length>=3;`));
  await shot('bookmark-conflict-light');
  await action('Pull');
  check('Pull reconciles local changes and reports bookmark alignment in the UI', await e(`const v=p.repositoryView();return !v.error&&v.remoteHealth.kind==='ahead'&&v.contentEl.querySelector('.lgd-repository-sync-status').textContent.includes('Rebased 1 local change');`));
  check('The canonical bookmark points to the finalized tip', jj.jj('log', '-G', '-r', 'main', '-T', 'commit_id') === jj.jj('log', '-G', '-r', '@-', '-T', 'commit_id'));
  await action('Push');
  check('Push works again after recovery', await e(`return !p.repositoryView().error&&p.repositoryView().remoteHealth.kind==='ready';`));
  jj.peer('pull', '--ff-only');
  jj.write('note.md', 'Incompatible local text\n');
  await createChange(jj.ctx, ['note.md'], 'Local incompatible contribution', (await getRepositoryStatus(jj.ctx)).token);
  jj.publish('note.md', 'Incompatible collaborator text\n');
  await action('Pull');
  check('A refused integration explains that fetch succeeded and names the conflict', await e(`const v=p.repositoryView(),text=v.contentEl.querySelector('.lgd-repository-sync-status').textContent;return v.error.includes('Fetched origin/main')&&text.includes('conflict with local history')&&text.includes('note.md');`));
  await e(`await p.repositoryView().refresh();`);
  check('Refreshing retains the failed Pull outcome and the history', await e(`const v=p.repositoryView();return v.contentEl.querySelector('.lgd-repository-sync-status').textContent.includes('conflict with local history')&&v.contentEl.querySelectorAll('.lgd-repository-change').length>=4;`));
  await shot('integration-refused-light');
  jj.jj('rebase', '-b', '@', '-o', 'main@origin');
  await e(`await p.repositoryView().refresh();document.body.classList.remove('theme-light');document.body.classList.add('theme-dark');`);
  check('Unresolved inherited conflicts are visible on history entries', await e(`const v=p.repositoryView();return v.remoteHealth.kind==='conflict'&&v.contentEl.textContent.includes('File conflicts')&&v.remoteHealth.files.includes('note.md');`));
  await e(`p.repositoryView().contentEl.querySelector('.lgd-repository-sync-files').click();`);
  await until(`p.repositoryView().currentRoute.kind==='changes'&&!p.repositoryView().loading`);
  check('Pending Changes includes inherited conflicts in an otherwise empty Workcopy', await e(`const v=p.repositoryView();return v.status.files.some(f=>f.path==='note.md'&&f.status==='U')&&!!v.contentEl.querySelector('[data-status="U"]');`));
  await e(`const v=p.repositoryView();v.state.description='Cannot finalize conflicts';v.state.selected=new Set(['note.md']);v.render();`);
  check('Creating a change stays disabled while file conflicts remain', await e(`return p.repositoryView().contentEl.querySelector('.mod-cta').disabled;`));
  await shot('file-conflicts-dark');
  const git = remoteFixture(); fixtures.push(git);
  git.write('note.md', 'Local text\n'); await createChange(git.ctx, ['note.md'], 'Local change', (await getRepositoryStatus(git.ctx)).token);
  git.publish('note.md', 'Collaborator text\n'); git.git('fetch', 'origin');
  assert.throws(() => git.git('rebase', 'origin/main'));
  await navigate(git);
  check('An unfinished Git rebase has a clear persistent status and a usable timeline', await e(`const v=p.repositoryView();return v.remoteHealth.kind==='blocked'&&v.contentEl.textContent.includes('Unfinished rebase')&&v.contentEl.querySelectorAll('.lgd-repository-change').length>=2;`));
  const before = git.read('note.md'); await action('Pull');
  check('Pull preserves the unfinished Git operation', git.read('note.md') === before && await e(`return p.repositoryView().error.includes('current rebase');`));
  await shot('git-rebase-dark');
  check('No renderer errors', (await e(`return window.__syncErrors;`)).length === 0);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
  console.log('Native resilience checks passed: ' + output);
} catch (error) {
  await shot('failed'); throw error;
} finally {
  await e(`p.repositoryView()?.leaf.detach();`).catch(() => {});
  cdp.close();
  for (const fixture of fixtures) fixture.clean();
}
