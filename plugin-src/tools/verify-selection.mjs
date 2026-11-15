/** Real Obsidian regression for the explicit Workcopy selection model. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {connect} from './cdp.mjs';
if(!process.argv[2])throw new Error('Provide an isolated QA manifest.');
const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),c=await connect(m.port);
const fixture=JSON.parse(fs.readFileSync(path.join(m.output,'history-fixture.local.json'),'utf8'));
const e=code=>c.evaluate(`const p=app.plugins.plugins['live-git-diff'];${code}`);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 assert.equal(path.resolve(await e('return app.vault.adapter.basePath;')),path.resolve(m.vault));
 await e(`p.closeReview();p.historyView()?.leaf.detach();await p.openHistory(app.vault.getAbstractFileByPath(${JSON.stringify(fixture.file)}));return true;`);
 for(let i=0;i<200;i++){if(await e('return p.historyView()?.controller.state.entry&&!p.historyView().controller.state.loading;'))break;await wait(100);}
 assert.deepEqual(await e('return p.historyView().controller.state.selected.map(c=>c.sha);'),['workcopy']);
 assert.ok(await e('return [...p.historyView().contentEl.querySelectorAll(".lgd-history-compare")].every(b=>b.hidden);'));
 await e('const v=p.historyView(),r=v.controller.state.entry.commits.filter(c=>c.kind!=="workcopy");v.controller.select(r[0].sha);v.controller.select(r[1].sha);window.__selected=r[1].sha;return true;');
 assert.deepEqual(await e('return p.historyView().controller.state.selected.map(c=>c.sha);'),[await e('return window.__selected;'),'workcopy']);
 await e("const v=p.historyView(),b=[...v.contentEl.querySelectorAll('button[data-commit]')].find(b=>b.dataset.commit===window.__selected);b.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));return true;");
 for(let i=0;i<200;i++){if(await e('return p.session?.status==="ready"&&!p.historyReviewState().openingFile;'))break;await wait(100);}
 assert.ok(await e('return p.session.sha===window.__selected&&p.session.endpoints[1].kind==="worktree";'));
 await e('p.historyView().controller.clearSelection();return true;');assert.ok(await e('return !!p.session&&p.historyView().controller.comparisonRequest()===null;'));
 console.log('Workcopy default, replacement, double click, explicit pair and independent clearing passed.');
}finally{c.close();}
