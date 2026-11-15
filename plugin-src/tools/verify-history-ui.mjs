/** Isolated DOM/visual QA; never opens or writes an Obsidian vault.
 * Usage: node tools/verify-history-ui.mjs <Chromium executable>
 * Output: ../.npm-cache/history-ui/{report.html,light.png,dark.png}
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(root, '../.npm-cache/history-ui');
const executable = process.argv[2];
if (!executable || !fs.existsSync(executable)) throw new Error('Provide a local Chromium/Edge executable.');
fs.mkdirSync(output, { recursive: true });
const stub = `
function create(tag, options = {}) {
  const el = document.createElement(tag);
  if (options.cls) el.className = options.cls;
  if (options.text) el.textContent = options.text;
  if (options.type) el.type = options.type;
  if (options.placeholder) el.placeholder = options.placeholder;
  for (const [key, value] of Object.entries(options.attr || {})) el.setAttribute(key, value);
  this.appendChild(el); return el;
}
Object.assign(HTMLElement.prototype, {
  createEl: create, createDiv(options) { return create.call(this, 'div', options); },
  createSpan(options) { return create.call(this, 'span', options); },
  empty() { this.replaceChildren(); }, addClass(...names) { this.classList.add(...names); },
  toggleClass(name, enabled) { this.classList.toggle(name, enabled); },
  setText(text) { this.textContent = text; }, setAttr(name, value) { this.setAttribute(name, value); }
});
export class ItemView { constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.contentEl = leaf.contentEl; } }
export class TFile { constructor(path) { this.path = path; this.name = path.split('/').pop(); } }
export class Scope { register(mods, key, callback) {
  document.addEventListener('keydown', event => {
    if (event.key === key && (event.ctrlKey || event.metaKey)) callback(event);
  });
} }
export class Menu {
  static last;
  items = [];
  addItem(configure) {
    const item = { title:'', disabled:false, callback() {},
      setTitle(v) { this.title=v; return this; }, setIcon() { return this; },
      setDisabled(v) { this.disabled=v; return this; }, onClick(v) { this.callback=v; return this; } };
    configure(item); this.items.push(item); return this;
  }
  addSeparator() {}
  showAtMouseEvent() { Menu.last = this; }
}
export function setIcon(el) { el.textContent = '↔'; }
export class WorkspaceLeaf {}
`;
const entry = `
import { GitHistoryView } from './src/historyView.ts';
import { HistoryCache } from './src/history.ts';
import { TFile, Menu } from 'obsidian';
const results = [];
function check(name, condition) {
  results.push({ name, pass:!!condition });
  if (!condition) throw new Error(name);
}
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const paint = () => new Promise(resolve => setTimeout(resolve, 100));
const commits = Array.from({length:12}, (_,i) => ({sha:String(12-i), shortSha:String(12-i),
  subject:i===0 ? 'Improve sidebar history selection and comparisons' : 'Revision '+(12-i),
  author:'History QA', path:'note.md', date:'Nov 12, 2026', relative:'today'}));
const files = new Map(['note.md', 'other.md'].map(path => [path,new TFile(path)]));
let active = files.get('note.md'), opening = null, pending = null, fail = false;
const calls = [], cache = new HistoryCache({ head:async()=> 'HEAD', log:async()=>[{kind:"workcopy",sha:"workcopy",shortSha:"Workcopy",subject:"Workcopy",path:"note.md",date:"",relative:"Live document"},...commits] });
const host = {
  settings:{logLimit:20}, historyCache:cache,
  historyActiveFile:()=> active,
  historyReviewState:()=> ({openingFile:opening, error:null, active:null}),
  compareHistory:async(filePath, versions)=> {
    calls.push({filePath, shas:versions.map(c=>c.sha)});
    if (fail) throw new Error('QA comparison failed');
    if (pending) await pending;
  }
};
const contentEl = document.getElementById('panel');
const view = new GitHistoryView({contentEl, app:{scope:{},vault:{getAbstractFileByPath:p=>files.get(p)}}},host);
const selected = () => view.controller.state.selected.map(c=>c.sha).join(',');
const row = sha => contentEl.querySelector('button[data-commit="'+sha+'"]');
const icon = sha => row(sha).parentElement.querySelector('.lgd-history-compare');
function context(sha) {
  row(sha).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  return Menu.last.items;
}
function doubleClick(sha) {
  for (const [type,detail] of [['click',1],['click',2],['dblclick',2]]) {
    row(sha).dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,detail}));
  }
}
const filter = value => { const el=contentEl.querySelector('input');el.value=value;el.dispatchEvent(new Event('input')); };
async function run() {
  await view.onOpen(); await view.setFile(files.get('note.md')); await paint();
  check('Workcopy is initially selected and has no compare icon', selected()==='workcopy' && ![...contentEl.querySelectorAll('.lgd-history-compare')].some(b=>!b.hidden));
  row('12').click();check('plain click forms a pair with Workcopy', selected()==='12,workcopy');
  row('10').click();check('third click replaces historical target', selected()==='10,workcopy');
  icon('10').click();await turn();check('compare icon submits explicit pair',calls.at(-1).shas.join(',')==='10,workcopy');
  doubleClick('11');await turn();check('double click replaces target and compares',selected()==='11,workcopy' && calls.at(-1).shas.join(',')==='11,workcopy');
  view.controller.setSelection(['12','10']);let count=calls.length;doubleClick('9');await turn();
  check('third historical double click preserves pair without comparing',selected()==='10,12' && calls.length===count);
  let menu=context('9');check('third row menu offers both selected targets',menu.length===4);
  menu[1].callback();await turn();check('context menu forms chosen historical pair',selected()==='9,10');
  context('12')[0].callback();await turn();check('context Workcopy action forms explicit pair',selected()==='12,workcopy');
  context('12').at(-1).callback();check('clear leaves zero selections',!selected());
  doubleClick('11');await turn();check('double click alone does not compare',selected()==='11');
  view.controller.setSelection(['12','10']);await paint();
  const line=contentEl.querySelector('.lgd-history-connector');
  check('two icons have a connector',!line.hidden && parseFloat(line.style.height)>0);
  filter('Revision 10');check('filter preserves selected targets visibly',!!row('12') && !!row('10'));
  filter('');
  active=files.get('other.md');view.updateActiveFile();check('different note shows follow action',!contentEl.querySelector('.lgd-history-follow').hidden);
  const stale=context('10');count=calls.length;contentEl.querySelector('.lgd-history-follow').click();await turn();stale[0].callback();
  check('stale menu cannot compare another note',calls.length===count && view.controller.state.file.path==='other.md');
  await view.onClose();
  const report=document.getElementById('report');report.textContent=JSON.stringify({results,passed:results.length});report.dataset.complete='true';
}
run().catch(error=>{const report=document.getElementById('report');report.textContent=JSON.stringify({results,error:error.stack});report.dataset.complete='failed';});
`;
const bundle = await build({
  stdin: { contents: entry, resolveDir: root }, bundle:true, write:false, format:'iife',
  plugins:[{ name:'isolated-host', setup(builder) {
    builder.onResolve({filter:/repository\.ts$/},()=>({path:'repository',namespace:'qa-repository'}));
    builder.onLoad({filter:/.*/,namespace:'qa-repository'},()=>({contents:'export const WORKCOPY="workcopy";export const resolveRepository=async()=>({root:"/qa",rel:"note.md"});export const workcopy=path=>({kind:"workcopy",sha:"workcopy",shortSha:"Workcopy",subject:"Workcopy",path,date:"",relative:"Live document"});export const repositoryHead=async()=>"HEAD";export const repositoryLog=async()=>[];export const evolution=async()=>({commits:[],hasMore:false});'}));
    builder.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'qa'}));
    builder.onLoad({filter:/.*/,namespace:'qa'},()=>({contents:stub}));
    builder.onResolve({filter:/\/git\.ts$|^\.\/git\.ts$/},()=>({path:'git',namespace:'qa-git'}));
    builder.onLoad({filter:/.*/,namespace:'qa-git'},()=>({contents:'export const resolveGitAsync=async()=>({root:"/qa",rel:"note.md"}); export const fileLogAsync=async()=>[]; export const resolveRefAsync=async()=>"HEAD";'}));
  }}],
});
const baseCss = `
*{box-sizing:border-box}body{font:14px system-ui;margin:24px;background:var(--background-primary);color:var(--text-normal)}
:root{--background-primary:#fff;--background-secondary:#f7f7f7;--text-normal:#262626;--text-muted:#686868;--text-faint:#aaa;--background-modifier-border:#ddd;--background-modifier-hover:#eee;--background-modifier-active-hover:#e9e6f4;--interactive-accent:#7655bb;--interactive-accent-hover:#6748a8;--text-on-accent:white;--text-success:#248342;--text-warning:#af7818;--text-error:#c33;--font-ui-smaller:12px;--font-monospace:monospace;--radius-s:4px}
body.dark{--background-primary:#202020;--background-secondary:#252525;--text-normal:#ddd;--text-muted:#aaa;--text-faint:#666;--background-modifier-border:#444;--background-modifier-hover:#333;--background-modifier-active-hover:#393144;--text-success:#6dc884;--text-warning:#e0b25b}
#shell{width:340px;border:1px solid var(--background-modifier-border);background:var(--background-secondary)}#panel{height:820px}.clickable-icon{display:flex;align-items:center;justify-content:center;border:0;background:transparent;cursor:pointer;font-size:19px}input{padding:6px;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);color:var(--text-normal)}#report{white-space:pre-wrap;font-size:11px;max-width:640px}button{font:inherit}button:disabled{opacity:.5}
`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(output, 'profile-'));
const child = spawn(executable, ['--headless','--disable-gpu','--no-first-run',`--user-data-dir=${profile}`,
  '--disable-extensions','--disable-background-networking','--remote-debugging-port=0','--window-size=1100,1050','about:blank'], { windowsHide:true, stdio:'ignore' });
let socket;
try {
  let port;
  for (let i=0;i<200;i++) {
    const activePort=path.join(profile,'DevToolsActivePort');
    if (fs.existsSync(activePort)) { port=fs.readFileSync(activePort,'utf8').split('\n')[0];break; }
    await pause(100);
  }
  assert.ok(port,'Headless browser failed to start');
  const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(10000)})).json();
  const page=pages.find(item=>item.type==='page' && item.url==='about:blank');
  assert.ok(page,'No isolated blank test page');
  socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let sequence=0;
  const pending=new Map();
  socket.onmessage=event=>{
    const response=JSON.parse(event.data),item=pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);clearTimeout(item.timer);
    if(response.error)item.reject(new Error(JSON.stringify(response.error)));else item.resolve(response.result);
  };
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Timed out: '+method));},15000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1100,height:1050,deviceScaleFactor:1,mobile:false});
  await send('Page.bringToFront');
  for (const theme of ['light','dark']) {
  const html = `<!doctype html><meta charset="utf-8"><style>${baseCss}\n${fs.readFileSync(path.join(root,'styles.css'),'utf8')}</style><body class="${theme}"><h2>VCS History — isolated UI verification</h2><div id="shell"><div id="panel"></div></div><pre id="report">Running…</pre><script>${bundle.outputFiles[0].text}</script></body>`;
  const file = path.join(output, theme+'.html');fs.writeFileSync(file, html);
  await send('Page.navigate',{url:pathToFileURL(file).href});
  let complete;
  for (let i=0;i<200;i++) {
    const state=await send('Runtime.evaluate',{expression:'document.getElementById("report")?.dataset.complete',returnByValue:true});
    complete=state.result?.value;if(complete)break;await pause(100);
  }
  const snapshot=await send('Runtime.evaluate',{expression:'document.documentElement.outerHTML',returnByValue:true});
  const dom=snapshot.result.value;
  fs.writeFileSync(path.join(output,theme+'-report.html'),dom);
  const report = dom.match(/<pre id="report"[^>]*>(.*?)<\/pre>/s)?.[1];
  assert.ok(/data-complete="true"/.test(dom),report || 'UI verification did not finish');
  console.log(theme+': '+JSON.parse(report).passed+' UI assertions passed');
  const screenshot=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(output,theme+'.png'),Buffer.from(screenshot.data,'base64'));
  }
  await send('Browser.close');
} finally { socket?.close();child.kill(); }
