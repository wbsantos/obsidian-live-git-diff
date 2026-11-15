import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { App,TFile } from 'obsidian';
import { resolveRepository, repositoryHead, repositoryLog, evolution, snapshotWorkspace, SNAPSHOT_DELAY } from '../src/repository.ts';

for(const colocate of [true,false]) test(`JJ snapshots retain change identity and filter unrelated saves (colocated=${colocate})`, async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lgd-jj-'));
  const jj=(...args:string[])=>execFileSync('jj',['--no-pager','--color=never','--config','user.name="QA"','--config','user.email="qa@localhost"','-R',dir,...args],{encoding:'utf8',windowsHide:true}).trim();
  try {
    execFileSync('jj',['git','init',...(colocate ? [] : ['--no-colocate']),dir],{windowsHide:true});
    fs.writeFileSync(path.join(dir,'note.md'),'one\n');jj('util','snapshot');
    fs.writeFileSync(path.join(dir,'note.md'),'two\n');jj('util','snapshot');
    fs.writeFileSync(path.join(dir,'other.md'),'unrelated');jj('util','snapshot');
    fs.writeFileSync(path.join(dir,'note.md'),'three\n');jj('util','snapshot');
    const app={vault:{adapter:{getFullPath:(p:string)=>path.join(dir,p)}}} as unknown as App;
    const ctx=await resolveRepository(app,{path:'note.md'} as TFile);
    assert.equal(ctx.backend,'jj');assert.equal(SNAPSHOT_DELAY,15000);
    const head=await repositoryHead(ctx), log=await repositoryLog(ctx,head,30);
    assert.equal(log[0].kind,'workcopy');assert.equal(log[0].currentSha,head);
    const evo=await evolution(ctx,log[0],30);
    assert.ok(evo.commits.length>=3);
    assert.equal(evo.commits.filter(c=>!c.absent).length,3);
    const change=log[0].changeId;
    fs.writeFileSync(path.join(dir,'note.md'),'four\n');await snapshotWorkspace(ctx);
    const next=await repositoryLog(ctx,await repositoryHead(ctx),30);
    assert.equal(next[0].changeId,change);assert.notEqual(next[0].currentSha,head);
    assert.equal(fs.readFileSync(path.join(dir,'note.md'),'utf8'),'four\n');
    fs.renameSync(path.join(dir,'note.md'),path.join(dir,'renamed.md'));await snapshotWorkspace(ctx);
    const renamed=await resolveRepository(app,{path:'renamed.md'} as TFile);
    const renamedLog=await repositoryLog(renamed,await repositoryHead(renamed),30);
    const renamedEvolution=await evolution(renamed,renamedLog[0],30);
    assert.ok(renamedEvolution.commits.some(c=>c.path==='note.md'&&!c.absent));
  } finally { assert.ok(path.basename(dir).startsWith('lgd-jj-'));fs.rmSync(dir,{recursive:true,force:true}); }
});
