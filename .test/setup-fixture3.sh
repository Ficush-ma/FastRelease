#!/usr/bin/env bash
# 用于验证「切换分支自动刷新」的测试仓库（纯本地分支，不涉及远端）
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rm -rf .ftrepo
git init -q -b master .ftrepo
cd .ftrepo
git config user.name "Test User"
git config user.email "test@example.com"
git config core.autocrlf false

printf "base\n" > base.txt
git add .
git commit -qm "初始化项目"

git checkout -q -b dev
printf "a\n" > a.txt
git add .
git commit -qm "feat: dev 新增 A"
printf "shared b\n" > b.txt
git add .
git commit -qm "feat: dev 新增 B"

git checkout -q -b release master
B=$(git log dev --format=%H --grep="新增 B" -n1)
git cherry-pick "$B" >/dev/null 2>&1
printf "release\n" > r.txt
git add .
git commit -qm "chore: release 自己的提交"

git checkout -q -b hotfix master
printf "hotfix only\n" > h.txt
git add .
git commit -qm "fix: hotfix 独立提交"

git checkout -q dev
echo "fixture ready"
git branch --format='%(refname:short)'
