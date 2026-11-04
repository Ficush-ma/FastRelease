'use strict';
const { spawn } = require('child_process');
const http = require('http'); const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FR_PORT || 9423);
const REPO = 'C:/Users/admin/AppData/Local/Temp/fr-fixtab3/repo';
const CFG = path.join(ROOT, '.data', 'config.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => { http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });
(async () => {
  const backup = fs.existsSync(CFG) ? fs.readFileSync(CFG, 'utf8') : null;
  const c = backup ? JSON.parse(backup) : {};
  c.lastRepo = REPO; c.repos = [REPO, ...((c.repos || []).filter((x) => x !== REPO))];
  c.leftBranch = 'dev'; c.rightBranch = 'release-1';
  fs.writeFileSync(CFG, JSON.stringify(c, null, 2) + '\n');

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, '--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu'], { cwd: ROOT, stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { await sleep(500); try { const l = await getJson('http://127.0.0.1:' + PORT + '/json/list'); page = (l || []).find((t) => t.type === 'page'); } catch (e) {} }
  if (!page) { app.kill(); throw new Error('no page'); }
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const ev = async (x) => { const mid = ++id; const p = new Promise((r) => pend.set(mid, (m) => r(m.result && m.result.result && m.result.result.value))); ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: x, returnByValue: true } })); return p; };

  for (let i = 0; i < 50; i++) { await sleep(500); if (await ev('document.querySelectorAll(\'.pane[data-side="left"] .commit-row\').length > 0')) break; }
  for (let i = 0; i < 30; i++) { await sleep(500); if (await ev('document.querySelectorAll(\'.pane[data-side="left"] .badge.picked\').length > 0')) break; }
  console.log('快速合并页 已摘取徽标:', await ev('document.querySelectorAll(\'.pane[data-side="left"] .badge.picked\').length'));

  await ev('document.querySelector(\'.tab[data-tab="fix"]\').click()');
  for (let i = 0; i < 30; i++) { await sleep(400); if (await ev('document.querySelectorAll("#fixBranchList .fix-row").length > 0')) break; }
  await sleep(1200);
  console.log('批量页 已摘取徽标:', await ev('document.querySelectorAll(\'.pane[data-side="left"] .badge.picked\').length'));
  console.log('批量页 提交行数:', await ev('document.querySelectorAll(\'.pane[data-side="left"] .commit-row\').length'));

  await ev('document.querySelector(\'.tab[data-tab="merge"]\').click()');
  await sleep(2500);
  console.log('切回快速合并页 已摘取徽标:', await ev('document.querySelectorAll(\'.pane[data-side="left"] .badge.picked\').length'));

  ws.close(); app.kill();
  if (backup != null) fs.writeFileSync(CFG, backup);
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
