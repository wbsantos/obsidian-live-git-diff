/**
 * settings.ts — user-facing configuration, and the ONLY place this plugin persists
 * anything at all.
 *
 * PERSISTENCE SCOPE — read this before changing it.
 * Obsidian's plugin-data API writes <vault>/.obsidian/plugins/live-git-diff/data.json:
 * this plugin's own config file, created by the plugin API, deleted when the plugin is
 * uninstalled. It is NOT a note, and `persistSettings` below is the single call site in
 * the entire codebase — tools/check-invariant.mjs PINS that fact (exact file, exact
 * count) and fails the build if another one appears anywhere else. The read-only
 * invariant this plugin sells is "it cannot write to your NOTES"; keeping config
 * persistence to one declared, asserted line is how that claim stays checkable rather
 * than a promise. See README "Read-only invariant" for the full argument.
 *
 * NOTE ON PHRASING: the gate matches CALLS (name + open paren), so prose here names the
 * method without parentheses on purpose. Do not "fix" that — see check-invariant.mjs.
 */
import { App, PluginSettingTab, Setting } from 'obsidian';
import type { Plugin } from 'obsidian';

/**
 * The five diff colors.
 *
 * WHY FIVE AND NOT NINE: the palette is deliberately economical (see README). A 'mod'
 * block is not a third color — it is the ins wash on the new side and the del wash on
 * the old side, which is VS Code's actual design. The word-level marks are not a
 * fourth and fifth color either: they are the SAME color painted twice, letting
 * alpha compositing darken the changed words. So these five knobs reach every pixel
 * of the diff.
 */
export interface DiffColors {
  /** Wash behind inserted text (and the new side of a modification). */
  insBg: string;
  /** Wash behind deleted text (and the old side of a modification). */
  delBg: string;
  /** Rail beside a wholly inserted block. */
  insRail: string;
  /** Rail beside a wholly deleted block. */
  delRail: string;
}

/**
 * Which commit a review defaults to.
 *
 * `head` was the only option in v1, and it assumed the changes under review are sitting
 * UNCOMMITTED in the working tree. That assumption breaks for the workflow this plugin
 * was actually built for: when an agent commits constantly (so that reverting is cheap),
 * the changes are already committed by the time anyone reviews them — often across
 * several commits — and a working-tree-vs-HEAD diff shows precisely nothing.
 *
 * Hence `file-prev` and `custom`, and hence the commit picker, which is the primary way
 * to answer this per-review. These settings only choose the DEFAULT.
 */
export type BaseRefMode = 'head' | 'head~1' | 'file-prev' | 'custom';

export interface LiveGitDiffSettings {
  /**
   * Color OVERRIDES. An empty string means "use the built-in default", which is
   * theme-aware (GitHub Light Default / GitHub Dark Default). An override is a single
   * value that applies in BOTH themes — see README "Known limitations".
   */
  colors: DiffColors;
  /** Which commit a plain "Open git diff review" pins. See BaseRefMode. */
  baseRefMode: BaseRefMode;
  /** Used only when baseRefMode === 'custom'. */
  baseRef: string;
  /** How many commits the picker lists. */
  logLimit: number;
  /** Verbose console logging. Warnings and errors are always on regardless. */
  debug: boolean;
}

export const DEFAULT_SETTINGS: LiveGitDiffSettings = {
  colors: { insBg: '', delBg: '', insRail: '', delRail: '' },
  baseRefMode: 'head',
  baseRef: 'main',
  logLimit: 50,
  debug: false,
};

/** CSS custom property backing each color. Must match styles.css. */
const CSS_VAR: Record<keyof DiffColors, string> = {
  insBg: '--lgd-ins-bg',
  delBg: '--lgd-del-bg',
  insRail: '--lgd-ins-rail',
  delRail: '--lgd-del-rail',
};

/** Built-in light-theme values, shown as the placeholder so the field is discoverable. */
const LIGHT_DEFAULT: DiffColors = {
  insBg: '#6fdd8b80',
  delBg: '#ff818266',
  insRail: '#4ac26b66',
  delRail: '#ff818266',
};

const FIELD_LABEL: Record<keyof DiffColors, { name: string; desc: string }> = {
  insBg: {
    name: 'Inserted text',
    desc: 'Wash behind added blocks, and behind the NEW side of a changed block. The changed words get a second coat of this same color.',
  },
  delBg: {
    name: 'Deleted text',
    desc: 'Wash behind removed blocks, and behind the OLD side of a changed block, in the base pane.',
  },
  insRail: { name: 'Rail — added', desc: 'The 4px bar beside a wholly new block.' },
  delRail: { name: 'Rail — removed', desc: 'The 4px bar beside a wholly removed block.' },
};

/**
 * Is `v` something CSS will actually accept as a color?
 *
 * Validated rather than pattern-matched: these fields take ANY css color, because
 * translucency is the entire design (see README — GitHub's palette works by hue, and
 * the alpha is what keeps a wash readable behind text). A regex for #rrggbbaa would
 * reject `color-mix(...)`, `oklch(...)` and `rgb(0 0 0 / 20%)` for no reason.
 */
export function isValidColor(v: string): boolean {
  const s = String(v || '').trim();
  if (!s) return true; // empty = "use the default", always valid
  if (typeof CSS === 'undefined' || !CSS.supports) return true; // no validator here; let CSS decide
  return CSS.supports('color', s);
}

/**
 * Push color overrides onto the document as inline custom properties.
 *
 * WHY document.body AND WHY INLINE: styles.css declares the defaults on `body` and the
 * dark variants on `body.theme-dark`. An inline style on the same element outranks both
 * selectors without any !important arms race, and clearing it falls straight back to
 * the theme-aware defaults. One place to write, one place to clear.
 *
 * Pop-out windows are separate documents; each gets the same treatment via
 * `app.workspace.containerEl.ownerDocument` walks would be the thorough version —
 * v1 sets the main document only. See README "Known limitations".
 */
export function applyColors(settings: LiveGitDiffSettings): void {
  const body = document.body;
  if (!body) return;
  (Object.keys(CSS_VAR) as Array<keyof DiffColors>).forEach((k) => {
    const v = String(settings.colors[k] || '').trim();
    if (v && isValidColor(v)) body.style.setProperty(CSS_VAR[k], v);
    else body.style.removeProperty(CSS_VAR[k]);
  });
}

/** Remove every property we set. Called on unload — leave no trace. */
export function clearColors(): void {
  const body = document.body;
  if (!body) return;
  (Object.values(CSS_VAR)).forEach((v) => body.style.removeProperty(v));
}

/**
 * The host this tab needs. Narrower than the whole plugin on purpose: the tab should
 * not be able to reach into the review session.
 */
export interface SettingsHost extends Plugin {
  settings: LiveGitDiffSettings;
  saveSettings(): Promise<void>;
}

/**
 * THE ONLY PERSISTENCE CALL IN THE CODEBASE. Pinned by tools/check-invariant.mjs:
 * exactly one call site, in exactly this file. Writes plugin config
 * (.obsidian/plugins/live-git-diff/data.json) — never a note.
 */
export async function persistSettings(plugin: SettingsHost): Promise<void> {
  await plugin.saveData(plugin.settings);
}

/** Merge stored config over the defaults, tolerating a partial/older data.json. */
export function mergeSettings(loaded: unknown): LiveGitDiffSettings {
  const l = (loaded || {}) as Partial<LiveGitDiffSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...l,
    // Nested object: a spread alone would replace the whole colors block with a
    // partial one from an older data.json and leave the new keys undefined.
    colors: { ...DEFAULT_SETTINGS.colors, ...(l.colors || {}) },
  };
}

export class LiveGitDiffSettingTab extends PluginSettingTab {
  private plugin: SettingsHost;

  constructor(app: App, plugin: SettingsHost) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    /* ---- base version ---------------------------------------------------- */
    new Setting(containerEl).setName('Base version').setHeading();

    const pickerNote = containerEl.createEl('p', { cls: 'lgd-settings-note' });
    pickerNote.setText(
      'To choose a version per review, use the command "Open review against a version…" — ' +
      'the Git History sidebar stays on the chosen file. Select one or two versions, then choose Compare. These settings decide ' +
      'what the note-header Compare action, Git Compare menu and plain "Open git diff review" command compare against.'
    );

    new Setting(containerEl)
      .setName('Compare against by default')
      .setDesc(
        'Whichever you pick is resolved to a commit when the review opens, and that commit ' +
        'is then pinned for the session — so the diff cannot shrink while something else ' +
        'commits to the repo mid-review.'
      )
      .addDropdown((d) =>
        d
          .addOption('head', 'The latest commit (HEAD)')
          .addOption('head~1', 'One commit before HEAD (HEAD~1)')
          .addOption('file-prev', 'This file\'s previous version')
          .addOption('custom', 'A specific ref…')
          .setValue(this.plugin.settings.baseRefMode)
          .onChange(async (v) => {
            this.plugin.settings.baseRefMode = v as BaseRefMode;
            await this.plugin.saveSettings();
            this.display(); // show/hide the ref field
          })
      );

    if (this.plugin.settings.baseRefMode === 'head') {
      const warn = containerEl.createEl('p', { cls: 'lgd-settings-note' });
      // Said out loud because it is the single most confusing outcome this plugin has:
      // a clean working tree against HEAD is an empty diff, which looks like the plugin
      // is broken rather than like a correct answer to the question that was asked.
      warn.setText(
        'Note: comparing against HEAD shows your UNCOMMITTED changes. If your work is ' +
        'already committed, this diff will be empty — pick a version instead.'
      );
    }

    if (this.plugin.settings.baseRefMode === 'file-prev') {
      const note = containerEl.createEl('p', { cls: 'lgd-settings-note' });
      note.setText(
        'The commit before the most recent one that touched this file — i.e. "what changed ' +
        'in the last edit to this document", regardless of what else was committed since.'
      );
    }

    if (this.plugin.settings.baseRefMode === 'custom') {
      new Setting(containerEl)
        .setName('Ref')
        .setDesc(
          'Anything git resolves: main, origin/main, v1.2, HEAD~5, a sha, main@{yesterday}.'
        )
        .addText((t) =>
          t
            .setPlaceholder('main')
            .setValue(this.plugin.settings.baseRef)
            .onChange(async (v) => {
              this.plugin.settings.baseRef = v.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName('Versions to list')
      .setDesc('How many commits to load per page in the Git history sidebar.')
      .addSlider((s) =>
        s
          .setLimits(10, 200, 10)
          .setValue(this.plugin.settings.logLimit)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.logLimit = v;
            await this.plugin.saveSettings();
          })
      );

    /* ---- colors --------------------------------------------------------- */
    new Setting(containerEl).setName('Colors').setHeading();

    const note = containerEl.createEl('p', { cls: 'lgd-settings-note' });
    note.setText(
      'Defaults are GitHub\'s diff palette and follow your light/dark theme. Any CSS color works — ' +
      'including alpha, which matters: these are washes that sit behind text, and the defaults are ' +
      'translucent on purpose. Leave a field empty to use the default. An override applies to both themes.'
    );

    (Object.keys(CSS_VAR) as Array<keyof DiffColors>).forEach((key) => {
      const label = FIELD_LABEL[key];
      let swatch: HTMLElement | null = null;

      const setting = new Setting(containerEl)
        .setName(label.name)
        .setDesc(label.desc)
        .addText((t) => {
          t.setPlaceholder(LIGHT_DEFAULT[key])
            .setValue(this.plugin.settings.colors[key])
            .onChange(async (v) => {
              const val = v.trim();
              const ok = isValidColor(val);
              t.inputEl.toggleClass('lgd-invalid', !ok);
              // An invalid color is NOT saved: persisting it would leave a field that
              // silently does nothing and a user hunting a bug in the wrong place.
              if (!ok) return;
              this.plugin.settings.colors[key] = val;
              await this.plugin.saveSettings();
              if (swatch) swatch.style.background = val || LIGHT_DEFAULT[key];
            });
          t.inputEl.addClass('lgd-color-input');
          return t;
        });

      // A live swatch. The value is translucent, so it is shown over a text sample —
      // a solid chip would misrepresent what the color actually looks like in use.
      swatch = setting.controlEl.createDiv({ cls: 'lgd-swatch', text: 'abc' });
      swatch.style.background = this.plugin.settings.colors[key] || LIGHT_DEFAULT[key];
    });

    new Setting(containerEl)
      .setName('Reset colors')
      .setDesc('Clear all five overrides and go back to the theme-aware defaults.')
      .addButton((b) =>
        b.setButtonText('Reset').onClick(async () => {
          this.plugin.settings.colors = { ...DEFAULT_SETTINGS.colors };
          await this.plugin.saveSettings();
          this.display();
        })
      );

    /* ---- debug ----------------------------------------------------------- */
    new Setting(containerEl).setName('Advanced').setHeading();

    new Setting(containerEl)
      .setName('Debug logging')
      .setDesc(
        'Verbose console output, and extra detail in the alignment report. ' +
        'Warnings and errors are logged regardless of this setting.'
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debug).onChange(async (v) => {
          this.plugin.settings.debug = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
