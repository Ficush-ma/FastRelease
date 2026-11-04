'use strict';
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}}); }).on('error', rej);
});
(async () => {
  fs.writeFileSync(path.join(ROOT, '.data', 'config.json'), JSON.stringify({
    lastRepo: path.join(ROOT, '.tmprepo'), repos: [path.join(ROOT, '.tmprepo')],
    leftBranch: 'dev', rightBranch: 'release', pageSize: 200, pullMode: 'rebase', mergeTool: ''
  }, null, 2));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [ROOT, '--remote-debugging-port=' + PORT, '--no-sandbox'], { cwd: ROOT, stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { const l = await getJson('http://127.0.0.1:' + PORT + '/json/list'); page = (l||[]).find(t=>t.type==='page'); } catch(e) {}
    if (page) break;
  }
  if (!page) throw new Error('窗口没起来');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const ev = (expr) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result && m.result.result && m.result.result.value));
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });

  for (let i = 0; i < 40; i++) { await sleep(500); if (await ev('document.querySelectorAll(\'.pane[data-side="left"] .commit-row\').length') > 0) break; }
  const picked = await ev(`(() => {
    const rows = Array.from(document.querySelectorAll('.pane[data-side="left"] .commit-row'));
    const row = rows.find(x => x.textContent.includes('调整 a.txt')) || rows[0];
    row.click(); return row.innerText.replace(/\n/g,' ').slice(0,45);
  })()`);
  console.log('选中冲突提交:', picked);
  await sleep(500);
  await ev('document.querySelector("#btnTransferPush").click()');
  await sleep(700);
  await ev('document.querySelector("#modalOk").click()');
  // 等冲突窗口
  let mergeOpen = false;
  for (let i = 0; i < 60; i++) { await sleep(500); mergeOpen = await ev('!document.querySelector("#mergeView").classList.contains("hidden")'); if (mergeOpen) break; }
  console.log('冲突窗口打开:', mergeOpen);
  if (mergeOpen) {
    await ev('document.querySelector("#mfUseOurs").click()');
    await sleep(500);
    await ev('document.querySelector("#mfSave").click()');
    await sleep(1200);
    console.log('继续按钮可用:', !(await ev('document.querySelector("#mfContinue").disabled')));
    await ev('document.querySelector("#mfContinue").click()');
  }
  let toasts = [];
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const st = await ev('({ modal: !document.querySelector("#modal").classList.contains("hidden"), title: document.querySelector("#modalTitle").textContent, toasts: Array.from(document.querySelectorAll(".toast")).map(t=>t.textContent) })');
    toasts = st.toasts;
    if (st.modal) { console.log('出现确认框:', st.title); }
    if (st.toasts.some(t => /已推送|推送成功/.test(t))) break;
  }
  console.log('toast:', JSON.stringify(toasts));
  console.log('远端 release:'); console.log(execSync('git --git-dir=.tmpremote.git log --oneline release -2', { cwd: ROOT, encoding: 'utf8' }).trim());
  ws.close(); app.kill();
})().catch(e => { console.error('FAILED:', e.message||e); process.exit(1); });
