'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FR_PORT || 9391);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  const EXE = process.env.FR_EXE || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const app = spawn(EXE,
    [ROOT, '--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu'],
    { cwd: ROOT, stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try { const l = await getJson('http://127.0.0.1:' + PORT + '/json/list'); page = (l || []).find((t) => t.type === 'page'); } catch (e) { /* retry */ }
  }
  if (!page) { app.kill(); throw new Error('窗口没起来'); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).slice(0, 300));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('CONSOLE ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('LOG ' + m.params.entry.text.slice(0, 300));
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return 'THROW: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text);
    return r && r.result && r.result.value;
  };
  await send('Runtime.enable', {});
  await send('Log.enable', {});

  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await ev('!!document.querySelector("#dirtyChip")')) break;
  }
  console.log('chip:', await ev('(document.querySelector("#dirtyChip")||{}).textContent'));
  console.log('页面版本标记:', await ev('typeof workDiffHtml + "/" + typeof setWorkDiff'));
  console.log('点击前 workView class:', await ev('document.querySelector("#workView").className'));

  await ev('document.querySelector("#dirtyChip").click()');
  await sleep(2500);

  console.log('点击后 workView class:', await ev('document.querySelector("#workView").className'));
  console.log('workView display:', await ev('getComputedStyle(document.querySelector("#workView")).display'));
  console.log('workDiff 文本:', JSON.stringify(await ev('document.querySelector("#workDiff").innerText.slice(0, 60)')));
  console.log('toast:', await ev('JSON.stringify(Array.from(document.querySelectorAll(".toast")).map(t => t.textContent))'));
  console.log('--- 控制台错误 ---');
  console.log(logs.length ? logs.join('\n') : '(无)');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(ROOT, '.test', 'openwork.png'), Buffer.from(shot.data, 'base64'));
  ws.close();
  app.kill();
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
