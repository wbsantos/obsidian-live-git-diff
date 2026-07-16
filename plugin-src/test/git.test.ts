/**
 * git.test.ts — base-ref resolution, file history, and the two ways reading a base
 * legitimately fails.
 *
 * These run against a REAL git repository, built from scratch in a temp directory by
 * each test. Not a mock: the behaviour under test is git's, and the interesting cases
 * (a rename, a commit from before the file existed, an annotated tag) are exactly the
 * ones a mock would get wrong in whatever way the author already believed.
 *
 * `git.ts` imports `obsidian` with `import type`, which is erased at runtime — that is
 * what lets this file exercise the real module in plain node.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  GitError,
  commitInfoFor,
  fileLog,
  readBaseAt,
  resolveRef,
  showAt,
} from '../src/git.ts';

/* ------------------------------------------------------------------ *
 * a real repo, built per test                                         *
 * ------------------------------------------------------------------ */

interface Repo {
  root: string;
  git: (...args: string[]) => string;
  commit: (msg: string, when?: string) => string;
  cleanup: () => void;
}

function makeRepo(): Repo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lgd-git-'));
  const g = (...args: string[]): string =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root },
    });
  g('init', '-q', '.');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  return {
    root,
    git: g,
    commit(msg: string, when?: string): string {
      const env = when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {};
      execFileSync('git', ['-C', root, 'add', '-A'], { env: { ...process.env, HOME: root, ...env } });
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', msg], {
        env: { ...process.env, HOME: root, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@e.com', ...env },
      });
      return g('rev-parse', 'HEAD').trim();
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** A repo with a 4-commit history and a rename partway through. */
function repoWithRename(): { repo: Repo; shas: Record<string, string> } {
  const repo = makeRepo();
  const w = (f: string, s: string): void => fs.writeFileSync(path.join(repo.root, f), s);

  w('old-name.md', '# Title\n\nfirst version\n');
  const first = repo.commit('first: create the doc', '2026-07-04T09:00:00-04:00');

  w('old-name.md', '# Title\n\nsecond version\n');
  const second = repo.commit('second: edit the doc', '2026-07-07T14:10:00-04:00');

  repo.git('mv', 'old-name.md', 'new-name.md');
  const renamed = repo.commit('third: rename the doc', '2026-07-15T16:11:00-04:00');

  w('new-name.md', '# Title\n\nfourth version\n');
  const fourth = repo.commit('fourth: edit after the rename', '2026-07-15T22:07:00-04:00');

  return { repo, shas: { first, second, renamed, fourth } };
}

/* ------------------------------------------------------------------ *
 * ref resolution                                                      *
 * ------------------------------------------------------------------ */

test('resolveRef: HEAD, HEAD~N, sha, short sha, branch, annotated tag', () => {
  const { repo, shas } = repoWithRename();
  try {
    assert.equal(resolveRef(repo.root, 'HEAD'), shas.fourth);
    assert.equal(resolveRef(repo.root, 'HEAD~1'), shas.renamed);
    assert.equal(resolveRef(repo.root, 'HEAD~3'), shas.first);
    assert.equal(resolveRef(repo.root, shas.second), shas.second, 'a full sha resolves to itself');
    assert.equal(resolveRef(repo.root, shas.second.slice(0, 7)), shas.second, 'a short sha resolves');

    repo.git('branch', 'topic', shas.second);
    assert.equal(resolveRef(repo.root, 'topic'), shas.second, 'a branch name resolves');

    // ANNOTATED tags are the reason `^{commit}` is in resolveRef: without the peel this
    // returns the TAG object's sha, and `git show <tag-sha>:path` then fails with an
    // error that reads like the file isn't tracked.
    repo.git('tag', '-a', 'v1.0', shas.first, '-m', 'release');
    assert.equal(resolveRef(repo.root, 'v1.0'), shas.first, 'an annotated tag peels to its commit');

    repo.git('tag', 'light', shas.second);
    assert.equal(resolveRef(repo.root, 'light'), shas.second, 'a lightweight tag resolves');
  } finally {
    repo.cleanup();
  }
});

test('resolveRef: a ref whose name STARTS WITH A DASH resolves, not parsed as an option', () => {
  // ARGUMENT injection — the class that argv form does NOT close. A ref is a plain argv
  // element, but git still reads an element beginning with '-' as an OPTION, and the
  // ref here comes from settings (data.json), which in a shared vault is attacker-
  // influenced. `--end-of-options` is what makes it a revision again.
  //
  // This is also the reason the test can assert something POSITIVE rather than probe for
  // an exploit: '-x' is a legal ref that git itself will create, so the fix has a
  // visible right answer. Without --end-of-options in resolveRef, git says
  // "fatal: Needed a single revision" and this test fails — verified by reverting it.
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, 'a.md'), 'x\n');
    const sha = repo.commit('init');

    // `git branch -- -x` REFUSES ("'-x' is not a valid branch name"), so the ref is
    // written straight into the ref store — which is how such a name gets into a real
    // repo in the first place, and proves git is happy to RESOLVE what it won't create.
    repo.git('update-ref', 'refs/heads/-x', sha);
    assert.match(repo.git('show-ref'), /refs\/heads\/-x/, 'the dashed ref really exists');

    assert.equal(resolveRef(repo.root, '-x'), sha, 'a dashed ref resolves to its commit');
  } finally {
    repo.cleanup();
  }
});

test('resolveRef: an option-shaped ref is refused as a ref, never honoured as an option', () => {
  // The other half: a dashed ref that is NOT a real ref must still fail as a ref —
  // --end-of-options must not turn `--output=...` into an option git acts on. If this
  // ever passes, git took the argument seriously and wrote a file.
  const repo = makeRepo();
  const bait = path.join(os.tmpdir(), 'lgd-arginject-probe');
  try {
    fs.rmSync(bait, { force: true });
    fs.writeFileSync(path.join(repo.root, 'a.md'), 'x\n');
    repo.commit('init');

    assert.throws(
      () => resolveRef(repo.root, `--output=${bait}`),
      (e: Error) => e instanceof GitError && /--output=/.test(e.message),
      'it fails as an unresolvable REF, and the message quotes what was typed'
    );
    assert.ok(!fs.existsSync(bait), 'git never treated the ref as an --output option');
  } finally {
    fs.rmSync(bait, { force: true });
    repo.cleanup();
  }
});

test('resolveRef: a bogus ref fails loudly, quoting the ref', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, 'a.md'), 'x\n');
    repo.commit('init');
    assert.throws(
      () => resolveRef(repo.root, 'no-such-branch'),
      (e: Error) => e instanceof GitError && /no-such-branch/.test(e.message),
      'the message must name the ref the user actually typed'
    );
  } finally {
    repo.cleanup();
  }
});

test('resolveRef: an empty ref is refused before it reaches git', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, 'a.md'), 'x\n');
    repo.commit('init');
    assert.throws(() => resolveRef(repo.root, '   '), (e: Error) => e instanceof GitError && /settings/i.test(e.message));
  } finally {
    repo.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * commit metadata — the header's content                              *
 * ------------------------------------------------------------------ */

test('commitInfoFor: subject, short sha, and a human AM/PM local time', () => {
  const { repo, shas } = repoWithRename();
  try {
    const c = commitInfoFor(repo.root, shas.second);
    assert.equal(c.sha, shas.second);
    assert.equal(c.shortSha, shas.second.slice(0, 7));
    assert.equal(c.subject, 'second: edit the doc');
    assert.ok(c.relative.length > 0, 'a relative age is present');

    // THE FORMAT RULE, pinned. Times a person reads are AM/PM local with no leading
    // zeros — never 24-hour, never ISO. The commit was authored 2:10 PM local.
    assert.equal(c.date, 'Jul 7, 2:10 PM');
    assert.doesNotMatch(c.date, /\d{4}-\d{2}-\d{2}T/, 'not ISO');
    assert.doesNotMatch(c.date, /14:10/, 'not 24-hour');
    assert.doesNotMatch(c.date, /Jul 07|02:10/, 'leading zeros are stripped');
  } finally {
    repo.cleanup();
  }
});

test('commitInfoFor: midnight and noon are 12 AM / 12 PM, never 0', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, 'a.md'), 'x\n');
    const midnight = repo.commit('at midnight', '2026-07-04T00:05:00-04:00');
    assert.equal(commitInfoFor(repo.root, midnight).date, 'Jul 4, 12:05 AM');

    fs.writeFileSync(path.join(repo.root, 'a.md'), 'y\n');
    const noon = repo.commit('at noon', '2026-07-04T12:05:00-04:00');
    assert.equal(commitInfoFor(repo.root, noon).date, 'Jul 4, 12:05 PM');
  } finally {
    repo.cleanup();
  }
});

test('commitInfoFor: a subject containing a tab does not break the parse', () => {
  // Why the fields are separated by US (0x1f) and not by a tab.
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, 'a.md'), 'x\n');
    const sha = repo.commit('subject\twith\ttabs');
    const c = commitInfoFor(repo.root, sha);
    assert.equal(c.subject, 'subject\twith\ttabs');
    assert.equal(c.sha, sha);
  } finally {
    repo.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * file history — the picker's list                                    *
 * ------------------------------------------------------------------ */

test('fileLog: lists the file\'s commits, newest first, THROUGH a rename', () => {
  // --follow is the point: without it the history stops at the rename and the picker
  // silently hides every version of the document older than its current name.
  const { repo, shas } = repoWithRename();
  try {
    const log = fileLog(repo.root, 'new-name.md', 50);
    assert.equal(log.length, 4, 'all four commits, including the two pre-rename');
    assert.deepEqual(log.map((c) => c.sha), [shas.fourth, shas.renamed, shas.second, shas.first]);
    assert.deepEqual(log.map((c) => c.subject), [
      'fourth: edit after the rename',
      'third: rename the doc',
      'second: edit the doc',
      'first: create the doc',
    ]);
  } finally {
    repo.cleanup();
  }
});

test('fileLog: each entry carries the file\'s path AS OF that commit', () => {
  // This is what makes rename resolution free — the same call that lists the commits
  // also says what the file was called at each one.
  const { repo } = repoWithRename();
  try {
    const log = fileLog(repo.root, 'new-name.md', 50);
    const byPath = Object.fromEntries(log.map((c) => [c.subject, c.path]));
    assert.equal(byPath['fourth: edit after the rename'], 'new-name.md');
    assert.equal(byPath['third: rename the doc'], 'new-name.md');
    assert.equal(byPath['second: edit the doc'], 'old-name.md', 'pre-rename commits know the old name');
    assert.equal(byPath['first: create the doc'], 'old-name.md');
  } finally {
    repo.cleanup();
  }
});

test('fileLog: only commits that touched THIS file', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, 'mine.md'), 'a\n');
    repo.commit('touches mine');
    fs.writeFileSync(path.join(repo.root, 'other.md'), 'b\n');
    repo.commit('touches other only');
    fs.writeFileSync(path.join(repo.root, 'mine.md'), 'c\n');
    repo.commit('touches mine again');

    const log = fileLog(repo.root, 'mine.md', 50);
    assert.deepEqual(log.map((c) => c.subject), ['touches mine again', 'touches mine']);
  } finally {
    repo.cleanup();
  }
});

test('fileLog: respects the limit, and an untracked file yields an empty list', () => {
  const repo = makeRepo();
  try {
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(repo.root, 'a.md'), `v${i}\n`);
      repo.commit(`commit ${i}`);
    }
    assert.equal(fileLog(repo.root, 'a.md', 3).length, 3, 'the limit is honoured');
    assert.equal(fileLog(repo.root, 'a.md', 50).length, 5);

    fs.writeFileSync(path.join(repo.root, 'untracked.md'), 'x\n');
    assert.deepEqual(fileLog(repo.root, 'untracked.md', 50), [], 'no history is an empty list, not a throw');
  } finally {
    repo.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * reading the base — including the two ways it legitimately fails     *
 * ------------------------------------------------------------------ */

test('readBaseAt: reads the file at an arbitrary commit', () => {
  const { repo, shas } = repoWithRename();
  try {
    const r = readBaseAt(repo.root, 'new-name.md', shas.fourth);
    assert.match(r.text, /fourth version/);
    assert.equal(r.path, 'new-name.md');
    assert.equal(r.renamedFrom, null);
  } finally {
    repo.cleanup();
  }
});

test('readBaseAt: FOLLOWS A RENAME rather than reporting the file as new', () => {
  // The bug this prevents: `git show <pre-rename-sha>:new-name.md` fails, and an empty
  // base pane reads as "the whole file is new" — wrong, but entirely plausible.
  const { repo, shas } = repoWithRename();
  try {
    // Prove the naive call really does fail, so this test is guarding a real hazard.
    assert.throws(() => showAt(repo.root, shas.first, 'new-name.md'));

    const r = readBaseAt(repo.root, 'new-name.md', shas.first);
    assert.match(r.text, /first version/, 'the old content came back');
    assert.equal(r.path, 'old-name.md', 'read under the name it had then');
    assert.equal(r.renamedFrom, 'old-name.md', 'and the rename is reported so the UI can say so');
  } finally {
    repo.cleanup();
  }
});

test('readBaseAt: a commit from BEFORE the file existed says exactly that', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, 'first.md'), 'x\n');
    const before = repo.commit('before the doc existed');

    fs.writeFileSync(path.join(repo.root, 'doc.md'), '# Doc\n');
    repo.commit('add the doc', '2026-07-09T10:30:00-04:00');

    assert.throws(
      () => readBaseAt(repo.root, 'doc.md', before),
      (e: Error) => {
        assert.ok(e instanceof GitError);
        assert.match(e.message, /did not exist at/i, 'names the actual problem');
        assert.match(e.message, /earliest commit is/i, 'and tells you where to go instead');
        assert.match(e.message, /add the doc/, 'quoting the earliest commit by subject');
        return true;
      }
    );
  } finally {
    repo.cleanup();
  }
});

test('readBaseAt: an entirely untracked file is a DIFFERENT message', () => {
  // "you picked a commit too early" and "this file has never been committed" want
  // completely different reactions, so they must not share a message.
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, 'tracked.md'), 'x\n');
    const sha = repo.commit('init');
    fs.writeFileSync(path.join(repo.root, 'untracked.md'), 'y\n');

    assert.throws(
      () => readBaseAt(repo.root, 'untracked.md', sha),
      (e: Error) => {
        assert.ok(e instanceof GitError);
        assert.match(e.message, /no commits at all|not tracked/i);
        assert.doesNotMatch(e.message, /did not exist at/i, 'not the wrong diagnosis');
        return true;
      }
    );
  } finally {
    repo.cleanup();
  }
});

test('readBaseAt: never returns empty text in place of an error', () => {
  // The wrong-but-plausible failure, asserted directly: every failure path must THROW.
  // Empty base text renders as "the whole file is new", which is a lie the reader
  // cannot detect.
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, 'a.md'), 'x\n');
    const sha = repo.commit('init');
    fs.writeFileSync(path.join(repo.root, 'ghost.md'), 'y\n');
    let threw = false;
    try {
      const r = readBaseAt(repo.root, 'ghost.md', sha);
      assert.notEqual(r.text, '', 'BUG: returned empty text instead of throwing');
    } catch {
      threw = true;
    }
    assert.ok(threw, 'an unreadable base must throw, never return emptiness');
  } finally {
    repo.cleanup();
  }
});

test('readBaseAt: an empty file at a commit is empty text, not an error', () => {
  // The mirror of the test above: a legitimately empty file must NOT be treated as a
  // failure. "" is a real answer here.
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, 'empty.md'), '');
    const sha = repo.commit('add an empty doc');
    const r = readBaseAt(repo.root, 'empty.md', sha);
    assert.equal(r.text, '');
    assert.equal(r.renamedFrom, null);
  } finally {
    repo.cleanup();
  }
});

test('readBaseAt: a ref is passed as ARGV, so it cannot be a shell injection', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, 'a.md'), 'x\n');
    repo.commit('init');
    const evil = '$(touch /tmp/lgd-pwned); rm -rf /';
    assert.throws(() => resolveRef(repo.root, evil), (e: Error) => e instanceof GitError);
    assert.ok(!fs.existsSync('/tmp/lgd-pwned'), 'the subshell never ran');
  } finally {
    repo.cleanup();
  }
});

test('paths with spaces survive (argv, never a shell string)', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo.root, 'my notes'));
    fs.writeFileSync(path.join(repo.root, 'my notes', 'a doc.md'), '# hi\n');
    const sha = repo.commit('add a spaced path');
    const r = readBaseAt(repo.root, 'my notes/a doc.md', sha);
    assert.match(r.text, /# hi/);
    assert.equal(fileLog(repo.root, 'my notes/a doc.md', 10).length, 1);
  } finally {
    repo.cleanup();
  }
});
