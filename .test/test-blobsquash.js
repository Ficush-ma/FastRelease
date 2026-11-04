'use strict';
// 自动测试：patch-id + blob 内容判定的「已合并」识别
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const git = require('../src/git');

const TMP = 'C:/Users/admin/AppData/Local/Temp/fr-blobsquash';

let pass = 0;
const fails = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  PASS ' + name); }
  else { fails.push(name); console.log('  FAIL ' + name + '\n        期望 ' + e + '\n        实际 ' + a); }
}
function g(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@l', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
}
const write = (cwd, name, text) => fs.writeFileSync(path.join(cwd, name), text);

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

/* ---------------- 场景 1：squash + 单独摘取 + 未合并 + 删除文件 ---------------- */
const R1 = path.join(TMP, 'repo1');
fs.mkdirSync(R1);
g(R1, 'init', '-q', '-b', 'master');
write(R1, 'a.txt', 'a1\na2\na3\na4\na5\n');
write(R1, 'b.txt', 'b1\nb2\nb3\n');
write(R1, 'c.txt', 'c1\nc2\n');
g(R1, 'add', '.');
g(R1, 'commit', '-qm', 'init');

g(R1, 'checkout', '-q', '-b', 'dev');
write(R1, 'x1.txt', 'one\n');
g(R1, 'add', '.');
g(R1, 'commit', '-qm', 'C1 新增 x1');
write(R1, 'a.txt', 'a1\na2\ndev-3\na4\na5\n');
g(R1, 'commit', '-qam', 'C2 a.txt 第3行');
write(R1, 'x2.txt', 'two\n');
g(R1, 'add', '.');
g(R1, 'commit', '-qm', 'C3 新增 x2');
write(R1, 'b.txt', 'b1\ndev-b2\nb3\n');
g(R1, 'commit', '-qam', 'C4 b.txt 第2行');
write(R1, 'x3.txt', 'three\n');
g(R1, 'add', '.');
g(R1, 'commit', '-qm', 'C5 新增 x3（不合并）');
g(R1, 'rm', '-q', 'c.txt');
g(R1, 'commit', '-qm', 'C6 删除 c.txt（release 也删了）');

const sha = (repo, ref) => g(repo, 'rev-parse', ref).trim();
const S = {
  C1: sha(R1, 'dev~5'), C2: sha(R1, 'dev~4'), C3: sha(R1, 'dev~3'),
  C4: sha(R1, 'dev~2'), C5: sha(R1, 'dev~1'), C6: sha(R1, 'dev')
};

g(R1, 'checkout', '-q', 'master');
g(R1, 'checkout', '-q', '-b', 'release');
g(R1, 'cherry-pick', '-n', S.C1, S.C2, S.C3);
g(R1, 'commit', '-qm', 'squash: C1+C2+C3');
g(R1, 'cherry-pick', S.C4);
g(R1, 'commit', '-q', '--amend', '-m', 'C4 单独摘取');
g(R1, 'rm', '-q', 'c.txt');
g(R1, 'commit', '-qm', '移除 c.txt');

(async () => {
  console.log('\n场景 1：squash / 单独摘取 / 未合并 / 删除文件');
  const res = await git.checkMerged(R1, { source: 'dev', target: 'release' });
  if (!res.ok) { console.log('  checkMerged 失败:', res.error); fails.push('checkMerged 调用失败'); }
  const by = {};
  for (const c of res.commits || []) by[c.subject.slice(0, 2)] = { merged: c.merged, kind: c.mergeKind };

  check('C1 被 squash → 已合并', by['C1'], { merged: true, kind: 'squash' });
  check('C2 被 squash → 已合并', by['C2'], { merged: true, kind: 'squash' });
  check('C3 被 squash → 已合并', by['C3'], { merged: true, kind: 'squash' });
  check('C4 单独摘取 → 已合并(patch)', by['C4'], { merged: true, kind: 'patch' });
  check('C5 未合并 → 未合并', by['C5'], { merged: false, kind: undefined });
  check('C6 删除文件（目标也删）→ 已合并', by['C6'], { merged: true, kind: 'patch' });
  check('squashCount（只算内容判定命中的）', res.squashCount, 3);
  check('unmergedCount', res.unmergedCount, 1);

  console.log('\n场景 1（徽标口径）：patchFlags');
  const pf = await git.patchFlags(R1, { source: 'dev', target: 'release' });
  if (!pf.ok) { console.log('  patchFlags 失败:', pf.error); fails.push('patchFlags 调用失败'); }
  check('patchFlags 命中数（含两分支共享的 init）', Object.keys(pf.map || {}).length, 6);
  check('patchFlags squash 数', Object.keys(pf.squash || {}).length, 3);
  check('C5 未被误标', !!(pf.map || {})[S.C5], false);

  /* ---------------- 场景 2：squash 之后目标分支又改了同一文件（已知盲区） ---------------- */
  const R2 = path.join(TMP, 'repo2');
  fs.mkdirSync(R2);
  g(R2, 'init', '-q', '-b', 'master');
  write(R2, 'k.txt', 'k1\n');
  g(R2, 'add', '.');
  g(R2, 'commit', '-qm', 'init');
  g(R2, 'checkout', '-q', '-b', 'dev');
  write(R2, 'n.txt', 'new\n');
  g(R2, 'add', '.');
  g(R2, 'commit', '-qm', 'D1 新增 n.txt');
  write(R2, 'n.txt', 'new2\n');
  g(R2, 'commit', '-qam', 'D2 再改 n.txt');
  const D1 = sha(R2, 'dev~1');
  const D2 = sha(R2, 'dev');
  g(R2, 'checkout', '-q', 'master');
  g(R2, 'checkout', '-q', '-b', 'release');
  g(R2, 'cherry-pick', '-n', D1, D2);
  g(R2, 'commit', '-qm', 'squash: D1+D2');
  write(R2, 'n.txt', 'later-edited-on-release\n');
  g(R2, 'commit', '-qam', '后来又在 release 上改了 n.txt');

  console.log('\n场景 2：squash 之后又改同一文件（预期：内容比对认不出，merge-tree 降级为「可能已合并」）');
  const r2 = await git.checkMerged(R2, { source: 'dev', target: 'release' });
  const d1 = (r2.commits || []).find((c) => c.subject.startsWith('D1'));
  const d2 = (r2.commits || []).find((c) => c.subject.startsWith('D2'));
  check('D1 未确认合并', d1 && d1.merged, false);
  check('D1 标记为需人工确认', d1 && d1.maybe, true);
  check('D2 标记为需人工确认', d2 && d2.maybe, true);
  check('maybeCount', r2.maybeCount, 2);

  /* ---------------- 场景 4：blob 判不出，但 merge-tree 判定已合并 ---------------- */
  const R4 = path.join(TMP, 'repo4');
  fs.mkdirSync(R4);
  g(R4, 'init', '-q', '-b', 'master');
  write(R4, 'm.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n');
  g(R4, 'add', '.');
  g(R4, 'commit', '-qm', 'init');
  g(R4, 'checkout', '-q', '-b', 'dev');
  write(R4, 'm.txt', 'dev-1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n');
  g(R4, 'commit', '-qam', 'F1 改第1行');
  write(R4, 'm.txt', 'dev-1\ndev-2\nl3\nl4\nl5\nl6\nl7\nl8\n');
  g(R4, 'commit', '-qam', 'F2 改第2行');
  const F1 = sha(R4, 'dev~1');
  const F2 = sha(R4, 'dev');
  g(R4, 'checkout', '-q', 'master');
  g(R4, 'checkout', '-q', '-b', 'release');
  g(R4, 'cherry-pick', '-n', F1, F2);
  g(R4, 'commit', '-qm', 'squash: F1+F2');
  write(R4, 'm.txt', 'dev-1\ndev-2\nl3\nl4\nl5\nl6\nlater-7\nl8\n');
  g(R4, 'commit', '-qam', '之后又改了第7行（与 F1/F2 不同位置）');

  console.log('\n场景 4：blob 判不出（文件被后续改过），交给 merge-tree');
  const r4 = await git.checkMerged(R4, { source: 'dev', target: 'release' });
  const f1 = (r4.commits || []).find((c) => c.subject.startsWith('F1'));
  const f2 = (r4.commits || []).find((c) => c.subject.startsWith('F2'));
  check('F2 由 merge-tree 判定已合并', f2 && f2.mergeKind, 'deep');
  // F1 与 F2 的行紧邻，三方合并时 git 会把两处改动算成同一块 → 冲突 → 降级为「需确认」
  check('F1 相邻改动被降级为「需确认」', !!(f1 && f1.maybe), true);
  check('F1 未被判成已合并', f1 && f1.merged, false);
  check('squashCount（F2 一条 deep）', r4.squashCount, 1);
  check('maybeCount = 1', r4.maybeCount, 1);
  check('unmergedCount = 1（只剩 F1 待确认）', r4.unmergedCount, 1);

  /* ---------------- 场景 5：确实没合并的，merge-tree 不能误判 ---------------- */
  console.log('\n场景 5：真正没合并的（改动会对目标产生差异）');
  const r1b = await git.checkMerged(R1, { source: 'dev', target: 'release' });
  const c5 = (r1b.commits || []).find((c) => c.subject.startsWith('C5'));
  check('C5 仍为未合并', c5 && c5.merged, false);
  check('C5 不算需确认', !!(c5 && c5.maybe), false);

  /* ---------------- 场景 3：回归 —— 已由 patch-id 命中的，不能被误标成 squash ---------------- */
  console.log('\n场景 3：回归（conflict-test：已合并的都是 patch 命中，不能误标 squash）');
  const R3 = 'C:/Users/admin/Desktop/conflict-test/repo';
  if (fs.existsSync(R3)) {
    const r3 = await git.checkMerged(R3, { source: 'dev', target: 'release' });
    if (!r3.ok) console.log('  checkMerged 失败:', (r3.error || '').split('\n')[0]);
    else {
      check('squash 数 = 0', r3.squashCount, 0);
      const allPatch = (r3.commits || []).filter((c) => c.merged).every((c) => c.mergeKind === 'patch');
      check('已合并的 kind 全为 patch', allPatch, true);
    }
  } else {
    console.log('  （跳过：演示仓不存在）');
  }

  console.log('\n------------ 结果 ------------');
  console.log('通过 ' + pass + ' 项' + (fails.length ? '，失败 ' + fails.length + ' 项：' + fails.join('、') : '，全部通过'));
  process.exit(fails.length ? 1 : 0);
})();
