# Design: stop openReview from wiping third-party annotation marks

> Diagnosis + fix design by a Fable (claude-fable-5) max-effort pass, 2026-07-16, verified
> by static analysis of both plugins + Obsidian 1.12.7 asar internals AND live CDP probes.
> Root cause and fix are probe-validated. Implementation follows in a separate commit.

---

{
  "summary": "Fable-only: diagnose why opening a Live Git Diff review wipes side-comments reading-view marks, design the fix (design doc only)",
  "agentCount": 1,
  "logs": [
    "Fable design returned."
  ],
  "result": {
    "ranAsFable": true,
    "design": "All evidence is in. Writing the design document as my final deliverable.

---

# Design: Stop `openReview` from wiping third-party annotation marks

**Repo:** `/Users/jessicakosturko/Development/obsidian-live-git-diff` · **Scope:** design only, no code changes
**Method:** static analysis of both plugins + Obsidian 1.12.7 internals (`~/Library/Application Support/obsidian/obsidian-1.12.7.asar`), then **live verification via CDP against the running Obsidian** (port 9222, `LiveGitDiff-Demo` vault, 3 probe runs). Every claim below is either cited to file:line or to a probe measurement taken tonight.

---

## TL;DR

| | |
|---|---|
| **The wipe** | Ours, deterministic, unconditional. `openReview` → `rerenderPreviews()` (`plugin-src/src/main.ts:580`, `:662-674`) → Obsidian's `MarkdownPreviewRenderer.rerender(true)`, which **synchronously empties every section element** (`o.rendered=!1, o.el.empty()` — asar @2538218) on **every open markdown leaf in the workspace**, then rebuilds asynchronously. Probe: marks = 0 at the moment `openReview` returns, in 3 of 3 runs. |
| **The asymmetry** | Whether marks come back is decided entirely by the *annotation plugin's* post-processor re-running during the async rebuild — a race we start at the single most hostile moment we ever create (mid split-resize, mid active-leaf change, interleaved with ~84 base-pane renders, inside Obsidian's `lastText = null` window). A later, quiet `rerender(true)` re-runs the same processor with its inputs whole — so it restores. |
| **The fix** | Stop force-rerendering the note pane at all. Decorate the already-rendered sections **in place** (walk `previewMode.renderer.sections`, feature-detected), reusing the exact post-processor body; the registered post-processor keeps covering naturally-rendered sections. Delete both `rerenderPreviews()` call sites. Probe-validated: with the rerender suppressed, **marks never drop** (4→4→4), and the in-place walk decorated 44/44 sections with correct row resolution. |

---

## 1. Root cause

### 1.1 The mechanism chain

**Step 1 — the wipe is synchronous and ours.**
`openReview` (`main.ts:494`) ends with:

```
main.ts:579   await this.revealView();      // split + base pane render
main.ts:580   this.rerenderPreviews();      // ← the wipe
main.ts:583   this.sync.attach();
```

`rerenderPreviews` (`main.ts:662-674`) calls `view.previewMode.rerender(true)` on **every** markdown leaf. Obsidian 1.12.7 implements that as (asar @2538218, de-minified):

```js
rerender(full) {
  this.lastText = null;
  if (full) for (const o of this.sections)
    if (o !== header && o !== footer) { o.rendered = false; o.el.empty(); }  // ← SYNCHRONOUS
  this.queueRender();                                                        // ← rebuild is ASYNC
}
```

`el.empty()` destroys every child of every section — including every other plugin's decorations. **Probe run 1:** MutationObserver logged `REMOVED-containing-mark` at T+693.1ms and `openReview RETURNED` with `marks: 0` at T+693.2ms. This is the drop to 0 in the repro, and it is unconditional.

**Step 2 — restoration is a race run by the other plugin, not by us.**
`queueRender` → `onRender` (asar @2543049) re-renders sections **asynchronously** (0ms timer, 5ms budget per frame, re-queued), and for each section runs *all* registered post-processors. Whether marks return therefore depends entirely on the annotation plugin's processor being fully self-sufficient at that exact moment. side-comments' processor is an **async, detached** call (`side-comments-fork/main.ts:80-82`: `void this.renderReadingView(el, ctx)`) with a state-dependent branch (`main.ts:1173-1176`):

```ts
const document = this.currentDocument?.filePath === normalizedPath
  ? this.currentDocument                       // sync path — marks land inside the processor call
  : await this.store.loadDocument(normalizedPath);  // async path — marks land microtasks later
```

**Step 3 — why our forced pass is the most hostile moment the plugin ever sees.** At `main.ts:580` we have just, in the same breath:
- **Split the workspace** — `revealView` → `createLeafBySplit` (`main.ts:652`), which internally calls `setActiveLeaf(newLeaf)` (asar @3415144) — the note pane resizes and the active leaf changes mid-flight;
- **Run every post-processor ~84 extra times with `sourcePath: ''`** — the base pane renders per-row via `MarkdownRenderer.render(app, text, el, '', this)` (`baseView.ts:214`); probe run 1 counted 84 side-comments invocations with empty sourcePath before the note pass even began;
- **Nulled Obsidian's `lastText`** — `getSectionInfo` returns `{ text: this.lastText || \"\", … }` (asar @2539078). On files ≥ 10,240 chars the reparse is async (worker; asar @2543049 `parseAsync` branch), so processors in that window receive `sectionInfo.text === \"\"`. side-comments' normalized anchor fallback then hard-disables (`readingViewRenderer.ts:204-207`: `if (preferredIndex === undefined) return null`) — any anchor whose `selectedText` crosses Markdown syntax is silently dropped. (The demo note is 6,815 bytes → `parseSync`, so this window doesn't exist there; it does on real-vault-sized notes.)
- **Left the plugin's per-file state wherever our flow put it** — `currentDocument` is maintained only by `file-open` (`side-comments-fork/main.ts:103-107`), and `file-open` only fires when `getActiveFile()` *changes* (asar `activeLeafEvents`, @~3419200).

A later manual `rerender(true)` runs the identical processor in a **settled** workspace: no resize, no leaf churn, no `''`-render storm, parse complete, plugin state whole. Same code, different inputs — that is the asymmetry.

### 1.2 Verdict on the four candidate mechanisms

| Candidate | Verdict | Evidence |
|---|---|---|
| **(a) post-processor order / our DOM surgery wipes their marks** | **Refuted.** | `unwrapCharMarks` removes only `[data-lgd-char]` spans (`charmarks.ts:40`, `:238`); `el.normalize()` merges text nodes, never removes elements (`:245`). `wrapRanges` splits/wraps text nodes and asserts byte-identical `textContent` (`:332-343`). `styleDelPad` is style-only with compare-before-write (`viewzones.ts:450-451`). Probe: after recovery, marks coexist with our wash **with the review open** — if our per-section pass wiped theirs, the coexistence state could not exist. |
| **(b) timing/readiness of the plugin's state** | **Confirmed as the asymmetry driver** (the *class*, §1.3). | The forced pass runs with the plugin's inputs (per-file state, `sectionInfo.text`, workspace geometry) in transition; the manual pass runs with them whole. |
| **(c) virtualization detaches the section** | Refuted as primary; real as a compounder. | The repro holds on-screen. But probe run 1 logged 7 of ~45 note-path invocations with `el.isConnected === false` — decorations do land in detached elements during the forced pass (`updateVirtualDisplay` detaches outside the attach window; asar @2543049 tail). |
| **(d) `rerender(true)` semantics — clear-then-async-rebuild** | **Confirmed as the wipe.** | Clear is synchronous (`o.el.empty()`), rebuild is queued. Our subsequent synchronous work does *not* land between their render and the frame — the processors re-run properly on rebuild; the damage is the guaranteed wipe plus the hostile-moment race, not an ordering overwrite. |

**The one-sentence root cause:** *`openReview` synchronously destroys every other plugin's note-pane decorations via a forced full rerender, and then bets — at the worst possible moment, on every open, across every open markdown leaf — that every annotation plugin can rebuild its marks per-section from scratch; any plugin that can't (event-driven renderers, state-mid-transition processors, syntax anchors inside the `lastText` window) stays wiped until an external trigger.*

### 1.3 Honesty note: what tonight's builds actually show

With the currently-installed pair (side-comments `main.js` built Jul 16 03:39, matching fork HEAD `328a8ed`), the **persistent** zero did not reproduce under probes: marks recovered in ≤300ms in all three states I forced (sync branch; forced `currentDocument = null` async branch; reuse-path reopen). The fork shipped two anchor-location fixes tonight (`ccfe6ed` Jul 15 22:41 \"Fix reading view marks for anchors containing Markdown syntax\", `328a8ed` Jul 16 01:04 \"seed the normalized fallback from the anchor's own block\") — the prompt's repro (`marks 2`; the sidecar has since been edited, 04:31, and now yields 4 spans) is consistent with the pre-fix build, whose anchor seeding failed exactly when our forced pass degraded its inputs. That fork-side fix rescued **one** plugin. The class remains: we cannot require every annotation plugin to win this race, which is the commission's constraint and what §2 removes.

### 1.4 The confirming probe (already run — re-runnable)

Scripts: `…/scratchpad/fable-probe-open.js`, `fable-probe-async2.js`, `fable-probe-fix.js`, driven by `cdp.mjs` (`node cdp.mjs <probe.js>`; Obsidian already listens on :9222). What they instrument: `file-open`/`active-leaf-change`; wraps on `sc.renderReadingView` (branch + `el.isConnected`), `sc.store.loadDocument`; a MutationObserver for mark add/remove; mark counts at T+0/300/1500/3000ms. Key numbers:

| Run | Condition | marks at `openReview` return | marks t+300ms | Notes |
|---|---|---|---|---|
| 1 | warm, sidebar focused (sync branch) | **0** | 3 (recovered) | wipe at T+693.1ms; 84 `sourcePath:''` invocations; 45 note-path invocations, 7 on detached els |
| 2 | note focused, `currentDocument` forced null (async branch) | **0** | 4 (recovered) | manual 2nd rerender: 4→4; reuse-path reopen: 0 at return → 4 |
| 3 | **`rerenderPreviews` suppressed (the fix's premise)** | **4 — never dropped** | 4 | `renderer.sections`: 44/44 with els (26 attached), `renderer.getSectionInfo(el)` works outside a post-processor; in-place walk decorated 44/44, row resolved 44/44 |

The one-line cheap probe for anyone re-verifying before coding: count `.side-comments-reading-view-mark` immediately after `await plugin.openReview()` (expect 0 today), then with `plugin.rerenderPreviews = () => {}` (expect no drop).

---

## 2. The fix — from our side, generic

### 2.1 Chosen design: decorate in place; never force-rerender the note pane

Do we need `rerenderPreviews` on the note side at all? Only for one thing: sections rendered *before* the review opened have never passed through our post-processor, so they carry no decorations (or a previous session's). The rerender was a sledgehammer to force our processor to run on them. But every decoration primitive we own is already built to be applied to a **live** element idempotently — that is the recycle-safety design (`main.ts:199-227`, `charmarks.ts:449-451`, `viewzones.ts:441-465`, `panes.ts:64-68`). The only post-processor input we lacked outside a render pass is the section's line range — and probe 3 proves `view.previewMode.renderer.getSectionInfo(el)` and `renderer.sections` supply it from outside, for attached *and* detached sections (44/44).

**Design:**

1. **Extract the post-processor body** (`main.ts:181-227`) into `decorateNoteSection(el, info: {lineStart, lineEnd})` — the tag (`nblock`, `noteLines.set`), row stamp, `styleDelPad`, `setNoteKind`, `harvestInsHeight`/`charMarks.apply`/`unwrapCharMarks` branch. The registered post-processor becomes a thin caller (`ctx.getSectionInfo` → `decorateNoteSection`). Unchanged behavior for naturally-rendered sections.
2. **Add `decorateNotePaneInPlace()`**: for each markdown leaf whose file is the session file and mode is `preview` (the existing `notePane()` filter, `main.ts:297-320`, generalized to all matching leaves): feature-detect `previewMode.renderer` with `Array.isArray(renderer.sections)` and `typeof renderer.getSectionInfo === 'function'`; for each section **that has rendered content** (skip `section.rendered === false` / childless els — see §3.2), call `decorateNoteSection(section.el, renderer.getSectionInfo(section.el))`.
3. **openReview**: replace `this.rerenderPreviews()` (`main.ts:580`) with `this.decorateNotePaneInPlace()`. Order stands: session → `clearNoteDecorations` → `revealView` (base blocks must exist for `charMarks.apply`, `charmarks.ts:414-416`) → decorate → `sync.attach()`.
4. **closeReview**: **delete** `this.rerenderPreviews()` (`main.ts:596`) outright. `clearNoteDecorations` (`main.ts:610-625`) already reverses us; upgrade it to (a) walk `renderer.sections` when available instead of `scroller.querySelectorAll('.lgd-nblock')` — today the close-path rerender is what cleaned *detached* decorated sections, and the selector walk can't reach them — and (b) also remove `ATTR_ROW` and `CLS.haspad`, which it currently leaves behind (`panes.ts:22`, `:38`; today masked by the rebuild).
5. **Fallback:** if the renderer internals aren't the expected shape (future Obsidian), fall back to today's `rerender(true)` for that leaf and `log.warn` once. Same feature-detect-with-stated-degradation pattern as the scroll APIs (`sync.ts:373-396`, ARCHITECTURE Fact 2).

**What gets deleted:** the `rerenderPreviews()` call at `main.ts:580`; the entire call at `main.ts:596`; the now-false comment at `main.ts:581-582`. `rerenderPreviews` itself shrinks to the fallback path.

### 2.2 Options weighed

| Option | Verdict | Trade-off it carries |
|---|---|---|
| **A. In-place decoration, no forced rerender** (chosen) | ✅ Simplest *correct* | Touches feature-detected internals (`renderer.sections`, `renderer.getSectionInfo`) — mitigated by fallback (§2.1.5). Removes the wipe **class**, not just this plugin's instance; also stops re-parsing the whole doc, re-loading every embed, and rerendering *every other open markdown leaf* on each open/close. |
| B. Keep the rerender; schedule a second one after settle | ❌ | It's the manual-workaround automated: the wipe still happens (visible flicker ×2), event-driven annotation plugins still lose marks permanently, the `lastText` window reopens on each pass, and \"after settle\" is an unbounded race. A rerender to fix a rerender is also the loop seed §3.3 forbids. |
| C. Narrow the rerender to the session file's leaf only | ❌ alone | Fixes the blast radius (today we wipe annotations in **every open markdown file**, since `main.ts:663` loops all leaves), but the reviewed note — the pane this bug is about — still gets wiped. Worth keeping as a property of A (A writes only to session-file leaves). |
| D. Decorate via an absolutely-positioned overlay, no in-el classes | ❌ | Rebuilds zones/wash against virtualization from scratch; word-level marks *need* in-el spans for wrapping; contradicts the padding-not-margin load-bearing choice (ARCHITECTURE Fact 1/4). Complexity with no compatibility gain over A. |

---

## 3. No-regression argument

### 3.1 What must keep working — and why it does

| Surface | Why A preserves it |
|---|---|
| **Diff wash + word marks on the note pane** | Same body, same inputs: `decorateNoteSection` is the post-processor body verbatim; probe 3 resolved a row for 44/44 sections from `renderer.getSectionInfo` line ranges (`rowForNoteRange`, `main.ts:375-386`). Recycled sections keep self-healing via the unchanged registered processor. |
| **View zones** | `styleDelPad` per-el at decorate time exactly as today; `computeDelPads` still runs in the base view's rAF (`baseView.ts:241-244`) then `applyDelPads` walks rendered blocks — order unchanged relative to today (the post-processor pass also preceded that rAF). `harvestInsHeight` still fires per decorated `ins` section. |
| **Scroll anchor / sync** | `noteLines` WeakMap is populated by the extracted body (it must move with it — this is the one easy-to-miss transplant, `main.ts:188`); `sync.attach()` unchanged at `main.ts:583`. Anchors only ever read attached elements (`topmostVisible`). |
| **Third-party marks** (this bug) | Nothing empties the note DOM anymore. Our writes are: `classList` add/remove of `lgd-*` (`panes.ts:64-68` removes only classes we own), one `data-row-index` attr, inline paddings, and `[data-lgd-char]` spans that assert byte-identical `textContent` and self-revert (`charmarks.ts:332-343`). Probe 3: marks 4 before, 4 after in-place decoration. |
| **Stale previous-session paint** | `clearNoteDecorations` at `main.ts:543` still runs first, now over the sections walk, so it reaches detached sections too — *better* than today. |
| **Close leaves no trace** | Upgraded clear removes paddings, char spans, kinds, `nblock`, plus `ATTR_ROW` + `haspad` (§2.1.4) — a superset of today's clear, replacing what the deleted close-path rebuild used to paper over. |

### 3.2 The one real footgun in A, pre-neutralized

Decorating an **unrendered** (empty) section would make `charMarks.apply` diff `\"\"` against the base text and **cache wrong ranges** keyed by `row.idx` (`charmarks.ts:418-427`) — poisoning the block for the whole session (cache hit on the real render). Hence the hard rule in §2.1.2: skip sections without rendered content; the registered post-processor decorates them at their natural render. This costs nothing: an empty section has nothing to wash.

### 3.3 No-wipe and no-loop, structurally

- **Cannot re-wipe:** the fix path contains no call to `rerender`, `empty()`, `setChildrenInPlace`, or any child-removal on note-pane elements. The only child-structure mutations are span **insertions** with a byte-exact `textContent` assertion that reverts on violation.
- **Cannot loop:** today's code already never rerenders from inside the post-processor; the fix adds no render trigger anywhere. The event chain bottoms out in style writes: `charMarks.onHeightChange → zones.scheduleRefresh` (debounced) → `refresh` → inline heights/paddings with compare-before-write (`viewzones.ts:133`, `:450-451`) → at most a *scroll* (`sync`), and scroll-driven recycling re-enters through the same idempotent decorate body. Fixed point, no oscillation — the same convergence argument as ARCHITECTURE Fact 4, now with one fewer external forcing function.
- **What could break that works today:** (1) Obsidian renames `renderer.sections`/`getSectionInfo` → fallback path = exactly today's behavior, loudly logged; (2) a section rendered-but-detached at open never re-enters via the processor if Obsidian re-attaches without re-rendering — covered because the in-place walk decorates detached-but-rendered sections too (probe 3: 44 decorated vs 26 attached); (3) any consumer that *depended* on open/close forcing a full re-render of unrelated leaves — none exists in-repo (`rerenderPreviews` has exactly the two call sites).

---

## 4. What we genuinely cannot fix from our side

1. **Event-driven annotation renderers.** A plugin that paints marks only on its own events (`file-open`/`modify`) and not per-section loses them on *any* Obsidian re-render — scroll recycling, mode toggle, theme change — not just ours. After A we no longer *cause* such re-renders, which makes coexistence with us as good as coexistence with vanilla Obsidian; their residual fragility is theirs.
2. **The base pane's `sourcePath: ''` fan-out.** Post-processors are global by design; our per-row `MarkdownRenderer.render(…, '', …)` (`baseView.ts:214`) still invokes every processor (~84×/open here). Path-guarded processors no-op — that is why `''` was chosen (`baseView.ts:208-213`) — but a non-guarded processor will decorate our base DOM and we cannot prevent it.
3. **Minimal contract to ask of annotation plugins** (README \"compatibility\" note, and upstreamable to the fork):
 - Render reading-view marks from a `registerMarkdownPostProcessor`, self-sufficiently: derive everything from `ctx.sourcePath` + your own store, never from ambient \"current file\" state (`file-open` does not fire when a fileless view becomes active — asar `activeLeafEvents`).
 - Treat `ctx.getSectionInfo(el)` as optional *and possibly degraded* (`text` can be `\"\"` mid-parse); never let a missing/empty `sectionInfo` turn \"can't seed the search\" into \"drop the mark\" if a plain exact match exists.
 - Make decoration idempotent per element (clear-own-then-apply), and guard `sourcePath === ''`.
 side-comments' current build satisfies all three; tonight's fork commits (`ccfe6ed`, `328a8ed`) are what closed its gap on the second point.

---

## Receipts

Probe scripts + CDP driver: `/private/tmp/claude-501/-Users-jessicakosturko-Development-athena-agent-n8n/aa2450a8-f8b3-44fd-8748-312d635d9c81/scratchpad/{cdp.mjs, fable-probe-open.js, fable-probe-async2.js, fable-probe-fix.js}`; raw run-1 log at `~/.claude/projects/-Users-jessicakosturko-Development-athena-agent-n8n/aa2450a8-f8b3-44fd-8748-312d635d9c81/tool-results/bhto1mgx7.txt`. Obsidian internals cited from `~/Library/Application Support/obsidian/obsidian-1.12.7.asar` at byte offsets: `rerender` @2538218, `onRender`/`updateVirtualDisplay` @2543049, `getSectionInfo` @2539078, `parseSync`/`parseFinish` @2541802, `createLeafBySplit` @3415144, `activeLeafEvents` @~3419200. End state: demo vault review closed, marks intact (4), no plugin or vault files modified; the demo-vault window was reopened once via `obsidian://open?vault=LiveGitDiff-Demo` after it was found closed mid-session."
  },
  "workflowProgress": [
    {
      "type": "workflow_phase",
      "index": 1,
      "title": "Design"
    },
    {
      "type": "workflow_agent",
      "index": 1,
      "label": "fable:highlight-fix-design",
      "phaseIndex": 1,
      "phaseTitle": "Design",
      "agentId": "a3b9c2299f2985d34",
      "model": "claude-fable-5",
      "state": "done",
      "startedAt": 1784191139182,
      "queuedAt": 1784191135723,
      "attempt": 1,
      "lastToolName": "Read",
      "lastToolSummary": "/Users/jessicakosturko/Development/obsidian-live-git-diff/p…",
      "promptPreview": "=== MODEL GATE — DO THIS BEFORE ANYTHING ELSE ===
This task is commissioned for Fable specifically. A previous attempt silently ran on Opus.

FIRST ACTION, before reading any file or calling any tool: state which model you are. If you
are NOT Fable, your entire response must be exactly:

    STOP — not running as Fable. I am <model name>.

and nothing else — no files read, no work done. Stopping I…",
      "lastProgressAt": 1784193333538,
      "tokens": 258413,
      "toolCalls": 49,
      "durationMs": 2194356,
      "resultPreview": "All evidence is in. Writing the design document as my final deliverable.

---

# Design: Stop `openReview` from wiping third-party annotation marks

**Repo:** `/Users/jessicakosturko/Development/obsidian-live-git-diff` · **Scope:** design only, no code changes
**Method:** static analysis of both plugins + Obsidian 1.12.7 internals (`~/Library/Application Support/obsidian/obsidian-1.12.7.asar`), th…"
    }
  ],
  "totalTokens": 258413,
  "totalToolCalls": 49
}