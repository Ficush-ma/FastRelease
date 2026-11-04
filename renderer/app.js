'use strict';

/* ============================================================
   FastRelease - 渲染层
   ============================================================ */

(function () {

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const api = window.api;

const state = {
  dir: '',
  info: null,
  branches: [],
  config: {},
  busy: false,
  tab: 'merge',
  stashDeferred: false,
  panes: {},
  merge: {
    active: false,
    dir: '',
    target: '',
    operation: 'cherry-pick',
    files: [],
    resolved: new Set(),
    others: [],
    current: null,
    pendingPush: false,
    pendingStash: false,
    pushSide: '',
    fixQueue: false,
    fixBranch: '',
    fixItem: null
  }
};

/* -------------------------- 小工具 -------------------------- */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtDateShort(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtDateFull(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function toast(msg, type = '') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  box.appendChild(el);
  const ttl = type === 'err' ? 6500 : 3200;
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, ttl);
}

function setStatus(text, kind = '') {
  $('#statusText').textContent = text;
  const dot = $('#statusDot');
  dot.className = 'dot ' + kind;
}

let toastTimer = null;
function setBusy(v, text) {
  state.busy = v;
  if (v) {
    setStatus(text || '执行中…', 'busy');
    clearTimeout(toastTimer);
  } else {
    setStatus('就绪', 'ok');
  }
  updateTransferUI();
  if (state.panes.left && state.panes.right) updatePaneAhead();
}

function logCmd(cmd, output, ok = true, autoOpen = true) {
  const body = $('#logBody');
  const entry = document.createElement('div');
  entry.className = 'log-entry' + (ok ? '' : ' err');
  const time = new Date();
  entry.innerHTML =
    `<span class="time">${pad2(time.getHours())}:${pad2(time.getMinutes())}:${pad2(time.getSeconds())}</span>` +
    `<span class="cmd">$ ${escapeHtml(cmd)}</span>` +
    (output ? `\n<span class="out">${escapeHtml(output)}</span>` : '');
  body.appendChild(entry);
  body.scrollTop = body.scrollHeight;
  if (!ok && autoOpen) $('#logPanel').classList.remove('hidden');
}

function logResult(res) {
  if (!res) return;
  const autoOpen = !res.conflict;
  if (Array.isArray(res.logs)) {
    res.logs.forEach((l) => logCmd(l.cmd, l.output, l.ok, autoOpen));
  } else if (res.cmd) {
    logCmd(res.cmd, res.output || '', res.ok, autoOpen);
  }
}

/* -------------------------- 对话框 -------------------------- */

function modalConfirm(title, body, okText = '确定', danger = false) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = body;
    const ok = $('#modalOk');
    const cancel = $('#modalCancel');
    ok.textContent = okText;
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    cancel.classList.remove('hidden');
    modal.classList.remove('hidden');
    const close = (v) => {
      modal.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      modal.removeEventListener('mousedown', onBackdrop);
      resolve(v);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onBackdrop = (e) => { if (e.target === modal) close(false); };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    modal.addEventListener('mousedown', onBackdrop);
    setTimeout(() => ok.focus(), 30);
  });
}

function modalAlert(title, body, okText = '好') {
  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = body;
    const ok = $('#modalOk');
    const cancel = $('#modalCancel');
    ok.textContent = okText;
    ok.className = 'btn primary';
    cancel.classList.add('hidden');
    modal.classList.remove('hidden');
    const close = () => {
      modal.classList.add('hidden');
      ok.removeEventListener('click', close);
      modal.removeEventListener('mousedown', onBackdrop);
      resolve(true);
    };
    const onBackdrop = (e) => { if (e.target === modal) close(); };
    ok.addEventListener('click', close);
    modal.addEventListener('mousedown', onBackdrop);
    setTimeout(() => ok.focus(), 30);
  });
}

/* -------------------------- 提交列表栏 -------------------------- */

class Pane {
  constructor(side) {
    this.side = side;
    this.el = $(`.pane[data-side="${side}"]`);
    this.branchSelect = $('.branch-select', this.el);
    this.authorSelect = $('.author-select', this.el);
    this.searchInput = $('.search-input', this.el);
    this.searchBox = $('.search-box', this.el);
    this.searchClear = $('.search-clear', this.el);
    this.timeSelect = $('.time-select', this.el);
    this.customRange = $('.custom-range', this.el);
    this.dateFrom = $('.date-from', this.el);
    this.dateTo = $('.date-to', this.el);
    this.listEl = $('.commit-list', this.el);
    this.moreBtn = $('.more-btn', this.el);
    this.footTip = $('.foot-tip', this.el);
    this.countTip = $('.count-tip', this.el);
    this.branchTip = $('.branch-tip', this.el);
    this.selectAll = $('.select-all', this.el);

    this.commits = [];
    this.selected = new Set();
    this.activeHash = '';
    this.ahead = 0;
    this.behind = 0;
    this.lastIndex = -1;
    this.pickedMap = {};
    this.squashMap = {};
    this.limit = 200;
    this.hasMore = false;
    this.branch = '';
    this.loading = false;
    this.timeRange = side === 'left' ? '30' : 'all';
    this.pickedLabel = side === 'left' ? '已摘取' : '左侧已有';

    this.bind();
  }

  bind() {
    this.branchSelect.addEventListener('change', async () => {
      this.branch = this.branchSelect.value;
      const patch = this.side === 'left' ? { leftBranch: this.branch } : { rightBranch: this.branch };
      const saved = await api.setConfig(patch);
      if (saved && saved.config) state.config = saved.config;
      this.selected.clear();
      this.limit = state.config.pageSize || 200;

      // 换分支后：本栏重拉提交，同时刷新两栏的「已摘取」标记并重绘
      this.loadAuthors();
      await this.load(true);
      await refreshFlags();
      state.panes.left.render();
      state.panes.right.render();
      loadAheads();
      updateTransferUI();
    });

    let timer = null;
    this.searchInput.addEventListener('input', () => {
      this.searchBox.classList.toggle('has-value', !!this.searchInput.value);
      clearTimeout(timer);
      timer = setTimeout(() => this.load(true), 320);
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(timer); this.load(true); }
      if (e.key === 'Escape') { this.searchInput.value = ''; this.searchBox.classList.remove('has-value'); this.load(true); }
    });
    this.searchClear.addEventListener('click', () => {
      this.searchInput.value = '';
      this.searchBox.classList.remove('has-value');
      this.load(true);
    });

    this.authorSelect.addEventListener('change', () => this.load(true));

    this.timeSelect.value = this.timeRange;
    this.timeSelect.addEventListener('change', () => {
      this.timeRange = this.timeSelect.value;
      if (this.timeRange === 'custom') {
        this.customRange.classList.remove('hidden');
        if (!this.dateFrom.value) {
          const d = new Date(Date.now() - 30 * 864e5);
          this.dateFrom.value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
          const n = new Date();
          this.dateTo.value = `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
        }
      } else {
        this.customRange.classList.add('hidden');
        this.load(true);
        refreshFlags(); // 徽标口径跟随时间窗口
      }
    });
    $('.apply-range', this.el).addEventListener('click', () => {
      this.load(true);
      refreshFlags();
    });
    $('.cancel-range', this.el).addEventListener('click', () => {
      this.customRange.classList.add('hidden');
      this.timeSelect.value = this.timeRange;
      if (this.timeRange === 'custom') this.timeRange = 'all';
    });

    $('.refresh-btn', this.el).addEventListener('click', () => this.load(true));
    this.moreBtn.addEventListener('click', async () => {
      this.limit += state.config.pageSize || 200;
      await this.load(false);
    });

    this.selectAll.addEventListener('change', () => {
      const all = this.selectAll.checked;
      this.commits.forEach((c) => {
        if (all) this.selected.add(c.hash);
        else this.selected.delete(c.hash);
      });
      this.syncSelectionDom();
      updateTransferUI();
    });

    this.listEl.addEventListener('click', (e) => {
      const row = e.target.closest('.commit-row');
      if (!row) return;
      const idx = Number(row.dataset.index);
      const cb = e.target.closest('input[type="checkbox"]');
      if (e.shiftKey && this.lastIndex >= 0 && !cb) {
        const [a, b] = [Math.min(this.lastIndex, idx), Math.max(this.lastIndex, idx)];
        for (let i = a; i <= b; i++) this.selected.add(this.commits[i].hash);
      } else {
        const hash = this.commits[idx].hash;
        if (this.selected.has(hash)) this.selected.delete(hash);
        else this.selected.add(hash);
        this.activeHash = hash;
      }
      this.lastIndex = idx;
      this.syncSelectionDom();
      updateTransferUI();
    });

    this.listEl.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.commit-row');
      if (!row) return;
      const c = this.commits[Number(row.dataset.index)];
      if (c) openDetail(c.hash);
    });

    this.listEl.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.commit-row');
      if (!row) return;
      e.preventDefault();
      const c = this.commits[Number(row.dataset.index)];
      if (!c) return;
      showContextMenu(e.clientX, e.clientY, [
        { label: '查看提交详情', act: () => openDetail(c.hash) },
        { label: '复制提交哈希', act: () => navigator.clipboard.writeText(c.hash) },
        { label: '复制提交信息', act: () => navigator.clipboard.writeText(c.subject) },
        { sep: true },
        {
          label: '只选中此提交',
          act: () => { this.selected.clear(); this.selected.add(c.hash); this.activeHash = c.hash; this.syncSelectionDom(); updateTransferUI(); }
        }
      ]);
    });
  }

  setBranches(branches) {
    const prev = this.branchSelect.value;
    const locals = branches.filter((b) => !b.isRemote);
    const remotes = branches.filter((b) => b.isRemote);
    let html = '<optgroup label="本地分支">' + locals.map((b) =>
      `<option value="${escapeHtml(b.name)}">${escapeHtml(b.name)}${b.current ? '  (当前)' : ''}</option>`).join('') + '</optgroup>';
    if (remotes.length) {
      html += '<optgroup label="远端分支">' + remotes.map((b) =>
        `<option value="${escapeHtml(b.name)}">${escapeHtml(b.name)}</option>`).join('') + '</optgroup>';
    }
    this.branchSelect.innerHTML = html;
    if (prev && branches.some((b) => b.name === prev)) this.branchSelect.value = prev;
    this.branch = this.branchSelect.value;
  }

  get branchInfo() {
    return state.branches.find((b) => b.name === this.branch) || null;
  }

  get isRemote() {
    const b = this.branchInfo;
    return !!(b && b.isRemote);
  }

  timeBounds() {
    const v = this.timeRange;
    if (v === 'all') return {};
    if (v === 'custom') {
      const from = this.dateFrom.value ? this.dateFrom.value + 'T00:00:00' : '';
      const to = this.dateTo.value ? this.dateTo.value + 'T23:59:59' : '';
      return { since: from, until: to };
    }
    const now = new Date();
    if (v === 'today') {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { since: fmtLocal(d) };
    }
    const days = parseInt(v, 10) || 30;
    return { since: fmtLocal(new Date(Date.now() - days * 864e5)) };
  }

  // 异步填充作者下拉（不阻塞提交列表），保留当前选择
  async loadAuthors() {
    if (!state.dir || !this.branch) return;
    const branch = this.branch;
    const res = await api.authors({ dir: state.dir, ref: branch });
    if (branch !== this.branch) return; // 期间又切了分支，丢弃过期结果
    if (!res || !res.ok) return;
    const prev = this.authorSelect.value;
    this.authorSelect.innerHTML = '<option value="">全部作者</option>' +
      res.authors.map((a) =>
        `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}（${a.count}）</option>`).join('');
    if (prev && res.authors.some((a) => a.name === prev)) this.authorSelect.value = prev;
  }

  async load(reset) {
    if (!state.dir || !this.branch) return;
    if (reset) {
      this.limit = state.config.pageSize || 200;
      this.selected.clear();
    }
    this.loading = true;
    this.listEl.innerHTML = '<div class="list-loading"><span class="spinner"></span>正在读取提交…</div>';
    const bounds = this.timeBounds();
    const res = await api.commits({
      dir: state.dir,
      ref: this.branch,
      limit: this.limit,
      skip: 0,
      search: this.searchInput.value.trim(),
      since: bounds.since || '',
      until: bounds.until || '',
      author: this.authorSelect.value || ''
    });
    this.loading = false;
    if (!res || !res.ok) {
      this.commits = [];
      this.hasMore = false;
      this.renderError(res && res.error);
      this.updateMeta();
      return;
    }
    this.commits = res.commits || [];
    this.hasMore = !!res.hasMore;
    this.render();
    this.updateMeta();
    updateTransferUI();
  }

  renderError(msg) {
    this.listEl.innerHTML = `<div class="list-empty">读取提交失败<br /><span style="color:#a52626">${escapeHtml(msg || '未知错误')}</span></div>`;
  }

  updateMeta() {
    const total = this.commits.length;
    this.countTip.textContent = total ? `${total} 条提交` : '';
    this.moreBtn.classList.toggle('hidden', !this.hasMore);
    const b = state.branches.find((x) => x.name === this.branch);
    if (b) {
      const parts = [];
      if (b.isRemote) parts.push('远端分支（只读）');
      else if (b.upstream) parts.push(`跟踪 ${b.upstream}`);
      parts.push(`最新 ${fmtDateFull(b.date)}`);
      this.branchTip.textContent = parts.join(' · ');
    } else {
      this.branchTip.textContent = '';
    }
    if (total === 0) {
      const filtered = this.searchInput.value.trim() || (this.timeRange !== 'all');
      this.footTip.textContent = filtered ? '没有匹配的提交，试试放宽时间范围或清空搜索' : '该分支还没有提交';
    } else if (this.hasMore) {
      this.footTip.textContent = `已加载 ${total} 条，还有更早的提交`;
    } else {
      this.footTip.textContent = '';
    }
  }

  render() {
    if (this.loading) return;
    if (!this.commits.length) {
      this.listEl.innerHTML = `<div class="list-empty">${state.dir ? '当前筛选条件下没有提交' : '请先选择仓库'}</div>`;
      this.selectAll.checked = false;
      this.selectAll.indeterminate = false;
      return;
    }
    const curBranch = state.info && state.info.branch;
    const html = this.commits.map((c, i) => {
      const sel = this.selected.has(c.hash);
      const picked = !!this.pickedMap[c.hash];
      const badges = [];
      if (picked) {
        const sq = !!this.squashMap[c.hash];
        badges.push(sq
          ? `<span class="badge picked squash" title="对侧分支的文件内容已包含该提交的改动（squash 合并判定）">${this.pickedLabel}</span>`
          : `<span class="badge picked" title="对侧分支已存在等价提交（patch-id 判定）">${this.pickedLabel}</span>`);
      }
      if (c.isMerge) badges.push('<span class="badge merge">合并</span>');
      if (curBranch && this.branch === curBranch && i === 0) badges.push('<span class="badge head">HEAD</span>');
      return (
        `<div class="commit-row${sel ? ' selected' : ''}${this.activeHash === c.hash ? ' active' : ''}" data-index="${i}" data-hash="${c.hash}">` +
        `<span class="col-check"><input type="checkbox" ${sel ? 'checked' : ''} tabindex="-1" /></span>` +
        `<span class="col-hash" title="${c.hash}">${escapeHtml(c.short)}</span>` +
        `<span class="col-msg" title="${escapeHtml(c.subject)}">${badges.join('')}<span class="text">${escapeHtml(c.subject)}</span></span>` +
        `<span class="col-author" title="${escapeHtml(c.email)}">${escapeHtml(c.author)}</span>` +
        `<span class="col-date" title="${escapeHtml(c.date)}">${fmtDateShort(c.timestamp)}</span>` +
        `</div>`
      );
    }).join('');
    this.listEl.innerHTML = html;

    const loaded = this.commits.length;
    const selCount = this.commits.filter((c) => this.selected.has(c.hash)).length;
    this.selectAll.checked = loaded > 0 && selCount === loaded;
    this.selectAll.indeterminate = selCount > 0 && selCount < loaded;
  }

  clearSelection() {
    this.selected.clear();
    this.syncSelectionDom();
    updateTransferUI();
  }

  /** 原位更新选中状态，避免整表重绘（保证双击等交互稳定） */
  syncSelectionDom() {
    const rows = this.listEl.children;
    this.commits.forEach((c, i) => {
      const row = rows[i];
      if (!row) return;
      const sel = this.selected.has(c.hash);
      row.classList.toggle('selected', sel);
      row.classList.toggle('active', c.hash === this.activeHash);
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = sel;
    });
    const loaded = this.commits.length;
    const selCount = this.commits.filter((c) => this.selected.has(c.hash)).length;
    this.selectAll.checked = loaded > 0 && selCount === loaded;
    this.selectAll.indeterminate = selCount > 0 && selCount < loaded;
  }

  get selectedCommits() {
    return this.commits.filter((c) => this.selected.has(c.hash));
  }
}

/* -------------------------- 分支/仓库状态 -------------------------- */

function updateHeadInfo() {
  const info = state.info;
  const box = $('#headInfo');
  if (!info || !info.ok) {
    box.innerHTML = '';
    $('#repoState').textContent = '';
    return;
  }
  const branchLabel = info.operation === 'rebase' && info.rebaseBranch
    ? info.rebaseBranch + '（变基中）'
    : (info.branch || 'HEAD 分离');
  const parts = [];
  parts.push(`<span class="chip branch">${escapeHtml(branchLabel)}</span>`);
  if (info.ahead || info.behind) {
    parts.push(
      `<span class="chip" title="相对上游 ${escapeHtml(info.upstream || '')}">` +
      `<span class="up">↑${info.ahead}</span>&nbsp;<span class="down">↓${info.behind}</span></span>`
    );
  }
  if (info.dirty.length) {
    parts.push(`<span class="chip dirty clickable" id="dirtyChip" title="点击查看改动文件">工作区 ${info.dirty.length} 处改动</span>`);
  } else {
    parts.push('<span class="chip clean clickable" id="dirtyChip" title="点击查看工作区（当前没有未提交改动）">工作区干净</span>');
  }
  box.innerHTML = parts.join('');
  const chip = $('#dirtyChip');
  if (chip) chip.addEventListener('click', openWorkView);

  const rs = [];
  rs.push(`当前分支：${info.branch}`);
  if (info.upstream) rs.push(`上游：${info.upstream} ↑${info.ahead} ↓${info.behind}`);
  $('#repoState').textContent = rs.join('　|　');

  const picking = !!(info.operation || info.cherryPicking);
  $('#pickBanner').classList.toggle('hidden', !picking);
  if (picking) {
    const label = { 'cherry-pick': '摘取', rebase: '变基', merge: '合并' }[info.operation] || '摘取';
    $('#pickBannerText').textContent = `当前仓库有一次未完成的${label}操作（存在冲突），需要先解决或中止。`;
    $('#btnResumePick').textContent = '继续解决冲突';
  }
  updatePaneAhead();
}

function updatePaneAhead() {
  const info = state.info;
  ['left', 'right'].forEach((side) => {
    const pane = state.panes[side];
    if (!pane) return;
    const bi = pane.branchInfo;
    const remote = !!(bi && bi.isRemote);
    const pushBtn = $(`.push-btn[data-side="${side}"]`);
    const pullBtn = $(`.pull-btn[data-side="${side}"]`);
    const badge = $('.ahead-badge', pushBtn);

    if (remote) {
      pushBtn.disabled = true;
      badge.textContent = '';
      pushBtn.title = '这是远端分支，只能用来查看和摘取，不能直接推送';
      pullBtn.title = `更新远端引用 ${pane.branch}`;
    } else {
      pushBtn.disabled = state.busy;
      const isCurrent = info && info.ok && pane.branch === info.branch;
      const ahead = isCurrent && info.ahead ? info.ahead : (pane.ahead || 0);
      badge.textContent = ahead ? ` ${ahead}` : '';
      pushBtn.title = `推送 ${pane.branch} 到远端` + (ahead ? `（领先 ${ahead} 个提交）` : '');
      const behind = isCurrent && info.behind ? info.behind : (pane.behind || 0);
      pullBtn.title = `拉取 ${pane.branch} 最新代码` + (behind ? `（远端领先 ${behind} 个提交）` : '');
    }
  });
}

function updateTransferUI() {
  const left = state.panes.left;
  const right = state.panes.right;
  const ls = left ? left.selected.size : 0;
  const rs = right ? right.selected.size : 0;
  const btn = $('#btnTransfer');
  const arrow = $('.xfer-arrow', btn);
  const count = $('.xfer-count', btn);
  const text = $('.xfer-text', btn);

  let dir = null;
  if (ls && !rs) dir = 'right';
  else if (rs && !ls) dir = 'left';
  else if (ls && rs) dir = 'right';

  const sameBranch = !!(left && right && left.branch && left.branch === right.branch);
  const n = dir === 'left' ? rs : ls;
  const dstPane = dir === 'left' ? left : right;
  const remoteTarget = !!(dstPane && dstPane.isRemote);
  const blocked = !dir || state.busy || sameBranch || remoteTarget;
  btn.disabled = blocked;
  arrow.textContent = dir === 'left' ? '←' : '→';
  count.textContent = String(n || 0);
  text.textContent = '摘取';

  const btnPush = $('#btnTransferPush');
  btnPush.disabled = blocked;
  $('.xfer-arrow', btnPush).textContent = dir === 'left' ? '←' : '→';
  $('.xfer-count', btnPush).textContent = String(n || 0);
  btnPush.title = blocked ? btn.title : `摘取 ${n} 个提交到 ${dstPane.branch}，成功后自动推送`;

  const hint = $('.xfer-hint');
  if (sameBranch) {
    hint.innerHTML = '两侧是同一个分支<br />请选择不同分支';
  } else if (remoteTarget) {
    hint.innerHTML = '目标不能是远端分支<br />请换成对应本地分支';
  } else {
    hint.innerHTML = '选择提交后<br />摘取到对侧';
  }

  if (sameBranch) {
    btn.title = '左右两侧是同一个分支，无法摘取';
  } else if (remoteTarget) {
    btn.title = '摘取目标必须是本地分支（远端分支只读）';
  } else if (dir) {
    const src = dir === 'left' ? right : left;
    btn.title = `从 ${src.branch} 摘取选中的 ${n} 个提交到 ${dstPane.branch}`;
  } else {
    btn.title = '先在左右任一栏勾选提交';
  }
  $('#btnClearSel').disabled = !(ls || rs);
  updateFixButtons();
}

/* -------------------------- 仓库加载 -------------------------- */

async function openRepo(dir, opts = {}) {
  if (!dir) return;
  setBusy(true, '正在打开仓库…');
  const info = await api.repoInfo(dir);
  if (!info || !info.ok) {
    state.dir = '';
    state.info = null;
    $('#repoWarning').classList.remove('hidden');
    $('#repoWarning').textContent = (info && info.error) || '无法打开该目录';
    setBusy(false);
    setStatus('未打开仓库', 'err');
    if (!opts.silent) toast((info && info.error) || '无法打开该目录', 'err');
    return;
  }
  $('#repoWarning').classList.add('hidden');
  state.dir = info.root;
  state.info = info;
  $('#repoPath').value = info.root;

  // 记住仓库
  const repos = [info.root, ...(state.config.repos || []).filter((r) => r !== info.root)].slice(0, 12);
  state.config = (await api.setConfig({ lastRepo: info.root, repos })).config;

  updateHeadInfo();
  await loadBranches();
  setBusy(false);
  setStatus('就绪', 'ok');
  if (!opts.silent) toast('已打开 ' + info.root, 'ok');
}

async function loadBranches(prefetched) {
  const res = prefetched && prefetched.ok ? prefetched : await api.branches(state.dir);
  if (!res || !res.ok) {
    toast((res && res.error) || '读取分支失败', 'err');
    return;
  }
  state.branches = res.branches || [];
  if (!state.branches.length) {
    toast('该仓库没有任何本地分支', 'warn');
    return;
  }

  const names = state.branches.map((b) => b.name);
  const current = res.current || (state.info && state.info.branch);
  const byDate = (arr) => arr.slice().sort((a, b) => b.timestamp - a.timestamp);
  const locals = byDate(state.branches.filter((b) => !b.isRemote));
  const remoteBranches = byDate(state.branches.filter((b) => b.isRemote));
  const devRe = /(^|\/)dev|develop/i;
  const relRe = /(^|\/)(release|master|main|prod|hotfix)/i;

  let leftName = state.config.leftBranch;
  let rightName = state.config.rightBranch;

  // 源分支：优先 dev（本地优先，其次远端），其次任意非当前分支
  if (!names.includes(leftName)) {
    const cand = locals.find((b) => devRe.test(b.name)) ||
      remoteBranches.find((b) => devRe.test(b.name)) ||
      locals.find((b) => b.name !== current) ||
      locals[0] || remoteBranches[0];
    leftName = cand ? cand.name : current;
  }
  // 目标分支：优先当前的 release 类分支，其次最新的 release 类本地分支
  if (!names.includes(rightName)) {
    const cand = locals.find((b) => b.name === current && relRe.test(b.name)) ||
      locals.find((b) => relRe.test(b.name)) ||
      locals[0] ||
      locals.find((b) => b.name !== leftName);
    rightName = cand ? cand.name : current;
  }
  if (leftName === rightName && names.length > 1) {
    const alt = locals.find((b) => b.name !== leftName) || names.find((n) => n !== leftName);
    if (alt) rightName = alt;
  }

  state.panes.left.setBranches(state.branches);
  state.panes.left.branchSelect.value = leftName;
  state.panes.left.branch = leftName;
  state.panes.right.setBranches(state.branches);
  state.panes.right.branchSelect.value = rightName;
  state.panes.right.branch = rightName;

  state.panes.left.loadAuthors();
  state.panes.right.loadAuthors();
  await Promise.all([state.panes.left.load(true), state.panes.right.load(true), loadAheads()]);
  // 「已摘取」标记要跑 git cherry（大仓库上很慢）：放后台算，先让界面可用
  refreshFlags().then(() => {
    state.panes.left.render();
    state.panes.right.render();
  }).catch(() => {});
  updatePaneAhead();
  updateTransferUI();

  // 合并检查页如果开着，同步分支下拉（保留已选值）
  if (currentTab() === 'check') {
    const s = $('#ckSource');
    const t = $('#ckTarget');
    if (s && t) {
      fillBranchSelect(s, s.value || (state.panes.left && state.panes.left.branch));
      fillBranchSelect(t, t.value || (state.panes.right && state.panes.right.branch));
    }
  }
}

async function loadAheads() {
  const left = state.panes.left;
  const right = state.panes.right;
  if (!left || !right) return;
  const ask = (pane) => (pane.branch && !pane.isRemote ? api.branchAhead(state.dir, pane.branch) : null);
  const [l, r] = await Promise.all([ask(left), ask(right)]);
  left.ahead = (l && l.ok && l.ahead) || 0;
  left.behind = (l && l.ok && l.behind) || 0;
  right.ahead = (r && r.ok && r.ahead) || 0;
  right.behind = (r && r.ok && r.behind) || 0;
  updatePaneAhead();
}

/**
 * 计算两栏的「已摘取」徽标。
 * 口径与列表筛选一致：用每栏自己的时间窗口（「全部时间」时后端封顶 90 天）。
 * 后端按分支 tip + 窗口做 patch-id 索引缓存，分支没动时第二次是毫秒级。
 */
async function refreshFlags() {
  const left = state.panes.left;
  const right = state.panes.right;
  if (!left || !left.branch) return;

  // 批量页有多个目标分支，单个「已摘取」口径没有意义，统一不显示徽标
  if (currentTab() === 'fix') {
    left.pickedMap = {};
    left.squashMap = {};
    left.render();
    return;
  }

  if (!right || !right.branch) return;

  const runOne = async (pane, other) => {
    if (pane.branch === other.branch) {
      pane.pickedMap = {};
      pane.squashMap = {};
      pane.render();
      return;
    }
    const bounds = pane.timeBounds();
    const source = pane.branch;
    pane.el.classList.add('flagging');
    try {
      // 只判当前列表里的提交：结果稳定、耗时可控（深层判定按条数给预算）
      const res = await api.patchFlags({
        dir: state.dir,
        source,
        target: other.branch,
        since: bounds.since || '',
        until: bounds.until || '',
        only: (pane.commits || []).map((c) => c.hash)
      });
      // 期间切了分支就丢弃过期结果
      if (pane.branch !== source) return;
      if (res && res.ok) {
        pane.pickedMap = res.map || {};
        pane.squashMap = (res && res.squash) || {};
        pane.render();
      }
    } catch (e) {
      try { api.logError({ kind: 'rejection', message: '刷新已摘取标记失败：' + ((e && e.message) || e) }); } catch (_) { /* ignore */ }
    } finally {
      pane.el.classList.remove('flagging');
    }
  };

  await Promise.all([runOne(left, right), runOne(right, left)]);
}

async function refreshAll(opts = {}) {
  if (!state.dir) return;
  setBusy(true, '正在刷新…');
  try {
    // 仓库信息与分支列表并行，少一次串行等待
    const [info, br] = await Promise.all([api.repoInfo(state.dir), api.branches(state.dir)]);
    if (info && info.ok) {
      state.info = info;
      updateHeadInfo();
    }
    // 分支列表拿到就解除忙碌，后面的提交加载/标记计算不再锁界面
    await loadBranches(br);
  } catch (e) {
    toast('刷新失败：' + ((e && e.message) || e), 'err');
  } finally {
    setBusy(false);
    updateTransferUI();
  }
  if (opts.reselect) updateTransferUI();
  if (currentTab() === 'fix') await initFixView();
}

async function refreshInfoOnly() {
  if (!state.dir) return;
  const info = await api.repoInfo(state.dir);
  if (info && info.ok) {
    state.info = info;
    updateHeadInfo();
  }
}

/* -------------------------- 拉取 / 推送 -------------------------- */

async function doPull(side) {
  const pane = state.panes[side];
  if (!pane.branch) return;
  const mode = state.config.pullMode || 'rebase';

  // 工作区有改动且拉的是当前分支：确认后自动暂存，拉完恢复
  const isCurrent = state.info && state.info.ok && state.info.branch === pane.branch;
  const dirty = state.info && state.info.dirty ? state.info.dirty.length : 0;
  let autoStash = false;
  if (!pane.isRemote && isCurrent && dirty) {
    autoStash = await modalConfirm(
      '工作区有未提交改动',
      `当前工作区有 <b>${dirty}</b> 处未提交改动。<br />` +
      `继续将执行：<b>git stash push -u</b> 暂存 → ${mode === 'rebase' ? '变基' : '拉取'} → 自动恢复改动。<br />` +
      `如果变基过程中出现冲突，改动会一直保留在 stash 里，等你解决完并继续（或中止）之后再恢复。`,
      '暂存并继续'
    );
    if (!autoStash) return;
  }

  if (pane.isRemote) setBusy(true, `正在更新远端引用 ${pane.branch}…`);
  else setBusy(true, autoStash ? `正在暂存并${mode === 'rebase' ? '变基' : '拉取'} ${pane.branch}…` : (mode === 'rebase' ? `正在变基 ${pane.branch}…` : `正在拉取 ${pane.branch}…`));

  const res = await api.pull(state.dir, pane.branch, mode, autoStash);
  logResult(res);
  reportStash(res);

  if (!res.ok && res.conflict) {
    setBusy(false);
    toast('拉取时发生冲突，请解决后继续', 'warn');
    state.merge.pendingStash = !!res.stashed;
    await openMergeView(res.files || [], pane.branch, res.operation || 'rebase');
    refreshInfoOnly();
    return;
  }

  setBusy(false);
  if (!res.ok) {
    toast(res.error || '拉取失败', 'err');
    return;
  }
  toast(res.message || '已更新', 'ok');
  await refreshAll();
}

/**
 * 推送某个分支
 * skipConfirm=true 时不再弹确认框（用于「摘取并推送」的连续动作）
 */
async function performPush(side, { skipConfirm = false, retried = false, autoRebase = false } = {}) {
  const pane = state.panes[side];
  if (!pane || !pane.branch) return;
  if (pane.isRemote) {
    toast('这是远端分支，请选择本地分支再推送', 'warn');
    return;
  }
  const info = state.info;
  if (!skipConfirm && !retried && info && info.branch === pane.branch && info.upstream && info.ahead === 0) {
    toast('没有需要推送的提交（本地与远端已一致）', 'warn');
    return;
  }
  if (!skipConfirm) {
    const aheadNote = info && info.branch === pane.branch && info.ahead
      ? `\n本次将推送 ${info.ahead} 个提交。`
      : '';
    const ok = await modalConfirm('推送到远端', `确定把 <b>${escapeHtml(pane.branch)}</b> 推送到远端吗？${aheadNote}`);
    if (!ok) return;
  }

  setBusy(true, `正在推送 ${pane.branch}…`);
  const res = await api.push(state.dir, pane.branch);
  logResult(res);
  setBusy(false);

  if (!res.ok) {
    const rejected = /non-fast-forward|rejected|fetch first|failed to push|\[rejected\]/i.test(res.error || '');
    if (rejected && !retried) {
      // 「摘取并推送」是明确的连续动作：被拒时直接变基重推，不再打断用户
      const doRebase = autoRebase
        ? true
        : await modalConfirm(
          '远端有新提交',
          '推送被拒绝：远端存在你本地没有的提交。<br />是否先变基到最新，然后自动重新推送？',
          '变基并推送'
        );
      if (doRebase) {
        if (autoRebase) toast('远端有新提交，正在变基后自动重推…', 'warn');
        await doPull(side);
        // 变基若产生冲突，等解决完再推
        if (state.info && state.info.operation) {
          state.merge.pendingPush = true;
          state.merge.pushSide = side;
          return;
        }
        await performPush(side, { skipConfirm: true, retried: true });
        return;
      }
    }
    toast(res.error || '推送失败', 'err');
    return;
  }
  toast(res.message || '推送成功', 'ok');
  await refreshAll();
}

async function doPush(side) {
  return performPush(side);
}

/* -------------------------- 摘取 -------------------------- */

async function doCherryPick(mode = 'pick') {
  const withPush = mode === 'pickPush';
  const left = state.panes.left;
  const right = state.panes.right;
  const ls = left.selected.size;
  const rs = right.selected.size;
  let src = left;
  let dst = right;
  if (ls && !rs) { src = left; dst = right; }
  else if (rs && !ls) { src = right; dst = left; }
  else if (ls && rs) { src = left; dst = right; }
  else return;

  const commits = src.selectedCommits;
  if (!commits.length) return;
  if (src.branch === dst.branch) {
    toast('左右两侧是同一个分支，请先选择不同的分支', 'warn');
    return;
  }
  if (dst.isRemote) {
    toast(`目标分支 ${dst.branch} 是远端分支，请把右侧切到本地分支再摘取`, 'warn');
    return;
  }
  const picked = commits.filter((c) => src.pickedMap[c.hash]);
  const dirty = state.info && state.info.dirty && state.info.dirty.length;

  let body =
    `从 <b>${escapeHtml(src.branch)}</b> 摘取 <b>${commits.length}</b> 个提交到 <b>${escapeHtml(dst.branch)}</b>：<br />` +
    `<div class="hint" style="margin:6px 0;max-height:150px;overflow:auto;font-family:Consolas,monospace">` +
    commits.slice().reverse().map((c) => `${c.short} ${escapeHtml(c.subject)}`).join('<br />') +
    `</div>`;
  if (dirty) {
    body += `<div style="color:#8a5606;margin-top:6px">当前工作区有 ${dirty} 处未提交改动：<br />` +
      `摘取前会自动执行 <b>git stash push -u</b> 暂存（含未跟踪文件），摘取完成后自动恢复。<br />` +
      `如果中途出现冲突，改动会一直保留在 stash 里，等你解决冲突并继续（或中止）之后再恢复。</div>`;
  }
  if (picked.length) {
    body += `<div style="color:#8a5606;margin-top:6px">其中 ${picked.length} 个提交在 ${escapeHtml(dst.branch)} 上已存在等价提交，可能会重复或冲突。</div>`;
  }
  body += `<div class="hint" style="margin-top:8px">执行时会自动切换到 ${escapeHtml(dst.branch)} 分支。</div>`;
  if (withPush) {
    body += `<div style="color:#0a5cb8;margin-top:6px">摘取成功后会立即把这个分支推送到远端。</div>`;
  }

  const ok = await modalConfirm(withPush ? '摘取并推送' : '摘取提交', body, withPush ? '摘取并推送' : '开始摘取');
  if (!ok) return;

  setBusy(true, dirty ? '正在暂存改动并摘取…' : '正在摘取提交…');
  const res = await api.cherryPick({
    dir: state.dir,
    target: dst.branch,
    commits: commits.map((c) => c.hash),
    autoStash: !!dirty
  });
  logResult(res);
  reportStash(res);

  if (res.ok) {
    src.clearSelection();
    toast(res.message || '摘取完成', res.empty ? 'warn' : 'ok');
    await refreshAll();
    if (withPush) {
      if (res.empty) {
        toast('没有产生新提交，跳过推送', 'warn');
      } else {
        await performPush(dst.side, { skipConfirm: true, autoRebase: true });
      }
    } else {
      setBusy(false);
      if (!res.empty) {
        const btn = $(`.push-btn[data-side="${dst.side}"]`);
        btn.classList.add('flash');
        setTimeout(() => btn.classList.remove('flash'), 1600);
      }
    }
    return;
  }

  setBusy(false);

  if (res.empty) {
    src.clearSelection();
    await refreshAll();
    toast(res.error || '所选提交的改动已存在于目标分支', 'warn');
    return;
  }

  if (res.conflict) {
    toast(withPush ? '摘取时发生冲突，解决后会继续推送' : '摘取时发生冲突，请在冲突窗口中解决', 'warn');
    state.merge.pendingPush = withPush;
    state.merge.pushSide = dst.side;
    state.merge.pendingStash = !!res.stashed;
    if (res.stashed) toast('工作区改动已暂存，解决冲突并继续后会自动恢复', 'ok');
    await openMergeView(res.files || [], dst.branch, 'cherry-pick');
    // 后台刷新一下顶部状态（此时仓库已切到目标分支）
    refreshInfoOnly();
    return;
  }

  toast(res.error || '摘取失败', 'err');
  await refreshAll();
}

/* -------------------------- 工作区改动 / 自动暂存 -------------------------- */

const workState = { files: [], active: '', opening: false };

async function openWorkView() {
  if (workState.opening) return;
  if (!state.dir) {
    toast('请先选择一个仓库', 'warn');
    return;
  }
  workState.opening = true;
  const chip = $('#dirtyChip');
  const chipText = chip ? chip.textContent : '';
  if (chip) chip.textContent = '读取中…';
  try {
    const res = await api.workingChanges(state.dir);
    if (!res || !res.ok) {
      toast((res && res.error) || '读取工作区失败', 'err');
      return;
    }
    workState.files = res.files || [];
    workState.active = '';
    const summary = res.stat ? res.stat.split('\n').pop().trim() : '';
    $('#workCount').textContent = workState.files.length
      ? workState.files.length + ' 个文件' + (summary ? ' · ' + summary : '')
      : '';
    setWorkDiff(workState.files.length ? '从左侧选择一个文件查看改动' : '工作区没有改动');
    $('#workView').classList.remove('hidden');
    $('#workRestore').classList.toggle('hidden', !state.stashDeferred);
    renderWorkList();
    if (workState.files.length) loadWorkDiff(workState.files[0].path);
  } catch (e) {
    toast('打开工作区失败：' + ((e && e.message) || e), 'err');
  } finally {
    workState.opening = false;
    if (chip && chip.isConnected) chip.textContent = chipText;
  }
}

function workCodeClass(code) {
  if (code === '??') return 'unt';
  if (code.includes('D')) return 'del';
  if (code.includes('A')) return 'add';
  return 'mod';
}

function renderWorkList() {
  const list = $('#workList');
  list.innerHTML = workState.files.map((f) =>
    `<div class="work-item${workState.active === f.path ? ' active' : ''}" data-path="${escapeHtml(f.path)}">` +
    `<span class="wcode ${workCodeClass(f.code)}">${escapeHtml(f.code.trim() || '?')}</span>` +
    `<span class="wname">${escapeHtml(f.path)}</span></div>`).join('');
  list.querySelectorAll('.work-item').forEach((el) => {
    el.addEventListener('click', () => loadWorkDiff(el.dataset.path));
  });
}

/** 把 git diff 文本按行着色：新增/删除/块头/文件头，让改动处一眼可见 */
function workDiffHtml(text) {
  const rows = String(text).split('\n').map((line) => {
    let cls = '';
    if (/^(\+\+\+|---)\s/.test(line)) cls = 'meta';
    else if (line.startsWith('@@')) cls = 'hunk';
    else if (/^(diff --git|index |new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode|Binary files)/.test(line)) cls = 'head';
    else if (line.startsWith('\\')) cls = 'meta';
    else if (line.startsWith('+')) cls = 'add';
    else if (line.startsWith('-')) cls = 'del';
    return '<span class="dl' + (cls ? ' ' + cls : '') + '">' + (escapeHtml(line) || '&#8203;') + '</span>';
  });
  return rows.join('\n');
}

/** 统一的 diff 输出入口；colorize 为 false 时按纯文本显示（提示语 / 错误） */
function setWorkDiff(text, { colorize = false } = {}) {
  const el = $('#workDiff');
  if (!colorize) {
    el.textContent = text;
    return;
  }
  el.innerHTML = workDiffHtml(text);
}

async function loadWorkDiff(relPath) {
  const f = workState.files.find((x) => x.path === relPath);
  if (!f) return;
  workState.active = relPath;
  renderWorkList();
  setWorkDiff('读取中…');
  const stagedOnly = !f.untracked && f.code[1] === ' ' && f.code[0] !== ' ';
  const res = await api.workingDiff({
    dir: state.dir,
    relPath: f.path,
    untracked: f.untracked,
    staged: stagedOnly
  });
  if (workState.active !== relPath) return;
  const ok = !!(res && res.ok);
  setWorkDiff(ok ? (res.text || '（无差异）') : ((res && res.error) || '读取失败'), { colorize: ok });
}

/** 自动暂存的结果提示（摘取冲突未解决时暂存先留着） */
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
}

/* -------------------------- 提交详情 -------------------------- */

let detailOpenFor = '';

async function openDetail(hash) {
  detailOpenFor = hash;
  $('#detailDrawer').classList.remove('hidden');
  $('#detailSubject').textContent = '加载中…';
  $('#detailMeta').textContent = hash;
  $('#detailBody').innerHTML = '<div class="list-loading"><span class="spinner"></span>正在读取改动…</div>';
  const res = await api.commitDetail(state.dir, hash);
  if (detailOpenFor !== hash) return;
  if (!res || !res.ok) {
    $('#detailBody').innerHTML = `<div class="list-empty">读取失败：${escapeHtml((res && res.error) || '')}</div>`;
    return;
  }
  $('#detailSubject').textContent = res.header.subject || '(无提交信息)';
  $('#detailMeta').textContent = `${res.header.hash} · ${res.header.author} · ${fmtDateFull(res.header.date)}`;
  $('#detailBody').innerHTML = renderPatch(res.patch, res.truncated);
}

function renderPatch(patch, truncated) {
  if (!patch.trim()) return '<div class="list-empty">该提交没有文本改动</div>';
  const lines = patch.split('\n');
  const files = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
      current = { name: m ? m[2] : line.replace(/^diff --git /, ''), lines: [] };
      files.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (!files.length) files.push({ name: 'diff', lines });

  let html = '';
  for (const f of files) {
    html += `<div class="diff-file"><div class="diff-file-head">${escapeHtml(f.name)}</div><div class="diff-body">`;
    for (const line of f.lines) {
      if (line.startsWith('@@')) html += `<div class="diff-line hunk">${escapeHtml(line)}</div>`;
      else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename')) {
        html += `<div class="diff-line meta">${escapeHtml(line)}</div>`;
      } else if (line.startsWith('+')) html += `<div class="diff-line add">${escapeHtml(line)}</div>`;
      else if (line.startsWith('-')) html += `<div class="diff-line del">${escapeHtml(line)}</div>`;
      else html += `<div class="diff-line ctx">${escapeHtml(line)}</div>`;
    }
    html += '</div></div>';
  }
  if (truncated) html += '<div class="list-empty">改动过大，仅显示前 400KB 内容</div>';
  return html;
}

/* -------------------------- 冲突解决 -------------------------- */

function parseConflictBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let pos = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('<<<<<<<')) {
      const start = pos;
      let j = i + 1;
      const ours = [];
      const base = [];
      const theirs = [];
      while (j < lines.length && !lines[j].startsWith('|||||||') && !lines[j].startsWith('=======')) {
        ours.push(lines[j]); j++;
      }
      if (j < lines.length && lines[j].startsWith('|||||||')) {
        j++;
        while (j < lines.length && !lines[j].startsWith('=======')) { base.push(lines[j]); j++; }
      }
      if (j < lines.length && lines[j].startsWith('=======')) {
        j++;
        while (j < lines.length && !lines[j].startsWith('>>>>>>>')) { theirs.push(lines[j]); j++; }
      }
      let theirsLabel = '';
      if (j < lines.length && lines[j].startsWith('>>>>>>>')) theirsLabel = lines[j].slice(7).trim();
      let end = pos;
      for (let k = i; k <= Math.min(j, lines.length - 1); k++) end += lines[k].length + 1;
      end = Math.min(end, text.length);
      const hasTrailingNewline = text[end - 1] === '\n';
      blocks.push({
        start, end, ours, base, theirs,
        oursLabel: line.slice(7).trim(),
        theirsLabel,
        hasTrailingNewline
      });
      pos = end;
      i = j + 1;
      continue;
    }
    pos += line.length + 1;
    i++;
  }
  return blocks;
}

function renderMergePanes() {
  const m = state.merge.current;
  if (!m) return;
  const text = $('#mrText').value;
  const blocks = parseConflictBlocks(text);
  m.blocks = blocks;

  const buildSide = (sideKey) => {
    let html = '';
    let ln = 1;
    let pos = 0;
    const push = (str, cls, blockIdx) => {
      const rows = str.split('\n');
      // 末尾空行不计入
      if (rows.length && rows[rows.length - 1] === '') rows.pop();
      rows.forEach((row) => {
        html += `<div class="mline ${cls}${blockIdx != null ? ' current' : ''}"${blockIdx != null ? ` data-block="${blockIdx}"` : ''}>` +
          `<span class="ln">${ln++}</span><span class="tx">${escapeHtml(row) === '' ? '&nbsp;' : escapeHtml(row)}</span></div>`;
      });
    };

    const ordered = [];
    blocks.forEach((b, idx) => ordered.push({ t: 'b', idx, b }));
    // 逐个块切分上下文
    let cursor = 0;
    const seq = [];
    blocks.forEach((b, idx) => {
      if (b.start > cursor) seq.push({ t: 'ctx', text: text.slice(cursor, b.start) });
      seq.push({ t: 'conf', idx, b });
      cursor = b.end;
    });
    if (cursor < text.length) seq.push({ t: 'ctx', text: text.slice(cursor) });

    seq.forEach((item) => {
      if (item.t === 'ctx') {
        push(item.text, 'ctx', null);
      } else {
        const lines = sideKey === 'ours' ? item.b.theirs.length : item.b.ours.length;
        const mine = sideKey === 'ours' ? item.b.ours : item.b.theirs;
        push(mine.join('\n'), sideKey, item.idx);
        const otherLen = sideKey === 'ours' ? item.b.theirs.length : item.b.ours.length;
        if (otherLen > mine.length) {
          html += `<div class="mline gap"><span class="ln"></span><span class="tx">对方此处在 ${otherLen} 行，本侧 ${mine.length} 行</span></div>`;
        }
      }
    });
    return html;
  };

  $('#oursBody').innerHTML = buildSide('ours');
  $('#theirsBody').innerHTML = buildSide('theirs');

  const status = $('#mrStatus');
  const resolvedCount = blocks.filter((b) => b.resolved).length;
  if (blocks.length) {
    status.textContent = `还有 ${blocks.length} 处冲突未解决`;
    status.className = 'mr-status';
  } else {
    status.textContent = '所有冲突标记已清除，可以保存';
    status.className = 'mr-status done';
  }
  $('#mfContinue').disabled = blocks.length > 0;
  $('#mfUseOurs').disabled = !blocks.length;
  $('#mfUseTheirs').disabled = !blocks.length;
  $('#mfUseBoth').disabled = !blocks.length;
  $('#mfPrev').disabled = !blocks.length;
  $('#mfNext').disabled = !blocks.length;
  updateMergeNav(false);
}

function mergeBlockIndex() {
  const m = state.merge.current;
  if (!m) return -1;
  const blocks = m.blocks || [];
  if (!blocks.length) return -1;
  if (m.blockIndex == null || m.blockIndex >= blocks.length) m.blockIndex = 0;
  return m.blockIndex;
}

function updateMergeNav(scroll = true) {
  const m = state.merge.current;
  if (!m) return;
  const idx = mergeBlockIndex();
  $$('.mline.current').forEach((el) => el.classList.remove('current'));
  if (idx >= 0) {
    $$(`.mline[data-block="${idx}"]`).forEach((el) => el.classList.add('current'));
    if (scroll) {
      const first = $(`.mline[data-block="${idx}"]`);
      if (first) {
        first.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const twin = $$('.mpane')[1].querySelector(`.mline[data-block="${idx}"]`);
        if (twin) twin.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }
  $('#mergeSubTitle').textContent = m.blocks && m.blocks.length
    ? `${m.relPath} · 第 ${idx + 1}/${m.blocks.length} 处冲突`
    : `${m.relPath} · 无冲突标记`;
}

function resolveCurrentBlock(mode) {
  const m = state.merge.current;
  if (!m) return;
  const blocks = m.blocks || [];
  const idx = mergeBlockIndex();
  if (idx < 0) return;
  const b = blocks[idx];
  const ta = $('#mrText');
  const nl = b.hasTrailingNewline ? '\n' : '';
  let repl = '';
  if (mode === 'ours') repl = b.ours.length ? b.ours.join('\n') + nl : '';
  else if (mode === 'theirs') repl = b.theirs.length ? b.theirs.join('\n') + nl : '';
  else {
    const both = [...b.ours, ...b.theirs];
    repl = both.length ? both.join('\n') + nl : '';
  }
  const text = ta.value;
  ta.value = text.slice(0, b.start) + repl + text.slice(b.end);
  const nextBlocks = parseConflictBlocks(ta.value);
  m.blocks = nextBlocks;
  m.blockIndex = Math.min(idx, Math.max(0, nextBlocks.length - 1));
  renderMergePanes();
  m.dirty = true;
}

async function openMergeView(files, targetBranch, operation) {
  state.merge.active = true;
  state.merge.dir = state.dir;
  const targetOk = targetBranch && targetBranch !== 'HEAD';
  state.merge.target = targetOk
    ? targetBranch
    : ((state.info && state.info.rebaseBranch) || (state.panes.right && state.panes.right.branch) || '远端');
  state.merge.operation = operation || (state.info && state.info.operation) || 'cherry-pick';
  state.merge.resolved = new Set();
  state.merge.files = files.slice();
  state.merge.allFiles = files.slice();
  $('#mergeSubTitle').textContent = '';
  $('#mergeView').classList.remove('hidden');

  const isRebase = state.merge.operation === 'rebase';
  const isStash = state.merge.operation === 'stash';
  $('#mergeTitle').textContent = state.merge.fixQueue && state.merge.fixBranch
    ? '解决冲突 · ' + state.merge.fixBranch
    : (isStash ? '解决改动恢复冲突' : (isRebase ? '解决变基冲突' : '解决摘取冲突'));
  $('#oursName').textContent = isRebase ? `远端最新（${state.merge.target}）` : `当前分支（${state.merge.target}）`;
  $('#theirsName').textContent = isStash ? '你暂存的改动' : (isRebase ? '你的本地提交' : '被摘取的提交');
  $('#mfContinue').textContent = isStash ? '全部完成，恢复改动' : (isRebase ? '全部完成，继续变基' : '全部完成，继续摘取');
  $('#mfAbort').textContent = isStash ? '放弃恢复（保留 stash）' : (isRebase ? '中止变基' : '中止摘取');
  $('#mfSkip').classList.toggle('hidden', isStash);
  $('#mfList').innerHTML = '';
  const st = await api.conflicts(state.dir);
  if (st && st.ok) {
    state.merge.others = st.others || [];
    if (st.files && st.files.length && !state.merge.files.length) {
      state.merge.files = st.files;
      state.merge.allFiles = st.files.slice();
    }
    $('#mfOther').innerHTML = state.merge.others.length
      ? '其他变更：<br />' + state.merge.others.slice(0, 30).map((o) =>
          `<span style="font-family:Consolas,monospace">${escapeHtml(o.code)} ${escapeHtml(o.path)}</span>`).join('<br />')
      : '';
  }
  renderMergeFileList();
  if (state.merge.files.length) await loadMergeFile(state.merge.files[0]);
  else {
    state.merge.current = null;
    $('#mrText').value = '';
    $('#oursBody').innerHTML = '<div class="list-empty">没有待解决的冲突文件</div>';
    $('#theirsBody').innerHTML = '';
  }
}

function renderMergeFileList() {
  const list = $('#mfList');
  const all = (state.merge.allFiles && state.merge.allFiles.length) ? state.merge.allFiles : state.merge.files;
  list.innerHTML = all.map((f) => {
    const done = state.merge.resolved.has(f);
    const active = state.merge.current && state.merge.current.relPath === f ? ' active' : '';
    return `<div class="mf-item${active} ${done ? 'resolved' : 'pending'}" data-path="${escapeHtml(f)}">
      <span class="state">${done ? '✓' : '●'}</span><span class="fname">${escapeHtml(f)}</span>
    </div>`;
  }).join('');
  const remain = all.filter((f) => !state.merge.resolved.has(f)).length;
  $('#mfFileCount').textContent = all.length ? `(${all.length - remain}/${all.length} 已解决)` : '';
  list.querySelectorAll('.mf-item').forEach((el) => {
    el.addEventListener('click', () => loadMergeFile(el.dataset.path));
  });
}

async function loadMergeFile(relPath) {
  // 加载期间先禁用所有动作，避免对空内容操作
  ['#mfSave', '#mfContinue', '#mfPrev', '#mfNext', '#mfUseOurs', '#mfUseTheirs', '#mfUseBoth'].forEach((s) => { $(s).disabled = true; });
  const res = await api.readConflict(state.dir, relPath);
  if (!res || !res.ok) {
    toast((res && res.error) || '读取冲突文件失败', 'err');
    return;
  }
  const hasCRLF = !res.binary && res.content.includes('\r\n');
  const text = res.binary ? '' : (hasCRLF ? res.content.replace(/\r\n/g, '\n') : res.content);
  state.merge.current = {
    relPath,
    absPath: res.absPath,
    eol: hasCRLF ? '\r\n' : '\n',
    binary: !!res.binary,
    blockIndex: 0,
    blocks: [],
    dirty: false
  };

  if (res.binary) {
    $('#mrText').classList.add('hidden');
    $('#mrBinary').classList.remove('hidden');
    $('#mrText').value = '';
    $('#oursBody').innerHTML = '<div class="list-empty">二进制文件<br />无法预览内容</div>';
    $('#theirsBody').innerHTML = '<div class="list-empty">二进制文件<br />无法预览内容</div>';
    $('#mrStatus').textContent = '二进制冲突：请选择保留哪一侧';
    $('#mrStatus').className = 'mr-status';
    renderMergeFileList();
    $('#mergeSubTitle').textContent = `${relPath} · 二进制冲突`;
    ['#mfPrev', '#mfNext', '#mfUseOurs', '#mfUseTheirs', '#mfUseBoth', '#mfSave'].forEach((s) => { $(s).disabled = true; });
    $('#mfContinue').disabled = true;
    return;
  }

  $('#mrBinary').classList.add('hidden');
  $('#mrText').classList.remove('hidden');
  $('#mrText').value = text;
  renderMergePanes();
  renderMergeFileList();
  $('#mfSave').disabled = state.merge.resolved.has(relPath);
}

async function resolveBinaryConflict(side) {
  const m = state.merge.current;
  if (!m || !m.binary) return;
  const res = await api.resolveBinary({ dir: state.dir, relPath: m.relPath, side });
  if (!res || !res.ok) {
    toast((res && res.error) || '解决二进制冲突失败', 'err');
    return;
  }
  state.merge.resolved.add(m.relPath);
  state.merge.files = (res.remaining || []).slice();
  toast('已采用' + (side === 'ours' ? '左侧' : '右侧') + '版本：' + m.relPath, 'ok');
  renderMergeFileList();
  if (state.merge.files.length) {
    await loadMergeFile(state.merge.files[0]);
  } else {
    finishAllConflicts();
  }
}

function finishAllConflicts() {
  state.merge.current = null;
  const isRebase = state.merge.operation === 'rebase';
  $('#mrBinary').classList.add('hidden');
  $('#mrText').classList.remove('hidden');
  $('#mrText').value = '';
  $('#oursBody').innerHTML = `<div class="list-empty">所有冲突文件都已解决<br />点击「${isRebase ? '全部完成，继续变基' : '全部完成，继续摘取'}」</div>`;
  $('#theirsBody').innerHTML = '';
  $('#mfList').innerHTML = '<div class="mf-other">全部解决完毕</div>';
  $('#mrStatus').textContent = '';
  $('#mfSave').disabled = true;
  $('#mfContinue').disabled = false;
  $('#mfContinue').focus();
}

async function saveCurrentConflictFile() {
  const m = state.merge.current;
  if (!m) return;
  if (m.binary) {
    toast('二进制文件请使用上方按钮选择一侧版本', 'warn');
    return;
  }
  // 用过外部工具的话，磁盘上的文件才是最新版：先从磁盘重读，避免编辑器旧内容覆盖外部修改
  if (m.externalEdited) {
    const rd = await api.readConflict(state.dir, m.relPath);
    if (rd && rd.ok) {
      $('#mrText').value = rd.content.replace(/\r\n/g, '\n');
    }
    m.externalEdited = false;
  }
  const text = $('#mrText').value;
  const blocks = parseConflictBlocks(text);
  if (blocks.length) {
    toast(`还有 ${blocks.length} 处冲突未处理，不能标记为已解决`, 'warn');
    m.blocks = blocks;
    m.blockIndex = 0;
    renderMergePanes();
    return;
  }
  const content = m.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
  const res = await api.saveConflict({ dir: state.dir, relPath: m.relPath, content });
  if (!res || !res.ok) {
    toast((res && res.error) || '保存失败', 'err');
    return;
  }
  state.merge.resolved.add(m.relPath);
  state.merge.files = (res.remaining || []).slice();
  toast('已标记为已解决：' + m.relPath, 'ok');
  renderMergeFileList();
  renderMergePanes();
  if (state.merge.files.length) {
    await loadMergeFile(state.merge.files[0]);
  } else {
    finishAllConflicts();
  }
}

async function continuePick() {
  if (!state.merge.active) return;
  const st = await api.conflicts(state.dir);
  const remaining = (st && st.ok && st.files) || [];
  if (remaining.length) {
    toast(`还有 ${remaining.length} 个冲突文件未解决`, 'warn');
    state.merge.files = remaining;
    renderMergeFileList();
    return;
  }
  // 恢复暂存改动导致的冲突：解决完 add 之后丢掉这条 stash 记录即可
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
  setBusy(true, isRebase ? '正在继续变基…' : '正在继续摘取…');
  const res = await api.continueCherryPick(state.dir);
  logResult(res);
  if (res.ok) {
    const needPush = state.merge.pendingPush;
    const pushSide = state.merge.pushSide;
    const needStash = state.merge.pendingStash;
    closeMergeView();
    toast(isRebase ? '变基已完成' : '摘取已完成', 'ok');
    if (needStash) await restoreStash();
    await refreshAll();

    // 批量页：单个分支的冲突解决完了，记结果 → 推送 → 继续下一个分支
    if (state.merge.fixQueue) {
      const br = state.merge.fixBranch;
      const item = state.merge.fixItem;
      state.merge.fixQueue = false;
      state.merge.fixBranch = '';
      state.merge.fixItem = null;
      fixState.results.push({ branch: br, state: 'picked', count: item ? item.commits.length : 0, message: '（解决冲突后继续）' });
      renderFixResult();
      if (fixState.mode === 'pickPush' && br) await fixPush(br);
      await fixStep();
      return;
    }

    if (needPush && pushSide) await performPush(pushSide, { skipConfirm: true, autoRebase: true });
    return;
  }
  setBusy(false);
  if (res.operation) state.merge.operation = res.operation;
  if (res.conflict) {
    state.merge.files = res.files || [];
    renderMergeFileList();
    if (state.merge.files.length) await loadMergeFile(state.merge.files[0]);
    toast('继续时又出现冲突，请继续解决', 'warn');
    return;
  }
  if (res.empty) {
    const goSkip = await modalConfirm(
      '这一步解决后为空',
      '解决冲突后，这一步没有产生任何改动，Git 无法生成空提交。<br />建议跳过它，继续后面的内容。',
      '跳过这一步'
    );
    if (goSkip) await skipPick(true);
    return;
  }
  toast(res.error || '继续失败', 'err');
}

function closeMergeView() {
  state.merge.active = false;
  state.merge.current = null;
  state.merge.files = [];
  state.merge.pendingPush = false;
  state.merge.pendingStash = false;
  state.merge.pushSide = '';
  $('#mergeView').classList.add('hidden');
}

async function abortPick() {
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

  const label = state.merge.operation === 'rebase' ? '变基' : '摘取';
  const ok = await modalConfirm(
    '中止' + label,
    `将回滚本次${label}的全部改动，回到操作前的状态。<br />确定中止吗？`,
    '中止并回滚',
    true
  );
  if (!ok) return;
  setBusy(true, '正在回滚…');
  const res = await api.abortCherryPick(state.dir);
  setBusy(false);
  if (!res.ok) { toast(res.error || '中止失败', 'err'); return; }
  const needStash = state.merge.pendingStash;
  closeMergeView();
  if (needStash) await restoreStash();
  await refreshAll();
  toast('已中止' + label, 'ok');

  if (state.merge.fixQueue) {
    const br = state.merge.fixBranch;
    state.merge.fixQueue = false;
    state.merge.fixBranch = '';
    state.merge.fixItem = null;
    fixState.queue = [];
    fixState.results.push({ branch: br || '', state: 'aborted', count: 0, message: '已中止，剩余分支未执行' });
    renderFixResult();
    await finishFix();
  }
}

async function skipPick(silent) {
  if (!silent) {
    const ok = await modalConfirm('跳过此提交', '跳过当前有冲突的提交，继续摘取后续提交。该提交的改动不会进入目标分支。', '跳过', true);
    if (!ok) return;
  }
  setBusy(true, '正在跳过…');
  const res = await api.skipCherryPick(state.dir);
  setBusy(false);
  if (res.ok) {
    closeMergeView();
    await refreshAll();
    toast('已跳过当前提交', 'ok');
    return;
  }
  if (res.conflict) {
    state.merge.files = res.files || [];
    renderMergeFileList();
    if (state.merge.files.length) await loadMergeFile(state.merge.files[0]);
    toast('后续提交仍有冲突，请继续解决', 'warn');
    return;
  }
  toast(res.error || '跳过失败', 'err');
}

/* -------------------------- 最近仓库 / 设置 -------------------------- */

let ctxMenuEl = null;
function showContextMenu(x, y, items) {
  closeContextMenu();
  const el = document.createElement('div');
  el.className = 'context-menu';
  items.forEach((it) => {
    if (it.sep) { el.appendChild(Object.assign(document.createElement('div'), { className: 'cm-sep' })); return; }
    const d = document.createElement('div');
    d.className = 'cm-item';
    d.textContent = it.label;
    d.addEventListener('click', () => { closeContextMenu(); it.act(); });
    el.appendChild(d);
  });
  document.body.appendChild(el);
  const rect = el.getBoundingClientRect();
  el.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  el.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  ctxMenuEl = el;
  setTimeout(() => document.addEventListener('mousedown', onDocDown), 0);
}
function onDocDown(e) {
  if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeContextMenu();
}
function closeContextMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
  document.removeEventListener('mousedown', onDocDown);
}

function showRecentMenu(anchor) {
  const repos = state.config.repos || [];
  const rect = anchor.getBoundingClientRect();
  const items = repos.length
    ? repos.map((r) => ({ label: r, act: () => openRepo(r) }))
    : [{ label: '暂无历史记录', act: () => {} }];
  items.push({ sep: true });
  items.push({
    label: '清除历史记录',
    act: async () => { state.config = (await api.setConfig({ repos: [] })).config; toast('已清除历史', 'ok'); }
  });
  showContextMenu(rect.left, rect.bottom + 3, items);
}

function openSettings() {
  $('#setMergeTool').value = state.config.mergeTool || '';
  $('#setPageSize').value = state.config.pageSize || 200;
  $('#setPullMode').value = state.config.pullMode || 'rebase';
  $('#settingsModal').classList.remove('hidden');
}

/* -------------------------- 合并检查 -------------------------- */

const checkState = {
  last: null,
  loading: false,
  ranOnce: false
};

function currentTab() {
  return state.tab || 'merge';
}

function switchTab(name) {
  state.tab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  // 左栏是同一个 DOM 节点，按页签搬到对应容器里，选择状态/筛选条件都保持
  if (name === 'fix') {
    const host = $('#fixPaneHost');
    if (host && state.panes.left && state.panes.left.el.parentElement !== host) host.appendChild(state.panes.left.el);
  } else {
    restoreLeftPane();
  }
  $('#viewMerge').classList.toggle('hidden', name !== 'merge');
  $('#viewCheck').classList.toggle('hidden', name !== 'check');
  $('#viewFix').classList.toggle('hidden', name !== 'fix');
  if (name === 'check') initCheckView();
  if (name === 'fix') initFixView();
  if (name === 'fix' || name === 'merge') refreshFlags();
  updateFixButtons();
}

function timeLabelOf(v) {
  const map = {
    '7': '最近 7 天', '30': '最近 30 天', '90': '最近 90 天',
    '180': '最近半年', '365': '最近一年', all: '全部时间', custom: '自定义区间'
  };
  return map[v] || v;
}

function rangeFromPreset(v) {
  if (v === 'all') return {};
  if (v === 'custom') {
    const from = $('#ckFrom').value ? $('#ckFrom').value + 'T00:00:00' : '';
    const to = $('#ckTo').value ? $('#ckTo').value + 'T23:59:59' : '';
    return { since: from, until: to };
  }
  const days = parseInt(v, 10) || 30;
  return { since: fmtLocal(new Date(Date.now() - days * 864e5)) };
}

function fillBranchSelect(sel, keepValue) {
  const locals = state.branches.filter((b) => !b.isRemote);
  const remotes = state.branches.filter((b) => b.isRemote);
  let html = '<optgroup label="本地分支">' + locals.map((b) =>
    `<option value="${escapeHtml(b.name)}">${escapeHtml(b.name)}${b.current ? ' (当前)' : ''}</option>`).join('') + '</optgroup>';
  if (remotes.length) {
    html += '<optgroup label="远端分支">' + remotes.map((b) =>
      `<option value="${escapeHtml(b.name)}">${escapeHtml(b.name)}</option>`).join('') + '</optgroup>';
  }
  sel.innerHTML = html;
  if (keepValue && state.branches.some((b) => b.name === keepValue)) sel.value = keepValue;
}

async function initCheckView() {
  if (!state.dir) {
    $('#ckSummary').textContent = '请先在顶部选择一个 git 仓库';
    return;
  }
  const srcSel = $('#ckSource');
  const dstSel = $('#ckTarget');
  if (!checkState.inited && state.config.checkTime) {
    $('#ckTime').value = state.config.checkTime;
  }
  checkState.inited = true;
  $('#ckCustomRange').classList.toggle('hidden', $('#ckTime').value !== 'custom');

  fillBranchSelect(srcSel, state.config.checkSource || (state.panes.left && state.panes.left.branch));
  fillBranchSelect(dstSel, state.config.checkTarget || (state.panes.right && state.panes.right.branch));

  if ($('#ckTime').value === 'custom' && !$('#ckFrom').value) {
    const d = new Date(Date.now() - 30 * 864e5);
    $('#ckFrom').value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const n = new Date();
    $('#ckTo').value = `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
  }

  await loadCheckAuthors();
  // 不在切 Tab 时自动检测：大仓库上比对耗时，只有点「开始检测」才跑。
  if (!checkState.ranOnce) {
    $('#ckSummary').textContent = '选择分支和检测人后点「开始检测」';
  }
}

async function loadCheckAuthors() {
  const src = $('#ckSource').value;
  if (!src || !state.dir) return;
  const { since, until } = rangeFromPreset($('#ckTime').value);
  const res = await api.authors({ dir: state.dir, ref: src, since, until });
  const sel = $('#ckAuthor');
  // 只有第一次进来时才用配置/当前用户做默认值；
  // 之后（含切 Tab 回来）必须保留用户的选择，包括「全部人」。
  const first = !checkState.authorsLoaded;
  const prev = sel.value;
  const want = first ? (state.config.checkAuthor || '') : prev;
  let html = '<option value="">全部人</option>';
  if (res && res.ok) {
    html += res.authors.map((a) =>
      `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}（${a.count}）</option>`).join('');
  }
  sel.innerHTML = html;

  // 默认值固定为「全部人」；仅恢复用户上次自己选过的值（存在配置里）。
  // 不默认成 git config user.name——检测通常是为了看别人的提交有没有合进来。
  if (!first) sel.value = want;
  else if (want && (res.authors || []).some((a) => a.name === want)) sel.value = want;
  else sel.value = '';
  checkState.authorsLoaded = true;
}

function markCheckDirty() {
  if (checkState.ranOnce && !checkState.loading) $('#ckDirty').classList.remove('hidden');
}

async function runCheck() {
  if (!state.dir) {
    $('#ckSummary').textContent = '请先在顶部选择一个 git 仓库';
    return;
  }
  const source = $('#ckSource').value;
  const target = $('#ckTarget').value;
  const author = $('#ckAuthor').value;
  const timeVal = $('#ckTime').value;
  const { since, until } = rangeFromPreset(timeVal);

  if (!source || !target) {
    $('#ckSummary').textContent = '请选择源分支和目标分支';
    return;
  }
  if (source === target) {
    $('#ckSummary').innerHTML = '<span class="num-bad">源分支和目标分支不能相同</span>';
    $('#ckList').innerHTML = '';
    return;
  }

  checkState.loading = true;
  checkState.ranOnce = true;
  $('#ckDirty').classList.add('hidden');
  $('#ckRun').disabled = true;
  $('#ckSummary').innerHTML = '<span class="spinner" style="display:inline-block;vertical-align:-2px"></span> 正在检测…';
  $('#ckList').innerHTML = '';

  const res = await api.checkMerged({ dir: state.dir, source, target, author, since, until });
  checkState.loading = false;
  $('#ckRun').disabled = false;

  if (!res || !res.ok) {
    $('#ckSummary').innerHTML = `<span class="num-bad">检测失败：</span>${escapeHtml((res && res.error) || '未知错误')}`;
    return;
  }

  state.config = (await api.setConfig({
    checkSource: source, checkTarget: target, checkAuthor: author, checkTime: timeVal
  })).config || state.config;

  checkState.last = res;
  renderCheckSummary(res, timeVal);
  renderCheckList();
}

function renderCheckSummary(res, timeVal) {
  const who = res.author ? escapeHtml(res.author) : '全部人';
  const timeTxt = timeVal === 'custom'
    ? `${$('#ckFrom').value || '不限'} ~ ${$('#ckTo').value || '不限'}`
    : timeLabelOf(timeVal);
  // 未合并 = 一定没合并的；需确认 = merge-tree 冲突、无法自动判定的（不算进未合并，避免重复计数）
  const maybe = res.maybeCount || 0;
  const bad = Math.max(0, res.unmergedCount - maybe);
  const parts = [];
  if (bad > 0) parts.push(`<span class="num-bad">${bad} 个未合并</span>`);
  if (maybe > 0) parts.push(`<span class="num-warn">${maybe} 个需人工确认</span>`);
  const okPart = parts.length ? parts.join('、') : `<span class="num-ok">全部已合并</span>`;
  $('#ckSummary').innerHTML =
    `<b>${who}</b> · ${escapeHtml(timeTxt)} · <span class="ck-sub">` +
    `源 <b>${escapeHtml(res.source)}</b> → 目标 <b>${escapeHtml(res.target)}</b></span><br />` +
    `共 <b>${res.total}</b> 个提交，${okPart}（已合并 ${res.mergedCount} 个` +
    (res.squashCount ? `，其中 <b>${res.squashCount}</b> 个为 squash 合并` : '') + '）' +
    (res.total === 0 ? '<br /><span class="ck-sub">该时间范围内没有这个人的提交，换个时间范围或检测人试试</span>' : '');
}

function renderCheckList() {
  const res = checkState.last;
  const list = $('#ckList');
  if (!res) { list.innerHTML = ''; return; }
  const onlyUnmerged = $('#ckOnlyUnmerged').checked;
  const rows = res.commits.filter((c) => (onlyUnmerged ? !c.merged : true));

  if (!rows.length) {
    list.innerHTML = `<div class="list-empty">${onlyUnmerged
      ? (res.total === 0 ? '没有可检测的提交' : '这个人的提交都已经合并到目标分支了')
      : '没有提交'}</div>`;
    return;
  }

  list.innerHTML = rows.map((c) => `
    <div class="ck-row" data-hash="${c.hash}" title="${escapeHtml(c.subject)}">
      <span class="col-hash">${escapeHtml(c.short)}</span>
      <span class="col-msg"><span class="text">${escapeHtml(c.subject)}</span></span>
      <span class="col-author" title="${escapeHtml(c.email)}">${escapeHtml(c.author)}</span>
      <span class="col-date" title="${escapeHtml(c.date)}">${fmtDateShort(c.timestamp)}</span>
      <span class="col-state">
        <span class="badge ${c.merged ? (c.mergeKind === 'patch' ? 'merged' : 'merged squash') : (c.maybe ? 'maybe' : 'unmerged')}" title="${
          c.merged ? (c.mergeKind === 'patch' ? '目标分支存在等价补丁（patch-id）' : (c.mergeKind === 'deep' ? '三方合并无残留，改动已在目标分支（merge-tree 判定）' : '目标分支文件内容已一致（squash 判定）'))
          : (c.maybe ? '目标分支上同一处被后续改过，无法自动判定，建议人工看一眼' : '目标分支没有这段改动')
        }">${c.merged ? (c.mergeKind === 'patch' ? '已合并' : '已合并·squash') : (c.maybe ? '可能已合并' : '未合并')}</span>
      </span>
    </div>`).join('');

  list.querySelectorAll('.ck-row').forEach((el) => {
    el.addEventListener('dblclick', () => openDetail(el.dataset.hash));
  });
}

/* -------------------------- 代码修复快速合并 -------------------------- */

const fixState = {
  dir: '',
  branches: [],
  selected: new Set(),
  filter: '',
  running: false,
  mode: 'pick',
  queue: [],
  results: [],
  current: ''
};

const leftHome = { parent: null, next: null };

/** 记住左栏 DOM 原来在 快速合并 页里的位置，切回来时放回原处 */
function rememberLeftHome() {
  const el = state.panes.left && state.panes.left.el;
  if (!el || !el.parentElement || el.parentElement.id === 'fixPaneHost') return;
  leftHome.parent = el.parentElement;
  leftHome.next = el.nextElementSibling;
}

function restoreLeftPane() {
  const el = state.panes.left && state.panes.left.el;
  if (!el || !leftHome.parent) return;
  if (el.parentElement !== leftHome.parent) leftHome.parent.insertBefore(el, leftHome.next);
}

async function initFixView() {
  if (!state.dir) {
    fixState.branches = [];
    renderFixList();
    updateFixButtons();
    return;
  }
  if (fixState.dir !== state.dir) {
    fixState.dir = state.dir;
    fixState.selected = new Set();
    fixState.results = [];
    renderFixResult();
  }
  const res = await api.branches(state.dir);
  if (!res || !res.ok) {
    toast((res && res.error) || '读取分支失败', 'err');
    return;
  }
  fixState.branches = (res.locals || res.local || res.branches || [])
    .filter((b) => !b.isRemote)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
  const names = new Set(fixState.branches.map((b) => b.name));
  const srcName = (state.panes.left && state.panes.left.branch) || '';
  if (srcName) fixState.selected.delete(srcName);
  for (const n of [...fixState.selected]) if (!names.has(n)) fixState.selected.delete(n);
  renderFixList();
  updateFixButtons();
}

function renderFixList() {
  const list = $('#fixBranchList');
  if (!list) return;
  if (!state.dir) { list.innerHTML = '<div class="fix-empty">请先在顶部选择仓库</div>'; return; }
  if (!fixState.branches.length) { list.innerHTML = '<div class="fix-empty">没有本地分支</div>'; return; }
  const kw = fixState.filter.trim().toLowerCase();
  const rows = fixState.branches.filter((b) => !kw || String(b.name).toLowerCase().includes(kw));
  if (!rows.length) { list.innerHTML = '<div class="fix-empty">没有匹配的分支</div>'; return; }

  const srcName = (state.panes.left && state.panes.left.branch) || '';
  list.innerHTML = rows.map((b) => {
    const isSrc = !!srcName && b.name === srcName;
    const on = !isSrc && fixState.selected.has(b.name);
    return '<div class="fix-row' + (on ? ' checked' : '') + (isSrc ? ' disabled' : '') + '" data-branch="' + escapeHtml(b.name) + '" data-src="' + (isSrc ? '1' : '0') + '">' +
      (isSrc ? '<input type="checkbox" disabled tabindex="-1" />' : '<input type="checkbox" ' + (on ? 'checked' : '') + ' tabindex="-1" />') +
      '<span class="fix-name" title="' + escapeHtml(b.name) + '">' + escapeHtml(b.name) + '</span>' +
      (isSrc ? '<span class="badge">源分支</span>' : (b.current ? '<span class="badge head">当前</span>' : '')) +
      (b.upstream ? '<span class="fix-up">' + escapeHtml(b.upstream) + '</span>' : '') +
      '</div>';
  }).join('');

  list.querySelectorAll('.fix-row').forEach((row) => {
    row.addEventListener('click', () => {
      if (row.dataset.src === '1') { toast('这里是源分支，不能再摘取回自身', 'warn'); return; }
      const name = row.dataset.branch;
      if (fixState.selected.has(name)) fixState.selected.delete(name);
      else fixState.selected.add(name);
      renderFixList();
      updateFixButtons();
    });
  });
}

function updateFixButtons() {
  const btn = $('#btnFixPick');
  const btnPush = $('#btnFixPickPush');
  if (!btn || !btnPush) return;
  const n = state.panes.left ? state.panes.left.selected.size : 0;
  const m = fixState.selected.size;
  const disabled = !n || !m || state.busy || fixState.running;
  btn.disabled = disabled;
  btnPush.disabled = disabled;
  $('.xfer-count', btn).textContent = String(n || 0);
  $('.xfer-count', btnPush).textContent = String(n || 0);
  const sel = $('#fixSelCount');
  if (sel) sel.textContent = m ? '已选 ' + m + ' 个分支' : '未选择分支';
  const tip = $('#fixTip');
  if (tip) {
    if (!n) tip.textContent = '先在左侧勾选要摘取的提交';
    else if (!m) tip.textContent = '再在右侧勾选目标分支';
    else tip.textContent = '将把 ' + n + ' 个提交摘取到 ' + m + ' 个分支';
  }
  btn.title = disabled ? '先勾选左侧提交和右侧分支' : '把 ' + n + ' 个提交摘取到 ' + m + ' 个分支';
  btnPush.title = btn.title + '，每个分支成功后立即推送';
}

function fixResultLabel(r) {
  const map = {
    picked: '已摘取', pushed: '已摘取并推送', empty: '无需摘取（改动已存在）',
    skipped: '已合并，跳过', error: '失败', aborted: '已中止',
    pushFail: '推送失败'
  };
  return map[r.state] || r.state;
}

function renderFixResult() {
  const box = $('#fixResult');
  if (!box) return;
  if (!fixState.results.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="fix-result-title">执行结果</div>' + fixState.results.map((r) => {
    const cls = (r.state === 'picked' || r.state === 'pushed' || r.state === 'skipped' || r.state === 'empty')
      ? 'ok' : (r.state === 'aborted' ? 'warn' : 'bad');
    const msg = r.message ? String(r.message).split(/\r?\n/)[0].slice(0, 70) : '';
    return '<div class="fix-result-row ' + cls + '">' +
      '<span class="fix-res-branch" title="' + escapeHtml(r.branch) + '">' + escapeHtml(r.branch) + '</span>' +
      '<span class="fix-res-state">' + escapeHtml(fixResultLabel(r)) + (r.count ? ' · ' + r.count + ' 条' : '') + '</span>' +
      (msg ? '<span class="fix-res-msg" title="' + escapeHtml(msg) + '">' + escapeHtml(msg) + '</span>' : '') +
      '</div>';
  }).join('');
}

async function startFixMerge(mode) {
  const src = state.panes.left;
  if (!src || !state.dir) { toast('请先选择仓库', 'warn'); return; }
  const commits = src.selectedCommits || [];
  if (!commits.length) { toast('请先在左侧勾选要摘取的提交', 'warn'); return; }
  const srcName = src.branch || '';
  const targets = fixState.branches.filter((b) => fixState.selected.has(b.name) && b.name !== srcName).map((b) => b.name);
  if (!targets.length) { toast('请先在右侧勾选至少一个分支', 'warn'); return; }

  const shas = commits.map((c) => c.hash);
  const bounds = src.timeBounds ? src.timeBounds() : {};

  setBusy(true, '正在检查各分支是否已包含这些提交…');
  const plan = [];
  for (const branch of targets) {
    const r = await api.patchFlags({
      dir: state.dir, source: src.branch, target: branch,
      since: bounds.since || '', until: bounds.until || '', only: shas
    });
    const merged = (r && r.ok) ? (r.map || {}) : {};
    plan.push({
      branch,
      commits: commits.filter((c) => !merged[c.hash]),
      skipped: commits.filter((c) => merged[c.hash]).length
    });
  }
  setBusy(false);

  const usable = plan.filter((p) => p.commits.length);
  if (!usable.length) {
    toast('所选提交在勾选的分支上都已经合并过了，无需摘取', 'warn');
    return;
  }

  const withPush = mode === 'pickPush';
  let body = '从 <b>' + escapeHtml(src.branch) + '</b> 摘取 <b>' + commits.length + '</b> 个提交，目标分支：' +
    '<div class="hint" style="margin:6px 0;max-height:170px;overflow:auto;font-family:Consolas,monospace">' +
    plan.map((p) => p.commits.length
      ? escapeHtml(p.branch) + ' ← ' + p.commits.map((c) => c.short).join(' ')
      : escapeHtml(p.branch) + ' ← <span style="color:#8a5606">已合并，跳过</span>').join('<br />') + '</div>';
  const skippedTotal = plan.reduce((s, p) => s + p.skipped, 0);
  if (skippedTotal) {
    body += '<div style="color:#8a5606;margin-top:6px">有 ' + skippedTotal + ' 条提交在部分分支上已合并，已自动排除。</div>';
  }
  body += '<div class="hint" style="margin-top:6px">按列表顺序逐个分支执行（自动切换分支）；遇到冲突会停下来让你解决，解决后自动继续下一个分支。</div>';
  if (withPush) body += '<div style="color:#0a5cb8;margin-top:6px">每个分支摘取成功后立即推送。</div>';

  const ok = await modalConfirm(withPush ? '批量摘取并推送' : '批量摘取', body, withPush ? '开始摘取并推送' : '开始摘取');
  if (!ok) return;

  fixState.mode = withPush ? 'pickPush' : 'pick';
  fixState.queue = usable;
  fixState.results = plan.filter((p) => !p.commits.length).map((p) => ({ branch: p.branch, state: 'skipped', count: 0 }));
  fixState.running = true;
  renderFixResult();
  updateFixButtons();
  await fixStep();
}

async function fixStep() {
  const item = fixState.queue.shift();
  if (!item) {
    fixState.running = false;
    await finishFix();
    return;
  }
  fixState.current = item.branch;
  const dirty = (state.info && state.info.dirty ? state.info.dirty.length : 0);
  setBusy(true, '正在把 ' + item.commits.length + ' 个提交摘取到 ' + item.branch + '…（剩 ' + fixState.queue.length + ' 个分支）');

  const res = await api.cherryPick({
    dir: state.dir,
    target: item.branch,
    commits: item.commits.map((c) => c.hash),
    autoStash: !!dirty
  });
  logResult(res);

  if (res.ok) {
    fixState.results.push({
      branch: item.branch,
      state: res.empty ? 'empty' : 'picked',
      count: res.empty ? 0 : item.commits.length,
      message: res.message || ''
    });
    setBusy(false);
    await refreshAll();
    if (fixState.mode === 'pickPush' && !res.empty) await fixPush(item.branch);
    renderFixResult();
    return fixStep();
  }

  if (res.conflict) {
    setBusy(false);
    state.merge.pendingPush = false;
    state.merge.pushSide = '';
    state.merge.pendingStash = !!res.stashed;
    state.merge.fixQueue = true;
    state.merge.fixBranch = item.branch;
    state.merge.fixItem = item;
    toast('摘取到 ' + item.branch + ' 时发生冲突，解决后会继续剩下的分支', 'warn');
    await openMergeView(res.files || [], item.branch, 'cherry-pick');
    return;
  }

  fixState.results.push({ branch: item.branch, state: 'error', count: 0, message: res.error || res.message || '摘取失败' });
  setBusy(false);
  renderFixResult();
  await refreshAll();
  return fixStep();
}

/** 批量模式下的推送：被拒就先变基重推一次 */
async function fixPush(branch) {
  setBusy(true, '正在推送 ' + branch + '…');
  let res = await api.push(state.dir, branch);
  if (!res.ok && /non-fast-forward|rejected|fetch first|\[rejected\]/i.test(res.error || '')) {
    toast(branch + ' 推送被拒，正在变基后重试…', 'warn');
    const pr = await api.pull(state.dir, branch, 'rebase', false);
    if (pr && pr.ok && !pr.conflict) {
      res = await api.push(state.dir, branch);
    } else {
      res = { ok: false, error: '推送被拒，变基未完成（可能需要手动处理冲突）' };
    }
  }
  setBusy(false);

  const last = fixState.results[fixState.results.length - 1];
  if (res.ok) {
    if (last && last.branch === branch) last.state = 'pushed';
  } else {
    fixState.results.push({ branch, state: 'pushFail', count: 0, message: res.error || '推送失败' });
  }
  renderFixResult();
}

async function finishFix() {
  fixState.running = false;
  fixState.current = '';
  updateFixButtons();
  await refreshAll();
  const okN = fixState.results.filter((r) => r.state === 'picked' || r.state === 'pushed').length;
  const skipN = fixState.results.filter((r) => r.state === 'skipped').length;
  const badN = fixState.results.filter((r) => r.state === 'error' || r.state === 'pushFail' || r.state === 'aborted').length;
  const parts = ['成功 ' + okN + ' 个分支'];
  if (skipN) parts.push('跳过 ' + skipN + ' 个（已合并）');
  if (badN) parts.push('失败 ' + badN + ' 个');
  toast('批量摘取完成：' + parts.join('，'), badN ? 'warn' : 'ok');
  renderFixResult();
  if (state.panes.left) state.panes.left.clearSelection();
  refreshFlags();
}

/* -------------------------- 全局事件 -------------------------- */

function bindGlobal() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('#ckRun').addEventListener('click', runCheck);
  // 修改任何条件都只标记「待重检」，不自动触发比对。
  $('#ckSource').addEventListener('change', async () => {
    markCheckDirty();
    await loadCheckAuthors();
  });
  $('#ckTarget').addEventListener('change', markCheckDirty);
  $('#ckAuthor').addEventListener('change', markCheckDirty);
  $('#ckTime').addEventListener('change', () => {
    markCheckDirty();
    const custom = $('#ckTime').value === 'custom';
    $('#ckCustomRange').classList.toggle('hidden', !custom);
    if (custom && !$('#ckFrom').value) {
      const d = new Date(Date.now() - 30 * 864e5);
      $('#ckFrom').value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const n = new Date();
      $('#ckTo').value = `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
    }
  });
  $('#ckFrom').addEventListener('change', markCheckDirty);
  $('#ckTo').addEventListener('change', markCheckDirty);
  $('#ckOnlyUnmerged').addEventListener('change', renderCheckList);

  $('#btnBrowse').addEventListener('click', async () => {
    const res = await api.pickFolder($('#repoPath').value.trim());
    if (res && res.ok) openRepo(res.path);
  });

  $('#repoPath').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openRepo($('#repoPath').value.trim());
  });

  $('#btnRecent').addEventListener('click', () => showRecentMenu($('#btnRecent')));
  $('#btnRefreshAll').addEventListener('click', () => refreshAll({ reselect: true }));
  $('#btnOpenFolder').addEventListener('click', () => {
    if (state.dir) api.openPath(state.dir);
  });
  $('#btnSettings').addEventListener('click', openSettings);

  $$('.pull-btn').forEach((b) => b.addEventListener('click', () => doPull(b.dataset.side)));
  $$('.push-btn').forEach((b) => b.addEventListener('click', () => doPush(b.dataset.side)));
  $('#btnTransfer').addEventListener('click', () => doCherryPick('pick'));
  $('#btnTransferPush').addEventListener('click', () => doCherryPick('pickPush'));

  $('#btnFixPick').addEventListener('click', () => startFixMerge('pick'));
  $('#btnFixPickPush').addEventListener('click', () => startFixMerge('pickPush'));
  $('#btnFixAll').addEventListener('click', () => {
    const srcName = (state.panes.left && state.panes.left.branch) || '';
    fixState.branches.forEach((b) => { if (b.name !== srcName) fixState.selected.add(b.name); });
    renderFixList(); updateFixButtons();
  });
  $('#btnFixNone').addEventListener('click', () => {
    fixState.selected.clear();
    renderFixList(); updateFixButtons();
  });
  $('#fixSearch').addEventListener('input', (e) => { fixState.filter = e.target.value; renderFixList(); });
  $('#fixSearchClear').addEventListener('click', () => {
    fixState.filter = ''; $('#fixSearch').value = ''; renderFixList();
  });
  $('#btnClearSel').addEventListener('click', () => {
    state.panes.left.clearSelection();
    state.panes.right.clearSelection();
  });

  $('#btnToggleLog').addEventListener('click', () => $('#logPanel').classList.toggle('hidden'));
  $('#btnCloseLog').addEventListener('click', () => $('#logPanel').classList.add('hidden'));
  $('#btnClearLog').addEventListener('click', () => { $('#logBody').innerHTML = ''; });

  $('#btnResumePick').addEventListener('click', async () => {
    const st = await api.conflicts(state.dir);
    const op = (st && st.operation) || (state.info && state.info.operation);
    const target = (st && st.rebaseBranch) || (state.info && state.info.rebaseBranch) ||
      (state.info && state.info.branch !== 'HEAD' ? state.info.branch : '') ||
      (state.panes.right && state.panes.right.branch) || '';
    await openMergeView((st && st.files) || [], target, op);
  });
  $('#btnAbortPick').addEventListener('click', abortPick);

  $('#btnCloseDetail').addEventListener('click', () => {
    detailOpenFor = '';
    $('#detailDrawer').classList.add('hidden');
  });

  // 工作区改动弹窗
  $('#workClose').addEventListener('click', () => $('#workView').classList.add('hidden'));
  $('#workRestore').addEventListener('click', () => restoreStash());

  // 冲突窗口
  $('#mfPrev').addEventListener('click', () => {
    const m = state.merge.current;
    if (!m || !m.blocks || !m.blocks.length) return;
    m.blockIndex = (mergeBlockIndex() - 1 + m.blocks.length) % m.blocks.length;
    updateMergeNav();
  });
  $('#mfNext').addEventListener('click', () => {
    const m = state.merge.current;
    if (!m || !m.blocks || !m.blocks.length) return;
    m.blockIndex = (mergeBlockIndex() + 1) % m.blocks.length;
    updateMergeNav();
  });
  $('#mfUseOurs').addEventListener('click', () => resolveCurrentBlock('ours'));
  $('#mfUseTheirs').addEventListener('click', () => resolveCurrentBlock('theirs'));
  $('#mfUseBoth').addEventListener('click', () => resolveCurrentBlock('both'));
  $('#mfExternal').addEventListener('click', async () => {
    const m = state.merge.current;
    if (!m) return;
    const res = await api.externalMerge({
      dir: state.merge.dir || state.dir,
      relPath: m.relPath,
      absPath: m.absPath,
      tool: state.config.mergeTool || ''
    });
    if (res && res.ok) {
      m.externalEdited = true;
      toast('已用外部工具打开。改完保存后，回到这里点「保存并标记已解决」，会自动读取磁盘上的最新内容', 'ok');
    } else {
      toast((res && res.error) || '打开外部工具失败', 'err');
    }
  });
  $('#mfSave').addEventListener('click', saveCurrentConflictFile);
  $('#mfContinue').addEventListener('click', continuePick);
  $('#mfAbort').addEventListener('click', abortPick);
  $('#mfSkip').addEventListener('click', skipPick);
  $('#mfBinaryOurs').addEventListener('click', () => resolveBinaryConflict('ours'));
  $('#mfBinaryTheirs').addEventListener('click', () => resolveBinaryConflict('theirs'));
  $('#mrText').addEventListener('input', () => {
    const m = state.merge.current;
    if (m) m.dirty = true;
    renderMergePanes();
  });
  $('#mrText').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      const s = ta.selectionStart;
      ta.value = ta.value.slice(0, s) + '    ' + ta.value.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = s + 4;
      renderMergePanes();
    }
  });

  // 设置
  $('#setSave').addEventListener('click', async () => {
    state.config = (await api.setConfig({
      mergeTool: $('#setMergeTool').value.trim(),
      pageSize: Math.max(50, Math.min(2000, parseInt($('#setPageSize').value, 10) || 200)),
      pullMode: $('#setPullMode').value
    })).config;
    $('#settingsModal').classList.add('hidden');
    toast('设置已保存', 'ok');
  });
  $('#setCancel').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));

  // 键盘
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5') { e.preventDefault(); refreshAll({ reselect: true }); }
    if (e.key === 'Escape') {
      if (!$('#workView').classList.contains('hidden')) { $('#workView').classList.add('hidden'); return; }
      if (!$('#settingsModal').classList.contains('hidden')) { $('#settingsModal').classList.add('hidden'); return; }
      if (!$('#modal').classList.contains('hidden')) { $('#modalCancel').click(); return; }
      if (!$('#detailDrawer').classList.contains('hidden')) {
        detailOpenFor = '';
        $('#detailDrawer').classList.add('hidden');
        return;
      }
    }
    if (state.merge.active) {
      if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); $('#mfPrev').click(); }
      if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); $('#mfNext').click(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveCurrentConflictFile(); }
    }
  });
}

/* -------------------------- 启动 -------------------------- */

async function boot() {
  // 兜底：任何未捕获的异步异常都不能让界面卡在「忙碌」状态（否则摘取按钮永久禁用）
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandled]', e.reason);
    if (state.busy) setBusy(false);
    toast('操作出错：' + ((e.reason && (e.reason.message || e.reason)) || '未知错误'), 'err');
  });
  state.config = (await api.getConfig()).config || {};
  state.panes.left = new Pane('left');
  state.panes.right = new Pane('right');
  rememberLeftHome();
  state.panes.left.limit = state.config.pageSize || 200;
  state.panes.right.limit = state.config.pageSize || 200;
  bindGlobal();
  updateTransferUI();
  setStatus('就绪', 'ok');

  if (state.config.lastRepo) {
    $('#repoPath').value = state.config.lastRepo;
    await openRepo(state.config.lastRepo, { silent: true });
  } else {
    setStatus('请先选择一个 git 仓库', '');
    state.panes.left.render();
    state.panes.right.render();
  }
}

// 全局兜底：不吞异常，界面上一律有提示，同时写日志
window.addEventListener('error', (e) => {
  const msg = (e && e.message) || '脚本错误';
  try { toast('界面出错：' + msg, 'err'); } catch (_) { /* ignore */ }
  try { api.logError({ kind: 'error', message: msg, stack: (e && e.error && e.error.stack) || (e && e.filename + ':' + e.lineno) || '' }); } catch (_) { /* ignore */ }
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  const msg = (r && (r.message || r)) || '未处理的异常';
  try { toast('操作失败：' + msg, 'err'); } catch (_) { /* ignore */ }
  try { api.logError({ kind: 'rejection', message: String(msg), stack: (r && r.stack) || '' }); } catch (_) { /* ignore */ }
});

boot();

})();
