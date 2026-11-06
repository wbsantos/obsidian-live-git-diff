# Validation: 0.3.0

Validated on 2026-11-06 with Node 24.13.0, Git for Windows and Obsidian 1.15.0. Application checks used an isolated vault/profile with copies of the reported documents, the vault's appearance settings, active CSS snippets and ten enabled community plugins. Original notes and their repository were only read.

## Automated checks

`npm run ci` passed: TypeScript, worker build and capability audit, plugin bundle checks and all **169 tests**, with no skipped tests. The suite covers structural Markdown parsing, visual equivalence, link destinations, code indentation, task/list hierarchy, tables, Unicode, repeated content, bounded refinement, source preservation, worker cancellation and stale revisions.

History tests include out-of-order A→B and A→B→A requests, successful-cache timestamps, failed refreshes, cached display followed by refresh, pinned pagination, renames, accented/bracketed filenames, cancellation, max-two selection and closed panels. Tests also verify that each historical endpoint resolves its own reference links.

The read-only gate inspects the readable worker before embedding and the final bundle. Plugin editor dispatches contain presentation/scrolling effects only. Runtime dependencies are pinned to `markdown-it@15.0.3` and `diff@9.0.0`. `npm audit --omit=dev` reported **zero vulnerabilities**. The full development audit reported two moderate findings through the Obsidian SDK's Moment dependency; neither the SDK nor Moment is bundled by this plugin.

## Application and pixel verification

Independent expected row/item sets were authored before screen checks. Each reported document was compared with the commit immediately preceding its latest file commit. Its copied current content matched the committed index. The oracle was not inferred from the engine output.

| Check | Passing assertions |
| --- | ---: |
| Table engine → DOM → screenshot pixels, dark theme | 632 |
| Added/modified table rows, light theme | 127 |
| Header actions, history, lifecycle, editing and external changes | 32 |
| Native table cell editing, undo/redo, folds, resizing and widget recycling | 14 |
| Reported prose/list source lines, reading panes and screenshot pixels | 38 |

The table checks verify every changed cell and a negative control on every unchanged row. They compare screenshots with presentation enabled and temporarily suppressed, require visible pixels with the correct red/green change, and check preserved text and geometry. The added V15 row is green in Live Preview and reading; unchanged headers are not highlighted. Both historical panes have independently verified colors and reference links.

The prose checks verify all expected changed source lines, individual changed and unchanged list items on both reading sides, inline-code marks, and actual pixels on the screen. An unchanged neighboring line is a negative control for the native editor.

Interaction checks cover unsaved typing, immediate invalidation, native undo/redo, external file changes in reading mode, newer editor content winning over save notifications, closing either participant, tab replacement, unrelated tab focus, two historical versions, swapped sides, bidirectional scrolling, sidebar pagination and delayed Git results. Closing the history sidebar leaves an existing review open. Content width measured **700 px** with the plugin disabled, enabled without review, and after closing review.

Native cell testing exposed a nested-editor issue: cell editors inherit the note's identity but contain only the cell text. The final implementation excludes nested and embedded editors from document comparison input and gutter presentation. Cell typing still updates through Obsidian's main document editor.

## Performance

Single local measurements, not latency guarantees:

| Workload | Time | Heap growth |
| --- | ---: | ---: |
| One word changed in 2,500 words | 13.70 ms | 1.20 MiB |
| Parse and compare 882,000 characters / 2,840 blocks | 541.92 ms | 27.79 MiB |
| Same size, historical parse reused | 199.59 ms | 19.73 MiB |

The 882,000-character application test rendered all 2,840 historical blocks in **7.23 seconds**. A 16 ms UI heartbeat ran 381 times, with a maximum observed interval of 90 ms. First rendering remains more expensive than subsequent edits.

## Reproduction tools

Run the tools from `plugin-src` against an isolated Obsidian instance exposed on a local CDP port. Never point mutation/interaction tools at a working vault. Local manifests and captured private document contents are deliberately excluded from Git.

- `tools/prepare-visual-qa.mjs`: takes an explicit local configuration, reads originals and previous file versions, and creates copies in a separate QA repository. Configuration includes `vault`, `output`, `port` and `cases` with `file`, `original`, `ref: "previous-file-version"` and independently authored table expectations.
- `tools/load-qa.mjs`: verifies the connected vault against the generated manifest before replacing the QA plugin bundle.
- `tools/verify-visual.mjs`: checks table rows, cells, geometry and pixels. An optional `theme` property selects `light` or `dark` for the run.
- `tools/prepare-history-qa.mjs` and `tools/verify-experience.mjs`: prepare a synthetic commit history and exercise the actual sidebar, note actions and review lifecycle.
- `tools/verify-table-interaction.mjs`: opens an added row (label argument, default V15), edits through native input, checks pixels, undo/redo, folding, resizing and recycled widgets. Restores the QA copy afterward.
- `tools/verify-prose-visual.mjs`: uses the manifest's independent `prose` expectations for source lines and old/current list items, then checks actual rendered pixels.
- `tools/benchmark.mjs`: engine measurements; an optional path reads an actual large note without writing it. `LGD_BENCHMARK_OUT` selects the result file.
- `tools/verify-large.mjs`: measures responsiveness while rendering an isolated `large.md` fixture of approximately 882,000 characters.

The committed Obsidian section oracle also includes adjacent headings, list continuations, frontmatter and fenced code. Compatibility beyond Obsidian 1.15.0 was not established by these application checks. Public APIs drive Live Preview editing; guarded DOM mapping handles table presentation, and reading mode retains a defensive fallback for Obsidian's already-rendered sections. A mapping failure is reported instead of inventing row locations.
