'use strict';
/* 用真实大仓库验证：界面可用时间、勾选后摘取按钮是否立刻可点 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 9342;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [ROOT, `--remote-debugging-port=${PORT}`, '--no-sandbox'], { cwd: ROOT, stdio: 'ignore' });
  let page;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try { const l = await getJson(`http://127.0.0.1:${PORT}/json/list`); page = l.find((t) => t.type === 'page'); if (page) break; } catch (e) { /* retry */ }
  }
  if (!page) { app.kill(); throw new Error('窗口没起来'); }
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

  const q = (sel) => `document.querySelectorAll(${JSON.stringify(sel)}).length`;

  let waited = 0;
  let rows = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(500); waited += 500;
    rows = await evaluate(q('.pane[data-side="left"] .commit-row'));
    if (rows > 0) break;
  }
  console.log(`左栏提交出现：${waited}ms（${rows} 行）`);
  console.log('状态栏：', await evaluate('document.querySelector("#statusText").textContent'));

  await evaluate(`document.querySelector('.pane[data-side="left"] .commit-row').click()`);
  await sleep(500);
  const after = await evaluate(`({
    disabled: document.querySelector('#btnTransfer').disabled,
    pushDisabled: document.querySelector('#btnTransferPush').disabled,
    count: document.querySelector('#btnTransfer .xfer-count').textContent,
    hint: document.querySelector('.xfer-hint').innerText.replace(/\\n/g, ' ')
  })`);
  console.log('勾选后按钮:', JSON.stringify(after));

  // 等「已摘取」标记算完（后台计算），最多 60 秒
  let badges = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    badges = await evaluate(q('.pane[data-side="left"] .badge.picked'));
    if (badges > 0) break;
  }
  console.log('已摘取标记数量:', badges, `（等待 ${(i2 => i2)()}s 级别）`);
  console.log('标记算完后按钮仍可点:', !(await evaluate('document.querySelector("#btnTransfer").disabled')));

  ws.close();
  app.kill();
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
