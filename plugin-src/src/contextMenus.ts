import { MarkdownView, Menu, Notice, TFile } from 'obsidian';
import type { Plugin, TAbstractFile, WorkspaceLeaf } from 'obsidian';

interface FileMenuHost {
  openHistory(file: TFile): Promise<void>;
  openReview(options: { file: TFile; leaf?: WorkspaceLeaf; repin: boolean }): Promise<void>;
}

/** Menu targets come from the clicked file/view, never the globally active note. */
export function registerFileMenus(plugin: Plugin, host: FileMenuHost): void {
  const { app } = plugin;
  const decorated = new WeakSet<Menu>();
  const bindings = new Map<MarkdownView, () => void>();
  let disposed = false, scheduled = false;

  function addActions(menu: Menu, file: TAbstractFile | null, leaf?: WorkspaceLeaf): void {
    if (!(file instanceof TFile) || file.extension !== 'md' || decorated.has(menu)) return;
    decorated.add(menu);
    const run = async (compare: boolean): Promise<void> => {
      if (disposed) return;
      if (app.vault.getAbstractFileByPath(file.path) !== file) { new Notice('The file is no longer available.'); return; }
      try {
        if (compare) await host.openReview({ file, leaf, repin: true });
        else await host.openHistory(file);
      } catch (error) { new Notice(`Unable to ${compare ? 'compare this file' : 'open Git history'}: ${(error as Error).message || error}`); }
    };
    menu.addItem(item => item.setSection('action').setTitle('Git History').setIcon('history').onClick(() => run(false)));
    menu.addItem(item => item.setSection('action').setTitle('Git Compare').setIcon('git-compare').onClick(() => run(true)));
  }

  plugin.registerEvent(app.workspace.on('file-menu', (menu, file, _source, leaf) => addActions(menu, file, leaf)));
  plugin.registerEvent(app.workspace.on('editor-menu', (menu, _editor, info) => {
    addActions(menu, info.file, info instanceof MarkdownView ? info.leaf : undefined);
  }));

  function attach(): void {
    if (disposed) return;
    const views = new Set(app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView));
    for (const [view, remove] of bindings) if (!views.has(view)) { remove(); bindings.delete(view); }
    for (const view of views) if (!bindings.has(view)) {
      const handler = (event: MouseEvent): void => {
        const target = event.target;
        if (!(target instanceof view.containerEl.ownerDocument.defaultView!.Element) || !view.file) return;
        // Leave links, embeds, property editors and other interactive controls to their own menus.
        if (target.closest('a,img,video,audio,input,textarea,button,.markdown-embed,.metadata-container,.cm-table-widget [contenteditable="true"]')) return;
        const reading = view.getMode() === 'preview' && !!target.closest('.markdown-preview-view');
        const table = view.getMode() === 'source' && !!target.closest('.cm-table-widget');
        const header = !!target.closest('.view-header-title');
        if (!reading && !table && !header) return;
        if (reading && target.closest('[contenteditable="true"]')) return;
        const alreadyHandled = event.defaultPrevented;
        const menu = Menu.forEvent(event);
        // Plain reading text normally uses Electron's clipboard menu. Preserve Copy
        // when creating its public event menu; shared native menus retain their items.
        if (reading && !alreadyHandled) {
          const selection = view.containerEl.ownerDocument.getSelection();
          const text = selection && view.containerEl.contains(selection.anchorNode) && view.containerEl.contains(selection.focusNode) ? selection.toString() : '';
          if (text) menu.addItem(item => item.setSection('clipboard').setTitle('Copy').setIcon('copy')
            .onClick(() => view.containerEl.ownerDocument.defaultView!.navigator.clipboard.writeText(text)
              .catch(() => { new Notice('Unable to copy the selected text.'); })));
        }
        addActions(menu, view.file, view.leaf);
      };
      view.containerEl.addEventListener('contextmenu', handler);
      bindings.set(view, () => view.containerEl.removeEventListener('contextmenu', handler));
    }
  }
  const schedule = (): void => {
    if (scheduled || disposed) return;
    scheduled = true; queueMicrotask(() => { scheduled = false; attach(); });
  };
  plugin.registerEvent(app.workspace.on('layout-change', schedule));
  app.workspace.onLayoutReady(attach);
  plugin.register(() => { disposed = true; for (const remove of bindings.values()) remove(); bindings.clear(); });
}
