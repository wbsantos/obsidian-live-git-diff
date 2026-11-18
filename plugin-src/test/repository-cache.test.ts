import test from 'node:test';
import assert from 'node:assert/strict';
import { RepositoryCache } from '../src/repositoryCache.ts';
import type { RepositoryCacheLoader } from '../src/repositoryCache.ts';
import type { RepositoryChange, RepositoryPage } from '../src/repositoryManager.ts';
import type { GitContext } from '../src/git.ts';

const context: GitContext = { root: 'C:\\Vault', abs: 'C:\\Vault\\note.md', rel: 'note.md', backend: 'git' };
const revision = (n: number): RepositoryChange => ({ sha: String(n).padStart(40, 'a'), shortSha: String(n), subject: `Change ${n}`, author: 'Author', date: '2026-11-14', parents: [] });
const page = (n = 0): RepositoryPage => ({ changes: [revision(n)], hasMore: true });
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}
const savedPages = (cache: RepositoryCache): unknown[] => (cache.serialize() as { pages: unknown[] }).pages;

test('conflicted changes and their files survive cache persistence without aliasing views', async () => {
  const original = { ...revision(1), conflicted: true, conflictedFiles: ['notes/conflicted.md'] };
  const loader: RepositoryCacheLoader = { anchor: async () => 'jj:pinned', page: async () => ({ changes: [original], hasMore: false }) };
  const cache = new RepositoryCache(undefined, loader);
  const first = await cache.load(context, '', 0, 50);
  first.changes[0].conflictedFiles!.push('view-only.md');
  const restored = new RepositoryCache(undefined, loader); restored.hydrate(cache.serialize());
  const change = (await restored.load(context, '', 0, 50)).changes[0];
  assert.equal(change.conflicted, true);
  assert.deepEqual(change.conflictedFiles, ['notes/conflicted.md']);
});

test('persistent pages require the current anchor and isolate returned objects', async () => {
  let anchor = 'git:original', reads = 0, anchors = 0, changed = 0;
  const loader: RepositoryCacheLoader = {
    anchor: async () => { anchors++; return anchor; },
    page: async (_ctx, options) => { reads++; assert.equal(options.anchor, anchor); return page(reads); },
  };
  const cache = new RepositoryCache(() => changed++, loader);
  const first = await cache.load(context, 'Stories', 0, 50);
  assert.equal(first.anchor, anchor); first.changes[0].subject = 'Changed in a view'; first.changes[0].parents!.push('parent');
  const second = await cache.load(context, 'Stories', 0, 50);
  assert.equal(second.changes[0].subject, 'Change 1'); assert.deepEqual(second.changes[0].parents, []);
  assert.equal(reads, 1); assert.equal(anchors, 2); assert.equal(changed, 1);
  const reloaded = new RepositoryCache(undefined, loader); reloaded.hydrate(JSON.parse(JSON.stringify(cache.serialize())));
  assert.deepEqual(await reloaded.load(context, 'Stories', 0, 50), second); assert.equal(reads, 1);
  anchor = 'git:other-branch-moved';
  assert.equal((await reloaded.load(context, 'Stories', 0, 50)).changes[0].subject, 'Change 2');
  assert.equal(reads, 2);
});

test('folder, pagination, backend and workspace scopes cannot alias', async () => {
  let reads = 0;
  const loader: RepositoryCacheLoader = { anchor: async () => 'same', page: async (_ctx, options) => { reads++; return page(options.offset); } };
  const cache = new RepositoryCache(undefined, loader);
  await cache.load(context, '', 0, 50);
  await cache.load({ ...context, root: 'c:/vault/' }, undefined, 0, 50);
  assert.equal(reads, 1);
  await cache.load(context, 'folder', 0, 50);
  await cache.load(context, 'folder', 50, 50);
  await cache.load(context, 'folder', 0, 25);
  await cache.load({ ...context, backend: 'jj', workspaceRoot: 'C:/vault' }, 'folder', 0, 50);
  await cache.load({ ...context, backend: 'jj', workspaceRoot: 'C:/other-workspace' }, 'folder', 0, 50);
  assert.equal(reads, 6);
});

test('concurrent readers share subprocesses and one cancellation cannot poison another', async () => {
  const anchor = deferred<string>(), result = deferred<RepositoryPage>(); let anchors = 0, reads = 0;
  const cache = new RepositoryCache(undefined, {
    anchor: () => { anchors++; return anchor.promise; }, page: () => { reads++; return result.promise; },
  });
  const abort = new AbortController();
  const first = cache.load(context, '', 0, 50, abort.signal), second = cache.load(context, '', 0, 50);
  const firstRejected = assert.rejects(first, { name: 'AbortError' });
  anchor.resolve('git:pinned');
  await new Promise<void>(resolve => setImmediate(resolve));
  abort.abort(); result.resolve(page());
  await firstRejected;
  assert.equal((await second).changes.length, 1); assert.equal(anchors, 1); assert.equal(reads, 1);
  assert.equal(savedPages(cache).length, 1);
});

test('reset prevents an in-flight page from restoring persisted entries', async () => {
  const result = deferred<RepositoryPage>(); let changed = 0;
  const cache = new RepositoryCache(() => changed++, { anchor: async () => 'git:a', page: () => result.promise });
  const pending = cache.load(context, undefined, 0, 50);
  await new Promise<void>(resolve => setImmediate(resolve));
  cache.clear(); result.resolve(page());
  await pending;
  assert.equal(savedPages(cache).length, 0); assert.equal(changed, 1);
});

test('repository invalidation removes only that repository, including Windows spelling variants', async () => {
  const loader: RepositoryCacheLoader = { anchor: async () => 'git:a', page: async () => page() };
  const cache = new RepositoryCache(undefined, loader);
  await cache.load(context, undefined, 0, 50);
  await cache.load({ ...context, root: 'C:/Other' }, undefined, 0, 50);
  cache.invalidate('c:/VAULT/');
  assert.equal(savedPages(cache).length, 1);
  assert.equal((savedPages(cache)[0] as { root: string }).root, 'c:/other');
});

test('failed anchor or page reads never persist errors or block retries', async () => {
  let anchorCalls = 0, pageCalls = 0;
  const cache = new RepositoryCache(undefined, {
    anchor: async () => { if (++anchorCalls === 1) throw new Error('anchor failure'); return 'git:a'; },
    page: async () => { if (++pageCalls === 1) throw new Error('page failure'); return page(); },
  });
  await assert.rejects(cache.load(context, undefined, 0, 50), /anchor failure/);
  await assert.rejects(cache.load(context, undefined, 0, 50), /page failure/);
  assert.equal(savedPages(cache).length, 0);
  await cache.load(context, undefined, 0, 50);
  assert.equal(pageCalls, 2); assert.equal(savedPages(cache).length, 1);
});

test('persistent schema rejects malformed entries and strips unknown properties', async () => {
  const cache = new RepositoryCache(undefined, { anchor: async () => 'git:a', page: async () => page() });
  await cache.load(context, undefined, 0, 50);
  const serialized = cache.serialize() as { version: number; pages: Array<Record<string, unknown>> };
  const stored = serialized.pages[0];
  (stored.page as RepositoryPage).changes[0] = { ...revision(0), injected: 'discard me' } as RepositoryChange;
  serialized.pages.push({ ...stored, limit: -5 }, { ...stored, page: { changes: [{ sha: 'missing fields' }], hasMore: false } });
  cache.hydrate(serialized);
  assert.equal(savedPages(cache).length, 1);
  assert.ok(!JSON.stringify(cache.serialize()).includes('injected'));
  for (const corrupt of [null, { version: 100, pages: [stored] }, { version: 1, pages: 'bad' }, { version: 1, pages: Array(201).fill(stored) }]) {
    cache.hydrate(corrupt); assert.equal(savedPages(cache).length, 0);
  }
});

test('LRU limits bound page count, metadata records and bytes', async () => {
  let reads = 0;
  const loader: RepositoryCacheLoader = { anchor: async () => 'git:a', page: async (_ctx, options) => { reads++; return page(options.offset); } };
  const cache = new RepositoryCache(undefined, loader, { maxPages: 2, maxChanges: 2 });
  await cache.load(context, undefined, 0, 1);
  await cache.load(context, undefined, 1, 1);
  await cache.load(context, undefined, 0, 1);
  await cache.load(context, undefined, 2, 1);
  assert.equal(savedPages(cache).length, 2);
  await cache.load(context, undefined, 0, 1); assert.equal(reads, 3);
  await cache.load(context, undefined, 1, 1); assert.equal(reads, 4);
  const bytes = new RepositoryCache(undefined, {
    anchor: async () => 'git:a', page: async () => ({ changes: [{ ...revision(1), subject: 'x'.repeat(2000) }], hasMore: false }),
  }, { maxBytes: 1024 });
  await bytes.load(context, undefined, 0, 50); assert.equal(savedPages(bytes).length, 0);
  const records = new RepositoryCache(undefined, {
    anchor: async () => 'git:a', page: async () => ({ changes: [revision(1), revision(2)], hasMore: true }),
  }, { maxChanges: 1 });
  await records.load(context, undefined, 0, 50); assert.equal(savedPages(records).length, 0);
});

test('invalid pagination and already-cancelled calls never execute repository commands', async () => {
  let anchors = 0;
  const cache = new RepositoryCache(undefined, { anchor: async () => { anchors++; return 'git:a'; }, page: async () => page() });
  for (const [offset, limit] of [[-1, 50], [0, 0], [0, 5001], [0.5, 50]]) await assert.rejects(cache.load(context, undefined, offset, limit), /Invalid history page/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(cache.load(context, undefined, 0, 50, abort.signal), { name: 'AbortError' });
  assert.equal(anchors, 0);
});
