'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PORT = 9338;
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
  const cfgPath = process.env.FR_CFG || path.join(ROOT, '.data', 'config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({
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

  await sleep(4500);
  const results = [];
  const check = (name, cond) => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name); };

  // 1. 左栏作者下拉已填充
  const opts = await evaluate(`Array.from(document.querySelectorAll('.pane[data-side="left"] .author-select option')).map(o => o.value)`);
  console.log('左栏作者选项:', JSON.stringify(opts));
  check('作者下拉包含 Alice/Bob', opts.includes('Alice') && opts.includes('Bob'));

  // 2. 选 Bob 后列表只剩 Bob 的提交
  await evaluate(`(() => { const s = document.querySelector('.pane[data-side="left"] .author-select'); s.value = 'Bob'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(2500);
  const bobRows = await evaluate(`Array.from(document.querySelectorAll('.pane[data-side="left"] .commit-row')).map(r => r.querySelector('.col-author') && r.querySelector('.col-author').textContent)`);
  const bobAuthors = await evaluate(`Array.from(document.querySelectorAll('.pane[data-side="left"] .commit-row .row-author, .pane[data-side="left"] .commit-row')).length`);
  console.log('Bob 过滤后行数:', bobRows.length, '作者:', JSON.stringify(bobRows.slice(0, 3)));
  check('选 Bob 后仅 1 条', bobRows.length === 1);

  // 3. 切回全部作者恢复
  await evaluate(`(() => { const s = document.querySelector('.pane[data-side="left"] .author-select'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(3000);
  const backN = await evaluate(`document.querySelectorAll('.pane[data-side="left"] .commit-row').length`);
  console.log('切回全部后行数:', backN);
  check('切回全部作者后恢复', backN === 4);

  // 4. 合并检查默认检测人是「全部人」
  await evaluate(`document.querySelector('.tab[data-tab="check"]').click()`);
  await sleep(2500);
  const defAuthor = await evaluate(`document.querySelector('#ckAuthor').value`);
  console.log('检测默认作者:', JSON.stringify(defAuthor));
  check('检测默认=全部人', defAuthor === '');

  console.log('\n结果：' + results.filter((r) => r[1]).length + ' 通过 / ' + results.filter((r) => !r[1]).length + ' 失败');
  ws.close();
  app.kill();
  process.exit(results.every((r) => r[1]) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
