'use strict';
/* 验证：切 Tab / 改条件不触发检测；只有点「开始检测」才跑。 */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PORT = 9337;
const EXE = process.env.FR_EXE || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
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
    lastRepo: path.join(ROOT, '.fcrepo'), repos: [path.join(ROOT, '.fcrepo')],
    leftBranch: 'dev', rightBranch: 'release', pageSize: 200, pullMode: 'rebase', mergeTool: ''
  }, null, 2));

  const app = spawn(EXE, [ROOT, `--remote-debugging-port=${PORT}`, '--no-sandbox'], { cwd: ROOT, stdio: 'ignore' });
  let page;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch (e) { /* retry */ }
  }
  if (!page) { app.kill(); throw new Error('no page'); }
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

  await sleep(3500);
  const results = [];
  const check = (name, cond) => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name); };

  // 切到合并检查：不应自动跑
  await evaluate(`document.querySelector('.tab[data-tab="check"]').click()`);
  await sleep(2500);
  const afterTab = await evaluate(`({
    summary: document.querySelector('#ckSummary').textContent,
    rows: document.querySelectorAll('#ckList .ck-row').length,
    btnDisabled: document.querySelector('#ckRun').disabled
  })`);
  console.log('切Tab后:', JSON.stringify(afterTab));
  check('切 Tab 不自动检测', afterTab.rows === 0 && afterTab.summary.includes('开始检测') && !afterTab.btnDisabled);

  // 改检测人：不应自动跑
  await evaluate(`(() => { const s = document.querySelector('#ckAuthor'); s.value = 'Bob'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(1500);
  check('改检测人不自动检测', (await evaluate(`document.querySelectorAll('#ckList .ck-row').length`)) === 0);

  // 点按钮：跑
  await evaluate(`document.querySelector('#ckRun').click()`);
  await sleep(4000);
  const afterRun = await evaluate(`({
    rows: document.querySelectorAll('#ckList .ck-row').length,
    summary: document.querySelector('#ckSummary').textContent
  })`);
  console.log('点按钮后:', JSON.stringify(afterRun));
  check('点按钮后出结果', afterRun.rows === 1 && afterRun.summary.includes('未合并'));

  // 改条件出现提示但不重跑
  await evaluate(`(() => { const s = document.querySelector('#ckAuthor'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(1200);
  check('改条件后出现待重检提示', await evaluate(`!document.querySelector('#ckDirty').classList.contains('hidden')`));
  check('改条件后旧结果保留、未重跑', (await evaluate(`document.querySelectorAll('#ckList .ck-row').length`)) === 1);

  // 切走再切回：结果保留、不重跑
  await evaluate(`document.querySelector('.tab[data-tab="merge"]').click()`);
  await sleep(400);
  await evaluate(`document.querySelector('.tab[data-tab="check"]').click()`);
  await sleep(2000);
  check('来回切 Tab 结果保留', (await evaluate(`document.querySelectorAll('#ckList .ck-row').length`)) === 1);

  // 再点按钮重跑
  await evaluate(`document.querySelector('#ckRun').click()`);
  await sleep(4000);
  const rerun = await evaluate(`({
    rows: document.querySelectorAll('#ckList .ck-row').length,
    dirtyHidden: document.querySelector('#ckDirty').classList.contains('hidden')
  })`);
  console.log('重跑后:', JSON.stringify(rerun));
  check('重跑后 2 条未合并且提示消失', rerun.rows === 2 && rerun.dirtyHidden);

  console.log('\n结果：' + results.filter((r) => r[1]).length + ' 通过 / ' + results.filter((r) => !r[1]).length + ' 失败');
  ws.close();
  app.kill();
  process.exit(results.every((r) => r[1]) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
