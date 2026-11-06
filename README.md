# Live Git Diff

Compare Markdown notes with Git versions while editing in Obsidian's native Live Preview. The historical version is rendered read-only. Changes to visible content, formatting, links and structure remain visible; equivalent Markdown spelling and table padding are ignored.

## Open a comparison

Use **Compare** in the note header, next to Obsidian's reading/editing controls, to compare with the configured reference (HEAD by default). The button becomes **Close comparison** during review. Closing either participating tab also closes the review and clears its highlights. Other note tabs remain open.

Use the adjacent **Git history** button to open the sidebar:

- Click one commit to compare it with the current note, including unsaved edits.
- Ctrl/Cmd+click a second commit to compare two historical versions in read-only panes. The earlier version starts on the left; **Swap sides** reverses them.
- Ctrl/Cmd+click a selected commit to deselect it. Up to two versions can be selected.
- Filter loaded commits, select **Load more**, or refresh the history. The footer shows Git loading progress and the time of the last successful synchronization.

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
