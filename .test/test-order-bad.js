/**
 * 反向对照：证明「按界面顺序（新→旧）直接摘」在同一场景下会冲突，
 * 从而说明 orderCommits 的必要性。注意：老逻辑是同秒时间退化成原顺序。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-orderbad-'));
const repo = path.join(base, 'repo');
fs.mkdirSync(repo);
const g = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sh = (cmd) => execFileSync('cmd.exe', ['/d', '/s', '/c', cmd], { cwd: repo, encoding: 'utf8' }).trim();

g(['init', '-q', '-b', 'dev']);
g(['config', 'user.name', 't']);
g(['config', 'user.email', 't@t']);
g(['config', 'commit.gpgsign', 'false']);
fs.writeFileSync(path.join(repo, 'a.txt'), ['line1', 'base', 'line3'].join('\n'), 'utf8');
g(['add', '.']);
g(['commit', '-q', '-m', 'init']);

// 针对同一块区域连续三次修改，时间戳故意相同
const env = 'set GIT_COMMITTER_DATE=1793861334&& set GIT_AUTHOR_DATE=1793861334&& ';
const edits = [['提交A', 'A行'], ['提交B', 'B行'], ['提交C', 'C行']];
for (const [msg, val] of edits) {
  fs.writeFileSync(path.join(repo, 'a.txt'), ['line1', val, 'line3'].join('\n'), 'utf8');
  g(['add', '.']);
  sh(env + 'git commit -q -m ' + msg);
}
g(['branch', 'master', 'HEAD~3']);

const all = g(['log', '--format=%H', 'dev']).split('\n').filter(Boolean);
const init = all[all.length - 1];
const newestFirst = all.filter((h) => h !== init); // 界面顺序：新→旧

// 反向对照：在临时克隆里按新→旧强行摘
const clone = path.join(base, 'clone');
execFileSync('git', ['clone', '-q', repo, clone], { encoding: 'utf8' });
g(['checkout', '-q', 'master'], clone);
let bad = false;
try {
  execFileSync('git', ['cherry-pick', '-x', ...newestFirst], { cwd: clone, encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  bad = true;
}
console.log('对照（按界面顺序新→旧强行摘）: ' + (bad ? '发生冲突 / 失败' : '意外成功'));
if (!bad) {
  console.log('  说明这三处改动没有叠在同一区域，对照无效');
  process.exit(0);
}
console.log('结论: 顺序确实关键，旧→新才是正确执行顺序');
console.log('tmp: ' + base);
