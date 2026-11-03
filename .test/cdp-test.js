'use strict';

/**
 * 零依赖 UI 测试：用 Electron 的远程调试协议（CDP）驱动真实窗口。
 * 用法：node .test/cdp-test.js
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 9333;
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function waitForTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error('等不到调试端口');
}

(async () => {
  const app = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${PORT}`, '--no-sandbox'], {
    cwd: ROOT,
    stdio: 'ignore'
  });

  const target = await waitForTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });

  const send = (method, params) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });

  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails.exception));
    }
    return r.result && r.result.result && r.result.result.value;
  };

  await sleep(4000);

  const snapshot = () => evaluate(`(() => ({
    leftBranch: document.querySelector('#leftBranch').value,
    rightBranch: document.querySelector('#rightBranch').value,
    leftRows: document.querySelectorAll('.pane[data-side="left"] .commit-row').length,
    rightRows: document.querySelectorAll('.pane[data-side="right"] .commit-row').length,
    leftBadges: Array.from(document.querySelectorAll('.pane[data-side="left"] .badge.picked')).map(e => e.textContent),
    rightBadges: Array.from(document.querySelectorAll('.pane[data-side="right"] .badge.picked')).map(e => e.textContent),
    leftSubjects: Array.from(document.querySelectorAll('.pane[data-side="left"] .col-msg .text')).map(e => e.textContent),
    status: document.querySelector('#statusText').textContent
  }))()`);

  const before = await snapshot();
  console.log('切换前:', JSON.stringify(before, null, 2));

  console.log('\n>>> 切换左栏分支 dev -> hotfix（不点刷新按钮）');
  await evaluate(`(() => {
    const sel = document.querySelector('#leftBranch');
    sel.value = 'hotfix';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value;
  })()`);

  let after = null;
  for (let i = 0; i < 10; i++) {
    await sleep(1200);
    after = await snapshot();
    if (after.leftBranch === 'hotfix' && after.leftRows > 0 && after.leftRows !== before.leftRows) break;
  }
  console.log('切换后:', JSON.stringify(after, null, 2));

  const ok = after.leftBranch === 'hotfix'
    && after.leftRows !== before.leftRows
    && after.leftSubjects.join('|') !== before.leftSubjects.join('|')
    && after.rightBadges.length === 0;
  console.log('\n结果:', ok ? 'PASS 切换分支后列表与两栏标记都已自动刷新' : 'FAIL 自动刷新不完全');

  await send('Browser.close').catch(() => {});
  try { app.kill(); } catch (_) {}
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('测试失败:', e.message);
  process.exit(1);
});
