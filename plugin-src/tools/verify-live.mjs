import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { connect } from './cdp.mjs';

const cdp = await connect();
const results = [];
const check = (name, condition, detail) => { assert.ok(condition, `${name}: ${JSON.stringify(detail)}`); results.push({ name, pass: true, detail }); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => cdp.evaluate(`const p=app.plugins.plugins['live-git-diff']; ${code}`);
async function ready() {
  for (let i = 0; i < 200; i++) {
    const s = await evaluate('return {status:p.session?.status,error:p.session?.error};');
    if (s.error) throw new Error(s.error);
    if (s.status === 'ready') return;
    await wait(50);
  }
  throw new Error('Comparison did not become ready');
}
try {
  await cdp.send('Page.bringToFront');
  // The QA process is intentionally hidden; keep Electron animation frames running.
  await evaluate('require("@electron/remote").getCurrentWindow().webContents.setBackgroundThrottling(false); return true;');
  await evaluate(`const welcome=[...document.querySelectorAll('.modal')].find(m=>m.innerText.startsWith('Welcome to Excalidraw'));
    if(welcome)[...welcome.querySelectorAll('button')].find(b=>b.innerText==='Close')?.click();return true;`);
  await evaluate(`window.__qaErrors=[]; window.addEventListener('error',e=>window.__qaErrors.push(e.message));
    window.__qaOriginal=p.currentEditor().state.doc.toString(); window.__qaSha=p.session.sha;
    window.__qaBase=p.baseView().blockEls.values().next().value;
    p.currentEditor().focus(); p.currentEditor().dispatch({selection:{anchor:0}}); return true;`);
  await cdp.send('Input.insertText', { text: 'Parágrafo de teste inserido.\n\n' });
  const stale = await evaluate(`return {status:p.session.status,highlighted:document.querySelectorAll('.lgd-editor-mod,.lgd-editor-ins,.lgd-block.lgd-mod,.lgd-block.lgd-del').length};`);
  check('typing invalidates old highlights immediately', stale.status === 'updating' && stale.highlighted === 0, stale);
  await ready();
  const edited = await evaluate(`return {sha:p.session.sha,originalSha:window.__qaSha,starts:p.session.currentText.startsWith('Parágrafo de teste inserido.'),cache:window.__qaBase===p.baseView().blockEls.values().next().value,revision:p.session.revision};`);
  check('typing compares live text and keeps commit/render cache', edited.sha === edited.originalSha && edited.starts && edited.cache, edited);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await ready();
  check('native undo preserves complete original text', await evaluate('return p.session.currentText===window.__qaOriginal;'));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'y', code: 'KeyY', modifiers: 2, windowsVirtualKeyCode: 89 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'y', code: 'KeyY', modifiers: 2, windowsVirtualKeyCode: 89 });
  await ready();
  check('native redo restores edit', await evaluate("return p.session.currentText.startsWith('Parágrafo de teste inserido.');"));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await ready();
  await evaluate('p.currentEditor().scrollDOM.scrollTop=700; return true;'); await wait(250);
  const noteScroll = await evaluate('return {note:p.currentEditor().scrollDOM.scrollTop,base:p.basePane().scrollTop};');
  check('editor scroll moves historical pane', noteScroll.note > 100 && noteScroll.base > 100, noteScroll);
  await evaluate('p.basePane().scrollTop=1300; return true;'); await wait(300);
  const baseScroll = await evaluate('return {note:p.currentEditor().scrollDOM.scrollTop,api:p.sync.lastScrollApi};');
  check('historical scroll uses public CodeMirror API', baseScroll.api === 'EditorView.scrollIntoView' && baseScroll.note > noteScroll.note, baseScroll);
  await evaluate(`const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path==='review.md');
    await leaf.setViewState({type:'markdown',state:{file:'review.md',mode:'preview'},active:true}); return true;`);
  await wait(500);
  check('reading mode remains available', await evaluate("return p.notePane()!==null&&!p.notePane().editorView&&document.querySelectorAll('.lgd-nblock').length>0;"));
  await evaluate(`const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path==='review.md');
    await leaf.setViewState({type:'markdown',state:{file:'review.md',mode:'source',source:false},active:true}); return true;`);
  await wait(500);
  check('Live Preview resumes with same pin', await evaluate('return !!p.notePane()?.editorView&&p.session.sha===window.__qaSha;'));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
  await wait(200);
  await evaluate('p.currentEditor().scrollDOM.scrollTop=0; return true;'); await wait(250);
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve('../app-qa/live-preview.png'), Buffer.from(screenshot.data, 'base64'));
  const errors = await evaluate('return window.__qaErrors;');
  check('no renderer errors during interaction', errors.length === 0, errors);
  fs.writeFileSync(path.resolve('../app-qa/live-verification.json'), JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { cdp.close(); }
