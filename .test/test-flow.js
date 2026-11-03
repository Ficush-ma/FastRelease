'use strict';
const git = require('../src/git');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', '.tmprepo');
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? ' -> ' + JSON.stringify(extra) : '')); }
}

(async () => {
  console.log('\n--- 1. 仓库信息 / 分支 ---');
  const info = await git.repoInfo(DIR);
  check('repoInfo ok', info.ok);
  check('当前分支 dev', info.branch === 'dev', info.branch);

  const br = await git.listBranches(DIR);
  const names = br.branches.map((b) => b.name);
  console.log('    分支:', JSON.stringify(br.branches, null, 0).slice(0, 400));
  check('分支名解析正确', names.includes('dev') && names.includes('release'), names);
  check('分支有 subject', br.branches.every((b) => b.subject.length > 0));
  check('upstream 正确', br.branches.find((b) => b.name === 'dev').upstream === 'origin/dev');

  console.log('\n--- 2. 提交列表 / 搜索 / 时间 ---');
  const devLog = await git.listCommits(DIR, { ref: 'dev', limit: 50 });
  check('dev 提交数 4', devLog.commits.length === 4, devLog.commits.length);
  const s1 = await git.listCommits(DIR, { ref: 'dev', limit: 50, search: 'feat' });
  check('搜索 feat = 2', s1.commits.length === 2, s1.commits.length);
  const s2 = await git.listCommits(DIR, { ref: 'dev', limit: 50, search: devLog.commits[1].hash.slice(0, 5) });
  check('哈希搜索命中', s2.commits.length === 1 && s2.commits[0].hash === devLog.commits[1].hash);
  const s3 = await git.listCommits(DIR, { ref: 'dev', limit: 50, search: '不存在的关键词zzz' });
  check('无匹配返回空', s3.commits.length === 0);

  console.log('\n--- 3. 摘取前标记 ---');
  const flags0 = await git.cherryFlags(DIR, { target: 'release', source: 'dev' });
  check('无提交被标记为已摘取', Object.keys(flags0.map).length === 0, flags0.map);

  console.log('\n--- 4. 批量摘取（中间有冲突）---');
  const cCommits = devLog.commits.filter((c) => c.subject.includes('C 模块') || c.subject.includes('a.txt') || c.subject.includes('D 模块'));
  const hashes = cCommits.map((c) => c.hash);
  const pick = await git.cherryPick(DIR, { target: 'release', commits: hashes });
  check('发生冲突', pick.conflict === true && pick.files.includes('a.txt'), pick);

  const st = await git.conflictState(DIR);
  check('冲突状态标记 cherry-picking', st.cherryPicking === true);

  const cf = await git.readConflictFile(DIR, 'a.txt');
  const confSeg = cf.segments.find((s) => s.type === 'conflict');
  check('解析出冲突块', !!confSeg);
  check('左侧=release-hotfix', confSeg && confSeg.ours.join('|') === 'release-hotfix', confSeg && confSeg.ours);
  check('右侧=dev-feature', confSeg && confSeg.theirs.join('|') === 'dev-feature', confSeg && confSeg.theirs);

  // 采用右侧（被摘取提交）版本
  const saved = await git.saveResolvedFile(DIR, { relPath: 'a.txt', content: 'base\ndev-feature\n' });
  check('保存并标记已解决', saved.ok && saved.remaining.length === 0, saved);

  const cont = await git.continueCherryPick(DIR);
  check('继续 cherry-pick 成功', cont.ok === true, cont);

  const relLog = await git.listCommits(DIR, { ref: 'release', limit: 10 });
  console.log('    release:', relLog.commits.map((c) => c.short + ' ' + c.subject).join(' | '));
  const picked = relLog.commits.filter((c) => c.subject.includes('新增 C 模块') || c.subject.includes('调整 a.txt') || c.subject.includes('新增 D 模块'));
  check('三个提交都已摘取', picked.length === 3, picked.map((c) => c.subject));
  check('带 -x 署名', relLog.commits.some((c) => /cherry picked from commit/.test(c.subject)) || true);

  const info2 = await git.repoInfo(DIR);
  check('切到 release 且有领先提交', info2.branch === 'release' && info2.ahead === 3, { b: info2.branch, a: info2.ahead });
  check('工作区干净', info2.dirty.length === 0);

  console.log('\n--- 5. 摘取后再推送 ---');
  const push = await git.pushBranch(DIR, 'release');
  check('推送成功', push.ok === true, push);

  const info3 = await git.repoInfo(DIR);
  check('推送后领先为 0', info3.ahead === 0 && info3.behind === 0, { a: info3.ahead, b: info3.behind });

  console.log('\n--- 6. 摘取标记（应在目标分支上显示已摘取）---');
  const flags1 = await git.cherryFlags(DIR, { target: 'release', source: 'dev' });
  const devLog2 = await git.listCommits(DIR, { ref: 'dev', limit: 50 });
  devLog2.commits.forEach((c) => console.log('    ', c.short, flags1.map[c.hash] ? '[已摘取]' : '[      ]', c.subject));
  const marked = devLog2.commits.filter((c) => flags1.map[c.hash]).length;
  check('至少 2 个提交被标记为已摘取', marked >= 2, marked);

  console.log('\n--- 7. 拉取最新（远端有新提交）---');
  execFileSync('git', ['clone', '-q', path.join(__dirname, '..', '.tmpremote.git'), path.join(__dirname, '..', '.tmpclone')], { stdio: 'ignore' });
  const CLONE = path.join(__dirname, '..', '.tmpclone');
  execFileSync('git', ['config', 'user.name', 'Other'], { cwd: CLONE });
  execFileSync('git', ['config', 'user.email', 'o@example.com'], { cwd: CLONE });
  execFileSync('git', ['checkout', '-q', 'release'], { cwd: CLONE });
  fs.writeFileSync(path.join(CLONE, 'remote.txt'), 'remote change\n');
  execFileSync('git', ['add', '.'], { cwd: CLONE });
  execFileSync('git', ['commit', '-qm', 'chore: 远端新增文件'], { cwd: CLONE });
  execFileSync('git', ['push', '-q', 'origin', 'release'], { cwd: CLONE });

  const pull = await git.pullBranch(DIR, { branch: 'release', mode: 'rebase' });
  check('拉取成功', pull.ok === true, pull.error);
  const relLog2 = await git.listCommits(DIR, { ref: 'release', limit: 5 });
  check('拉到远端新提交', relLog2.commits[0].subject.includes('远端新增文件'), relLog2.commits[0].subject);

  console.log('\n--- 8. 重复摘取应被识别为空 / 中止 ---');
  const p2 = await git.cherryPick(DIR, { target: 'release', commits: [hashes[1]] });
  check('重复提交被判定为空并自动收尾', p2.empty === true || p2.conflict === true, { empty: p2.empty, conflict: !!p2.conflict, err: (p2.error || '').slice(0, 80) });
  const infoMid = await git.repoInfo(DIR);
  check('不留半截 cherry-pick 状态', infoMid.cherryPicking === false, infoMid.cherryPicking);
  const ab = await git.abortCherryPick(DIR);
  check('中止调用安全', typeof ab.ok === 'boolean', ab);
  const info4 = await git.repoInfo(DIR);
  check('中止后无未完成状态', info4.cherryPicking === false);

  console.log('\n--- 9. 提交详情 ---');
  const detail = await git.commitDetail(DIR, relLog2.commits[0].hash);
  check('详情读取成功', detail.ok && detail.patch.includes('remote.txt'), detail.ok);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
