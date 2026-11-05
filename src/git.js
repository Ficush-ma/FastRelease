'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SEP = '\x1f';

/**
 * 执行 git 命令（不经 shell，参数数组传递，避免转义问题）
 */
function run(cwd, args, opts = {}) {
  const { timeout = 60000, env = {}, input = null } = opts;
  const fullArgs = [
    '-c', 'core.quotepath=false',
    '-c', 'i18n.logOutputEncoding=UTF-8',
    '-c', 'core.editor=true',
    '-c', 'sequence.editor=true',
    ...args
  ];
  return new Promise((resolve) => {
    let child;
    const cmdText = 'git ' + args.join(' ');
    try {
      child = spawn('git', fullArgs, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '1',
          ...env
        }
      });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(e && e.message || e), cmd: cmdText });
      return;
    }
    const out = [];
    const err = [];
    let done = false;
    let timedOut = false;
    const timer = timeout > 0 ? setTimeout(() => {
      if (!done) {
        timedOut = true;
        try { child.kill(); } catch (_) { /* ignore */ }
      }
    }, timeout) : null;

    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout: '', stderr: String(e && e.message || e), cmd: cmdText });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code: code === null ? -1 : code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        cmd: cmdText,
        timedOut
      });
    });
    try {
      if (input != null) child.stdin.end(input);
      else child.stdin.end();
    } catch (_) { /* ignore */ }
  });
}

function mergeOutput(r) {
  return [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
}

async function ensureRepo(dir) {
  if (!dir || typeof dir !== 'string') {
    return { ok: false, error: '请先选择仓库目录' };
  }
  const abs = path.resolve(dir.trim());
  if (!fs.existsSync(abs)) return { ok: false, error: '目录不存在：' + abs };
  const r = await run(abs, ['rev-parse', '--show-toplevel'], { timeout: 20000 });
  if (!r.ok) {
    return { ok: false, error: '这不是一个 git 仓库：' + abs };
  }
  return { ok: true, root: r.stdout.trim() };
}

async function getStatusShort(dir) {
  const r = await run(dir, ['status', '--porcelain=v1', '-uall'], { timeout: 30000 });
  return r.ok ? r.stdout : '';
}

/** 工作区改动明细（文件 + 状态码），供弹窗展示 */
async function workingChanges(dir) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;
  const [stR, statR] = await Promise.all([
    run(root, ['status', '--porcelain=v1', '-uall'], { timeout: 30000 }),
    run(root, ['diff', '--stat', 'HEAD'], { timeout: 30000 })
  ]);
  if (!stR.ok) return { ok: false, error: mergeOutput(stR) || '读取工作区状态失败' };

  const files = [];
  for (const line of stR.stdout.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const p = line.slice(3).trim();
    files.push({
      code,
      path: p,
      untracked: code === '??',
      staged: code[0] !== ' ' && code[0] !== '?'
    });
  }
  return { ok: true, files, stat: (statR.ok ? statR.stdout : '').trim() };
}

/** 单个改动文件的 diff（未跟踪文件返回内容预览） */
async function workingDiff(dir, { relPath, untracked = false, staged = false } = {}) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  if (!relPath) return { ok: false, error: '缺少文件路径' };
  const root = repo.root;

  if (untracked) {
    try {
      const txt = fs.readFileSync(path.join(root, relPath), 'utf8');
      const lines = txt.replace(/\r\n/g, '\n').split('\n');
      // 去掉文件末尾换行产生的空行，避免预览里多出一条空白「新增」行
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      const preview = lines.slice(0, 500).map((l) => '+ ' + l).join('\n');
      return { ok: true, text: preview + (lines.length > 500 ? `\n…（共 ${lines.length} 行，仅显示前 500 行）` : ''), untracked: true };
    } catch (e) {
      return { ok: false, error: '读取文件失败：' + ((e && e.message) || e) };
    }
  }

  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  args.push('--', relPath);
  const r = await run(root, args, { timeout: 30000 });
  if (!r.ok) return { ok: false, error: mergeOutput(r) || '读取 diff 失败' };
  return { ok: true, text: r.stdout || '（无文本差异，可能是二进制文件或仅权限变化）' };
}

/** 自动暂存工作区（含未跟踪文件） */
async function stashPush(dir, { message = '' } = {}) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const msg = message || 'FastRelease 自动暂存 ' + new Date().toISOString();
  const r = await run(repo.root, ['stash', 'push', '-u', '-m', msg], { timeout: 180000 });
  const out = mergeOutput(r);
  if (!r.ok) return { ok: false, stashed: false, error: '自动暂存失败：\n' + out };
  if (/No local changes/i.test(out)) return { ok: true, stashed: false, message: out };
  return { ok: true, stashed: true, message: out };
}

/** 恢复最近一次自动暂存的改动；有冲突时返回冲突文件，交给内置冲突界面解决 */
async function stashPop(dir) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;
  // 先带 --index 恢复：这样「已暂存 / 未暂存」的区分也能原样还原。
  // 内容冲突时 git 会整体放弃 --index（不留半截标记），此时退回普通 pop，把冲突交给冲突界面。
  let r = await run(root, ['stash', 'pop', '--index'], { timeout: 180000 });
  let out = mergeOutput(r);
  if (r.ok) return { ok: true, message: out, indexed: true };
  if (/conflicts in index|without --index/i.test(out)) {
    r = await run(root, ['stash', 'pop'], { timeout: 180000 });
    out = mergeOutput(r);
    if (r.ok) return { ok: true, message: out };
  }

  const st = await conflictState(root);
  if (st.files.length) {
    return {
      ok: false,
      conflict: true,
      files: st.files,
      error: '恢复改动时和目标分支的内容冲突，请逐个文件解决后点「全部完成，恢复改动」。'
    };
  }
  return {
    ok: false,
    error: '改动未能自动恢复（仍保存在 stash 里，可用 git stash list 查看）：\n' + out
  };
}

/** 冲突解决并 add 之后，丢掉这条 stash 记录（内容已在工作区） */
async function stashFinish(dir) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const r = await run(repo.root, ['stash', 'drop', 'stash@{0}'], { timeout: 60000 });
  if (r.ok) return { ok: true };
  return { ok: false, error: mergeOutput(r) || '删除 stash 记录失败' };
}

/** 放弃本次恢复：工作区回到干净状态，改动仍保留在 stash 里 */
async function stashAbort(dir) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const r = await run(repo.root, ['reset', '--hard', 'HEAD'], { timeout: 60000 });
  if (r.ok) return { ok: true, message: '已放弃恢复，改动仍在 stash 里' };
  return { ok: false, error: mergeOutput(r) || '回滚失败' };
}

async function isCherryPicking(dir) {
  const r = await run(dir, ['rev-parse', '--git-path', 'CHERRY_PICK_HEAD'], { timeout: 20000 });
  if (!r.ok) return false;
  let p = r.stdout.trim();
  if (!path.isAbsolute(p)) p = path.join(dir, p);
  return fs.existsSync(p);
}

async function gitPathExists(root, name) {
  const r = await run(root, ['rev-parse', '--git-path', name], { timeout: 20000 });
  if (!r.ok) return false;
  let p = r.stdout.trim();
  if (!path.isAbsolute(p)) p = path.join(root, p);
  return fs.existsSync(p);
}

/** 当前仓库是否停在某个多步操作中间（cherry-pick / rebase / merge） */
async function opState(dir) {
  const root = (await ensureRepo(dir)).root;
  const [cp, rm, ra, mr] = await Promise.all([
    gitPathExists(root, 'CHERRY_PICK_HEAD'),
    gitPathExists(root, 'rebase-merge'),
    gitPathExists(root, 'rebase-apply'),
    gitPathExists(root, 'MERGE_HEAD')
  ]);
  const operation = cp ? 'cherry-pick' : (rm || ra ? 'rebase' : (mr ? 'merge' : ''));

  // 变基时 HEAD 是游离的，真实分支名记录在 rebase-merge/head-name 里
  let rebaseBranch = '';
  if (rm || ra) {
    const rel = (rm ? 'rebase-merge' : 'rebase-apply') + '/head-name';
    const pR = await run(root, ['rev-parse', '--git-path', rel], { timeout: 20000 });
    if (pR.ok) {
      let p = pR.stdout.trim();
      if (!path.isAbsolute(p)) p = path.join(root, p);
      try {
        rebaseBranch = fs.readFileSync(p, 'utf8').trim().replace(/^refs\/heads\//, '');
      } catch (_) { /* 读不到就留空 */ }
    }
  }

  return { cherryPicking: cp, rebasing: rm || ra, merging: mr, operation, rebaseBranch };
}

/**
 * 仓库整体信息：当前分支、上游、领先/落后、脏文件、远端列表
 */
async function repoInfo(dir) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;

  const [branchR, remotesR, statusR, op, upstreamR] = await Promise.all([
    run(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 20000 }),
    run(root, ['remote'], { timeout: 20000 }),
    run(root, ['status', '--porcelain=v1', '-uall'], { timeout: 30000 }),
    opState(root),
    run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { timeout: 20000 })
  ]);

  const branch = branchR.ok ? branchR.stdout.trim() : '';
  const remotes = remotesR.ok ? remotesR.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const dirty = [];
  if (statusR.ok) {
    for (const line of statusR.stdout.split('\n')) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      const p = line.slice(3).trim();
      dirty.push({ code, path: p });
    }
  }

  let ahead = 0;
  let behind = 0;
  let upstream = '';
  if (upstreamR.ok) {
    upstream = upstreamR.stdout.trim();
    const ab = await run(root, ['rev-list', '--left-right', '--count', upstream + '...HEAD'], { timeout: 30000 });
    if (ab.ok) {
      const parts = ab.stdout.trim().split(/\s+/);
      behind = parseInt(parts[0], 10) || 0;
      ahead = parseInt(parts[1], 10) || 0;
    }
  }

  return {
    ok: true,
    root,
    branch,
    upstream,
    ahead,
    behind,
    dirty,
    cherryPicking: op.cherryPicking,
    rebasing: op.rebasing,
    operation: op.operation,
    rebaseBranch: op.rebaseBranch || '',
    remotes,
    defaultRemote: remotes.includes('origin') ? 'origin' : (remotes[0] || 'origin')
  };
}

async function listBranches(dir) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;
  // 注意：for-each-ref 不支持 %x1f 占位符，这里必须用真实的分隔字符
  const fmt = ['%(refname:short)', '%(objectname:short)', '%(committerdate:iso-strict)', '%(committerdate:unix)', '%(subject)', '%(upstream:short)'].join(SEP);
  const [localR, remoteR, cur] = await Promise.all([
    run(root, ['for-each-ref', '--sort=-committerdate', '--format=' + fmt, 'refs/heads'], { timeout: 30000 }),
    run(root, ['for-each-ref', '--sort=-committerdate', '--format=' + fmt, 'refs/remotes'], { timeout: 30000 }),
    run(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 20000 })
  ]);
  if (!localR.ok) return { ok: false, error: mergeOutput(localR) || '读取分支失败' };

  const current = cur.ok ? cur.stdout.trim() : '';

  const parse = (r, isRemote) => {
    if (!r.ok) return [];
    return r.stdout.split('\n').filter(Boolean).map((line) => {
      const f = line.split(SEP);
      const name = f[0];
      const parts = name.split('/');
      return {
        name,
        isRemote,
        remoteName: isRemote ? parts[0] : '',
        localName: isRemote ? parts.slice(1).join('/') : name,
        hash: f[1],
        date: f[2],
        timestamp: parseInt(f[3], 10) || 0,
        subject: f[4] || '',
        upstream: f[5] || '',
        current: !isRemote && name === current
      };
    });
  };

  const locals = parse(localR, false);
  const localNames = new Set(locals.map((b) => b.name));
  // 远端分支去掉 origin/HEAD 这类符号引用（其 short name 可能只是 "origin"）
  const remotes = parse(remoteR, true)
    .filter((b) => b.name.includes('/') && !/\/HEAD$/.test(b.name))
    .map((b) => ({ ...b, hasLocal: localNames.has(b.localName) }));

  return { ok: true, root, branches: locals.concat(remotes), locals, remotes, current };
}

/**
 * 提交列表
 * 支持：关键字搜索（提交信息 / 哈希前缀）、时间范围、分页
 */
async function listCommits(dir, { ref, limit = 200, skip = 0, search = '', since = '', until = '', author = '' } = {}) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;
  if (!ref) return { ok: false, error: '请选择分支' };

  const fmt = ['%H', '%h', '%an', '%ae', '%ad', '%ct', '%P', '%D', '%s'].join('%x1f');
  const kw = (search || '').trim();
  const isHashLike = /^[0-9a-fA-F]{4,40}$/.test(kw);

  const buildArgs = (useGrep, pageLimit, pageSkip) => {
    const args = ['log', ref, '--date=iso-strict', '--pretty=format:' + fmt];
    if (kw && useGrep) args.push('-i', '--grep=' + kw, '--fixed-strings');
    if (since) args.push('--since=' + since);
    if (until) args.push('--until=' + until);
    if (author) args.push('--author=' + author);
    args.push('-n', String(pageLimit));
    if (pageSkip > 0) args.push('--skip', String(pageSkip));
    return args;
  };

  const parse = (stdout) => stdout.split('\n').filter(Boolean).map((line) => {
    const f = line.split(SEP);
    const parents = (f[6] || '').trim().split(/\s+/).filter(Boolean);
    return {
      hash: f[0],
      short: f[1],
      author: f[2],
      email: f[3],
      date: f[4],
      timestamp: parseInt(f[5], 10) || 0,
      parents: parents.length,
      isMerge: parents.length > 1,
      refs: f[7] || '',
      subject: f[8] || ''
    };
  });

  const exactAuthor = (list) => {
    // --author 是子串/正则匹配，再精确过滤一次，避免 "Bob" 匹配到 "Bob Lee"
    return author ? list.filter((c) => c.author === author) : list;
  };

  const fetch = async (useGrep, pageLimit, pageSkip) => {
    const r = await run(root, buildArgs(useGrep, pageLimit, pageSkip), { timeout: 60000 });
    if (!r.ok) return { ok: false, error: mergeOutput(r) || '读取提交失败' };
    return { ok: true, commits: parse(r.stdout) };
  };

  let commits;
  let hasMore;

  if (kw && isHashLike) {
    // 像哈希的关键字：先按哈希前缀匹配；匹配不到（多半是 storyid/工单号这类数字）
    // 自动降级为普通文本搜索，两种语义都覆盖。
    const first = await fetch(false, 5000, 0);
    if (!first.ok) return first;
    const low = kw.toLowerCase();
    const byHash = first.commits.filter((c) => c.hash.toLowerCase().startsWith(low));
    if (byHash.length) {
      commits = exactAuthor(byHash).slice(skip, skip + limit);
      return { ok: true, commits, hasMore: false };
    }
    const second = await fetch(true, limit, skip);
    if (!second.ok) return second;
    commits = exactAuthor(second.commits);
    hasMore = commits.length >= limit;
  } else {
    const r = await fetch(!!kw, limit, skip);
    if (!r.ok) return r;
    commits = exactAuthor(r.commits);
    hasMore = commits.length >= limit;
  }

  return { ok: true, commits, hasMore };
}

/**
 * 用 git cherry 标记「补丁已存在于目标分支」的提交。
 * 大仓库上 cherry 全量比对极慢（几万提交要几分钟），这里只比对源分支最近的
 * limitCommits 个提交——界面上每页最多也就看几百个，够用且快一个数量级。
 * 注意：新界面已改用 patchFlags（按时间窗口 + 索引缓存），此函数保留兼容。
 */
async function cherryFlags(dir, { target, source, limitCommits = 300 }) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  if (!target || !source) return { ok: true, map: {} };
  const root = repo.root;

  // 基点必须取自「源分支自己」的历史，否则不会起到限制作用
  let limitRef = '';
  if (limitCommits > 0) {
    const baseR = await run(root, ['rev-list', '-1', '--skip=' + limitCommits, source], { timeout: 20000 });
    if (baseR.ok) limitRef = baseR.stdout.trim();
  }
  const args = ['cherry', target, source];
  if (limitRef) args.push(limitRef);

  const r = await run(root, args, { timeout: 60000 });
  if (!r.ok) return { ok: true, map: {}, warning: mergeOutput(r) };
  const map = {};
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sign = t[0];
    const sha = t.slice(2).trim();
    if (sign === '-') map[sha] = true;
  }
  return { ok: true, map };
}

/* ---------------------- patch-id 索引（「已摘取」标记） ---------------------- */

const BADGE_MAX_DAYS = 90;
// 缓存：root|ref|since|until -> { tip, shaToPatch, patchToShas }
const patchIndexCache = new Map();

/** 跑 `git log ... -p | git patch-id --stable`，把提交映射到 patch-id */
function runPipe(cwd, logArgs, opts = {}) {
  const timeout = opts.timeout || 180000;
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let err = '';
    let timer = null;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok, stdout: out, stderr: err });
    };
    let a;
    let b;
    const env = { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };
    try {
      a = spawn('git', ['-c', 'core.quotepath=false', ...logArgs], { cwd, windowsHide: true, env });
      b = spawn('git', ['patch-id', '--stable'], { cwd, windowsHide: true, env });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: String((e && e.message) || e) });
      return;
    }
    if (opts.input != null) {
      try { a.stdin.write(opts.input); a.stdin.end(); } catch (_) { /* ignore */ }
    }
    a.stdout.pipe(b.stdin);
    a.stderr.on('data', (d) => { err += d; });
    b.stdout.on('data', (d) => { out += d; });
    b.stderr.on('data', (d) => { err += d; });
    a.on('error', (e) => { err += String((e && e.message) || e); done(false); });
    b.on('error', (e) => { err += String((e && e.message) || e); done(false); });
    a.on('close', () => { try { b.stdin.end(); } catch (_) { /* ignore */ } });
    b.on('close', (code) => done(code === 0));
    timer = setTimeout(() => {
      try { a.kill(); } catch (_) { /* ignore */ }
      try { b.kill(); } catch (_) { /* ignore */ }
      done(false);
    }, timeout);
  });
}

async function buildPatchIndex(root, ref, { since, until, exclude } = {}) {
  const args = ['log', ref, '--no-merges', '--pretty=format:commit %H', '-p'];
  if (exclude) args.push('^' + exclude);
  if (since) args.push('--since=' + since);
  if (until) args.push('--until=' + until);

  const r = await runPipe(root, args, { timeout: 180000 });
  const shaToPatch = new Map();
  const patchToShas = new Map();
  if (r.ok) {
    for (const line of r.stdout.split('\n')) {
      const m = line.trim().match(/^([0-9a-f]{40})\s+([0-9a-f]{40})$/);
      if (!m) continue;
      const pid = m[1];
      const sha = m[2];
      shaToPatch.set(sha, pid);
      if (!patchToShas.has(pid)) patchToShas.set(pid, []);
      patchToShas.get(pid).push(sha);
    }
  }
  return { ok: r.ok, shaToPatch, patchToShas, error: r.ok ? '' : (r.stderr || 'patch-id 计算失败') };
}

/** 只算指定提交的 patch-id（不建全量索引，批量预检查 / 徽标场景用） */
async function patchIdsFor(root, shas) {
  const map = new Map();
  if (!shas || !shas.length) return { ok: true, map };
  const r = await runPipe(root, [
    'log', '--no-walk=unsorted', '--stdin', '--no-merges', '--pretty=format:commit %H', '-p'
  ], { timeout: 180000, input: shas.join('\n') + '\n' });
  if (!r.ok) return { ok: false, map, error: r.stderr || 'patch-id 计算失败' };
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{40})\s+([0-9a-f]{40})$/);
    if (m) map.set(m[2], m[1]);
  }
  return { ok: true, map };
}

/** 取某个分支在时间窗口内的 patch-id 索引（带缓存 + 增量更新） */
async function getPatchIndex(root, ref, { since, until }) {
  const tipR = await run(root, ['rev-parse', ref], { timeout: 20000 });
  const tip = tipR.ok ? tipR.stdout.trim() : '';
  const key = [root, ref, since || '', until || ''].join('|');
  const cached = patchIndexCache.get(key);

  if (cached && cached.tip === tip) return { ok: true, ...cached, cached: true };

  if (cached && cached.tip && tip) {
    // 增量：分支只是往前走，就只补算新提交
    const anc = await run(root, ['merge-base', '--is-ancestor', cached.tip, tip], { timeout: 20000 });
    if (anc.ok) {
      const inc = await buildPatchIndex(root, tip, { since, until, exclude: cached.tip });
      if (inc.ok) {
        for (const [sha, pid] of inc.shaToPatch) {
          cached.shaToPatch.set(sha, pid);
          if (!cached.patchToShas.has(pid)) cached.patchToShas.set(pid, []);
          cached.patchToShas.get(pid).push(sha);
        }
        cached.tip = tip;
        return { ok: true, ...cached, cached: false, incremental: true };
      }
    }
  }

  const fresh = await buildPatchIndex(root, tip || ref, { since, until });
  if (!fresh.ok) return { ok: false, error: fresh.error };
  const entry = { tip, shaToPatch: fresh.shaToPatch, patchToShas: fresh.patchToShas };
  patchIndexCache.set(key, entry);
  return { ok: true, ...entry, cached: false };
}

/**
 * 「已摘取」标记：源分支窗口内的提交，其 patch 是否已出现在目标分支窗口内。
 * 口径与界面筛选一致（同一 since/until，未指定时间时封顶 90 天）。
 */
/**
 * 统一的「已合并」判定：三层的唯一实现，徽标和合并检查都走这里。
 *   ① patch-id（带缓存索引）—— 摘取/变基/rebase 后的常规场景
 *   ② 内容比对（改动文件的 blob 是否一致）—— squash 后文件没再被改过
 *   ③ merge-tree 三方合并干跑 —— squash 后文件在别处又被改过
 *
 * only：只判定这些提交（批量预检查 / 合并检查的提交列表）；不传则判定窗口内的全部提交。
 * 返回四个集合：patch / content / deep（已合并的三种依据）、unsure（冲突，需人工确认）。
 */
/** 相对时间窗（现在往前推 N 天）每次调用都带毫秒，会把索引缓存打散；按整点归整 */
function stableSince(since) {
  const base = since || new Date(Date.now() - BADGE_MAX_DAYS * 864e5).toISOString();
  const t = Date.parse(base);
  if (!Number.isFinite(t)) return base;
  return new Date(Math.floor(t / 3600000) * 3600000).toISOString();
}

async function mergedStatus(dir, { source, target, since, until, only = null, deepCap = 300, contentCap = 2000 } = {}) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const nothing = { patch: new Set(), content: new Set(), deep: new Set(), unsure: new Set(), deepSkipped: 0 };
  if (!source || !target || source === target) {
    return { ok: true, ...nothing, counts: { source: 0, target: 0 } };
  }

  const root = repo.root;
  const from = stableSince(since);
  const onlySet = Array.isArray(only) && only.length ? new Set(only) : null;

  // 有明确提交列表时：只算这些提交的 patch-id + 目标分支的索引，省掉一遍全量索引（大仓库上差十几秒）
  const [srcPatch, dstIdx] = await Promise.all([
    onlySet ? patchIdsFor(root, [...onlySet]) : getPatchIndex(root, source, { since: from, until: until || '' }),
    getPatchIndex(root, target, { since: from, until: until || '' })
  ]);
  if (!srcPatch.ok || !dstIdx.ok) {
    return { ok: false, error: srcPatch.error || dstIdx.error || '索引计算失败' };
  }
  const srcMap = onlySet ? srcPatch.map : srcPatch.shaToPatch;

  const candidates = onlySet ? [...onlySet] : [...srcMap.keys()];

  const patch = new Set();
  for (const sha of candidates) {
    const pid = srcMap.get(sha);
    if (pid && dstIdx.patchToShas.has(pid)) patch.add(sha);
  }

  const content = new Set();
  const rest = candidates.filter((sha) => !patch.has(sha));
  if (rest.length) {
    const cf = await contentFlags(root, { target, shas: rest, cap: contentCap });
    if (cf.ok) for (const sha of rest) if (cf.map[sha]) content.add(sha);
  }

  const deep = new Set();
  const unsure = new Set();
  const rest2 = rest.filter((sha) => !content.has(sha));
  const deepSkipped = rest2.length > deepCap ? rest2.length - deepCap : 0;
  if (rest2.length) {
    const df = await deepFlags(root, { target, shas: rest2, cap: deepCap });
    if (df.ok) {
      for (const sha of rest2) {
        if (df.map[sha]) deep.add(sha);
        else if (df.unsure[sha]) unsure.add(sha);
      }
    }
  }

  return {
    ok: true,
    patch, content, deep, unsure, deepSkipped,
    window: { since: from, until: until || '' },
    counts: { source: srcMap.size, target: dstIdx.patchToShas.size },
    cached: !!(srcPatch.cached && dstIdx.cached)
  };
}

/**
 * 「已摘取」徽标：把 mergedStatus 的结果拍平成 { sha: true }。
 * squash 里既包含内容比对的命中，也包含 merge-tree 的命中（前端只用于换配色和 tooltip）。
 */
async function patchFlags(dir, { source, target, since, until, only = null }) {
  // 深层判定单条约 100~150ms，很便宜；按「当前要判定的条数」给预算，避免被固定上限截断
  const onlyLen = Array.isArray(only) ? only.length : 0;
  const deepCap = Math.max(200, Math.min(onlyLen || 300, 600));
  const st = await mergedStatus(dir, { source, target, since, until, only, deepCap });
  if (!st.ok) return st;

  const map = {};
  const squash = {};
  for (const sha of st.patch) map[sha] = true;
  for (const sha of st.content) { map[sha] = true; squash[sha] = true; }
  for (const sha of st.deep) { map[sha] = true; squash[sha] = true; }

  return {
    ok: true,
    map,
    squash,
    window: st.window,
    counts: { ...st.counts, squash: Object.keys(squash).length, unsure: st.unsure.size, deepSkipped: st.deepSkipped, deepCap },
    cached: st.cached
  };
}

/**
 * 内容级判定：提交改过的文件，在目标分支上是否已经是同样的内容。
 *
 * 用途：squash（多条提交压成一条）后，原提交的 patch-id 在目标分支上不存在，
 * patch-id 比对会误报「未合并」。这里不比 patch，比「改动是否已经落在目标文件里」：
 * 一次 git log --raw 拿到每条提交产出的 blob，一次 git ls-tree -r 拿到目标分支的 blob，
 * 逐个文件比对 oid。成本固定 2 个 git 进程，与提交数无关。
 */
async function contentFlags(root, { target, shas, cap = 2000 }) {
  if (!target || !shas || !shas.length) return { ok: true, map: {} };
  const list = shas.slice(0, cap);

  const [rawR, treeR] = await Promise.all([
    run(root, ['log', '--stdin', '--no-walk=unsorted', '--no-merges', '--raw', '--no-abbrev', '--pretty=format:commit %H'], {
      timeout: 120000,
      input: list.join('\n') + '\n'
    }),
    run(root, ['ls-tree', '-r', '-z', '--full-tree', target], { timeout: 60000 })
  ]);
  if (!rawR.ok) return { ok: false, error: mergeOutput(rawR) || '读取提交改动失败' };
  if (!treeR.ok) return { ok: false, error: mergeOutput(treeR) || '读取目标分支文件列表失败' };

  const targetBlob = new Map();
  for (const rec of treeR.stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(' ');
    targetBlob.set(rec.slice(tab + 1), meta[2]);
  }

  const perCommit = new Map();
  let cur = '';
  for (const line of rawR.stdout.split('\n')) {
    if (line.startsWith('commit ')) {
      cur = line.slice(7).trim();
      if (!perCommit.has(cur)) perCommit.set(cur, []);
      continue;
    }
    if (!cur || line[0] !== ':') continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(1, tab).split(' ');
    perCommit.get(cur).push({ oid: meta[3] || '', path: line.slice(tab + 1) });
  }

  const map = {};
  for (const [sha, files] of perCommit) {
    if (!files.length) continue; // 空提交不参与内容判定
    const all = files.every((f) => {
      const oid = targetBlob.get(f.path);
      if (/^0+$/.test(f.oid)) return oid === undefined; // 该提交删了这个文件：目标上也不该有
      return oid === f.oid;
    });
    if (all) map[sha] = true;
  }
  return { ok: true, map, checked: perCommit.size };
}

/* ---------- merge-tree 兜底：对内容比对仍判不出的候选做三方合并干跑 ---------- */

const deepCache = new Map(); // key: root|targetTip|sha -> merged | conflict | diff | error
let mergeTreeSupport = null; // null 未探测 / true 支持 / false 不支持

/** 机器上的 git 是否支持 merge-tree --merge-base（2.40+） */
async function mergeTreeSupported(root) {
  if (mergeTreeSupport !== null) return mergeTreeSupport;
  const r = await run(root, ['merge-tree', '-h'], { timeout: 20000 });
  const txt = (r.stdout || '') + (r.stderr || '');
  // usage 里是 '--[no-]merge-base'；老版本 git 的 usage 完全不出现 merge-base
  mergeTreeSupport = txt.indexOf('merge-base') >= 0;
  return mergeTreeSupport;
}

/**
 * 把候选提交的改动三方合并到目标分支，干跑一次（不动工作区、不动索引）。
 * 结果树 === 目标树  → 改动已在，判「已合并」
 * 有冲突            → 目标分支上这段内容被改过，降级为「可能已合并，需人工确认」
 * 结果树 !== 目标树  → 确实没合并
 */
async function deepFlags(root, { target, shas, cap = 300, concurrency = 4 } = {}) {
  const map = {};
  const unsure = {};
  if (!target || !shas || !shas.length) return { ok: true, map, unsure };
  if (!(await mergeTreeSupported(root))) return { ok: true, map, unsure, unsupported: true };

  const [treeR, tipR] = await Promise.all([
    run(root, ['rev-parse', target + '^{tree}'], { timeout: 20000 }),
    run(root, ['rev-parse', target], { timeout: 20000 })
  ]);
  if (!treeR.ok) return { ok: false, error: mergeOutput(treeR) || '读取目标分支根树失败' };
  const targetTree = treeR.stdout.trim();
  const tip = tipR.ok ? tipR.stdout.trim() : target;

  const list = shas.slice(0, cap);
  let idx = 0;
  const one = async (sha) => {
    const key = root + '|' + tip + '|' + sha;
    const hit = deepCache.get(key);
    if (hit) {
      if (hit === 'merged') map[sha] = true;
      else if (hit === 'conflict') unsure[sha] = true;
      return;
    }
    const judge = (r) => {
      const out = (r.stdout || '').trim();
      const first = (out.split(/\r?\n/)[0] || '').trim();
      const isTree = /^[0-9a-f]{40,64}$/.test(first);
      if (r.code === 0 && isTree) return first === targetTree ? 'merged' : 'diff';
      if (r.code === 1 && isTree) return 'conflict';
      return 'error';
    };
    const mergeAt = (extra = []) => run(root,
      ['merge-tree', '--write-tree', '--merge-base=' + sha + '^', ...extra, tip, sha],
      { timeout: 60000 });

    let verdict = judge(await mergeAt());
    // 冲突常见成因是空白/缩进差异（整文件被视为双方大改），忽略空白再试一次：
    // 结果树仍等于目标树 → 内容其实一致，判已合并
    if (verdict === 'conflict') {
      const v2 = judge(await mergeAt(['-Xignore-all-space']));
      if (v2 === 'merged') verdict = 'merged';
    }
    if (deepCache.size > 20000) deepCache.clear();
    deepCache.set(key, verdict);
    if (verdict === 'merged') map[sha] = true;
    else if (verdict === 'conflict') unsure[sha] = true;
  };
  const worker = async () => { while (idx < list.length) { const s = list[idx++]; await one(s); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));

  return { ok: true, map, unsure, truncated: shas.length > cap ? shas.length - cap : 0 };
}

async function branchRemote(dir, branch) {
  const r = await run(dir, ['config', '--get', 'branch.' + branch + '.remote'], { timeout: 20000 });
  if (r.ok && r.stdout.trim()) return r.stdout.trim();
  return 'origin';
}

/** 某个分支相对其上游的领先/落后提交数（用于「推送 N」提示） */
async function branchAheadBehind(dir, branch) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;
  const up = await run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', branch + '@{upstream}'], { timeout: 20000 });
  if (!up.ok || !up.stdout.trim()) return { ok: true, ahead: 0, behind: 0, upstream: '' };
  const upstream = up.stdout.trim();
  const ab = await run(root, ['rev-list', '--left-right', '--count', upstream + '...' + branch], { timeout: 30000 });
  if (!ab.ok) return { ok: true, ahead: 0, behind: 0, upstream };
  const parts = ab.stdout.trim().split(/\s+/);
  return { ok: true, ahead: parseInt(parts[1], 10) || 0, behind: parseInt(parts[0], 10) || 0, upstream };
}

/**
 * 拉取
 * mode = 'rebase'：把本地提交变基到远端最新之上（默认，符合团队习惯）
 * mode = 'ff'    ：只做快进
 * 远端分支（origin/xxx）只更新引用，不做任何本地改动
 */
async function pullBranch(dir, { branch, mode = 'rebase', autoStash = false } = {}) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;
  const logs = [];

  const remoteRef = await run(root, ['show-ref', '--verify', '--quiet', 'refs/remotes/' + branch], { timeout: 20000 });
  if (remoteRef.ok) {
    const remoteName = branch.split('/')[0];
    const fr = await run(root, ['fetch', remoteName, '--prune'], { timeout: 300000 });
    logs.push({ cmd: fr.cmd, ok: fr.ok, output: mergeOutput(fr) });
    if (!fr.ok) return { ok: false, error: '更新远端分支失败：\n' + mergeOutput(fr), logs };
    return { ok: true, logs, message: '已更新远端引用 ' + branch };
  }

  const op = await opState(root);
  if (op.operation) {
    return { ok: false, error: '仓库正处于「' + opLabel(op.operation) + '」过程中，请先完成或中止后再拉取。' };
  }

  const curR = await run(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 20000 });
  const current = curR.ok ? curR.stdout.trim() : '';
  const remote = await branchRemote(root, branch);

  // 工作区有改动：默认拒绝；用户确认后可自动暂存，拉取/变基完成后再恢复
  let stashed = false;
  if (current === branch) {
    const dirty = await getStatusShort(root);
    if (dirty.trim()) {
      if (!autoStash) {
        return {
          ok: false,
          error: '工作区有未提交的改动，' + (mode === 'rebase' ? '变基前' : '拉取前') + '请先提交或储藏：\n' +
            dirty.trim().split('\n').slice(0, 15).join('\n')
        };
      }
      const sp = await stashPush(root, { message: 'FastRelease 拉取前自动暂存' });
      logs.push({ cmd: 'git stash push -u', ok: sp.ok, output: sp.message || sp.error || '' });
      if (!sp.ok) return { ok: false, error: sp.error || '自动暂存失败', logs };
      stashed = sp.stashed;
    }
  }
  const restore = async (res) => {
    if (!stashed) return res;
    const pop = await stashPop(root);
    logs.push({ cmd: 'git stash pop', ok: pop.ok, output: pop.message || pop.error || '' });
    return {
      ...res,
      stashed: true,
      stashRestored: pop.ok,
      stashConflict: !!pop.conflict,
      stashFiles: pop.files || [],
      stashError: pop.ok ? '' : pop.error
    };
  };

  const fetchR = await run(root, ['fetch', remote, '--prune'], { timeout: 300000 });
  logs.push({ cmd: fetchR.cmd, ok: fetchR.ok, output: mergeOutput(fetchR) });
  if (!fetchR.ok) {
    return { ok: false, error: '拉取远端失败（网络或凭据问题）：\n' + mergeOutput(fetchR), logs };
  }

  if (current === branch) {
    const args = mode === 'ff'
      ? ['pull', '--ff-only', remote, branch]
      : ['pull', '--rebase', '--no-edit', remote, branch];
    const pullR = await run(root, args, { timeout: 300000, env: { GIT_EDITOR: 'true' } });
    logs.push({ cmd: pullR.cmd, ok: pullR.ok, output: mergeOutput(pullR) });

    if (pullR.ok) {
      return restore({ ok: true, logs, message: mode === 'ff' ? '已快进更新 ' + branch : '已变基到最新：' + branch });
    }

    const after = await conflictState(root);
    if (after.files.length) {
      // 冲突时暂存先留着，等解决完继续 / 中止再恢复
      return {
        ok: false,
        conflict: true,
        operation: after.operation || 'rebase',
        files: after.files,
        logs,
        stashed,
        error: '拉取时发生冲突（' + opLabel(after.operation || 'rebase') + '），请解决后继续。'
      };
    }
    return restore({
      ok: false,
      error: (mode === 'ff'
        ? '当前分支 ' + branch + ' 无法快进（本地有提交分叉）。可以把「拉取方式」改成变基再试。\n'
        : '变基失败：\n') + mergeOutput(pullR),
      logs
    });
  }

  // 非当前分支：只允许快进，避免影响当前工作区
  const ffR = await run(root, ['fetch', remote, branch + ':' + branch], { timeout: 300000 });
  logs.push({ cmd: ffR.cmd, ok: ffR.ok, output: mergeOutput(ffR) });
  if (!ffR.ok) {
    return {
      ok: false,
      error: '分支 ' + branch + ' 不是当前分支，无法在这里变基；且它无法快进（本地领先或已分叉）。\n请先切换到该分支，或手动处理。',
      logs
    };
  }
  return { ok: true, logs, message: '已更新 ' + branch };
}

function opLabel(op) {
  return { 'cherry-pick': '摘取 cherry-pick', rebase: '变基 rebase', merge: '合并 merge' }[op] || op;
}

async function checkoutBranch(dir, branch) {
  return run(dir, ['checkout', branch], { timeout: 120000 });
}

/**
 * 把一组提交排成「从旧到新」的安全顺序。
 *
 * 关键是不能用提交时间：同一次推送、批量脚本、squash 前的连续提交，时间戳
 * 常常完全相同（精度只到秒），按时间排会退化成输入顺序——而输入顺序是列表
 * 从上到下的「新→旧」，于是倒着摘，几处改动叠在同一块区域就必然冲突。
 *
 * 做法：`git rev-list --topo-order` 输出这些提交及其祖先（已按拓扑排序，父在前），
 * 只保留我们关心的那些，保持该顺序即为祖先优先；互不相干的分支再按时间兜底。
 */
async function orderCommits(root, list) {
  const wanted = new Set(list);
  if (wanted.size <= 1) return list.slice();
  const r = await run(root, ['rev-list', '--topo-order', '--reverse', ...list], { timeout: 60000 });
  if (r.ok) {
    const seq = r.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
    const ordered = seq.filter((sha) => wanted.has(sha));
    if (ordered.length === wanted.size) return ordered;
  }
  // 兜底：按作者/提交时间从旧到新（相同时间保持输入顺序的稳定排序）
  const metaR = await run(root, ['show', '-s', '--format=%H' + SEP + '%ct' + SEP + '%at', ...list], { timeout: 30000 });
  const order = new Map();
  const idx = new Map(list.map((s, i) => [s, i]));
  if (metaR.ok) {
    for (const line of metaR.stdout.split('\n')) {
      const f = line.split(SEP);
      if (f[0]) order.set(f[0].trim(), [parseInt(f[1], 10) || 0, parseInt(f[2], 10) || 0]);
    }
  }
  return list.slice().sort((a, b) => {
    const oa = order.get(a) || [0, 0];
    const ob = order.get(b) || [0, 0];
    return oa[0] - ob[0] || oa[1] - ob[1] || (idx.get(b) || 0) - (idx.get(a) || 0);
  });
}

/**
 * 摘取提交到目标分支
 */
async function cherryPick(dir, { target, commits, autoStash = false }) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;
  const logs = [];
  const list = (commits || []).filter(Boolean);
  if (!list.length) return { ok: false, error: '没有选择要摘取的提交' };

  const remoteCheck = await run(root, ['show-ref', '--verify', '--quiet', 'refs/remotes/' + target], { timeout: 20000 });
  if (remoteCheck.ok) {
    return { ok: false, error: '目标不能是远端分支 ' + target + '，请选择本地分支作为摘取目标。' };
  }

  const op = await opState(root);
  if (op.operation) {
    return { ok: false, error: '当前有未完成的「' + opLabel(op.operation) + '」，请先完成或中止后再操作。' };
  }

  // 工作区有改动：默认拒绝；用户确认后可自动暂存，摘取完成/中止后再恢复
  let stashed = false;
  const st = await getStatusShort(root);
  if (st.trim()) {
    if (!autoStash) {
      return { ok: false, error: '工作区有未提交的改动，请先提交或储藏：\n' + st.trim().split('\n').slice(0, 15).join('\n') };
    }
    const sp = await stashPush(root, { message: 'FastRelease 摘取前自动暂存' });
    logs.push({ cmd: 'git stash push -u', ok: sp.ok, output: sp.message || sp.error || '' });
    if (!sp.ok) return { ok: false, error: sp.error || '自动暂存失败', logs };
    stashed = sp.stashed;
  }
  // 暂存后若出错（非冲突），把改动还回去，别让用户的工作白丢
  const restore = async (res) => {
    if (!stashed) return res;
    const pop = await stashPop(root);
    logs.push({ cmd: 'git stash pop', ok: pop.ok, output: pop.message || pop.error || '' });
    return {
      ...res,
      stashed: true,
      stashRestored: pop.ok,
      stashConflict: !!pop.conflict,
      stashFiles: pop.files || [],
      stashError: pop.ok ? '' : pop.error
    };
  };

  // 提交顺序：从旧到新。不能用提交时间戳——同一次推送/批量生成的提交时间常常
  // 完全一样（同一秒），按时间排序会退化成原始顺序，等于倒着摘，必然冲突。
  // 因此优先按祖先关系排序（被依赖的提交在前），只在互不相干时才用时间兜底。
  const sorted = await orderCommits(root, list);

  const curR = await run(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 20000 });
  const current = curR.ok ? curR.stdout.trim() : '';
  if (current !== target) {
    const co = await checkoutBranch(root, target);
    logs.push({ cmd: co.cmd, ok: co.ok, output: mergeOutput(co) });
    if (!co.ok) {
      return restore({ ok: false, error: '切换到目标分支 ' + target + ' 失败：\n' + mergeOutput(co), logs });
    }
  }

  const r = await run(root, ['cherry-pick', '-x', ...sorted], { timeout: 300000 });
  logs.push({ cmd: r.cmd, ok: r.ok, output: mergeOutput(r) });

  if (r.ok) {
    return restore({ ok: true, logs, message: '已摘取 ' + sorted.length + ' 个提交到 ' + target, count: sorted.length });
  }

  const conflicted = await conflictState(root);
  const out = mergeOutput(r);
  if (conflicted.files.length) {
    // 冲突时暂存先不恢复：等用户解决完 continue / 中止之后再 pop
    return { ok: false, conflict: true, files: conflicted.files, logs, stashed, error: '摘取时发生冲突，请解决后继续。', output: out };
  }

  // 提交内容已在目标分支存在时，git 会停下并提示补丁为空。
  // 这里自动跳掉这些空提交，避免仓库停留在半截的 cherry-pick 状态。
  if (/now empty|nothing to commit|previous cherry-pick is now empty/i.test(out) && await isCherryPicking(root)) {
    const sk = await run(root, ['cherry-pick', '--skip'], { timeout: 120000 });
    logs.push({ cmd: sk.cmd, ok: sk.ok, output: mergeOutput(sk) });
    const after = await conflictState(root);
    if (after.files.length) {
      return {
        ok: false, conflict: true, files: after.files, logs, stashed,
        error: '部分提交内容已存在被自动跳过；剩余提交出现冲突，请解决。'
      };
    }
    if (await isCherryPicking(root)) {
      await run(root, ['cherry-pick', '--abort'], { timeout: 60000 });
      return restore({ ok: false, empty: true, logs, error: '所选提交的改动在目标分支上已全部存在，没有产生任何新提交。' });
    }
    return restore({ ok: true, empty: true, logs, message: '摘取完成：内容已存在的提交已自动跳过' });
  }

  return restore({ ok: false, error: '摘取失败：\n' + out, logs });
}

async function conflictState(dir) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return { files: [] };
  const root = repo.root;
  const [uR, op] = await Promise.all([
    run(root, ['diff', '--name-only', '--diff-filter=U'], { timeout: 30000 }),
    opState(root)
  ]);
  const files = uR.ok ? uR.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const stR = await run(root, ['status', '--porcelain=v1', '-uall'], { timeout: 30000 });
  const others = [];
  if (stR.ok) {
    for (const line of stR.stdout.split('\n')) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      const p = line.slice(3).trim();
      if (files.includes(p)) continue;
      others.push({ code, path: p });
    }
  }
  return { ok: true, root, files, others, cherryPicking: op.cherryPicking, operation: op.operation, rebaseBranch: op.rebaseBranch || '' };
}

function parseConflicts(text) {
  const lines = text.split('\n');
  const segments = [];
  let ctx = [];
  let i = 0;
  const pushCtx = () => {
    if (ctx.length) {
      segments.push({ type: 'context', lines: ctx });
      ctx = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('<<<<<<<')) {
      pushCtx();
      const oursLabel = line.slice(7).trim();
      let ours = [];
      let base = [];
      let theirs = [];
      let theirsLabel = '';
      i++;
      while (i < lines.length && !lines[i].startsWith('|||||||') && !lines[i].startsWith('=======')) {
        ours.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].startsWith('|||||||')) {
        i++;
        while (i < lines.length && !lines[i].startsWith('=======')) {
          base.push(lines[i]);
          i++;
        }
      }
      if (i < lines.length && lines[i].startsWith('=======')) {
        i++;
        while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
          theirs.push(lines[i]);
          i++;
        }
        if (i < lines.length) {
          theirsLabel = lines[i].slice(7).trim();
          i++;
        }
      }
      segments.push({ type: 'conflict', ours, base, theirs, oursLabel, theirsLabel });
    } else {
      ctx.push(line);
      i++;
    }
  }
  pushCtx();
  return segments;
}

async function readConflictFile(dir, relPath) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(path.resolve(root))) return { ok: false, error: '非法路径' };
  let content = '';
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { ok: false, error: '读取文件失败：' + e.message };
  }
  // 二进制文件无法用文本方式合并
  if (content.includes('\u0000')) {
    return { ok: true, path: relPath, absPath: abs, binary: true, content: '', segments: [], conflictCount: 0 };
  }
  const segments = parseConflicts(content);
  const conflictCount = segments.filter((s) => s.type === 'conflict').length;
  return { ok: true, path: relPath, absPath: abs, content, segments, conflictCount };
}

async function resolveBinaryFile(dir, { relPath, side }) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;
  const flag = side === 'ours' ? '--ours' : '--theirs';
  const co = await run(root, ['checkout', flag, '--', relPath], { timeout: 60000 });
  if (!co.ok) return { ok: false, error: mergeOutput(co) };
  const add = await run(root, ['add', '--', relPath], { timeout: 30000 });
  if (!add.ok) return { ok: false, error: mergeOutput(add) };
  const left = await conflictState(root);
  return { ok: true, remaining: left.files, cherryPicking: left.cherryPicking };
}

async function saveResolvedFile(dir, { relPath, content }) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(path.resolve(root))) return { ok: false, error: '非法路径' };
  try {
    fs.writeFileSync(abs, content, 'utf8');
  } catch (e) {
    return { ok: false, error: '写入失败：' + e.message };
  }
  const add = await run(root, ['add', '--', relPath], { timeout: 30000 });
  if (!add.ok) return { ok: false, error: '标记已解决失败：' + mergeOutput(add) };
  const left = await conflictState(root);
  return { ok: true, remaining: left.files, cherryPicking: left.cherryPicking };
}

/** 继续当前未完成的操作（cherry-pick / rebase） */
async function continueCherryPick(dir) {
  const root = (await ensureRepo(dir)).root;
  const op = await opState(root);
  if (!op.operation) return { ok: false, error: '当前没有进行中的操作' };

  const verb = op.operation === 'rebase' ? 'rebase' : 'cherry-pick';
  const r = await run(root, [verb, '--continue'], { timeout: 180000, env: { GIT_EDITOR: 'true' } });
  if (r.ok) return { ok: true, logs: [{ cmd: r.cmd, ok: true, output: mergeOutput(r) }] };

  const out = mergeOutput(r);
  const st = await conflictState(root);
  if (!st.files.length && /now empty|nothing to commit|previous cherry-pick is now empty|no changes/i.test(out)) {
    return { ok: false, empty: true, error: '这一步没有产生任何改动（空提交）', operation: op.operation };
  }
  return {
    ok: false,
    conflict: st.files.length > 0,
    files: st.files,
    operation: st.operation || op.operation,
    error: out || '继续失败'
  };
}

/** 中止当前未完成的操作并回滚 */
async function abortCherryPick(dir) {
  const root = (await ensureRepo(dir)).root;
  const op = await opState(root);
  if (!op.operation) return { ok: false, error: '当前没有进行中的操作' };
  const verb = op.operation === 'rebase' ? 'rebase' : (op.operation === 'merge' ? 'merge' : 'cherry-pick');
  const r = await run(root, [verb, '--abort'], { timeout: 120000 });
  return r.ok ? { ok: true } : { ok: false, error: mergeOutput(r) };
}

async function skipCherryPick(dir) {
  const root = (await ensureRepo(dir)).root;
  const op = await opState(root);
  if (!op.operation) return { ok: false, error: '当前没有进行中的操作' };
  const verb = op.operation === 'rebase' ? 'rebase' : 'cherry-pick';
  const r = await run(root, [verb, '--skip'], { timeout: 120000, env: { GIT_EDITOR: 'true' } });
  if (r.ok) return { ok: true };
  const st = await conflictState(root);
  return {
    ok: false,
    conflict: st.files.length > 0,
    files: st.files,
    operation: st.operation || op.operation,
    error: mergeOutput(r)
  };
}

async function pushBranch(dir, branch) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;
  const remote = await branchRemote(root, branch);

  const upR = await run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', branch + '@{upstream}'], { timeout: 20000 });
  const hasUpstream = upR.ok && upR.stdout.trim();

  const args = hasUpstream ? ['push', remote, branch] : ['push', '-u', remote, branch];
  const r = await run(root, args, { timeout: 300000 });
  const out = mergeOutput(r);
  if (r.ok) return { ok: true, output: out, message: '已推送 ' + branch };
  return { ok: false, error: out || '推送失败' };
}

async function commitDetail(dir, hash) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;
  const [statR, patchR] = await Promise.all([
    run(root, ['show', '--stat', '--format=%H%x1f%an%x1f%ad%x1f%s%x1f%b', '--date=iso-strict', '-n', '1', hash], { timeout: 60000 }),
    run(root, ['show', '--format=', '--patch', '--no-color', '-n', '1', hash], { timeout: 60000 })
  ]);
  if (!statR.ok) return { ok: false, error: mergeOutput(statR) };
  const f = statR.stdout.split(SEP);
  const header = {
    hash: (f[0] || '').trim(),
    author: f[1] || '',
    date: f[2] || '',
    subject: f[3] || '',
    body: (statR.stdout.split(SEP)[4] || '').split('\n--\n')[0].trim()
  };
  const stat = statR.stdout.split(SEP).slice(4).join(SEP).trim();
  let patch = patchR.ok ? patchR.stdout : '';
  const MAX = 400000;
  const truncated = patch.length > MAX;
  if (truncated) patch = patch.slice(0, MAX);
  return { ok: true, header, stat, patch, truncated };
}

/** 某个分支在时间范围内出现过的作者（用于「检测人」下拉），按提交数排序 */
async function listAuthors(dir, { ref, since = '', until = '' } = {}) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;
  if (!ref) return { ok: false, error: '请选择分支' };

  const args = ['log', ref, '--format=%an', '-n', '3000'];
  if (since) args.push('--since=' + since);
  if (until) args.push('--until=' + until);

  const [r, meR] = await Promise.all([
    run(root, args, { timeout: 60000 }),
    run(root, ['config', '--get', 'user.name'], { timeout: 20000 })
  ]);
  if (!r.ok) return { ok: false, error: mergeOutput(r) || '读取作者失败' };

  const counter = new Map();
  for (const line of r.stdout.split('\n')) {
    const name = line.trim();
    if (!name) continue;
    counter.set(name, (counter.get(name) || 0) + 1);
  }
  const authors = Array.from(counter.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));

  return { ok: true, authors, me: meR.ok ? meR.stdout.trim() : '' };
}

/** 读取冲突文件的三个暂存版本（:1:=base :2:=ours :3:=theirs），供外部合并工具使用 */
async function conflictStages(dir, relPath) {
  const root = (await ensureRepo(dir)).root;
  const read = async (stage) => {
    const r = await run(root, ['show', ':' + stage + ':' + relPath], { timeout: 30000 });
    return r.ok ? r.stdout : '';
  };
  const [base, ours, theirs] = await Promise.all([read(1), read(2), read(3)]);
  if (!ours && !theirs) return { ok: false, error: '读不到冲突版本（:1:/:2:/:3:）' };
  return { ok: true, base, ours, theirs };
}

/**
 * 合并检查：列出某人在源分支上、但目标分支里还没有等价补丁的提交。
 * 用 git cherry（patch-id 比对），所以 cherry-pick 过去、sha 变了的提交也算「已合并」。
 */
async function checkMerged(dir, { source, target, author = '', since = '', until = '' } = {}) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const root = repo.root;
  if (!source || !target) return { ok: false, error: '请选择源分支和目标分支' };
  if (source === target) return { ok: false, error: '源分支和目标分支不能相同' };

  // 作者过滤交给 git 自己做（--author 用正则匹配 %an），不要拉回全量再在 JS 里筛。
  const fmt = ['%H', '%h', '%an', '%ae', '%ad', '%ct', '%s'].join('%x1f');
  const args = ['log', source, '--date=iso-strict', '--pretty=format:' + fmt, '-n', '3000'];
  if (author) args.push('--author=' + author);
  if (since) args.push('--since=' + since);
  if (until) args.push('--until=' + until);

  const [lr, meR] = await Promise.all([
    run(root, args, { timeout: 60000 }),
    run(root, ['config', '--get', 'user.name'], { timeout: 20000 })
  ]);
  if (!lr.ok) {
    const msg = mergeOutput(lr);
    if (/unknown revision|bad revision|not a valid/i.test(msg)) {
      return { ok: false, error: '分支不存在或无法比较：\n' + msg };
    }
    return { ok: false, error: msg || '读取提交失败' };
  }

  let commits = lr.stdout.split('\n').filter(Boolean).map((line) => {
    const f = line.split(SEP);
    return {
      hash: f[0],
      short: f[1],
      author: f[2],
      email: f[3],
      date: f[4],
      timestamp: parseInt(f[5], 10) || 0,
      subject: f[6] || '',
      merged: false
    };
  });
  if (author) commits = commits.filter((c) => c.author === author);

  // 和「已摘取」徽标走同一套判定（mergedStatus），避免两处口径不一致
  const st = await mergedStatus(root, {
    source, target, since, until,
    only: commits.map((c) => c.hash),
    deepCap: 600
  });
  if (!st.ok) return { ok: false, error: st.error };

  let squashCount = 0;
  let maybeCount = 0;
  for (const c of commits) {
    if (st.patch.has(c.hash)) {
      c.merged = true;
      c.mergeKind = 'patch';
    } else if (st.content.has(c.hash)) {
      c.merged = true;
      c.mergeKind = 'squash';
      squashCount += 1;
    } else if (st.deep.has(c.hash)) {
      c.merged = true;
      c.mergeKind = 'deep';
      squashCount += 1;
    } else if (st.unsure.has(c.hash)) {
      c.maybe = true;
      maybeCount += 1;
    }
  }

  const unmerged = commits.filter((c) => !c.merged);
  return {
    ok: true,
    me: meR.ok ? meR.stdout.trim() : '',
    source,
    target,
    author,
    total: commits.length,
    unmergedCount: unmerged.length,
    mergedCount: commits.length - unmerged.length,
    squashCount,
    maybeCount,
    window: st.window,
    commits
  };
}

async function repoLog(dir, ref) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  const fmt = ['%h', '%s', '%an', '%ad'].join('%x1f');
  const r = await run(repo.root, ['log', ref, '-n', '1000', '--date=short', '--pretty=format:' + fmt], { timeout: 60000 });
  if (!r.ok) return { ok: false, error: mergeOutput(r) };
  const commits = r.stdout.split('\n').filter(Boolean).map((l) => {
    const f = l.split(SEP);
    return { short: f[0], subject: f[1], author: f[2], date: f[3] };
  });
  return { ok: true, commits };
}

module.exports = {
  run,
  repoInfo,
  opState,
  listBranches,
  listCommits,
  cherryFlags,
  patchFlags,
  contentFlags,
  deepFlags,
  workingChanges,
  workingDiff,
  stashPush,
  stashPop,
  stashFinish,
  stashAbort,
  branchAheadBehind,
  pullBranch,
  pushBranch,
  cherryPick,
  orderCommits,
  conflictState,
  readConflictFile,
  conflictStages,
  saveResolvedFile,
  resolveBinaryFile,
  continueCherryPick,
  abortCherryPick,
  skipCherryPick,
  commitDetail,
  repoLog,
  listAuthors,
  checkMerged,
  mergedStatus,
  mergeOutput
};
