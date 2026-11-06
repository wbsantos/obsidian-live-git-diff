import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {connect} from './cdp.mjs';
if (!process.argv[2]) throw new Error('Provide the isolated visual QA manifest.');
const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8')), item=m.cases[0], label=process.argv[3]||'V15';
const c=await connect(m.port), results=[], wait=ms=>new Promise(r=>setTimeout(r,ms));
const e=code=>c.evaluate(`const p=app.plugins.plugins['live-git-diff'];${code}`);
const table=`[...p.currentEditor().contentDOM.querySelectorAll('tr')].find(tr=>tr.cells[0]?.textContent.trim()===${JSON.stringify(label)})`;
const check=(name,ok,detail)=>{results.push({name,pass:!!ok,detail});assert.ok(ok,`${name}: ${JSON.stringify(detail)}`);console.log('PASS '+name);};
async function until(code){for(let i=0;i<160;i++){if(await e(`return ${code};`)){await wait(120);return;}await wait(50);}throw new Error('Timed out: '+code);}
const ready=()=>until("p.session?.status==='ready'&&p.snapshotViews().every(v=>v.blockEls.size===(v.side==='a'?p.session.baseRows:p.session.noteRows).length)");
async function show(){await e(`const row=p.session.rows.find(r=>r.b?.cells?.some(c=>c[0]?.text===${JSON.stringify(label)})),v=p.currentEditor();v.dispatch({effects:v.constructor.scrollIntoView(v.state.doc.line(row.b.lineStart+1).from,{y:'start'})});return true;`);await until(`!!(${table})`);await e(`(${table}).cells[1].scrollIntoView({block:'center'});return true;`);await wait(150);}
async function key(mod,key,code){for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key,code,modifiers:mod,windowsVirtualKeyCode:key.toUpperCase().charCodeAt(0)});}
async function green(name){
 const points=await e(`const cell=(${table}).cells[1],r=cell.getBoundingClientRect();return [4,12,24].map(n=>({x:r.left+n,y:r.bottom-5}));`);
 const pic=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(m.output,name+'.png'),Buffer.from(pic.data,'base64'));
 const pixels=await e(`const img=new Image();img.src='data:image/png;base64,'+${JSON.stringify(pic.data)};await img.decode();const cv=document.createElement('canvas');cv.width=img.width;cv.height=img.height;const ctx=cv.getContext('2d');ctx.drawImage(img,0,0);const s=img.width/innerWidth;return ${JSON.stringify(points)}.map(pt=>Array.from(ctx.getImageData(Math.round(pt.x*s),Math.round(pt.y*s),1,1).data).slice(0,3));`);
 check(name,pixels.filter(rgb=>rgb[1]>rgb[0]+8&&rgb[1]>rgb[2]+8).length>=2,pixels);
}
let verifiedVault=false;
try{
 assert.equal(path.resolve(await e('return app.vault.adapter.basePath;')),path.resolve(m.vault));verifiedVault=true;
 await e(`p.closeReview();for(const l of app.workspace.getLeavesOfType('markdown'))if(l.view.file?.path===${JSON.stringify(item.file)})l.detach();return true;`);
 fs.writeFileSync(path.join(m.vault,item.file),item.after);await wait(400);
 await e(`const file=app.vault.getAbstractFileByPath(${JSON.stringify(item.file)}),leaf=app.workspace.getLeaf('tab');await leaf.openFile(file);await leaf.setViewState({type:'markdown',state:{file:file.path,mode:'source',source:false},active:true});await p.openReview({file,ref:${JSON.stringify(m.qaSha)}});p.sync.enabled=false;app.workspace.setActiveLeaf(p.reviewLeaf,{focus:true});return true;`);await ready();
 await e("p.currentEditor().dispatch({selection:{anchor:0}});p.currentEditor().focus();return app.commands.executeCommandById('editor:unfold-all');");await wait(300);await show();
 const original=await e(`return {text:p.session.currentText,cell:(${table}).cells[1].textContent};`);
 const point=await e(`const r=(${table}).cells[1].getBoundingClientRect();return {x:r.left+30,y:r.top+20};`);
 for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});await wait(180);
 check('native cell editor opens without a plugin gutter',await e(`return !!document.activeElement.closest('td .cm-editor')&&!document.activeElement.closest('.cm-editor').querySelector('.lgd-gutter');`));
 await green('table-active-cell-green');
 await c.send('Input.insertText',{text:'QA-TABLE-EDIT '});
 check('cell typing immediately invalidates obsolete marks',await e(`return p.session.status==='updating'&&!p.reviewLeaf.view.containerEl.querySelector('.lgd-table-cell-ins');`));await ready();
 check('cell typing compares the full unsaved document at the same commit',await e(`return p.session.currentText.includes('QA-TABLE-EDIT ')&&p.session.currentText.length>${original.text.length}&&p.session.sha===${JSON.stringify(m.qaSha)}&&p.currentEditor().state.doc.length>1000;`));
 check('presentation leaves the native cell focused',await e(`return !!document.activeElement.closest('td .cm-editor');`));await green('table-typed-cell-green');
 await key(2,'z','KeyZ');await ready();
 check('native cell undo removes only the test edit',await e(`return !p.session.currentText.includes('QA-TABLE-EDIT ')&&(${table}).cells[1].querySelector('[contenteditable]').textContent===${JSON.stringify(original.cell)};`));
 await key(2,'y','KeyY');await ready();check('native cell redo restores the edit',await e("return p.session.currentText.includes('QA-TABLE-EDIT ');"));
 await key(2,'z','KeyZ');await ready();
 await e("p.currentEditor().dispatch({selection:{anchor:0}});p.currentEditor().focus();app.workspace.setActiveLeaf(p.reviewLeaf,{focus:true});app.commands.executeCommandById('editor:fold-all');return true;");await wait(250);
 check('folding keeps the comparison ready and pinned',await e(`return p.session.status==='ready'&&p.session.sha===${JSON.stringify(m.qaSha)}&&!(${table});`));
 await e("app.workspace.setActiveLeaf(p.reviewLeaf,{focus:true});p.currentEditor().focus();return true;");await wait(150);
 const unfolded=await e("return app.commands.executeCommandById('editor:unfold-all');");check('native unfold command executes in the participating note',unfolded);await wait(300);await show();await green('table-unfolded-green');
 await c.send('Emulation.setDeviceMetricsOverride',{width:1300,height:900,deviceScaleFactor:1,mobile:false});await wait(200);await show();await green('table-resized-green');
 await e('const v=p.currentEditor();v.dispatch({effects:v.constructor.scrollIntoView(0,{y:"start"})});return true;');await wait(200);await show();await green('table-recycled-green');
 check('the native mapping has no failed table targets',await e(`return p.currentEditor().dom.getAttribute('data-lgd-table-failed')==='0'&&!p.presentationWarning();`));
}finally{
 if(verifiedVault){await e(`p.closeReview();for(const l of app.workspace.getLeavesOfType('markdown'))if(l.view.file?.path===${JSON.stringify(item.file)})l.detach();return true;`).catch(()=>{});fs.writeFileSync(path.join(m.vault,item.file),item.after);}
 await c.send('Emulation.setDeviceMetricsOverride',{width:1800,height:1100,deviceScaleFactor:1,mobile:false}).catch(()=>{});
 fs.writeFileSync(path.join(m.output,'table-interaction-verification.json'),JSON.stringify({date:new Date().toISOString(),results},null,2));c.close();
}
console.log(`${results.length} table interaction assertions passed`);
