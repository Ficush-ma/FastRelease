'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const git = require('./src/git');

app.setName('FastRelease');

// 开发时数据写在程序目录，打包后程序目录是只读的 asar，改写到用户配置目录
const DATA_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(__dirname, '.data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEFAULT_CONFIG = {
  lastRepo: '',
  repos: [],
  leftBranch: '',
  rightBranch: '',
  pageSize: 200,
  pullMode: 'rebase',
  mergeTool: ''
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readConfig() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (_) {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(patch) {
  ensureDataDir();
  const cfg = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 640,
    title: 'FastRelease - 提交摘取工具',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#f0f0f0',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'light';
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------- IPC ------------------------- */

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    const t0 = Date.now();
    try {
      const r = await fn(payload || {});
      if (process.env.FR_IPC_LOG) {
        fs.appendFileSync(path.join(DATA_DIR, 'ipc.log'), `${new Date().toISOString()} ${channel} ${Date.now() - t0}ms\n`);
      }
      return r;
    } catch (e) {
      if (process.env.FR_IPC_LOG) {
        fs.appendFileSync(path.join(DATA_DIR, 'ipc.log'), `${new Date().toISOString()} ${channel} ERROR ${Date.now() - t0}ms ${(e && e.message) || e}\n`);
      }
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

handle('config:get', () => ({ ok: true, config: readConfig() }));

handle('config:set', (payload) => ({ ok: true, config: writeConfig(payload) }));

handle('repo:info', (p) => git.repoInfo(p.dir));

handle('repo:branches', (p) => git.listBranches(p.dir));

handle('repo:commits', (p) => git.listCommits(p.dir, p));

handle('repo:cherryFlags', (p) => git.cherryFlags(p.dir, p));
handle('repo:patchFlags', (p) => git.patchFlags(p.dir, p));
handle('repo:workingChanges', (p) => git.workingChanges(p.dir));

/** 渲染层错误落盘，方便远程排查“点了没反应”这类问题 */
handle('app:logError', (p) => {
  try {
    ensureDataDir();
    const line = '[' + new Date().toISOString() + '] ' + (p.kind || 'error') + ': ' + (p.message || '') + '\n' +
      (p.stack ? p.stack + '\n' : '') + '---\n';
    fs.appendFileSync(path.join(DATA_DIR, 'renderer-error.log'), line);
    return { ok: true, file: path.join(DATA_DIR, 'renderer-error.log') };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
handle('repo:workingDiff', (p) => git.workingDiff(p.dir, p));
handle('repo:stashPop', (p) => git.stashPop(p.dir));
handle('repo:stashFinish', (p) => git.stashFinish(p.dir));
handle('repo:stashAbort', (p) => git.stashAbort(p.dir));

handle('repo:ahead', (p) => git.branchAheadBehind(p.dir, p.branch));

handle('repo:pull', (p) => git.pullBranch(p.dir, { branch: p.branch, mode: p.mode, autoStash: !!p.autoStash }));

handle('repo:push', (p) => git.pushBranch(p.dir, p.branch));

handle('repo:cherryPick', (p) => git.cherryPick(p.dir, p));

handle('repo:conflicts', (p) => git.conflictState(p.dir));

handle('conflict:read', (p) => git.readConflictFile(p.dir, p.relPath));

handle('conflict:save', (p) => git.saveResolvedFile(p.dir, p));

handle('conflict:resolveBinary', (p) => git.resolveBinaryFile(p.dir, p));

handle('conflict:continue', (p) => git.continueCherryPick(p.dir));

handle('conflict:abort', (p) => git.abortCherryPick(p.dir));

handle('conflict:skip', (p) => git.skipCherryPick(p.dir));

handle('commit:detail', (p) => git.commitDetail(p.dir, p.hash));

handle('repo:log', (p) => git.repoLog(p.dir, p.ref));

handle('repo:authors', (p) => git.listAuthors(p.dir, p));

handle('repo:checkMerged', (p) => git.checkMerged(p.dir, p));

handle('dialog:pickFolder', async (p) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Git 仓库目录',
    defaultPath: p.dir || readConfig().lastRepo || 'C:\\',
    properties: ['openDirectory'],
    buttonLabel: '选择'
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});

handle('shell:openPath', async (p) => {
  if (!p.path) return { ok: false };
  const err = await shell.openPath(p.path);
  return err ? { ok: false, error: err } : { ok: true };
});

handle('shell:showItem', (p) => {
  if (!p.path) return { ok: false };
  shell.showItemInFolder(p.path);
  return { ok: true };
});

/**
 * 探测 TortoiseGitMerge.exe：先读注册表（TortoiseGit 安装时写入 ProcPath，
 * 自定义安装位置也能找到），再试官方默认安装路径。
 */
function probeTortoiseMerge() {
  const found = [];
  const { execFileSync } = require('child_process');
  for (const hive of ['HKLM\\SOFTWARE\\TortoiseGit', 'HKCU\\SOFTWARE\\TortoiseGit']) {
    try {
      const out = execFileSync('reg', ['query', hive, '/v', 'ProcPath'], { encoding: 'utf8', timeout: 5000 });
      for (const line of out.split(/\r?\n/)) {
        if (/ProcPath/i.test(line) && /REG_SZ/i.test(line)) {
          const val = line.split(/REG_SZ/i).pop().trim();
          if (val) {
            found.push(val.endsWith('.exe') ? val : path.join(val, 'TortoiseGitMerge.exe'));
            found.push(path.join(val, 'bin', 'TortoiseGitMerge.exe'));
          }
        }
      }
    } catch (_) { /* 键不存在或 reg 不可用，忽略 */ }
  }
  found.push(
    'C:\\Program Files\\TortoiseGit\\bin\\TortoiseGitMerge.exe',
    'C:\\Program Files (x86)\\TortoiseGit\\bin\\TortoiseGitMerge.exe'
  );
  return found;
}

/**
 * 从候选里挑出真正可用的 exe。注意 existsSync 对目录也返回 true，
 * 必须用 statSync().isFile() 过滤；用户填了目录时自动往下找一层 exe。
 */
function resolveMergeExe(tool) {
  const cands = [];
  const t = (tool || '').trim();
  if (t) {
    cands.push(t);
    try {
      if (fs.existsSync(t) && fs.statSync(t).isDirectory()) {
        cands.push(path.join(t, 'TortoiseGitMerge.exe'));
        cands.push(path.join(t, 'bin', 'TortoiseGitMerge.exe'));
      }
    } catch (_) { /* ignore */ }
  }
  cands.push(...probeTortoiseMerge());
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (_) { /* ignore */ }
  }
  return null;
}

handle('merge:external', async (p) => {
  const cfg = readConfig();
  const exe = resolveMergeExe(p.tool || cfg.mergeTool);
  if (!exe) return { ok: false, error: '未找到 TortoiseGitMerge.exe，可在设置里指定完整路径（exe 文件）' };

  // 三份完整文件内容：优先用调用方传的，否则从 git 暂存区取 :1:/(:2:/:3:)
  let base = p.base, ours = p.ours, theirs = p.theirs;
  if (base == null || ours == null || theirs == null) {
    const st = await git.conflictStages(p.dir, p.relPath);
    if (!st.ok) return { ok: false, error: st.error || '读取冲突版本失败' };
    base = st.base; ours = st.ours; theirs = st.theirs;
  }

  const tmp = path.join(DATA_DIR, 'merge-tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const safe = (p.relPath || 'file').replace(/[\\/:*?"<>|]/g, '_');
  const writeTmp = (name, content) => {
    const fp = path.join(tmp, name);
    fs.writeFileSync(fp, content == null ? '' : content, 'utf8');
    return fp;
  };
  const tmpBase = writeTmp(safe + '.base', base);
  const tmpMine = writeTmp(safe + '.mine', ours);
  const tmpTheirs = writeTmp(safe + '.theirs', theirs);
  const merged = path.join(path.dirname(p.absPath), p.relPath);

  const { spawn } = require('child_process');
  try {
    const child = spawn(exe, ['/base:' + tmpBase, '/theirs:' + tmpTheirs, '/mine:' + tmpMine, '/merged:' + merged], {
      detached: true,
      stdio: 'ignore'
    });
    // spawn 失败（如 ENOENT）走 error 事件，不接住会把整个主进程干崩
    child.on('error', (err) => {
      console.error('[merge:external] spawn failed:', err.message);
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

handle('dev:reveal', async () => {
  shell.showItemInFolder(__filename);
  return { ok: true };
});
