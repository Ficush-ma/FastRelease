'use strict';
const git = require('../src/git');
const path = require('path');

const DIR = path.join(__dirname, '..', '.fxrepo');
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};

(async () => {
  console.log('\n--- 1. 分支列表（本地 + 远端）---');
  const br = await git.listBranches(DIR);
  const names = br.branches.map((b) => b.name);
  console.log('    ', names.join(' | '));
  check('包含远端 dev 分支', names.includes('origin/dev-20251112'), names);
  check('包含本地 release', names.includes('release-1028'), names);
  const dev = br.branches.find((b) => b.name === 'origin/dev-20251112');
  check('远端标记正确', dev && dev.isRemote === true && dev.remoteName === 'origin');
  check('本地分支未被标成远端', br.branches.find((b) => b.name === 'release-1028').isRemote === false);

  console.log('\n--- 2. 从远端分支读提交 ---');
  const devLog = await git.listCommits(DIR, { ref: 'origin/dev-20251112', limit: 50 });
  check('能读到远端 dev 提交', devLog.ok && devLog.commits.length === 3, devLog.commits && devLog.commits.length);
  const d1 = devLog.commits.find((c) => c.subject.includes('D1 模块'));
  check('找到 D1 提交', !!d1);

  console.log('\n--- 3. 已摘取标记（远端 source）---');
  const flags = await git.cherryFlags(DIR, { target: 'release-1028', source: 'origin/dev-20251112' });
  const devLog2 = await git.listCommits(DIR, { ref: 'origin/dev-20251112', limit: 50 });
  devLog2.commits.forEach((c) => console.log('     ', c.short, flags.map[c.hash] ? '[已摘取]' : '[      ]', c.subject));
  check('已摘过的 a.txt 提交被标记', devLog2.commits.filter((c) => flags.map[c.hash]).length >= 1);

  console.log('\n--- 4. 从远端分支摘取到本地 release ---');
  const pick = await git.cherryPick(DIR, { target: 'release-1028', commits: [d1.hash] });
  console.log('     ', JSON.stringify({ ok: pick.ok, conflict: pick.conflict, msg: pick.message, err: (pick.error || '').slice(0, 120) }));
  check('摘取成功', pick.ok === true, pick);
  const afterPick = await git.repoInfo(DIR);
  check('当前在 release-1028', afterPick.branch === 'release-1028', afterPick.branch);

  console.log('\n--- 5. 目标为远端分支时应被拒绝 ---');
  const bad = await git.cherryPick(DIR, { target: 'origin/dev-20251112', commits: [d1.hash] });
  check('拒绝摘取到远端分支', bad.ok === false && /远端分支/.test(bad.error || ''), bad.error);

  console.log('\n--- 6. 变基拉取（本地有提交、远端有新提交、且冲突）---');
  const before = await git.repoInfo(DIR);
  console.log('     拉取前 ahead/behind:', before.ahead, before.behind);
  const pull = await git.pullBranch(DIR, { branch: 'release-1028', mode: 'rebase' });
  console.log('     ', JSON.stringify({ ok: pull.ok, conflict: pull.conflict, op: pull.operation, err: (pull.error || '').slice(0, 100) }));
  check('变基触发冲突', pull.conflict === true && pull.operation === 'rebase', pull);
  check('冲突文件为 a.txt', (pull.files || []).includes('a.txt'), pull.files);

  const cs = await git.conflictState(DIR);
  check('识别为 rebase 过程', cs.operation === 'rebase' && cs.cherryPicking === false, cs.operation);

  const cf = await git.readConflictFile(DIR, 'a.txt');
  const seg = cf.segments.find((s) => s.type === 'conflict');
  console.log('      左侧(远端):', seg && seg.ours, '右侧(本地):', seg && seg.theirs);
  check('左侧是远端改动', seg && seg.ours.join('|').includes('remote-change'));
  check('右侧是本地提交', seg && seg.theirs.join('|').includes('dev-feature'));

  console.log('\n--- 7. 解决冲突并继续变基 ---');
  const resolvedText = 'base\nremote-change\ndev-feature\n';
  const saved = await git.saveResolvedFile(DIR, { relPath: 'a.txt', content: resolvedText });
  check('标记已解决', saved.ok && saved.remaining.length === 0, saved);

  const cont = await git.continueCherryPick(DIR);
  console.log('     ', JSON.stringify({ ok: cont.ok, conflict: cont.conflict, empty: cont.empty, err: (cont.error || '').slice(0, 160) }));
  check('变基继续成功', cont.ok === true, cont);

  const after = await git.repoInfo(DIR);
  check('变基后无进行中操作', after.operation === '', after.operation);
  check('本地提交已重放到远端之后', after.ahead === 2 && after.behind === 0, { ahead: after.ahead, behind: after.behind });

  const relLog = await git.listCommits(DIR, { ref: 'release-1028', limit: 6 });
  console.log('     release-1028:'); relLog.commits.forEach((c) => console.log('       ', c.short, c.subject));
  const remoteIdx = relLog.commits.findIndex((c) => c.subject.includes('远端修复'));
  check('远端提交成为基底（本地提交在其之后）', remoteIdx === 2, remoteIdx);
  check('历史保持线性（无 merge 提交）', relLog.commits.every((c) => !c.isMerge));

  console.log('\n--- 8. 无冲突时的变基拉取 ---');
  const { execFileSync } = require('child_process');
  const OTHER = path.join(__dirname, '..', '.fxother');
  execFileSync('git', ['checkout', '-q', 'release-1028'], { cwd: OTHER });
  require('fs').writeFileSync(path.join(OTHER, 'o2.txt'), 'more remote work\n');
  execFileSync('git', ['add', '.'], { cwd: OTHER });
  execFileSync('git', ['commit', '-qm', 'feat: 远端又一个提交'], { cwd: OTHER });
  execFileSync('git', ['push', '-q', 'origin', 'release-1028'], { cwd: OTHER });

  const pull2 = await git.pullBranch(DIR, { branch: 'release-1028', mode: 'rebase' });
  console.log('     ', JSON.stringify({ ok: pull2.ok, msg: pull2.message, err: (pull2.error || '').slice(0, 120) }));
  check('无冲突变基成功', pull2.ok === true, pull2);
  const relLog2 = await git.listCommits(DIR, { ref: 'release-1028', limit: 6 });
  console.log('     release-1028:'); relLog2.commits.forEach((c) => console.log('       ', c.short, c.subject));
  check('新的远端提交进入历史', relLog2.commits.some((c) => c.subject.includes('远端又一个提交')));
  check('本地提交仍在线性历史里', relLog2.commits.filter((c) => c.subject.includes('dev')).length === 2);
  const info2 = await git.repoInfo(DIR);
  check('落后数归零', info2.behind === 0, { ahead: info2.ahead, behind: info2.behind });

  console.log('\n--- 9. 远端分支拉取=只更新引用 ---');
  const pullRemote = await git.pullBranch(DIR, { branch: 'origin/dev-20251112', mode: 'rebase' });
  console.log('     ', JSON.stringify({ ok: pullRemote.ok, msg: pullRemote.message, err: (pullRemote.error || '').slice(0, 100) }));
  check('远端分支不报错', pullRemote.ok === true, pullRemote);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
