'use strict';
// 只读验证：在真实工作目录上打开打包版，看右栏 ed8ee5db 是否出现「左侧已有」
// 注意：本脚本只做导航和读取 DOM，绝不触发推送/拉取/摘取
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'FastRelease-1.1.9-win64', 'FastRelease.exe');
const PORT = Number(process.env.FR_PORT || 9431);
const REPO = 'D:/release/wdt3_code';
const CFG = 'C:/Users/admin/AppData/Roaming/FastRelease/data/config.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => { http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });

(async () => {
  const backup = fs.existsSync(CFG) ? fs.readFileSync(CFG, 'utf8') : null;
  const c = backup ? JSON.parse(backup) : {};
  c.lastRepo = REPO;
  c.repos = [REPO, ...((c.repos || []).filter((x) => x !== REPO))];
  c.leftBranch = 'origin/dev-20251112';
  c.rightBranch = 'release-1111';
  fs.writeFileSync(CFG, JSON.stringify(c, null, 2) + '\n');

  const app = spawn(EXE, ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu'], { cwd: path.dirname(EXE), stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 80 && !page; i++) {
    await sleep(500);
    try { const l = await getJson('http://127.0.0.1:' + PORT + '/json/list'); page = (l || []).find((t) => t.type === 'page'); } catch (e) { /* retry */ }
  }
  if (!page) { app.kill(); throw new Error('窗口没起来'); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(); const errs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errs.push(String(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).slice(0, 160));
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pend.set(mid, (m) => m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return 'THROW: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r && r.result && r.result.value;
  };
  await send('Runtime.enable', {});

  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    if (await ev('document.querySelectorAll(\'.pane[data-side="right"] .commit-row\').length > 0')) break;
  }
  console.log('提交列表加载完成，用时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('左栏:', await ev('document.querySelector(\'.pane[data-side="left"] .branch-select\').value'),
    '| 右栏:', await ev('document.querySelector(\'.pane[data-side="right"] .branch-select\').value'));
  console.log('右栏行数:', await ev('document.querySelectorAll(\'.pane[data-side="right"] .commit-row\').length'));

  // 看「判定中」提示是否出现过（新版本才有）
  let sawFlagging = false;
  for (let i = 0; i < 4; i++) {
    if (await ev('!!document.querySelector(".pane.flagging")')) { sawFlagging = true; break; }
    await sleep(500);
  }
  console.log('出现「判定中…」:', sawFlagging);

  // 等两个方向都算完（最多 4 分钟）
  const t1 = Date.now();
  for (let i = 0; i < 240; i++) {
    await sleep(1000);
    const flagging = await ev('document.querySelectorAll(".pane.flagging").length');
    const leftBadges = await ev('document.querySelectorAll(\'.pane[data-side="left"] .badge.picked\').length');
    const rightBadges = await ev('document.querySelectorAll(\'.pane[data-side="right"] .badge.picked\').length');
    if (i % 10 === 0) console.log('  ...' + i + 's 判定中=' + flagging + ' 左徽标=' + leftBadges + ' 右徽标=' + rightBadges);
    if (flagging === 0 && (leftBadges > 0 || rightBadges > 0)) break;
  }
  console.log('徽标计算完成，用时', ((Date.now() - t1) / 1000).toFixed(1) + 's');

  const rowInfo = (side, hash) => `(() => {
    const rows = Array.from(document.querySelectorAll('.pane[data-side="${side}"] .commit-row'));
    const row = rows.find((r) => (r.dataset.hash || '').indexOf('${hash}') === 0);
    if (!row) return { found: false };
    return {
      found: true,
      short: row.querySelector('.col-hash').textContent.trim(),
      badges: Array.from(row.querySelectorAll('.badge')).map((b) => b.textContent.trim() + '[' + b.className.replace('badge ', '') + ']')
    };
  })()`;

  for (const h of ['ed8ee5d', '3ef9f72', '4cf5216']) {
    for (const side of ['right', 'left']) {
      const info = await ev(rowInfo(side, h));
      if (info && info.found) console.log(side + ' 栏 ' + info.short + ' → ' + (info.badges.join(' ') || '(无徽标)'));
    }
  }

  console.log('左栏徽标总数:', await ev('document.querySelectorAll(\'.pane[data-side="left"] .badge.picked\').length'));
  console.log('右栏徽标总数:', await ev('document.querySelectorAll(\'.pane[data-side="right"] .badge.picked\').length'));
  console.log('右栏蓝色(squash)徽标:', await ev('document.querySelectorAll(\'.pane[data-side="right"] .badge.picked.squash\').length'));

  const shot = await Promise.race([
    send('Page.captureScreenshot', { format: 'png' }),
    new Promise((r) => setTimeout(() => r(null), 15000))
  ]);
  if (shot && shot.data) {
    fs.writeFileSync(path.join(ROOT, '.test', 'real-fix.png'), Buffer.from(shot.data, 'base64'));
    console.log('截图: real-fix.png');
  } else console.log('截图超时');

  if (errs.length) console.log('页面异常:', errs.join(' || '));
  ws.close();
  app.kill();
  // 保留用户原来的分支选择，不还原成不存在的 release-1
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
