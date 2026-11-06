/** Structural, DOM-free comparison. Only visualKey may establish equality. */
import MarkdownIt, { type Token, type Env, type MarkdownIt as MarkdownParser } from 'markdown-it';
import { boundedOpcodes } from './sequence.ts';
export { boundedOpcodes, opcodes } from './sequence.ts';

export const MOD_MIN_SIMILARITY = 0.5;
export const MAX_APPROX_BLOCKS = 200;
export interface ParseOptions { breaks?: boolean }
export type BlockType = 'paragraph' | 'heading' | 'list' | 'list-item' | 'quote' | 'callout' | 'table' | 'code' | 'properties' | 'reference' | 'unknown' | 'rule';
export interface TableCell { text: string; visualKey: string }
export interface Block {
  text: string;
  lineStart: number;
  lineEnd: number;
  sourceStart: number;
  sourceEnd: number;
  type: BlockType;
  visualKey: string;
  visibleText: string;
  tokens: string[];
  conservative?: string;
  cells?: TableCell[][];
  items?: Block[];
  listKind?: string;
}
export type PairKind = 'same' | 'mod' | 'del' | 'ins';
export type Range = [number, number];
export interface TextDetail { a: Range[]; b: Range[] }
export interface CellDetail { rowA: number; rowB: number; column: number; detail: TextDetail }
export interface PairRow {
  kind: PairKind;
  a: Block | null;
  b: Block | null;
  structural?: string;
  simplified?: boolean;
  detail?: TextDetail;
  sourceDetail?: TextDetail;
  cells?: CellDetail[];
  items?: PairRow[];
  listStructureChanged?: boolean;
}
export type OpTag = 'equal' | 'delete' | 'insert' | 'replace';
export type Opcode = [OpTag, number, number, number, number];
export interface Budget { timeout?: number; maxEditLength?: number }

const eol = (s: string): string => s.replace(/\r\n?/g, '\n');
const space = (s: string): string => s.replace(/[ \t\n\r\f]+/g, ' ');
export const norm = (s: string): string => space(s).trim();
export function words(s: string): string[] { return s.match(/[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu) || []; }

function parser(options: ParseOptions): MarkdownParser {
  const md = new MarkdownIt({ html: true, breaks: !!options.breaks, linkify: true });
  // Embedded/dynamic output is never inspected; destinations and aliases are explicit.
  md.inline.ruler.before('link', 'obsidian_link', (state, silent) => {
    const match = /^(!?)\[\[([^\]\n]+)\]\]/.exec(state.src.slice(state.pos));
    if (!match) return false;
    if (!silent) {
      const split = match[2].indexOf('|');
      const target = split < 0 ? match[2] : match[2].slice(0, split);
      const token = state.push(match[1] ? 'obsidian_embed' : 'obsidian_link', '', 0);
      token.attrs = [['target', target.trim()]];
      token.content = split < 0 ? target : match[2].slice(split + 1);
    }
    state.pos += match[0].length;
    return true;
  });
  return md;
}

/** Syntax markers vanish; effective structure, case, attributes and code survive. */
function semantic(ts: Token[], breaks: boolean): { key: string; text: string } {
  const parts: unknown[] = [];
  let pending = '', visible = '';
  const flush = (): void => { if (pending) { parts.push(['text', space(pending)]); pending = ''; } };
  for (const t of ts) {
    if (t.type === 'inline') {
      flush();
      const inner = semantic(t.children || [], breaks);
      parts.push(['inline', inner.key]); visible += inner.text;
    } else if (t.type === 'text' || (t.type === 'softbreak' && !breaks)) {
      const value = t.type === 'softbreak' ? ' ' : t.content;
      pending += value; visible += value;
    } else {
      flush();
      if (t.type === 'softbreak' || t.type === 'hardbreak') { parts.push(['break']); visible += '\n'; }
      else if (t.type === 'fence' || t.type === 'code_block') {
        parts.push(['code', t.type === 'fence' ? t.info.trim() : '', eol(t.content)]); visible += t.content;
      } else {
        const attrs = (t.attrs || []).slice().sort((a, b) => a[0].localeCompare(b[0]));
        parts.push([t.type, t.tag, t.nesting, t.hidden, attrs, t.content]);
        if (t.children) parts.push(semantic(t.children, breaks).key);
        if (t.content) visible += t.content;
        if (t.type.endsWith('_close') && t.block) visible += '\n';
      }
    }
  }
  flush();
  return { key: JSON.stringify(parts), text: visible.trim() };
}

function tableCells(ts: Token[], breaks: boolean): TableCell[][] {
  const rows: TableCell[][] = [];
  for (const t of ts) {
    if (t.type === 'tr_open') rows.push([]);
    if (t.type === 'inline' && rows.length) {
      const cell = semantic(t.children || [], breaks);
      rows[rows.length - 1].push({ text: cell.text, visualKey: cell.key });
    }
  }
  return rows;
}

export interface ParsedDocument { blocks: Block[]; references: string }
export function blocks(input: string | null | undefined, options: ParseOptions = {}): Block[] {
  return parseDocument(input, options).blocks;
}
export function parseDocument(input: string | null | undefined, options: ParseOptions = {}): ParsedDocument {
  const source = input || '', rawLines = source.split('\n'), lines = eol(source).split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of rawLines) { starts.push(offset); offset += line.length + 1; }
  const md = parser(options);
  let frontEnd = 0;
  if (lines[0] === '---') {
    const close = lines.findIndex((s, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(s));
    if (close > 0) frontEnd = close + 1;
  }
  const parseLines = lines.slice();
  for (let i = 0; i < frontEnd; i++) parseLines[i] = '';
  // One complete parse is essential: inline references resolve against the whole document.
  const env: Env = {};
  const ts = md.parse(parseLines.join('\n'), env);
  const out: Block[] = [];
  const makeBlock = (start: number, end: number, type: BlockType, tokens: Token[], conservative?: string): Block | null => {
    while (end > start && !lines[end - 1].trim()) end--;
    if (end <= start) return null;
    const sourceStart = starts[start];
    const sourceEnd = starts[end - 1] + rawLines[end - 1].replace(/\r$/, '').length;
    const text = source.slice(sourceStart, sourceEnd);
    const meaning = semantic(tokens, !!options.breaks);
    if (!conservative && type !== 'code' && (tokens.some(t => /html/.test(t.type) || t.children?.some(c => /html/.test(c.type) || (c.type === 'text' && /==/.test(c.content)))) ||
        /\$|%%|\[\^|(?:^|\n)\s*\^\S+/.test(text))) conservative = 'Sintaxe estendida: comparação conservadora do fonte.';
    if (type === 'code' && /^(?:```|~~~)\s*(dataview|dataviewjs|query|tasks|mermaid)\b/i.test(text)) {
      conservative = 'Conteúdo gerado por plugin: apenas o fonte é comparado.';
    }
    if (type === 'quote' && /^>\s*\[![^\]]+\]/.test(text)) type = 'callout';
    const key = conservative ? eol(text) : meaning.key;
    const visibleText = meaning.text || text;
    const block: Block = { text, lineStart: start, lineEnd: end - 1, sourceStart, sourceEnd, type,
      visualKey: JSON.stringify([type, key]), visibleText,
      tokens: words(visibleText).map(t => t.toLocaleLowerCase()), conservative,
      ...(type === 'table' ? { cells: tableCells(tokens, !!options.breaks) } : {}) };
    if (type === 'list') {
      block.listKind = JSON.stringify([tokens[0].type, tokens[0].attrs]);
      block.items = [];
      for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type !== 'list_item_open' || token.level !== tokens[0].level + 1 || !token.map) continue;
        let endToken = i + 1;
        while (endToken < tokens.length && !(tokens[endToken].type === 'list_item_close' && tokens[endToken].level === token.level)) endToken++;
        const item = makeBlock(token.map[0], token.map[1], 'list-item', tokens.slice(i, endToken + 1));
        if (item) block.items.push(item);
        i = endToken;
      }
    }
    return block;
  };
  const add = (start: number, end: number, type: BlockType, tokens: Token[], conservative?: string): void => {
    const block = makeBlock(start, end, type, tokens, conservative);
    if (block) out.push(block);
  };
  if (frontEnd) add(0, frontEnd, 'properties', [], 'Propriedades: comparação conservadora do fonte.');
  let covered = frontEnd;
  const gap = (end: number): void => {
    let start = covered;
    while (start < end && !lines[start].trim()) start++;
    if (start < end) add(start, end, 'reference', [], 'Definições ou sintaxe não interpretada: comparação conservadora do fonte.');
  };
  for (let i = 0; i < ts.length; i++) {
    const first = ts[i];
    if (!first.map || first.level !== 0 || first.nesting === -1) continue;
    const [start, end] = first.map;
    gap(start);
    let j = i + 1;
    if (first.nesting === 1) {
      while (j < ts.length && !(ts[j].level === 0 && ts[j].nesting === -1)) j++;
      j++;
    }
    const kinds: Record<string, BlockType> = { paragraph_open: 'paragraph', heading_open: 'heading',
      bullet_list_open: 'list', ordered_list_open: 'list', blockquote_open: 'quote', table_open: 'table',
      fence: 'code', code_block: 'code', hr: 'rule' };
    const type = kinds[first.type] || 'unknown';
    add(start, end, type, ts.slice(i, j), type === 'unknown' ? 'Construção não interpretada: comparação conservadora do fonte.' : undefined);
    covered = end; i = j - 1;
  }
  gap(lines.length);
  const escape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const references = Object.entries(env.references || {}).map(([label, ref]) =>
    `[${label.replace(/\]/g, '\\]')}]: <${ref.href}> "${escape(ref.title)}"`).join('\n');
  return { blocks: out, references };
}

function sequenceSimilarity(a: string[], b: string[], timeout = 8, itemCoverage = false): number {
  if (!a.length || !b.length) return a.length === b.length ? 1 : 0;
  // An item can retain most of its content while gaining several clauses. Its
  // surrounding list supplies the context; an expansion must not erase that match.
  const denominator = itemCoverage && Math.min(a.length, b.length) >= 4 ? Math.min(a.length, b.length) : (a.length + b.length) / 2;
  if (Math.min(a.length, b.length) / denominator < MOD_MIN_SIMILARITY) return 0;
  const result = boundedOpcodes(a, b, { timeout, maxEditLength: 512 });
  if (result.simplified) return 0;
  let common = 0;
  for (const op of result.ops) if (op[0] === 'equal') common += op[2] - op[1];
  return common / denominator;
}
export const similarity = (a: string, b: string): number => sequenceSimilarity(words(a.toLocaleLowerCase()), words(b.toLocaleLowerCase()));

function listSimilarity(a: Block, b: Block, deadline: number): number {
  if (!a.items?.length || !b.items?.length || a.items.length > MAX_APPROX_BLOCKS || b.items.length > MAX_APPROX_BLOCKS) return 0;
  const rows = pair(a.items, b.items, false, deadline);
  if (rows.some(r => r.simplified)) return 0;
  let retained = 0;
  for (const row of rows) if (row.a && row.b) {
    const score = row.kind === 'same' ? 1 : sequenceSimilarity(row.a.tokens, row.b.tokens, 8, true);
    retained += score * Math.min(row.a.tokens.length, row.b.tokens.length);
  }
  const size = (items: Block[]): number => items.reduce((n, item) => n + item.tokens.length, 0);
  return retained / Math.max(1, Math.min(size(a.items), size(b.items)));
}

function align(a: Block[], b: Block[], deadline: number): PairRow[] {
  const fallback = (): PairRow[] => [
    ...a.map(x => ({ kind: 'del' as const, a: x, b: null, simplified: true })),
    ...b.map(x => ({ kind: 'ins' as const, a: null, b: x, simplified: true })),
  ];
  if (a.length > MAX_APPROX_BLOCKS || b.length > MAX_APPROX_BLOCKS) return fallback();
  const width = b.length + 1;
  const scores = new Float64Array((a.length + 1) * width), distances = new Float64Array(scores.length);
  const steps = new Uint8Array(scores.length);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    if (Date.now() > deadline) return fallback();
    const at = i * width + j, down = at + width, right = at + 1, diag = down + 1;
    const chooseDown = scores[down] > scores[right] || (scores[down] === scores[right] && distances[down] <= distances[right]);
    const from = chooseDown ? down : right;
    scores[at] = scores[from]; distances[at] = distances[from]; steps[at] = chooseDown ? 1 : 2;
    const compatible = a[i].type === b[j].type || ([a[i].type, b[j].type].every(t => t === 'paragraph' || t === 'heading'));
    if (!compatible) continue;
    let s = sequenceSimilarity(a[i].tokens, b[j].tokens, Math.max(1, Math.min(8, deadline - Date.now())), a[i].type === 'list-item');
    if (s < MOD_MIN_SIMILARITY && a[i].items && b[j].items) s = listSimilarity(a[i], b[j], deadline);
    if (s < MOD_MIN_SIMILARITY) continue;
    const score = s + scores[diag], distance = Math.abs(i - j) + distances[diag];
    if (score > scores[at] + 1e-9 || (Math.abs(score - scores[at]) <= 1e-9 && distance <= distances[at])) {
      scores[at] = score; distances[at] = distance; steps[at] = 3;
    }
  }
  const rows: PairRow[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const step = i === a.length ? 2 : j === b.length ? 1 : steps[i * width + j];
    if (step === 3) rows.push({ kind: a[i].visualKey === b[j].visualKey ? 'same' : 'mod', a: a[i++], b: b[j++] });
    else if (step === 1) rows.push({ kind: 'del', a: a[i++], b: null });
    else rows.push({ kind: 'ins', a: null, b: b[j++] });
  }
  return rows;
}

export function textDetail(a: string, b: string, budget: Budget = {}): TextDetail & { simplified: boolean } {
  const tokenize = (text: string): { keys: string[]; offsets: number[]; ends: number[] } => {
    const matches = [...text.matchAll(/[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu)];
    return { keys: matches.map(m => m[0]), offsets: matches.map(m => m.index!), ends: matches.map(m => m.index! + m[0].length) };
  };
  const A = tokenize(a), B = tokenize(b);
  const { ops, simplified } = boundedOpcodes(A.keys, B.keys, budget);
  const ra: Range[] = [], rb: Range[] = [];
  for (const op of ops) if (op[0] !== 'equal') {
    if (op[1] < op[2]) ra.push([A.offsets[op[1]], A.ends[op[2] - 1]]);
    if (op[3] < op[4]) rb.push([B.offsets[op[3]], B.ends[op[4] - 1]]);
  }
  return { a: ra, b: rb, simplified };
}

function refine(row: PairRow, deadline: number): void {
  if (row.kind !== 'mod' || !row.a || !row.b) return;
  const { a, b } = row;
  if (a.visibleText === b.visibleText || a.type !== b.type) row.structural = 'Alteração de formatação, destino de link, propriedades ou estrutura.';
  if (a.conservative || b.conservative) row.structural = a.conservative || b.conservative;
  if (Date.now() > deadline) { row.simplified = true; return; }
  if (a.items && b.items && !a.conservative && !b.conservative) {
    row.items = pair(a.items, b.items, true, deadline);
    row.listStructureChanged = a.listKind !== b.listKind;
    if (row.listStructureChanged) row.structural = 'Alteração do tipo ou da numeração da lista.';
    if (row.items.some(item => item.simplified)) row.simplified = true;
    return;
  }
  const budget = { timeout: Math.max(1, Math.min(25, deadline - Date.now())), maxEditLength: 1024 };
  const detail = textDetail(a.visibleText, b.visibleText, budget), source = textDetail(a.text, b.text, budget);
  row.simplified = detail.simplified || source.simplified;
  if (!row.simplified) { row.detail = detail; row.sourceDetail = source; }
  if (a.cells && b.cells) {
    row.cells = [];
    const makeRow = (cells: TableCell[]): Block => ({ ...a, type: 'table', text: '', cells: undefined,
      visualKey: JSON.stringify(cells.map(c => c.visualKey)), visibleText: cells.map(c => c.text).join(' '),
      tokens: words(cells.map(c => c.text).join(' ')).map(t => t.toLocaleLowerCase()) });
    const ra = a.cells.map(makeRow), rb = b.cells.map(makeRow);
    for (const cellRow of pair(ra, rb, false, deadline)) {
      if (cellRow.simplified) row.simplified = true;
      if (cellRow.kind === 'same') continue;
      const ia = cellRow.a ? ra.indexOf(cellRow.a) : -1, ib = cellRow.b ? rb.indexOf(cellRow.b) : -1;
      const ac = a.cells[ia] || [], bc = b.cells[ib] || [];
      for (let col = 0; col < Math.max(ac.length, bc.length); col++) {
        if (ac[col]?.visualKey === bc[col]?.visualKey) continue;
        if (Date.now() > deadline) { row.simplified = true; break; }
        const d = textDetail(ac[col]?.text || '', bc[col]?.text || '', budget);
        if (d.simplified) row.simplified = true;
        row.cells.push({ rowA: ia, rowB: ib, column: col, detail: d });
      }
    }
  }
}

export function pair(a: Block[], b: Block[], details = true, deadline = Date.now() + 350): PairRow[] {
  const exact = boundedOpcodes(a.map(x => x.visualKey), b.map(x => x.visualKey), { timeout: 75, maxEditLength: 2048 });
  const rows: PairRow[] = [];
  for (const [tag, i, ie, j, je] of exact.ops) {
    if (tag === 'equal') for (let k = 0; k < ie - i; k++) rows.push({ kind: 'same', a: a[i + k], b: b[j + k] });
    else if (tag === 'delete') for (let k = i; k < ie; k++) rows.push({ kind: 'del', a: a[k], b: null });
    else if (tag === 'insert') for (let k = j; k < je; k++) rows.push({ kind: 'ins', a: null, b: b[k] });
    else rows.push(...align(a.slice(i, ie), b.slice(j, je), deadline));
  }
  if (details) for (const row of rows) refine(row, deadline);
  return rows;
}

