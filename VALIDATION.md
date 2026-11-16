# Validation: 0.6.0 — Remote push and pull

Validated on 2026-11-15 with Node 24.13.0, Git 2.47.1.windows.2, Jujutsu 0.47.1 and desktop Obsidian on Windows. All remote mutations used disposable local bare repositories; no hosted remote was contacted and no user repository was pushed or pulled.

- Automated validation: the full suite ran **241 tests**, with 240 passing and one CSS identifier contract failure. The datalist ID was corrected and the release rebuilt; all **10 bundle checks** then passed. TypeScript, worker audit and both capability gates passed for the final build.
- All **22 remote integration tests** passed, covering Git, colocated JJ and separate JJ storage: discovery, finalized-only push, fast-forward pull, preservation of disjoint pending work, divergence, and ignored-file protection. Additional cases cover targeted push despite mirror/follow-tags settings, invalid targets, detached Git HEAD, tracked-remote inference, pending renames, leading-space filenames, and retry after an overlap is resolved.
- Repository UI verification passes **35 assertions per theme**, including busy controls, duplicate submission protection, retained drafts and inline errors. Both light and dark themes were checked.
- Native Obsidian verification passed remote/branch selection and persistence, push of the finalized JJ parent, pull of a contributor's update, unchanged pending note content and working change ID, and refreshed history. The native tool creates only a local scratch remote.
- Inspected real-app screenshots: [remote settings](docs/screenshots/repository/remote-settings.png) and [repository remote actions](docs/screenshots/repository/remote-actions.png). Both are included in the README.

Reproduce with `npm run ci`, `node tools/verify-repository-ui.mjs <Chromium executable>` and, after installing the build in the isolated QA vault, `node tools/verify-remote-app.mjs`. The native tool verifies the vault path before mutation and also regenerates these two screenshots. HTTPS/SSH authentication against a hosted remote was not exercised; the plugin uses existing CLI credentials and reports errors without storing credentials.

Pull explicitly delegates working-file updates to the VCS. The direct note-write gate still rejects filesystem imports and note/editor mutation APIs; it does not claim subprocesses cannot update files. Git pull disables automatic stashing and ignored-file overwrite. JJ pull snapshots saved work and checks for overlapping pending or untracked paths before moving the working change. Push uses an explicit non-forced Git refspec for both backends, without mirror, tags or recursive submodule publication. Pending work and JJ evolution/operation history remain local.

## Previous validation: 0.5.0 — Change Review

Validated on 2026-11-15, Windows, Node 24.13.0, Git 2.47.1.windows.2 and Jujutsu 0.47.1. Repository mutations used fresh temporary repositories and a separate Obsidian profile. The development repository and the user's vault were not used for test commits.

- Full `npm run ci`: **218 tests passed**, no failures or skips; TypeScript, worker audit, bundle checks and note-write invariant passed. Final presentation/archived-comparison changes also passed the 47 affected unit/integration checks and a rebuilt 0.5.0 artifact.
- Isolated Chromium UI checks: **28 repository assertions per theme**, including pagination after an external update, draft preservation, selected folder operations, stale results, duplicate submit protection, AI generation without committing, cancellation and Explain context. Existing file history: **15 assertions per theme** unchanged.
- Native Obsidian: repository/folder history, change details, file navigation, Back/Forward, deleted-file history and two-version comparison (including Swap sides), selective JJ finalization and Git commit, description generation, Explain panel, and separate editable AI settings were exercised. Repository/file panels use sidebar tabs; Explain uses a separate lower pane.
- Copilot CLI **1.0.108** completed synthetic CLI and native Obsidian description/Explain requests. Codex CLI **0.167.2** completed a synthetic request using the configured restricted invocation. Claude Code **2.1.81** accepted its flags but returned HTTP 401, invalid OAuth token; successful Claude generation could not be verified with this account. The plugin displays the provider's authentication error.
- CLI transport tests cover Windows npm/native resolution, Unicode and shell-like source text on stdin, owned-process cancellation, event-output parsing and short-response limits. Git and JJ evidence tests ensure unselected files are excluded and stale status is rejected.

Reproduce with `npm run ci`, then `node tools/verify-repository-ui.mjs <Chromium executable>` and `node tools/verify-history-ui.mjs <Chromium executable>`. `tools/prepare-repository-qa.mjs` creates a fresh scratch vault and profile; start Obsidian with its `--user-data-dir` and port 9238, then run `tools/verify-repository-app.mjs`. Native AI checks require an installed, authenticated Copilot CLI and may consume provider usage. Short scratch paths avoid Windows path limits in JJ's operation store.

The cache persists metadata, never note bodies or AI output. It is invalidated after local changes and checked against current refs/JJ operation before reuse. The current first page is fetched again after a repository update; this is a bounded page cache, not an incremental database. Git uses `--skip`; JJ requests bounded prefixes. Filters cover loaded results only. Markdown comparisons retain their prior rendering and editor behavior; binary diffs, conflict resolution, staging hunks, remotes and history rewriting remain outside scope. Git commit hooks retain their normal behavior.

Current screenshots, captured from the real application in an isolated vault: [repository history](docs/screenshots/repository/repository-history.png), [folder history](docs/screenshots/repository/folder-history.png), [change details](docs/screenshots/repository/change-details.png), [pending changes](docs/screenshots/repository/pending-changes.png), [generated description](docs/screenshots/repository/generated-description.png), [Explain in light mode](docs/screenshots/repository/explain-light.png), [Explain in dark mode](docs/screenshots/repository/explain-dark.png), and [AI settings](docs/screenshots/repository/ai-settings.png). After preparing the QA vault and opening Obsidian, `node tools/capture-repository-screenshots.mjs` regenerates this gallery; it uses two live AI requests and never creates a change. Pass `--history-only` to capture the three history/detail screens without AI requests.

## Previous validation: 0.4.0

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
