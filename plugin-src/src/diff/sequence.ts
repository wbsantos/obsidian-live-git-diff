import { diffArrays } from 'diff';
import type { Budget, Opcode } from './mddiff.ts';

/** Bounded Myers; remove common edges before allocating algorithm state. */
export function boundedOpcodes(A: string[], B: string[], budget: Budget = {}): { ops: Opcode[]; simplified: boolean } {
  let prefix = 0;
  while (prefix < A.length && prefix < B.length && A[prefix] === B[prefix]) prefix++;
  let ae = A.length, be = B.length;
  while (ae > prefix && be > prefix && A[ae - 1] === B[be - 1]) { ae--; be--; }
  const changes = diffArrays(A.slice(prefix, ae), B.slice(prefix, be), {
    timeout: budget.timeout ?? 25, maxEditLength: budget.maxEditLength ?? 1024,
  });
  const ops: Opcode[] = [];
  const emit = (op: Opcode): void => {
    if (op[1] === op[2] && op[3] === op[4]) return;
    const prev = ops[ops.length - 1];
    if (prev && prev[0] !== 'equal' && op[0] !== 'equal') {
      prev[2] = op[2]; prev[4] = op[4]; prev[0] = prev[1] === prev[2] ? 'insert' : prev[3] === prev[4] ? 'delete' : 'replace';
    } else ops.push(op);
  };
  if (prefix) emit(['equal', 0, prefix, 0, prefix]);
  let i = prefix, j = prefix;
  if (!changes) emit([ae === prefix ? 'insert' : be === prefix ? 'delete' : 'replace', prefix, ae, prefix, be]);
  else for (const c of changes) {
    const ni = i + (c.added ? 0 : c.count), nj = j + (c.removed ? 0 : c.count);
    emit([c.added ? 'insert' : c.removed ? 'delete' : 'equal', i, ni, j, nj]); i = ni; j = nj;
  }
  if (ae < A.length) emit(['equal', ae, A.length, be, B.length]);
  return { ops, simplified: !changes };
}
export const opcodes = (A: string[], B: string[]): Opcode[] => boundedOpcodes(A, B).ops;


