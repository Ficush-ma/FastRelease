'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FR_PORT || 9403);
const REPO = process.env.FR_REPO;
const OUT = process.env.FR_OUT || 'checktab.png';
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
    if (await ev('!!document.querySelector(".tab[data-tab=\\"check\\"]")')) break;
  }
  await ev('document.querySelector(".tab[data-tab=\\"check\\"]").click()');
  for (let i = 0; i < 40; i++) { await sleep(500); if (await ev('document.querySelectorAll("#ckSource option").length > 0')) break; }

  const setSel = async (sel, val) => ev('(() => { const s = document.querySelector("' + sel + '"); const o = Array.from(s.options).find(x => x.value === ' + JSON.stringify(val) + ') || Array.from(s.options).find(x => x.textContent === ' + JSON.stringify(val) + '); if (!o) return "no option"; s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return o.value; })()');
  console.log('source 选项:', await ev('Array.from(document.querySelector("#ckSource").options).map(o => o.value).join(",")'));
  console.log('target 选项:', await ev('Array.from(document.querySelector("#ckTarget").options).map(o => o.value).join(",")'));
  console.log('set source:', await setSel('#ckSource', 'dev'));
  console.log('set target:', await setSel('#ckTarget', 'release'));
  await ev('document.querySelector("#ckOnlyUnmerged").checked = false');
  await ev('document.querySelector("#ckRun").click()');

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await ev('document.querySelectorAll("#ckList .ck-row").length > 0')) break;
  }
  console.log('汇总:', await ev('document.querySelector("#ckSummary").innerText.replace(/\\n/g, " | ")'));
  console.log('徽标:', await ev('JSON.stringify(Array.from(document.querySelectorAll("#ckList .ck-row .badge")).map(e => e.textContent + "/" + e.className))'));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(ROOT, '.test', OUT), Buffer.from(shot.data, 'base64'));
  console.log('截图:', OUT);

  ws.close();
  app.kill();
  if (REPO && backup != null) fs.writeFileSync(CFG, backup);
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
