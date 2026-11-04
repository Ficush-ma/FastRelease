'use strict';
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PORT = 9347;
const REPO = path.join(ROOT, '.tmprepo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

(async () => {
  fs.writeFileSync(path.join(ROOT, '.data', 'config.json'), JSON.stringify({
    lastRepo: REPO, repos: [REPO], leftBranch: 'dev', rightBranch: 'release',
    pageSize: 200, pullMode: 'rebase', mergeTool: ''
  }, null, 2));

  let page = null;
  let app = null;
  for (let attempt = 0; attempt < 2 && !page; attempt++) {
    app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
      [ROOT, `--remote-debugging-port=${PORT}`, '--no-sandbox'], { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const l = await getJson(`http://127.0.0.1:${PORT}/json/list`);
        page = (l || []).find((t) => t.type === 'page');
        if (page) break;
      } catch (e) { /* retry */ }
    }
    if (!page && app) app.kill();
  }
  if (!page) throw new Error('窗口没起来');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const evaluate = (expr) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result && m.result.result && m.result.result.value));
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });

  const rowSel = '.pane[data-side="left"] .commit-row';
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const n = await evaluate(`document.querySelectorAll('${rowSel}').length`);
    if (n > 0) break;
  }
  const picked = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('${rowSel}'));
    const row = rows.find((x) => x.textContent.includes('新增 C 模块')) || rows[0];
    if (!row) return '';
    row.click();
    return row.innerText.replace(/\\n/g, ' ').slice(0, 50);
  })()`);
  console.log('选中提交:', picked);
  await sleep(600);

  await evaluate('document.querySelector("#btnTransferPush").click()');
  await sleep(800);
  console.log('首次确认框:', await evaluate('document.querySelector("#modalTitle").textContent'));
  await evaluate('document.querySelector("#modalOk").click()');

  let sawPushConfirm = false;
  let toasts = [];
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const st = await evaluate(`({
      modal: !document.querySelector('#modal').classList.contains('hidden'),
      title: document.querySelector('#modalTitle').textContent,
      toasts: Array.from(document.querySelectorAll('.toast')).map(t => t.textContent)
    })`);
    toasts = st.toasts;
    if (st.modal && /推送/.test(st.title)) { sawPushConfirm = true; break; }
    if (st.toasts.some((t) => /推送成功|已推送|没有需要推送/.test(t))) break;
  }
  console.log('toast:', JSON.stringify(toasts));
  console.log('二次推送确认框:', sawPushConfirm);
  console.log('远端 release:');
  console.log(execSync('git --git-dir=.tmpremote.git log --oneline release -2', { cwd: ROOT, encoding: 'utf8' }).trim());

  ws.close();
  if (app) app.kill();
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
