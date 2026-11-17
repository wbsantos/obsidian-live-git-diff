import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import type { GitContext } from '../src/git.ts';

interface Ribbon { icon:string; label:string; callback:()=>void; hidden:boolean; attributes:Map<string,string>; addClass():void; setAttr(name:string,value:string):void }
interface QuitTasks { jobs:Array<()=>Promise<void>>; add(job:()=>Promise<void>):void }
interface HostPlugin {
  onload():Promise<void>;
  updateSnapshotRibbon():Promise<void>;
  snapshotCurrentWorkspace():Promise<void>;
  snapshotTimers:Map<string,ReturnType<typeof setTimeout>>;
  disposed:boolean;
}
class TFile { path:string; constructor(path:string) {this.path=path;} }
class MarkdownView {}
class PluginStub {
  ribbon:Ribbon[]=[];
  app:unknown;
  constructor(app:unknown) {this.app=app;}
  register(){} registerView(){} registerEvent(){} registerEditorExtension(){} registerMarkdownPostProcessor(){} addSettingTab(){} addCommand(){}
  addRibbonIcon(icon:string,label:string,callback:()=>void):Ribbon {
    const entry:Ribbon={icon,label,callback,hidden:false,attributes:new Map(),addClass(){},setAttr(name,value){this.attributes.set(name,value);}};
    this.ribbon.push(entry);return entry;
  }
}
const notices:string[]=[];
const require=createRequire(import.meta.url);
const source=buildSync({stdin:{contents:`export {default as Plugin} from './main.ts';
  export {withRepositoryMutation} from './repository.ts';export {resolveRepositoryDirectory} from './repositoryManager.ts';`,
  resolveDir:fileURLToPath(new URL('../src/',import.meta.url))},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',external:['lgd:worker']}).outputFiles[0].text;
const module={exports:{}};
new Function('require','module','exports',source)((id:string)=>id==='obsidian'?{
  Plugin:PluginStub,MarkdownView,TFile,TFolder:class {},Component:class {},ItemView:class {},PluginSettingTab:class {},Setting:class {},
  Notice:class {constructor(message:string){notices.push(message);}hide(){}},
}:require(id),module,module.exports);
const {Plugin,withRepositoryMutation,resolveRepositoryDirectory}=module.exports as {
  Plugin:new(app:unknown)=>HostPlugin&PluginStub;
  withRepositoryMutation<T>(context:GitContext,run:()=>Promise<T>):Promise<T>;
  resolveRepositoryDirectory(app:unknown,path:string):Promise<GitContext>;
};
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

function fixture(backend:'git'|'jj',colocate=true){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'lgd-close-snapshot-')),root=path.join(base,'repo'),vault=path.join(root,'Vault');
  fs.mkdirSync(vault,{recursive:true});
  const run=(tool:string,args:string[])=>execFileSync(tool,args,{cwd:root,encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe']}).trim();
  const git=(...args:string[])=>run('git',['-C',root,...args]);
  // All verification queries explicitly avoid taking their own JJ snapshots.
  const jj=(...args:string[])=>run('jj',['--ignore-working-copy','--no-pager','--color=never','-R',root,...args]);
  const write=(file:string,text:string)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);};
  write('.gitignore','ignored/\nVault/.obsidian/\n');write('Vault/note.md','Original note\n');write('.hidden/types.d.ts','original hidden type\n');write('outside-vault.txt','original external content\n');
  if(backend==='jj'){
    run('jj',['--config','user.name="QA"','--config','user.email="qa@localhost"','git','init',...(colocate?[]:['--no-colocate']),root]);
    run('jj',['-R',root,'util','snapshot']);
  }
  else {git('init','-q');git('config','user.name','QA');git('config','user.email','qa@localhost');git('config','commit.gpgsign','false');git('add','.');git('commit','-qm','Initial');}
  const workspaceEvents=new EventEmitter(),vaultEvents=new EventEmitter();
  const app={workspace:{activeLeaf:null,getActiveFile:()=>null,getLeavesOfType:()=>[],on:workspaceEvents.on.bind(workspaceEvents),onLayoutReady(){}},
    vault:{adapter:{getFullPath:(file:string)=>path.join(vault,file)},on:vaultEvents.on.bind(vaultEvents),getAbstractFileByPath:()=>null}};
  const plugin=new Plugin(app);
  Object.assign(plugin,{loadSettings:async()=>{},scheduleLayout(){},scheduleSnapshotRibbonUpdate(){},repositoryChanged:async()=>{}});
  const tasks=():QuitTasks=>({jobs:[],add(job){this.jobs.push(job);}});
  const clean=()=>{for(const timer of plugin.snapshotTimers.values())clearTimeout(timer);plugin.disposed=true;workspaceEvents.removeAllListeners();vaultEvents.removeAllListeners();assert.equal(path.dirname(base),os.tmpdir());assert.ok(path.basename(base).startsWith('lgd-close-snapshot-'));fs.rmSync(base,{recursive:true,force:true});};
  return {root,vault,app,plugin,jj,git,write,workspaceEvents,tasks,clean};
}

for(const colocate of [true,false])test(`ribbon and awaited quit task snapshot the whole JJ workspace, including non-vault and hidden files (colocated=${colocate})`,async()=>{
  const f=fixture('jj',colocate);
  try{
    await f.plugin.onload();await f.plugin.updateSnapshotRibbon();
    const camera=f.plugin.ribbon.find(item=>item.icon==='camera');
    assert.ok(camera);assert.equal(camera.hidden,false,'works without an active note');
    const change=f.jj('log','-G','-r','@','-T','change_id'),parent=f.jj('log','-G','-r','@-','-T','commit_id');
    f.write('.hidden/types.d.ts','manual hidden type\n');f.write('outside-vault.txt','manual external content\n');f.write('ignored/not-tracked.txt','ignore me\n');
    f.write('.hidden/new.ts','new hidden file\n');f.write('new-outside-vault.txt','new external file\n');
    assert.equal(f.jj('file','show','-r','@','.hidden/types.d.ts'),'original hidden type');
    await f.plugin.snapshotCurrentWorkspace();
    assert.equal(f.jj('file','show','-r','@','.hidden/types.d.ts'),'manual hidden type');
    assert.equal(f.jj('file','show','-r','@','outside-vault.txt'),'manual external content');
    assert.equal(f.jj('file','show','-r','@','.hidden/new.ts'),'new hidden file');
    assert.equal(f.jj('file','show','-r','@','new-outside-vault.txt'),'new external file');
    assert.doesNotMatch(f.jj('file','list','-r','@'),/ignored/);
    assert.equal(f.jj('log','-G','-r','@','-T','change_id'),change);assert.equal(f.jj('log','-G','-r','@-','-T','commit_id'),parent);
    f.write('.hidden/types.d.ts','quit hidden type\n');f.write('outside-vault.txt','quit external content\n');
    const context=await resolveRepositoryDirectory(f.app,'');
    let release!:()=>void,finished=false;
    const held=withRepositoryMutation(context,()=>new Promise<void>(resolve=>{release=resolve;}));await turn();
    f.plugin.snapshotTimers.set(f.root,setTimeout(()=>assert.fail('quit must cancel the idle timer'),15_000));
    const tasks=f.tasks();f.workspaceEvents.emit('quit',tasks);
    assert.equal(tasks.jobs.length,1);assert.equal(f.plugin.snapshotTimers.size,0);
    const duplicate=f.tasks();f.workspaceEvents.emit('quit',duplicate);assert.equal(duplicate.jobs.length,0);
    // A queued quit task must still run after plugin teardown sets disposed.
    f.plugin.disposed=true;
    const capture=tasks.jobs[0]().then(()=>{finished=true;});
    await turn();assert.equal(finished,false,'quit waits for the repository mutation queue');
    release();await held;await capture;
    assert.equal(f.jj('file','show','-r','@','.hidden/types.d.ts'),'quit hidden type');
    assert.equal(f.jj('file','show','-r','@','outside-vault.txt'),'quit external content');
    assert.equal(f.jj('log','-G','-r','@','-T','change_id'),change);assert.equal(f.jj('log','-G','-r','@-','-T','commit_id'),parent);
  }finally{f.clean();}
});

test('Git-only vaults hide the camera and quit leaves HEAD, index and files unchanged',async()=>{
  const f=fixture('git');
  try{
    await f.plugin.onload();await f.plugin.updateSnapshotRibbon();
    assert.equal(f.plugin.ribbon.find(item=>item.icon==='camera')?.hidden,true);
    const head=f.git('rev-parse','HEAD'),index=fs.readFileSync(path.join(f.root,'.git/index'));
    f.write('outside-vault.txt','pending Git content\n');
    await f.plugin.snapshotCurrentWorkspace();
    const tasks=f.tasks();f.workspaceEvents.emit('quit',tasks);await Promise.all(tasks.jobs.map(job=>job()));
    assert.equal(f.git('rev-parse','HEAD'),head);assert.deepEqual(fs.readFileSync(path.join(f.root,'.git/index')),index);
    assert.equal(fs.existsSync(path.join(f.root,'.jj')),false);assert.equal(fs.readFileSync(path.join(f.root,'outside-vault.txt'),'utf8'),'pending Git content\n');
  }finally{f.clean();}
});
