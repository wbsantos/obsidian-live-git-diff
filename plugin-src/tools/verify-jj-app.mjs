import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {connect} from './cdp.mjs';
import {execFileSync} from 'node:child_process';
const manifest=JSON.parse(fs.readFileSync('../.npm-cache/jj-app-qa/manifest.json','utf8'));
const c=await connect(manifest.port),out=path.resolve('../docs/screenshots/history-jj');fs.mkdirSync(out,{recursive:true});
const e=code=>c.evaluate(`const p=app.plugins.plugins['live-git-diff'];${code}`);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<200;i++){if(await e(`return ${code}`))return;await wait(100);}throw new Error('Timed out: '+code);}
async function shot(name){await wait(300);const pic=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(pic.data,'base64'));}
try {
  assert.equal(path.resolve(await e('return app.vault.adapter.basePath')),path.resolve(manifest.vault));
  await e("document.querySelector('.modal-close-button')?.click();return true;");
  await c.send('Emulation.setDeviceMetricsOverride',{width:1400,height:1000,deviceScaleFactor:1,mobile:false});
  await e("require('@electron/remote').getCurrentWindow().webContents.setBackgroundThrottling(false);p.closeReview();p.historyView()?.leaf.detach();const f=app.vault.getAbstractFileByPath('Review.md');await app.workspace.getLeaf('tab').openFile(f);await p.openHistory(f);app.workspace.rightSplit.expand();return true;");
  await until("p.historyView()?.controller.state.entry&&!p.historyView().controller.state.loading&&!p.historyView().controller.state.expanded?.workcopy?.loading");
  console.log(await e("const s=p.historyView().controller.state;return {backend:s.entry.context.backend,error:s.error,groups:s.expanded,selected:s.selected.map(c=>c.sha)}"));
  assert.equal(await e("return p.historyView().controller.state.entry.context.backend"),'jj');
  assert.ok(await e("return p.historyView().controller.state.expanded.workcopy.commits.length>=2"));
  await e("app.vault.setConfig('theme','obsidian');document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');return true;");
  await shot('jj-workcopy-evolog-light');
  await e("const v=p.historyView(),parent=v.controller.state.entry.commits.find(c=>c.kind!=='workcopy');if(parent)await v.controller.expand(parent.sha);return true;");
  await shot('jj-historical-change-expanded');
  await e("const v=p.historyView(),s=v.controller.state;v.controller.select(s.expanded.workcopy.commits.find(c=>!c.absent).sha);return true;");
  await shot('jj-workcopy-selected');
  await e("const v=p.historyView(),versions=v.controller.state.expanded.workcopy.commits.filter(c=>!c.absent);v.controller.setSelection(versions.slice(0,2).map(c=>c.sha));return true;");
  await shot('jj-two-snapshots-light');
  await e("document.body.classList.remove('theme-light');document.body.classList.add('theme-dark');return true;");
  await shot('jj-two-snapshots-dark');
  await e("return p.historyView().applySelection();");
  await until("p.session?.status==='ready'&&!p.historyReviewState().openingFile");
  assert.equal(await e("return p.session.endpoints[1].kind"),'commit');
  await shot('jj-snapshot-comparison-dark');
  await e("p.closeReview();const v=p.historyView();await v.controller.expand('workcopy');return true;");
  assert.equal(await e("return p.historyView().controller.state.selected.length"),0);
  await e("const v=p.historyView();window.__beforeSnapshot=v.controller.state.entry.head;const f=app.vault.getAbstractFileByPath('Review.md');await app.vault.modify(f,(await app.vault.read(f))+'\\nSaved change for automatic snapshot QA.\\n');return true;");
  for(let i=0;i<250;i++) { if(await e('return p.historyView().controller.state.entry.head!==window.__beforeSnapshot'))break;await wait(100); }
  assert.ok(await e('return p.historyView().controller.state.entry.head!==window.__beforeSnapshot'));
  await e("const v=p.historyView();await v.controller.expand('workcopy',true);const snap=v.controller.state.expanded.workcopy.commits.find(c=>!c.absent);v.controller.setSelection([snap.sha,'workcopy']);await v.applySelection();return true;");
  await until("p.session?.status==='ready'&&!p.historyReviewState().openingFile");
  assert.equal(await e('return p.session.endpoints[1].kind'),'worktree');
  await shot('jj-live-workcopy-comparison');
  const gitDir=path.join(manifest.vault,'git-only');fs.mkdirSync(gitDir,{recursive:true});
  const git=(...args)=>execFileSync('git',['-C',gitDir,...args],{windowsHide:true,encoding:'utf8'});
  if(!fs.existsSync(path.join(gitDir,'.git'))) {
    git('init','-q');git('config','user.name','History QA');git('config','user.email','qa@localhost');
    fs.writeFileSync(path.join(gitDir,'Git review.md'),'# Git review\n\nOriginal version.\n');git('add','.');git('commit','-qm','Initial Git version');
    fs.writeFileSync(path.join(gitDir,'Git review.md'),'# Git review\n\nUpdated version.\n');git('add','.');git('commit','-qm','Refine Git version');
  }
  await wait(1500);
  await e("p.closeReview();const f=app.vault.getAbstractFileByPath('git-only/Git review.md');await app.workspace.getLeaf('tab').openFile(f);await p.openHistory(f);return true;");
  await until("p.historyView().controller.state.entry?.context.backend==='git'&&!p.historyView().controller.state.loading");
  assert.equal(await e('return p.historyView().controller.state.selected[0].kind'),'workcopy');
  await e("const v=p.historyView();v.controller.select(v.controller.state.entry.commits.find(c=>c.kind!=='workcopy').sha);document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');return true;");
  await shot('git-workcopy-light');
  console.log('JJ application comparisons, expansion and collapse passed. Screenshots: '+out);
} finally {c.close();}
