# FastRelease

给「dev 开发 → release 上线」这套 cherry-pick 流程用的桌面小工具。左右两栏分别放两个分支的提交，勾选左边几个提交，一次摘取到右边，然后一键推送。

界面和交互参照 TortoiseGit：浅色、紧凑、工具栏 + 列表，冲突解决参照 TortoiseGitMerge 的三栏对照。

## 启动

- 双击目录里的 **`FastRelease.bat`**（推荐，无控制台窗口）
- 或者命令行 `npm start`
- 第一次使用（新机器）需要先装依赖：`npm install`

启动后会记住上次打开的仓库、上次选的两个分支。

## 打包成 exe

```
npm install     # 第一次
npm run dist    # 打包，产物在 dist/
```

产物：

- `dist/FastRelease-1.1.6-win64/FastRelease.exe` —— 直接双击运行
- `dist/FastRelease-1.1.6-win64.zip` —— 整个运行目录的压缩包（约 113MB）

## 环境要求

- Windows + Git for Windows（需要 `git` 在 PATH 里）
- Node.js 18+（仅首次 `npm install` 和打包时需要）

改代码后重启应用即可生效，不需要构建步骤。
