# Live Git Diff

Compare Markdown notes with Git versions while editing in Obsidian's native Live Preview. The historical version is rendered read-only. Changes to visible content, formatting, links and structure remain visible; equivalent Markdown spelling and table padding are ignored.

## Open a comparison

Use **Compare** in the note header, next to Obsidian's reading/editing controls, to compare with the configured reference (HEAD by default). The button becomes **Close comparison** during review. Closing either participating tab also closes the review and clears its highlights. Other note tabs remain open.

Use the adjacent **Git History** button to open the sidebar. The panel stays on that file when you switch notes. **Git History** is also available by right-clicking a Markdown file in the File Explorer, a note's tab/header, or its content in Live Preview and reading mode. Looking up history does not open the note.

- **Workcopy** is listed first and selected by default. It represents the live note, including unsaved edits.
- Click another version to prepare a comparison. Both selected rows show compare icons; either icon compares the pair. Double-click selects the target and opens the comparison when two targets are selected.
- With Workcopy selected, clicking another historical version replaces the previous historical selection. Without Workcopy, at most two historical versions can be selected.
- Right-click to compare with Workcopy, with another selected version, or clear selections. Enter/Space toggles selection; Ctrl/Cmd+Enter compares the pair.
- In a **Jujutsu** workspace, change rows expand into older snapshots. The current Workcopy change starts expanded; only changes to this note's content are shown. Repeated content after a reversal remains in the timeline. Collapsing a change deselects its children.
- JJ snapshots run **15 seconds** after relevant saves and immediately when opening/refreshing history or starting comparisons. Snapshots record saved workspace content; the live Workcopy comparison also reads unsaved editor text. The plugin uses `jj util snapshot`, preserving the current change instead of creating a new one.
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

### Jujutsu support

Requires `jj` 0.47.1 or newer and a Git-backed workspace (colocated or not). The plugin queries JJ before falling back to Git and uses the underlying Git object store for immutable file contents and rename history. A nested Git repository is handled as Git even inside a JJ workspace. Snapshot commands are serialized by repository; automatic snapshots are limited to notes with a history panel or comparison open. Ignored files are not force-tracked and editor buffers are not forcibly saved.

History refresh does not move the immutable side of an open comparison. The direct comparison default maps Git HEAD to JJ `@-` and HEAD~1 to `@--`; custom JJ references must resolve to one revision.

The plugin does not edit note content directly. JJ snapshotting deliberately writes repository metadata and objects; this is an exception to the former description of all VCS commands as read-only. Production code still imports no filesystem module and cannot directly write note files.

Screenshots from an isolated Obsidian vault: [JJ Workcopy evolution](docs/screenshots/history-jj/jj-workcopy-evolog-light.png), [selected snapshots](docs/screenshots/history-jj/jj-two-snapshots-dark.png), and [Git Workcopy](docs/screenshots/history-jj/git-workcopy-light.png).
