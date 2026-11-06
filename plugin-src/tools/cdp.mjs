import fs from 'node:fs';
/** Local Electron QA transport. Never bundled with the plugin. */
export async function connect(port = 9223) {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = pages.find(p => p.url.includes('obsidian.md'));
  if (!target) throw new Error('No Obsidian target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const response = JSON.parse(event.data);
    const item = pending.get(response.id);
    if (item) { pending.delete(response.id); clearTimeout(item.timer); response.error ? item.reject(new Error(JSON.stringify(response.error))) : item.resolve(response.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
    pending.set(key, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: key, method, params }));
  });
  const evaluate = async code => {
    const response = await send('Runtime.evaluate', { expression: `(async()=>{${code}\n})()`, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  };
  return { send, evaluate, close: () => socket.close(), target };
}
if (process.argv[1]?.endsWith('cdp.mjs')) {
  const cdp = await connect();
  try { console.log(JSON.stringify(await cdp.evaluate(fs.readFileSync(process.argv[2], 'utf8')), null, 2)); }
  finally { cdp.close(); }
}
