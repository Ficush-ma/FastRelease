'use strict';
// 批量摘取 tab 的端到端测试：建仓 → 打开界面 → 勾提交/分支 → 摘取 → 校验各分支
const { execFileSync, spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const TMP = 'C:/Users/admin/AppData/Local/Temp/fr-fixtab';
const REPO = path.join(TMP, 'repo');
const PORT = Number(process.env.FR_PORT || 9411);
const CFG = path.join(ROOT, '.data', 'config.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function g(...args) {
  return execFileSync('git', ['-c', 'user.email=t@l', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
}
const write = (name, text) => fs.writeFileSync(path.join(REPO, name), text);

/* ---------- 建仓 ---------- */
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(REPO, { recursive: true });
g('init', '-q', '-b', 'master');
write('a.txt', 'l1\nl2\nl3\n');
g('add', '.');
g('commit', '-qm', 'init');
g('checkout', '-q', '-b', 'dev');
write('x1.txt', 'one\n');
g('add', '.');
g('commit', '-qm', 'A 新增 x1');
write('a.txt', 'l1\ndev-2\nl3\n');
g('commit', '-qam', 'B 改 a.txt 第2行');

// 三个目标分支：release-1 / release-2（已含 A）/ release-3
g('checkout', '-q', 'master');
for (const br of ['release-1', 'release-2', 'release-3']) {
  g('checkout', '-q', '-b', br, 'master');
}
g('checkout', '-q', 'release-2');
const A = g('rev-parse', 'dev~1').trim();
g('cherry-pick', A);
g('checkout', '-q', 'release-1');
console.log('仓库就绪:', REPO);
console.log('分支:', g('branch', '--format=%(refname:short)').trim().split('\n').join(', '));

/* ---------- 界面流程 ---------- */
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  const backup = fs.existsSync(CFG) ? fs.readFileSync(CFG, 'utf8') : null;
  const c = backup ? JSON.parse(backup) : {};
  c.lastRepo = REPO;
  c.repos = [REPO, ...((c.repos || []).filter((x) => x !== REPO))];
  c.leftBranch = 'dev';
  c.rightBranch = 'release-1';
  fs.writeFileSync(CFG, JSON.stringify(c, null, 2) + '\n');

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
  let id = 0; const pending = new Map(); const errs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errs.push('EXC ' + JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).slice(0, 200));
  };
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
  await send('Runtime.enable', {});

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await ev('document.querySelectorAll(\'.pane[data-side="left"] .commit-row\').length > 0')) break;
  }
  console.log('左侧提交数:', await ev('document.querySelectorAll(\'.pane[data-side="left"] .commit-row\').length'));

  await ev('document.querySelector(\'.tab[data-tab="fix"]\').click()');
  for (let i = 0; i < 40; i++) { await sleep(400); if (await ev('document.querySelectorAll("#fixBranchList .fix-row").length > 0')) break; }
  console.log('右栏分支数:', await ev('document.querySelectorAll("#fixBranchList .fix-row").length'));
  console.log('分支列表:', await ev('JSON.stringify(Array.from(document.querySelectorAll("#fixBranchList .fix-row .fix-name")).map(e => e.textContent))'));
  console.log('左栏是否搬进 fix 页:', await ev('!!document.querySelector("#fixPaneHost .pane[data-side=\\"left\\"]")'));
  console.log('fix 页可见:', await ev('!document.querySelector("#viewFix").classList.contains("hidden")'));

  // 勾选左侧全部提交
  await ev('document.querySelector(\'.pane[data-side="left"] .select-all\').click()');
  await sleep(600);
  console.log('已选提交:', await ev('document.querySelector(\'.pane[data-side="left"] .select-all\').closest(".pane").querySelectorAll(".commit-row.selected").length'));

  // 勾选右栏全部分支
  await ev('document.querySelector("#btnFixAll").click()');
  await sleep(600);
  console.log('已选分支:', await ev('document.querySelector("#fixSelCount").textContent'));
  console.log('摘取按钮可用:', await ev('!document.querySelector("#btnFixPick").disabled'));

  // 点摘取 → 确认
  await ev('document.querySelector("#btnFixPick").click()');
  for (let i = 0; i < 40; i++) { await sleep(400); if (await ev('!document.querySelector("#modal").classList.contains("hidden")')) break; }
  const modalBody = await ev('document.querySelector("#modalBody") ? document.querySelector("#modalBody").innerText.replace(/\\n/g, " | ") : ""');
  console.log('确认框:', JSON.stringify(String(modalBody).slice(0, 240)));
  await ev('document.querySelector("#modalOk").click()');

  // 等执行结果（冲突时自动用左侧解决并继续）
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const mergeOpen = await ev('!document.querySelector("#mergeView").classList.contains("hidden")');
    if (mergeOpen) {
      console.log('  → 冲突窗口出现，自动用左侧解决');
      await ev('document.querySelector("#mfUseOurs").click()');
      await sleep(400);
      await ev('document.querySelector("#mfSave").click()');
      await sleep(1000);
      if (await ev('!document.querySelector("#mfContinue").disabled')) await ev('document.querySelector("#mfContinue").click()');
      await sleep(1500);
      continue;
    }
    const rows = await ev('document.querySelectorAll("#fixResult .fix-result-row").length');
    const busy = await ev('document.querySelector("#statusDot").className.indexOf("busy") >= 0');
    if (i % 5 === 0) console.log('  ...' + i + 's 结果行=' + rows + ' 运行中=' + busy);
    if (!busy && rows >= 3) break;
  }
  await sleep(1000);
  console.log('结果行:', await ev('JSON.stringify(Array.from(document.querySelectorAll("#fixResult .fix-result-row")).map(e => e.innerText.replace(/\\n/g, " ")))'));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(ROOT, '.test', 'fixtab.png'), Buffer.from(shot.data, 'base64'));
  console.log('截图: fixtab.png');
  if (errs.length) console.log('页面异常:', errs.join(' || '));

  ws.close();
  app.kill();
  if (backup != null) fs.writeFileSync(CFG, backup);

  /* ---------- 校验各分支 ---------- */
  console.log('\n--- 分支校验 ---');
  for (const br of ['release-1', 'release-2', 'release-3']) {
    const log = g('log', '--oneline', br, '-4').trim().split('\n').map((x) => x.slice(0, 40));
    const hasX1 = (() => { try { g('cat-file', '-e', br + ':x1.txt'); return true; } catch (e) { return false; } })();
    const line2 = g('show', br + ':a.txt').split('\n')[1];
    console.log(br + ' | x1.txt: ' + (hasX1 ? '有' : '无') + ' | a.txt 第2行: ' + line2);
    log.forEach((l) => console.log('   ' + l));
  }
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
