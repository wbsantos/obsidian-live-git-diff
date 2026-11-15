# Validation: 0.4.0

Validated on 2026-11-07 with Node 24.13.0 and Obsidian 1.15.0 on Windows. Application checks used a separate vault/profile with the existing appearance settings, CSS snippets and community plugins. Original documents and their Git repository were not modified.

## Selection and history

Selection is now a draft. A plain click selects one version; Ctrl/Cmd+click adds/removes a second. Compare or Ctrl/Cmd+Enter applies a detached, immutable request. The keyboard shortcut uses Obsidian's public view Scope so it is handled before application-wide shortcuts.

The panel stays on the explicitly chosen file. Opening another note, filtering, clearing a draft and closing a comparison do not retarget the history. Reopening the same history retains its selection, filter and scroll. Renaming a file or its containing folder updates the target; deletion disables comparison and reports unavailability. Late history results may update their original cache but cannot repaint another visit or a deleted target.

## Context menus

Git History and Git Compare are available in the File Explorer, note tab/header, Live Preview editor, native table menu and Reading view. History does not open a closed note; Compare opens/reveals the clicked file against the configured reference and leaves any history draft independent.

Integration uses the public file-menu/editor-menu events, registered view DOM listeners and Menu.forEvent. A WeakSet deduplicates items when hooks share a menu. Listeners are removed when a view disappears or the plugin unloads. Reading text retains Copy when selected; links and interactive components keep their native contexts. Folders do not receive Markdown-only actions.

## Automated checks

`npm run ci` passed TypeScript, the worker capability audit before embedding, the plugin bundle gate and all **173 tests**, with no failures or skipped tests. Existing engine, rendering, Git, worker and revision regressions remain in the suite. New regressions cover immutable submitted requests, same-file reopening, deleted-file responses/cache recovery and replacement of a two-version draft by a plain click.

Runtime dependencies remain pinned to `markdown-it@15.0.3` and `diff@9.0.0`. `npm audit --omit=dev` reported **zero vulnerabilities**. The full development audit still reports two moderate findings through the Obsidian SDK's Moment dependency; neither the SDK nor Moment is bundled. No dependency versions changed in this release.

## Application verification

| Check | Passing assertions |
| --- | ---: |
| Explicit selection, independent history, opening state, rename/delete | 18 |
| Actual context menus, correct targets, Copy, deduplication and reload | 19 |
| Existing lifecycle, history, editing, external updates and width regressions | 32 |
| Native table editing, pixels, undo/redo, folds, resizing and recycling | 14 |

The **83 application checks** included real mouse and keyboard input, DOM inspection and screenshot pixels. Selection checks retained the same Session and reference leaf, unchanged scroll offsets, and the pinned commit until explicit application. A delayed submitted request retained its original commit while the draft changed. Menus were opened with actual right-click input; Copy was verified against a temporary clipboard API spy in the QA process without replacing the system clipboard.

Regression checks verified green added-row pixels in historical views and native table cells, including while editing, after undo/redo, after folding/unfolding and after resizing. Editor width remains equal with the plugin disabled, enabled without a review and after closing a review. The comparison engine and large-document algorithm were unchanged; the prior performance work was retained.

## Reproduction

Run from `plugin-src` with an explicit local QA manifest. The tools verify the connected vault path before performing interactions. Manifests containing private document copies, local results and screenshots are excluded from Git.

- `tools/verify-selection.mjs`: draft-versus-active review, fixed file history, immutable submissions, keyboard scope and target lifecycle.
- `tools/verify-context-menus.mjs`: actual Explorer/editor/reading/header/tab/table menus, linked-file targets, selected-text Copy, repeated native hooks and plugin reload.
- `tools/verify-experience.mjs`: existing review interactions, updated to use the explicit Compare button.
- `tools/verify-table-interaction.mjs`: native table editing and visible green pixels.
- `tools/load-qa.mjs`: loads the built release only after verifying the isolated vault.

The history fixture comes from `tools/prepare-history-qa.mjs`; table fixtures and independent visual expectations come from `tools/prepare-visual-qa.mjs`. The tools require a local Obsidian CDP endpoint and must not target a working vault.

Minimum declared Obsidian version remains 1.7.2; the application verification covered 1.15.0. The historical side remains read-only. No editor private fields, monkey patches or content-writing transactions were introduced into the plugin. Table presentation retains guarded DOM mapping; existing defensive Reading-section compatibility remains unchanged.


## Git / Jujutsu history and explicit Workcopy

The history now starts with Workcopy selected. Comparisons require two distinct endpoints; selecting another historical target retains the Workcopy anchor. JJ change rows expand into immutable snapshots, filtered by the note's file content, with selected child snapshots cleared on collapse. Workcopy remains live and historical endpoints remain pinned.

The complete automated suite passed **188 tests**. Targeted controller, active-note and bundle checks also passed after the final changes. Real JJ integration covers colocated and non-colocated workspaces, stable change identity during snapshotting, unrelated-file filtering, and unchanged file bytes after snapshotting. The filesystem-import and note-writing gates continue to pass.

Actual Obsidian validation used the disposable vault under `.npm-cache/jj-app-qa`, never a working vault. It verified expansion/collapse, two historical endpoints, editable Workcopy comparisons, automatic snapshotting after the 15-second save debounce, and Git backend selection for a nested Git repository. The isolated Chromium DOM harness passed 15 assertions in each of the light/dark themes.

Eight native application screenshots are saved in `docs/screenshots/history-jj/`, including Workcopy evolution, an expanded historical change, selected snapshots in both themes, historical comparison, live comparison and the Git equivalent. These screenshots contain demonstration notes only.

JJ commands use `--ignore-working-copy` for queries and explicitly use `jj util snapshot` for authorized background recording. This records saved workspace contents according to JJ tracking rules and can update repository metadata and objects; the plugin does not force editor saves or run `jj commit`/`jj new` on working repositories. Snapshots are serialized by repository and scheduled by workspace after 15 seconds without relevant saves. Git-only repositories never receive automatic commits.

Reproduce native checks from `plugin-src` with `node tools/prepare-jj-qa.mjs`, an isolated Obsidian profile on port 9237, `node tools/load-qa.mjs ../.npm-cache/jj-app-qa/manifest.json`, and `node tools/verify-jj-app.mjs`.
