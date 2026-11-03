'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SEP = '\x1f';

/**
 * 执行 git 命令（不经 shell，参数数组传递，避免转义问题）
 */
function run(cwd, args, opts = {}) {
  const { timeout = 60000, env = {} } = opts;
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
    try { child.stdin.end(); } catch (_) { /* ignore */ }
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
  const args = ['log', ref, '--date=iso-strict', '--pretty=format:' + fmt];
  const kw = (search || '').trim();
  const isHashLike = /^[0-9a-fA-F]{4,40}$/.test(kw);

  let useClientFilter = false;
  if (kw && !isHashLike) {
    args.push('-i', '--grep=' + kw, '--fixed-strings');
  } else if (kw && isHashLike) {
    useClientFilter = true;
  }
  if (since) args.push('--since=' + since);
  if (until) args.push('--until=' + until);
  if (author) args.push('--author=' + author);

  const pageLimit = useClientFilter ? 5000 : limit;
  const pageSkip = useClientFilter ? 0 : skip;
  args.push('-n', String(pageLimit));
  if (pageSkip > 0) args.push('--skip', String(pageSkip));

  const r = await run(root, args, { timeout: 60000 });
  if (!r.ok) return { ok: false, error: mergeOutput(r) || '读取提交失败' };

  let commits = r.stdout.split('\n').filter(Boolean).map((line) => {
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

  // --author 是子串/正则匹配，再精确过滤一次，避免 "Bob" 匹配到 "Bob Lee"
  if (author) commits = commits.filter((c) => c.author === author);

  if (useClientFilter) {
    const low = kw.toLowerCase();
    commits = commits.filter((c) => c.hash.toLowerCase().startsWith(low));
    commits = commits.slice(skip, skip + limit);
  }

  return { ok: true, commits, hasMore: useClientFilter ? false : commits.length >= limit };
}

/**
 * 用 git cherry 标记「补丁已存在于目标分支」的提交
 */
async function cherryFlags(dir, { target, source }) {
  const repo = await ensureRepo(dir);
  if (!repo.ok) return repo;
  if (!target || !source) return { ok: true, map: {} };
  const r = await run(repo.root, ['cherry', target, source], { timeout: 60000 });
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
async function pullBranch(dir, { branch, mode = 'rebase' } = {}) {
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

  if (current === branch) {
    const dirty = await getStatusShort(root);
    if (dirty.trim()) {
      return {
        ok: false,
        error: '工作区有未提交的改动，' + (mode === 'rebase' ? '变基前' : '拉取前') + '请先提交或储藏：\n' +
          dirty.trim().split('\n').slice(0, 15).join('\n')
      };
    }
  }

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
      return { ok: true, logs, message: mode === 'ff' ? '已快进更新 ' + branch : '已变基到最新：' + branch };
    }

    const after = await conflictState(root);
    if (after.files.length) {
      return {
        ok: false,
        conflict: true,
        operation: after.operation || 'rebase',
        files: after.files,
        logs,
        error: '拉取时发生冲突（' + opLabel(after.operation || 'rebase') + '），请解决后继续。'
      };
    }
    return {
      ok: false,
      error: (mode === 'ff'
        ? '当前分支 ' + branch + ' 无法快进（本地有提交分叉）。可以把「拉取方式」改成变基再试。\n'
        : '变基失败：\n') + mergeOutput(pullR),
      logs
    };
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
 * 摘取提交到目标分支
 */
async function cherryPick(dir, { target, commits }) {
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

  const st = await getStatusShort(root);
  if (st.trim()) {
    return { ok: false, error: '工作区有未提交的改动，请先提交或储藏：\n' + st.trim().split('\n').slice(0, 15).join('\n') };
  }

  // 提交顺序：按提交时间从旧到新
  const metaR = await run(root, ['show', '-s', '--format=%H%x1f%ct', ...list], { timeout: 30000 });
  const order = new Map();
  if (metaR.ok) {
    for (const line of metaR.stdout.split('\n')) {
      const f = line.split(SEP);
      if (f[0]) order.set(f[0].trim(), parseInt(f[1], 10) || 0);
    }
  }
  const sorted = list.slice().sort((a, b) => (order.get(a) || 0) - (order.get(b) || 0));

  const curR = await run(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 20000 });
  const current = curR.ok ? curR.stdout.trim() : '';
  if (current !== target) {
    const co = await checkoutBranch(root, target);
    logs.push({ cmd: co.cmd, ok: co.ok, output: mergeOutput(co) });
    if (!co.ok) {
      return { ok: false, error: '切换到目标分支 ' + target + ' 失败：\n' + mergeOutput(co), logs };
    }
  }

  const r = await run(root, ['cherry-pick', '-x', ...sorted], { timeout: 300000 });
  logs.push({ cmd: r.cmd, ok: r.ok, output: mergeOutput(r) });

  if (r.ok) {
    return { ok: true, logs, message: '已摘取 ' + sorted.length + ' 个提交到 ' + target, count: sorted.length };
  }

  const conflicted = await conflictState(root);
  const out = mergeOutput(r);
  if (conflicted.files.length) {
    return { ok: false, conflict: true, files: conflicted.files, logs, error: '摘取时发生冲突，请解决后继续。', output: out };
  }

  // 提交内容已在目标分支存在时，git 会停下并提示补丁为空。
  // 这里自动跳掉这些空提交，避免仓库停留在半截的 cherry-pick 状态。
  if (/now empty|nothing to commit|previous cherry-pick is now empty/i.test(out) && await isCherryPicking(root)) {
    const sk = await run(root, ['cherry-pick', '--skip'], { timeout: 120000 });
    logs.push({ cmd: sk.cmd, ok: sk.ok, output: mergeOutput(sk) });
    const after = await conflictState(root);
    if (after.files.length) {
      return {
        ok: false, conflict: true, files: after.files, logs,
        error: '部分提交内容已存在被自动跳过；剩余提交出现冲突，请解决。'
      };
    }
    if (await isCherryPicking(root)) {
      await run(root, ['cherry-pick', '--abort'], { timeout: 60000 });
      return { ok: false, empty: true, logs, error: '所选提交的改动在目标分支上已全部存在，没有产生任何新提交。' };
    }
    return { ok: true, empty: true, logs, message: '摘取完成：内容已存在的提交已自动跳过' };
  }

  return { ok: false, error: '摘取失败：\n' + out, logs };
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

  // 1) 先算出时间下界对应的基点提交，把 git cherry 的比对范围限制在「最近这段历史」，
  //    否则它会对两个分支的全量历史算 patch-id，大仓库上非常慢。
  let limitRef = '';
  if (since) {
    const baseR = await run(root, ['rev-list', '-1', '--before=' + since, source], { timeout: 30000 });
    if (baseR.ok) limitRef = baseR.stdout.trim();
  }

  const cherryArgs = ['cherry', target, source];
  if (limitRef) cherryArgs.push(limitRef);
  const [cr, meR] = await Promise.all([
    run(root, cherryArgs, { timeout: 300000 }),
    run(root, ['config', '--get', 'user.name'], { timeout: 20000 })
  ]);
  if (!cr.ok) {
    const msg = mergeOutput(cr);
    if (/unknown revision|bad revision|not a valid/i.test(msg)) {
      return { ok: false, error: '分支不存在或无法比较：\n' + msg };
    }
    return { ok: false, error: msg || 'git cherry 执行失败' };
  }

  // '+' = 目标分支没有等价补丁（未合并）；'-' = 已有等价补丁
  const unmergedSet = new Set();
  for (const line of cr.stdout.split('\n')) {
    if (!line.trim()) continue;
    if (line[0] === '+') unmergedSet.add(line.slice(2).trim());
  }

  // 2) 作者过滤交给 git 自己做（--author 用正则匹配 %an），不要拉回全量再在 JS 里筛。
  const fmt = ['%H', '%h', '%an', '%ae', '%ad', '%ct', '%s'].join('%x1f');
  const args = ['log', source, '--date=iso-strict', '--pretty=format:' + fmt, '-n', '3000'];
  if (author) args.push('--author=' + author);
  if (since) args.push('--since=' + since);
  if (until) args.push('--until=' + until);

  const lr = await run(root, args, { timeout: 60000 });
  if (!lr.ok) return { ok: false, error: mergeOutput(lr) || '读取提交失败' };

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
      merged: !unmergedSet.has(f[0])
    };
  });

  if (author) commits = commits.filter((c) => c.author === author);

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
  branchAheadBehind,
  pullBranch,
  pushBranch,
  cherryPick,
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
  mergeOutput
};
