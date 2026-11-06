import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {connect} from './cdp.mjs';
if(!process.argv[2])throw new Error('Provide the isolated QA manifest with independent prose expectations.');
const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),item=m.cases.find(x=>x.prose),spec=item?.prose;
if(!spec)throw new Error('Missing prose expectations.');
const c=await connect(m.port),results=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
const e=code=>c.evaluate(`const p=app.plugins.plugins['live-git-diff'];${code}`);
const check=(name,ok,detail)=>{results.push({name,pass:!!ok,detail});assert.ok(ok,`${name}: ${JSON.stringify(detail)}`);console.log('PASS '+name);};
async function settle(){await wait(140);await e('await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;');}
async function pixels(label,changed,side){
 await e("window.__lgdProseTarget.scrollIntoView({block:'center'});return true;");await settle();
 const points=await e(`const el=window.__lgdProseTarget,r=el.getBoundingClientRect();let t=Math.max(r.top+4,100),b=Math.min(r.bottom-4,innerHeight-45);for(let a=el.parentElement;a;a=a.parentElement){if(/auto|scroll|hidden/.test(getComputedStyle(a).overflowY)){const q=a.getBoundingClientRect();t=Math.max(t,q.top+4);b=Math.min(b,q.bottom-4);}}return [t,(t+b)/2,b].map(y=>({x:r.right-4,y})).filter(pt=>el.contains(document.elementFromPoint(pt.x,pt.y)));`);
 check(label+' visible',points.length>=2,points);
 const on=await c.send('Page.captureScreenshot',{format:'png'});
 await e("document.body.classList.add('lgd-qa-prose-hide');return true;");await settle();const off=await c.send('Page.captureScreenshot',{format:'png'});
 await e("document.body.classList.remove('lgd-qa-prose-hide');return true;");
 const delta=await e(`const decode=async data=>{const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();const cv=document.createElement('canvas');cv.width=img.width;cv.height=img.height;const ctx=cv.getContext('2d');ctx.drawImage(img,0,0);return {ctx,scale:img.width/innerWidth};};const a=await decode(${JSON.stringify(on.data)}),b=await decode(${JSON.stringify(off.data)});return ${JSON.stringify(points)}.map(pt=>{const x=Math.round(pt.x*a.scale),y=Math.round(pt.y*a.scale),aa=a.ctx.getImageData(x,y,1,1).data,bb=b.ctx.getImageData(x,y,1,1).data;return [0,1,2].map(i=>aa[i]-bb[i]);});`);
 const colored=delta.filter(d=>side==='a'?d[0]>d[1]+4&&d[0]>d[2]+4:d[1]>d[0]+4&&d[1]>d[2]+4);
 check(label+' pixels',changed?colored.length>=2:delta.every(d=>d.every(v=>Math.abs(v)<5)),delta);
 if(changed)fs.writeFileSync(path.join(m.output,label.replaceAll('/','-')+'.png'),Buffer.from(on.data,'base64'));
}
try{
 assert.equal(path.resolve(await e('return app.vault.adapter.basePath;')),path.resolve(m.vault));
 await e(`p.closeReview();const f=app.vault.getAbstractFileByPath(${JSON.stringify(item.file)}),leaf=app.workspace.getLeaf('tab');await leaf.openFile(f);await leaf.setViewState({type:'markdown',state:{file:f.path,mode:'source',source:false},active:true});await p.openReview({file:f,ref:${JSON.stringify(m.qaSha)}});p.sync.enabled=false;return true;`);await settle();
 check('reported latest and previous file versions pinned',await e(`return p.session.status==='ready'&&p.session.baseText===${JSON.stringify(item.before)}&&p.session.currentText===${JSON.stringify(item.after)};`));
 const lines=await e(`const v=p.currentEditor(),lines=[];for(let set of v.state.facet(v.constructor.decorations)){if(typeof set==='function')set=set(v);set.between(0,v.state.doc.length,(from,to,d)=>{if(['lgd-editor-ins','lgd-editor-mod'].includes(d.spec.class||d.spec.attributes?.class))lines.push(v.state.doc.lineAt(from).number);});}return [...new Set(lines)].sort((a,b)=>a-b);`);
 check('every independently expected changed source line is decorated',JSON.stringify(lines)===JSON.stringify(spec.liveLines),lines);
 await e(`const style=document.createElement('style');style.id='lgd-qa-prose-hide';style.textContent='body.lgd-qa-prose-hide .lgd-itemwise li.lgd-item-changed.lgd-item-changed,body.lgd-qa-prose-hide .lgd-editor-mod.lgd-editor-mod,body.lgd-qa-prose-hide .lgd-editor-ins.lgd-editor-ins {background:transparent!important;}';document.head.append(style);return true;`);
 for(const line of [21,26]){
  await e(`const v=p.currentEditor();v.dispatch({effects:v.constructor.scrollIntoView(v.state.doc.line(${line}).from,{y:'center'})});return true;`);await settle();
  await e(`const v=p.currentEditor(),n=v.domAtPos(v.state.doc.line(${line}).from).node;window.__lgdProseTarget=(n.nodeType===1?n:n.parentElement).closest('.cm-line');return true;`);
  await pixels('prose-live-line-'+line,spec.liveLines.includes(line),'b');
 }
 await e(`await p.reviewLeaf.setViewState({type:'markdown',state:{file:p.session.filePath,mode:'preview'},active:true});return true;`);await settle();
 for(const side of ['a','b']){
  await e(`const row=p.session.rows.find(r=>r.${side}?.lineStart===${side==='a'?spec.listLineA:spec.listLineB});${side==='a'?'p.baseView().blockEls.get(row.idx).scrollIntoView({block:"start"});':'p.notePane().view.previewMode.applyScroll(row.b.lineStart);'}return true;`);await settle();
  const count=await e(`const row=p.session.rows.find(r=>r.${side}?.lineStart===${side==='a'?spec.listLineA:spec.listLineB});window.__lgdProseRoot=${side==='a'?'p.baseView().blockEls.get(row.idx)':"p.notePane().view.containerEl.querySelector('[data-row-index=\"'+row.idx+'\"]')"};return window.__lgdProseRoot.querySelectorAll('ul>li').length;`);
  const expected=side==='a'?spec.changedItemsA:spec.changedItemsB;
  const marked=await e("return [...window.__lgdProseRoot.querySelectorAll('ul>li')].map((li,i)=>li.classList.contains('lgd-item-changed')?i+1:0).filter(Boolean);");
  check('prose '+side+' exact changed items',JSON.stringify(marked)===JSON.stringify(expected),marked);
  for(let i=1;i<=count;i++){await e(`window.__lgdProseTarget=window.__lgdProseRoot.querySelectorAll('ul>li')[${i-1}];return true;`);await pixels('prose-'+side+'-item-'+i,expected.includes(i),side);}
  check('prose '+side+' inline code has word marks',await e('return !!window.__lgdProseRoot.querySelector("code [data-lgd-char]");'));
 }
}finally{
 await e("document.body.classList.remove('lgd-qa-prose-hide');document.getElementById('lgd-qa-prose-hide')?.remove();delete window.__lgdProseRoot;delete window.__lgdProseTarget;return true;").catch(()=>{});
 fs.writeFileSync(path.join(m.output,'prose-visual-verification.json'),JSON.stringify({date:new Date().toISOString(),results},null,2));c.close();
}
console.log(`${results.length} prose visual assertions passed`);
