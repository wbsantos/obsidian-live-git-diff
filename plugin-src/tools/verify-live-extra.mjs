import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { connect } from './cdp.mjs';
const cdp = await connect(), results = [];
const evaluate = code => cdp.evaluate(`const p=app.plugins.plugins['live-git-diff']; ${code}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const check = (name, condition, detail) => { assert.ok(condition, `${name}: ${JSON.stringify(detail)}`); results.push({ name, pass: true, detail }); };
async function until(code) { for (let i = 0; i < 200; i++) { if (await evaluate(code)) return; await wait(50); } throw new Error('Timed out: ' + code); }
try {
  await evaluate('require("@electron/remote").getCurrentWindow().webContents.setBackgroundThrottling(false); return true;');
  const ids = JSON.parse(fs.readFileSync('../app-qa/plugins-to-test.json', 'utf8').replace(/^\uFEFF/, ''));
  const plugins = await evaluate(`await app.plugins.loadManifests();const loaded=[];for(const id of ${JSON.stringify(ids)}){if(id!=='live-git-diff'){try{await app.plugins.enablePlugin(id);loaded.push({id,loaded:!!app.plugins.plugins[id]});}catch(e){loaded.push({id,error:e.message});}}}return loaded;`);
  check('existing installed plugins load alongside comparison', plugins.every(x => x.loaded), plugins);
  await evaluate('window.__qaErrors=[];window.__extraSha=p.session.sha;return true;');
  const table = await evaluate(`const row=p.session.rows.find(r=>r.kind==='mod'&&r.b?.type==='table'),v=p.currentEditor();
    v.dispatch({effects:v.constructor.scrollIntoView(v.state.doc.line(row.b.lineStart+1).from,{y:'start'})});
    return {row:row.idx,line:row.b.lineStart};`);
  await wait(300);
  const tableState = await evaluate(`return {tables:document.querySelectorAll('.cm-table-widget table').length,gutter:document.querySelectorAll('.lgd-gutter-mod').length,baseCells:document.querySelectorAll('.lgd-content td .lgd-char-del').length};`);
  check('native table and public margin marker are present', tableState.tables > 0 && tableState.gutter > 0 && tableState.baseCells > 0, { ...table, ...tableState });
  const pic = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('../app-qa/table-preview.png', Buffer.from(pic.data, 'base64'));
  await evaluate(`p.currentEditor().focus(); app.commands.executeCommandById('editor:fold-all'); return true;`); await wait(200);
  await evaluate('p.basePane().scrollTop=2200;return true;'); await wait(250);
  check('folded sections preserve content and comparison', await evaluate('return p.session.status===\'ready\'&&p.currentEditor().state.doc.toString()===p.session.currentText&&p.session.sha===window.__extraSha;'));
  await evaluate("app.commands.executeCommandById('editor:unfold-all');return true;");
  for (const width of [900, 1500]) { await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false }); await wait(200); }
  check('resize leaves content and pin intact', await evaluate('return p.currentEditor().state.doc.toString()===p.session.currentText&&p.session.sha===window.__extraSha;'));
  await evaluate(`const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path==='review.md');
    await leaf.openFile(app.vault.getAbstractFileByPath('extended-structure.md')); return true;`); await wait(250);
  check('switching notes removes review decorations from other note', await evaluate("return document.querySelectorAll('.lgd-editor-ins,.lgd-editor-mod').length===0&&p.session.filePath==='review.md'&&p.session.sha===window.__extraSha;"));
  const notePath = path.resolve('../app-qa/vault/review.md');
  await wait(1000);
  const before = fs.readFileSync(notePath, 'utf8');
  try {
    fs.writeFileSync(notePath, before + '\n\nAlteração externa para validação.\n');
    await until("return p.session.status==='ready'&&p.session.currentText.includes('Alteração externa para validação.');");
    check('external disk edit updates pinned comparison without open editor', await evaluate('return p.session.sha===window.__extraSha;'));
  } finally { fs.writeFileSync(notePath, before); }
  await until("return p.session.status==='ready'&&!p.session.currentText.includes('Alteração externa para validação.');");
  await evaluate(`const leaf=app.workspace.getLeavesOfType('markdown')[0];await leaf.openFile(app.vault.getAbstractFileByPath('review.md'));return true;`);
  await wait(400);
  // Trigger a disk event while a newer live buffer exists. No disk value may overwrite that buffer.
  await evaluate("p.currentEditor().focus();p.currentEditor().dispatch({selection:{anchor:0}});return true;");
  await cdp.send('Input.insertText', { text: 'Texto ainda no editor.\n\n' });
  await evaluate("app.vault.trigger('modify',app.vault.getAbstractFileByPath('review.md'));return true;");
  await until("return p.session.status==='ready'&&p.session.currentText.startsWith('Texto ainda no editor.');");
  check('save event cannot replace newer editor content', await evaluate("return p.currentEditor().state.doc.toString().startsWith('Texto ainda no editor.')&&p.session.sha===window.__extraSha;"));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await until("return p.session.status==='ready'&&!p.session.currentText.startsWith('Texto ainda no editor.');");
  const errors = await evaluate('return window.__qaErrors;'); check('no renderer errors with existing plugins', errors.length === 0, errors);
  fs.writeFileSync('../app-qa/live-extra-verification.json', JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { cdp.close(); }

