/** Snapshot QA in an isolated native Obsidian profile; never closes a user's vault. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {connect} from './cdp.mjs';

const latest = path.resolve('../.npm-cache/snapshot-qa-latest.json');
const run = (root, ...args) => execFileSync('jj', ['--no-pager', '--color=never', '-R', root, ...args], {cwd:root,encoding:'utf8',windowsHide:true}).trim();
if (process.argv[2] === 'prepare') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lgd-snapshot-app-'));
  const root = path.join(base, 'repo'), vault = path.join(root, 'Vault'), profile = path.join(base, 'profile');
  fs.mkdirSync(path.join(vault, '.obsidian/plugins/live-git-diff'), {recursive:true});
  fs.mkdirSync(path.join(root, '.hidden'), {recursive:true});
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(root, '.gitignore'), 'Vault/.obsidian/\nignored/\n');
  fs.writeFileSync(path.join(root, '.hidden/types.d.ts'), 'original hidden\n');
  fs.writeFileSync(path.join(root, 'outside-vault.txt'), 'original external\n');
  fs.writeFileSync(path.join(vault, 'Note.md'), '# Snapshot QA\n');
  execFileSync('jj', ['git', 'init', root], {windowsHide:true});
  run(root, 'config', 'set', '--repo', 'user.name', 'Snapshot QA');
  run(root, 'config', 'set', '--repo', 'user.email', 'qa@example.test');
  run(root, 'util', 'snapshot');
  for (const name of ['main.js','manifest.json','styles.css']) fs.copyFileSync(path.resolve('../plugin-dist',name),path.join(vault,'.obsidian/plugins/live-git-diff',name));
  fs.writeFileSync(path.join(vault,'.obsidian/community-plugins.json'),JSON.stringify(['live-git-diff']));
  fs.writeFileSync(path.join(vault,'.obsidian/app.json'),JSON.stringify({legacyEditor:false,livePreview:true}));
  fs.writeFileSync(path.join(profile,'obsidian.json'),JSON.stringify({vaults:{'snapshot-review-qa':{path:vault,ts:Date.now(),open:true}},updateDisabled:true}));
  const manifest = {base,root,vault,profile,port:9240};
  fs.mkdirSync(path.dirname(latest),{recursive:true});fs.writeFileSync(latest,JSON.stringify(manifest,null,2));
  console.log(JSON.stringify(manifest));
} else {
  const config = JSON.parse(fs.readFileSync(process.argv[2] || latest,'utf8'));
  assert.equal(path.dirname(config.base), os.tmpdir());
  assert.ok(path.basename(config.base).startsWith('lgd-snapshot-app-'));
  assert.equal(config.vault,path.join(config.base,'repo','Vault'));
  const jj = (...args) => run(config.root,'--ignore-working-copy',...args);
  const show = file => jj('file','show','-r','@',file);
  const change = jj('log','-G','-r','@','-T','change_id'), parent = jj('log','-G','-r','@-','-T','commit_id');
  const cdp = await connect(config.port);
  const pause = () => new Promise(resolve=>setTimeout(resolve,150));
  try {
    assert.equal(await cdp.evaluate('return app.vault.adapter.getBasePath();'),config.vault,'must be the isolated QA vault');
    await cdp.evaluate(`const trust=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Trust author and enable plugins'));trust?.click();`);
    let camera;
    for(let i=0;i<100;i++) {
      camera=await cdp.evaluate(`const button=document.querySelector('.lgd-snapshot-action');return {loaded:!!app.plugins.plugins['live-git-diff'],visible:!!button&&!button.hidden&&getComputedStyle(button).display!=='none',cursor:button&&getComputedStyle(button).cursor};`);
      if(camera.loaded&&camera.visible) break;
      await pause();
    }
    assert.equal(camera?.visible,true);assert.equal(camera.cursor,'pointer');
    assert.equal(await cdp.evaluate('return app.workspace.getActiveFile()?.path || null;'),null,'no note needs to be open');
    fs.writeFileSync(path.join(config.root,'.hidden/types.d.ts'),'manual hidden\n');
    fs.writeFileSync(path.join(config.root,'outside-vault.txt'),'manual external\n');
    fs.writeFileSync(path.join(config.root,'.hidden/new.ts'),'new hidden file\n');
    fs.mkdirSync(path.join(config.root,'ignored'),{recursive:true});fs.writeFileSync(path.join(config.root,'ignored/secret.txt'),'ignored\n');
    assert.equal(show('.hidden/types.d.ts'),'original hidden');
    await cdp.evaluate(`document.querySelector('.lgd-snapshot-action').click();return true;`);
    for(let i=0;i<100;i++) {
      if(await cdp.evaluate(`return document.querySelector('.lgd-snapshot-action').getAttribute('aria-busy')==='false';`)) break;
      await pause();
    }
    assert.equal(show('.hidden/types.d.ts'),'manual hidden');assert.equal(show('outside-vault.txt'),'manual external');
    assert.equal(show('.hidden/new.ts'),'new hidden file');assert.doesNotMatch(jj('file','list','-r','@'),/ignored/);
    console.log('PASS native camera: entire workspace, hidden/new/non-vault files, no note open, ignore rules');
    fs.writeFileSync(path.join(config.root,'.hidden/types.d.ts'),'quit hidden\n');
    fs.writeFileSync(path.join(config.root,'outside-vault.txt'),'quit external\n');
    fs.writeFileSync(path.join(config.root,'.hidden/on-close.ts'),'new on close\n');
    assert.equal(show('.hidden/types.d.ts'),'manual hidden','read probes must not snapshot');
    await cdp.evaluate(`setTimeout(()=>window.close(),0);return true;`);
    for(let i=0;i<100;i++) {
      await pause();
      try {
        const pages=await (await fetch('http://127.0.0.1:'+config.port+'/json/list')).json();
        if(!pages.some(page=>page.id===cdp.target.id)) break;
      } catch { break; }
    }
    assert.equal(show('.hidden/types.d.ts'),'quit hidden');assert.equal(show('outside-vault.txt'),'quit external');
    assert.equal(show('.hidden/on-close.ts'),'new on close');
    assert.equal(jj('log','-G','-r','@','-T','change_id'),change);assert.equal(jj('log','-G','-r','@-','-T','commit_id'),parent);
    console.log('PASS normal native close: awaited snapshot, new hidden and external content, same change and parent');
  } finally { cdp.close(); }
}
