import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {connect} from './cdp.mjs';
if(!process.argv[2])throw new Error('Provide an isolated QA manifest with the history fixture.');
const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),fixture=JSON.parse(fs.readFileSync(path.join(m.output,'history-fixture.local.json'),'utf8'));
const c=await connect(m.port),results=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
const e=code=>c.evaluate(`const p=app.plugins.plugins['live-git-diff'];${code}`);
const check=(name,ok,detail)=>{results.push({name,pass:!!ok,detail});assert.ok(ok,`${name}: ${JSON.stringify(detail)}`);console.log('PASS '+name);};
async function until(code){for(let i=0;i<160;i++){if(await e(`return ${code};`)){await wait(100);return;}await wait(50);}throw new Error('Timed out: '+code);}
const ready=()=>until("!p.historyReviewState().openingFile&&p.session?.status==='ready'&&p.snapshotViews().every(v=>v.blockEls.size===(v.side==='a'?p.session.baseRows:p.session.noteRows).length)");
const historyReady=()=>until('p.historyView()?.controller.state.entry&&!p.historyView().controller.state.loading');
async function click(sha){await e(`const b=p.historyView().contentEl.querySelector('button[data-commit="'+${JSON.stringify(sha)}+'"]');if(!b)throw new Error('Commit not listed');b.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));return true;`);await wait(100);}
async function key(mod,key,code){for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key,code,modifiers:mod,windowsVirtualKeyCode:key==='Enter'?13:key===' '?32:key.toUpperCase().charCodeAt(0)});}
const unchanged=()=>e('return p.session===window.__uxReview.session&&p.baseView().leaf===window.__uxReview.leaf&&p.baseView().bodyEl.scrollTop===window.__uxReview.top;');
try{
 assert.equal(path.resolve(await e('return app.vault.adapter.basePath;')),path.resolve(m.vault));
 await c.send('Emulation.setDeviceMetricsOverride',{width:1800,height:1100,deviceScaleFactor:1,mobile:false});
 await e(`require('@electron/remote').getCurrentWindow().webContents.setBackgroundThrottling(false);p.closeReview();p.historyView()?.leaf.detach();p.settings.logLimit=10;app.workspace.leftSplit.collapse();const file=app.vault.getAbstractFileByPath(${JSON.stringify(fixture.file)});await p.openReview({file,ref:${JSON.stringify(fixture.commits[0])}});await p.openHistory(file);return true;`);await ready();await historyReady();
 await e('p.sync.enabled=false;p.baseView().bodyEl.scrollTop=800;return true;');await wait(200);
 await e('window.__uxReview={session:p.session,leaf:p.baseView().leaf,top:p.baseView().bodyEl.scrollTop};return true;');
 await click(fixture.commits[2]);check('one click only prepares a draft and preserves panes and scroll',await unchanged());
 check('one selection has an explicit worktree action',await e("return p.historyView().contentEl.querySelector('.lgd-history-compare').title.startsWith('Compare with Working Tree');"));
 await click(fixture.commits[0]);check('plain click prepares two versions without changing the review',await unchanged());
 check('active review and pending selection are independently identified',await e(`const v=p.historyView();return v.contentEl.querySelector('.lgd-history-selection').textContent.includes(${JSON.stringify(fixture.commits[2].slice(0,7))})&&v.contentEl.querySelector('.lgd-history-active').textContent.includes('Working tree')&&v.contentEl.querySelector('.lgd-history-compare').title.startsWith('Compare Selected Versions');`));
 await click(fixture.commits[1]);check('third selection is rejected without changing the comparison',await unchanged()&&await e("return p.historyView().controller.state.selected.length===2&&p.historyView().controller.state.hint.includes('up to two');"));
 await e("const q=p.historyView().contentEl.querySelector('input');q.value='no matching commits';q.dispatchEvent(new Event('input'));return true;");
 check('filtering does not apply or conceal the selected-version summary',await unchanged()&&await e("return p.historyView().contentEl.querySelector('.lgd-history-selection').textContent.includes(' → ');"));
 await e("p.historyView().controller.clearSelection();return true;");check('clearing draft leaves the current review open',await unchanged()&&await e("return p.historyView().controller.state.selected.length===0;"));
 await e("const q=p.historyView().contentEl.querySelector('input');q.value='';q.dispatchEvent(new Event('input'));return true;");
 await e('p.historyView().controller.clearSelection();return true;');
 await e(`const b=p.historyView().contentEl.querySelector('button[data-commit="'+${JSON.stringify(fixture.commits[1])}+'"]');b.focus();return true;`);await key(0,'Enter','Enter');
 check('Enter on a row selects without comparing',await unchanged()&&await e(`return p.historyView().controller.state.selected.length===1&&p.historyView().controller.state.selected[0].sha===${JSON.stringify(fixture.commits[1])};`));
 await click(fixture.commits[0]);await e('p.historyView().contentEl.querySelector("input").focus();return true;');await key(2,'Enter','Enter');await ready();
 check('Ctrl+Enter explicitly compares the prepared pair',await e(`return p.session.endpoints[0].sha===${JSON.stringify(fixture.commits[0])}&&p.session.endpoints[1].sha===${JSON.stringify(fixture.commits[1])};`));
 await e('p.baseView().leaf.detach();return true;');await until('p.session===null');
 check('closing a participant keeps the prepared selection available',await e("return p.historyView().controller.state.selected.length===2&&!p.historyView().contentEl.querySelector('.lgd-history-compare:not([hidden])').disabled;"));
 // Hold a real Git lookup after submission, then alter the draft while it is running.
 await e(`const original=p.noteLeaf.bind(p);window.__uxNoteLeaf=original;p.noteLeaf=async(...args)=>{await new Promise(r=>window.__uxRelease=r);return original(...args);};return true;`);
 await e(`p.historyView().controller.setSelection([${JSON.stringify(fixture.commits[0])}]);p.historyView().contentEl.querySelector('.lgd-history-compare:not([hidden])').click();return true;`);await until('!!window.__uxRelease');
 check('opening reports progress and prevents duplicate submission',await e("const b=p.historyView().contentEl.querySelector('.lgd-history-compare:not([hidden])');return b.disabled&&b.title==='Opening comparison…';"));
 await e(`p.historyView().controller.setSelection([${JSON.stringify(fixture.commits[2])}]);return true;`);await e('window.__uxRelease();p.noteLeaf=window.__uxNoteLeaf;delete window.__uxRelease;delete window.__uxNoteLeaf;return true;');await ready();
 check('submitted request retains its commit even if the draft changes',await e(`return p.session.sha===${JSON.stringify(fixture.commits[0])}&&p.historyView().controller.state.selected[0].sha===${JSON.stringify(fixture.commits[2])};`));
 await e("for(const l of app.workspace.getLeavesOfType('markdown'))if(l.view.file?.path==='mapping.md')l.detach();await p.openHistory(app.vault.getAbstractFileByPath('mapping.md'));return true;");await historyReady();
 check('history of an unopened file leaves its note closed and the other review active',await e(`return !app.workspace.getLeavesOfType('markdown').some(l=>l.view.file?.path==='mapping.md')&&p.session.filePath===${JSON.stringify(fixture.file)};`));
 await e("const l=app.workspace.getLeaf('tab');await l.openFile(app.vault.getAbstractFileByPath('reported.md'));return true;");await wait(250);
 check('opening another note does not change the chosen history',await e("return p.historyView().controller.state.file.path==='mapping.md';"));
 await e("const v=p.historyView();v.controller.setSelection([v.controller.state.entry.commits[0].sha]);window.__uxDraft=v.controller.state;const q=v.contentEl.querySelector('input');q.value='qa';q.dispatchEvent(new Event('input'));await p.openHistory(app.vault.getAbstractFileByPath('mapping.md'));return true;");
 check('reopening the same history preserves selection and filter',await e("return p.historyView().controller.state===window.__uxDraft&&p.historyView().contentEl.querySelector('input').value==='qa';"));
 await e('p.historyView().contentEl.querySelector("input").focus();return true;');await key(2,'Enter','Enter');await ready();
 check('explicit Compare opens the previously closed note',await e("return p.session.filePath==='mapping.md'&&p.reviewLeaf.view.file.path==='mapping.md';"));
 const pic=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(m.output,'selection-and-active-review.png'),Buffer.from(pic.data,'base64'));
 // Rename/delete only this separate temporary QA file.
 await e("const path='ux-lifecycle.md';if(!app.vault.getAbstractFileByPath(path))await app.vault.create(path,'# Temporary UX lifecycle fixture');await p.openHistory(app.vault.getAbstractFileByPath(path));return true;");await historyReady();
 await e("await app.vault.rename(app.vault.getAbstractFileByPath('ux-lifecycle.md'),'ux-renamed.md');return true;");await until("p.historyView().controller.state.file.path==='ux-renamed.md'&&!p.historyView().controller.state.loading");
 check('renaming the history target follows the renamed file',await e("return p.historyView().contentEl.querySelector('.lgd-history-file').textContent==='ux-renamed.md';"));
 await e("await app.vault.delete(app.vault.getAbstractFileByPath('ux-renamed.md'));return true;");
 check('deleting the target disables Compare and reports unavailability',await e("return p.historyView().controller.state.unavailable&&p.historyView().controller.state.selected.length===0&&p.historyView().contentEl.querySelector('.lgd-history-footer').textContent.includes('no longer available');"));
}finally{
 await e('if(window.__uxRelease)window.__uxRelease();if(window.__uxNoteLeaf)p.noteLeaf=window.__uxNoteLeaf;delete window.__uxReview;delete window.__uxDraft;return true;').catch(()=>{});
 fs.writeFileSync(path.join(m.output,'selection-verification.json'),JSON.stringify({date:new Date().toISOString(),results},null,2));c.close();
}
console.log(`${results.length} selection assertions passed`);
