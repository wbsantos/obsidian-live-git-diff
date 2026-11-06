import fs from 'node:fs';
import assert from 'node:assert/strict';
import { connect } from './cdp.mjs';
const c=await connect(),measurements=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function measure(label){
  await wait(150);
  measurements.push(await c.evaluate(`const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path==='reported.md'),root=leaf.view.containerEl;
    const metrics=selector=>{const el=root.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {width:r.width,left:r.left,paddingLeft:s.paddingLeft,paddingRight:s.paddingRight,display:s.display};};
    return {label:${JSON.stringify(label)},viewport:innerWidth,pane:metrics('.cm-editor'),scroller:metrics('.cm-scroller'),content:metrics('.cm-content'),sizer:metrics('.cm-sizer'),gutters:metrics('.cm-gutters'),pluginGutter:metrics('.lgd-gutter'),line:metrics('.cm-line')};`));
}
try {
  await c.evaluate(`const p=app.plugins.plugins['live-git-diff'];if(p.session)window.__widthPin={file:p.session.filePath,sha:p.session.sha,label:p.session.baseRefLabel};p.closeReview();const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path==='reported.md');await leaf.setViewState({type:'markdown',state:{file:'reported.md',mode:'source',source:false},active:true});return true;`);
  for(const width of [900,1200,1600]){
    await c.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await measure('enabled-idle');
    await c.evaluate(`await app.plugins.disablePlugin('live-git-diff');return true;`);
    await measure('disabled');
    await c.evaluate(`await app.plugins.enablePlugin('live-git-diff');return true;`);
  }
  const pin=await c.evaluate('return window.__widthPin;');
  await c.evaluate(`const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path==='reported.md');app.workspace.setActiveLeaf(leaf,{focus:true});await app.plugins.plugins['live-git-diff'].openReview({file:leaf.view.file,ref:${JSON.stringify(pin.sha)},label:${JSON.stringify(pin.label)}});return true;`);
  await measure('enabled-review');
  if(process.argv[2]==='after'){
    for(const width of [900,1200,1600]){
      const active=measurements.find(m=>m.viewport===width&&m.label==='enabled-idle'),off=measurements.find(m=>m.viewport===width&&m.label==='disabled');
      assert.deepEqual(active.content,off.content,`idle editor geometry at ${width}px`);
      assert.equal(active.pluginGutter,null,'idle editor has no review gutter');
    }
    assert.ok(measurements.at(-1).pluginGutter,'review still shows the public gutter');
  }
  fs.writeFileSync(`../app-qa/editor-width-${process.argv[2]||'before'}.json`,JSON.stringify(measurements,null,2));
  console.log(JSON.stringify(measurements,null,2));
}finally{c.close();}
