# Live Git Diff

**Review a note side by side against its git version — both fully rendered, scroll-synced, inside Obsidian.**

<!-- SCREENSHOT: replace this comment with the hero image once captured.
     Expected path: docs/screenshot-side-by-side.png
     See "Screenshots to capture" at the bottom of this file. -->

![Live Git Diff — the base version on the left, your real note on the right](docs/screenshot-side-by-side.png)

---

## Why this exists

No Obsidian plugin diffs **rendered** markdown. File Diff, Intervaults, and Diff Apply all diff **raw source** — you get `**bold**` and `| --- |` and pipe tables in a monospace gutter, which is not the document you wrote. Obsidian's reading view has no diff at all.

So reviewing a note against its last commit means leaving Obsidian for a tool that renders the diff — and leaving behind your annotations, your text-to-speech, and your links. This plugin closes that gap: the diff is rendered, it is side by side, it is scroll-synced, and the right-hand pane is your **actual note**, so everything that attaches to your notes keeps working.

> *Prior art checked 2026-07-15. If another plugin has since shipped rendered diffs, this section is out of date — please open an issue.*

## What it does

- **Side-by-side rendered diff.** Left = the git version, right = your real note. Both typeset by Obsidian, in your theme.
- **Compare against any version.** Pick from a list of the file's commits — by subject and age, not by sha. Spans as many commits as you like in one view, and follows renames.
- **Nothing is written to disk.** The base version is fetched into memory with `git show`. No temp file, no generated note, nothing in your vault.
- **Scroll-synced.** Scroll either pane; the other follows, anchored block-to-block.
- **Word-level marks.** Inside a changed block, the words that actually changed are highlighted — on both sides.
- **Your plugins keep working.** The right pane is an ordinary markdown leaf. This plugin only *adds CSS classes* to it — it never touches your text — so annotation plugins, TTS, and links behave exactly as they always do.
- **Read-only, and that's enforced.** Not a promise: a [build gate](#privacy-and-safety) fails the build if a write method reaches the bundle.

## Requirements

- **Obsidian 1.4.0+**, **desktop only.** The plugin runs `git` as a subprocess, which a mobile app cannot do.
- **`git` on your PATH.**
- **The note must live inside a git repository.** Your vault root does **not** have to be the git root — a vault nested inside a larger repo works fine, which is the common case for anyone keeping docs alongside code.
- The note must be **tracked** in git at the version you are comparing against.

## Installation

### Via BRAT (recommended while this is in beta)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins straight from a GitHub repo and keeps them updated.

1. Install **Obsidian42 - BRAT** from Community Plugins and enable it.
2. Open the command palette → **BRAT: Add a beta plugin for testing**.
3. Paste the repo URL:
   ```
   https://github.com/jkosturko/obsidian-live-git-diff
   ```
   <!-- PLACEHOLDER: replace with the real public repo URL before sharing. -->
4. Choose the latest version and click **Add Plugin**.
5. Enable **Live Git Diff** in **Settings → Community plugins**.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/jkosturko/obsidian-live-git-diff/releases). <!-- PLACEHOLDER: repo URL -->
2. Create the folder `<your-vault>/.obsidian/plugins/live-git-diff/`.
3. Put the three files in it.
4. Restart Obsidian (or toggle **Community plugins** off and on) and enable **Live Git Diff**.

> Building from source instead? See [CONTRIBUTING.md](CONTRIBUTING.md). `npm run build` emits those three files into `plugin-dist/`.

### Via Community plugins

**Not yet submitted.** This plugin is not in the community directory. Use BRAT or a manual install for now.

## Usage

Open a note that lives in a git repo, switch to **Reading view**, then run **Live Git Diff: Open review against a version…** from the command palette. Pick a version from the list; a second pane opens with it beside your note.

| Command | What it does |
| --- | --- |
| **Open review against a version…** | **The main one.** Lists this file's recent commits — subject, age, sha — and pins the one you pick as the base. |
| **Open git diff review for this file** | The quick path: pins whatever you set as the default base (HEAD unless you change it) without asking. |
| **Close review** | Ends the session, removes every decoration, and closes the base pane. |
| **Refresh review (re-pin the base version)** | Re-resolves the base and re-diffs. Use it after new commits land. |
| **Toggle scroll sync** | Turns the pane-following on and off. The base pane's header shows which. |
| **Copy alignment report to clipboard** | Copies a JSON diagnostic — how far the panes are out of alignment, in pixels, right now. For bug reports. |

### Choosing what to compare against

**This is the setting that decides whether the plugin is useful to you**, so it's worth 30 seconds.

The default compares your note against **HEAD** — which shows your **uncommitted** changes. That's the right answer if you edit, then review, then commit.

It is the *wrong* answer if your changes are **already committed** — which is the normal case when something commits frequently on your behalf (an AI agent checkpointing so that reverting stays cheap, say). Then your working tree is clean, HEAD already contains the changes, and the diff is **empty**. The plugin will tell you so rather than just showing you nothing.

For that workflow, use **Open review against a version…** and pick the commit from *before* the work started. One base, N commits of change, one view. The picker shows what you actually recognise:

```
apply review round 1
7 hours ago · Jul 15, 4:11 PM · 3c9d151

note the autumn planting rule
8 days ago · Jul 7, 2:10 PM · 9b1f2e4
```

Subject, sha, and both dates are all searchable. The list follows renames, so history doesn't stop at the point the file got its current name.

You can also set a different **default** in settings (HEAD, HEAD~1, this file's previous version, or any ref you like), for the quick command.

### What a "review session" is

Opening a review **pins a base commit** and holds it for the whole session.

That's deliberate, and it's the difference between a review that works and one that quietly evaporates. If the diff followed a live `HEAD`, every commit landing while you read would shrink it — and a review of a document something else is actively committing to would appear to *finish itself*. The base stays put until you explicitly re-pin it with **Refresh review**.

Sessions live in memory only. Close the review, or quit Obsidian, and it is gone — there is nothing to clean up.

The base pane's header always names the pinned version, because a sha on its own can't tell you what you're looking at:

```
base 3c9d151 · "apply review round 1" · 7 hours ago
```

### Reading the colors

| What you see | What it means |
| --- | --- |
| **Green wash** (right pane) | New text — this wasn't in the base version. |
| **Red wash** (left pane) | Removed text — this was in the base and isn't now. |
| **Darker green / red on words** | Exactly the words that changed inside a changed block. |
| **A changed block** | Green on the right, red on the left, with a rail beside both. The layout says "this became that" — so there is no third color for "modified". |
| **A gap on one side** | Reserved space where the other side has text. Both sides always show their real content at full size; nothing is collapsed or hidden. |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| **Compare against by default** | The latest commit (HEAD) | What the *quick* command pins. Options: `HEAD` (shows uncommitted changes), `HEAD~1`, **this file's previous version** (the commit before the last one that touched *this* document — regardless of what else was committed since), or a specific ref. The version picker overrides this per review. |
| **Ref** | `main` | Only shown for *A specific ref*. Anything git resolves: `main`, `origin/main`, `v1.2`, `HEAD~5`, a sha, `main@{yesterday}`. Resolved once when the review opens, then pinned. |
| **Versions to list** | 50 | How many commits the version picker shows. |
| **Inserted text** | GitHub green | Wash behind added blocks and the new side of a change. The changed words get a second coat of the same color. |
| **Deleted text** | GitHub red | Wash behind removed blocks and the old side of a change. |
| **Rail — added** | GitHub green | The 4px bar beside a wholly new block. |
| **Rail — removed** | GitHub red | The 4px bar beside a wholly removed block. |
| **Rail — changed** | GitHub amber | The 4px bar beside a changed block. |
| **Debug logging** | Off | Verbose console output. Warnings and errors are logged either way. |

Colors accept **any CSS color**, including alpha — `#6fdd8b80`, `rgb(0 0 0 / 20%)`, `color-mix(...)`. Alpha matters: these are washes that sit *behind* your text, and the defaults are translucent on purpose. Leave a field empty for the default.

The defaults are GitHub's diff palette and follow your light/dark theme automatically. **An override applies to both themes** — see [Known limitations](#known-limitations).

## How it works

Three ideas, in order of how much they matter:

1. **The base version never becomes a file.** `git show <sha>:<path>` is read into memory and rendered by Obsidian's own renderer into a custom read-only pane. There is no temp file and no generated note.
2. **Your note is your note.** The right pane is a normal markdown leaf showing the real file. The plugin adds CSS classes to already-rendered blocks — it never touches text nodes, never injects text, never writes. That's precisely why annotation plugins and TTS keep working: they anchor to the file, and the file is untouched.
3. **The panes are aligned by block, not by pixel.** Obsidian only keeps the blocks near your viewport in the DOM, so the heights of far-off blocks literally cannot be measured. Sync therefore anchors the topmost *visible* block to its counterpart, and reserves blank space ("view zones") wherever one side has text the other doesn't.

The full reasoning — including why each of the obvious approaches doesn't work — is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Known limitations

These are real, measured, and worth knowing before you rely on it.

- **Block grain, not line grain.** The diff pairs *blocks* (paragraphs, lists, tables, code fences), not lines. A block edited a little is shown as a modification with the changed words marked; a block rewritten past recognition is shown as a delete plus an add. **A list restructured into a paragraph reads as delete+add, not as a modification.** VS Code diffs lines and doesn't have this; we diff blocks because block pairing is what keeps the two rendered panes aligned and keeps annotation anchors intact.
- **Inserting a block next to an edited one can turn the edit into delete+add.** Within a rewritten region, blocks pair by position, so a newly inserted block shifts its neighbours' pairing.
- **~24px of residual drift in unpaired regions.** Measured on a 94-change diff: the anchor block is pixel-exact at 5 of 6 sample positions, median worst-case on-screen drift **24px**, max **48px**. Drift is bounded, not cumulative — it does not grow as you scroll.
- **Reading view only.** Obsidian's markdown post-processors don't run in Live Preview, so decorations appear in Reading view only. You can still edit in Live Preview; you just won't see the highlights while you do. (VS Code has the same limitation.)
- **The base pane opens on the right.** Obsidian places a new split *after* the active pane. Drag its tab across once to put it on the left; the workspace remembers.
- **Links and embeds don't resolve in the base pane.** The base is rendered with an empty source path, on purpose — that's what stops other plugins from painting your *current* note's annotations onto the *old* text, anchored to lines that no longer mean the same thing. The cost is that relative links in the old version aren't clickable.
- **Color overrides apply to both themes.** The built-in defaults are theme-aware; an override is a single value used in light and dark alike.
- **Desktop only.** Requires `git` as a subprocess.
- **Large notes are diffed on open, not incrementally.** Fine for a book chapter. A multi-megabyte note is untested.

## FAQ / Troubleshooting

**The diff is empty / nothing is highlighted.**
Almost always: your changes are already **committed**, and you're comparing against HEAD — which contains them. A clean working tree against HEAD is correctly an empty diff. Use **Open review against a version…** and pick a commit from before the work started. (See [Choosing what to compare against](#choosing-what-to-compare-against).)

**The base pane is empty, or says "not tracked in git".**
The file isn't tracked at that commit. The pane distinguishes two cases in words, because they need different reactions: *"this file did not exist at &lt;sha&gt;"* (you picked a commit from before it was created — it names the earliest commit that does have it) versus *"not tracked in git at all"* (it has never been committed). It always says which, rather than rendering blank — because "no base" and "the whole file is new" look identical otherwise.

**The file was renamed and I expected history to stop.**
It doesn't. The picker uses `git log --follow`, and the base pane reads the file under whatever name it had at the commit you picked. When that name differs from today's, the header says `was old-name.md`.

**Nothing happens when I run the command.**
Three usual causes: the note isn't inside a git repo; you're not in **Reading view** (decorations only exist there); or `git` isn't on the PATH that Obsidian sees. Turn on **Debug logging** in settings and check the developer console (`Ctrl/Cmd+Shift+I`).

**My annotations/comments disappeared!**
They didn't — this plugin cannot write to your notes, and it never modifies text. Close the review; if something still looks wrong, it isn't from this plugin. The read-only claim is [machine-enforced](#privacy-and-safety), and you can run the check yourself.

**The panes drift apart as I scroll.**
Some drift in inserted/deleted regions is expected (see above). If a *paired* block is badly out, run **Copy alignment report to clipboard** and paste it into an issue — `deltaPx` is exactly the number needed to diagnose it.

**The diff shrank while I was reading it.**
That's what pinning prevents, so this shouldn't happen — unless you ran **Refresh review**, which intentionally re-pins to the current version. If it happened on its own, please file an issue.

**Scroll sync feels steppy.**
The note pane is scrolled by source *line*, not by pixel (it has to be — see ARCHITECTURE). Whether Obsidian honours a fractional line is undocumented and version-dependent.

## Privacy and safety

**This plugin never writes to your notes, and never talks to the network.**

Its entire effect on your machine is: run `git` to *read* text, read your note, build DOM, add CSS classes. It imports no filesystem module at all. The only thing it persists is its own settings, in its own config file, which Obsidian deletes when you uninstall it.

That's a strong claim, so it's **checked mechanically on every build** rather than promised here:

```bash
cd plugin-src
npm ci
npm run build     # typecheck -> bundle -> gate
```

The gate ([`plugin-src/tools/check-invariant.mjs`](plugin-src/tools/check-invariant.mjs)) reads the shipped bundle and fails the build if it finds:

- **any write method** — `vault.modify(`, `vault.create(`, `vault.delete(`, `adapter.write(`, `editor.replace…(`, `writeFile…(`, and 30-odd more;
- **any filesystem import** — you cannot write a file with a module you never imported;
- **any `innerHTML` assignment**;
- **NUL bytes or invalid UTF-8** — because a check that can't read the file isn't a check. *(This one is not paranoia: an earlier hand-written build contained NUL bytes, which made `grep` treat it as binary and skip it. Every read-only check "passed" without reading a single line. That defect is why this gate reads the bytes itself.)*

Settings persistence is the one declared exception, and it is **pinned**: exactly one call site, in exactly one file. A second one anywhere fails the build.

And the gate itself is tested — [`plugin-src/test/invariant.test.ts`](plugin-src/test/invariant.test.ts) plants real violations in a copy of the bundle and asserts the gate goes red for each. A gate nobody has watched fail is not known to work. CI runs all of it on every push.

## Credits and prior art

- **[VS Code](https://github.com/microsoft/vscode)** — `markdown-language-features` is the closest prior art for decorating a *rendered* markdown view, and this plugin borrows its technique on purpose: rails that cost zero layout, the two-channel color scheme (background = "is this new?", rail = "where did it come from?"), one color painted twice to darken changed words, and **view zones** — reserving blank space on the short side rather than collapsing or hiding either side's content.
- **[GitHub's VS Code themes](https://github.com/primer/github-vscode-theme)** — the diff palette, taken verbatim from `light-default` / `dark-default`. GitHub's hues are nearly white, which is what lets a wash sit behind text without shouting; the intensity was never the alpha.
- **Obsidian's own reading view** — the base pane inherits `markdown-preview-view` / `markdown-preview-sizer` rather than re-deriving typography. Every hand-rolled lookalike drifted.
- The `metadataCache.getFileCache().sections` API, which settles block-grain questions by measurement instead of argument.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The one hard rule: **this plugin does not write to notes.** That isn't a style preference — it's the entire reason the design is safe to run on a document you care about, and the build enforces it.

## License

[MIT](LICENSE) © 2026 Jessica Kosturko

---

## Screenshots to capture

*(Delete this section once the images exist.)*

| File | What to capture |
| --- | --- |
| `docs/screenshot-side-by-side.png` | **The hero shot.** A review open on a real note: base pane left, note right, with a red-washed deleted block, a green-washed inserted block, and at least one changed block showing word-level marks on both sides. Wide enough that both panes are comfortably readable. Light theme. |
| `docs/screenshot-word-marks.png` | **Close-up** of a single changed block, both panes, showing the darker word-level marks inside the lighter block wash. This is the detail the hero shot is too zoomed-out to show. |
| `docs/screenshot-view-zones.png` | A **deleted run**: the base pane showing removed text, and the gap reserved opposite it in the note pane. Shows that nothing is collapsed. |
| `docs/screenshot-version-picker.png` | **The version picker** (`Open review against a version…`), open, showing several commits with subject / relative age / date / sha. This is the feature that makes the plugin work for a committed-changes workflow — worth showing high in the README. |
| `docs/screenshot-settings.png` | The **settings tab**, with the five color fields and their live swatches visible. |
| `docs/demo-scroll-sync.gif` | **10-15s**: scroll the note pane and watch the base pane follow, through at least one inserted and one deleted region. This is the feature that's impossible to convey in a still. Keep it under ~5MB. |
| `docs/screenshot-dark.png` | *(Optional)* The hero shot in dark theme, to show the palette adapts. |
