import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {connect} from './cdp.mjs';
if(!process.argv[2])throw new Error('Provide a local isolated QA manifest.');
const manifest=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const c=await connect(manifest.port);
try{
  assert.equal(path.resolve(await c.evaluate('return app.vault.adapter.basePath;')),path.resolve(manifest.vault));
  await c.evaluate("await app.plugins.disablePlugin('live-git-diff');return true;");
  for(const name of ['main.js','styles.css','manifest.json'])fs.copyFileSync(path.resolve('../plugin-dist',name),path.join(manifest.vault,'.obsidian/plugins/live-git-diff',name));
  console.log(await c.evaluate("await app.plugins.loadManifests();await app.plugins.enablePlugin('live-git-diff');return {version:app.plugins.plugins['live-git-diff']?.manifest.version};"));
}finally{c.close();}
