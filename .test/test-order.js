/**
 * 验证：界面上「新→旧」勾选一串针对同一处的提交，实际执行必须「旧→新」。
 * 用与渲染层相同的数据形态（commits 列表从上到下 = 新→旧）调用 orderCommits 与 cherryPick。
 */
const path = require('path');
const { execFileSync } = require('child_process');
const git = require('../src/git.js');

const repo = process.argv[2];
if (!repo) {
  console.error('usage: node test-order.js <repo>');
  process.exit(2);
}

const sh = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + label);
  } else {
    fail++;
    console.log('  \u2717 ' + label + (extra ? '  -> ' + extra : ''));
  }
}

(async () => {
  // 模拟界面：git log 默认新→旧，取 dev 上的提交（排除 init）
  const rows = sh(['log', '--format=%H%x1f%s', 'dev'])
    .split('\n')
    .map((l) => l.split('\x1f'))
    .filter((f) => f[1] !== 'init')
    .map((f) => ({ hash: f[0].trim(), subject: f[1] }));

  const display = rows.map((r) => r.subject);
  console.log('界面显示顺序（上→下）: ' + display.join(' → '));

  // 界面里全选后传给后端的顺序，就是 display 顺序
  const selected = rows.map((r) => r.hash);

  const ordered = await git.orderCommits(repo, selected);
  const nameOf = (h) => (rows.find((r) => r.hash === h) || { subject: h.slice(0, 7) }).subject;
  const execOrder = ordered.map(nameOf);
  console.log('执行顺序（实际）    : ' + execOrder.join(' → '));

  const expect = display.slice().reverse();
  check('执行顺序 = 显示的倒序（旧→新）', execOrder.join(',') === expect.join(','), '期望 ' + expect.join(','));

  const res = await git.cherryPick(repo, { target: 'master', commits: selected, autoStash: false });
  console.log('摘取结果: ok=' + res.ok + ' conflict=' + !!res.conflict + (res.error ? ' error=' + res.error : ''));
  check('摘取成功（无冲突）', res.ok === true);

  if (res.ok) {
    const t1 = sh(['rev-parse', 'master^{tree}']);
    const t2 = sh(['rev-parse', 'dev^{tree}']);
    check('master 树 == dev 树', t1 === t2, t1 + ' vs ' + t2);
    const logOrder = sh(['log', '--format=%s', '-3', 'master']).split('\n');
    check('目标分支上提交顺序为 旧→新', logOrder[0] === '提交C' && logOrder[2] === '提交A', logOrder.join(','));
  }

  console.log('\n断言: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
