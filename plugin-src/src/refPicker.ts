/**
 * refPicker.ts — choose which commit to review against.
 *
 * WHY A PICKER AND NOT A TEXT BOX. Nobody memorises shas. The question a reviewer
 * actually has is "how far back do I want to go?", and the answer is recognised by
 * SUBJECT and AGE — "apply review round 1, 7 hours ago" — never by `d308280`. A per-file
 * log is short and every entry in it is, by construction, a version of this document
 * that once existed. A free-text ref field is still available in settings for the cases
 * a list cannot express (a branch, a tag, `main@{yesterday}`), but it is the fallback,
 * not the front door.
 *
 * The list comes from `git log --follow`, so it survives renames: history does not
 * truncate at the point the file got its current name.
 */
import { SuggestModal } from 'obsidian';
import type { App } from 'obsidian';
import type { CommitInfo } from './git.ts';

export class CommitPickerModal extends SuggestModal<CommitInfo> {
  private commits: CommitInfo[];
  private onPick: (c: CommitInfo) => void;

  constructor(app: App, fileName: string, commits: CommitInfo[], onPick: (c: CommitInfo) => void) {
    super(app);
    this.commits = commits;
    this.onPick = onPick;
    this.setPlaceholder(`Review ${fileName} against which version?`);
    this.emptyStateText = 'No commits match. This file may have no history yet.';
    this.setInstructions([
      { command: '↑↓', purpose: 'navigate' },
      { command: '↵', purpose: 'pin as base' },
      { command: 'esc', purpose: 'cancel' },
    ]);
  }

  getSuggestions(query: string): CommitInfo[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.commits;
    // Subject, sha, AND both date forms are searchable: "round 1", "d308280", "8 days",
    // and "Jul 7" are all things someone plausibly types to find the same commit.
    return this.commits.filter((c) =>
      c.subject.toLowerCase().includes(q) ||
      c.sha.toLowerCase().startsWith(q) ||
      c.relative.toLowerCase().includes(q) ||
      c.date.toLowerCase().includes(q)
    );
  }

  renderSuggestion(c: CommitInfo, el: HTMLElement): void {
    // DOM API, never innerHTML — a commit subject is untrusted text, and the invariant
    // gate rejects innerHTML outright.
    el.addClass('lgd-pick');

    // The SUBJECT leads. It is the only field a person recognises.
    el.createDiv({ cls: 'lgd-pick-subject', text: c.subject });

    const meta = el.createDiv({ cls: 'lgd-pick-meta' });
    // Relative first: "how far back am I going?" is the question being asked, and it is
    // answerable at a glance. The absolute time is the precision behind it.
    meta.createSpan({ cls: 'lgd-pick-rel', text: c.relative });
    meta.createSpan({ cls: 'lgd-sep', text: ' · ' });
    meta.createSpan({ cls: 'lgd-pick-date', text: c.date });
    meta.createSpan({ cls: 'lgd-sep', text: ' · ' });
    meta.createSpan({ cls: 'lgd-pick-sha', text: c.shortSha });

    // Only shown when it differs — a silent rename is exactly the surprise worth naming,
    // since the base pane will be reading the file under a name that no longer exists.
    if (c.path && c.path !== this.currentPath) {
      meta.createSpan({ cls: 'lgd-sep', text: ' · ' });
      meta.createSpan({ cls: 'lgd-pick-renamed', text: `was ${c.path}` });
    }
  }

  /** The file's path today, so a renamed entry can be flagged. Set by the caller. */
  currentPath = '';

  onChooseSuggestion(c: CommitInfo): void {
    this.onPick(c);
  }
}
