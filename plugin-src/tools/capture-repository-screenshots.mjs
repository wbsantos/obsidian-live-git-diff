/** Capture real Obsidian screens from the isolated QA vault. Runs two AI requests unless --history-only. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { connect } from './cdp.mjs';

const manifest = JSON.parse(fs.readFileSync('../.npm-cache/repository-qa-latest.json', 'utf8'));
const output = path.resolve('../docs/screenshots/repository');
const c = await connect(manifest.port);
const e = code => c.evaluate(`const p=app.plugins.plugins['live-git-diff'];${code}`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function shot(name) {
  await pause(350);
  const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data, 'base64'));
  console.log('Captured ' + name);
}
try {
  assert.equal(path.resolve(await e('return app.vault.adapter.basePath;')), path.resolve(manifest.vault));
  assert.ok(path.basename(path.dirname(manifest.vault)).startsWith('review-qa-'), 'Use only the isolated QA vault.');
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
  assert.equal(await e('return p.repositoryView().error;'), '');
  await shot('repository-history');
  await e("await p.openRepository(app.vault.getAbstractFileByPath('Stories'));return true;");
  await shot('folder-history');
  await e(`const v=p.repositoryView(),change=v.changes.find(change=>change.subject==='Refine approval rules');
    await p.navigateRepository({kind:'details',context:v.currentRoute.context,sha:change.sha});return true;`);
  await shot('change-details');
  if (!process.argv.includes('--history-only')) {
  await e("await p.openChanges(app.vault.getAbstractFileByPath('Stories/Approval.md'));return true;");
  assert.ok(await e('return p.repositoryView().state.selected.size>0;'));
  await shot('pending-changes');
  await e('await p.repositoryView().generateDescription();return true;');
  assert.equal(await e('return p.repositoryView().error;'), '');
  assert.ok(await e('return p.repositoryView().state.description.length>0;'));
  await shot('generated-description');
  await e("await p.explainFile(app.vault.getAbstractFileByPath('Stories/Approval.md'));return true;");
  assert.equal(await e('return !!app.workspace.getLeavesOfType("live-git-diff-explain")[0].view.contentEl.querySelector(".lgd-error");'), false);
  await shot('explain-light');
  await e("document.body.classList.remove('theme-light');document.body.classList.add('theme-dark');return true;");
  await shot('explain-dark');
  await e("document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');app.setting.open();app.setting.openTabById('live-git-diff');return true;");
  assert.equal(await e('return document.querySelectorAll(".lgd-ai-prompt").length;'), 2);
  await shot('ai-settings');
  await e("document.querySelector('.modal-close-button')?.click();return true;");
  }
} finally { c.close(); }
