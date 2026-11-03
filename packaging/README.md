# FastRelease

给「dev 开发 → release 上线」这套 cherry-pick 流程用的桌面小工具。左右两栏分别放两个分支的提交，勾选左边几个提交，一次摘取到右边，然后一键推送。

界面和交互参照 TortoiseGit：浅色、紧凑、工具栏 + 列表，冲突解决参照 TortoiseGitMerge 的三栏对照。

## 启动

双击本目录下的 **`FastRelease.exe`**（同目录其它文件是运行时，需要放在一起）。

首次使用选一次仓库和两个分支，之后会自动记住。

## 环境要求

- Windows 64 位
- Git for Windows（需要 `git` 在 PATH 里）

当前版本：1.1.6
