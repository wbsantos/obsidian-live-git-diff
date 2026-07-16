#!/usr/bin/env node
/**
 * capture-sections.mjs — capture Obsidian's OWN sectioning of a file, as a test oracle.
 *
 * WHY THIS EXISTS
 * ---------------
 * Our block splitter has to agree with Obsidian's sectioning, and Obsidian's sectioning
 * is closed source. Agreement therefore cannot be argued — it has to be MEASURED. This
 * tool asks a running Obsidian for `metadataCache.getFileCache(file).sections`, which is
 * the same sectioning the renderer uses, and writes it to a fixture that
 * test/grain-oracle.test.ts asserts against.
 *
 * It is not a reimplementation of Obsidian's sectioner. A reimplementation would only
 * prove our splitter agrees with our own second guess — the definition of a fake oracle.
 * That is why this tool talks to the real app, and why the test SKIPS rather than
 * substituting a guess when the fixture is absent.
 *
 * The bug that justifies all of this: on a real 767-line document, Obsidian reported 308
 * sections where our splitter produced 270. All 38 of the gap were a paragraph followed
 * immediately by a list — which our "run of non-blank lines" grain merged into one block
 * and Obsidian renders as two. A merged base block is ONE element where the note has
 * TWO, so the pair has different heights and every block below it drifts. Fixing that one
 * rule took mid-document drift from 40px to 0px.
 *
 * USAGE
 * -----
 *   1. Quit Obsidian, then relaunch it with the debugging port open:
 *        open -a Obsidian --args --remote-debugging-port=9222        # macOS
 *        obsidian --remote-debugging-port=9222                       # Linux/Windows
 *   2. Copy the corpus into ANY vault (a scratch vault is ideal — nothing is written):
 *        cp test/fixtures/corpus-head.md /path/to/SomeVault/
 *   3. Open that note in Obsidian so the vault window exists, then:
 *        npm run capture-oracle -- --window "SomeVault" --file "corpus-head.md"
 *   4. Commit the fixture it writes (test/fixtures/obsidian-sections.json).
 *
 * READ-ONLY: this tool only reads. It opens no file for writing in the vault, and the
 * expression it evaluates calls `cachedRead` and `getFileCache` — both read APIs.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const WINDOW = arg('window', null);
const FILE = arg('file', 'corpus-head.md');
const PORT = arg('port', '9222');
const OUT = path.resolve(HERE, '..', arg('out', 'test/fixtures/obsidian-sections.json'));

if (!WINDOW) {
  console.error('usage: npm run capture-oracle -- --window "<vault or window title substring>" [--file corpus-head.md] [--port 9222]');
  process.exit(64);
}

/* ---- find the window ------------------------------------------------ */
let targets;
try {
  targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
} catch (e) {
  console.error(
    `Cannot reach Obsidian's debugging port on 127.0.0.1:${PORT}.\n` +
    `Relaunch Obsidian with --remote-debugging-port=${PORT} (see the header of this file).\n` +
    `${e.message}`
  );
  process.exit(69);
}

const pages = targets.filter((t) => t.type === 'page');
const target = pages.find((t) => (t.title || '').includes(WINDOW));
if (!target) {
  console.error(`No Obsidian window matching ${JSON.stringify(WINDOW)}.\nAvailable windows:`);
  for (const p of pages) console.error('  -', p.title);
  process.exit(65);
}

/* ---- ask it for the sectioning -------------------------------------- */
// Content and sections are read in ONE evaluation so they are guaranteed to describe the
// same bytes. Capturing them separately would let an edit land in between and produce an
// oracle that silently describes a file that no longer exists.
const expression = `
const f = app.vault.getAbstractFileByPath(${JSON.stringify(FILE)});
if (!f) return JSON.stringify({ error: 'not-found', files: app.vault.getMarkdownFiles().map(x => x.path).slice(0, 40) });
const text = await app.vault.cachedRead(f);
const cache = app.metadataCache.getFileCache(f);
if (!cache) return JSON.stringify({ error: 'no-cache' });
return JSON.stringify({
  path: f.path,
  text,
  apiVersion: (window.require ? require('obsidian').apiVersion : null),
  sections: (cache.sections || []).map(s => ({
    type: s.type,
    startLine: s.position.start.line,
    endLine: s.position.end.line,
  })),
});
`;

const ws = new WebSocket(target.webSocketDebuggerUrl);
const reply = new Promise((res, rej) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id === 1) res(m);
  };
  ws.onerror = rej;
  setTimeout(() => rej(new Error('timed out waiting for Obsidian to answer')), 20000);
});
await new Promise((r) => { ws.onopen = r; });
// Not strictly required here — metadataCache is parsed at load and does not depend on
// the renderer — but it costs nothing and it is required for any measurement that reads
// the rendered view (Chromium throttles rAF in unfocused windows, which freezes
// Obsidian's virtual renderer and makes it report 2 sections for an 83KB note).
ws.send(JSON.stringify({ id: 99, method: 'Page.bringToFront' }));
await new Promise((r) => setTimeout(r, 300));
ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    expression: `(async()=>{${expression}})()`,
    returnByValue: true,
    awaitPromise: true,
  },
}));

const msg = await reply;
ws.close();

if (msg.result?.exceptionDetails) {
  console.error('Obsidian threw:', JSON.stringify(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails, null, 1));
  process.exit(70);
}

const payload = JSON.parse(msg.result.result.value);
if (payload.error === 'not-found') {
  console.error(`No file ${JSON.stringify(FILE)} in that vault. Copy the corpus in first. Markdown files there:`);
  for (const p of payload.files) console.error('  -', p);
  process.exit(66);
}
if (payload.error) {
  console.error('Obsidian could not provide a metadata cache for that file:', payload.error);
  process.exit(70);
}

/* ---- write the fixture ---------------------------------------------- */
// The sha256 of the exact text Obsidian sectioned is the ANTI-STALENESS DEVICE: the test
// re-hashes its local corpus and refuses to run against an oracle captured from
// different bytes. Without it, editing the corpus would leave a stale oracle quietly
// "passing".
const sha256 = crypto.createHash('sha256').update(payload.text, 'utf8').digest('hex');
const fixture = {
  _comment: [
    "Obsidian's OWN sectioning of test/fixtures/corpus-head.md, used as the grain oracle.",
    'Captured by tools/capture-sections.mjs from a running Obsidian over CDP.',
    'Regenerate with: npm run capture-oracle -- --window "<vault>" --file "corpus-head.md"',
    'sourceSha256 must match the local corpus, or the oracle is stale and the test fails.',
  ],
  capturedAt: new Date().toISOString(),
  obsidianApiVersion: payload.apiVersion,
  sourceFile: 'test/fixtures/corpus-head.md',
  sourceSha256: sha256,
  sectionCount: payload.sections.length,
  sections: payload.sections,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n', 'utf8');

console.log(`Captured ${payload.sections.length} sections from ${payload.path}`);
console.log(`  Obsidian API version: ${payload.apiVersion}`);
console.log(`  source sha256: ${sha256}`);
console.log(`  written to: ${path.relative(process.cwd(), OUT)}`);
console.log('\nNow run: npm test');
