import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileLogAsync, readBaseAtAsync, resolveRefAsync, commitInfoForAsync, resolveGitAsync } from '../src/git.ts';
import type { App, TFile } from 'obsidian';
test('async Git preserves accented literal paths, authors and renamed file history at pinned heads',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lgd-async-'));
  const git=(...args:string[])=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',windowsHide:true}).trim();
  try{
    git('init','-q');git('config','user.name','Test Author');git('config','user.email','test@localhost');
    const old='original [á].md',name='renamed [á].md';fs.writeFileSync(path.join(dir,old),'old\n');git('add','--',old);git('commit','-qm','Initial');const a=git('rev-parse','HEAD');
    git('mv','--',old,name);git('commit','-qm','Rename');const b=git('rev-parse','HEAD');
    fs.writeFileSync(path.join(dir,name),'new\n');git('add','--',name);git('commit','-qm','Update');const h=git('rev-parse','HEAD');
    const log=await fileLogAsync(dir,name,50);assert.deepEqual(log.map(c=>c.sha),[h,b,a]);
    assert.deepEqual(log.map(c=>c.path),[name,name,old]);assert.ok(log.every(c=>c.author==='Test Author'));
    const earlier=await fileLogAsync(dir,name,50,{head:b});assert.deepEqual(earlier.map(c=>c.sha),[b,a]);
    assert.equal((await readBaseAtAsync(dir,name,a,undefined,log[2].path)).text,'old\n');
    assert.equal((await readBaseAtAsync(dir,name,a)).renamedFrom,old);
    assert.equal(await resolveRefAsync(dir,'HEAD'),h);assert.equal((await commitInfoForAsync(dir,h)).subject,'Update');
    await assert.rejects(resolveRefAsync(dir,'--help'),/Cannot resolve/);
    const app={vault:{adapter:{getFullPath:(file:string)=>path.join(dir,file)}}} as unknown as App;
    const context=await resolveGitAsync(app,{path:name} as TFile);assert.equal(context.rel,name);
    const abort=new AbortController();abort.abort();await assert.rejects(fileLogAsync(dir,name,2,{signal:abort.signal}));
  }finally{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(dir).startsWith('lgd-async-'));fs.rmSync(dir,{recursive:true,force:true});}
});
