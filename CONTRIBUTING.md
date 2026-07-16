# Contributing

Thanks for looking. This is a small, opinionated plugin with one hard rule and a lot of comments explaining why things are the way they are.

## The hard rule

> **This plugin does not write to notes.**

That isn't a style preference. It's the entire reason the design is safe to point at a document you care about, and it's the plugin's main promise to the people who install it. Decoration only: add CSS classes to blocks Obsidian already rendered, and never touch text.

It is enforced mechanically, not socially — `tools/check-invariant.mjs` runs on every build, every `npm test`, and in CI. **If your change makes the gate go red, change the code, not the gate.** If you genuinely believe you have a case for an exception, open an issue with the argument first; don't weaken the check to get a PR green.

Concretely, a change is out of scope if it needs to:

- call any vault/adapter/editor write method;
- import a filesystem module (the plugin currently imports none, and the gate asserts it);
- inject text or elements into the note pane, or modify `textContent` anywhere.

That last one deserves its own note. Annotation plugins store **source-text offsets** and resolve them by walking text nodes. Adding so much as a `+` marker inside a rendered block silently moves every anchor after it — and that surfaces days later as *"my comments moved"*, with no way to trace it back to you. `wrapRanges` asserts byte-identical `textContent` and self-reverts for exactly this reason. Please don't route around it.

## Getting set up

```bash
cd plugin-src
npm ci
npm run ci        # typecheck + test + build + invariant gate — do this first
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Watch build. Emits into `../plugin-dist/`, including `styles.css` and `manifest.json`. |
| `npm run build` | Typecheck → production bundle → invariant gate. |
| `npm test` | The full test suite (node's built-in runner; no test framework dependency). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run gate` | Just the read-only invariant gate, against the built bundle. |
| `npm run capture-oracle` | Capture Obsidian's block sectioning as a test fixture — see below. |

### Testing your build in Obsidian

The build emits exactly the three files Obsidian loads. Symlink `plugin-dist` into a vault:

```bash
ln -s "$(pwd)/../plugin-dist" "/path/to/YourVault/.obsidian/plugins/live-git-diff"
```

Then **Settings → Community plugins → Reload plugins** after each build. Use a scratch vault, not one you care about — that's just good practice, not a comment on the invariant.

## Repository layout

```
plugin-src/        the source. This is where you work.
  src/             TypeScript modules
  test/            node:test suites + fixtures
  tools/           the invariant gate + the oracle capture tool
plugin-dist/       the BUILT plugin — main.js, manifest.json, styles.css. Committed.
docs/              ARCHITECTURE.md and OBSIDIAN-COMPLIANCE.md
manifest.json      a copy of plugin-src/manifest.json. BRAT reads it from the root.
versions.json      a copy of plugin-src/versions.json, for the same reason.
```

The original spike lives on the **`archive/spike`** branch — `git show archive/spike:SPIKE-RESULTS.md`, or check it out to browse. It is off `main` on purpose: it carried its own older `manifest.json` (`id: spike2b-gitdiff`), and a repo with two manifests in it confuses BRAT and anyone reading it for the first time. `SPIKE-RESULTS.md` stays on `main` as the measured record the design rests on.

`plugin-dist/` is committed on purpose: it's the artifact a user copies into their vault, and committing it means the read-only claim is auditable from a clone without trusting that someone's local build matched these sources.

**The root `manifest.json` and `versions.json` are copies, and copies drift.** They exist because BRAT resolves a version by reading the manifest from the **repository root**, before it downloads any release asset — with the manifest only under `plugin-src/`, BRAT could not install this plugin at all. Nothing regenerates them, so **releasing means updating all three**: `plugin-src/manifest.json`, the root copy, and `versions.json` at both paths. `test/bundle.test.ts` catches a manifest that disagrees with `package.json` on version; CI and the release workflow additionally `diff` the root copies against their `plugin-src/` originals, so a root copy left behind fails the run instead of shipping.

## Before you open a PR

1. **`npm run ci` passes.** Typecheck, tests, build, gate.
2. **You tested it in a real Obsidian**, in Reading view, on a note in a git repo. The typecheck cannot tell you the feature works — see `docs/ARCHITECTURE.md` for the story of a relative `require()` that typechecked, linted, read correctly, and silently never loaded.
3. **Comments explain WHY, not what.** This codebase is dense with hard-won facts (the reading view virtualises; padding not margin; block grain must match Obsidian's sections). If you discover a new one, write it down where the next person will hit it. If you find one that's *wrong*, please fix the comment as well as the code.
4. **No new dependencies** without a good reason. The plugin ships zero runtime dependencies and the toolchain is esbuild + TypeScript + node's own test runner. That's deliberate.
5. **If you bumped the version**, the root `manifest.json` and `versions.json` match their `plugin-src/` originals. Nothing copies them for you, and a stale root manifest makes BRAT install the wrong version — silently.

## The grain oracle

`test/grain-oracle.test.ts` asserts that our block splitter agrees with **Obsidian's own sectioning** — which matters because a disagreement means the two panes measure differently and everything below it drifts. Obsidian's sectioning is closed source, so agreement is a **measurement**, not an argument.

It compares against a captured snapshot of `metadataCache.getFileCache().sections`. **The fixture is committed** (`test/fixtures/obsidian-sections.json`, captured from a live Obsidian 1.12.7), so the suite runs green out of the box and CI's `LGD_REQUIRE_ORACLE=1` is satisfied honestly. If the fixture is ever absent, the test **skips** locally and **fails** in CI — which is the deliberate design: a missing oracle must be loud, not silently green.

You need to re-capture it if you change the block splitter's grain, or to check a newer Obsidian still sections the way this one did. The fixture records a sha256 of the exact bytes Obsidian sectioned, so a stale oracle fails loudly instead of passing quietly.

To capture it:

```bash
# 1. relaunch Obsidian with the debugging port open
open -a Obsidian --args --remote-debugging-port=9222        # macOS
# 2. copy the corpus into any vault (nothing is written to it)
cp test/fixtures/corpus-head.md /path/to/AnyVault/
# 3. open that note in Obsidian, then:
npm run capture-oracle -- --window "AnyVault" --file "corpus-head.md"
```

Commit the fixture it writes, and say which Obsidian version it came from.

**Please don't "fix" a missing oracle by reimplementing Obsidian's sectioner to compare against.** That only proves our splitter agrees with our own second guess — a fake oracle, which is worse than no oracle because it reports green.

## Style

- `const`/`let`, never `var`. Real types, not `any` (use `unknown` and narrow).
- DOM via Obsidian's `createEl`/`createDiv` helpers. Never `innerHTML` — the gate rejects it.
- Classes in `styles.css`, not inline styles. The two exceptions are computed at runtime and commented as such: the spacer's `height` and the deletion zone's `padding`. There's no class that could express a per-element measured pixel value.
- UI text in **sentence case**. Command names must **not** repeat the plugin name — Obsidian prefixes it for you.
- Class names are prefixed `lgd-`, defined in `styles.css`, and referenced through the `CLS` map in `src/panes.ts`. A test asserts code and CSS agree in both directions.

## Reporting a bug

Please include:

- Obsidian version, OS, and plugin version;
- whether the note is in Reading view and inside a git repo;
- the output of **Copy alignment report to clipboard** if it's about drift or sync — `deltaPx` is exactly the number needed;
- console output with **Debug logging** turned on in settings.
