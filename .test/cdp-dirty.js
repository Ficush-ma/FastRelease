'use strict';
/* 验证：工作区改动弹窗 + 摘取确认里的自动暂存说明 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PORT = 9343;
const REPO = path.join(ROOT, '.tmprepo');
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
  fs.writeFileSync(path.join(ROOT, '.data', 'config.json'), JSON.stringify({
    lastRepo: REPO, repos: [REPO], leftBranch: 'dev', rightBranch: 'release',
    pageSize: 200, pullMode: 'rebase', mergeTool: ''
  }, null, 2));

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [ROOT, `--remote-debugging-port=${PORT}`, '--no-sandbox'], { cwd: ROOT, stdio: 'ignore' });
  let page;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try { const l = await getJson(`http://127.0.0.1:${PORT}/json/list`); page = l.find((t) => t.type === 'page'); if (page) break; } catch (e) { /* retry */ }
  }
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

  await sleep(4000);
  const results = [];
  const check = (n, c, extra) => { results.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (extra ? ' → ' + JSON.stringify(extra) : '')); };

  // 顶部 chip 存在且可点
  const chip = await evaluate(`(() => {
    const el = document.querySelector('#dirtyChip');
    return el ? el.textContent.trim() : '';
  })()`);
  check('有工作区改动 chip', chip.includes('处改动'), chip);

  await evaluate(`document.querySelector('#dirtyChip').click()`);
  await sleep(2500);
  const view = await evaluate(`({
    visible: !document.querySelector('#workView').classList.contains('hidden'),
    count: document.querySelectorAll('#workList .work-item').length,
    firstCode: (document.querySelector('#workList .wcode') || {}).textContent,
    diff: (document.querySelector('#workDiff') || {}).textContent.slice(0, 30)
  })`);
  check('弹窗打开并列出文件', view.visible && view.count >= 1, view);
  check('首个文件有 diff 内容', !!view.diff && !view.diff.includes('从左侧选择'), view.diff);

  // 点第二个文件
  const second = await evaluate(`(() => {
    const items = document.querySelectorAll('#workList .work-item');
    if (items.length < 2) return null;
    items[1].click();
    return items[1].dataset.path;
  })()`);
  if (second) {
    await sleep(1500);
    const t = await evaluate(`document.querySelector('#workDiff').textContent.slice(0, 30)`);
    check('切换文件能加载 diff', !!t && !t.includes('读取中'), { second, t });
  }

  await evaluate(`document.querySelector('#workClose').click()`);
  await sleep(300);
  check('关闭弹窗', await evaluate(`document.querySelector('#workView').classList.contains('hidden')`));

  // 摘取确认里的自动暂存说明
  await evaluate(`document.querySelector('.pane[data-side="left"] .commit-row').click()`);
  await sleep(400);
  await evaluate(`document.querySelector('#btnTransfer').click()`);
  await sleep(600);
  const body = await evaluate(`document.querySelector('#modalBody').innerText`);
  check('确认框说明自动暂存', body.includes('stash') || body.includes('暂存'), body.slice(0, 80));
  await evaluate(`document.querySelector('#modalCancel').click()`);

  console.log('\n结果：' + results.filter(Boolean).length + ' 通过 / ' + results.filter((r) => !r).length + ' 失败');
  ws.close();
  app.kill();
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
