/** Isolated repository UI QA. No real vault/repository mutations.
 * Usage: node tools/verify-repository-ui.mjs <Chromium executable>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.env.LGD_UI_QA_OUTPUT || path.join(root, '../.npm-cache/repository-ui'));
const executable = process.argv[2];
assert.ok(executable && fs.existsSync(executable), 'Provide a Chromium executable.');
fs.mkdirSync(output, { recursive: true });
const stub = `
function create(tag, options = {}) {
  const el = document.createElement(tag);
  if (options.cls) el.className = options.cls;
  if (options.text) el.textContent = options.text;
  if (options.type) el.type = options.type;
  if (options.placeholder) el.placeholder = options.placeholder;
  for (const [key,value] of Object.entries(options.attr || {})) el.setAttribute(key,value);
  this.appendChild(el); return el;
}
Object.assign(HTMLElement.prototype, {
  createEl:create, createDiv(options){return create.call(this,'div',options);}, createSpan(options){return create.call(this,'span',options);},
  empty(){this.replaceChildren();}, addClass(...names){this.classList.add(...names);}, toggleClass(name,value){this.classList.toggle(name,value);},
  setText(value){this.textContent=value;}, setAttr(name,value){this.setAttribute(name,value);}, toggle(value){this.style.display=value?'':'none';}
});
export class ItemView { constructor(leaf){this.leaf=leaf;this.app=leaf.app;this.contentEl=leaf.contentEl;} }
export class Scope { register(){} }
export class WorkspaceLeaf {}
export class App {}
export class PluginSettingTab { constructor(app){this.app=app;this.containerEl=document.createElement('div');} }
class Control {
  constructor(parent,tag='input'){this.inputEl=parent.createEl(tag);this.selectEl=this.inputEl;}
  setValue(value){this.inputEl.value=String(value);return this;}
  setPlaceholder(value){this.inputEl.placeholder=value;return this;}
  setDisabled(value){this.inputEl.disabled=value;return this;}
  setLimits(){return this;} setDynamicTooltip(){return this;} setTooltip(){return this;}
  setIcon(){return this;} setButtonText(value){this.inputEl.textContent=value;return this;}
  addOption(value,text){this.selectEl.createEl('option',{value,text});this.selectEl.lastChild.value=value;return this;}
  addOptions(values){for(const [value,text] of Object.entries(values))this.addOption(value,text);return this;}
  onChange(callback){this.inputEl[this.inputEl.tagName==='SELECT'?'onchange':'oninput']=()=>callback(this.inputEl.value);return this;}
  onClick(callback){this.inputEl.onclick=callback;return this;}
}
export class Setting {
  constructor(parent){this.settingEl=parent.createDiv({cls:'setting-item'});this.controlEl=this.settingEl.createDiv();}
  setName(value){this.settingEl.dataset.name=value;return this;} setDesc(value){this.settingEl.title=value;return this;}
  setHeading(){return this;}
  addDropdown(fn){fn(new Control(this.controlEl,'select'));return this;}
  addText(fn){fn(new Control(this.controlEl));return this;}
  addTextArea(fn){fn(new Control(this.controlEl,'textarea'));return this;}
  addButton(fn){fn(new Control(this.controlEl,'button'));return this;}
  addExtraButton(fn){return this.addButton(fn);}
  addSlider(fn){return this.addText(fn);} addToggle(fn){return this.addText(fn);}
}
export class Notice { constructor(text){window.notices.push(text);} }
export class Menu {
  static last; items=[];
  addItem(configure){const item={title:'',setTitle(value){this.title=value;return this;},setIcon(){return this;},setDisabled(value){this.disabled=value;return this;},onClick(value){this.callback=value;return this;}};configure(item);this.items.push(item);return this;}
  addSeparator(){} showAtMouseEvent(){Menu.last=this;}
}
export function setIcon(el,name){el.dataset.icon=name;el.textContent=({'arrow-left':'←','arrow-right':'→','refresh-cw':'↻','history':'◷','git-commit-horizontal':'⊙','camera':'▣','folder':'▱'})[name] || '•';}
`;
const entry = `
import { GitRepositoryView } from './src/repositoryView.ts';
import { ExplainView } from './src/explainView.ts';
import { LiveGitDiffSettingTab, mergeSettings } from './src/settings.ts';
import { Menu } from 'obsidian';
const results=[];
const check=(name,value)=>{results.push({name,pass:!!value});if(!value)throw new Error(name);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const turn=()=>pause(20);
const context={root:'/vault/.git',workspaceRoot:'/vault',backend:'jj',abs:'/vault',rel:''};
const files=[{path:'Stories/Checkout.md',status:'M'},{path:'Stories/Payments.md',status:'A'},{path:'Archive/Old story.md',status:'D'},{path:'README.md',status:'R',oldPath:'Introduction.md'}];
const change=i=>({sha:String(i).padStart(40,'a'),shortSha:'a'+i,changeId:'change'+i,subject:i===1?'Clarify payment acceptance criteria':'Review story '+i,author:'Product owner',date:'Nov 14, 2026',description:'Clarify payment acceptance criteria\\n\\nInclude cancellation and retry scenarios.',parents:['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']});
window.notices=[];
window.qa={files:[...files],anchor:'one',fail:false,saves:[],snapshots:0,detail:async sha=>({change:{...change(1),sha},files})};
const calls=[];let view;
const host={settings:{logLimit:10},
  saveSettings:async()=>{qa.preferenceSaves=(qa.preferenceSaves||0)+1;},
  loadRepositoryHistory:async(ctx,path,offset,limit)=>({changes:Array.from({length:Math.min(limit,25-offset)},(_,i)=>change(offset+i+1)),hasMore:offset+limit<25,anchor:qa.anchor}),
  navigateRepository:async route=>{calls.push(route);await view.setRoute(route);},
  openRepositoryFile:async(ctx,path,revision)=>calls.push({kind:'file',path,revision}),
  openRepositoryNote:async(ctx,path)=>calls.push({kind:'note',path}),
  navigationBack:()=>calls.push({kind:'back'}),navigationForward:()=>calls.push({kind:'forward'}),navigationState:()=>({back:true,forward:false}),repositoryChanged:async()=>{},
  repositorySyncOutcome:()=>qa.outcome,
  generateDescription:async(ctx,paths,token,signal)=>qa.generate ? qa.generate(signal) : 'Generated description',
  explainRepository:async(ctx,options)=>calls.push({kind:'explain',...options}),
  syncRepository:async(ctx,action)=>{calls.push({kind:'sync',action,context:ctx});if(qa.syncWait)await qa.syncWait;if(qa.syncError)throw new Error(qa.syncError);}
};
const panel=document.getElementById('panel');
view=new GitRepositoryView({contentEl:panel,app:{scope:{}}},host);
const get=selector=>panel.querySelector(selector), all=selector=>[...panel.querySelectorAll(selector)];
const commits=()=>all('.lgd-repository-change:not([data-sync="pending"])');
const contextMenu=element=>{element.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));return Menu.last.items;};
const input=(element,value)=>{element.value=value;element.dispatchEvent(new Event('input'));};
async function run(){
  await view.onOpen();await view.setRoute({kind:'log',context});
  check('Repository history uses bounded pages',commits().length===10);
  check('Pending changes are the first gray timeline item',get('.lgd-repository-change').dataset.sync==='pending' && get('.lgd-repository-change').textContent.includes('4 pending files'));
  const synced=get('[data-sync="synced"]'),unsynced=get('[data-sync="unsynced"]');
  check('Remote ancestors and unpublished commits have distinct colored dots',!!synced && !!unsynced && getComputedStyle(synced,'::before').backgroundColor!==getComputedStyle(unsynced,'::before').backgroundColor);
  check('Navigating list entries use the link cursor',getComputedStyle(synced).cursor==='pointer' && getComputedStyle(get('[data-sync="pending"]')).cursor==='pointer');
  check('Repository icon differs from file history',view.getIcon()==='git-branch');
  get('[data-sync="pending"]').click();await turn();
  check('Clicking the pending entry navigates to Pending changes',view.currentRoute.kind==='changes');
  await view.setRoute({kind:'log',context});
  check('Back and forward reflect shared navigation',!get('[aria-label="Back"]').disabled && get('[aria-label="Forward"]').disabled);
  get('.lgd-repository-change').focus();get('.lgd-repository-change').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  check('Keyboard moves through changes',document.activeElement===all('.lgd-repository-change')[1]);
  qa.anchor='two';get('.lgd-history-more').click();await turn();
  check('Changed anchor restarts pagination',commits().length===10);
  get('.lgd-history-more').click();await turn();check('Stable anchor appends a page',commits().length===20);
  input(get('input[type="search"]'),'payment');check('Filter searches loaded changes',commits().length===1);
  commits()[0].click();await turn();
  check('Click opens full change details',view.currentRoute.kind==='details' && get('.lgd-repository-details').textContent.includes('cancellation and retry'));
  check('Details group affected folders',all('.lgd-repository-folder').length===2 && all('.lgd-repository-file').length===4);
  const deleted=all('.lgd-repository-file').find(row=>row.textContent.includes('Old story'));
  check('Deleted file offers history without open file',contextMenu(deleted).some(item=>item.title==='VCS History') && !contextMenu(deleted).some(item=>item.title==='Open file'));
  get('.lgd-repository-filename').click();await turn();check('File history receives selected revision',calls.at(-1).kind==='file' && !!calls.at(-1).revision);
  const folder=all('summary').find(el=>el.textContent.includes('Stories'));
  contextMenu(folder).find(item=>item.title==='VCS History').callback();await turn();
  check('Folder context menu opens scoped history',view.currentRoute.kind==='log' && view.currentRoute.path==='Stories');
  await view.setRoute({kind:'changes',context,paths:['Stories/']});
  check('Folder entry preselects only descendants',all('.lgd-repository-file input:checked').length===2);
  check('Create requires description',get('.mod-cta').disabled);
  input(get('textarea'),'Review checkout flow');check('Description enables create',!get('.mod-cta').disabled);
  qa.fail=true;get('.mod-cta').click();await turn();
  check('Failed create retains draft and selection',get('textarea').value==='Review checkout flow' && all('.lgd-repository-file input:checked').length===2 && get('.lgd-error').textContent.includes('Repository changed'));
  await view.setRoute({kind:'log',context});await view.setRoute({kind:'changes',context});
  check('Navigation preserves pending draft',get('textarea').value==='Review checkout flow' && all('.lgd-repository-file input:checked').length===2);
  const changeLayout=value=>{const select=get('[aria-label="Pending files view"]');select.value=value;select.dispatchEvent(new Event('change'));};
  changeLayout('list');await turn();
  check('File List flattens folders while preserving every file and selection',!get('.lgd-repository-folder') && all('.lgd-repository-file').length===4 && all('.lgd-repository-file input:checked').length===2);
  check('File List filenames start immediately after their checkboxes',all('.lgd-repository-filename').every(button=>{
    const name=button.querySelector('.lgd-repository-filename-text');
    return Math.abs(name.getBoundingClientRect().left-button.getBoundingClientRect().left-parseFloat(getComputedStyle(button).paddingLeft))<1;
  }));
  check('File List keeps directory paths in tooltips',all('.lgd-repository-filename').every(button=>files.some(file=>button.title.includes(file.path))));
  check('File List preserves description and persists preference',get('textarea').value==='Review checkout flow' && host.settings.pendingChangesView==='list' && qa.preferenceSaves===1);
  input(get('input[type="search"]'),'Stories/');check('File List still filters by directory',all('.lgd-repository-file').length===2);
  input(get('input[type="search"]'),'');
  await view.setRoute({kind:'log',context});await view.setRoute({kind:'changes',context});
  check('File List preference survives navigation',get('[aria-label="Pending files view"]').value==='list' && !get('.lgd-repository-folder'));
  changeLayout('tree');await turn();
  check('File Tree restores folders and keeps the draft',all('.lgd-repository-folder').length===2 && get('textarea').value==='Review checkout flow');
  const stories=all('summary').find(el=>el.textContent.includes('Stories'));
  contextMenu(stories).find(item=>item.title==='Deselect folder').callback();check('Folder menu deselects files',all('.lgd-repository-file input:checked').length===0);
  get('.lgd-repository-selection input').click();check('Select all includes all pending files',all('.lgd-repository-file input:checked').length===4);
  let finish;qa.saveWait=new Promise(resolve=>finish=resolve);qa.fail=false;
  get('.mod-cta').click();await turn();check('Mutation disables controls',get('.mod-cta').disabled && get('textarea').disabled);
  get('.mod-cta').click();finish();await turn();check('Repeated submission creates one change',qa.saves.length===2);
  check('Successful create clears draft and selection',get('textarea').value==='' && all('.lgd-repository-file input:checked').length===0);
  qa.saveWait=null;get('[aria-label="Snapshot working copy"]').click();await turn();check('Snapshot preserves current change',qa.snapshots===1 && view.currentRoute.kind==='changes');
  await view.setRoute({kind:'changes',context:{...context,backend:'git'}});check('Git hides exclusive snapshot action',!get('[aria-label="Snapshot working copy"]'));
  let finishDetails;qa.detail=()=>new Promise(resolve=>finishDetails=resolve);
  const pending=view.setRoute({kind:'details',context,sha:'old'});await turn();await view.setRoute({kind:'changes',context});
  finishDetails({change:change(2),files});await pending;
  check('Stale details cannot overwrite a later route',view.currentRoute.kind==='changes' && !get('.lgd-repository-details'));
  qa.files=[...files];await view.refresh();input(get('textarea'),'Finalize checkout story');
  get('.lgd-repository-selection input').click();
  const saves=qa.saves.length;get('[aria-label="Generate description"]').click();await turn();
  check('AI generation only fills editable description',get('textarea').value==='Generated description' && qa.saves.length===saves && !get('textarea').disabled);
  contextMenu(get('.lgd-repository-selection')).find(item=>item.title==='Explain selected changes').callback();await turn();
  check('Explain receives selected paths and status token',calls.at(-1).kind==='explain' && calls.at(-1).paths.length===4 && calls.at(-1).token==='status');
  qa.generate=signal=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Cancelled'))));
  get('[aria-label="Generate description"]').click();await turn();
  check('AI generation can be cancelled without creating a change',!get('[aria-label="Cancel generation"]').disabled && get('.mod-cta').disabled);
  get('[aria-label="Cancel generation"]').click();await turn();
  check('Cancellation preserves previous description',get('textarea').value==='Generated description' && qa.saves.length===saves);
  check('Push and pull are available in the repository header',!!get('[aria-label="Push"]') && !!get('[aria-label="Pull"]'));
  const remoteMenu=contextMenu(get('.lgd-repository-location'));
  check('Repository context menu exposes sync without remote overrides',remoteMenu.filter(item=>['Push','Pull'].includes(item.title)).length===2 && !remoteMenu.some(item=>item.title==='Remote settings'));
  let finishSync;qa.syncWait=new Promise(resolve=>finishSync=resolve);
  get('[aria-label="Push"]').click();await turn();
  check('Push disables mutations and reports progress',get('.mod-cta').disabled && get('[aria-label="Pull"]').disabled && get('.lgd-history-footer').textContent==='Pushing…');
  const pushCount=calls.filter(call=>call.kind==='sync').length;
  remoteMenu.find(item=>item.title==='Push').callback();await turn();
  check('Repeated remote action is ignored while busy',calls.filter(call=>call.kind==='sync').length===pushCount && contextMenu(get('.lgd-repository-heading')).find(item=>item.title==='Push').disabled);
  finishSync();await turn();qa.syncWait=null;
  check('Successful push preserves the pending review draft',get('textarea').value==='Generated description' && all('.lgd-repository-file input:checked').length===4 && !get('[aria-label="Pull"]').disabled);
  qa.syncError='Remote branch diverged. Resolve it before pulling.';get('[aria-label="Pull"]').click();await turn();
  check('Pull errors remain visible without clearing the draft',get('.lgd-error').textContent.includes('Remote branch diverged') && get('textarea').value==='Generated description' && !get('[aria-label="Push"]').disabled);

  // Folder selection must include filtered descendants and stay synchronized
  // with individually selected files, without requiring a refresh.
  view.state.selected.clear();view.render();
  const folderCheckbox=()=>get('[aria-label="Include folder Stories"]');
  const fileCheckbox=()=>get('[aria-label="Include Stories/Checkout.md"]');
  fileCheckbox().click();
  check('Individual selection makes the folder indeterminate',!folderCheckbox().checked && folderCheckbox().indeterminate);
  folderCheckbox().click();
  check('Partially selected folder selects its remaining files',folderCheckbox().checked && view.state.selected.size===2);
  fileCheckbox().click();
  check('Individual deselection clears the folder checked state',!folderCheckbox().checked && folderCheckbox().indeterminate);
  folderCheckbox().click();
  check('Click after individual deselection selects all again',folderCheckbox().checked && view.state.selected.size===2);
  folderCheckbox().click();
  check('Checked folder deselects every descendant',view.state.selected.size===0);
  input(get('input[type="search"]'),'Payments');folderCheckbox().click();
  check('Filtered folder selection includes hidden matching descendants',view.state.selected.has('Stories/Checkout.md') && view.state.selected.has('Stories/Payments.md') && view.state.selected.size===2);
  folderCheckbox().click();
  check('Filtered folder deselection clears hidden descendants too',view.state.selected.size===0);
  input(get('input[type="search"]'),'');get('.lgd-repository-selection input').click();
  qa.generate=async()=>{throw 'Generation failed with a plain-text diagnostic';};
  await view.generateDescription();
  check('Plain-text AI errors show a useful diagnostic',get('.lgd-error').textContent.includes('plain-text diagnostic'));
  qa.generate=async()=>{throw new Error('   ');};await view.generateDescription();
  check('Empty AI errors cannot produce an empty red container',get('.lgd-error').textContent.includes('failed without details'));
  view.error='Commit rejected: '+('very-long-path/'.repeat(80));view.render();
  let footer=get('.lgd-history-footer');
  // Reproduce themes that use the same solid red for both error variables.
  document.body.style.setProperty('--background-modifier-error','#cc3333');
  document.body.style.setProperty('--text-error','#cc3333');
  const luminance=color=>{
    const channels=color.slice(color.indexOf('(')+1,color.lastIndexOf(')')).split(',').slice(0,3).map(value=>Number(value)/255)
      .map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4);
    return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
  };
  const readable=element=>{
    const style=getComputedStyle(element),a=luminance(style.color),b=luminance(style.backgroundColor);
    return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=4.5;
  };
  check('Repository errors stay readable when theme error text and background are identical',readable(footer));
  for(const cls of ['lgd-history-active lgd-error','lgd-explain-text lgd-error','lgd-error']){
    const probe=document.body.createDiv({cls,text:'Error diagnostic'});
    check('Diagnostic contrast is preserved for '+cls,readable(probe));probe.remove();
  }
  document.body.style.removeProperty('--background-modifier-error');
  document.body.style.removeProperty('--text-error');
  check('Long error paths wrap inside the panel',footer.scrollWidth<=footer.clientWidth+1 && !!get('.lgd-repository-error-copy'));
  view.error=Array.from({length:80},(_,i)=>'Diagnostic line '+i).join('\\n');view.render();
  footer=get('.lgd-history-footer');
  check('Multiline diagnostics have bounded height and scroll',footer.clientHeight<=221 && footer.scrollHeight>footer.clientHeight);
  check('Error remains inside the panel bounds',footer.getBoundingClientRect().bottom<=panel.getBoundingClientRect().bottom);
  panel.style.height='330px';view.render();
  check('Small panels can scroll to composer and error',panel.scrollHeight>panel.clientHeight && getComputedStyle(panel).overflowY==='auto');
  panel.style.height='820px';

  // Exercise effort changes through the actual settings controls.
  const plugin={settings:mergeSettings({ai:{description:{model:'gpt-6-luna',effort:'none'}}}),saveSettings:async()=>{}};
  const tab=new LiveGitDiffSettingTab({},plugin);tab.display();
  const settings=tab.containerEl;
  check('Settings have no manual remote configuration',!settings.querySelector('[data-name="Remote"]'));
  check('Previous-version comparison is the default',plugin.settings.baseRefMode==='file-prev');
  const setting=(name,index=0)=>settings.querySelectorAll('[data-name="'+name+'"]')[index];
  const efforts=()=>setting('Reasoning effort').querySelector('select');
  const options=()=>[...efforts().options].map(option=>option.value);
  check('Luna settings expose its supported efforts',options().includes('none') && options().includes('max') && !options().includes('minimal'));
  input(setting('Model').querySelector('input'),'gpt-5.3-codex');
  check('Changing model updates effort options and clears an incompatible value',!options().includes('none') && !options().includes('max') && plugin.settings.ai.description.effort==='');
  const agent=setting('Agent').querySelector('select');agent.value='claude';agent.dispatchEvent(new Event('change'));await turn();
  check('Claude Code has a selectable effort control',!efforts().disabled && options().includes('high'));
  input(setting('Model').querySelector('input'),'claude-opus-4-6');
  check('Opus exposes max effort',options().includes('max'));
  efforts().value='max';efforts().dispatchEvent(new Event('change'));await turn();
  check('Effort choice is saved independently per AI purpose',plugin.settings.ai.description.effort==='max' && plugin.settings.ai.explain.effort==='');
  input(setting('Model').querySelector('input'),'custom-model');
  check('Unknown models use CLI effort defaults',efforts().disabled && plugin.settings.ai.description.effort==='');

  // Explain keeps a close action after success/error and aborts an active request.
  const explainRoot=document.createElement('div');let detached=0,explain;
  const leaf={contentEl:explainRoot,app:{},detach(){detached++;void explain.onClose();}};
  explain=new ExplainView(leaf);await explain.onOpen();
  await explain.explain('Success',async()=>'Explanation');
  check('Explain success retains a close action',!!explainRoot.querySelector('[aria-label="Close Explain panel"]') && !explainRoot.querySelector('[aria-label="Cancel generation"]'));
  await explain.explain('Failure',async()=>{throw 'Explain diagnostic';});
  check('Explain failures preserve diagnostics and close action',explainRoot.textContent.includes('Explain diagnostic') && !!explainRoot.querySelector('[aria-label="Close Explain panel"]'));
  let explainSignal;
  const request=explain.explain('Working',signal=>{explainSignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Cancelled'))));});
  check('Explain cancel and close have distinct icons',explainRoot.querySelector('[aria-label="Cancel generation"]').dataset.icon==='square' && explainRoot.querySelector('[aria-label="Close Explain panel"]').dataset.icon==='x');
  explainRoot.querySelector('[aria-label="Close Explain panel"]').click();await request;
  check('Closing Explain aborts its request and detaches the panel',explainSignal.aborted && detached===1);
  qa.files=[...files];await view.setRoute({kind:'log',context});view.state.query='';view.render();
  qa.health={kind:'conflict',summary:'Bookmark targets conflict · origin/main',target:{remote:'origin',branch:'main'},ahead:1,behind:1,
    hints:['Pull can reconcile a single unpublished local line.'],refs:[{name:'main',sha:change(1).sha,conflicted:true},{name:'origin/main',sha:change(2).sha}],conflicts:[change(1).sha],files:['Stories/Checkout.md']};
  qa.outcome={action:'pull',message:'Fetched origin/main. Integration stopped.\\nIncoming changes conflict with local history: Stories/Checkout.md.',attention:true};
  await view.refresh();
  check('Conflicted bookmarks keep history and identify both branch targets',commits().length>=10 && get('.lgd-repository-sync-status').textContent.includes('Bookmark targets conflict') && all('.lgd-repository-ref').some(el=>el.textContent==='main (conflicted)') && all('.lgd-repository-ref').some(el=>el.textContent==='origin/main'));
  check('File conflicts are visible on history entries',!!get('.lgd-repository-ref[data-conflict="true"]') && all('.lgd-repository-ref').some(el=>el.textContent==='File conflicts'));
  check('Sync panel retains the fetched outcome and actual reason after refresh',get('.lgd-repository-sync-status').textContent.includes('Incoming changes conflict with local history') && get('.lgd-repository-sync-status').textContent.includes('1 local / 1 incoming'));
  check('Sync diagnostics have a copy action',all('.lgd-repository-error-copy').some(el=>el.textContent==='Copy sync details'));
  get('.lgd-repository-sync-files').click();await turn();
  check('Conflicted-file shortcut uses the existing Pending Changes screen',view.currentRoute.kind==='changes');
  qa.health={...qa.health,kind:'blocked',summary:'Unfinished rebase · sync needs attention',hints:['Finish or abort the current operation in your VCS, then refresh.']};
  await view.setRoute({kind:'log',context});
  check('Unfinished Git operations have a persistent explanation without losing history',get('.lgd-repository-sync-status').textContent.includes('Unfinished rebase') && commits().length>=10);
  const report=document.getElementById('report');report.textContent=JSON.stringify({results,passed:results.length});report.dataset.complete='true';
}
run().catch(error=>{const report=document.getElementById('report');report.textContent=JSON.stringify({results,error:error.stack});report.dataset.complete='failed';});
`;
const bundle = await build({stdin:{contents:entry,resolveDir:root},bundle:true,write:false,format:'iife',plugins:[{name:'isolated-host',setup(builder){
  builder.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'qa'}));
  builder.onLoad({filter:/.*/,namespace:'qa'},()=>({contents:stub}));
  builder.onResolve({filter:/^(child_process|os)$/},args=>({path:args.path,namespace:'qa-node'}));
  builder.onLoad({filter:/.*/,namespace:'qa-node'},()=>({contents:'export const spawn=()=>{throw new Error("Unexpected process")}; export const execFile=spawn; export const tmpdir=()=>"/tmp";'}));
  builder.onResolve({filter:/repositoryRemote\.ts$/},()=>({path:'remote',namespace:'qa-remote'}));
  builder.onLoad({filter:/.*/,namespace:'qa-remote'},()=>({contents:'export const repositorySyncState=async(ctx,ids)=>({synced:ids.filter((_,index)=>index%2===0),remote:"origin/main"});export const repositoryRemoteHealth=async()=>globalThis.qa?.health||null;'}));
  builder.onResolve({filter:/repositoryManager\.ts$/},()=>({path:'manager',namespace:'qa-manager'}));
  builder.onLoad({filter:/.*/,namespace:'qa-manager'},()=>({contents:`
    export const getChangeDetails=async(ctx,sha)=>qa.detail(sha);
    export const getRepositoryStatus=async()=>({files:qa.files,token:'status'});
    export const createChange=async(ctx,paths,description,token)=>{qa.saves.push({paths,description,token});if(qa.fail)throw new Error('Repository changed. Refresh first.');if(qa.saveWait)await qa.saveWait;qa.files=[];};
  `}));
  builder.onResolve({filter:/repository\.ts$/},()=>({path:'repository',namespace:'qa-repository'}));
  builder.onLoad({filter:/.*/,namespace:'qa-repository'},()=>({contents:'export const snapshotWorkspace=async()=>{qa.snapshots++;};'}));
}}]});
const baseCss=`*{box-sizing:border-box}body{font:14px system-ui;margin:24px;background:var(--background-primary);color:var(--text-normal)}
:root{--background-primary:#fff;--background-secondary:#f7f7f7;--text-normal:#262626;--text-muted:#686868;--text-faint:#aaa;--background-modifier-border:#ddd;--background-modifier-hover:#eee;--background-modifier-active-hover:#e9e6f4;--interactive-accent:#7655bb;--interactive-accent-hover:#6748a8;--text-on-accent:white;--text-success:#248342;--text-warning:#af7818;--text-error:#c33;--font-ui-smaller:12px;--font-ui-small:13px;--font-monospace:monospace;--radius-s:4px}
body.dark{--background-primary:#202020;--background-secondary:#252525;--text-normal:#ddd;--text-muted:#aaa;--text-faint:#666;--background-modifier-border:#444;--background-modifier-hover:#333;--background-modifier-active-hover:#393144;--text-success:#6dc884;--text-warning:#e0b25b}
#shell{width:340px;border:1px solid var(--background-modifier-border);background:var(--background-secondary)}#panel{height:820px}.clickable-icon{display:flex;align-items:center;justify-content:center;border:0;background:transparent;cursor:pointer;font-size:19px;width:24px;padding:2px}input,textarea{padding:6px;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);color:var(--text-normal)}#report{white-space:pre-wrap;font-size:11px;max-width:640px}button{font:inherit;justify-content:center}button:disabled{opacity:.5}.mod-cta{background:var(--interactive-accent);color:var(--text-on-accent);padding:8px;border:0;border-radius:4px}
`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profile=fs.mkdtempSync(path.join(output,'profile-'));
const child=spawn(executable,['--headless','--disable-gpu','--no-first-run',`--user-data-dir=${profile}`,'--disable-extensions','--disable-background-networking','--remote-debugging-port=0','--window-size=1100,1050','about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;
try {
  let port;
  for(let i=0;i<200;i++){const file=path.join(profile,'DevToolsActivePort');if(fs.existsSync(file)){port=fs.readFileSync(file,'utf8').split('\n')[0];break;}await pause(100);}
  assert.ok(port,'Browser failed to start');
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(10000)})).json();
  const page=pages.find(item=>item.type==='page'&&item.url==='about:blank');assert.ok(page);
  socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let sequence=0;const pending=new Map();
  socket.onmessage=event=>{const response=JSON.parse(event.data),item=pending.get(response.id);if(!item)return;pending.delete(response.id);clearTimeout(item.timer);if(response.error)item.reject(new Error(JSON.stringify(response.error)));else item.resolve(response.result);};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Timed out: '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1100,height:1050,deviceScaleFactor:1,mobile:false});
  for(const theme of ['light','dark']){
    const file=path.join(output,theme+'.html');
    fs.writeFileSync(file,`<!doctype html><meta charset="utf-8"><style>${baseCss}\n${fs.readFileSync(path.join(root,'styles.css'),'utf8')}</style><body class="${theme}"><h2>Repository — isolated UI verification</h2><div id="shell"><div id="panel"></div></div><pre id="report">Running…</pre><script>${bundle.outputFiles[0].text}</script></body>`);
    await send('Page.navigate',{url:pathToFileURL(file).href});
    let complete;
    for(let i=0;i<200;i++){const state=await send('Runtime.evaluate',{expression:'document.getElementById("report")?.dataset.complete',returnByValue:true});complete=state.result?.value;if(complete)break;await pause(100);}
    const result=await send('Runtime.evaluate',{expression:'document.getElementById("report").textContent',returnByValue:true});
    const report=JSON.parse(result.result.value);fs.writeFileSync(path.join(output,theme+'-report.json'),JSON.stringify(report,null,2));
    assert.equal(complete,'true',JSON.stringify(report));console.log(`${theme}: ${report.passed} UI assertions passed`);
    const screenshot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,theme+'.png'),Buffer.from(screenshot.data,'base64'));
  }
  await send('Browser.close');
} finally {socket?.close();child.kill();}
