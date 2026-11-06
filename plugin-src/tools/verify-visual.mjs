import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { connect } from './cdp.mjs';
// Expectations are authored independently in a local manifest, never inferred from the diff.
if (!process.argv[2]) throw new Error('Provide the local visual-cases manifest.');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const output=manifest.output;fs.mkdirSync(output,{recursive:true});
const c=await connect(manifest.port),results=[];let originalTheme=null;
const evaluate=code=>c.evaluate(`const p=app.plugins.plugins['live-git-diff'];${code}`);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,ok,detail)=>{results.push({name,pass:!!ok,detail});assert.ok(ok,`${name}: ${JSON.stringify(detail)}`);};
const normalized=value=>value.replace(/\s+/g,' ').trim();
async function settle(){await wait(160);await evaluate('await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;');}
async function ready(){for(let i=0;i<150;i++){if(await evaluate("return p.session?.status==='ready'&&p.baseView()?.blockEls.size===p.session.baseRows.length;")){await settle();return;}await wait(80);}throw new Error('Comparison failed to become ready');}
async function screenshot(){return (await c.send('Page.captureScreenshot',{format:'png'})).data;}
async function paintDiff(on,off,points){return evaluate(`
  const decode=async data=>{const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();const cv=document.createElement('canvas');cv.width=img.width;cv.height=img.height;const x=cv.getContext('2d');x.drawImage(img,0,0);return x;};
  const a=await decode(${JSON.stringify(on)}),b=await decode(${JSON.stringify(off)});
  return ${JSON.stringify(points)}.map(pt=>{const x=Math.round(pt.x),y=Math.round(pt.y);const aa=Array.from(a.getImageData(x,y,1,1).data).slice(0,3),bb=Array.from(b.getImageData(x,y,1,1).data).slice(0,3);return {on:aa,off:bb,delta:aa.map((v,i)=>v-bb[i])};});
`);}
async function tableInfo(anchor,side,mode){
  return evaluate(`const row=p.session.rows.find(r=>(r.${side}?.cells||[]).some(c=>c[0]?.text===${JSON.stringify(anchor)}));
    if(!row)throw new Error('Expected source table missing');
    const table=${side==='a'?"p.baseView().blockEls.get(row.idx)?.querySelector('table')":"[...p.notePane().scroller.querySelectorAll('table')].find(t=>[...t.rows].some(tr=>tr.cells[0]?.textContent.replace(/\\s+/g,' ').trim()=== "+JSON.stringify(anchor)+"))"};
    if(!table)return null;
    window.__lgdQaTable=table;
    return {index:row.idx,rows:[...table.rows].map(tr=>({label:tr.cells[0]?.textContent.replace(/\\s+/g,' ').trim(),painted:[...tr.cells].some(td=>td.classList.contains('lgd-table-cell-${side==='a'?'del':'ins'}')),columns:tr.cells.length})),engine:(row.tableRows||[]).filter(r=>r.kind!=='same'&&r.row${side.toUpperCase()}>=0).map(r=>row.${side}.cells[r.row${side.toUpperCase()}][0].text),text:table.textContent};
  `);
}
async function showTable(anchor,side,mode){
  await evaluate(`const row=p.session.rows.find(r=>(r.${side}?.cells||[]).some(c=>c[0]?.text===${JSON.stringify(anchor)}));if(!row)throw new Error('Missing table');
    ${side==='a'?"p.baseView().blockEls.get(row.idx).scrollIntoView({block:'start'});":mode==='live'?"const v=p.currentEditor();v.dispatch({effects:v.constructor.scrollIntoView(v.state.doc.line(row.b.lineStart+1).from,{y:'start'})});":"p.notePane().view.previewMode.applyScroll(row.b.lineStart);"}return true;`);
  for(let i=0;i<60;i++){await settle();const info=await tableInfo(anchor,side,mode);if(info)return info;}
  throw new Error(`Table not rendered: ${anchor}, ${side}, ${mode}`);
}
async function verifyCell(rowIndex,column,changed,side,label,artifact){
  await evaluate(`const cell=window.__lgdQaTable.rows[${rowIndex}].cells[${column}];cell.scrollIntoView({block:'center',inline:'center'});return true;`);await settle();
  const info=await evaluate(`const cell=window.__lgdQaTable.rows[${rowIndex}].cells[${column}],r=cell.getBoundingClientRect();
    let l=Math.max(0,r.left+4),t=Math.max(0,r.top+4),right=Math.min(innerWidth,r.right-4),bottom=Math.min(innerHeight-35,r.bottom-4);
    for(let a=cell.parentElement;a;a=a.parentElement){const s=getComputedStyle(a),b=a.getBoundingClientRect();if(/auto|scroll|hidden/.test(s.overflowX)){l=Math.max(l,b.left+2);right=Math.min(right,b.right-2);}if(/auto|scroll|hidden/.test(s.overflowY)){t=Math.max(t,b.top+2);bottom=Math.min(bottom,b.bottom-2);}}
    const points=[];if(right>l&&bottom>t)for(const x of [l,(l+right)/2,right])for(const y of [t,bottom])if(cell.contains(document.elementFromPoint(x,y)))points.push({x,y});
    return {points,rect:[r.width,r.height],bg:getComputedStyle(cell).backgroundImage,classes:cell.className,text:cell.textContent};`);
  check(`${label}: visible cell ${column}`,info.points.length>=3,info);
  const on=await screenshot();
  await evaluate("document.body.classList.add('lgd-qa-hide');return true;");await settle();const off=await screenshot();
  const geometry=await evaluate(`const r=window.__lgdQaTable.rows[${rowIndex}].cells[${column}].getBoundingClientRect();document.body.classList.remove('lgd-qa-hide');return [r.width,r.height];`);await settle();
  check(`${label}: presentation preserves geometry ${column}`,JSON.stringify(geometry)===JSON.stringify(info.rect));
  const pixels=await paintDiff(on,off,info.points);
  const visible=pixels.filter(q=>Math.max(...q.delta.map(Math.abs))>=5);
  const rightHue=visible.filter(q=>side==='b'?q.delta[1]>q.delta[0]+3&&q.delta[1]>q.delta[2]+3:q.delta[0]>q.delta[1]+3&&q.delta[0]>q.delta[2]+3);
  check(`${label}: ${changed?'painted':'unchanged'} pixels in cell ${column}`,changed?visible.length>=3&&rightHue.length>=3:visible.length===0,{pixels,classes:info.classes,bg:info.bg});
  if(artifact&&column===0)fs.writeFileSync(path.join(output,artifact+'.png'),Buffer.from(on,'base64'));
}
try{
  const actual=await evaluate('return app.vault.adapter.basePath;');assert.equal(path.resolve(actual),path.resolve(manifest.vault),'Refuse to modify a non-QA vault');
  await c.send('Emulation.setDeviceMetricsOverride',{width:1800,height:1100,deviceScaleFactor:1,mobile:false});
  originalTheme=await evaluate('return {dark:document.body.classList.contains("theme-dark"),light:document.body.classList.contains("theme-light")};');
  if(manifest.theme)await evaluate(`document.body.classList.toggle('theme-dark',${manifest.theme==='dark'});document.body.classList.toggle('theme-light',${manifest.theme==='light'});return true;`);
  await evaluate(`require('@electron/remote').getCurrentWindow().webContents.setBackgroundThrottling(false);app.workspace.leftSplit.collapse();app.workspace.rightSplit.collapse();
    const s=document.createElement('style');s.id='lgd-qa-hide-style';s.textContent='body.lgd-qa-hide .lgd-table-cell-ins.lgd-table-cell-ins,body.lgd-qa-hide .lgd-table-cell-del.lgd-table-cell-del,.lgd-qa-hide .lgd-table-cell-detail .table-cell-wrapper {background-image:none!important;} .lgd-qa-hide tr.lgd-rowchanged{background-color:transparent!important;} .lgd-qa-hide [data-lgd-char]{background:transparent!important;} .lgd-qa-hide .lgd-editor-ins,.lgd-qa-hide .lgd-editor-mod{background-image:none!important;background-color:transparent!important;}';document.head.append(s);return true;`);
  for(const item of manifest.cases){
    await evaluate(`p.closeReview();const file=app.vault.getAbstractFileByPath(${JSON.stringify(item.file)});let leaf=app.workspace.getLeavesOfType('markdown')[0]||app.workspace.getLeaf('tab');await leaf.openFile(file);await leaf.setViewState({type:'markdown',state:{file:file.path,mode:'source',source:false},active:true});await p.openReview({file,ref:${JSON.stringify(manifest.qaSha)}});p.sync.enabled=false;return true;`);await ready();
    check(`${item.file}: pinned correct before and current texts`,await evaluate(`return p.session.baseText===${JSON.stringify(item.before)}&&p.session.currentText===${JSON.stringify(item.after)};`));
    for(const mode of ['live','reading']){
      if(mode==='reading'){await evaluate("const leaf=p.reviewLeaf;await leaf.setViewState({type:'markdown',state:{file:p.session.filePath,mode:'preview'},active:true});return true;");await settle();}
      for(const expected of item.tables)for(const side of ['a','b']){
        const info=await showTable(expected.anchor,side,mode);const want=expected.changed[side].map(normalized);
        check(`${item.file}/${mode}/${side}/${expected.anchor}: engine rows`,JSON.stringify(info.engine.map(normalized))===JSON.stringify(want),{engine:info.engine,want});
        const painted=info.rows.filter(row=>row.painted).map(row=>row.label);
        check(`${item.file}/${mode}/${side}/${expected.anchor}: DOM rows`,JSON.stringify(painted)===JSON.stringify(want),{painted,want});
        for(let i=0;i<info.rows.length;i++){
          const row=info.rows[i],changed=want.includes(row.label);
          // Every changed cell, plus a first-cell negative control on every unchanged row.
          for(let col=0;col<(changed?row.columns:1);col++)await verifyCell(i,col,changed,side,`${item.file}/${mode}/${side}/${row.label}`,changed?`${item.file}-${mode}-${side}-${i}`:null);
        }
        const after=await evaluate('return window.__lgdQaTable.textContent;');check(`${item.file}/${mode}/${side}: text preserved`,after===info.text);
        console.log(`PASS ${item.file} ${mode} ${side} ${expected.anchor}`);
      }
    }
  }
}finally{
  await evaluate("document.body.classList.remove('lgd-qa-hide');document.getElementById('lgd-qa-hide-style')?.remove();delete window.__lgdQaTable;return true;").catch(()=>{});
  if(originalTheme)await evaluate(`document.body.classList.toggle('theme-dark',${originalTheme.dark});document.body.classList.toggle('theme-light',${originalTheme.light});return true;`).catch(()=>{});
  fs.writeFileSync(path.join(output,'visual-coverage.json'),JSON.stringify({generatedAt:new Date().toISOString(),sources:manifest.cases.map(({file,sha,head,fileHead,beforeHash,afterHash})=>({file,sha,head,fileHead,beforeHash,afterHash})),results},null,2));c.close();
}
console.log(`${results.length} visual assertions passed`);
