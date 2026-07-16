/**
 * baseView.ts — the LEFT pane: a custom read-only ItemView rendering the git base
 * version of the note, fetched into memory. Nothing lands on disk, ever.
 *
 * WHY A CUSTOM VIEW AND NOT A SECOND MARKDOWN LEAF: a markdown leaf needs a real file.
 * The base version is not a file and must never become one — the entire point is that
 * no generated document appears in the vault. An ItemView lets us render arbitrary text
 * with Obsidian's own renderer, and because nothing annotates the OLD version, this
 * pane needs no getSectionInfo() and no comment support. That asymmetry is what makes
 * the whole design possible: the two panes need not be symmetric, because comments are
 * only ever needed on the CURRENT side.
 */
import { ItemView, MarkdownRenderer, WorkspaceLeaf } from 'obsidian';
import { CLS, ATTR_ROW } from './panes.ts';
import type { Session } from './session.ts';
import type { ViewZones } from './viewzones.ts';

export const VIEW_TYPE = 'live-git-diff-base';

/** What this view needs from the plugin. Structural — no import of the plugin class. */
export interface BaseViewHost {
  session: Session | null;
  zones: ViewZones;
  sync: { enabled: boolean; attach(): void };
}

export class GitBaseView extends ItemView {
  private host: BaseViewHost;

  /** The scrolling element of this pane (`.lgd-body`). Recreated on every render. */
  bodyEl: HTMLElement | null = null;
  /** row.idx -> its block container in this pane. */
  blockEls: Map<number, HTMLElement> = new Map();
  /**
   * row.idx -> the VIEW ZONE standing in for an 'ins' row (text the note has and the
   * base does not). See `render`.
   */
  spacerEls: Map<number, HTMLElement> = new Map();

  private syncBadgeEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, host: BaseViewHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    const s = this.host.session;
    return s ? `Base: ${s.fileName}` : 'Git base';
  }

  getIcon(): string {
    return 'git-compare';
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  /** Full re-render from the plugin's current in-memory session. */
  async render(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('lgd-view');
    // Stale after empty() — rebuilt below, and the plugin re-attaches its scroll
    // listener to the NEW body element once this returns.
    this.bodyEl = null;
    this.blockEls = new Map();
    this.spacerEls = new Map();

    const session = this.host.session;
    if (!session) {
      root.createDiv({
        cls: 'lgd-empty',
        text: 'No review session. Run "Live Git Diff: open review for this file".',
      });
      return;
    }

    const header = root.createDiv({ cls: 'lgd-header' });
    header.createDiv({ cls: 'lgd-title', text: session.fileName });

    if (session.error) {
      header.createDiv({ cls: 'lgd-sub', text: 'base unavailable' });
      // The error is rendered IN the pane, loudly. An empty base pane must never be the
      // only signal — "no base text" and "the whole file is new" look identical on
      // screen, and the second reading is wrong-but-plausible.
      const errBody = root.createDiv({ cls: 'lgd-body markdown-preview-view markdown-rendered' });
      errBody.createDiv({ cls: 'lgd-error', text: session.error });
      return;
    }

    // THE HEADER HAS TO IDENTIFY THE BASE IN WORDS.
    // While the base was always HEAD, "base a1b2c3d" was enough. Now that any commit can
    // be pinned, a sha alone cannot answer the first question a surprising diff raises —
    // "which version am I actually looking at?" — so the subject and the age carry it:
    //   base 3c9d151 · "apply review round 1" · 7 hours ago
    const sub = header.createDiv({ cls: 'lgd-sub' });
    sub.createSpan({ cls: 'lgd-sha', text: `base ${session.shortSha}` });

    const c = session.baseCommit;
    if (c) {
      sub.createSpan({ cls: 'lgd-sep', text: ' · ' });
      sub.createSpan({ cls: 'lgd-subject', text: `"${c.subject}"` });
      sub.createSpan({ cls: 'lgd-sep', text: ' · ' });
      // Relative age answers "how far back am I?" at a glance; the absolute local time
      // (AM/PM, never 24h or ISO) is the precision behind it, on hover.
      const rel = sub.createSpan({ cls: 'lgd-age', text: c.relative });
      rel.setAttr('title', c.date);
    } else if (session.baseRefLabel) {
      sub.createSpan({ cls: 'lgd-sep', text: ' · ' });
      sub.createSpan({ text: session.baseRefLabel });
    }

    // A rename is worth naming: without this the base pane silently shows a file under a
    // name that no longer exists, which looks like a bug rather than like history.
    if (session.baseReadAs) {
      sub.createSpan({ cls: 'lgd-sep', text: ' · ' });
      sub.createSpan({ cls: 'lgd-renamed', text: `was ${session.baseReadAs}` });
    }

    const counts = header.createDiv({ cls: 'lgd-sub' });
    counts.createSpan({
      text: `${session.counts.blocks} blocks · ${session.counts.changed} changed`,
    });
    this.syncBadgeEl = counts.createSpan({ cls: 'lgd-sync' });
    this.updateSyncBadge();

    // 'markdown-preview-view markdown-rendered' are Obsidian's own reading-view classes.
    // Inheriting them means the base pane is typeset by the SAME css as the real note
    // (theme, font size, spacing) instead of a hand-rolled lookalike that drifts.
    const body = root.createDiv({ cls: 'lgd-body markdown-preview-view markdown-rendered' });
    this.bodyEl = body;
    // Obsidian's reading view is `.markdown-preview-view > .markdown-preview-sizer
    // .markdown-preview-section > <block>`. The sizer is what carries the content
    // padding and reading width; without it the theme's block spacing has nothing to
    // hang off and the pane reads as squished. Mirror the real structure rather than
    // re-deriving the typography ourselves.
    const sizer = body.createDiv({ cls: 'markdown-preview-sizer markdown-preview-section' });

    // Render the BASE version block by block. Because we did the splitting, we own the
    // line map on this side — no getSectionInfo needed here.
    for (const row of session.rows) {
      if (!row.a) {
        // VIEW ZONE (VS Code's term). An 'ins' row exists only in the note, so the base
        // pane is SHORTER than the note by that block's height and every paired block
        // below the run lands too high. We own this DOM, so we can reserve the missing
        // height with an empty element — the trick the note pane denies us (its sizer
        // calls setChildrenInPlace() every scroll tick and rips injections out). Height
        // comes from the note-side counterpart, measured lazily and cached, because the
        // reading view may not have rendered it yet; until it is known the zone is 0px,
        // i.e. exactly the behaviour we'd have without it. One zone PER ROW (not per
        // run) so partial knowledge of a run still narrows the error.
        const sp = sizer.createDiv({ cls: CLS.spacer });
        sp.setAttr(ATTR_ROW, String(row.idx));
        sp.style.height = this.host.zones.insHeight(row.idx) + 'px';
        this.spacerEls.set(row.idx, sp);
        continue;
      }
      const el = sizer.createDiv({ cls: CLS.block });
      el.setAttr('data-line-start', String(row.a.lineStart));
      el.setAttr('data-line-end', String(row.a.lineEnd));
      el.setAttr(ATTR_ROW, String(row.idx));
      this.blockEls.set(row.idx, el);
      if (row.kind === 'del') el.addClass(CLS.del);
      else if (row.kind === 'mod') el.addClass(CLS.mod);
      else el.addClass(CLS.same);

      // sourcePath is '' ON PURPOSE. Any post-processor (notably a side-comments
      // plugin) keys off sourcePath to find a note's annotations. Passing the real path
      // would paint the CURRENT note's comment marks onto this OLD text, anchored to
      // lines that no longer mean the same thing. '' resolves to no note, so those
      // processors no-op here. Verified live: no stray comment marks on the old version.
      // Cost: relative links/embeds in the base pane won't resolve. See README.
      await MarkdownRenderer.render(this.app, row.a.text, el, '', this);
    }

    // This pane's scroll listener must follow the freshly-created body element.
    this.host.sync.attach();
    // Every base block is now rendered and measurable, which is precisely the moment the
    // deletion zones become exactly knowable. Deferred one frame: rects read
    // synchronously after a large DOM build can predate the layout that
    // MarkdownRenderer's own async work triggers, and a zone computed from a
    // half-laid-out pane is worse than one computed a frame late.
    window.requestAnimationFrame(() => {
      if (!this.bodyEl || !this.bodyEl.isConnected) return; // re-rendered since
      this.host.zones.refresh(true);
    });
  }

  updateSyncBadge(): void {
    if (!this.syncBadgeEl) return;
    this.syncBadgeEl.setText(this.host.sync.enabled ? ' · sync on' : ' · sync off');
  }

  async onClose(): Promise<void> {
    this.bodyEl = null;
    this.blockEls = new Map();
    this.spacerEls = new Map();
    // Nothing else to tear down; child components are unloaded with this view.
  }
}
