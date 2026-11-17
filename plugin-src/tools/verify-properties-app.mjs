/** Native comparison QA using only the existing, isolated JJ QA vault. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connect } from './cdp.mjs';

const config = JSON.parse(fs.readFileSync('../.npm-cache/jj-app-qa/manifest.json', 'utf8'));
assert.equal(path.resolve(config.vault), path.resolve('../.npm-cache/jj-app-qa/vault'));
const output = path.resolve('../.npm-cache/properties-app-qa');
fs.mkdirSync(output, { recursive: true });
for (const name of ['main.js', 'styles.css', 'manifest.json'])
  fs.copyFileSync(path.resolve('../plugin-dist', name), path.join(config.vault, '.obsidian/plugins/live-git-diff', name));
const c = await connect(config.port);
const e = code => c.evaluate(`const p=app.plugins.plugins['live-git-diff'];${code}`);
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const until = async code => { for (let i=0;i<200;i++) { if (await e(`return ${code}`)) return; await pause(); } throw new Error('Timed out: '+code); };
const jj = (...args) => execFileSync('jj', ['--no-pager', '--color=never', '-R', config.vault, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const note = 'Properties QA.md';
const original = '---\nstatus: Draft\npriority: 2\ncomplete: false\ntags:\n  - review\n  - qa/native\naliases:\n  - Historical note\nrelated: "[[Review]]"\nempty:\nstructured:\n  owner: QA\n---\n# Properties comparison\n\nOriginal body.\n';
const updated = original.replace('Draft', 'Ready').replace('priority: 2', 'priority: 3').replace('complete: false', 'complete: true').replace('Historical note', 'Current note').replace('Original body.', 'Updated body.');
try {
  assert.equal(path.resolve(await e('return app.vault.adapter.basePath;')), path.resolve(config.vault));
  await c.evaluate("await app.plugins.unloadPlugin('live-git-diff');await app.plugins.loadPlugin('live-git-diff');");
  await e("require('@electron/remote').getCurrentWindow().webContents.setBackgroundThrottling(false);");
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1050, deviceScaleFactor: 1, mobile: false });
  await e("document.querySelector('.modal-close-button')?.click();app.workspace.leftSplit.collapse();app.workspace.rightSplit.collapse();");
  await e(`let f=app.vault.getAbstractFileByPath(${JSON.stringify(note)});if(f)await app.vault.modify(f,${JSON.stringify(original)});else f=await app.vault.create(${JSON.stringify(note)},${JSON.stringify(original)});`);
  jj('util', 'snapshot');
  const sha = jj('--ignore-working-copy', 'log', '-G', '-r', '@', '-T', 'commit_id');
  await e(`const f=app.vault.getAbstractFileByPath(${JSON.stringify(note)});await app.vault.modify(f,${JSON.stringify(updated)});const leaf=app.workspace.getLeaf('tab');await leaf.setViewState({type:'markdown',state:{file:f.path,mode:'preview'},active:true});await p.openReview({file:f,leaf,ref:${JSON.stringify(sha)},label:'Historical properties'});`);
  await until("p.session?.status==='ready' && !!p.baseView()?.bodyEl.querySelector('.lgd-properties [data-property-key=structured]')");
  const data = await e(`const root=p.baseView().bodyEl;const prop=key=>root.querySelector('[data-property-key="'+key+'"] .metadata-property-value');return {historical:prop('status').textContent,current:document.querySelector('.markdown-preview-view:not(.lgd-body) [data-property-key=status] .metadata-property-value')?.textContent,priority:prop('priority').textContent,checked:prop('complete').querySelector('input').checked,disabled:prop('complete').querySelector('input').disabled,links:prop('related').querySelectorAll('a.internal-link').length,tags:prop('tags').querySelectorAll('a.tag').length,structured:prop('structured').textContent,raw:root.querySelectorAll('.lgd-properties pre').length,editable:root.querySelectorAll('.lgd-properties [contenteditable=true],.lgd-properties input:not(:disabled)').length,rows:[...root.querySelectorAll('.metadata-property')].map(el=>({height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width}))};`);
  assert.equal(data.historical, 'Draft'); assert.equal(data.priority, '2');
  assert.equal(data.checked, false); assert.equal(data.disabled, true);
  assert.equal(data.links, 1); assert.equal(data.tags, 2);
  assert.equal(data.raw, 0); assert.equal(data.editable, 0);
  assert.match(data.structured, /owner/);
  assert.equal(data.rows.length, 8); assert.ok(data.rows.every(row=>row.height>15 && row.width>150));
  await e("p.sync.enabled=false;p.baseView().bodyEl.scrollTop=0;const pane=p.notePane();if(pane)pane.scroller.scrollTop=0;");
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1050, deviceScaleFactor: 1, mobile: false });
  for (const theme of ['light', 'dark']) {
    await e(`document.body.classList.remove('theme-light','theme-dark');document.body.classList.add('theme-${theme}');`);
    await pause();
    const png = await e("const image=await require('@electron/remote').getCurrentWindow().webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});return image.toPNG().toString('base64');");
    fs.writeFileSync(path.join(output, theme+'.png'), Buffer.from(png, 'base64'));
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(data, null, 2));
  const current = jj('--ignore-working-copy', 'log', '-G', '-r', '@', '-T', 'commit_id');
  await e(`const f=app.vault.getAbstractFileByPath(${JSON.stringify(note)});const left={sha:${JSON.stringify(sha)},shortSha:'old',subject:'Original',relative:'',date:'',path:f.path};const right={...left,sha:${JSON.stringify(current)},shortSha:'new',subject:'Updated'};await p.compareHistory(f.path,[left,right]);`);
  await until("p.session?.status==='ready' && p.snapshotViews().length===2 && p.snapshotViews().every(v=>v.bodyEl.querySelector('[data-property-key=structured]'))");
  const pair = await e("return p.snapshotViews().map(v=>({side:v.side,status:v.bodyEl.querySelector('[data-property-key=status] .metadata-property-value').textContent,raw:v.bodyEl.querySelectorAll('.lgd-properties pre').length})).sort((a,b)=>a.side.localeCompare(b.side));");
  assert.deepEqual(pair, [{side:'a',status:'Draft',raw:0},{side:'b',status:'Ready',raw:0}]);
  console.log('PASS native historical properties: historical values, tags, links, numbers, read-only checkbox, empty/nested values, both themes');
} finally { c.close(); }
