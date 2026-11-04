'use strict';
// 一致性测试：徽标（patchFlags）与合并检查（checkMerged）必须给出相同结论
const git = require('../src/git');

let pass = 0;
const fails = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log('  PASS ' + name); }
  else { fails.push(name); console.log('  FAIL ' + name + '\n        期望 ' + JSON.stringify(expected) + '\n        实际 ' + JSON.stringify(actual)); }
}

const CASES = [
  { name: 'repo1（squash + 单独摘取 + 未合并）', dir: 'C:/Users/admin/AppData/Local/Temp/fr-blobsquash/repo1' },
  { name: 'repo4（merge-tree 兜底 + 需确认）', dir: 'C:/Users/admin/AppData/Local/Temp/fr-blobsquash/repo4' }
];

(async () => {
  for (const c of CASES) {
    console.log('\n' + c.name);
    const cm = await git.checkMerged(c.dir, { source: 'dev', target: 'release' });
    const pf = await git.patchFlags(c.dir, { source: 'dev', target: 'release' });
    if (!cm.ok || !pf.ok) {
      console.log('  调用失败:', cm.error || pf.error);
      fails.push(c.name + ' 调用失败');
      continue;
    }

    let mismatch = 0;
    let kinds = 0;
    for (const row of cm.commits || []) {
      const byBadge = !!(pf.map || {})[row.hash];
      if (byBadge !== !!row.merged) {
        mismatch += 1;
        console.log('   不一致: ' + row.short + ' ' + row.subject.slice(0, 24) + ' | 徽标=' + byBadge + ' 检查=' + row.merged);
      }
      if (row.merged && row.mergeKind && row.mergeKind !== 'patch') {
        kinds += 1;
        if (!(pf.squash || {})[row.hash]) {
          mismatch += 1;
          console.log('   配色不一致: ' + row.short + ' 检查判定为 ' + row.mergeKind + '，但徽标没标成 squash 样式');
        }
      }
    }
    check('两侧结论完全一致（' + (cm.commits || []).length + ' 条提交）', mismatch, 0);
    check('squash/deep 命中数一致', kinds, pf.counts.squash);
  }

  console.log('\n------------ 结果 ------------');
  console.log('通过 ' + pass + ' 项' + (fails.length ? '，失败 ' + fails.length + ' 项' : '，全部通过'));
  process.exit(fails.length ? 1 : 0);
})();
