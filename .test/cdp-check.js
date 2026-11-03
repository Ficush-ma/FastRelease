'use strict';

/** 用 CDP 驱动真实窗口验证「合并检查」页签 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 9334;
const ELECTRON = process.env.FR_EXE || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const IS_PACKAGED = !!process.env.FR_EXE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) { /* 等 */ }
    await sleep(500);
  }
  throw new Error('调试端口没起来');
}

(async () => {
  const appArgs = [`--remote-debugging-port=${PORT}`, '--no-sandbox'];
  if (!IS_PACKAGED) appArgs.unshift(ROOT);
  const app = spawn(ELECTRON, appArgs, { cwd: ROOT, stdio: 'ignore' });
  const target = await waitTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception));
    return r.result && r.result.result && r.result.result.value;
  };

  await sleep(4000);
  console.log('页签:', await evaluate(`Array.from(document.querySelectorAll('.tab')).map(t => t.textContent).join(' | ')`));

  await evaluate(`document.querySelector('[data-tab="check"]').click()`);
  await sleep(3500);

  const snap = `(() => ({
    tabActive: document.querySelector('.tab.active').textContent,
    checkVisible: !document.querySelector('#viewCheck').classList.contains('hidden'),
    mergeHidden: document.querySelector('#viewMerge').classList.contains('hidden'),
    summary: document.querySelector('#ckSummary').innerText.replace(/\\n/g, ' | '),
    rows: Array.from(document.querySelectorAll('.ck-row')).map(r => r.innerText.replace(/\\s+/g, ' ').trim()),
    authors: Array.from(document.querySelectorAll('#ckAuthor option')).map(o => o.textContent),
    author: document.querySelector('#ckAuthor').value,
    time: document.querySelector('#ckTime').value,
    source: document.querySelector('#ckSource').value,
    target: document.querySelector('#ckTarget').value
  }))()`;

  const first = await evaluate(snap);
  console.log('\n默认（最近30天 / 自动选中当前用户 Alice）:');
  console.log(JSON.stringify(first, null, 2));

  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, 'preview-check.png'), Buffer.from(shot1.result.data, 'base64'));

  console.log('\n>>> 切换检测人为 Bob');
  await evaluate(`(() => { const s = document.querySelector('#ckAuthor'); s.value = 'Bob'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(2500);
  const second = await evaluate(snap);
  console.log(JSON.stringify({ summary: second.summary, rows: second.rows }, null, 2));

  console.log('\n>>> 切回「全部人」，再取消「只看未合并」');
  await evaluate(`(() => { const s = document.querySelector('#ckAuthor'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(2500);
  const allUnmerged = await evaluate(snap);
  await evaluate(`(() => { const c = document.querySelector('#ckOnlyUnmerged'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(800);
  const third = await evaluate(snap);
  console.log(JSON.stringify({ 只看未合并: allUnmerged.rows.length, 显示全部: third.rows.length, rows: third.rows }, null, 2));

  const ok = first.checkVisible && first.mergeHidden && first.rows.length === 1
    && first.summary.includes('未合并') && first.time === '30'
    && second.rows.length === 1 && second.rows[0].includes('Bob')
    && allUnmerged.rows.length === 2 && third.rows.length === 4;

  console.log('\n结果:', ok ? 'PASS' : 'FAIL');
  try { app.kill(); } catch (_) {}
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
