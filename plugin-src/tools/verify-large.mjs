import fs from 'node:fs';
import assert from 'node:assert/strict';
import { connect } from './cdp.mjs';
const c = await connect();
try {
  const result = await c.evaluate(`
    const p=app.plugins.plugins['live-git-diff']; const previous=p.session.sha;
    const leaf=app.workspace.getLeavesOfType('markdown')[0];await leaf.openFile(app.vault.getAbstractFileByPath('large.md'));
    let ticks=0,maxGap=0,last=performance.now(); const interval=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++;},16);
    const start=performance.now();
    await p.openReview();
    clearInterval(interval);
    const result={status:p.session.status,error:p.session.error,chars:p.session.currentText.length,blocks:p.session.counts.blocks,rendered:p.baseView().blockEls.size,elapsedMs:Math.round(performance.now()-start),heartbeatTicks:ticks,maxHeartbeatGapMs:Math.round(maxGap)};
    await leaf.openFile(app.vault.getAbstractFileByPath('review.md'));await p.openReview({ref:previous,label:'QA original'});
    return result;
  `);
  assert.equal(result.status, 'ready'); assert.equal(result.rendered, result.blocks); assert.ok(result.heartbeatTicks > 2);
  fs.writeFileSync('../app-qa/large-ui-verification.json', JSON.stringify({ date: new Date().toISOString(), ...result }, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { c.close(); }
