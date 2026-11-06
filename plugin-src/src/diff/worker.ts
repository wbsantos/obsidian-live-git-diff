import { pair, parseDocument } from './mddiff.ts';
import type { Block, PairRow, ParseOptions } from './mddiff.ts';
import type { Revision } from '../session.ts';

export interface CompareRequest {
  identity: Revision;
  baseText: string;
  currentText: string;
  options: ParseOptions;
  baseBlocks?: Block[];
  baseReferences?: string;
}
export interface CompareResponse { identity: Revision; rows?: PairRow[]; baseBlocks?: Block[]; baseReferences?: string; currentReferences?: string; error?: string }

/** Separate from the transport so the exact worker algorithm is testable in Node. */
export function compareRequest(request: CompareRequest): CompareResponse {
  try {
    const base = request.baseBlocks ? { blocks: request.baseBlocks, references: request.baseReferences || '' } : parseDocument(request.baseText, request.options);
    const baseBlocks = base.blocks;
    const current = parseDocument(request.currentText, request.options);
    return { identity: request.identity, rows: pair(baseBlocks, current.blocks), baseReferences: base.references, currentReferences: current.references,
      ...(request.baseBlocks ? {} : { baseBlocks }) };
  } catch (error) {
    return { identity: request.identity, error: error instanceof Error ? error.message : String(error) };
  }
}

// A dedicated worker has no DOM, vault, Node imports or network capabilities in our code.
const scope = globalThis as unknown as { document?: unknown; onmessage: ((e: MessageEvent<CompareRequest>) => void) | null; postMessage: (message: CompareResponse) => void };
if (typeof scope.postMessage === 'function' && !scope.document) {
  scope.onmessage = event => scope.postMessage(compareRequest(event.data));
}
