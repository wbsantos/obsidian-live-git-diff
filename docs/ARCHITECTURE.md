# Architecture

> Why this plugin is built the way it is. Written for whoever touches it next — including future me.
>
> Everything here is **measured**, not argued. Where a number appears, it came from a real run against a real 767-line document, and the method is stated so you can re-run it. Where something is a guess, it says so.

---

## The problem in one paragraph

Reviewing a note against its last commit means seeing both versions, rendered, side by side, scroll-synced — without leaving the app that holds your annotations and your text-to-speech. VS Code renders the diff but has none of your notes infrastructure. Obsidian has the infrastructure but cannot render a diff. Every existing Obsidian diff plugin diffs **raw source**, which is not the document you wrote.

## The shape, and the one insight that makes it possible

```
┌─────────────────────────┬─────────────────────────┐
│  BASE PANE (ours)       │  NOTE PANE (Obsidian's) │
│  custom ItemView        │  a REAL markdown leaf   │
│  `git show sha:path`    │  your actual file       │
│  rendered from memory   │  reading view           │
│  we own this DOM        │  we may only add classes│
└─────────────────────────┴─────────────────────────┘
         scroll sync: anchor topmost VISIBLE block
```

**The insight: the two panes do not need to be symmetric, because comments are only ever needed on the *current* side.** Nobody annotates the old version. That asymmetry is what unlocks everything:

- The **right** pane must be a real markdown leaf, or annotation plugins and TTS detach — they key off a real `sourcePath`. So we may only *decorate* it.
- The **left** pane is never annotated, therefore it needs no `getSectionInfo()`, no real file, and no plugin compatibility at all. So it can be a custom view rendering text that exists only in memory.

Every previous attempt at this failed by trying to make the two panes the same kind of thing. A custom two-pane view means neither side is a real file (annotations detach). A generated side-by-side note means a generated document (and, at ~290KB of HTML-in-markdown, it pinned Obsidian's renderer at 100% CPU and froze the app).

## Fact 1 — the reading view virtualises, and that is not negotiable

**Obsidian only keeps the blocks near your viewport in the DOM.** Off-screen sections are `.detach()`ed and their `getBoundingClientRect()` reads as zeros. Confirmed live: **45 of 271 blocks rendered** at any moment on an 83KB note.

Worse, `sizerEl.setChildrenInPlace()` runs **every scroll tick** — so any element you inject into the note pane is *ripped straight back out*.

Three consequences that shape the whole design:

1. **"Measure both panes, pad to equal heights, mirror `scrollTop`" is structurally impossible**, not merely difficult. The heights you would need are the heights of elements that do not exist.
2. **You cannot inject anything into the note pane.** But you *can* restyle an element it already owns — growing an existing block reserves space just as well as inserting a new one. That is why deletion view zones are `padding-bottom` on the preceding block rather than a spacer element.
3. **The post-processor is the only moment you hold a note block.** It fires as a section renders, and the reading view will later throw that element away. Anything you need to know about a block (its height, its row) must be harvested *then*, and remembered.

> **Padding, not margin — load-bearing.** Padding is inside the border box, so the rect Obsidian's own `measureSection()` reads already includes it and its virtual-display math stays true. A margin lives *outside* the box: the reading view would measure each block at its unpadded height, disagree with real layout by the sum of every zone above it, and mis-place sections — trading our drift for its drift.

## Fact 2 — line-space is the currency, never pixels

This is what Obsidian itself uses for editor↔preview sync, for exactly the same reason: pixels for unrendered content don't exist.

API provenance, since none of this is well documented:

| API | Status | Behaviour |
| --- | --- | --- |
| `view.currentMode.applyScroll(n)` | Declared in `obsidian.d.ts` (on `MarkdownSubView`), undocumented | Scrolls without side effects — tried first. **Silently no-ops when sections are unmeasured.** Whether it honours a *fractional* line is unspecified; if sync looks steppy, suspect this. |
| `view.previewMode.applyScroll(n)` | Same | Same. |
| `view.setEphemeralState({line})` | Fully public, retry-safe | Works, but **centres** the line and may flash a highlight — fallback only. |
| `view.previewMode.getScroll()` | Typed as returning a number | **Can return `null`.** Its typing lies. |

All of it is feature-detected and wrapped. A broken internal must degrade to "sync stops working", never "the plugin throws on every scroll frame".

## Fact 3 — the block grain must match Obsidian's sectioning

**The bug:** our splitter grouped "runs of non-blank lines". Obsidian sections a *list* separately from a paragraph that immediately precedes it with no blank line. So a paragraph-then-list became **one** block for us and **two** sections for Obsidian.

That is not cosmetic. A merged base block is one element where the note has two → the pair measures differently → **every block below it drifts**.

**The oracle:** `metadataCache.getFileCache(file).sections` is the same sectioning the renderer uses. Asking it settles grain questions by measurement instead of argument.

```
Obsidian: 308 sections     ours: 270 blocks     gap: 38
```

All 38 were exactly that pattern. **One rule** (break paragraph→list) took the merge count to 0 and mid-document drift to **0px**.

Measured before/after, same document, same positions:

| Position | Before | After |
| --- | --- | --- |
| 3% | 24px | 24px |
| 15% | 40px | **0px** |
| 40% | 40px | **0px** |
| 65% | 40px | **0px** |
| 90% | 48px | 46px |

The residual at 3% / 90% is the *unpaired* regions — which is what view zones exist for (Fact 4).

> This is why `test/grain-oracle.test.ts` exists, and why it compares against a **captured snapshot of Obsidian's real output** rather than a reimplementation. A reimplementation would only prove our splitter agrees with our own second guess. That is a fake oracle, and it is worse than no oracle because it reports green. Capture it with `npm run capture-oracle` — see `tools/capture-sections.mjs`.

## Fact 4 — view zones, and why each side needs a different technique

Once paired blocks measure identically, **all** remaining drift comes from **unpaired runs**: an insertion makes the note taller by its own height, a deletion makes the base taller by its own height, and the next anchor lands off by exactly that much.

VS Code's answer is a **view zone**: blank reserved space on whichever side is short, both sides' real content always shown at full size. It does *not* collapse deletions. Neither do we.

We own one pane and merely decorate the other, so:

| Direction | Technique | Heights |
| --- | --- | --- |
| **`ins`** (note has it, base doesn't) | `.lgd-spacer`, a real empty element in the **base** pane — we own that DOM | **Lazy.** The note-side block may not be rendered. Harvested opportunistically and cached; unknown ⇒ 0px ⇒ exactly the behaviour we'd have without it. |
| **`del`** (base has it, note doesn't) | `padding-bottom` on the note block **preceding** the run — we can only restyle what exists | **Exact.** The base pane is ours and un-virtualised; every block is rendered, so a run's height is a plain sum of rects. |

Measured on a real 312-block diff — **94 changed** (43 mod / 26 ins / 25 del) across 17 insertion runs and 17 deletion runs:

| Position | Before zones | After zones |
| --- | --- | --- |
| 5% | 98px | **16px** |
| 20% | 46px | 40px |
| 35% | **340px** | **24px** |
| 50% | 126px | **24px** |
| 65% | 0px | 48px |
| 80% | **235px** | **24px** |
| **median worst** | **126px** | **24px** |
| **max worst** | **340px** | **48px** |

All 26 insertion zones harvested a height (26/26) despite the note pane being virtualised.

### The spacer is an ANCHOR, not just spacing

This is the part that killed the 340px, and it is easy to miss.

A spacer sits at exactly the position its row's content occupies **in reading order**. So `baseElFor(idx)` resolves to `blockEls ?? spacerEls` — meaning **every** note row now has a base-side counterpart. Before, a topmost-visible `ins` row resolved to *nothing*, and sync fell through to interpolation.

The interpolation wasn't misbehaving. It was being asked a question it can only estimate.

Note that the **zero-height case is still correct**, not merely tolerable: a spacer whose height hasn't been harvested yet is 0px tall but is still in the right *place*, so the anchor lands exactly; only the blocks below it stay off until the height is known. Strictly better than interpolating, at every stage of the harvest.

### Convergence

The two zone directions are mutually dependent — insertion heights are measured from note blocks carrying deletion padding, deletion heights from base blocks positioned by insertion zones. The refresh order breaks the cycle rather than chasing it:

1. measure `ins` heights, **subtracting** any deletion padding already on the block;
2. push those heights into the base pane's spacers;
3. re-sum the `del` runs from the base pane, which has now settled;
4. write that back to the note pane's padding.

Each step reads a quantity the later steps can't perturb. **Verified:** hammering one scroll position 8× holds at 2616px of insertion zones and 120px of deletion padding — converges in one pass, no growth. Skipping step 1's subtraction makes the two mechanisms feed each other and the error grows per pass.

## Fact 5 — the `textContent` invariant

Annotation plugins (side-comments and friends) store **source-text offsets** and resolve them by walking text nodes with `TreeWalker(SHOW_TEXT)`, accumulating lengths. This walk is **invariant under splitting and wrapping** — because `textContent`'s concatenation order is what it reads, and re-parenting a character doesn't change that order.

So the rule for the word-level mark layer is exact:

> **`el.textContent` must be byte-identical before and after wrapping.** Characters may be re-parented; not one may be added, removed, or reordered.

Adding so much as a `+` marker silently moves every anchor after it — a failure that surfaces days later as *"my comments moved"*. So `wrapRanges` **asserts** it and self-reverts rather than trusting the reasoning. `charMarks.reverts` in the alignment report must be 0.

Corollaries that look odd on purpose:

- **Never render "before" text inside an annotated block.** Duplicate occurrences shift the ordinal math. This is why the two-pane design is a *correctness* requirement, not a preference. (VS Code's own answer: deleted text as an absolutely-positioned, `display:none`-until-hover sibling — outside the block.)
- **No `id` attributes on our spans.** `extractContents()` can *clone* an ancestor when a comment mark partially crosses one of our spans, and a duplicated id would be genuine corruption. Classes and data-attrs clone harmlessly.
- **Diff the rendered `textContent`, not the markdown.** Both blocks are rendered and in hand, which sidesteps source→rendered offset mapping entirely: `**bold**` in source is `bold` on screen, and every offset derived from source would be wrong by the width of the syntax.
- **Skipped nodes still count toward offsets.** Code and math are skipped for *wrapping* but their text is still in `textContent`. Getting that backwards shifts every later range.

Empirically (spike 1): 3 comments, all byte-exact — including one inside an injected span on a decorated block with **13 duplicate occurrences** of the anchor text in the file (it picked the right one), and one crossing a span boundary.

Measured on the 94-change diff: 43/43 changed rows marked, 225 spans, **0 suppressed**, **`reverts: 0`**, **`maxBaseHeightDeltaPx: 0`** — inline spans changed no block heights, so the view zones stay in sync. Probed at runtime rather than assumed, because "inline spans don't affect layout" is a premise the zones are built on.

## Fact 6 — geometry must match, or drift is guaranteed

An override of `max-width:100%` made the base pane wrap at **795px** while the note wrapped at **700px** (`--file-line-width`). Different wrap points → different line counts → different block heights → **everything below the anchor drifted, while the anchor itself was pixel-exact** (`deltaPx: 0`).

That's the signature of this bug class, and it's a confusing one: the diagnostic says perfect and the screen says wrong.

Hence: the base pane inherits Obsidian's own `markdown-preview-view` / `markdown-rendered` / `markdown-preview-sizer` classes and mirrors the real DOM structure, rather than re-deriving typography. **Every hand-rolled lookalike drifted.**

Related: the rail is an absolutely-positioned `::before`, not `border-left` + `padding-left`. It costs **zero layout**, so a decorated block has exactly the same geometry as an undecorated one — and a pseudo-element is not a text node, so it can't perturb the offset walk either.

## Fact 7 — the base sha must be pinned, and it must be CHOOSABLE

`HEAD` moves while you review — this plugin was built for reviewing a document something *else* is still committing to. Diffing against a live `HEAD` makes the diff silently shrink toward zero as commits land, and the review appears to **finish itself**. So the sha is captured once per session; re-pinning is an explicit command.

But pinning to **HEAD** encodes a second, unstated assumption: *that the changes under review are sitting uncommitted in the working tree.* That assumption is false for the workflow this plugin exists to serve. When an agent commits constantly — deliberately, as checkpoints, so that reverting stays cheap — the changes are **already committed** by the time anyone reads them, usually spread across several commits. The working tree is clean. `HEAD` already contains everything. The diff is **empty**, and an empty diff looks exactly like a broken plugin.

The fix is small, because the sha was always a variable: **make the base ref selectable.**

```
base pane  = git show <chosen-ref>:<path-at-that-ref>   ← this moves
note pane  = the real file on disk                       ← this does NOT
```

### Why NOT refA..refB

The tempting generalisation — diff any two commits against each other — **destroys the design**, and it is worth being explicit about why, because it will be proposed again.

It makes the **note pane synthetic**. And the note pane being a real file in a real markdown leaf is not an implementation detail; it is the entire reason this plugin exists rather than "just use VS Code". Annotation plugins and TTS attach via a real `sourcePath`. A synthetic right-hand pane detaches every one of them, and what remains is a worse VS Code embedded in Obsidian.

So: **one side is chosen, the other is always what is on disk.** That constraint is not a limitation of the current implementation — it is the load-bearing wall. `test/session.test.ts` asserts it directly: three different bases, byte-identical note side.

### Renames

A commit from before a rename does not know the file by its current name, and `git show <old-sha>:<current-path>` fails there. Rendered as an empty base pane, that reads as *"the whole file is new"* — the wrong-but-plausible failure again.

`git log --follow --name-only` solves both halves at once, and this was verified against a repo with a real rename rather than assumed: the same call that lists the commits for the picker **also reports the file's path as of each one**. So rename resolution costs no extra git invocation — look the chosen sha up in the history and read the base under the name it had then.

The two legitimate failures are told apart **in words**, because they want different reactions:

| Situation | What the pane says |
| --- | --- |
| Picked a commit from before the file existed | *"This file did not exist at abc1234"* — and names the earliest commit that does have it |
| The file has never been committed | *"Not tracked in git at all"* — commit it first |

### A note on formats

Two small things, both verified rather than assumed:

- **Times a human reads are AM/PM local** — `Jul 7, 2:10 PM` — via `--date=format:%b %-d, %-I:%M %p`. The `-` flags strip leading zeros, and `%-I` is 12 at both midnight and noon (checked). No timezone conversion and no `%Z`: git already emits local time, so converting would be the bug, and `%Z` renders empty here. ISO is for machines; the alignment report keeps one, nothing a person reads does.
- **Fields are separated by ASCII US (0x1f), records by RS (0x1e)** — not tabs and newlines, because a commit subject can contain a tab and `--name-only` appends its own lines. And **not NUL**, which is git's own convention (`-z`) and the obvious choice: **node refuses to spawn a process with a NUL in any argv element.** It works when you type it into a shell, which is exactly how it survived a manual probe and then failed on the first real call from the plugin.

Related, and just as sharp: **the vault root is not necessarily the git root.** Resolve it with `git rev-parse --show-toplevel` and make the path relative to *that*. Get it wrong and `git show` fails, the base pane renders empty, and empty reads as *"the whole file is new"* — wrong, but plausible. That is the failure class this codebase works hardest against, and it is why the base pane renders errors loudly instead of rendering nothing.

## Fact 8 — the guard must be time-based

Obsidian's own one-shot boolean guard swallows the next real scroll when a programmatic scroll emits zero events. And a flag cleared on the next tick still lets the echo through, because the browser dispatches `scroll` asynchronously — starting note → base → note judder.

So the guard is a **time-based owner token**: held for 120ms after a programmatic move, and every nested call pushes the window out. Cost: a genuine user scroll started within 120ms of a programmatic one is ignored. Invisible in practice, and strictly better than an oscillation.

Related: align **on-screen positions** of the paired blocks, not scroller-relative offsets. Each pane's scroller starts at a different screen Y (the base pane has a header). Aligning each block to "top of its own scroller" lands them at different heights on screen — a constant error equal to the header. Measuring the header and subtracting it breaks the moment it wraps to two lines or a theme changes its padding. Aligning actual on-screen positions absorbs whatever chrome exists, automatically.

## The interpolation trade-off

An `ins` row has no base-side block. Two honest options:

- **(a) clamp** — hold the base pane at the enclosing anchor for the whole run;
- **(b) interpolate** — glide from the previous anchor's bottom to the next anchor's top, proportional to progress through the run.

**We chose (b)**, for the case that matters: a rewritten section (3 blocks deleted, 4 inserted). There, the note's 4-block insertion run and the base's 3-block deletion run sit *between the same pair of anchors* — so interpolation glides the base pane through the deleted text while you read the inserted text. It shows you the counterpart content, which is the entire question a diff review is asking. Clamping would freeze the base pane on an unrelated paragraph for four screens and then jump.

For a **pure** insertion the two anchors are adjacent in the base pane, so there's ~0px to interpolate and (b) degenerates to (a) — which is correct there anyway.

The cost: progress is measured in **block count, not pixels**. A run of one short and one very tall block advances the base pane evenly rather than proportionally. Pixel-accurate progress would need the heights of every block in the run — and those are exactly the blocks the reading view may not have rendered. **Block-count is the measurement that survives virtualisation.**

## The color scheme is VS Code's, and it has no third state

Verified by grepping VS Code's own `markdown-language-features/media/markdown.css`: **it uses no yellow anywhere.** `.code-line-diff-modified` exists, but only ever lands *combined with* `-added` — it never carries a color of its own. The whole design is in one rule:

```css
.code-line-diff-modified.code-line-diff-added { box-shadow: none }
```

A modified line **is** the *added* (green) wash; the `modified` class merely drops the rail so the dashed indicator can show instead. One channel, two states:

- **background** answers *"is this the new text?"* → green = new, red = old
- **rail** repeats that same answer in the margin (GitHub's `editorGutter.{added,deleted}Background`), so a page can be *scanned* for changes without reading it. It is **not** a second channel: a rail disagreeing with the wash it borders would claim a state the diff doesn't have.

An earlier draft washed modified blocks **amber on both sides**; a later one kept an amber *rail* after that wash was deleted. Both collided with annotation plugins' own yellow highlight, so yellow meant two things on screen at once. Deleting the state fixed the collision for free: **yellow now means only "annotated"**. Side-by-side needs no third state anyway — the layout already says "this became that".

Be precise about *why* the amber was wrong, because the obvious explanation is not the true one. `#d4a72c66` **is** `editorGutter.modifiedBackground` in GitHub Light Default — copied faithfully. The value was never the error; the **source** was. `editorGutter.*` is the SCM dirty-diff gutter of a *normal editor*, answering "what have I not committed?" — a different question on a different surface. `markdown.css` never reaches for it, and a diff has no use for it.

**Where we part company with VS Code:** its markdown diff is **single-pane**, so removed text is nowhere on screen and needs a stand-in — hence killing the rail on a modified block and marking the deletion with a 2px dashed red bar after it (`.diff-change-indicator-modification`). We are two-pane: the old text is in the pane to the left. That marker solves a problem we don't have, so `mod` keeps its rail, colored by the side it sits on.

**Why literal values, not Obsidian's theme vars:** an early version used `var(--color-green)` / `var(--color-red)` at 0.10 alpha and it read as *harsh* — even though 0.10 is **lighter** than GitHub's 0.30. The intensity was never the alpha; it was the **hue**. Obsidian's `--color-red` is `rgb(233,49,71)`, an alarm red. GitHub picked hues that are already nearly white and can therefore sit at higher alpha while staying quiet behind text. They tuned the hue, not the opacity. (The values are now CSS custom properties so settings can override them — but the *defaults* are GitHub's, and that's why.)

## Module map

| Module | Responsibility | Testable in node? |
| --- | --- | --- |
| `diff/mddiff.ts` | Block splitter, LCS pairer, similarity gate | ✅ pure, no DOM |
| `charmarks.ts` | Word-range math (pure) + the stateful mark layer (DOM) | ✅ the pure half |
| `git.ts` | The entire outside world: `show` / `rev-parse` / `log`. Read-only | ✅ against real temp repos |
| `refPicker.ts` | The version picker (`SuggestModal`) | — |
| `session.ts` | The in-memory session; per-pane anchor index | ✅ pure |
| `baseView.ts` | The read-only base pane `ItemView` | — |
| `viewzones.ts` | Insertion spacers + deletion padding, and their convergence | — |
| `sync.ts` | Anchor resolution, the two sync directions, the scroll lock | — |
| `settings.ts` | Settings tab; **the only persistence call site in the codebase** | — |
| `dom.ts` / `panes.ts` / `log.ts` | Geometry helpers; shared pane contracts; the debug-gated logger | — |

`panes.ts` holds the structural interfaces (`PaneHost`, `BasePaneLike`) purely so the zone/sync/view modules can be separate files without importing the plugin class in a cycle.

## Why the read-only gate is shaped the way it is

Two defects, both real, both from the spike:

1. **NUL bytes made `grep` treat the bundle as binary**, so every invariant check "passed" *without reading a line*. A read-only grep that cannot read the file is theatre. The gate now reads the bytes itself and asserts UTF-8 + zero NULs **before** applying any pattern.
2. **A check you pass by phrasing is not a check.** An earlier draft grepped for the filesystem *handle*; the code dodged it by destructuring the handle into a local. Green, unchanged. So the patterns match **write methods** — the thing that actually mutates — never a handle. Holding a reference to the vault isn't dangerous; calling `modify` on it is.

Layered on top: the gate asserts the bundle **imports no filesystem module at all**. That's a *capability* check, and unlike a name grep it can't be dodged by rephrasing — you cannot write a file with a module you never imported.

And the patterns match `name(` — the **call**, not the mention — so a comment explaining the invariant doesn't fail the build for describing it. That's not a loophole; it's the difference between a gate that gets documented and one that gets silently deleted. (The gate's very first run failed on its own authors' comments. `test/invariant.test.ts` now pins the convention.)

## What the alignment report is for

**Copy alignment report to clipboard** dumps live JSON so alignment can be checked with a number instead of an opinion.

`deltaPx` is the money field: for the note pane's topmost visible block, how far its counterpart sits from where it should be. 0 = the two blocks sit at the same depth in both viewports.

One subtlety worth preserving: the report resolves the counterpart with **the same resolver sync uses** (`baseElFor`). An earlier version gated on `row.paired`, so it reported `null` for every `ins` row — it went quiet on exactly the rows that drifted most. That is how a **340px** anchor error stayed invisible in a diagnostic whose whole job was to surface it.

## Things that cost real time (read before re-deriving them)

1. **Geometry must match or drift is guaranteed** — see Fact 6.
2. **Chromium throttles rAF in unfocused windows** → Obsidian's virtual renderer freezes → automated measurement reads `sections: 2, nblock: 0` **and lies**. Force focus first (`Page.bringToFront` + assert `document.hasFocus()`) before measuring anything rendered. *(Does not affect `metadataCache`, which is parsed at load — so the oracle capture doesn't need it.)*
3. **Obsidian doesn't resolve relative `require()`** in a plugin folder → ship one bundled file. This is why the plugin is bundled and why `test/bundle.test.ts` loads the built artifact rather than trusting the typecheck.
4. **NUL bytes make grep treat a file as binary** → see above.
5. **Inherit Obsidian's structure/theme vars** → every hand-rolled lookalike drifted.

## Deliberately not done

- **Live Preview decorations.** Post-processors don't run there; it would need a parallel CodeMirror decoration implementation. VS Code has the same limitation.
- **Line-grain diffing.** Would fix "list→paragraph reads as delete+add", but block pairing is what keeps the panes aligned and annotation anchors intact. Not obviously worth it.
- **Collapsing deletions.** VS Code doesn't, and neither should we — reserving space on the short side is what keeps both sides readable at full size.
- **Diffing non-markdown files**, merge/apply, and anything that writes. The last one is not a feature gap; it's the design.
