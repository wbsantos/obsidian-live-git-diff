import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {connect} from './cdp.mjs';
if(!process.argv[2])throw new Error('Provide the isolated QA manifest. The QA vault must contain large.md at its baseline commit.');
const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),c=await connect(m.port);
try{
 assert.equal(path.resolve(await c.evaluate('return app.vault.adapter.basePath;')),path.resolve(m.vault));
 const result=await c.evaluate(`
 const p=app.plugins.plugins['live-git-diff'];p.closeReview();
 const file=app.vault.getAbstractFileByPath('large.md');if(!file)throw new Error('Missing large.md fixture');
 const leaf=app.workspace.getLeaf('tab');await leaf.openFile(file);
 await leaf.setViewState({type:'markdown',state:{file:file.path,mode:'source',source:false},active:true});
 let ticks=0,maxGap=0,last=performance.now();const interval=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++;},16);
 const start=performance.now();try{
 await p.openReview({file,ref:${JSON.stringify(m.qaSha)}});
 return {status:p.session.status,error:p.session.error,chars:p.session.currentText.length,blocks:p.session.baseRows.length,rendered:p.baseView().blockEls.size,elapsedMs:Math.round(performance.now()-start),heartbeatTicks:ticks,maxHeartbeatGapMs:Math.round(maxGap)};
 }finally{clearInterval(interval);p.closeReview();leaf.detach();}
 `);
 assert.equal(result.status,'ready');assert.equal(result.rendered,result.blocks);assert.ok(result.heartbeatTicks>2);assert.ok(result.chars>=880000);
 fs.writeFileSync(path.join(m.output,'large-ui-verification.json'),JSON.stringify({date:new Date().toISOString(),...result},null,2));console.log(JSON.stringify(result,null,2));
}finally{c.close();}
