import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import { blocks, pair, textDetail } from '../src/diff/mddiff.ts';
const results = [];
function measure(name, run) {
  globalThis.gc?.();
  const memory = process.memoryUsage().heapUsed, start = performance.now();
  const detail = run();
  results.push({ name, milliseconds: Math.round((performance.now() - start) * 100) / 100,
    heapGrowthMiB: Math.round((process.memoryUsage().heapUsed - memory) / 1048576 * 100) / 100, ...detail });
}
const text = Array.from({ length: 2500 }, (_, i) => `palavra${i}`).join(' ');
measure('2500 words: one replacement', () => {
  const d = textDetail(text, text.replace('palavra1250', 'alterada1250'));
  return { changes: d.a.length, simplified: d.simplified };
});
const paragraph = 'Texto de referência para comparar desempenho, preservando ordem, pontuação e estrutura do documento. ';
const large = Array.from({ length: 3000 }, (_, i) => `${i}: ${paragraph.repeat(3)}\n\n`).join('').slice(0, 882000);
measure('882000 characters: full parse and comparison', () => {
  const a = blocks(large), b = blocks(large.replace('1500: Texto', '1500: TEXTO'));
  const rows = pair(a, b);
  return { chars: large.length, blocks: a.length, changed: rows.filter(r => r.kind !== 'same').length, simplified: rows.some(r => r.simplified) };
});
const cached = blocks(large);
measure('882000 characters: historical parse reused', () => {
  const rows = pair(cached, blocks(large.replace('1500: Texto', '1500: TEXTO')));
  return { changed: rows.filter(r => r.kind !== 'same').length };
});
if (process.argv[2]) {
  const actual = fs.readFileSync(process.argv[2], 'utf8');
  measure('largest vault note, read only: one word changed in memory', () => {
    const rows = pair(blocks(actual), blocks(actual.replace(/(\p{L}{5,})/u, '$1x')));
    return { chars: actual.length, blocks: rows.filter(r => r.a).length, changed: rows.filter(r => r.kind !== 'same').length, simplified: rows.some(r => r.simplified) };
  });
}
fs.writeFileSync(process.env.LGD_BENCHMARK_OUT || '../performance-live-preview.json', JSON.stringify({ node: process.version, date: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify(results, null, 2));
