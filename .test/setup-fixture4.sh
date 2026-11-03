#!/usr/bin/env bash
# 合并检查用测试仓：dev 上有 Alice 两个提交、Bob 一个提交；release 只摘了 Alice 的第一个
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rm -rf .fcrepo
git init -q -b master .fcrepo
cd .fcrepo
git config user.name "Alice"
git config user.email "alice@example.com"
git config core.autocrlf false

printf "base\n" > base.txt
git add .
git commit -qm "初始化项目"

git checkout -q -b dev
printf "a1\n" > a1.txt
git add .
git commit -qm "feat: Alice 的提交一"

printf "a2\n" > a2.txt
git add .
git commit -qm "feat: Alice 的提交二"

printf "b1\n" > b1.txt
git add .
git -c user.name="Bob" -c user.email="bob@example.com" commit -qm "fix: Bob 的提交"

git checkout -q -b release master
A1=$(git log dev --format=%H --grep="Alice 的提交一" -n1)
git cherry-pick "$A1" >/dev/null 2>&1
printf "r\n" > r.txt
git add .
git commit -qm "chore: release 自己的提交"

git checkout -q dev
echo "fixture ready"
git log --format='%h %an %s' dev
