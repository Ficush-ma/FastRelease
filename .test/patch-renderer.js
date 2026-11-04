'use strict';
/* 一次性把渲染层的「暂存恢复冲突 → 内置冲突界面」改动打上（应对沙箱回滚，可重复执行） */
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'renderer', 'app.js');
let raw = fs.readFileSync(FILE, 'utf8');
const crlf = raw.includes('\r\n');
let s = crlf ? raw.replace(/\r\n/g, '\n') : raw;
let changed = 0;
const apply = (from, to, label) => {
  if (!s.includes(from)) { console.log('跳过(未找到):', label); return; }
  s = s.replace(from, to);
  changed++;
  console.log('已替换:', label);
};

/* 1. reportStash + openStashConflict + restoreStash */
const oldStash = `/** 自动暂存的结果提示（冲突场景由 continue / abort 负责恢复） */
function reportStash(res) {
  if (!res || !res.stashed) return;
  if (res.conflict) {
    if (res.stashError) showStashDeferred(res.stashError);
    return;
  }
  if (res.stashRestored) toast('工作区改动已自动恢复', 'ok');
  else if (res.stashRestored === false) showStashDeferred(res.stashError);
}

/** 改动没能自动恢复：告诉用户在哪重试，并打开恢复入口 */
function showStashDeferred(msg) {
  state.stashDeferred = true;
  if (state.dir) {
    const btn = $('#workRestore');
    if (btn) btn.classList.remove('hidden');
  }
  toast(msg || '改动仍保存在 stash 里，可在「工作区改动」窗口点「恢复暂存的改动」重试', 'warn');
}

/** 冲突解决完 / 中止后，把摘取前暂存的改动恢复回来 */
async function restoreStash() {
  const res = await api.stashPop(state.dir, true);
  if (res && res.ok) {
    state.stashDeferred = false;
    $('#workRestore').classList.add('hidden');
    toast('工作区改动已恢复', 'ok');
    return;
  }
  showStashDeferred((res && res.error) || '改动未能自动恢复');
}`;

const newStash = `/** 自动暂存的结果提示（摘取冲突未解决时暂存先留着） */
function reportStash(res) {
  if (!res || !res.stashed) return;
  if (res.conflict) return;
  if (res.stashRestored) {
    toast('工作区改动已自动恢复', 'ok');
    return;
  }
  if (res.stashConflict && (res.stashFiles || []).length) {
    openStashConflict(res.stashFiles, res.stashError);
    return;
  }
  if (res.stashError) toast(res.stashError, 'warn');
}

/** 打开内置冲突界面，解决「恢复暂存改动」时的冲突 */
function openStashConflict(files, note) {
  state.stashDeferred = true;
  const branch = (state.info && state.info.branch) || '';
  openMergeView(files || [], branch, 'stash');
  toast(note || '恢复暂存改动时发生冲突，请解决后点「全部完成，恢复改动」', 'warn');
}

/** 恢复暂存的改动：有冲突时进入冲突界面逐个解决 */
async function restoreStash() {
  setBusy(true, '正在恢复暂存的改动…');
  const res = await api.stashPop(state.dir);
  setBusy(false);
  if (res && res.ok) {
    state.stashDeferred = false;
    $('#workRestore').classList.add('hidden');
    toast('工作区改动已恢复', 'ok');
    await refreshAll();
    return;
  }
  if (res && res.conflict && (res.files || []).length) {
    $('#workView').classList.add('hidden');
    openStashConflict(res.files, res.error);
    return;
  }
  toast((res && res.error) || '改动未能恢复，仍在 stash 里', 'err');
}`;
apply(oldStash, newStash, 'reportStash/restoreStash');

/* 2. 恢复按钮绑定 */
const oldBtn = `  $('#workRestore').addEventListener('click', async () => {
    setBusy(true, '正在恢复暂存的改动…');
    const res = await api.stashPop(state.dir, true);
    setBusy(false);
    if (res && res.ok) {
      state.stashDeferred = false;
      $('#workRestore').classList.add('hidden');
      $('#workView').classList.add('hidden');
      toast('工作区改动已恢复', 'ok');
      await refreshAll();
      return;
    }
    showStashDeferred((res && res.error) || '恢复失败');
  });`;
const newBtn = `  $('#workRestore').addEventListener('click', () => restoreStash());`;
apply(oldBtn, newBtn, 'workRestore 绑定');

/* 3. 冲突窗口文案（增加 stash 模式） */
const oldTitle = `  $('#mergeTitle').textContent = isRebase ? '解决变基冲突' : '解决摘取冲突';
  $('#oursName').textContent = isRebase ? \`远端最新（\${state.merge.target}）\` : \`当前分支（\${state.merge.target}）\`;
  $('#theirsName').textContent = isRebase ? '你的本地提交' : '被摘取的提交';
  $('#mfContinue').textContent = isRebase ? '全部完成，继续变基' : '全部完成，继续摘取';
  $('#mfAbort').textContent = isRebase ? '中止变基' : '中止摘取';`;
const newTitle = `  const isStash = state.merge.operation === 'stash';
  $('#mergeTitle').textContent = isStash ? '解决改动恢复冲突' : (isRebase ? '解决变基冲突' : '解决摘取冲突');
  $('#oursName').textContent = isRebase ? \`远端最新（\${state.merge.target}）\` : \`当前分支（\${state.merge.target}）\`;
  $('#theirsName').textContent = isStash ? '你暂存的改动' : (isRebase ? '你的本地提交' : '被摘取的提交');
  $('#mfContinue').textContent = isStash ? '全部完成，恢复改动' : (isRebase ? '全部完成，继续变基' : '全部完成，继续摘取');
  $('#mfAbort').textContent = isStash ? '放弃恢复（保留 stash）' : (isRebase ? '中止变基' : '中止摘取');
  $('#mfSkip').classList.toggle('hidden', isStash);`;
apply(oldTitle, newTitle, '冲突窗口文案');

/* 4. continuePick 增加 stash 分支 */
const oldCont = `  const isRebase = state.merge.operation === 'rebase';
  setBusy(true, isRebase ? '正在继续变基…' : '正在继续摘取…');`;
const newCont = `  // 恢复暂存改动导致的冲突：解决完 add 之后丢掉这条 stash 记录即可
  if (state.merge.operation === 'stash') {
    setBusy(true, '正在完成改动恢复…');
    const fin = await api.stashFinish(state.dir);
    setBusy(false);
    if (!fin || !fin.ok) {
      toast((fin && fin.error) || '完成恢复失败', 'err');
      return;
    }
    state.stashDeferred = false;
    $('#workRestore').classList.add('hidden');
    closeMergeView();
    await refreshAll();
    toast('工作区改动已恢复', 'ok');
    return;
  }

  const isRebase = state.merge.operation === 'rebase';
  setBusy(true, isRebase ? '正在继续变基…' : '正在继续摘取…');`;
apply(oldCont, newCont, 'continuePick stash 分支');

/* 5. abortPick 增加 stash 分支 */
const oldAbort = `async function abortPick() {
  const label = state.merge.operation === 'rebase' ? '变基' : '摘取';`;
const newAbort = `async function abortPick() {
  // 放弃恢复暂存改动：工作区回干净，改动仍留在 stash
  if (state.merge.operation === 'stash') {
    const okStash = await modalConfirm(
      '放弃恢复改动',
      '将把工作区恢复到干净状态，你暂存的改动会<b>保留在 stash 里</b>，之后还能再恢复。确定放弃吗？',
      '放弃恢复',
      true
    );
    if (!okStash) return;
    setBusy(true, '正在回滚…');
    const res = await api.stashAbort(state.dir);
    setBusy(false);
    if (!res || !res.ok) { toast((res && res.error) || '回滚失败', 'err'); return; }
    closeMergeView();
    await refreshAll();
    toast('已放弃恢复，改动仍在 stash 里', 'warn');
    return;
  }

  const label = state.merge.operation === 'rebase' ? '变基' : '摘取';`;
apply(oldAbort, newAbort, 'abortPick stash 分支');

fs.writeFileSync(FILE, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('完成，替换', changed, '处');
