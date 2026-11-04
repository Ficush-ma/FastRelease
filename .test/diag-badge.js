'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FR_PORT || 9401);
const REPO = process.env.FR_REPO;
const OUT = process.env.FR_OUT || 'badge.png';
const CFG = path.join(ROOT, '.data', 'config.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  const backup = fs.existsSync(CFG) ? fs.readFileSync(CFG, 'utf8') : null;
  if (REPO) {
    const c = backup ? JSON.parse(backup) : {};
    c.lastRepo = REPO;
    c.repos = [REPO, ...((c.repos || []).filter((x) => x !== REPO))];
    c.leftBranch = 'dev';
    c.rightBranch = 'release';
    fs.writeFileSync(CFG, JSON.stringify(c, null, 2) + '\n');
  }

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [ROOT, '--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu'], { cwd: ROOT, stdio: 'ignore' });

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
    if (r && r.exceptionDetails) return 'THROW: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r && r.result && r.result.value;
  };

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await ev('document.querySelectorAll(".pane[data-side=\\"left\\"] .commit-row").length > 0')) break;
  }
  // 等徽标算完
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await ev('document.querySelectorAll(".badge.picked").length > 0')) break;
  }

  console.log('左侧提交行:', await ev('document.querySelectorAll(".pane[data-side=\\"left\\"] .commit-row").length'));
  console.log('已摘取徽标(总数):', await ev('document.querySelectorAll(".pane[data-side=\\"left\\"] .badge.picked").length'));
  console.log('其中 squash 样式:', await ev('document.querySelectorAll(".pane[data-side=\\"left\\"] .badge.picked.squash").length'));
  console.log('squash 徽标背景色:', await ev('(() => { const e = document.querySelector(".badge.picked.squash"); return e ? getComputedStyle(e).backgroundColor : "(无)"; })()'));
  console.log('普通徽标背景色:', await ev('(() => { const e = document.querySelector(".badge.picked:not(.squash)"); return e ? getComputedStyle(e).backgroundColor : "(无)"; })()'));
  console.log('徽标文案:', await ev('JSON.stringify(Array.from(document.querySelectorAll(".pane[data-side=\\"left\\"] .badge.picked")).map(e => e.textContent + "|" + e.title).slice(0,4))'));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(ROOT, '.test', OUT), Buffer.from(shot.data, 'base64'));
  console.log('截图:', OUT);

  ws.close();
  app.kill();
  if (REPO && backup != null) fs.writeFileSync(CFG, backup);
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
