#!/usr/bin/env node
// obs-eval.js — evaluate JS inside an Obsidian window over CDP.
// Usage: node obs-eval.js <window-title-substring> '<js expression>'
// Requires Obsidian launched with --remote-debugging-port=9222. No deps (node>=22 WebSocket).
const [,, match, expr] = process.argv;
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const t = list.find(x => x.type === 'page' && (x.title||'').includes(match));
if (!t) { console.error('no window matching:', match, '\navailable:', list.filter(x=>x.type==='page').map(x=>x.title)); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
const done = new Promise(res => {
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) res(m); };
});
await new Promise(r => ws.onopen = r);
// Obsidian renders its reading view lazily on rAF, which Chromium THROTTLES in
// unfocused/occluded windows — measurements taken on a background window show a
// stalled virtual display (2 sections for an 83KB note) and are meaningless.
ws.send(JSON.stringify({ id: 99, method: 'Page.bringToFront' }));
await new Promise(r => setTimeout(r, 400));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
  params: { expression: `(async()=>{${expr}})()`, returnByValue: true, awaitPromise: true } }));
const m = await done;
ws.close();
const r = m.result?.result;
if (m.result?.exceptionDetails) { console.error('EXCEPTION:', JSON.stringify(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails, null, 1)); process.exit(2); }
console.log(typeof r?.value === 'string' ? r.value : JSON.stringify(r?.value, null, 1));
