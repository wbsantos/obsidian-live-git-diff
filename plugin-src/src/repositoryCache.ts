import type { GitContext } from './git.ts';
import { listRepositoryHistory, repositoryAnchor } from './repositoryManager.ts';
import type { RepositoryChange, RepositoryPage } from './repositoryManager.ts';

export interface RepositoryCacheLoader {
  anchor(context: GitContext): Promise<string>;
  page(context: GitContext, options: { path?: string; offset: number; limit: number; anchor: string }): Promise<RepositoryPage>;
}
export interface RepositoryCacheLimits { maxPages?: number; maxChanges?: number; maxBytes?: number }
interface CachedPage {
  repository: string;
  root: string;
  path: string;
  anchor: string;
  offset: number;
  limit: number;
  page: RepositoryPage;
}
interface StoredPage { value: CachedPage; bytes: number }
const VERSION = 2;
const defaultLoader: RepositoryCacheLoader = { anchor: repositoryAnchor, page: listRepositoryHistory };
const canonicalRoot = (root: string): string => {
  const normalized = root.replace(/\\/g, '/').replace(/\/$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
};
const repositoryKey = (ctx: GitContext): string => JSON.stringify([
  canonicalRoot(ctx.root), ctx.backend || 'git', canonicalRoot(ctx.workspaceRoot || ''),
]);
const pageKey = (value: Omit<CachedPage, 'page' | 'root'>): string =>
  JSON.stringify([value.repository, value.path, value.anchor, value.offset, value.limit]);
const copyChange = (change: RepositoryChange): RepositoryChange => ({ sha: change.sha, shortSha: change.shortSha,
  subject: change.subject, author: change.author, date: change.date,
  ...(change.changeId !== undefined ? { changeId: change.changeId } : {}),
  ...(change.description !== undefined ? { description: change.description } : {}),
  ...(change.conflicted !== undefined ? { conflicted: change.conflicted } : {}),
  ...(change.conflictedFiles ? { conflictedFiles: [...change.conflictedFiles] } : {}),
  ...(change.parents ? { parents: [...change.parents] } : {}) });
const copyPage = (page: RepositoryPage): RepositoryPage => ({ changes: page.changes.map(copyChange), hasMore: page.hasMore,
  ...(page.anchor !== undefined ? { anchor: page.anchor } : {}) });
const abortError = (): Error => Object.assign(new Error('History request cancelled.'), { name: 'AbortError' });

/** A view owns its cancellation; shared subprocesses belong to the cache. */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const aborted = (): void => { signal.removeEventListener('abort', aborted); reject(abortError()); };
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => { signal.removeEventListener('abort', aborted); resolve(value); },
      error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function string(value: unknown, max = 32_768): value is string { return typeof value === 'string' && value.length <= max; }
function change(value: unknown): value is RepositoryChange {
  return object(value) && string(value.sha, 128) && !!value.sha && string(value.shortSha, 128) &&
    string(value.subject) && string(value.author, 4096) && string(value.date, 1024) &&
    (value.changeId === undefined || string(value.changeId, 128)) &&
    (value.description === undefined || string(value.description, 65_536)) &&
    (value.conflicted === undefined || typeof value.conflicted === 'boolean') &&
    (value.conflictedFiles === undefined || (Array.isArray(value.conflictedFiles) && value.conflictedFiles.length <= 1024 && value.conflictedFiles.every(file => string(file, 4096)))) &&
    (value.parents === undefined || (Array.isArray(value.parents) && value.parents.length <= 1024 && value.parents.every(parent => string(parent, 128))));
}
function cachedPage(value: unknown): value is CachedPage {
  return object(value) && string(value.repository) && string(value.root) && string(value.path) &&
    string(value.anchor, 1_048_576) && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 &&
    Number.isSafeInteger(value.limit) && Number(value.limit) > 0 && Number(value.limit) <= 5000 &&
    object(value.page) && typeof value.page.hasMore === 'boolean' && Array.isArray(value.page.changes) &&
    value.page.changes.length <= Number(value.limit) && value.page.changes.every(change);
}

/**
 * Persist only bounded metadata pages. Every lookup checks repository identity first;
 * the anchor pins all refs (Git) or an operation (JJ), so old pages remain immutable.
 * Persistence is owned by the plugin's existing settings writer, never this class.
 */
export class RepositoryCache {
  private entries = new Map<string, StoredPage>();
  private anchors = new Map<string, Promise<string>>();
  private pending = new Map<string, Promise<RepositoryPage>>();
  private generation = 0;
  private changeCount = 0;
  private byteCount = 0;
  private readonly maxPages: number;
  private readonly maxChanges: number;
  private readonly maxBytes: number;
  private readonly changed: () => void;
  private readonly loader: RepositoryCacheLoader;
  constructor(changed: () => void = () => {}, loader: RepositoryCacheLoader = defaultLoader, limits: RepositoryCacheLimits = {}) {
    this.changed = changed; this.loader = loader;
    this.maxPages = Math.max(1, Math.min(200, Math.floor(limits.maxPages || 200)));
    this.maxChanges = Math.max(1, Math.min(5000, Math.floor(limits.maxChanges || 5000)));
    this.maxBytes = Math.max(1024, Math.min(8_388_608, Math.floor(limits.maxBytes || 8_388_608)));
  }
  hydrate(data: unknown): void {
    this.generation++;
    this.entries.clear(); this.anchors.clear(); this.pending.clear(); this.changeCount = 0; this.byteCount = 0;
    if (!object(data) || data.version !== VERSION || !Array.isArray(data.pages)) return;
    // Reject oversized input before traversing or cloning every record.
    if (data.pages.length > 200) return;
    for (const value of data.pages) if (cachedPage(value)) {
      const entry: CachedPage = { repository: value.repository, root: canonicalRoot(value.root), path: value.path,
        anchor: value.anchor, offset: value.offset, limit: value.limit, page: { ...copyPage(value.page), anchor: value.anchor } };
      this.store(entry);
    }
  }
  serialize(): unknown {
    return { version: VERSION, pages: [...this.entries.values()].map(({ value }) => ({ ...value, page: copyPage(value.page) })) };
  }
  clear(): void {
    this.generation++;
    this.entries.clear(); this.anchors.clear(); this.pending.clear(); this.changeCount = 0; this.byteCount = 0;
    this.changed();
  }
  invalidate(root: string): void {
    this.generation++;
    const canonical = canonicalRoot(root);
    for (const [key, entry] of this.entries) if (entry.value.root === canonical) this.remove(key);
    // Existing readers may finish, but cannot repopulate invalidated pages.
    this.anchors.clear(); this.pending.clear(); this.changed();
  }
  async load(ctx: GitContext, path: string | undefined, offset: number, limit: number, signal?: AbortSignal): Promise<RepositoryPage> {
    if (signal?.aborted) throw abortError();
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000)
      throw new Error('Invalid history page.');
    const repository = repositoryKey(ctx), generation = this.generation;
    let pendingAnchor = this.anchors.get(repository);
    if (!pendingAnchor) {
      pendingAnchor = Promise.resolve().then(() => this.loader.anchor(ctx));
      this.anchors.set(repository, pendingAnchor);
      const remove = (): void => { if (this.anchors.get(repository) === pendingAnchor) this.anchors.delete(repository); };
      void pendingAnchor.then(remove, remove);
    }
    const anchor = await waitFor(pendingAnchor, signal);
    if (signal?.aborted) throw abortError();
    const descriptor = { repository, root: canonicalRoot(ctx.root), path: path || '', anchor, offset, limit };
    const key = pageKey(descriptor), cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key); this.entries.set(key, cached);
      return copyPage(cached.value.page);
    }
    let pending = this.pending.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => this.loader.page(ctx, { path, offset, limit, anchor })).then(page => {
        const result = { ...copyPage(page), anchor };
        if (generation === this.generation) { this.store({ ...descriptor, page: result }); this.changed(); }
        return result;
      });
      this.pending.set(key, pending);
      const remove = (): void => { if (this.pending.get(key) === pending) this.pending.delete(key); };
      void pending.then(remove, remove);
    }
    return copyPage(await waitFor(pending, signal));
  }
  private remove(key: string): void {
    const entry = this.entries.get(key); if (!entry) return;
    this.changeCount -= entry.value.page.changes.length; this.byteCount -= entry.bytes; this.entries.delete(key);
  }
  private store(value: CachedPage): void {
    const bytes = JSON.stringify(value).length * 2, key = pageKey(value);
    this.remove(key);
    if (value.page.changes.length > this.maxChanges || bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes }); this.changeCount += value.page.changes.length; this.byteCount += bytes;
    while (this.entries.size > this.maxPages || this.changeCount > this.maxChanges || this.byteCount > this.maxBytes) {
      this.remove(this.entries.keys().next().value!);
    }
  }
}
