import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryCache, HistoryController, historyStatus } from '../src/history.ts';
import type { CommitInfo } from '../src/git.ts';
const commit=(sha:string):CommitInfo=>({sha,shortSha:sha,subject:sha,relative:'today',date:'Today',path:'file.md',author:'Test'});
const turn=()=>new Promise<void>(r=>setImmediate(r));
function setup(){
  const jobs:Array<{root:string;head:string;limit:number;resolve:(v:CommitInfo[])=>void;reject:(e:Error)=>void}>=[];
  let head='head1',clock=1000,headCalls=0,events=0;
  const comparisons:Array<{path:string;shas:string[]}>=[];
  const cache=new HistoryCache({head:async()=>{headCalls++;return head;},log:async(ctx,h,n)=>new Promise((resolve,reject)=>jobs.push({root:ctx.root,head:h,limit:n,resolve,reject}))},()=>++clock);
  const panel=new HistoryController(cache,async f=>({root:'/repo/'+f.path,rel:'file.md',abs:'/repo/'+f.path+'/file.md'}),()=>2,()=>{events++;},(path,selected)=>comparisons.push({path,shas:selected.map(c=>c.sha)}));
  return {cache,panel,jobs,comparisons,setHead:(v:string)=>{head=v;},get headCalls(){return headCalls;},get events(){return events;}};
}
test('old-file completion updates its cache but cannot repaint current list, selection or footer',async()=>{
  const s=setup(),a=s.panel.setFile({path:'A',name:'A'});await turn();const b=s.panel.setFile({path:'B',name:'B'});await turn();
  s.jobs[1].resolve([commit('b1')]);await b;s.panel.select('b1',false);const state=s.panel.state,events=s.events;
  s.jobs[0].resolve([commit('a1')]);await a;
  assert.equal(s.panel.state,state);assert.equal(s.events,events);assert.equal(s.cache.forFile('A')?.commits[0].sha,'a1');
  assert.match(historyStatus(s.panel.state),/^Last synced at /);assert.equal(s.panel.state.selected[0].sha,'b1');
});
test('A to B to A rejects first-visit results and keeps newer cache after out-of-order completion',async()=>{
  const s=setup(),a1=s.panel.setFile({path:'A',name:'A'});await turn();const b=s.panel.setFile({path:'B',name:'B'});await turn();const a2=s.panel.setFile({path:'A',name:'A'});await turn();
  s.jobs[2].resolve([commit('a-new')]);await a2;const state=s.panel.state;
  s.jobs[0].resolve([commit('a-old')]);await a1;s.jobs[1].resolve([commit('b')]);await b;
  assert.equal(s.panel.state,state);assert.equal(s.cache.forFile('A')?.commits[0].sha,'a-new');assert.equal(s.cache.forFile('B')?.commits[0].sha,'b');
});
test('return to file shows cache immediately and starts a new refresh',async()=>{
  const s=setup();const a=s.panel.setFile({path:'A',name:'A'});await turn();s.jobs[0].resolve([commit('old')]);await a;
  await s.panel.setFile(null);const again=s.panel.setFile({path:'A',name:'A'});
  assert.equal(s.panel.state.entry?.commits[0].sha,'old');assert.equal(s.panel.state.loading,true);
  await turn();s.jobs[1].resolve([commit('new')]);await again;assert.equal(s.panel.state.entry?.commits[0].sha,'new');
});
test('failure retains cache and last successful timestamp, including footer during refresh',async()=>{
  const s=setup(),a=s.panel.setFile({path:'A',name:'A'});await turn();s.jobs[0].resolve([commit('a')]);await a;
  const stamp=s.panel.state.entry!.lastSyncedAt,refresh=s.panel.refresh();await turn();assert.match(historyStatus(s.panel.state),/^Loading Git history… · Last synced at /);
  s.jobs[1].reject(new Error('Git failed'));await refresh;assert.equal(s.panel.state.entry!.lastSyncedAt,stamp);
  assert.match(historyStatus(s.panel.state),/^Unable to refresh Git history · Last synced at /);
});
test('load more remains on pinned HEAD; refresh and selection do not repin a comparison',async()=>{
  const s=setup(),a=s.panel.setFile({path:'A',name:'A'});await turn();s.jobs[0].resolve(['3','2','1'].map(commit));await a;
  s.panel.select('2',false);s.setHead('head2');const more=s.panel.refresh(true);await turn();
  assert.equal(s.jobs[1].head,'head1');assert.equal(s.headCalls,1);assert.equal(s.jobs[1].limit,5);
  s.jobs[1].resolve(['3','2','1'].map(commit));await more;const refresh=s.panel.refresh();await turn();assert.equal(s.jobs[2].head,'head2');
  s.jobs[2].resolve(['4','3','2','1'].map(commit));await refresh;
  assert.deepEqual(s.comparisons,[{path:'A',shas:['2']}]);assert.equal(s.panel.state.selected[0].sha,'2');
});
test('selection supports one, two older-first, rejection of third, and deselect to zero',async()=>{
  const s=setup(),a=s.panel.setFile({path:'A',name:'A'});await turn();s.jobs[0].resolve(['3','2','1'].map(commit));await a;
  const more=s.panel.refresh(true);await turn();s.jobs[1].resolve(['3','2','1'].map(commit));await more;
  s.panel.select('3',false);s.panel.select('2',true);assert.deepEqual(s.comparisons.at(-1)?.shas,['2','3']);
  const count=s.comparisons.length;s.panel.select('1',true);assert.equal(s.comparisons.length,count);assert.match(s.panel.state.hint!,/up to two/);
  s.panel.select('3',true);assert.deepEqual(s.comparisons.at(-1)?.shas,['2']);s.panel.select('2',true);assert.deepEqual(s.comparisons.at(-1)?.shas,[]);
});
test('closed panel cannot receive responses but outstanding read can finish the original cache',async()=>{
  const s=setup(),a=s.panel.setFile({path:'A',name:'A'});await turn();const events=s.events;s.panel.dispose();s.jobs[0].resolve([commit('a')]);await a;
  assert.equal(s.events,events);assert.equal(s.cache.forFile('A')?.commits[0].sha,'a');
});
