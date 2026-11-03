'use strict';

/**
 * 零依赖打包脚本：把 Electron 运行时 + 应用代码拼成可直接运行的目录，再压成 zip。
 * 不依赖 electron-builder / NSIS，国内网络也能跑。
 *
 * 用法：npm run dist
 * 产物：dist/FastRelease-<version>-win64/FastRelease.exe
 *      dist/FastRelease-<version>-win64.zip
 */

const fs = require('fs');
const path = require('path');
const { zipDirectory } = require('./zip');

const ROOT = path.join(__dirname, '..');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const OUT_DIR = path.join(ROOT, 'dist', `FastRelease-${VERSION}-win64`);
const APP_DIR = path.join(OUT_DIR, 'resources', 'app');
const ZIP_PATH = path.join(ROOT, 'dist', `FastRelease-${VERSION}-win64.zip`);

const COPY_LIST = ['main.js', 'preload.js', 'icon.ico'];
const COPY_DIRS = ['src', 'renderer'];

function fail(msg) {
  console.error('\n[打包失败] ' + msg + '\n');
  process.exit(1);
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const s = path.join(from, name);
    const d = path.join(to, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 复制 Electron 运行时，顺便把 electron.exe 直接落成 FastRelease.exe（避免多留一份） */
function copyElectronDist(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const s = path.join(from, name);
    const targetName = name === 'electron.exe' ? 'FastRelease.exe' : name;
    const d = path.join(to, targetName);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function tryRemove(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (_) {
    /* 某些环境会拦截删除，下面按结果判断 */
  }
  return !fs.existsSync(p);
}

console.log('1/4 检查 Electron 运行时…');
if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron.exe'))) {
  fail('找不到 node_modules/electron/dist/electron.exe，请先执行 npm install');
}
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'))) {
  fail('Electron 安装不完整，请重新执行 npm install');
}

console.log('2/4 复制 Electron 运行时到 dist/' + path.basename(OUT_DIR) + '…');
fs.mkdirSync(OUT_DIR, { recursive: true });
copyElectronDist(ELECTRON_DIST, OUT_DIR);

const newExe = path.join(OUT_DIR, 'FastRelease.exe');
if (!fs.existsSync(newExe)) fail('没有生成 FastRelease.exe，请检查 Electron 运行时是否完整');

console.log('3/4 写入应用代码…');
if (fs.existsSync(APP_DIR) && !tryRemove(APP_DIR)) {
  // 某些环境拦删除：先改名让路，旧的留着也无妨（下次清理）
  const parked = APP_DIR + '.old-' + Date.now();
  try { fs.renameSync(APP_DIR, parked); } catch (_) { /* ignore */ }
}
if (fs.existsSync(APP_DIR)) fail('无法清空 resources/app，请手动删除后重试');
fs.mkdirSync(APP_DIR, { recursive: true });

for (const f of COPY_LIST) copyFile(path.join(ROOT, f), path.join(APP_DIR, f));
for (const d of COPY_DIRS) copyDir(path.join(ROOT, d), path.join(APP_DIR, d));

// 面向使用者的 README 放到打包目录根部（不是源码仓库的开发者 README）
const pkgReadme = path.join(ROOT, 'packaging', 'README.md');
if (fs.existsSync(pkgReadme)) {
  copyFile(pkgReadme, path.join(OUT_DIR, 'README.md'));
  console.log('  已写入 README.md（packaging/README.md）');
} else {
  console.warn('  [提示] 没有 packaging/README.md，跳过');
}

// 应用自己的 package.json（去掉 devDependencies / build 段，保持干净）
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
delete pkg.devDependencies;
delete pkg.build;
delete pkg.scripts;
fs.writeFileSync(path.join(APP_DIR, 'package.json'), JSON.stringify(pkg, null, 2));

// 留着 app.asar 会让 Electron 忽略 app 目录，必须确保它不存在
const asar = path.join(OUT_DIR, 'resources', 'app.asar');
if (fs.existsSync(asar)) {
  try {
    fs.renameSync(asar, asar + '.bak'); // 改名通常比删除更容易被允许
  } catch (_) {
    /* 改名失败就退回删除 */
  }
  if (fs.existsSync(asar)) tryRemove(asar);
  if (fs.existsSync(asar)) fail('无法移走 resources/app.asar（Electron 会优先加载它）');
}

console.log('4/4 压缩成 zip（约 110MB，十几秒）…');
if (fs.existsSync(ZIP_PATH)) tryRemove(ZIP_PATH);
try {
  const res = zipDirectory(OUT_DIR, ZIP_PATH, (done, total) => {
    if (done % 10 === 0 || done === total) process.stdout.write(`\r  压缩中 ${done}/${total}`);
  });
  console.log('\n\n完成（' + res.files + ' 个文件，' + (res.size / 1024 / 1024).toFixed(1) + ' MB）：');
  console.log('  可执行文件  ' + newExe);
  console.log('  压缩包      ' + ZIP_PATH);
} catch (e) {
  console.warn('\n\n[提示] zip 压缩失败，但目录版仍可用：' + newExe);
  console.warn('       ' + (e && e.message));
}
