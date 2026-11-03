#!/usr/bin/env bash
# 模拟用户真实仓库结构：dev 只在远端，本地是 release-XXXX
# 注意：本机沙箱会拦截 git 写 refs/remotes，这里手工补远端引用文件（仅测试环境用）
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rm -rf .fxremote.git .fxrepo .fxother
git init --bare -q .fxremote.git
git clone -q .fxremote.git .fxrepo
cd .fxrepo
git config user.name "Test User"
git config user.email "test@example.com"
git config core.autocrlf false

mkref() { # mkref <branch> <sha>
  mkdir -p ".git/refs/remotes/origin"
  printf "%s\n" "$2" > ".git/refs/remotes/origin/$1"
}

printf "base\ncommon\n" > a.txt
printf "hello\n" > b.txt
git add .
git commit -qm "初始化项目"
git branch -M master
git push -q -u origin master
mkref master "$(git rev-parse master)"

# 远端 dev 分支（本地建完就删，保证只存在于远端）
git checkout -q -b dev-20251112
printf "base\ndev-feature\n" > a.txt
git add .
git commit -qm "fix: dev 修改 a.txt 第二行"
printf "feature d1\n" > d1.txt
git add .
git commit -qm "feat: dev 新增 D1 模块"
DEV_SHA=$(git rev-parse dev-20251112)
git push -q -u origin dev-20251112
mkref dev-20251112 "$DEV_SHA"
git checkout -q master
git branch -q -D dev-20251112

# 本地 release 分支
git checkout -q -b release-1028
printf "release-only\n" > r.txt
git add .
git commit -qm "chore: release 初始化"
git push -q -u origin release-1028
mkref release-1028 "$(git rev-parse release-1028)"

# 本地先摘一个 dev 提交（模拟已经 cherry-pick 过）
D1=$(git log "$DEV_SHA" --format=%H --grep="dev 修改 a.txt" -n1)
git cherry-pick "$D1" >/dev/null 2>&1 || {
  printf "base\ndev-feature\n" > a.txt
  git add a.txt
  GIT_EDITOR=true git cherry-pick --continue >/dev/null 2>&1
}

# 远端另一个人给 release 推了新提交，且改了 a.txt（制造变基冲突）
git clone -q ../.fxremote.git ../.fxother
cd ../.fxother
git config user.name "Other"
git config user.email "o@example.com"
git checkout -q release-1028
printf "base\nremote-change\n" > a.txt
printf "other\n" > o.txt
git add .
git commit -qm "hotfix: 远端修复 a.txt"
git push -q origin release-1028
OTHER_SHA=$(git rev-parse release-1028)

cd "$ROOT/.fxrepo"
git fetch -q origin 2>/dev/null || true   # 先把对象拉下来（本机 refs/remotes 写不进去，下面手工补）
mkref release-1028 "$OTHER_SHA"
git checkout -q release-1028
echo "fixture ready"
echo "本地 release-1028:"; git log --oneline -3
echo "远端 release-1028:"; git log --oneline -3 "$OTHER_SHA"
echo "远端 dev:"; git log --oneline -3 "$DEV_SHA"
