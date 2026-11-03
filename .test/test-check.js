'use strict';
const git = require('../src/git');
const path = require('path');

const DIR = path.join(__dirname, '..', '.fcrepo');
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};

(async () => {
  console.log('\n--- 1. 作者列表 ---');
  const au = await git.listAuthors(DIR, { ref: 'dev' });
  console.log('    ', JSON.stringify(au.authors));
  check('能列出两个作者', au.ok && au.authors.length === 2, au.authors && au.authors.length);
  check('Alice 有 3 个提交（含初始化）', au.authors.find((a) => a.name === 'Alice').count === 3);
  check('Bob 有 1 个提交', au.authors.find((a) => a.name === 'Bob').count === 1);

  console.log('\n--- 2. Alice 的合并情况 ---');
  const alice = await git.checkMerged(DIR, { source: 'dev', target: 'release', author: 'Alice' });
  console.log('    ', JSON.stringify({ total: alice.total, unmerged: alice.unmergedCount, merged: alice.mergedCount }));
  check('Alice 共 3 个提交', alice.total === 3, alice.total);
  check('其中 1 个未合并（另外 2 个已合并）', alice.unmergedCount === 1 && alice.mergedCount === 2, { u: alice.unmergedCount, m: alice.mergedCount });
  check('未合并的是「提交二」', alice.commits.filter((c) => !c.merged).map((c) => c.subject).join('|').includes('提交二'));

  console.log('\n--- 3. Bob 的合并情况 ---');
  const bob = await git.checkMerged(DIR, { source: 'dev', target: 'release', author: 'Bob' });
  check('Bob 只有 1 个提交且未合并', bob.total === 1 && bob.unmergedCount === 1, bob);

  console.log('\n--- 4. 不指定作者 ---');
  const all = await git.checkMerged(DIR, { source: 'dev', target: 'release' });
  check('全部人共 4 个提交，2 个未合并', all.total === 4 && all.unmergedCount === 2, { t: all.total, u: all.unmergedCount });

  console.log('\n--- 5. 时间范围过滤 ---');
  const future = await git.checkMerged(DIR, {
    source: 'dev', target: 'release', since: new Date(Date.now() + 864e5).toISOString()
  });
  check('未来时间点检测为空', future.total === 0, future.total);

  console.log('\n--- 6. 异常入参 ---');
  const same = await git.checkMerged(DIR, { source: 'dev', target: 'dev' });
  check('同分支报错', same.ok === false && /不能相同/.test(same.error || ''), same.error);
  const bad = await git.checkMerged(DIR, { source: 'dev', target: 'no-such-branch' });
  check('分支不存在报错', bad.ok === false, bad.error && bad.error.slice(0, 40));

  console.log('\n--- 7. 源为 release、目标为 dev（反向）---');
  const rev = await git.checkMerged(DIR, { source: 'release', target: 'dev' });
  check('release 上未进 dev 的提交能识别', rev.unmergedCount >= 1, rev.unmergedCount);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
