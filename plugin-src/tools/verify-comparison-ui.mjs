/** Native Obsidian checks against an existing, isolated QA profile. Build first. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connect } from './cdp.mjs';

const config = JSON.parse(fs.readFileSync(process.argv[2] || '../.npm-cache/jj-app-qa/manifest.json', 'utf8'));
const cache = path.resolve('../.npm-cache'), vault = path.resolve(config.vault);
assert.ok(vault.startsWith(cache + path.sep) && /qa/i.test(vault), 'use an isolated QA vault inside .npm-cache');
const output = path.join(cache, 'comparison-ui'); fs.mkdirSync(output, { recursive: true });
const filePath = 'Comparison UI QA.md';
const jj = (...args) => execFileSync('jj', ['--no-pager', '--color=never', '-R', vault, ...args], { cwd: vault, encoding: 'utf8', windowsHide: true }).trim();
const cdp = await connect(config.port), results = [];
const evaluate = code => cdp.evaluate(`const p=app.plugins.plugins['live-git-diff'];${code}`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, value, detail) => { assert.ok(value, `${name}: ${JSON.stringify(detail)}`); results.push({ name, detail }); console.log('PASS ' + name); };
async function until(expression) {
  for (let i = 0; i < 600; i++) { if (await evaluate(`return ${expression};`)) return; await wait(100); }
  throw new Error('Timed out: ' + expression);
}
async function shot(name) {
  await wait(200);
  const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(result.data, 'base64'));
}
const text = version => '# Comparison overview\n\n' + Array.from({ length: 65 }, (_, i) => {
  const number = i + 1;
  const paragraph = (number === 8 && version > 0) || (number === 57 && version > 1)
    ? `Paragraph ${number}: review the updated acceptance criteria and the revised delivery plan.`
    : `Paragraph ${number}: review the original acceptance criteria and the original delivery plan.`;
  return `## Section ${number}\n\n${paragraph}\n\n` +
    (number === 27 && version < 2 ? 'A legacy appendix that will disappear completely from the final document.\n\n' : '') +
    (number === 45 && version > 1 ? 'A brand new appendix that appears only in the final document.\n\n' : '');
}).join('');
const geometry = `const headers=[...document.querySelectorAll('.lgd-header')].map(el=>({height:el.getBoundingClientRect().height,text:el.textContent}));
  const note=p.notePane(),base=p.basePane();return {headers,live:document.querySelectorAll('.lgd-live-review').length,
    maps:document.querySelectorAll('.lgd-change-map').length,changed:p.session.counts.changed,
    counts:[...document.querySelectorAll('.lgd-change-map')].map(el=>el.querySelectorAll('button').length),
    topDelta:note&&base?base.getBoundingClientRect().top-note.scroller.getBoundingClientRect().top:null};`;

try {
  assert.equal(path.resolve(await evaluate('return app.vault.adapter.getBasePath();')), vault);
  await evaluate(`require('@electron/remote').getCurrentWindow().webContents.setBackgroundThrottling(false);p.closeReview();await app.plugins.disablePlugin('live-git-diff');`);
  for (const name of ['main.js', 'styles.css', 'manifest.json']) fs.copyFileSync(path.resolve('../plugin-dist', name), path.join(vault, '.obsidian/plugins/live-git-diff', name));
  await cdp.evaluate(`await app.plugins.loadManifests();await app.plugins.enablePlugin('live-git-diff');`);
  await evaluate(`for(const leaf of app.workspace.getLeavesOfType('markdown'))if(leaf.view.file?.path===${JSON.stringify(filePath)})leaf.detach();
    document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
  await evaluate(`window.__comparisonErrors=[];window.addEventListener('error',event=>window.__comparisonErrors.push(event.message));
    window.addEventListener('unhandledrejection',event=>window.__comparisonErrors.push(String(event.reason)));`);
  jj('new', '-m', 'Comparison overview QA');
  const versions = [];
  for (let version = 0; version < 3; version++) {
    await evaluate(`const file=app.vault.getAbstractFileByPath(${JSON.stringify(filePath)});if(file)await app.vault.modify(file,${JSON.stringify(text(version))});else await app.vault.create(${JSON.stringify(filePath)},${JSON.stringify(text(version))});`);
    jj('util', 'snapshot');
    if (version === 0) jj('describe', '-m', 'Review document changes with a deliberately long version description that wraps across several lines in narrow comparison panes');
    versions.push(jj('--ignore-working-copy', 'log', '-G', '-r', '@', '-T', 'commit_id'));
  }
  await evaluate(`p.closeReview();p.historyView()?.leaf.detach();const file=app.vault.getAbstractFileByPath(${JSON.stringify(filePath)});
    const leaf=app.workspace.getLeaf('tab');await leaf.openFile(file);await leaf.setViewState({type:'markdown',state:{file:file.path,mode:'source'},active:true});window.__comparisonLeaf=leaf;await p.openHistory(file);`);
  await until(`p.historyView()?.controller.state.entry&&!p.historyView().controller.state.loading&&!p.historyView().controller.state.expanded?.workcopy?.loading`);
  const snapshots = await evaluate(`const controller=p.historyView().controller;await controller.expand('workcopy',true);
    const state=controller.state;window.__comparisonVersions=controller.available();return {head:state.entry.head,snapshots:state.expanded.workcopy.commits};`);
  check('Workcopy snapshots omit the current revision and retain earlier versions',
    snapshots.snapshots.every(commit => commit.sha !== snapshots.head) && versions.slice(0, 2).every(sha => snapshots.snapshots.some(commit => commit.sha === sha)));
  await evaluate(`await p.openReview({file:app.vault.getAbstractFileByPath(${JSON.stringify(filePath)}),leaf:window.__comparisonLeaf,ref:${JSON.stringify(versions[0])},label:'Overview baseline'});`);
  await until(`p.session?.status==='ready'&&p.notePane()?.editorView&&document.querySelectorAll('.lgd-change-map').length===2`);
  await wait(300);
  let state = await evaluate(geometry);
  check('Live editor and base have equal headers, aligned scrollports and complete change maps',
    state.live === 1 && state.headers.length === 2 && Math.abs(state.headers[0].height - state.headers[1].height) < 1 &&
    Math.abs(state.topDelta) < 1 && state.counts.every(count => count === state.changed), state);
  check('Live comparisons hide snapshot-only swap actions', await evaluate(`return [...document.querySelectorAll('.lgd-swap')].every(el=>getComputedStyle(el).display==='none');`));
  for (const width of [950, 1500]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: false });
    await wait(300); state = await evaluate(geometry);
    check(`Header heights follow wrapping at ${width}px`, Math.abs(state.headers[0].height - state.headers[1].height) < 1 && Math.abs(state.topDelta) < 1, state);
  }
  for (const side of ['a', 'b']) {
    await evaluate(`p.basePane().scrollTop=0;p.notePane().scroller.scrollTop=0;`); await wait(180);
    await evaluate(`const root=${side === 'a' ? 'p.baseView().contentEl' : 'p.reviewLeaf.view.contentEl'};root.querySelector('.lgd-change-map button:last-child').click();`);
    await wait(500);
    const position = await evaluate(`return {base:p.basePane().scrollTop,note:p.notePane().scroller.scrollTop,text:p.currentEditor().state.doc.toString()};`);
    check(`Clicking ${side === 'a' ? 'base' : 'live'} markers navigates both panes without editing`, position.base > 500 && position.note > 500 && position.text === text(2), { base: position.base, note: position.note });
  }
  await evaluate(`const editor=p.currentEditor();editor.focus();editor.dispatch({selection:{anchor:editor.state.doc.length}});`);
  await cdp.send('Input.insertText', { text: '\nUnsaved buffer for snapshot visibility QA.\n' });
  const unsaved = await evaluate(`const controller=p.historyView().controller;await controller.expand('workcopy',true);
    return {head:controller.state.entry.commits[0].currentSha,first:controller.state.expanded.workcopy.commits[0]?.sha};`);
  check('The current saved snapshot remains available when the live editor differs', unsaved.first === unsaved.head, unsaved);
  await evaluate(`const editor=p.currentEditor();editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:${JSON.stringify(text(2))}}});`);
  await until(`p.session?.status==='ready'&&p.session.currentText===${JSON.stringify(text(2))}`);
  await evaluate(`p.toggleSync();`);
  check('Sync state also appears in the temporary live header', await evaluate(`return [...document.querySelectorAll('.lgd-sync')].every(el=>el.textContent.includes('off'));`));
  await evaluate(`p.basePane().scrollTop=0;p.notePane().scroller.scrollTop=0;p.reviewLeaf.view.contentEl.querySelector('.lgd-change-map button:last-child').click();`);
  await wait(300);
  check('Overview navigation respects disabled scroll sync', await evaluate(`return p.basePane().scrollTop===0&&p.notePane().scroller.scrollTop>500;`));
  await evaluate(`p.toggleSync();p.basePane().scrollTop=0;p.notePane().scroller.scrollTop=0;`); await wait(200);
  await shot('live-source-light');
  await evaluate(`const leaf=p.reviewLeaf;await leaf.setViewState({type:'markdown',state:{file:${JSON.stringify(filePath)},mode:'preview'},active:true});`);
  await until(`p.notePane()&&!p.notePane().editorView&&document.querySelectorAll('.lgd-change-map').length===2`);
  await wait(350); state = await evaluate(geometry);
  check('Reading mode retains matching headers and both overview maps', state.live === 1 && state.maps === 2 && Math.abs(state.topDelta) < 1, state);
  await evaluate(`p.reviewLeaf.view.contentEl.querySelector('.lgd-change-map button:last-child').click();`);
  await until(`p.notePane().scroller.scrollTop>500&&p.basePane().scrollTop>500`);
  check('Reading mode overview navigates virtualized content', await evaluate(`return p.notePane().scroller.scrollTop>500&&p.basePane().scrollTop>500;`));
  await evaluate(`document.body.classList.remove('theme-light');document.body.classList.add('theme-dark');p.notePane().scroller.scrollTop=0;p.basePane().scrollTop=0;`);
  await shot('live-reading-dark');
  await evaluate(`p.closeReview();`);
  check('Closing comparison removes live header and change maps', await evaluate(`return !document.querySelector('.lgd-live-review,.lgd-header,.lgd-change-map');`));
  await evaluate(`const commits=${JSON.stringify(versions.slice(0,2))}.map(sha=>window.__comparisonVersions.find(commit=>commit.sha===sha));await p.compareHistory(${JSON.stringify(filePath)},commits);`);
  await until(`p.session?.status==='ready'&&p.session.endpoints[1].kind==='commit'&&document.querySelectorAll('.lgd-change-map').length===2`);
  await wait(300); state = await evaluate(geometry);
  check('Snapshot comparisons also share header height and overview navigation', state.live === 0 && state.maps === 2 && state.headers.length === 2 && Math.abs(state.topDelta) < 1, state);
  await evaluate(`p.snapshotViews().find(view=>view.side==='b').contentEl.querySelector('.lgd-change-map button:last-child').click();`); await wait(400);
  check('Historical overview markers scroll both snapshots', await evaluate(`return p.notePane().scroller.scrollTop>100&&p.basePane().scrollTop>100;`));
  await shot('two-snapshots-dark');
  await evaluate(`p.closeReview();document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');`);
  check('No renderer errors', (await evaluate(`return window.__comparisonErrors;`)).length === 0, await evaluate(`return window.__comparisonErrors;`));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
  console.log('Native comparison UI checks passed. Artifacts: ' + output);
} finally { cdp.close(); }
