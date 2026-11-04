'use strict';
/* 界面验证：恢复暂存改动冲突 → 进入内置冲突界面 → 解决 → 完成恢复 */
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '.tmprepo');
const PORT = 9360;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  // 本地改动落在 a.txt，摘取会冲突，恢复也会冲突
  fs.writeFileSync(path.join(REPO, 'a.txt'), 'base\nLOCAL 本地改动\n');
  fs.writeFileSync(path.join(ROOT, '.data', 'config.json'), JSON.stringify({
    lastRepo: REPO, repos: [REPO], leftBranch: 'dev', rightBranch: 'release',
    pageSize: 200, pullMode: 'rebase', mergeTool: ''
  }, null, 2));

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [ROOT, '--remote-debugging-port=' + PORT, '--no-sandbox'], { cwd: ROOT, stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { const l = await getJson('http://127.0.0.1:' + PORT + '/json/list'); page = (l || []).find((t) => t.type === 'page'); } catch (e) { /* retry */ }
    if (page) break;
  }
  if (!page) throw new Error('窗口没起来');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const ev = (expr) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result && m.result.result && m.result.result.value));
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });

  const results = [];
  const check = (n, c, extra) => { results.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };

  for (let i = 0; i < 40; i++) { await sleep(500); if (await ev('document.querySelectorAll(\'.pane[data-side="left"] .commit-row\').length') > 0) break; }
  check('有工作区改动 chip', (await ev('document.querySelector("#dirtyChip").textContent')).includes('处改动'));

  // 摘取冲突提交
  await ev(`(() => {
    const rows = Array.from(document.querySelectorAll('.pane[data-side="left"] .commit-row'));
    const row = rows.find(x => x.textContent.includes('调整 a.txt')) || rows[0];
    row.click();
  })()`);
  await sleep(400);
  await ev('document.querySelector("#btnTransfer").click()');
  await sleep(600);
  await ev('document.querySelector("#modalOk").click()');

  let merge1 = false;
  for (let i = 0; i < 60; i++) { await sleep(500); merge1 = await ev('!document.querySelector("#mergeView").classList.contains("hidden")'); if (merge1) break; }
  check('摘取冲突窗口打开', merge1, await ev('document.querySelector("#mergeTitle").textContent'));

  await ev('document.querySelector("#mfUseOurs").click()');
  await sleep(400);
  await ev('document.querySelector("#mfSave").click()');
  await sleep(1500);
  await ev('document.querySelector("#mfContinue").click()');

  // 继续之后会自动恢复暂存 → 应该再次冲突并打开 stash 模式冲突窗口
  let merge2 = false;
  let title2 = '';
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    merge2 = await ev('!document.querySelector("#mergeView").classList.contains("hidden")');
    if (merge2) { title2 = await ev('document.querySelector("#mergeTitle").textContent'); break; }
  }
  check('恢复改动时打开冲突窗口', merge2, title2);
  check('标题是恢复冲突', /恢复冲突/.test(title2), title2);
  console.log('   ours/theirs:', await ev('document.querySelector("#oursName").textContent + " / " + document.querySelector("#theirsName").textContent'));
  console.log('   继续按钮文案:', await ev('document.querySelector("#mfContinue").textContent'));

  // 解决这个冲突
  await ev('document.querySelector("#mfUseTheirs").click()');
  await sleep(400);
  await ev('document.querySelector("#mfSave").click()');
  await sleep(1500);
  await ev('document.querySelector("#mfContinue").click()');
  await sleep(2500);

  const toasts = await ev('Array.from(document.querySelectorAll(".toast")).map(t => t.textContent)');
  console.log('   toast:', JSON.stringify(toasts));
  check('提示改动已恢复', toasts.some((t) => /改动已恢复/.test(t)), toasts);

  const stashLeft = execSync('git stash list', { cwd: REPO, encoding: 'utf8' }).trim();
  check('stash 已清空', stashLeft === '', stashLeft);
  const content = fs.readFileSync(path.join(REPO, 'a.txt'), 'utf8');
  console.log('   a.txt 内容:', JSON.stringify(content));
  check('文件内容为暂存版本（theirs）', content.includes('LOCAL'), content);

  console.log('\n结果：' + results.filter(Boolean).length + ' 通过 / ' + results.filter((r) => !r).length + ' 失败');
  ws.close();
  app.kill();
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
