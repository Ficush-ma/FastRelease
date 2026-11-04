'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FR_PORT || 9396);
const EXE = process.env.FR_EXE || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const CFG = 'C:/Users/admin/AppData/Roaming/FastRelease/data/config.json';
const OUT = process.env.FR_OUT || 'realclick.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  const cfgBackup = fs.readFileSync(CFG, 'utf8');
  if (process.env.FR_SETCFG) {
    const c = JSON.parse(cfgBackup);
    c.lastRepo = process.env.FR_SETCFG;
    fs.writeFileSync(CFG, JSON.stringify(c, null, 2) + '\n');
    console.log('配置临时指向:', c.lastRepo);
  }

  const app = spawn(EXE, [ROOT, '--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu'], { cwd: ROOT, stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try { const l = await getJson('http://127.0.0.1:' + PORT + '/json/list'); page = (l || []).find((t) => t.type === 'page'); } catch (e) { /* retry */ }
  }
  if (!page) { app.kill(); fs.writeFileSync(CFG, cfgBackup); throw new Error('窗口没起来'); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
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

  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await ev('!!document.querySelector("#dirtyChip")')) break;
  }
  console.log('chip 文本:', await ev('(document.querySelector("#dirtyChip")||{}).textContent'));
  const rect = await ev('(() => { const e = document.querySelector("#dirtyChip"); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }; })()');
  console.log('chip 位置:', JSON.stringify(rect));
  console.log('该点上最顶层元素:', await ev('(() => { const el = document.elementFromPoint(' + (rect ? rect.x : 0) + ', ' + (rect ? rect.y : 0) + '); return el ? el.id + "." + el.className : null; })()'));

  if (rect) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
  }
  await sleep(2500);

  console.log('点击后 workView class:', await ev('document.querySelector("#workView").className'));
  console.log('workCount:', JSON.stringify(await ev('document.querySelector("#workCount").textContent')));
  console.log('workDiff:', JSON.stringify(await ev('document.querySelector("#workDiff").innerText.slice(0, 50)')));
  console.log('toast:', await ev('JSON.stringify(Array.from(document.querySelectorAll(".toast")).map(t => t.textContent))'));

  // 验证全局错误兜底
  await ev('window.dispatchEvent(new ErrorEvent("error", { message: "测试异常", error: new Error("测试异常") }))');
  await sleep(900);
  console.log('错误兜底 toast:', await ev('JSON.stringify(Array.from(document.querySelectorAll(".toast")).map(t => t.textContent))'));
  const logFile = path.join(ROOT, '.data', 'renderer-error.log');
  console.log('日志文件:', fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split(/\r?\n/).slice(0, 2).join(' | ') : '(未生成)');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(ROOT, '.test', OUT), Buffer.from(shot.data, 'base64'));
  console.log('截图:', OUT);

  ws.close();
  app.kill();
  fs.writeFileSync(CFG, cfgBackup);
  console.log('配置已还原');
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
