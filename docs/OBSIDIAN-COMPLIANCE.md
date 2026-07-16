# Obsidian community plugin — compliance audit

> Audited against the official [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines), fetched 2026-07-15, plus the [submission requirements](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin).
>
> Every **PASS** below was verified by grep or by a test, not by reading the code and feeling good about it. Where a check is automated, the automation is named.

**Status: no known blockers for submission.** Three items are WONTFIX with reasons; one is a genuine open question for the author (see [Before submitting](#before-submitting)).

## General

| Guideline | Verdict | Evidence |
| --- | --- | --- |
| Avoid using global `app` instance | **PASS** | `grep -rE '(^\|[^.a-zA-Z])app\.(workspace\|vault\|metadataCache)' src/` → only `git.ts`, where `app` is a **function parameter** (`absPathOf(app: App, …)`), not the global. |
| Avoid unnecessary console logging | **FIXED** | All logging routes through `src/log.ts`. `debug()` is silent unless the user enables it; `warn`/`error` are always on **by design** — a plugin that hides its own failures behind a toggle produces a silent no-op that looks like a broken feature. One deliberate `console.log` remains (`main.ts`, clipboard-unavailable fallback): the user asked for the report, the clipboard failed, and the console is the only remaining way to deliver it. |
| Organize code base using folders | **PASS** | `src/` with `src/diff/`, `test/`, `tools/`. Ten modules, one responsibility each — see the module map in [ARCHITECTURE.md](ARCHITECTURE.md). |
| Rename placeholder class names | **PASS** | `LiveGitDiffPlugin`, `GitBaseView`, `LiveGitDiffSettingTab`. No `MyPlugin`/`SampleSettingTab` survives. |

## Mobile

| Guideline | Verdict | Evidence |
| --- | --- | --- |
| Node and Electron APIs | **PASS (N/A)** | `isDesktopOnly: true`. The plugin spawns `git` via `child_process`, which is exactly the case this flag exists for. |
| Lookbehind in regular expressions | **PASS** | `grep -rE '\(\?<[=!]' src/` → none. (One lookbehind exists in `test/bundle.test.ts`, which never ships and runs in node.) |

## UI text

| Guideline | Verdict | Evidence |
| --- | --- | --- |
| Only use headings under settings with more than one section | **PASS** | Three sections: *Base version*, *Colors*, *Advanced*. |
| Avoid "settings" in settings headings | **PASS** | No heading contains the word. |
| Use sentence case in UI | **PASS** | Every setting name and command name. Commands: "Open git diff review for this file", "Open review against a version…", "Close review", "Refresh review (re-pin the base version)", "Toggle scroll sync", "Copy alignment report to clipboard". |
| Use `setHeading` instead of `<h1>`/`<h2>` | **PASS** | `new Setting(containerEl).setName(…).setHeading()`. The one raw element is a `<p>` of descriptive text, not a heading. |
| *(Submission)* Command names must not repeat the plugin name | **FIXED** | The spike prefixed every command `Spike2b: …`. Obsidian prefixes automatically, so that yielded `Live Git Diff: Spike2b: …`. All prefixes removed. |

## Security

| Guideline | Verdict | Evidence |
| --- | --- | --- |
| Avoid `innerHTML`, `outerHTML`, `insertAdjacentHTML` | **PASS — automated** | All DOM via `createDiv`/`createSpan`/`setText`. Enforced on the **built bundle** by `tools/check-invariant.mjs`, which fails the build on a match; `test/invariant.test.ts` plants an `innerHTML` assignment and asserts the gate catches it. |

## Resource management

| Guideline | Verdict | Evidence |
| --- | --- | --- |
| Clean up resources when plugin unloads | **PASS** | `registerEvent` for all workspace events; `registerView` for the view; `this.register(…)` hooks dispose the sync + zone layers. `onunload` also removes every decoration (zone padding, word-mark spans) and clears color overrides, because reading-view sections are recycled rather than rebuilt — leaving them would strand phantom gaps in the user's note with no review open to explain them. |
| **Don't detach leaves in `onunload`** | **FIXED** | The spike called `detachLeavesOfType(VIEW_TYPE)` in `onunload`. Removed. `onunload` runs on every plugin **update and reload**, and detaching destroys the user's layout — the pane never comes back. Obsidian handles an orphaned leaf itself. `closeReview()` still detaches, because there the user asked for it. **Note: this reverses the original spec, which asked for detaching in `onunload`; the official guideline wins.** |
| Manual DOM listeners instead of `registerDomEvent` | **WONTFIX — justified** | The two scroll listeners are attached manually and tracked in `ScrollSync.domListeners`. `registerDomEvent` cannot unregister an individual listener — it only cleans up at unload — but these listeners must **move between elements mid-session**, because both panes are re-created on every re-render. Using it would leak a listener onto a dead element on every re-attach. `ScrollSync.detach()` owns the bookkeeping and `this.register(() => this.sync.dispose())` guarantees teardown at unload, which is the outcome the guideline is protecting. Justified in-code at the call site. |

## Commands

| Guideline | Verdict | Evidence |
| --- | --- | --- |
| Avoid setting a default hotkey | **PASS** | `grep -rn 'hotkeys' src/` → none. |
| Use the appropriate callback type | **FIXED** | All six commands moved from `callback` to `checkCallback`. Obsidian now **hides** a command that cannot run rather than offering it and answering with a Notice. "Close review" doesn't appear when there's no review; the review commands don't appear unless a markdown file is active. |
| Command names are sentence case, unprefixed | **PASS** | "Open review against a version…", "Open git diff review for this file", "Close review", "Refresh review (re-pin the base version)", "Toggle scroll sync", "Copy alignment report to clipboard". |
| *(UI text)* Timestamps shown to the user | **PASS** | The version picker and base-pane header render commit times as AM/PM **local** — `Jul 7, 2:10 PM` — never 24-hour or ISO. Verified: `%-d`/`%-I` strip leading zeros, `%-I` is 12 at both midnight and noon, no timezone conversion is applied (git already emits local time). Pinned by `test/git.test.ts`. The alignment report is machine-readable JSON and keeps an ISO timestamp. |

## Workspace

| Guideline | Verdict | Evidence |
| --- | --- | --- |
| Avoid accessing `workspace.activeLeaf` directly | **PASS** | Never referenced. Uses `getActiveFile()` and `getLeavesOfType()`. |
| Avoid managing references to custom views | **PASS** | `baseView()` looks the view up through `getLeavesOfType(VIEW_TYPE)` on **every call** and returns `null` when absent; no view instance is ever stored in a field. Elements are additionally guarded with `isConnected` before use, since the base pane is re-created on every render. |

## Vault

| Guideline | Verdict | Evidence |
| --- | --- | --- |
| Prefer Editor API over `Vault.modify` for the active file | **PASS (N/A)** | Writes nothing. |
| Prefer `Vault.process` over `Vault.modify` | **PASS (N/A)** | Writes nothing. |
| Prefer `FileManager.processFrontMatter` | **PASS (N/A)** | Writes nothing. |
| **Prefer the Vault API over the Adapter API** | **WONTFIX — justified** | `git.ts` calls `app.vault.adapter.getFullPath(file.path)`. This is the guideline's genuine exception: the plugin must hand `git` an **absolute filesystem path**, and the Vault API deliberately does not expose one (it abstracts over storage). `getFullPath` is pure string arithmetic — no I/O — and it is the only adapter member touched. Falls back to `adapter.basePath` + `path.join`, and throws a readable error if neither exists. The read-only gate deliberately does **not** grep for this handle: an earlier draft grepped for `vault.adapter` and the code dodged it by destructuring — a check you pass by rephrasing is not a check. The gate matches **write methods** instead, and additionally asserts no filesystem module is imported at all. |
| Avoid iterating all files to find a file by path | **PASS** | Uses `getActiveFile()`. `notePane()` iterates markdown **leaves** (not files) to find the one showing the session's file — that is the intended way to locate a view. |
| Use `normalizePath()` for user-defined paths | **PASS (N/A)** | Takes no user-defined vault path. The one user-supplied string is a git **ref**. It is passed to `git` as a single **argv element** to a process spawned without a shell, so it cannot be a shell injection — no shell ever parses it. That leaves the argument-parsing gap, which is separate and real: a ref beginning with `-` could be read by git as an **option**. `rev-parse` is therefore invoked with `--end-of-options`, after which git treats what follows as a ref and nothing else. |

## Editor

| Guideline | Verdict | Evidence |
| --- | --- | --- |
| Change or reconfigure editor extensions | **PASS (N/A)** | Registers no CodeMirror extension. Decoration is a markdown post-processor (reading view). |

## Styling

| Guideline | Verdict | Evidence |
| --- | --- | --- |
| No hardcoded styling | **WONTFIX — justified, 3 narrow cases** | All presentation lives in `styles.css` behind `lgd-` classes, and a test asserts code and CSS agree in **both directions** (`test/bundle.test.ts`, "every class the code uses is defined in styles.css, and vice versa"). Three inline styles remain, each a value **measured at runtime** that no class could express: **(1)** the view zone's `height`, harvested from a specific note block; **(2)** the deletion zone's `padding-bottom`/`padding-top`, summed from a specific run of base blocks; **(3)** the settings swatch's `background`, which *is* the user's color. Each is commented as such at its site. User color overrides are applied as **CSS custom properties** on `<body>`, not as per-element styles — one write, one place to clear. |

## TypeScript

| Guideline | Verdict | Evidence |
| --- | --- | --- |
| Prefer `const`/`let` over `var` | **PASS** | `grep -rE '\bvar\s+[a-zA-Z_]' src/` → none. (The spike's `mddiff.js` was ES5-style `var` throughout; the port converted it.) |
| Prefer async/await over Promise chains | **PASS** | No `.then(` in `src/`. |
| No `any` where a real type exists | **PASS** | `grep -rE ':\s*any\b\|<any>\|as any' src/` → none. Narrowing goes through `unknown` + explicit casts at the two genuine boundaries (Obsidian internals not in `obsidian.d.ts`, and `execFileSync` error objects). `tsc --strict` passes clean. |

## Manifest

| Field | Value | Verdict |
| --- | --- | --- |
| `id` | `live-git-diff` | **PASS** — lowercase-kebab, does not contain "obsidian". Asserted in `test/bundle.test.ts`. |
| `name` | `Live Git Diff` | **PASS** — does not contain "Obsidian". |
| `version` | `0.1.0` | **PASS** — semver; a test asserts it matches `package.json`. |
| `minAppVersion` | `1.4.0` | **PASS** — a test asserts `versions.json` maps it. |
| `description` | "Review a note side by side against its git version, both fully rendered and scroll-synced. Never writes to your notes." | **PASS** — sentence case, ends with a period, says what it does, 119 chars. |
| `author` / `authorUrl` | set | **PASS** |
| `isDesktopOnly` | `true` | **PASS** — required; the plugin spawns `git`. |
| `versions.json` | `{"0.1.0": "1.4.0"}` | **PASS** — required for compatibility mapping. |

## Before submitting

Four things were **not** code issues and had to be settled by the author. Three are now resolved; the resolutions are recorded rather than the items deleted, so a reader can see what was decided and why.

1. ~~**The repo URL is a placeholder.**~~ **RESOLVED.** Every URL now points at `github.com/jkosturko/obsidian-live-git-diff`. The placeholder was worse than a placeholder: it named an account that does not exist, so every published link 404'd. `authorUrl` in both manifests now names the **author's page** (`github.com/jkosturko`) rather than the plugin repo — the `obsidian-releases` submission validator rejects an `authorUrl` pointing at the plugin's own repository. Fixed in `package.json` (`repository`/`bugs`/`homepage`), `plugin-src/manifest.json`, `plugin-dist/manifest.json`, the README's install links, and the CHANGELOG's compare links.
2. ~~**BRAT and the community directory require `manifest.json` at the REPOSITORY ROOT.**~~ **RESOLVED.** `manifest.json` and `versions.json` now exist at the repo root as exact copies of the `plugin-src/` originals, so BRAT can resolve a version before downloading release assets. Copies rather than a move: `plugin-src/` is where the build reads its manifest from, and relocating the plugin to fix a discovery problem would have forked the toolchain. **The cost is drift** — the two must be updated together on release; CONTRIBUTING carries it as a checklist item, and `test/bundle.test.ts` already fails if the manifest and `package.json` disagree on version.
3. ~~**The repo also contains the original spike.**~~ **RESOLVED.** `plugin/`, `spikes/`, and `tools/` were moved to the **`archive/spike` branch** and removed from `main`. The provenance is preserved in history and reachable on that branch; what `main` no longer does is show a stranger a second, older `manifest.json` (`id: spike2b-gitdiff`) that confuses BRAT and reviewers alike. `SPIKE-RESULTS.md` deliberately stays on `main`: it is the measured record the plugin's design rests on, it is not a manifest, and nothing about it is ambiguous to a tool.
4. ~~**Screenshots do not exist yet.**~~ **RESOLVED.** Six stills and the scroll-sync GIF were captured from a live Obsidian 1.12.7 (staged demo vault, scripted git history, real review session) and live in `docs/`; the README hero, version-picker, and scroll-sync embeds point at them. The shot list stays in `private/screenshot-shotlist.md` for re-captures after visual changes.

## What is enforced automatically

Guidelines rot when they live only in a document, so the load-bearing ones are tests:

| Check | Where |
| --- | --- |
| No write method in the shipped bundle (37 patterns) | `tools/check-invariant.mjs` — build + CI |
| No filesystem module imported at all (capability check) | `tools/check-invariant.mjs` |
| No `innerHTML`/`outerHTML`/`insertAdjacentHTML` | `tools/check-invariant.mjs` |
| Bundle is valid UTF-8 with zero NUL bytes | `tools/check-invariant.mjs` |
| Persistence pinned to one call site in one file | `tools/check-invariant.mjs` |
| **The gate actually fails on each violation class** | `test/invariant.test.ts` (plants real violations) |
| Manifest shape, id rules, description, version agreement | `test/bundle.test.ts` |
| `versions.json` maps the current version | `test/bundle.test.ts` |
| The bundle loads and exports a Plugin subclass | `test/bundle.test.ts` |
| Every CSS class used in code exists, and vice versa | `test/bundle.test.ts` |
