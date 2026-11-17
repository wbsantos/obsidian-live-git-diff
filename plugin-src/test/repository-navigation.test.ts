import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import type { GitContext } from '../src/git.ts';
import type { RepositoryRoute } from '../src/repositoryView.ts';

class TFile { path: string; constructor(path: string) { this.path = path; } get name() { return this.path.split('/').pop()!; } get extension() { return this.name.split('.').pop()!; } }
class TFolder { path: string; constructor(path: string) { this.path = path; } }
class MarkdownView {}
class PluginStub { app: unknown; constructor(app: unknown) { this.app = app; } }
interface Leaf { view: { getViewType(): string }; setViewState(state: unknown): Promise<void> }
interface FileState { path: string; historicalHead?: string }
interface HistoryView {
  leaf: Leaf;
  getViewType(): string;
  controller: { state: { file: FileState | null } };
  setFile(file: TFile | null): Promise<void>;
  setHistoricalFile(file: string, context: GitContext, head: string): Promise<void>;
  updateNavigation(): void;
}
interface RepositoryView { leaf: Leaf; getViewType(): string; setRoute(route: RepositoryRoute): Promise<void>; updateNavigation(): void }
interface TestPlugin {
  updateActions(): void;
  openRepository(file?: TFile): Promise<void>;
  navigateRepository(route: RepositoryRoute): Promise<void>;
  openHistory(file: TFile): Promise<void>;
  openRepositoryFile(context: GitContext, relative: string, revision?: string): Promise<void>;
  navigationBack(): void;
  navigationForward(): void;
  navigationState(): { back: boolean; forward: boolean };
}
interface PersistHost { settings: Record<string, unknown>; repositoryCache: { serialize(): unknown }; saveData(value: unknown): Promise<void> }
const notices: string[] = [];
const require = createRequire(import.meta.url);
const source = buildSync({ stdin: { contents: `export { default as Plugin } from './main.ts';
  export { GitHistoryView } from './historyView.ts'; export { GitRepositoryView } from './repositoryView.ts';
  export { registerFileMenus } from './contextMenus.ts';
  export { persistSettings, mergeSettings } from './settings.ts';`, resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) },
bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', external: ['lgd:worker'] }).outputFiles[0].text;
const module = { exports: {} };
new Function('require', 'module', 'exports', source)((id: string) => id === 'obsidian'
  ? { Plugin: PluginStub, MarkdownView, TFile, TFolder, Component: class {}, ItemView: class {}, PluginSettingTab: class {},
    Modal: class {}, Setting: class {}, setIcon() {}, setTooltip() {}, Notice: class { constructor(message: string) { notices.push(message); } hide() {} } } : require(id), module, module.exports);
const { Plugin, GitHistoryView, GitRepositoryView, persistSettings, mergeSettings, registerFileMenus } = module.exports as {
  Plugin: new (app: unknown) => TestPlugin;
  GitHistoryView: { prototype: HistoryView }; GitRepositoryView: { prototype: RepositoryView };
  persistSettings(host: PersistHost): Promise<void>; mergeSettings(value: unknown): Record<string, unknown>;
  registerFileMenus(plugin: unknown, host: unknown): void;
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

test('note header keeps file history and replaces Pending changes with repository history for that note', async () => {
  const actions: {icon:string;title:string;callback:()=>void}[]=[];
  const file=new TFile('Stories/note.md');
  const view=Object.assign(new MarkdownView(),{file,leaf:{},containerEl:{contains:()=>true},addAction(icon:string,title:string,callback:()=>void){
    actions.push({icon,title,callback});return {remove(){},addClass(){},setAttr(){}};
  }});
  const plugin=new Plugin({workspace:{getLeavesOfType:()=>[{view}]}});
  let opened:TFile|undefined;plugin.openRepository=async target=>{opened=target;};
  plugin.updateActions();
  assert.equal(actions.find(action=>action.title==='VCS History')?.icon,'history');
  assert.equal(actions.find(action=>action.title==='Repository history')?.icon,'git-branch');
  assert.equal(actions.some(action=>action.title==='Pending changes'),false);
  actions.find(action=>action.title==='Repository history')!.callback();await turn();
  assert.equal(opened,file);
});

test('file and folder menus offer VCS Pending Changes for the clicked target', async () => {
  const callbacks = new Map<string, (...args: any[]) => void>();
  const targets: unknown[] = [];
  const plugin = { app: { workspace: { on: (event: string, callback: (...args: any[]) => void) => callbacks.set(event, callback),
    onLayoutReady() {} } }, registerEvent() {}, register() {} };
  registerFileMenus(plugin, { openChanges: async (target: unknown) => { targets.push(target); } });
  const clicked = [new TFile('note.md'), new TFolder('folder')];
  for (const target of clicked) {
    const items: Array<{ title: string; click?: () => void }> = [];
    const menu = { addItem(callback: (item: unknown) => void) {
      const state: { title: string; click?: () => void } = { title: '' };
      const item = { setSection: () => item, setTitle: (title: string) => { state.title = title; return item; },
        setIcon: () => item, onClick: (click: () => void) => { state.click = click; return item; } };
      callback(item); items.push(state);
    } };
    callbacks.get('file-menu')!(menu, target);
    const action = items.find(item => item.title === 'VCS Pending Changes');
    assert.ok(action); action.click!();
  }
  assert.deepEqual(targets, clicked);
});

function setup() {
  const vaultRoot = path.resolve('repository-navigation-fixture');
  const context: GitContext = { root: vaultRoot, abs: path.join(vaultRoot, 'Stories/note.md'), rel: 'Stories/note.md', backend: 'git' };
  const files = new Map<string, TFile>(), leaves = new Set<Leaf>();
  let active: Leaf | null = null;
  const visited: RepositoryRoute[] = [];
  const history = Object.create(GitHistoryView.prototype) as HistoryView;
  const repo = Object.create(GitRepositoryView.prototype) as RepositoryView;
  const historyLeaf: Leaf = { view: history, setViewState: async () => { leaves.add(historyLeaf); } };
  const repoLeaf: Leaf = { view: repo, setViewState: async () => { leaves.add(repoLeaf); } };
  history.leaf = historyLeaf; repo.leaf = repoLeaf; leaves.add(historyLeaf); leaves.add(repoLeaf);
  history.controller = { state: { file: null } };
  history.setFile = async file => { history.controller.state.file = file; };
  history.setHistoricalFile = async (file, _context, head) => { history.controller.state.file = { path: file, historicalHead: head }; };
  history.updateNavigation = () => {}; repo.updateNavigation = () => {};
  repo.setRoute = async route => { visited.push(route); };
  const plugin = new Plugin({ workspace: {
    getLeavesOfType: (type: string) => [...leaves].filter(leaf => leaf.view.getViewType() === type),
    getRightLeaf: () => leaves.has(historyLeaf) ? repoLeaf : historyLeaf,
    revealLeaf: async (leaf: Leaf) => { active = leaf; },
  }, vault: { adapter: { getFullPath: (relative: string) => path.join(vaultRoot, relative) },
    getAbstractFileByPath: (file: string) => files.get(file) || null } });
  const note = (file: string) => { const value = new TFile(file); files.set(file, value); return value; };
  return { plugin, context, files, leaves, history, repo, historyLeaf, repoLeaf, visited, note, get active() { return active; } };
}

test('folder, change, file and another folder share one reversible navigation trail', async () => {
  const s = setup(); s.note('Stories/note.md');
  const folder: RepositoryRoute = { kind: 'log', context: s.context, path: 'Stories' };
  const first: RepositoryRoute = { kind: 'details', context: s.context, sha: 'first' };
  const second: RepositoryRoute = { kind: 'details', context: s.context, sha: 'second' };
  const other: RepositoryRoute = { kind: 'log', context: s.context, path: 'Other' };
  await s.plugin.navigateRepository(folder); await s.plugin.navigateRepository(first);
  await s.plugin.openRepositoryFile(s.context, 'Stories/note.md', 'first');
  assert.equal(s.active, s.historyLeaf); assert.equal(s.history.controller.state.file?.path, 'Stories/note.md');
  await s.plugin.navigateRepository(second); await s.plugin.navigateRepository(other);
  s.plugin.navigationBack(); await turn(); assert.equal(s.visited.at(-1), second);
  s.plugin.navigationBack(); await turn(); assert.equal(s.active, s.historyLeaf);
  s.plugin.navigationBack(); await turn(); assert.equal(s.visited.at(-1), first);
  s.plugin.navigationBack(); await turn(); assert.equal(s.visited.at(-1), folder);
  assert.deepEqual(s.plugin.navigationState(), { back: false, forward: true });
  s.plugin.navigationForward(); await turn(); assert.equal(s.visited.at(-1), first);
  s.plugin.navigationForward(); await turn(); assert.equal(s.active, s.historyLeaf);
});

test('removed paths enter historical history and preserve its revision across back/forward', async () => {
  const s = setup(), folder: RepositoryRoute = { kind: 'log', context: s.context, path: 'Stories' };
  await s.plugin.navigateRepository(folder);
  await s.plugin.openRepositoryFile(s.context, 'Stories/deleted.md', 'archived');
  assert.deepEqual(s.history.controller.state.file, { path: 'Stories/deleted.md', historicalHead: 'archived' });
  s.plugin.navigationBack(); await turn(); assert.equal(s.visited.at(-1), folder);
  s.plugin.navigationForward(); await turn(); assert.deepEqual(s.history.controller.state.file, { path: 'Stories/deleted.md', historicalHead: 'archived' });
});

test('logical vault mapping rejects files outside the vault before creating a navigation entry', async () => {
  const s = setup(); notices.length = 0;
  await s.plugin.openRepositoryFile(s.context, '../outside.md', 'revision');
  assert.equal(s.active, null); assert.match(notices.at(-1)!, /outside the vault/);
  assert.deepEqual(s.plugin.navigationState(), { back: false, forward: false });
});

test('choosing file history supersedes pending creation of a repository pane', async () => {
  const s = setup(), note = s.note('Stories/note.md'), gate = deferred();
  s.leaves.delete(s.repoLeaf);
  s.repoLeaf.setViewState = async () => { await gate.promise; s.leaves.add(s.repoLeaf); };
  const pending = s.plugin.navigateRepository({ kind: 'log', context: s.context });
  await turn(); await s.plugin.openHistory(note); gate.resolve(); await pending;
  assert.equal(s.active, s.historyLeaf);
  assert.equal(s.visited.length, 0);
});

test('choosing a repository route supersedes pending creation of a file history pane', async () => {
  const s = setup(), note = s.note('Stories/note.md'), gate = deferred();
  s.leaves.delete(s.historyLeaf);
  s.historyLeaf.setViewState = async () => { await gate.promise; s.leaves.add(s.historyLeaf); };
  const pending = s.plugin.openHistory(note); await turn();
  const route: RepositoryRoute = { kind: 'details', context: s.context, sha: 'newer' };
  await s.plugin.navigateRepository(route); gate.resolve(); await pending;
  assert.equal(s.active, s.repoLeaf); assert.equal(s.visited.at(-1), route);
});

test('cache persistence and settings writes are serialized and capture latest queued settings', async () => {
  const first = deferred(), saves: Array<Record<string, unknown>> = []; let active = 0, maxActive = 0;
  const host: PersistHost = { settings: { debug: false }, repositoryCache: { serialize: () => ({ generation: saves.length }) },
    saveData: async value => { active++; maxActive = Math.max(active, maxActive); saves.push(value as Record<string, unknown>);
      if (saves.length === 1) await first.promise; active--; } };
  const older = persistSettings(host); await turn();
  host.settings.debug = true; const newer = persistSettings(host); await turn();
  assert.equal(saves.length, 1); first.resolve(); await Promise.all([older, newer]);
  assert.equal(maxActive, 1); assert.equal(saves[1].debug, true);
  assert.deepEqual(saves[1].repositoryHistoryCache, { generation: 1 });
  assert.equal(mergeSettings(saves[1]).repositoryHistoryCache, undefined);
});

test('a failed cache/settings save cannot poison the next persistence request', async () => {
  let writes = 0;
  const host: PersistHost = { settings: { debug: false }, repositoryCache: { serialize: () => ({}) },
    saveData: async () => { if (++writes === 1) throw new Error('disk full'); } };
  const failure = persistSettings(host), recovery = persistSettings(host);
  await assert.rejects(failure, /disk full/); await recovery; assert.equal(writes, 2);
});

test('legacy remote overrides are discarded and the previous-version comparison becomes the default once', () => {
  assert.equal(mergeSettings({}).remoteTargets, undefined);
  assert.equal(mergeSettings({ remoteTargets: { repo: { remote: 'other', branch: 'wrong' } } }).remoteTargets, undefined);
  assert.equal(mergeSettings({}).baseRefMode, 'file-prev');
  assert.equal(mergeSettings({baseRefMode:'head'}).baseRefMode, 'file-prev');
  assert.equal(mergeSettings({baseRefMode:'head',comparisonDefaultsVersion:1}).baseRefMode, 'head');
  assert.equal(mergeSettings({baseRefMode:'custom',baseRef:'main'}).baseRefMode, 'custom');
});
