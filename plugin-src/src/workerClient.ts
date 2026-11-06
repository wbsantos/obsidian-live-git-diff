import type { Block } from './diff/mddiff.ts';
import type { CompareRequest, CompareResponse } from './diff/worker.ts';

export interface WorkerLike {
  onmessage: ((event: MessageEvent<CompareResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: CompareRequest): void;
  terminate(): void;
}

export class ComparisonWorker {
  private worker: WorkerLike | null = null;
  private pending: { reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private cache: { key: string; blocks: Block[]; references: string } | null = null;
  private factory: () => WorkerLike;

  constructor(factory?: () => WorkerLike) {
    this.factory = factory || (() => {
      // This literal virtual module is resolved by esbuild after auditing the worker.
      const url = URL.createObjectURL(new Blob([require('lgd:worker')], { type: 'text/javascript' }));
      try { return new Worker(url); } finally { URL.revokeObjectURL(url); }
    });
  }

  cancel(): void {
    this.worker?.terminate(); this.worker = null;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      const error = new Error('Comparação substituída.'); error.name = 'AbortError';
      this.pending.reject(error); this.pending = null;
    }
  }

  compare(request: CompareRequest): Promise<CompareResponse> {
    this.cancel();
    const key = JSON.stringify([request.identity.filePath, request.identity.sha, request.options]);
    if (this.cache?.key === key) request = { ...request, baseBlocks: this.cache.blocks, baseReferences: this.cache.references, baseText: '' };
    return new Promise((resolve, reject) => {
      try {
        const worker = this.factory(); this.worker = worker;
        const fail = (error: Error): void => {
          if (this.worker !== worker) return;
          if (this.pending) clearTimeout(this.pending.timer);
          this.pending = null; worker.terminate(); this.worker = null; reject(error);
        };
        this.pending = { reject, timer: setTimeout(() => fail(new Error('A comparação excedeu o tempo limite.')), 15000) };
        worker.onmessage = event => {
          if (this.worker !== worker) return;
          const result = event.data;
          if (JSON.stringify(result.identity) !== JSON.stringify(request.identity)) return;
          if (result.error) { fail(new Error(result.error)); return; }
          if (!Array.isArray(result.rows)) { fail(new Error('Resposta incompleta do worker; comparação indisponível.')); return; }
          if (this.pending) clearTimeout(this.pending.timer);
          this.pending = null;
          if (result.baseBlocks) this.cache = { key, blocks: result.baseBlocks, references: result.baseReferences || '' };
          resolve(result);
        };
        worker.onerror = event => fail(new Error(event.message || 'Falha no worker da comparação.'));
        worker.postMessage(request);
      } catch (error) { reject(error); }
    });
  }
  dispose(): void { this.cancel(); this.cache = null; }
}
