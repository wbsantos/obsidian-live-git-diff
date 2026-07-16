# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-16

First release. Ports a measured spike into a real, installable plugin.

### Added

- **Side-by-side rendered git diff.** A read-only base pane renders the note's git
  version, fetched into memory with `git show`. Nothing is written to disk.
- **Compare against any version** — command **"Open review against a version…"** opens a
  picker listing the file's recent commits by subject, relative age, absolute time, and
  sha, all searchable. Selecting one pins it as the session base, so a review can span
  any number of commits.

  This is the difference between the plugin working and not working for a
  commit-frequently workflow: pinning to HEAD assumes the changes under review are
  sitting uncommitted in the working tree, and when something commits on your behalf
  (an agent checkpointing so reverts stay cheap) the tree is clean and the diff is empty.

  **The note pane is unaffected — deliberately.** Only the base moves. The right-hand
  pane stays the real file in a real markdown leaf, which is the only thing keeping
  annotation and TTS plugins attached. Diffing two arbitrary commits against each other
  would make both panes synthetic and break exactly that. `test/session.test.ts` pins the
  invariant.
- **Rename-aware.** The picker follows renames (`git log --follow`), and the base is read
  under the name the file had at the chosen commit — instead of failing, which rendered
  as an empty pane and read as "the whole file is new".
- **The base pane header names the pinned version** — `base 3c9d151 · "apply review round
  1" · 7 hours ago` — since a sha alone can't say what you're looking at. Commit times
  are AM/PM local ("Jul 7, 2:10 PM"), never 24-hour or ISO.
- **An empty diff says so in words**, and suggests the picker — because a clean working
  tree against HEAD is a correct empty answer that looks exactly like a broken plugin.
- **Anchor-based scroll sync** between the two panes. Anchors on the topmost *visible*
  block, because Obsidian's reading view virtualises and the heights of off-screen
  blocks cannot be measured. Measured: anchor exact at 5 of 6 sample positions, median
  worst-case drift 24px, max 48px on a 94-change diff.
- **View zones** — blank reserved space wherever one side has text the other doesn't.
  Insertions get a spacer element in the base pane (which we own); deletions get
  `padding-bottom` on the preceding note block (which we may only restyle). Took median
  worst drift from 126px to 24px, and max from 340px to 48px.
- **Word-level marks** inside changed blocks, diffed on the *rendered* text of both
  sides. Suppressed above 80% changed words. Measured: 43/43 changed rows marked, 225
  spans, 0 reverts, 0px height impact.
- **Pinned base sha** per review session — the diff cannot silently shrink toward zero
  while something else commits to the repo mid-review.
- **Settings tab**: the five diff colors (any CSS color, alpha included), the default
  base ref (HEAD / HEAD~1 / this file's previous version / any ref), how many versions the
  picker lists, and a debug toggle.
- **Alignment report** command, copied to the clipboard as JSON, for diagnosing drift
  with a number instead of an opinion.
- **Read-only invariant gate** (`tools/check-invariant.mjs`), wired into `npm run build`,
  `npm test`, and CI. Fails the build on any write method, any filesystem import, any
  `innerHTML` assignment, NUL bytes, or invalid UTF-8. Tested against planted violations.
- Docs: `README.md`, `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`.

### Changed — from the spike this was ported from

- **TypeScript + esbuild** replace a hand-written ~60KB CommonJS bundle. Two of the
  spike's bugs were artifacts of hand-writing what a bundler handles: a relative
  `require()` that silently never loaded, and NUL bytes that made `grep` treat the
  bundle as binary — so every read-only check "passed" without reading a line.
- **CSS classes renamed** `sp2a-`/`sp2b-` → `lgd-`. Spike names would have become
  permanent public API for anyone writing a theme snippet. A class-parity test now makes
  a mis-rename a test failure rather than a silently missing decoration.
- **The alignment report goes to the clipboard**, not to a hardcoded scratch path. That
  removed the gate's only carve-out: the plugin now imports no filesystem module at all,
  which is a capability the gate can check rather than a promise it has to trust.
- **Commands renamed** to sentence case and unprefixed — Obsidian adds the plugin name.

### Fixed

- **`git log --format` could not be spawned at all.** The record separator was NUL
  (`%x00`), which is git's own convention and works when typed into a shell — but **node
  refuses to spawn a process with a NUL in any argv element**. It survived a manual probe
  and failed on the first real call. Now ASCII RS (`0x1e`), which is the semantically
  correct byte *and* survives the transport. Caught by `test/git.test.ts` running against
  a real repository rather than a mock.
- **`scrollTop = NaN` snapped the base pane to the top.** The interpolation fallback read
  run-position fields that are only populated for *unpaired* rows. A paired row reaching
  that path — possible when the base pane is mid-re-render — computed
  `(undefined + frac) / undefined` = `NaN`. It now declines to answer, leaving the pane
  where it is, which is the correct behaviour for "I don't know". Latent in the spike.

### Pre-publication hardening

- **The grain oracle is captured and committed** (`test/fixtures/obsidian-sections.json`),
  from a live Obsidian 1.12.7. The oracle test skips when its fixture is absent, and CI
  sets `LGD_REQUIRE_ORACLE=1` so an absent fixture **fails** CI rather than skipping
  quietly — deliberate: the alternative is a test that invents its own oracle and
  reports green. With the fixture present, the suite passes because the oracle exists,
  not because anything was relaxed.
- **`manifest.json` and `versions.json` at the repository root.** BRAT resolves a
  version by reading the manifest from the repo root, so the previous layout — manifest
  only under `plugin-src/` — meant BRAT could not install this plugin at all, while the
  README recommended BRAT. They are exact copies of the `plugin-src/` originals and must
  be kept in sync on release (see CONTRIBUTING); CI diffs the copies on every push.
- **A tag-triggered release workflow** that builds the plugin and drafts a GitHub release
  with `main.js`, `manifest.json`, and `styles.css` attached — the three assets BRAT and
  a manual install both look for.
- **Every `git` ref argument now sits behind `--end-of-options`.** A user-supplied ref
  was already passed as a single argv element to a process spawned without a shell, so it
  could never have been a shell injection; `--end-of-options` closes the remaining gap,
  which is that a ref beginning with `-` could be parsed by git as an **option**.
- **The original spike moved to the `archive/spike` branch** and is off `main`. It was
  kept at the repo root for provenance, but it shipped a second, older `manifest.json`
  (`id: spike2b-gitdiff`) — precisely the thing that confuses BRAT and a reviewer reading
  the repo for the first time. The history is preserved on the branch, not deleted.
- **Every repository URL now points at `github.com/jkosturko`.** The previous URLs — in
  both manifests' `authorUrl`, `package.json`, the README's install links, and this
  file's compare links — named an account that does not exist and 404s. `authorUrl` now
  names the author's page rather than the plugin repo, which is what the
  `obsidian-releases` submission validator requires.

[0.1.0]: https://github.com/jkosturko/obsidian-live-git-diff/releases/tag/0.1.0
