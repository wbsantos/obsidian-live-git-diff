import { createTwoFilesPatch } from 'diff';
import type { GitContext } from './git.ts';
import { changePatch, pendingPatch, getChangeDetails, getRepositoryStatus } from './repositoryManager.ts';
import type { RepositoryFile } from './repositoryManager.ts';
import { AI_CONTEXT_LIMIT, boundedContext } from './ai.ts';

export function documentContext(path: string, text: string): string {
  if (text.includes('\0')) return `File: ${path}\nBinary file; content omitted.`;
  return `File: ${path}\n${boundedContext(text)}`;
}
export function comparisonContext(path: string, before: string, after: string, left: string, right: string): string {
  if (before.includes('\0') || after.includes('\0')) return `File: ${path}\n${left} → ${right}\nBinary content omitted.`;
  // Bound both the diff cost and the data sent. Cropping is explicit in the evidence.
  const a = boundedContext(before, 100_000), b = boundedContext(after, 100_000);
  const patch = createTwoFilesPatch(left, right, a, b, '', '', { context: 3, timeout: 300 });
  return boundedContext(`File: ${path}\n${left} → ${right}\n${patch || `Diff budget exceeded. Before excerpt:\n${boundedContext(a, 12000)}\nAfter excerpt:\n${boundedContext(b, 12000)}`}`);
}
const textFile = (file: string): boolean => /\.(md|markdown|txt|json|yaml|yml|csv|tsv|xml|html|css|js|ts|cs|sql)$/i.test(file);
export async function repositoryAiContext(context: GitContext, options: { sha?: string; paths?: string[]; token?: string },
  readWorking: (path: string) => Promise<string>, signal?: AbortSignal): Promise<string> {
  const details = options.sha ? await getChangeDetails(context, options.sha, signal) : null;
  const pending = details ? null : await getRepositoryStatus(context, signal);
  if (options.token && pending?.token !== options.token) throw new Error('Files changed. Refresh the list before generating a description.');
  const all = details?.files || pending!.files;
  const files = options.paths ? all.filter(file => options.paths!.includes(file.path)) : all;
  if (!files.length) throw new Error('No changes selected.');
  if (options.paths?.some(path => !files.some(file => file.path === path))) throw new Error('Selected files changed. Refresh the list.');
  let result = `${details ? `Change: ${details.change.subject}\n${details.change.description || ''}` : 'Selected pending changes'}\nFiles:\n${files.map(file => `${file.status} ${file.path}${file.oldPath ? ` (from ${file.oldPath})` : ''}`).join('\n')}\n`;
  for (const file of files.slice(0, 40)) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
    if (result.length > AI_CONTEXT_LIMIT - 1000) { result += '\n[Further file patches omitted: context limit.]'; break; }
    let patch: string;
    if (details) patch = await changePatch(context, options.sha!, file, signal);
    else patch = await workingPatch(file);
    result += `\nFile: ${file.path}\n${boundedContext(patch, 8000)}\n`;
  }
  if (files.length > 40) result += '\n[Only the first 40 file patches are included.]';
  if (pending && (await getRepositoryStatus(context, signal)).token !== pending.token) throw new Error('Files changed while preparing AI context. Refresh and try again.');
  return boundedContext(result);

  async function workingPatch(file: RepositoryFile): Promise<string> {
    const patch = await pendingPatch(context, file, signal);
    if (patch || file.status !== 'A') return patch || 'No textual difference.';
    return textFile(file.path) ? `Added file:\n${await readWorking(file.path)}` : 'Added binary or unsupported file; content omitted.';
  }
}
