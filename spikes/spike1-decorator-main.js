'use strict';

/*
 * spike1-decorator — THROWAWAY SPIKE PLUGIN
 *
 * PURPOSE
 *   Decorate the RENDERED READING VIEW with FAKE diff marks so we can observe
 *   whether a co-installed plugin ("side-comments") still resolves its
 *   word-level comment anchors on decorated DOM.
 *
 * HARD INVARIANT — THIS PLUGIN NEVER WRITES TO NOTES.
 *   No mutating Vault API calls (modify/process/create/delete/append), no Vault
 *   adapter writes, no Editor mutation, no MetadataCache writes.
 *   It ONLY styles / rearranges the rendered DOM of the reading view, and
 *   (for the diagnostic command) writes a JSON report to a scratchpad path
 *   OUTSIDE the vault via node's fs. Mode state is kept IN MEMORY ONLY —
 *   not even plugin data.json is written.
 *   Mirrors the read-only posture of the render-only markup plugin.
 *
 * Verify with:
 *   grep -nE 'vault\.(modify|process|create|delete|append|adapter)|editor\.(replace|setValue|transaction|setLine)|\.write\(' main.js
 *   -> must return no matches.
 */

const obsidian = require('obsidian');
const fs = require('fs');
const path = require('path');

/** Where the diagnostic command drops its JSON report (outside any vault). */
const REPORT_PATH =
  '/tmp/spike-scratch/spike1-dom-report.json';

const MODE_OFF = 'OFF';
const MODE_BLOCK_ONLY = 'BLOCK_ONLY';
const MODE_WORD_LEVEL = 'WORD_LEVEL';

const CLASS_ADDED = 'spike-added';
const CLASS_MODIFIED = 'spike-modified';
const CLASS_CHAR_INSERT = 'spike-char-insert';

/** Fake, git-free diff classification. This spike is about DOM effects only. */
function fakeDiffKind(lineStart) {
  const m = ((lineStart % 3) + 3) % 3;
  if (m === 0) return 'added';
  if (m === 1) return 'modified';
  return 'unchanged';
}

/** Selector for marks that side-comments (or similar) may have injected. */
const FOREIGN_MARK_SELECTOR =
  '[class*="side-comment"],[class*="comment"],[class*="annotation"],[class*="sc-"]';

/** Collect the text nodes under `root`, skipping code/pre/math subtrees. */
function collectTextNodes(root, doc) {
  const out = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('pre, code, .math, .MathJax, svg')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n = walker.nextNode();
  while (n) {
    out.push(n);
    n = walker.nextNode();
  }
  return out;
}

/**
 * MODE B (adversarial): wrap the first >5-char word in a span, deliberately
 * SPLITTING the text node into up to three nodes. textContent is preserved
 * exactly — we only re-parent the same characters.
 */
function wrapFirstLongWord(el, doc) {
  const textNodes = collectTextNodes(el, doc);
  for (let i = 0; i < textNodes.length; i++) {
    const node = textNodes[i];
    // Don't re-wrap our own or a foreign plugin's mark.
    if (node.parentElement && node.parentElement.closest('.' + CLASS_CHAR_INSERT)) {
      continue;
    }
    const text = node.nodeValue;
    if (!text) continue;
    const re = /[A-Za-z0-9']{6,}/;
    const match = re.exec(text);
    if (!match) continue;

    const start = match.index;
    const end = start + match[0].length;

    // splitText leaves `node` = [0,start), returns tail = [start, ...)
    const tail = start > 0 ? node.splitText(start) : node;
    // split tail so `tail` = the word, remainder stays after it
    if (end - start < tail.nodeValue.length) {
      tail.splitText(end - start);
    }
    const span = doc.createElement('span');
    span.className = CLASS_CHAR_INSERT;
    tail.parentNode.insertBefore(span, tail);
    span.appendChild(tail);
    return match[0];
  }
  return null;
}

module.exports = class Spike1DecoratorPlugin extends obsidian.Plugin {
  onload() {
    // In-memory only — deliberately never persisted (see HARD INVARIANT).
    this.mode = MODE_OFF;

    this.registerMarkdownPostProcessor((el, ctx) => {
      try {
        if (this.mode === MODE_OFF) return;

        const info = ctx && typeof ctx.getSectionInfo === 'function'
          ? ctx.getSectionInfo(el)
          : null;
        if (!info) return; // degrade silently — never throw

        const kind = fakeDiffKind(info.lineStart);
        if (kind === 'unchanged') return;

        el.addClass(kind === 'added' ? CLASS_ADDED : CLASS_MODIFIED);

        if (this.mode === MODE_WORD_LEVEL) {
          const before = el.textContent;
          wrapFirstLongWord(el, el.ownerDocument || document);
          if (el.textContent !== before) {
            console.error('[spike1-decorator] textContent changed — bug!', before, el.textContent);
          }
        }
      } catch (e) {
        console.error('[spike1-decorator] postprocessor error (ignored)', e);
      }
    });

    const setMode = (mode) => {
      this.mode = mode;
      new obsidian.Notice('Spike1 decoration: ' + mode);
      this.rerender();
    };

    this.addCommand({
      id: 'spike-decoration-off',
      name: 'Spike: decoration OFF',
      callback: () => setMode(MODE_OFF),
    });
    this.addCommand({
      id: 'spike-decoration-block-only',
      name: 'Spike: decoration BLOCK_ONLY',
      callback: () => setMode(MODE_BLOCK_ONLY),
    });
    this.addCommand({
      id: 'spike-decoration-word-level',
      name: 'Spike: decoration WORD_LEVEL',
      callback: () => setMode(MODE_WORD_LEVEL),
    });
    this.addCommand({
      id: 'spike-rerender',
      name: 'Spike: rerender',
      callback: () => {
        this.rerender();
        new obsidian.Notice('Spike1: rerender requested (mode ' + this.mode + ')');
      },
    });
    this.addCommand({
      id: 'spike-report-dom',
      name: 'Spike: report DOM',
      callback: () => this.reportDom(),
    });

    console.log('[spike1-decorator] loaded (mode OFF, read-only)');
  }

  onunload() {
    console.log('[spike1-decorator] unloaded');
  }

  /** Ask every markdown leaf to rebuild its view. Best-effort, never throws. */
  rerender() {
    try {
      this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
        if (leaf && typeof leaf.rebuildView === 'function') leaf.rebuildView();
      });
    } catch (e) {
      console.warn('[spike1-decorator] rerender unavailable — toggle reading/edit view manually', e);
    }
  }

  /**
   * DIAGNOSTIC: dump the rendered reading-view DOM to JSON so Claude can verify
   * anchor survival WITHOUT driving the Obsidian UI. Read-only w.r.t. the vault.
   */
  reportDom() {
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    const report = {
      generatedAt: new Date().toISOString(),
      mode: this.mode,
      file: view && view.file ? view.file.path : null,
      viewMode: view && typeof view.getMode === 'function' ? view.getMode() : null,
      blocks: [],
      error: null,
    };

    try {
      if (!view) throw new Error('No active MarkdownView');
      const container =
        (view.previewMode && view.previewMode.containerEl) || view.contentEl;
      if (!container) throw new Error('No preview container — switch to Reading view');

      const blocks = Array.from(container.querySelectorAll('.markdown-preview-section > div'));
      const ctx = view.previewMode;

      blocks.forEach((block, idx) => {
        const el = block.firstElementChild || block;
        let info = null;
        try {
          if (ctx && typeof ctx.getSectionInfo === 'function') info = ctx.getSectionInfo(el);
        } catch (e) {
          info = null;
        }

        const textNodes = collectTextNodes(el, el.ownerDocument || document);
        const foreign = Array.from(el.querySelectorAll(FOREIGN_MARK_SELECTOR)).map(
          (n) => n.outerHTML
        );

        report.blocks.push({
          index: idx,
          lineStart: info ? info.lineStart : null,
          lineEnd: info ? info.lineEnd : null,
          fakeDiffKind: info ? fakeDiffKind(info.lineStart) : null,
          tag: el.tagName,
          classes: el.className,
          textContent: el.textContent,
          textNodeCount: textNodes.length,
          spikeCharInsertCount: el.querySelectorAll('.' + CLASS_CHAR_INSERT).length,
          foreignMarkCount: foreign.length,
          foreignMarksOuterHTML: foreign,
        });
      });
    } catch (e) {
      report.error = String((e && e.message) || e);
    }

    try {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
      new obsidian.Notice(
        'Spike1: DOM report -> ' + REPORT_PATH + ' (' + report.blocks.length + ' blocks)'
      );
    } catch (e) {
      new obsidian.Notice('Spike1: report FAILED — ' + String((e && e.message) || e));
      console.error('[spike1-decorator] report write failed', e);
    }
  }
};
