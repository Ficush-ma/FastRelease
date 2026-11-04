'use strict';
const { spawn } = require('child_process');
const http = require('http'); const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FR_PORT || 9421);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => { http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });
(async () => {
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, '--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu'], { cwd: ROOT, stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { await sleep(500); try { const l = await getJson('http://127.0.0.1:' + PORT + '/json/list'); page = (l || []).find((t) => t.type === 'page'); } catch (e) {} }
  if (!page) { app.kill(); throw new Error('no page'); }
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const ev = async (x) => { const mid = ++id; const p = new Promise((r) => pend.set(mid, (m) => r(m.result && m.result.result && m.result.result.value))); ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: x, returnByValue: true } })); return p; };
  for (let i = 0; i < 40; i++) { await sleep(500); if (await ev('document.querySelectorAll(\'.pane[data-side="left"] .commit-row\').length > 0')) break; }
  console.log('初始: merge 页左栏在 viewMerge =', await ev('!!document.querySelector("#viewMerge .pane[data-side=\\"left\\"]")'));
  await ev('document.querySelector(\'.tab[data-tab="fix"]\').click()'); await sleep(1200);
  console.log('切到 fix: 左栏在 fixPaneHost =', await ev('!!document.querySelector("#fixPaneHost .pane[data-side=\\"left\\"]")'), '| 右栏仍可见 =', await ev('!!document.querySelector("#viewMerge .pane[data-side=\\"right\\"]")'));
  await ev('document.querySelector(\'.tab[data-tab="merge"]\').click()'); await sleep(1200);
  console.log('切回 merge: 左栏回 viewMerge =', await ev('!!document.querySelector("#viewMerge .pane[data-side=\\"left\\"]")'));
  console.log('左栏与右栏顺序正确 =', await ev('(() => { const k = Array.from(document.querySelectorAll("#viewMerge > *")).map(e => e.className.split(" ")[0] + (e.dataset.side ? ":" + e.dataset.side : "")); return k.join(","); })()'));
  console.log('左栏提交仍在 =', await ev('document.querySelectorAll(\'.pane[data-side="left"] .commit-row\').length'));
  ws.close(); app.kill();
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
