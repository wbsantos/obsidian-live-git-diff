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
