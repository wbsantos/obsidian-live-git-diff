import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Explicit local configuration keeps private documents and paths out of the repository.
// node tools/prepare-visual-qa.mjs /absolute/path/to/local-config.json
const configPath = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Provide a local QA configuration file.');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const vault = path.resolve(config.vault), output = path.resolve(config.output);
if (!fs.existsSync(path.join(vault, '.git'))) throw new Error('QA vault must be an isolated Git repository.');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
fs.mkdirSync(output, { recursive: true });
const snapshots = [];
for (const item of config.cases) {
  if (!/^[\w-]+\.md$/.test(item.file)) throw new Error('QA file names must be simple Markdown basenames.');
  const original = path.resolve(item.original);
  if (original.toLowerCase().startsWith(vault.toLowerCase() + path.sep)) throw new Error('Source document must be outside the QA vault.');
  const directory = path.dirname(original);
  const root = git(directory, 'rev-parse', '--show-toplevel').trim();
  const rel = git(directory, 'rev-parse', '--show-prefix').trim() + path.basename(original);
  const history = git(root, 'log', '--follow', '-n', '2', '--format=%H', '--', rel).trim().split(/\r?\n/);
  const head = git(root, 'rev-parse', 'HEAD').trim();
  if (item.ref === 'previous-file-version' && history.length < 2) throw new Error(`Need two file versions: ${rel}`);
  const sha = git(root, 'rev-parse', '--verify', '--end-of-options', `${item.ref === 'previous-file-version' ? history[1] : item.ref || 'HEAD'}^{commit}`).trim();
  const before = git(root, 'show', '--end-of-options', `${sha}:${rel}`);
  const after = fs.readFileSync(original, 'utf8');
  let index = null;
  try { index = git(root, 'show', `:${rel}`); } catch { /* Untracked index is recorded explicitly. */ }
  snapshots.push({ ...item, original, root, rel, sha, head, fileHead: history[0], before, after, index,
    capturedAt: new Date().toISOString(), beforeHash: hash(before), afterHash: hash(after) });
  fs.writeFileSync(path.join(vault, item.file), before);
}
const files = snapshots.map(item => item.file);
git(vault, 'add', '--', ...files);
if (git(vault, 'diff', '--cached', '--name-only', '--', ...files).trim()) {
  git(vault, '-c', 'user.name=Plugin QA', '-c', 'user.email=qa@localhost', 'commit', '-m', 'QA: independent visual regression baselines', '--', ...files);
}
const qaSha = git(vault, 'rev-parse', 'HEAD').trim();
for (const item of snapshots) fs.writeFileSync(path.join(vault, item.file), item.after);
const manifest = { vault, output, qaSha, cases: snapshots, port: config.port || 9223 };
fs.writeFileSync(path.join(output, 'visual-cases.local.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ qaSha, cases: snapshots.map(({ file, sha, beforeHash, afterHash }) => ({ file, sha, beforeHash, afterHash })) }, null, 2));
