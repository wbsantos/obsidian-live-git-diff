# Live Git Diff

Compare Markdown notes with Git versions while editing in Obsidian's native Live Preview. The historical version is rendered read-only. Changes to visible content, formatting, links and structure remain visible; equivalent Markdown spelling and table padding are ignored.

## Open a comparison

Use **Compare** in the note header, next to Obsidian's reading/editing controls, to compare with the configured reference (HEAD by default). The button becomes **Close comparison** during review. Closing either participating tab also closes the review and clears its highlights. Other note tabs remain open.

Use the adjacent **Git History** button to open the sidebar. The panel stays on that file when you switch notes. **Git History** is also available by right-clicking a Markdown file in the File Explorer, a note's tab/header, or its content in Live Preview and reading mode. Looking up history does not open the note.

- Click a commit to select or deselect it. Up to two versions can be selected; clicking a third keeps the existing pair. Selection does not change the open comparison.
- Selected rows show a compare icon on the right. With one version selected, it compares against that note's working tree, including unsaved edits. Double-click any commit to select only that version and compare it with the working tree immediately.
- With two selected, either compare icon opens two read-only historical panes. A dashed line connects the icons when both rows are included in the filter. The earlier version starts on the left; **Swap sides** reverses them.
- Right-click a commit to compare it with the worktree or any other selected commit, or choose **Clear Selections** to reset the draft without closing a review. Opening the menu preserves the current selection.
- Enter/Space toggles a focused row; Ctrl/Cmd+Enter applies the selection while focus is inside the history panel.
- Filter loaded commits, select **Load more**, or refresh the history. The footer shows Git loading progress and the time of the last successful synchronization.

The selected versions and the active comparison are displayed separately. You can prepare a comparison for another file while the current review remains open. Closing a review preserves the prepared selection. Choosing **Git History** on another file changes the panel and clears the draft; choosing the same file preserves its selection, filter and scroll position.

The header's small indicator and subtle border are green when the history belongs to the displayed note, amber when it belongs to another note, and neutral when the current content tab is not a note. Historical comparison panes count as their original note. Hover over the indicator for details. When the note differs, **Show history for active note**, beside Refresh, switches the panel to that note. Clicking any sidebar, including the File Explorer, preserves the displayed note context.

The context-menu action **Git Compare** starts a comparison immediately against the configured reference, opening or revealing the clicked note. It is independent of the history panel's prepared selection. Reading menus preserve Copy for selected text and leave links and other interactive components with their native menus.

The command palette remains available. **Open review against a version…** opens the same history sidebar. **Refresh review (re-pin the base version)** explicitly chooses the base again. Ordinary edits, external saves and history refreshes retain the chosen commit.

If the note has already been committed, select its previous file version or two historical commits to see that committed change. Comparing an unchanged worktree with HEAD correctly produces no differences.

## Review behavior

The comparison updates after 300 ms without typing. Obsolete highlights disappear immediately. Obsidian retains control of edits, the cursor, selection, undo, redo and saving. Reading mode is also supported. Outside a review, the plugin reserves no gutter space and leaves the editor content width unchanged.

Added content is green and removed content is red. Modified content shows its old and current forms. Tables are compared by rows and cells: added rows are green on the current side, removed rows are red on the base side, and unchanged headers and rows keep their normal appearance. A note explains additions that have no corresponding row on the opposite side. Lists are highlighted by changed item, including continuations.

History is cached per repository and file. A late Git result may populate that file's cache, but cannot change a panel that has switched to a different note or a newer visit to the same note. Paging retains its original HEAD, and history refresh never changes the pinned comparison.

## Installation and development

This desktop plugin requires Git on PATH. Install `main.js`, `manifest.json` and `styles.css` from `plugin-dist` into `.obsidian/plugins/live-git-diff/`. Reload the plugin after replacing its files. Back up the existing plugin directory first; retain `data.json` to preserve settings.

```powershell
cd plugin-src
npm ci --ignore-scripts
npm run ci
```

The build produces `plugin-dist`. The parser and diff libraries are bundled and pinned in the lockfile. The comparison worker is audited before embedding; the build and tests check the bundle's read-only constraints. Plugin transactions contain presentation and scrolling effects only. Settings are saved through Obsidian's plugin API.

See [validation and compatibility notes](VALIDATION.md) for the tested environment, verification tools and limitations. The original project documentation is retained in [README-0.1.1.md](README-0.1.1.md).

## Limits

The historical side uses Obsidian's Markdown renderer, rather than a second editable Live Preview. Properties and unsupported syntax are compared conservatively and identified in the panel. Dynamic plugin output does not define equality. Moved blocks have no special category. When refinement reaches its budget, the block remains marked as changed with an explicit simplified-details message.

Native table presentation uses the registered public CodeMirror view and source positions, with guarded DOM mapping to Obsidian's table widgets. If a future renderer prevents reliable mapping, the panel reports the limitation. Other replacement widgets, including formulas, use margin indicators. Reading-mode section discovery retains a guarded compatibility fallback for already-rendered sections.

Large documents are analyzed in a worker and rendered in batches. Their first historical render can still take several seconds; subsequent edits reuse the fixed historical content.
