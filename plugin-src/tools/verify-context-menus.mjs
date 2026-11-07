import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {connect} from './cdp.mjs';
if(!process.argv[2])throw new Error('Provide an isolated QA manifest.');
const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),c=await connect(m.port),results=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms)),e=code=>c.evaluate(`const p=app.plugins.plugins['live-git-diff'];${code}`);
const check=(name,ok,detail)=>{results.push({name,pass:!!ok,detail});assert.ok(ok,`${name}: ${JSON.stringify(detail)}`);console.log('PASS '+name);};
async function until(code){for(let i=0;i<160;i++){if(await e(`return ${code};`)){await wait(100);return;}await wait(50);}throw new Error('Timed out: '+code);}
const ready=()=>until("!p.historyReviewState().openingFile&&p.session?.status==='ready'");
const historyReady=()=>until('p.historyView()?.controller.state.entry&&!p.historyView().controller.state.loading');
async function escape(){await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait(60);}
const titles=()=>e("return [...document.querySelectorAll('.menu .menu-item-title')].filter(x=>x.getBoundingClientRect().width).map(x=>x.textContent);");
async function context(expression){
 await escape();await e(`const el=${expression};if(!el)throw new Error('Context target missing');el.scrollIntoView({block:'center'});return true;`);await wait(160);
 const point=await e(`const el=${expression},r=el.getBoundingClientRect();return {x:r.left+Math.min(24,r.width/2),y:r.top+Math.min(12,r.height/2)};`);
 for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,button:'right',clickCount:1,...point});await wait(160);return titles();
}
async function choose(title){
 const point=await e(`const el=[...document.querySelectorAll('.menu-item')].find(el=>el.querySelector('.menu-item-title')?.textContent===${JSON.stringify(title)}&&el.getBoundingClientRect().width);if(!el)throw new Error('Menu item missing: '+${JSON.stringify(title)});const r=el.getBoundingClientRect();return {x:r.left+40,y:r.top+r.height/2};`);
 for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});await wait(100);
}
const hasPair=items=>items.filter(x=>x==='Git History').length===1&&items.filter(x=>x==='Git Compare').length===1;
const explorer=file=>`app.workspace.getLeavesOfType('file-explorer')[0].view.containerEl.querySelector('[data-path="${file}"]')`;
let verifiedVault=false;
try{
 assert.equal(path.resolve(await e('return app.vault.adapter.basePath;')),path.resolve(m.vault));verifiedVault=true;
 await e("window.__menuCapture=app.workspace.on('file-menu',menu=>{window.__menuConstructor=menu.constructor;});return true;");
 await e("require('@electron/remote').getCurrentWindow().webContents.setBackgroundThrottling(false);p.closeReview();p.historyView()?.leaf.detach();p.settings.baseRefMode='head';for(const l of app.workspace.getLeavesOfType('markdown'))if(l.view.file?.path==='mapping.md')l.detach();const l=app.workspace.getLeaf('tab');await l.openFile(app.vault.getAbstractFileByPath('history-fixture.md'));app.workspace.leftSplit.expand();await app.workspace.revealLeaf(app.workspace.getLeavesOfType('file-explorer')[0]);return true;");
 let menu=await context(explorer('mapping.md'));check('Explorer has one pair of Git actions alongside native items',hasPair(menu)&&menu.length>4,menu);
 await choose('Git History');await historyReady();
 check('Explorer History targets the clicked file without opening its note',await e("return p.historyView().controller.state.file.path==='mapping.md'&&!app.workspace.getLeavesOfType('markdown').some(l=>l.view.file?.path==='mapping.md');"));
 await e('const v=p.historyView();v.controller.select(v.controller.state.entry.commits[0].sha,false);window.__menuDraft=v.controller.state;return true;');
 menu=await context(explorer('history-fixture.md'));await choose('Git Compare');await ready();
 check('Explorer Compare uses its clicked file and the configured HEAD',await e(`return p.session.filePath==='history-fixture.md'&&p.session.sha===${JSON.stringify(JSON.parse(fs.readFileSync(path.join(m.output,'history-fixture.local.json'),'utf8')).commits[2])};`));
 check('direct Compare leaves the other file history and draft unchanged',await e("return p.historyView().controller.state===window.__menuDraft&&p.historyView().controller.state.file.path==='mapping.md';"));
 await e("await p.reviewLeaf.setViewState({type:'markdown',state:{file:p.session.filePath,mode:'source',source:false},active:true});return true;");await wait(200);
 menu=await context("p.currentEditor().contentDOM.querySelector('.cm-line')");check('Live Preview editor retains native menu items and adds one Git pair',hasPair(menu)&&menu.length>4,menu);
 await choose('Git History');await historyReady();check('editor History targets its own note',await e("return p.historyView().controller.state.file.path==='history-fixture.md';"));
 const content='# Menu QA\n\nPlain reading text for a clipboard check.\n\n[[mapping]]\n\n[External link](https://example.com)\n\n| Key | Value |\n| --- | --- |\n| A | B |\n';
 await e(`let f=app.vault.getAbstractFileByPath('ux-menu.md');if(!f)f=await app.vault.create('ux-menu.md',${JSON.stringify(content)});window.__menuLeaf=app.workspace.getLeaf('tab');await window.__menuLeaf.openFile(f);await window.__menuLeaf.setViewState({type:'markdown',state:{file:f.path,mode:'preview'},active:true});return true;`);await wait(300);
 menu=await context("window.__menuLeaf.view.containerEl.querySelector('.markdown-preview-view p')");check('plain Reading view offers both file actions',hasPair(menu),menu);
 await choose('Git History');await historyReady();check('Reading History uses the clicked note even with another review open',await e("return p.historyView().controller.state.file.path==='ux-menu.md'&&p.session.filePath==='history-fixture.md';"));
 await e("const el=window.__menuLeaf.view.containerEl.querySelector('.markdown-preview-view p'),range=document.createRange();range.selectNodeContents(el);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);window.__menuClipboardOriginal=navigator.clipboard.writeText;navigator.clipboard.writeText=async text=>{window.__menuCopied=text;};return true;");
 menu=await context("window.__menuLeaf.view.containerEl.querySelector('.markdown-preview-view p')");check('selected Reading text retains Copy with the file actions',hasPair(menu)&&menu.filter(x=>x==='Copy').length===1,menu);
 await choose('Copy');check('Reading Copy passes the selected text to the clipboard API',await e("return window.__menuCopied==='Plain reading text for a clipboard check.';"));
 await e('navigator.clipboard.writeText=window.__menuClipboardOriginal;delete window.__menuClipboardOriginal;getSelection()?.removeAllRanges();return true;');
 menu=await context("window.__menuLeaf.view.containerEl.querySelector('a.internal-link')");check('internal-link menu keeps native actions without duplicate Git entries',hasPair(menu)&&menu.length>3,menu);
 await choose('Git History');await historyReady();check('internal link History uses the linked file',await e("return p.historyView().controller.state.file.path==='mapping.md';"));
 menu=await context("window.__menuLeaf.view.containerEl.querySelector('a.external-link')");check('external-link menu remains native',!menu.includes('Git History')&&!menu.includes('Git Compare')&&menu.length>1,menu);await escape();
 menu=await context("window.__menuLeaf.view.containerEl.querySelector('.view-header-title')");check('note header context has one Git action pair',hasPair(menu),menu);await escape();
 menu=await context("[...document.querySelectorAll('.workspace-tab-header-inner-title')].find(el=>el.textContent==='ux-menu')");check('note tab context has one Git action pair',hasPair(menu),menu);await escape();
 await e("await window.__menuLeaf.setViewState({type:'markdown',state:{file:'ux-menu.md',mode:'source',source:false},active:true});return true;");await wait(300);
 menu=await context("window.__menuLeaf.view.containerEl.querySelector('.cm-table-widget td')");check('native table menu retains its commands and has one Git pair',hasPair(menu)&&menu.length>4,menu);await escape();
 // Public event deduplication: different hooks can contribute to the same Menu.
 await e("const m=new window.__menuConstructor(),f=app.vault.getAbstractFileByPath('ux-menu.md');app.workspace.trigger('file-menu',m,f,'qa',window.__menuLeaf);app.workspace.trigger('editor-menu',m,window.__menuLeaf.view.editor,window.__menuLeaf.view);app.workspace.trigger('file-menu',m,f,'qa',window.__menuLeaf);m.showAtPosition({x:500,y:200});return true;");await wait(150);
 menu=await titles();check('shared menu is decorated once across repeated native hooks',hasPair(menu),menu);await escape();
 await e("const m=new window.__menuConstructor();app.workspace.trigger('file-menu',m,app.vault.getRoot(),'qa');m.addItem(i=>i.setTitle('QA folder item'));m.showAtPosition({x:500,y:200});return true;");await wait(120);
 menu=await titles();check('folder menus do not offer Markdown-only actions',!menu.includes('Git History')&&!menu.includes('Git Compare'),menu);await escape();
 await e("await window.__menuLeaf.setViewState({type:'markdown',state:{file:'ux-menu.md',mode:'preview'},active:true});return true;");await wait(200);
 await c.evaluate("await app.plugins.disablePlugin('live-git-diff');await app.plugins.enablePlugin('live-git-diff');return true;");await wait(250);
 menu=await context("window.__menuLeaf.view.containerEl.querySelector('.markdown-preview-view p')");check('plugin reload does not duplicate DOM menu handlers',hasPair(menu),menu);
 const pic=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(m.output,'reading-context-menu.png'),Buffer.from(pic.data,'base64'));await escape();
}finally{
 if(verifiedVault)await e("if(window.__menuCapture)app.workspace.offref(window.__menuCapture);delete window.__menuCapture;delete window.__menuConstructor;if(window.__menuClipboardOriginal)navigator.clipboard.writeText=window.__menuClipboardOriginal;delete window.__menuClipboardOriginal;delete window.__menuCopied;delete window.__menuDraft;window.__menuLeaf?.detach();delete window.__menuLeaf;const f=app.vault.getAbstractFileByPath('ux-menu.md');if(f)await app.vault.delete(f);return true;").catch(()=>{});
 fs.writeFileSync(path.join(m.output,'context-menus-verification.json'),JSON.stringify({date:new Date().toISOString(),results},null,2));c.close();
}
console.log(`${results.length} context menu assertions passed`);
