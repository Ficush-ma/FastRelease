#!/usr/bin/env bash
# 重建测试仓库：bare 远端 + 工作副本 + dev/release 分叉提交
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rm -rf .tmpremote.git .tmprepo .tmpclone
git init --bare -q .tmpremote.git
git clone -q .tmpremote.git .tmprepo
cd .tmprepo
git config user.name "Test User"
git config user.email "test@example.com"
git config core.autocrlf false

printf "base\ncommon\n" > a.txt
printf "hello\n" > b.txt
git add .
git commit -qm "初始化项目"
git branch -M release
git push -q -u origin release
git checkout -qb dev
git push -q -u origin dev

printf "feature one\n" > c.txt
git add .
git commit -qm "feat: 新增 C 模块"

printf "base\ndev-feature\n" > a.txt
git add .
git commit -qm "fix: 调整 a.txt 第二行（dev）"

printf "feature three\n" > d.txt
git add .
git commit -qm "feat: 新增 D 模块"
git push -q

git checkout -q release
printf "base\nrelease-hotfix\n" > a.txt
git add .
git commit -qm "hotfix: 紧急修复 a.txt（release）"
git push -q

git checkout -q dev
git fetch -q
echo "fixture ready"
