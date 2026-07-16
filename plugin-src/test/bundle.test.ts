/**
 * bundle.test.ts — does the thing we ship actually load?
 *
 * A typecheck proves the SOURCE is consistent. It does not prove the BUNDLE is loadable,
 * and the two came apart in the spike in the most expensive way available: a relative
 * `require('./mddiff')` typechecked, linted, and read correctly, then silently resolved
 * to nothing inside Obsidian, because Obsidian evaluates a plugin's main.js without
 * relative-module resolution. The plugin loaded. The feature was just dead.
 *
 * So this test does what Obsidian does: it evaluates the built bundle as CommonJS with
 * `obsidian` supplied from outside, and checks that a Plugin class comes back. It cannot
 * catch a runtime bug inside a view, but it does catch the whole class of "the bundle is
 * broken in a way no other check looks at" — bad format, missing export, an import that
 * resolves to undefined, or a module-scope throw.
 *
 * Requires the bundle: run `npm run build` first (`npm run ci` does both).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.resolve(ROOT, '..', 'plugin-dist');
const BUNDLE = path.join(DIST, 'main.js');

const built = fs.existsSync(BUNDLE);
const skip = !built && 'run `npm run build` first';

/**
 * A stand-in for the `obsidian` module, which only exists inside the app.
 * Just enough shape for the bundle's module scope to evaluate: every class the plugin
 * extends or instantiates at load time.
 */
function makeObsidianStub(): Record<string, unknown> {
  class Component { }
  class Plugin extends Component {
    app: unknown;
    manifest: unknown;
    constructor(app: unknown, manifest: unknown) { super(); this.app = app; this.manifest = manifest; }
  }
  class ItemView extends Component { constructor(_leaf: unknown) { super(); } }
  class PluginSettingTab { constructor(_app: unknown, _plugin: unknown) { } }
  class Setting { constructor(_el: unknown) { } }
  class Notice { constructor(_msg: string, _t?: number) { } }
  class MarkdownView extends Component { }
  class TFile { }
  class WorkspaceLeaf { }
  // Every class the bundle EXTENDS is evaluated at module scope, so a missing one is a
  // load-time TypeError rather than a runtime surprise. That is the point of this test:
  // adding `refPicker.ts` (which extends SuggestModal) broke bundle loading, and this
  // stub is what noticed.
  class Modal { constructor(_app: unknown) { } }
  class SuggestModal extends Modal {
    emptyStateText = '';
    setPlaceholder(_s: string): void { /* no-op */ }
    setInstructions(_i: unknown): void { /* no-op */ }
  }
  return {
    Component, Plugin, ItemView, PluginSettingTab, Setting, Notice,
    MarkdownView, TFile, WorkspaceLeaf, Modal, SuggestModal,
    MarkdownRenderer: { render: async () => undefined },
    apiVersion: '1.4.0',
  };
}

/** Evaluate the bundle the way Obsidian does, with `obsidian` injected. */
function loadBundle(): unknown {
  const stub = makeObsidianStub();
  const M = Module as unknown as {
    _load: (r: string, p: unknown, m: boolean) => unknown;
  };
  const original = M._load;
  M._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'obsidian') return stub;
    return original.call(this, request, parent, isMain);
  };
  try {
    const require_ = Module.createRequire(import.meta.url);
    delete require_.cache[require_.resolve(BUNDLE)];
    return require_(BUNDLE);
  } finally {
    M._load = original;
  }
}

test('bundle: parses as JavaScript', { skip }, () => {
  // The cheapest possible check, kept because it localises a syntax error to the bundle
  // rather than to whatever fails next.
  const r = spawnSync(process.execPath, ['--check', BUNDLE], { encoding: 'utf8' });
  assert.equal(r.status, 0, `node --check failed:\n${r.stderr}`);
});

test('bundle: evaluates and exports a Plugin subclass', { skip }, () => {
  const mod = loadBundle() as { default?: unknown };
  // esbuild's cjs output puts an `export default` on `.default`; Obsidian reads that.
  const Exported = (mod && mod.default ? mod.default : mod) as new (...a: unknown[]) => unknown;
  assert.equal(typeof Exported, 'function', 'the bundle exports a constructor');
  assert.ok(/class/.test(Exported.toString()), 'and it is a class');
  assert.equal(Exported.name, 'LiveGitDiffPlugin');
});

test('bundle: the exported class can be constructed without touching a vault', { skip }, () => {
  // Construction must not read, write, or spawn anything: Obsidian instantiates every
  // plugin at startup, before onload.
  const mod = loadBundle() as { default?: unknown };
  const Exported = (mod && mod.default ? mod.default : mod) as new (a: unknown, m: unknown) => unknown;
  const app = {};
  const manifest = { id: 'live-git-diff', version: '0.1.0' };
  assert.doesNotThrow(() => new Exported(app, manifest));
});

test('bundle: is CommonJS, not ESM', { skip }, () => {
  // Obsidian evaluates main.js as CJS. An `export` statement here means the format was
  // misconfigured, and the plugin would fail to load with a syntax error at runtime.
  const text = fs.readFileSync(BUNDLE, 'utf8');
  assert.ok(!/^\s*export\s+(default|const|class|function|\{)/m.test(text), 'no ESM export statements');
  assert.match(text, /module\.exports/, 'assigns module.exports');
});

test('bundle: does not inline the obsidian API', { skip }, () => {
  // `obsidian` must stay external — bundling a copy would both bloat the file and use a
  // different class identity than the host, so `instanceof` checks would fail.
  const text = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(text, /require\("obsidian"\)/, 'obsidian is required, not inlined');
});

test('dist: ships exactly the three files Obsidian loads', { skip }, () => {
  for (const f of ['main.js', 'manifest.json', 'styles.css']) {
    assert.ok(fs.existsSync(path.join(DIST, f)), `plugin-dist/${f} exists`);
  }
});

test('dist: manifest is valid and matches package.json', { skip }, () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  // Obsidian's required manifest keys.
  for (const k of ['id', 'name', 'version', 'minAppVersion', 'description', 'author']) {
    assert.ok(manifest[k], `manifest.${k} is present`);
  }
  assert.equal(manifest.version, pkg.version, 'manifest and package versions agree');
  assert.equal(manifest.isDesktopOnly, true, 'this plugin shells out to git — desktop only');
  // Community guideline: the id must not contain "obsidian".
  assert.ok(!/obsidian/i.test(manifest.id), 'plugin id does not contain "obsidian"');
  assert.match(manifest.id, /^[a-z0-9-]+$/, 'id is lowercase-kebab');
  // Community guideline: description is a sentence that says what it does.
  assert.ok(manifest.description.endsWith('.'), 'description ends with a period');
  assert.ok(manifest.description.length <= 250, 'description is short');
});

test('dist: versions.json maps this version to a minAppVersion', { skip }, () => {
  // Obsidian uses versions.json to decide which plugin release an older app may install.
  // A missing entry for the current version means older apps get an incompatible build.
  const versions = JSON.parse(fs.readFileSync(path.join(ROOT, 'versions.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  assert.ok(versions[manifest.version], `versions.json has an entry for ${manifest.version}`);
  assert.equal(versions[manifest.version], manifest.minAppVersion, 'and it matches minAppVersion');
});

test('styles: every class the code uses is defined in styles.css, and vice versa', { skip }, () => {
  // The spike used sp2a-/sp2b- prefixes; this build renamed them all to lgd-. A rename
  // like that is exactly where a class silently stops matching its rule and a decoration
  // just... stops appearing, with nothing failing. This makes that drift a test failure.
  const css = fs.readFileSync(path.join(DIST, 'styles.css'), 'utf8');
  const js = fs.readFileSync(BUNDLE, 'utf8');

  // CSS side: a class is a token after a dot. `--lgd-*` custom properties are excluded
  // for free, since they are never preceded by one.
  const cssClasses = new Set(Array.from(css.matchAll(/\.(lgd-[a-z0-9-]+)/g), (m) => m[1]));

  // JS side: class names live INSIDE string literals, and a literal often holds several
  // ('lgd-body markdown-preview-view markdown-rendered'), so scan within strings rather
  // than requiring the class to be the whole string. Two exclusions, both via the
  // lookbehind: `--lgd-ins-bg` is a CSS variable and `data-lgd-char` is an attribute —
  // neither is a class, and both are preceded by a hyphen.
  const jsClasses = new Set<string>();
  for (const [, body] of js.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
    for (const [tok] of body.matchAll(/(?<!-)\blgd-[a-z0-9-]+/g)) jsClasses.add(tok);
  }

  const usedButUndefined = [...jsClasses].filter((c) => !cssClasses.has(c));
  const definedButUnused = [...cssClasses].filter((c) => !jsClasses.has(c));

  assert.deepEqual(usedButUndefined, [], 'classes used in code but with no CSS rule');
  assert.deepEqual(definedButUnused, [], 'CSS rules for classes no code applies');
});

test('styles: no spike-era class names survive', { skip }, () => {
  const css = fs.readFileSync(path.join(DIST, 'styles.css'), 'utf8');
  const js = fs.readFileSync(BUNDLE, 'utf8');
  assert.doesNotMatch(css, /sp2[ab]-/, 'styles.css is free of spike prefixes');
  assert.doesNotMatch(js, /sp2[ab]-/, 'the bundle is free of spike prefixes');
});
