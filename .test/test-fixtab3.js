'use strict';
// 批量「摘取并推送」：每个分支摘完立即推送
const { execFileSync, spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const TMP = 'C:/Users/admin/AppData/Local/Temp/fr-fixtab3';
const REPO = path.join(TMP, 'repo');
const REMOTE = path.join(TMP, 'remote.git');
const PORT = Number(process.env.FR_PORT || 9419);
const CFG = path.join(ROOT, '.data', 'config.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function g(...args) {
  return execFileSync('git', ['-c', 'user.email=t@l', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
}
const write = (n, t) => fs.writeFileSync(path.join(REPO, n), t);

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(REPO, { recursive: true });
execFileSync('git', ['init', '-q', '--bare', REMOTE]);
g('init', '-q', '-b', 'master');
write('a.txt', 'l1\nl2\n');
g('add', '.'); g('commit', '-qm', 'init');
g('remote', 'add', 'origin', REMOTE);
g('checkout', '-q', '-b', 'dev');
write('x1.txt', 'one\n'); g('add', '.'); g('commit', '-qm', 'A 新增 x1');
for (const br of ['release-1', 'release-2']) {
  g('checkout', '-q', '-b', br, 'master');
  g('push', '-q', '-u', 'origin', br);
}
g('checkout', '-q', 'release-1');
g('push', '-q', 'origin', 'master', 'dev');
console.log('仓库就绪，远端:', REMOTE);

const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  const backup = fs.existsSync(CFG) ? fs.readFileSync(CFG, 'utf8') : null;
  const c = backup ? JSON.parse(backup) : {};
  c.lastRepo = REPO;
  c.repos = [REPO, ...((c.repos || []).filter((x) => x !== REPO))];
  c.leftBranch = 'dev';
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
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errs.push('EXC ' + String(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).slice(0, 160));
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
  await ev('document.querySelector(\'.tab[data-tab="fix"]\').click()');
  for (let i = 0; i < 40; i++) { await sleep(400); if (await ev('document.querySelectorAll("#fixBranchList .fix-row").length > 0')) break; }
  await ev('document.querySelector(\'.pane[data-side="left"] .select-all\').click()');
  await sleep(300);
  await ev('document.querySelector("#btnFixAll").click()');
  await sleep(300);
  console.log('已选分支:', await ev('document.querySelector("#fixSelCount").textContent'));

  await ev('document.querySelector("#btnFixPickPush").click()');
  for (let i = 0; i < 40; i++) { await sleep(400); if (await ev('!document.querySelector("#modal").classList.contains("hidden")')) break; }
  await ev('document.querySelector("#modalOk").click()');

  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const mergeOpen = await ev('!document.querySelector("#mergeView").classList.contains("hidden")');
    if (mergeOpen) {
      console.log('  → 冲突，自动用右侧解决');
      await ev('document.querySelector("#mfUseTheirs").click()');
      await sleep(300);
      await ev('document.querySelector("#mfSave").click()');
      await sleep(900);
      if (await ev('!document.querySelector("#mfContinue").disabled')) await ev('document.querySelector("#mfContinue").click()');
      await sleep(2000);
      continue;
    }
    const rows = await ev('document.querySelectorAll("#fixResult .fix-result-row").length');
    const busy = await ev('document.querySelector("#statusDot").className.indexOf("busy") >= 0');
    if (!busy && rows >= 2) break;
  }
  await sleep(1500);
  console.log('结果:', await ev('JSON.stringify(Array.from(document.querySelectorAll("#fixResult .fix-result-row")).map(e => e.innerText.replace(/\\n/g, " ")))'));
  if (errs.length) console.log('页面异常:', errs.join(' || '));

  ws.close();
  app.kill();
  if (backup != null) fs.writeFileSync(CFG, backup);

  console.log('\n--- 远端校验 ---');
  const remoteLog = (br) => execFileSync('git', ['--git-dir', REMOTE, 'log', '--oneline', br, '-3'], { encoding: 'utf8' }).trim().split('\n').map((x) => x.slice(0, 46));
  for (const br of ['release-1', 'release-2']) {
    console.log('[' + br + '] 远端:');
    remoteLog(br).forEach((l) => console.log('   ' + l));
  }
  console.log('本地工作区:', g('status', '--short').trim() || '干净');
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
