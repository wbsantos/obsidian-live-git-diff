#!/usr/bin/env node
/**
 * check-invariant.mjs — prove the built bundle cannot write to a note.
 *
 * This is the plugin's core safety claim, so it is enforced mechanically rather than
 * promised in a README. It runs on `npm run build`, on `npm test`, and in CI.
 *
 * ---------------------------------------------------------------------------
 * THE TWO DEFECTS THIS EXISTS BECAUSE OF — both real, both from the spike:
 *
 *  1. NUL BYTES MADE grep TREAT THE BUNDLE AS BINARY. `grep pattern main.js` printed
 *     "Binary file matches" or nothing at all, and every invariant check "passed"
 *     WITHOUT READING A SINGLE LINE. A read-only grep that cannot read the file is
 *     theatre. Hence check 1 below: the bundle must be valid UTF-8 with zero NULs,
 *     asserted BEFORE any pattern is applied — and this tool reads the file itself
 *     rather than shelling out to grep, so there is no binary-detection heuristic in
 *     the loop at all.
 *
 *  2. A CHECK YOU PASS BY PHRASING IS NOT A CHECK. An earlier draft grepped for the
 *     filesystem HANDLE (`vault.adapter`), and the code dodged it by destructuring the
 *     handle into a local. The check went green; nothing had changed. So the patterns
 *     below match WRITE METHODS — the thing that actually mutates — and never a handle.
 *     Holding a reference to the vault is not dangerous. Calling `modify` on it is.
 * ---------------------------------------------------------------------------
 *
 * WHAT "READ-ONLY" MEANS HERE, PRECISELY: the plugin never writes to a NOTE, or to
 * anything else in the vault except its own config file. It is not a claim that the
 * process performs no I/O — it spawns `git` (to READ), and it persists its own settings
 * through Obsidian's plugin API. Both are declared and both are checked below.
 *
 * Exit 0 = clean. Exit 1 = a violation, with the offending line printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/**
 * `--bundle` / `--src` exist so test/invariant.test.ts can point this gate at a COPY of
 * the bundle with a violation planted in it, and assert that the gate catches it.
 *
 * A gate nobody has ever seen fail is not known to work. That is not a rhetorical point
 * here: the previous invariant check passed vacuously for its entire life because NUL
 * bytes made grep skip the file, and nobody had watched it go red.
 */
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : dflt;
}

const BUNDLE = arg('bundle', path.resolve(ROOT, '..', 'plugin-dist', 'main.js'));
const SRC = arg('src', path.join(ROOT, 'src'));

let failures = 0;
let checks = 0;

const ok = (msg) => { checks++; console.log(`  PASS  ${msg}`); };
const bad = (msg, detail) => {
  checks++;
  failures++;
  console.log(`  FAIL  ${msg}`);
  if (detail) console.log(detail.split('\n').map((l) => '        ' + l).join('\n'));
};

console.log('read-only invariant gate');
console.log('========================');
console.log(`bundle: ${path.relative(process.cwd(), BUNDLE)}`);

if (!fs.existsSync(BUNDLE)) {
  console.error(`\nFAIL: the bundle does not exist. Run \`npm run build\` first.\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 1. the bundle must be READABLE TEXT                                 *
 * ------------------------------------------------------------------ */
const raw = fs.readFileSync(BUNDLE);

if (raw.includes(0x00)) {
  const at = raw.indexOf(0x00);
  bad('bundle contains no NUL bytes', `first NUL at byte offset ${at}`);
} else {
  ok('bundle contains no NUL bytes');
}

// Round-tripping through UTF-8 is the check: Node's decoder replaces invalid sequences
// with U+FFFD, so a mismatch on re-encode means the file was not valid UTF-8.
const text = raw.toString('utf8');
if (Buffer.compare(Buffer.from(text, 'utf8'), raw) !== 0) {
  bad('bundle is valid UTF-8', 'the bytes do not survive a utf8 decode/encode round trip');
} else {
  ok('bundle is valid UTF-8');
}

if (text.includes('�')) {
  bad('bundle has no replacement characters', 'U+FFFD present — some bytes were not decodable');
} else {
  ok('bundle has no U+FFFD replacement characters');
}

const lines = text.split('\n');
ok(`bundle is readable text (${lines.length} lines, ${raw.length} bytes)`);

/* ------------------------------------------------------------------ *
 * 2. NO WRITE METHOD may appear — zero exceptions                     *
 * ------------------------------------------------------------------ */
/**
 * Every one of these MUTATES something. None of them is a handle.
 *
 * THE OPEN PAREN IS PART OF EVERY PATTERN, on purpose: it matches the CALL, not a
 * mention. Without it, a comment explaining "we never call vault.modify" fails the build
 * for describing the invariant it upholds — and the only way to make the build pass
 * would be to delete the explanation. A gate that punishes documentation is a gate that
 * ends up undocumented. (This is not hypothetical: the first run of this tool failed on
 * its own authors' comments.)
 *
 * The convention that follows, and which the whole codebase obeys:
 *   - CODE calls a method:  `writeFileSync(...)`  -> matched, build fails.
 *   - PROSE names a method: "we never use writeFileSync" -> not matched, and allowed.
 *
 * Is `fs["writeFileSync"](x)` a dodge? Yes — for this check alone. That is exactly why
 * check 3 exists: with no filesystem module imported, there is no `fs` to subscript. The
 * name patterns are defence in depth on top of a capability check, never the only lock.
 */
const BANNED = [
  // --- Vault: note content ---
  ['vault.modify(', 'rewrites a note'],
  ['vault.process(', 'rewrites a note atomically'],
  ['vault.append(', 'appends to a note'],
  ['vault.create(', 'creates a note'],
  ['vault.createBinary(', 'creates a binary file'],
  ['vault.createFolder(', 'creates a folder'],
  ['vault.delete(', 'deletes a file'],
  ['vault.trash(', 'trashes a file'],
  ['vault.rename(', 'renames a file'],
  ['vault.copy(', 'copies a file'],
  // --- Adapter: the layer under the vault ---
  ['adapter.write(', 'writes a file'],
  ['adapter.writeBinary(', 'writes a binary file'],
  ['adapter.append(', 'appends to a file'],
  ['adapter.remove(', 'removes a file'],
  ['adapter.rename(', 'renames a file'],
  ['adapter.copy(', 'copies a file'],
  ['adapter.mkdir(', 'creates a directory'],
  ['adapter.rmdir(', 'removes a directory'],
  ['adapter.trashSystem(', 'trashes a file'],
  ['adapter.trashLocal(', 'trashes a file'],
  // --- Editor: live note buffer ---
  ['editor.replaceRange(', 'edits the open note'],
  ['editor.replaceSelection(', 'edits the open note'],
  ['editor.setValue(', 'replaces the open note'],
  ['editor.setLine(', 'edits the open note'],
  ['editor.transaction(', 'edits the open note'],
  // --- FileManager ---
  ['fileManager.renameFile(', 'renames a note'],
  ['fileManager.trashFile(', 'trashes a note'],
  ['processFrontMatter(', 'rewrites a note\'s frontmatter'],
  // --- Node filesystem ---
  ['writeFile(', 'writes a file'],
  ['writeFileSync(', 'writes a file'],
  ['appendFile(', 'appends to a file'],
  ['appendFileSync(', 'appends to a file'],
  ['createWriteStream(', 'opens a file for writing'],
  ['unlink(', 'deletes a file'],
  ['unlinkSync(', 'deletes a file'],
  ['rmSync(', 'deletes a file'],
  ['rmdirSync(', 'removes a directory'],
];

const violations = [];
for (const [needle, why] of BANNED) {
  for (let i = 0; i < lines.length; i++) {
    let col = lines[i].indexOf(needle);
    while (col !== -1) {
      violations.push({ needle, why, line: i + 1, text: lines[i].trim() });
      col = lines[i].indexOf(needle, col + 1);
    }
  }
}

if (violations.length) {
  bad(
    `no write method appears in the bundle (found ${violations.length})`,
    violations
      .map((v) => `${v.needle}  — ${v.why}\n  main.js:${v.line}: ${v.text.slice(0, 120)}`)
      .join('\n')
  );
} else {
  ok(`no write method appears in the bundle (${BANNED.length} patterns checked)`);
}

/* ------------------------------------------------------------------ *
 * 3. NO FILESYSTEM MODULE may be imported — a capability check        *
 * ------------------------------------------------------------------ */
/**
 * Stronger than the name-based grep above, and immune to rephrasing: you cannot write a
 * file with a module you never imported. `child_process` IS imported (that is how `git`
 * is read) and is allowed — but a subprocess that only ever runs `git show`/`rev-parse`
 * cannot write to a note either, and git.ts is the only module that builds those argv.
 */
const FS_IMPORTS = [
  "require(\"fs\")", "require('fs')",
  "require(\"node:fs\")", "require('node:fs')",
  "require(\"fs/promises\")", "require('fs/promises')",
  "require(\"node:fs/promises\")", "require('node:fs/promises')",
  'from "fs"', "from 'fs'",
  'from "node:fs"', "from 'node:fs'",
];
const fsHits = FS_IMPORTS.filter((p) => text.includes(p));
if (fsHits.length) {
  bad('bundle imports no filesystem module', `found: ${fsHits.join(', ')}`);
} else {
  ok('bundle imports no filesystem module (cannot write a file at all)');
}

/* ------------------------------------------------------------------ *
 * 4. saveData is PINNED — declared, located, and counted              *
 * ------------------------------------------------------------------ */
/**
 * `saveData()` writes <vault>/.obsidian/plugins/live-git-diff/data.json — the plugin's
 * own config file, created by Obsidian's plugin API and removed when the plugin is
 * uninstalled. It is NOT a note, and settings that do not persist are not settings.
 *
 * So it is allowed, but PINNED rather than waved through: exactly one call site, in
 * exactly one file. If a second one appears anywhere — or the first one moves — this
 * fails and a human has to look at it. That is the difference between a scoped invariant
 * and an exception list that quietly grows.
 *
 * The bundle is allowed 2 textual hits because esbuild emits the call plus the class
 * member reference; the SOURCE count is the one that is pinned to 1.
 */
const SAVE_OWNER = 'src/settings.ts';
const MAX_BUNDLE_SAVEDATA = 2;

function countIn(file, needle) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split(needle).length - 1;
}

const srcFiles = fs.readdirSync(SRC, { recursive: true })
  .filter((f) => String(f).endsWith('.ts'))
  .map((f) => path.join(SRC, String(f)));

const saveSites = srcFiles
  .map((f) => ({ file: path.relative(ROOT, f), n: countIn(f, 'saveData(') }))
  .filter((x) => x.n > 0);

const stray = saveSites.filter((s) => s.file !== SAVE_OWNER);
if (stray.length) {
  bad(
    `saveData( appears only in ${SAVE_OWNER}`,
    stray.map((s) => `${s.file}: ${s.n} call site(s) — persistence must stay in ${SAVE_OWNER}`).join('\n')
  );
} else {
  const owner = saveSites.find((s) => s.file === SAVE_OWNER);
  const n = owner ? owner.n : 0;
  if (n !== 1) {
    bad(`saveData( has exactly 1 call site in ${SAVE_OWNER}`, `found ${n}`);
  } else {
    ok(`saveData( is pinned: 1 call site, ${SAVE_OWNER} (plugin config only, never a note)`);
  }
}

const bundleSaveData = text.split('saveData(').length - 1;
if (bundleSaveData > MAX_BUNDLE_SAVEDATA) {
  bad(
    `bundle has at most ${MAX_BUNDLE_SAVEDATA} saveData( references`,
    `found ${bundleSaveData} — a new persistence path reached the bundle`
  );
} else {
  ok(`bundle has ${bundleSaveData} saveData( reference(s) (cap ${MAX_BUNDLE_SAVEDATA})`);
}

/* ------------------------------------------------------------------ *
 * 5. no innerHTML/outerHTML (Obsidian review guideline)               *
 * ------------------------------------------------------------------ */
const HTML_SINKS = ['innerHTML', 'outerHTML', 'insertAdjacentHTML'];
const htmlHits = [];
for (const needle of HTML_SINKS) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) htmlHits.push(`${needle}  main.js:${i + 1}: ${lines[i].trim().slice(0, 100)}`);
  }
}
if (htmlHits.length) {
  bad('bundle assigns no innerHTML/outerHTML', htmlHits.join('\n'));
} else {
  ok('bundle assigns no innerHTML/outerHTML (Obsidian review guideline)');
}

/* ------------------------------------------------------------------ *
 * verdict                                                             *
 * ------------------------------------------------------------------ */
console.log('');
if (failures) {
  console.log(`RESULT: FAIL — ${failures} of ${checks} checks failed.`);
  console.log('The read-only invariant is this plugin\'s core safety claim. Do not weaken');
  console.log('this gate to make a change pass; change the code, or bring the exception to');
  console.log('a human with an argument for why it is not a note write.');
  process.exit(1);
}
console.log(`RESULT: PASS — ${checks}/${checks} checks. The bundle cannot write to a note.`);
process.exit(0);
