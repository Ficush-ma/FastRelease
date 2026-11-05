'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload || {});

contextBridge.exposeInMainWorld('api', {
  getConfig: () => invoke('config:get'),
  setConfig: (patch) => invoke('config:set', patch),

  repoInfo: (dir) => invoke('repo:info', { dir }),
  branches: (dir) => invoke('repo:branches', { dir }),
  commits: (payload) => invoke('repo:commits', payload),
  cherryFlags: (payload) => invoke('repo:cherryFlags', payload),
  patchFlags: (payload) => invoke('repo:patchFlags', payload),
  workingChanges: (dir) => invoke('repo:workingChanges', { dir }),
  logError: (payload) => invoke('app:logError', payload),
  workingDiff: (payload) => invoke('repo:workingDiff', payload),
  stashPop: (dir) => invoke('repo:stashPop', { dir }),
  stashFinish: (dir) => invoke('repo:stashFinish', { dir }),
  stashAbort: (dir) => invoke('repo:stashAbort', { dir }),
  branchAhead: (dir, branch) => invoke('repo:ahead', { dir, branch }),
  pull: (dir, branch, mode, autoStash) => invoke('repo:pull', { dir, branch, mode, autoStash }),
  push: (dir, branch) => invoke('repo:push', { dir, branch }),
  cherryPick: (payload) => invoke('repo:cherryPick', payload),
  orderCommits: (dir, commits) => invoke('repo:orderCommits', { dir, commits }),
  commitDetail: (dir, hash) => invoke('commit:detail', { dir, hash }),
  repoLog: (dir, ref) => invoke('repo:log', { dir, ref }),
  authors: (payload) => invoke('repo:authors', payload),
  checkMerged: (payload) => invoke('repo:checkMerged', payload),

  conflicts: (dir) => invoke('repo:conflicts', { dir }),
  readConflict: (dir, relPath) => invoke('conflict:read', { dir, relPath }),
  saveConflict: (payload) => invoke('conflict:save', payload),
  resolveBinary: (payload) => invoke('conflict:resolveBinary', payload),
  continueCherryPick: (dir) => invoke('conflict:continue', { dir }),
  abortCherryPick: (dir) => invoke('conflict:abort', { dir }),
  skipCherryPick: (dir) => invoke('conflict:skip', { dir }),

  pickFolder: (dir) => invoke('dialog:pickFolder', { dir }),
  openPath: (p) => invoke('shell:openPath', { path: p }),
  showItem: (p) => invoke('shell:showItem', { path: p }),
  externalMerge: (payload) => invoke('merge:external', payload)
});
