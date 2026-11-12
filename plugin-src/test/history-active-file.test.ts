import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

class TFile {
  path: string;
  constructor(path: string) { this.path = path; }
  get extension(): string { return this.path.split('.').pop()!; }
  get name(): string { return this.path.split('/').pop()!; }
}
interface View { getViewType(): string }
interface Leaf { view: View; detach(): void; setViewState(state: { type: string; active: boolean }): Promise<void> }
class MarkdownView implements View {
  file: TFile | null = null;
  containerEl = { addEventListener() { }, removeEventListener() { } };
  getViewType(): string { return 'markdown'; }
}
class PluginStub {
  app: unknown;
  constructor(app: unknown) { this.app = app; }
  registerView() { }
  registerEvent() { }
  register() { }
  registerEditorExtension() { }
  registerMarkdownPostProcessor() { }
  addSettingTab() { }
  addCommand() { }
}
interface SnapshotView extends View { side: 'a' | 'b' }
interface HistoryView extends View {
  leaf: Leaf;
  controller: { state: { file: { path: string } | null }; fileUnavailable(): void };
  setFile(file: TFile | null): Promise<void>;
  updateActiveFile(): void;
  updateComparisonState(): void;
}
interface TestPlugin {
  session: { filePath: string } | null;
  participants: Map<Leaf, { type: string; side?: 'a' | 'b' }>;
  sync: { attach(): void; detach(): void };
  historyActiveFile(): TFile | null;
  openHistory(file: TFile | null): Promise<void>;
  closeReview(): void;
  onload(): Promise<void>;
  scheduleLayout(): void;
}

// Evaluate the current source as CommonJS with the same host-class stubs as the
// bundle smoke test. No dist rebuild, DOM, worker, or Git subprocess is required.
const require = createRequire(import.meta.url);
const source = buildSync({
  stdin: {
    contents: `export { default as Plugin } from './main.ts';
      export { GitBaseView, VIEW_TYPE } from './baseView.ts';
      export { GitHistoryView, HISTORY_VIEW_TYPE } from './historyView.ts';`,
    resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  packages: 'external', external: ['lgd:worker'],
}).outputFiles[0].text;
const module = { exports: {} };
const obsidian = {
  Plugin: PluginStub, MarkdownView, TFile, Component: class { }, ItemView: class { },
  PluginSettingTab: class { }, Setting: class { }, Notice: class { },
};
new Function('require', 'module', 'exports', source)(
  (id: string) => id === 'obsidian' ? obsidian : require(id), module, module.exports,
);
const { Plugin, GitBaseView, GitHistoryView, VIEW_TYPE } = module.exports as {
  Plugin: new (app: unknown) => TestPlugin;
  GitBaseView: { prototype: SnapshotView };
  GitHistoryView: { prototype: HistoryView };
  VIEW_TYPE: string; HISTORY_VIEW_TYPE: string;
};

function setup() {
  const leaves = new Set<Leaf>(), files = new Map<string, TFile>();
  const sidebars = new Set<Leaf>();
  let activeLeaf: Leaf | null = null, contentLeaf: Leaf | null = null;
  const workspaceEvents = new EventEmitter(), vaultEvents = new EventEmitter();
  const workspace = {
    get activeLeaf(): Leaf | null { return activeLeaf; },
    set activeLeaf(value: Leaf | null) {
      activeLeaf = value;
      if (value && !sidebars.has(value)) contentLeaf = value;
    },
    getMostRecentLeaf: () => contentLeaf,
    on: workspaceEvents.on.bind(workspaceEvents), onLayoutReady() { },
    iterateAllLeaves: (visit: (leaf: Leaf) => void) => leaves.forEach(visit),
    getLeavesOfType: (type: string) => [...leaves].filter(leaf => leaf.view.getViewType() === type),
    // These retained values must never be used for the active-note cue.
    getActiveFile: () => files.get('retained.md'),
    getActiveViewOfType: () => ({ file: files.get('retained.md') }),
    getRightLeaf: () => historyLeaf,
    revealLeaf: async (leaf: Leaf) => { workspace.activeLeaf = leaf; },
  };
  const plugin = new Plugin({ workspace, vault: {
    on: vaultEvents.on.bind(vaultEvents), getAbstractFileByPath: (path: string) => files.get(path) || null,
  } });
  // Rendering and geometry are outside the active-context contract under test.
  Object.assign(plugin, {
    loadSettings: async () => undefined, updateActions() { }, publishEditorMarks() { },
    watchReadingPane() { }, decorateNotePaneInPlace() { }, clearNoteDecorations() { },
    checkBreaks: async () => undefined, sync: { attach() { }, detach() { } },
  });
  function leaf(view: View, location: 'main' | 'left' | 'right' | 'popout' = 'main'): Leaf {
    const result: Leaf = { view, detach: () => { leaves.delete(result); },
      setViewState: async () => { workspace.activeLeaf = result; } };
    leaves.add(result);
    if (location === 'left' || location === 'right') sidebars.add(result);
    return result;
  }
  function note(path: string) {
    const file = new TFile(path); files.set(path, file);
    const view = new MarkdownView(); view.file = file;
    return { file, view, leaf: leaf(view) };
  }
  const history = Object.create(GitHistoryView.prototype) as HistoryView;
  const historyLeaf = leaf(history, 'right'); history.leaf = historyLeaf;
  const updates: Array<TFile | null> = [];
  history.controller = { state: { file: { path: 'retained.md' } }, fileUnavailable() { } };
  history.setFile = async file => { history.controller.state.file = file; };
  history.updateActiveFile = () => { updates.push(plugin.historyActiveFile()); };
  history.updateComparisonState = history.updateActiveFile;
  function snapshot(side: 'a' | 'b') {
    const view = Object.create(GitBaseView.prototype) as SnapshotView; view.side = side;
    const result = leaf(view); plugin.participants.set(result, { type: VIEW_TYPE, side });
    return result;
  }
  note('retained.md');
  return { plugin, workspace, workspaceEvents, vaultEvents, leaves, files, leaf, note,
    history, historyLeaf, updates, snapshot };
}

test('active cue uses the actual Markdown leaf and follows its file while history has focus', () => {
  const s = setup(), a = s.note('a.md'), b = s.note('b.md');
  s.workspace.activeLeaf = a.leaf;
  assert.equal(s.plugin.historyActiveFile(), a.file);
  s.workspace.activeLeaf = s.historyLeaf;
  assert.equal(s.plugin.historyActiveFile(), a.file);
  a.view.file = b.file;
  assert.equal(s.plugin.historyActiveFile(), b.file);
});

test('non-note content views and a fresh sidebar have no active cue', () => {
  const s = setup(), a = s.note('a.md');
  s.workspace.activeLeaf = s.historyLeaf;
  assert.equal(s.plugin.historyActiveFile(), null);
  s.workspace.activeLeaf = a.leaf; s.plugin.historyActiveFile();
  for (const other of [s.leaf({ getViewType: () => 'canvas' }), s.note('image.png').leaf]) {
    s.workspace.activeLeaf = other;
    assert.equal(s.plugin.historyActiveFile(), null);
    s.workspace.activeLeaf = s.historyLeaf;
    assert.equal(s.plugin.historyActiveFile(), null);
  }
});

test('left and right sidebars preserve the visible note independently of keyboard focus', async () => {
  const s = setup(), a = s.note('a.md'), b = s.note('b.md');
  const explorer = s.leaf({ getViewType: () => 'file-explorer' }, 'left');
  const search = s.leaf({ getViewType: () => 'search' }, 'left');
  const outline = s.leaf({ getViewType: () => 'outline' }, 'right');
  for (const note of [a, b]) {
    s.workspace.activeLeaf = note.leaf;
    // Also covers first lookup after plugin load while the explorer already has focus.
    for (const sidebar of [explorer, search, outline, s.historyLeaf, null]) {
      s.workspace.activeLeaf = sidebar; s.plugin.scheduleLayout(); await Promise.resolve();
      assert.equal(s.plugin.historyActiveFile(), note.file);
      assert.equal(s.updates.at(-1), note.file);
    }
  }
});

test('sidebar focus preserves historical comparison identity and follows non-note content changes', () => {
  const s = setup(), a = s.note('a.md');
  s.plugin.session = { filePath: a.file.path };
  const explorer = s.leaf({ getViewType: () => 'file-explorer' }, 'left');
  for (const side of ['a', 'b'] as const) {
    s.workspace.activeLeaf = s.snapshot(side);
    s.workspace.activeLeaf = explorer;
    assert.equal(s.plugin.historyActiveFile(), a.file);
  }
  s.workspace.activeLeaf = s.leaf({ getViewType: () => 'canvas' });
  s.workspace.activeLeaf = explorer;
  assert.equal(s.plugin.historyActiveFile(), null);
});

test('the latest content pane may belong to a pop-out window', () => {
  const s = setup(), a = s.note('a.md');
  const popout = s.leaf(a.view, 'popout');
  s.workspace.activeLeaf = popout;
  s.workspace.activeLeaf = s.leaf({ getViewType: () => 'file-explorer' }, 'left');
  assert.equal(s.plugin.historyActiveFile(), a.file);
});

test('either snapshot side resolves the current session only for a matching participant', () => {
  const s = setup(), a = s.note('a.md'); s.plugin.session = { filePath: a.file.path };
  for (const side of ['a', 'b'] as const) {
    const leaf = s.snapshot(side); s.workspace.activeLeaf = leaf;
    assert.equal(s.plugin.historyActiveFile(), a.file);
    s.workspace.activeLeaf = s.historyLeaf;
    assert.equal(s.plugin.historyActiveFile(), a.file);
    s.plugin.participants.set(leaf, { type: VIEW_TYPE, side: side === 'a' ? 'b' : 'a' });
    assert.equal(s.plugin.historyActiveFile(), null);
    s.plugin.participants.delete(leaf);
    assert.equal(s.plugin.historyActiveFile(), null);
  }
});

test('closed leaves and deleted or replaced note objects cannot leave a stale cue', () => {
  const s = setup(), a = s.note('a.md');
  s.workspace.activeLeaf = a.leaf; s.plugin.historyActiveFile();
  s.workspace.activeLeaf = s.historyLeaf;
  s.files.delete(a.file.path);
  assert.equal(s.plugin.historyActiveFile(), null);
  s.files.set(a.file.path, new TFile(a.file.path));
  assert.equal(s.plugin.historyActiveFile(), null);
  s.files.set(a.file.path, a.file);
  a.leaf.detach();
  assert.equal(s.plugin.historyActiveFile(), null);
});

test('closing a comparison invalidates a tracked snapshot but preserves a tracked Markdown note', () => {
  const s = setup(), a = s.note('a.md'); s.plugin.session = { filePath: a.file.path };
  s.workspace.activeLeaf = s.snapshot('a'); s.plugin.historyActiveFile();
  s.workspace.activeLeaf = s.historyLeaf;
  s.plugin.closeReview();
  assert.equal(s.updates.at(-1), null);
  s.workspace.activeLeaf = a.leaf; s.plugin.historyActiveFile();
  s.workspace.activeLeaf = s.historyLeaf;
  s.plugin.closeReview();
  assert.equal(s.updates.at(-1), a.file);
});

test('layout coalescing captures the last content focus before sidebar activation', async () => {
  const s = setup(), a = s.note('a.md'), b = s.note('b.md');
  s.workspace.activeLeaf = a.leaf; s.plugin.scheduleLayout();
  s.workspace.activeLeaf = b.leaf; s.plugin.scheduleLayout();
  s.workspace.activeLeaf = s.historyLeaf; s.plugin.scheduleLayout();
  await Promise.resolve();
  assert.deepEqual(s.updates, [b.file]);
  b.leaf.detach(); s.plugin.scheduleLayout(); await Promise.resolve();
  assert.equal(s.updates.at(-1), null);
});

test('openHistory captures content before activating a newly created sidebar', async () => {
  const s = setup(), a = s.note('a.md'), browsed = s.note('browsed.md');
  s.leaves.delete(s.historyLeaf);
  s.historyLeaf.setViewState = async () => {
    s.leaves.add(s.historyLeaf); s.workspace.activeLeaf = s.historyLeaf;
  };
  s.workspace.activeLeaf = a.leaf;
  await s.plugin.openHistory(browsed.file);
  assert.equal(s.workspace.activeLeaf, s.historyLeaf);
  assert.equal(s.history.controller.state.file, browsed.file);
  assert.equal(s.plugin.historyActiveFile(), a.file);
});

test('registered workspace and vault events refresh active context, including folder rename/delete', async () => {
  const s = setup(); await s.plugin.onload();
  // onload installs the real sync object; geometry remains irrelevant here.
  s.plugin.sync = { attach() { }, detach() { } };
  const a = s.note('folder/a.md');
  for (const event of ['file-open', 'active-leaf-change', 'layout-change']) {
    s.workspace.activeLeaf = a.leaf; s.workspaceEvents.emit(event);
    s.workspace.activeLeaf = s.historyLeaf;
    await Promise.resolve();
    assert.equal(s.updates.at(-1), a.file);
  }
  s.files.delete(a.file.path); a.file.path = 'renamed/a.md'; s.files.set(a.file.path, a.file);
  s.vaultEvents.emit('rename', { path: 'renamed' }, 'folder'); await Promise.resolve();
  assert.equal(s.updates.at(-1)?.path, 'renamed/a.md');
  s.files.delete(a.file.path);
  s.vaultEvents.emit('delete', { path: 'renamed' }); await Promise.resolve();
  assert.equal(s.updates.at(-1), null);
});
