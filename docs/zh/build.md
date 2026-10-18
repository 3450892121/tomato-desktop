# 构建与测试

[文档中心](../README.md) · [快速开始](getting-started.md) · [English](../en/build.md) · [AGENTS.md](../../AGENTS.md)

## 1. 环境

- Windows 10 / 11 64 位；
- Node.js 22+（自带 npm）；
- 约 3 GB 磁盘空间（依赖 + Electron + 加装包）。

```bash
cd app
npm install
npm start
```

中国大陆网络慢：

```bash
npm install --registry=https://registry.npmmirror.com
# PowerShell
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
```

## 2. 纯逻辑单测

```bash
cd app
npm test
```

包含现有纯逻辑测试 + MCP 21 项；不需要网络，也不需要加装包。

单个文件：

```bash
node tests/xxx.test.mjs
```

## 3. 自检与界面自动测试

```bash
cd app
.\node_modules\electron\dist\electron.exe . --smoke-test
.\node_modules\electron\dist\electron.exe . --ui-test
.\node_modules\electron\dist\electron.exe . --pdf-test
.\node_modules\electron\dist\electron.exe . --media-test
.\node_modules\electron\dist\electron.exe . --archive-test
```

结果写 `%TEMP%\tomato-*.json`，判定看 `pass:true` / `ok:true`；截图在 `%TEMP%\tomato-uitest`。

### 全量 29 项

```powershell
cd app
pwsh -File tools/run-all-self-tests.ps1            # 开发树
pwsh -File tools/run-all-self-tests.ps1 -Packaged  # 打包产物
```

结果：`%TEMP%\tomato-run-all.json`，日志 `%TEMP%\tomato-run-*.log`。

### 产物上的预期差异

- `--imghide-test`：`ok:true / verified:false`，`skipped` 含官方互通裁判（裁判不随包）；
- `--videodl-test`：`ok:true / verified:false`，`skipped` 只含「引擎更新全链路」（产物按 `VIDEODL_TEST_SKIP_UPDATE=1` 跳过联网更新）。

开发树交付前这两项要求 `verified:true`。

### 跑 `--ui-test` 前

清空 `app/userdata/settings.json`（它要求默认导航档案）。有自定义 `navOrder` 时 `navSort.resetHiddenInitially` 会失败。

## 4. MCP 专项

```bash
cd app
node tests/mcp.test.mjs          # 21 项
node tests/pack-mcp-smoke.mjs    # 9 项，针对 release 产物
```

覆盖：路径白名单、审计日志、只读模式、禁止覆盖、真实 ffmpeg / OCR / ASR / LibreOffice / pdfjs / Canvas、视频下载授权后真实下载。

## 5. 打包

```bash
cd app
npm run pack
```

产物：

```text
app/release/番茄图片混淆-桌面版-v<版本>-win64/
app/release/番茄图片混淆-桌面版-v<版本>-win64.zip
```

`pack.js` 会：

- 复制 Electron 运行时、应用源码、MCP、pdfjs legacy；
- 复制加装包（LibreOffice / ffmpeg / Real-ESRGAN / FunASR / OCR / 7-Zip / yt-dlp / HiBit）；
- 产物瘦身；
- 写 exe 图标 / 版本信息；
- 同步桌面快捷方式（目标 / 起始位置 / 图标）；
- 迁移上一版 `settings.json`；
- 删除旧版本产物（release 只保留最新）。

打包前先读 `app/tools/pack.js` 顶部注释；新增文件必须加进逐文件白名单。

## 6. 加装包

`app/addons/` 不进仓库，体积约 1.5 GB：

```text
addons/
├─ libreoffice/
├─ ffmpeg/
├─ realesrgan/
├─ asr/
├─ ocr/
├─ 7zip/
├─ ytdlp/
└─ hibit/
```

放置位置、版本、缺了会怎样：见 [`docs/加装包说明.txt`](../加装包说明.txt)。
许可与分发义务：见 [`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md)。

## 7. 新增工具

1. 复制 `app/src/tools/_template/` 为 `app/src/tools/<工具名>/`；
2. 改 `id` / `name` / `icon` / `group` / `order`；
3. 在 `app/src/shell/registry.js` 补 import 与工具清单；
4. 工具之间禁止互相 import；跨工具能力放 `src/shared/`；
5. 样式只写自己的 `styles.css`，颜色 / 字号 / 间距引用 `shell/theme.css`；
6. 新增文件与测试加进 `app/tools/pack.js` 白名单。

详见 [`新增工具指南.md`](../新增工具指南.md)。

## 8. 提交与发布

- 修 bug → `z+1`；加功能 → `y+1`；重要改动 → `x+1`；
- 每次改动建 commit；提交信息带 `fix:` / `feat:` / `docs:` / `chore:`；
- 交付前跑全量 29 项 + 产物 29 项 + `npm test` + `pack-mcp-smoke`；
- 打包成功后打 tag，并同步桌面快捷方式；
- release 目录只保留最新版本，旧版本靠 git tag 回溯。

更细的仓库纪律见 [`AGENTS.md`](../../AGENTS.md)。
