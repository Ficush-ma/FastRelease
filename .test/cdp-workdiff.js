'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FR_PORT || 9371);
const PICK = process.env.FR_PICK || 'a.txt';
const OUT = process.env.FR_OUT || 'workdiff.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
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
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result && r.result.value;
  };

  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await ev('!!document.querySelector("#dirtyChip")')) break;
  }

  await ev('document.querySelector("#dirtyChip").click()');
  await sleep(2000);

  await ev('(() => { const it = Array.from(document.querySelectorAll(".work-item")).find(x => x.dataset.path.indexOf(' + JSON.stringify(PICK) + ') >= 0); if (it) it.click(); })()');
  await sleep(2500);

  console.log('目标文件:', PICK);
  console.log('新增行:', await ev('document.querySelectorAll("#workDiff .dl.add").length'),
    '删除行:', await ev('document.querySelectorAll("#workDiff .dl.del").length'),
    '总行:', await ev('document.querySelectorAll("#workDiff .dl").length'));
  console.log('显示文本(前 80):', JSON.stringify(await ev('document.querySelector("#workDiff").innerText.slice(0, 80)')));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(ROOT, '.test', OUT), Buffer.from(shot.data, 'base64'));
  console.log('截图:', OUT);
  ws.close();
  app.kill();
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
