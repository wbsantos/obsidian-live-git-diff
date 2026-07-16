# Spike results — 2026-07-15

All three spikes PASS. Plan C (two-pane live git diff in Obsidian) is de-risked.
Every claim below is measured, not argued.

## Spike 1 — does decoration break side-comments? PASS
- side-comments stores **source-text offsets**, never DOM offsets. Capture in reading
  view = `getViewData()` + string-search; resolve = `TreeWalker(SHOW_TEXT)` cumulative
  length. **Split-invariant by construction**: same textContent, different tree => same result.
- Empirical: 3 comments, all byte-exact — including `scoring` (inside an injected span,
  on a decorated block, with **13 duplicate occurrences** in the file → picked the right one)
  and `scoring turns out` (crosses a span boundary).

### Rules the decorator must follow
- NEVER change `el.textContent`; never inject text inside an annotated block.
- **Never render "before" text inside the annotated block** — duplicate occurrences shift
  the ordinal math. (This is why the two-pane design is a *correctness* requirement, not
  a preference. VS Code's own answer: deleted text as an absolutely-positioned,
  display:none-until-hover sibling — outside the block.)
- Rails via CSS only. No `id` on tint spans (`extractContents()` clones them).
- Decoration can never orphan a comment: orphaning reads file text only.

## Spike 2a — both versions at once, from git, nothing on disk. PASS
- Base pane = custom ItemView, `git show <pinned-sha>:<rel>` into memory, rendered
  block-by-block with our own line map (`data-line-start/end`).
- Pinned base sha is required: HEAD moves as Claude commits mid-review, and the diff
  would silently shrink toward zero.
- git root != vault root — resolve via `git rev-parse --show-toplevel`, or `git show`
  fails and the base pane renders empty = "whole file is new" (wrong-but-plausible).
- `sourcePath: ''` on the base pane suppresses foreign post-processors (verified: no
  stray comment marks on the old version).

## Spike 2b — scroll sync. PASS
Measured, window force-focused, fresh session, reproduced twice:

| Position | Anchor delta | Worst on-screen drift |
|---|---|---|
| 3%  | 0px  | 24px |
| 15% | 0px  | 40px |
| 40% | 0px  | 40px |
| 65% | 40px | 40px |
| 90% | 0px  | 48px |

Document height 34,230px. Drift is **bounded, not cumulative**, and quantized to
0/24/40/48 = paragraph-margin steps (our `.sp2a-block` vs Obsidian's `div.el-*`).

### Grain fix — measured after (block grain matched to Obsidian's sections)

| Position | Before | After | Paired-block heights |
|---|---|---|---|
| 3%  | 24px | 24px | 0/14 mismatched |
| 15% | 40px | **0px** | 0/13 |
| 40% | 40px | **0px** | 0/8 |
| 65% | 40px | **0px** | 0/7 |
| 90% | 48px | 46px | 2/6 |

Root cause was NOT margins: our splitter grouped "runs of non-blank lines", so a
paragraph immediately followed by a list became ONE base block where Obsidian
renders TWO sections. Oracle: `metadataCache.getFileCache().sections` = 308 vs our
270; all 38 of the gap were exactly that pattern. One rule (break paragraph->list)
took `stillMerging` to 0 and drift to 0px through the middle of the document.

**Use `metadataCache.getFileCache().sections` as the grain oracle in the real build** —
it is the same sectioning the renderer uses, so it settles grain questions by
measurement instead of argument. (It only covers vault files; the base text still
needs our splitter, which is why the splitter must agree with it.)

Residual at 3%/90% is the unpaired regions (pure deletions/insertions with no
counterpart) — the case VS Code solves with view zones, and where there is no
correct answer without them.

### View zones — measured on a BIG diff (base 9b1f2e4 Jul-07 vs HEAD)

The 10-block diff was flattering us. Real test: 312 blocks, **94 changed**
(43 mod / 26 ins / 25 del) across **17 ins runs and 17 del runs**.

| position | before zones | after zones |
|---|---|---|
| 5%  | 98px  | **16px** |
| 20% | 46px  | 40px |
| 35% | **340px** | **24px** |
| 50% | 126px | **24px** |
| 65% | 0px   | 48px |
| 80% | **235px** | **24px** |
| **median worst** | **126px** | **24px** |
| **max worst** | **340px** | **48px** |

Anchor is 0px at 5 of 6 positions (was off by up to 340px). All 26 insertion
zones harvested a height (26/26) despite the note pane being virtualised.

**Insertions**: one `div.sp2a-spacer` per ins row in the base pane, height
harvested lazily from the note block via the post-processor (the one moment we
are guaranteed to hold the element before the reading view discards it). Crucially
the spacer is also the **alignment anchor** — `baseElFor(idx)` = blockEls ?? spacerEls.
That is what killed the 340px: an ins row previously had no base counterpart, so
the anchor fell through to interpolation.

**Deletions**: NOT collapsed (VS Code doesn't collapse — it reserves space on the
short side and never hides content). We can't inject into the note pane (virtualised,
setChildrenInPlace rips it out) — but we can style an element that's already there:
`padding-bottom` on the note block PRECEDING each del run, sized from the base's
exactly-known heights. Padding not margin, so Obsidian's measureSection() counts it.
Applied from the post-processor so it self-heals when sections recycle.

Verified no feedback loop: ins-height measurement subtracts del padding before
caching; hammering one scroll position 8x holds at 2616px ins zones / 120px del
pads — converges in one pass, no growth.

### Architecture facts (verified against Obsidian 1.11.5 source)
- **Reading view virtualizes**: off-screen sections are `.detach()`ed (getBoundingClientRect
  = zeros) and `sizerEl.setChildrenInPlace()` runs every scroll tick — so **injected spacers
  are ripped out**. Equal-height + mirrored scrollTop is structurally impossible. Confirmed
  live: 45 of 271 blocks rendered.
- **Line-space is the currency**, never pixels — this is what Obsidian itself uses for
  editor<->preview sync. `setEphemeralState({scroll:N})` is public + retry-safe;
  `previewMode.applyScroll()` **silently no-ops** when sections are unmeasured;
  `getScroll()` **can return null** despite its typing.
- Alignment: match **on-screen positions** of the paired blocks, not scroller-relative
  offsets — absorbs the header and any future chrome automatically.
- Guard with a **time-based owner token**, not Obsidian's one-shot boolean (which swallows
  the next real scroll when a programmatic scroll emits zero events).

## Traps that cost real time
1. **Geometry must match or drift is guaranteed.** An override of `max-width:100%` made the
   base pane wrap at 795px vs the note's 700px (`--file-line-width`) → different heights →
   everything below the anchor drifted while the anchor itself was pixel-exact.
2. **Chromium throttles rAF in unfocused windows** → Obsidian's virtual renderer freezes →
   automated measurement reads `sections: 2`, `nblock: 0` and lies. **Force focus first**
   (`Page.bringToFront` + assert `document.hasFocus()`).
3. **Obsidian doesn't resolve relative `require()`** in a plugin folder → ship one bundled file.
4. **NUL bytes make grep treat a file as binary** → every pattern "passes" silently. A
   read-only invariant grep that can't read the file is theatre. So is one that matches a
   *handle* rather than a *write method*.
5. Inherit Obsidian's structure/theme vars; every hand-rolled lookalike drifted.

## Build recommendations
- Standard plugin template: TypeScript + esbuild + CI lint gate. Hand-written JS cost us
  traps 3 and 4.
- Mine `Visual Studio Code.app/.../markdown-language-features/media/markdown.css` — the
  closest prior art for decorating a *rendered* markdown view: `box-shadow` rails (zero
  layout cost), theme variables, and the deletion indicator + hover tooltip pattern.
- Close the ~40px by adopting Obsidian's `div.el-*` wrapper classes on base blocks.
