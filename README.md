# 番茄工具箱 桌面版

[中文](README.md) · [English](README.en.md) · [文档中心](docs/README.md) · [更新日志](CHANGELOG.md) · [Releases](https://github.com/3450892121/tomato-desktop/releases)

![番茄工具箱主界面：左边是工具分类，右边是「图片混淆」](docs/images/main.png)

**一个不用安装、双击就能用的 Windows 文件处理工具箱。** 图片、视频、音频、PDF、Office 文档、压缩包这些日常杂活，都收在同一个窗口里；解压即用，配置只写在软件自己的文件夹里，不碰系统。

- **给不懂技术的人用**：每个工具页都写了怎么操作，参数有合理默认值，输出不覆盖原文件。
- **基本不用联网**：除了「视频下载」（它本来就是下载网络视频），其余 22 个工具断网照常工作。
- **和手机版互通**：「图片混淆」和安卓 App「番茄图片混淆」互相能解开。
- **也能给 AI 用**：内置本地 MCP server，41 个工具；DSH 用户双击 `一键接入DSH.cmd` 即可，不用改 JSON、不用装 Node。

> **两个名字是同一个软件**：界面左上角写的是「番茄工具箱」，解压后双击的 exe 叫 `番茄图片混淆桌面版.exe`。最早是给手机版做电脑版，后来工具越加越多，界面名就改成了工具箱。

## 软件信息

| 项目 | 说明 |
|---|---|
| 版本 | **v2.15.0** |
| 系统 | Windows 10 / 11，64 位 |
| 安装 | **免安装**：解压就能用，删掉文件夹就是卸载 |
| 体积 | 压缩包约 820 MB，解压后约 1.6 GB |
| 联网 | 只有「视频下载」需要联网，其余断网可用 |
| 许可 | MIT（见 [`LICENSE`](LICENSE)），第三方声明见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) |

## 一、下载和打开

1. 打开 [Releases](https://github.com/3450892121/tomato-desktop/releases/latest)，下载
   `tomato-desktop-v2.15.0-win64.zip`（约 820 MB）。
2. 解压到任意文件夹——桌面、文档、U 盘都行，路径里有中文也没关系。
3. 双击 `番茄图片混淆桌面版.exe`。

第一次打开时，Windows 可能弹出蓝色提示「Windows 已保护你的电脑」——点「更多信息」→「仍要运行」即可。软件没有买数字签名，这个提示属于正常现象。

配置、缓存都写在软件文件夹的 `userdata/`，**不写注册表、不装系统目录**；换电脑把整个文件夹拷走就是同一套东西。

> 不会用？压缩包里自带 `使用说明.txt`，软件里点「帮助」也能看。更短的入门见 [快速开始](docs/zh/getting-started.md)。

## 二、里面有哪些工具

一共 **23 个**，按六组放在左侧导航（点分组标题可展开 / 收起）：

| 分组 | 工具 |
|---|---|
| 图片 | 图片混淆 · 图片压缩 · 图片变清晰 · 图片格式转换 · 批量重命名 · 加水印 · 长图拼接 · 九宫格切图 · 文件藏图 |
| 视频 | 视频下载 · 视频播放器 · 视频格式转换 · 视频压缩 · 动图与视频互转 |
| 音频 | 音频格式转换 · 音频剪辑 · 语音转文字 |
| 文档 | PDF 转格式 · 文档格式转换 · PDF 编辑整理 · 文字识别 |
| 压缩 | 压缩与解压 |
| 系统 | 软件卸载 |

每个工具的详细说明见 [工具清单](docs/zh/tools.md)；逐条验收与测试口径见 [`spec/acceptance.md`](spec/acceptance.md)。

第一次用建议先试：

- **图片混淆 / 解混淆**：把图片打乱成看不懂的样子，对方用同款软件或手机 App 还原；支持单张、批量、拖拽、剪贴板。
- **图片压缩 / 格式转换**：照片压小、转 JPG / PNG / WebP；手机拍的 HEIC 也能转。
- **文件藏图**：把任意文件藏进一张图片，图片照样能正常打开。
- **PDF 与老文档**：PDF 转图片、图片转 PDF、合并拆分、水印页码、加密解密；老版 Word / Excel / PPT 和「假 .xls」也能转新格式。
- **压缩与解压**：ZIP / 7Z / TAR 等十几种格式，支持密码、分卷、免解压预览。

## 三、给 AI 助手用（MCP）

软件内置一个本地 MCP server：41 个工具，覆盖 21 个 GUI 工具（视频播放器、软件卸载不暴露）。

**DSH 用户（推荐，不需要改 JSON / 装 Node）：**

1. 双击软件目录里的 `一键接入DSH.cmd`；
2. 完全退出 DeepSeek Harness（不是关窗口，是退出程序）再打开；
3. 直接说：「用番茄工具箱把这个文件夹的图片压到 500KB 以内」。

脚本会自动写 DSH 配置、安装 Skill、用软件自己的 exe 启动 MCP；想撤掉双击 `一键移除DSH接入.cmd`。

其它客户端（Claude Desktop / Qoder / Trae 等）的配置、工具清单、安全边界见：

- [Agent 接入说明（中文，详细）](docs/Agent接入说明.md)
- [Agent 文档（中文）](docs/zh/agent.md) · [Agent docs (English)](docs/en/agent.md)
- [MCP server README](app/mcp/README.md)
- [Skill 包](skills/tomato-toolbox/SKILL.md)

> **安全边界**：视频下载默认每次要你在软件里授权；大多数其它工具是「调用即执行」，没有确认弹窗。MCP 有路径白名单、审计日志、只读模式、禁止覆盖，但它**不是沙箱**。详见 [安全说明](docs/zh/security.md)。

## 四、本次更新（v2.15.0）

- **小白一键接入 DSH**：双击 `一键接入DSH.cmd`，自动写配置、装 Skill、用软件 exe 启动 MCP；不需要改 JSON、不需要装 Node；`一键移除DSH接入.cmd` 可撤回。
- **文档重构**：主 README + 子文档、中文 / English 双语、v2.15.0 更新说明。
- **v2.14.1 安全加固**（同批）：路径白名单、审计日志 `userdata/mcp-audit.jsonl`、只读模式、禁止覆盖。
- **v2.14.0 Agent 入口**：本地 MCP server、41 个工具、视频下载授权闸门、Skill 包。

完整更新见 [CHANGELOG.md](CHANGELOG.md) / [CHANGELOG.en.md](CHANGELOG.en.md)，本版说明见 [v2.15.0 release notes](docs/zh/releases/v2.15.0.md)。

## 五、浅色和深色

顶栏右上角可以一键切换「浅色 / 深色 / 跟随系统」，选择会记住。

![深色主题](docs/images/dark.png)

## 六、常见问题

**Q：双击没反应，或者被杀毒软件拦了？**
A：先看是不是 Windows SmartScreen 拦了（「更多信息」→「仍要运行」）。少数杀毒软件会对没有数字签名的绿色软件误报，加信任即可。除「视频下载」外不联网，可以断网验证。

**Q：需要安装吗？怎么卸载？**
A：不需要安装。解压就能用；不要了直接删掉整个文件夹。

**Q：需要联网吗？**
A：除「视频下载」外都不需要。断网时其余 22 个工具照常工作。

**Q：处理完的文件存在哪？会不会覆盖原图？**
A：默认存在原文件旁边，文件名加「-混淆」「-压缩」这类后缀，**不覆盖原文件**；重名自动加序号。也可以自己选目录。

**Q：换电脑怎么带走？**
A：把整个软件文件夹拷走即可。设置可以在「设置」里导出成一个文件，到新电脑再导入。

**Q：提示缺少加装包怎么办？**
A：Release 成品包已带齐 ffmpeg、LibreOffice、Real-ESRGAN、FunASR、OCR 模型、7-Zip、yt-dlp、HiBit。若你拿到的是精简版（部分分发因许可不带 HiBit），「软件卸载」按 [`docs/加装包说明.txt`](docs/加装包说明.txt) 放回 HiBit 便携版即可。

**Q：AI 里找不到番茄工具箱的工具？**
A：先确认完全退出并重启了 DSH；再确认 `~/.dsh/profiles/*/cordis.patch.yml` 里有 `mcp-tomato-toolbox`。详见 [Agent 接入说明](docs/Agent接入说明.md)。

**Q：视频下载为什么一直要授权？**
A：这是有意的安全闸门。到「视频下载」页点「允许一次」，或打开「允许 AI 助手直接下载（本次运行有效）」；关掉软件就失效。

更多见 [FAQ](docs/zh/faq.md)。

## 七、给开发者

前置：Windows 10 / 11 64 位、Node.js 22+（自带 npm）。

```bash
cd app
npm install          # 装依赖（含 Electron）
npm start            # 打开软件窗口
npm test             # 纯逻辑单测（不需要网络，也不需要加装包）
npm run pack         # 打成免安装版，产物在 app/release/
```

中国大陆网络慢就用镜像：

```bash
npm install --registry=https://registry.npmmirror.com
# PowerShell：
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
```

加装包（ffmpeg、LibreOffice、Real-ESRGAN、FunASR、OCR、7-Zip、yt-dlp、HiBit）体积约 1.5 GB、许可各异，**不进仓库**；打包时由 `app/tools/pack.js` 从 `app/addons/<名字>/` 取用。详见 [构建与测试](docs/zh/build.md)、[`docs/加装包说明.txt`](docs/加装包说明.txt)、[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

### 目录结构

```
app/
├─ main.js / preload.js      主进程与安全桥
├─ mcp/                     本地 MCP server（41 个工具）
├─ src/shell/               工具箱框架：注册表、导航、工具页保活、任务队列、主题
├─ src/tools/<工具名>/      一个工具一个目录：index.js + ui.js + core/ + styles.css
├─ src/shared/              跨工具复用：图片读写、ffmpeg、HEIC、设置
├─ tests/                   纯逻辑单测 + 自检 / 界面自动测试
├─ tools/pack.js            打包脚本
└─ addons/                  加装包（不入库）
docs/                        文档（中英双语 + 详细中文手册）
spec/                        模块规格与验收标准
skills/tomato-toolbox/       Agent Skill
```

### 怎么验证改动

```bash
cd app
.\node_modules\electron\dist\electron.exe . --smoke-test
.\node_modules\electron\dist\electron.exe . --ui-test
node tests/mcp.test.mjs
npm test
```

结果写在 `%TEMP%\tomato-*.json`，看 `pass:true` / `ok:true`。完整测试矩阵与产物差异见 [构建与测试](docs/zh/build.md) 和 [`spec/acceptance.md`](spec/acceptance.md)。

## 八、已知限制

- 网站改版会让「视频下载」对某些站点解析失败；软件内提供「更新引擎」入口。
- 「图片变清晰」的 AI 放大需要 Vulkan 显卡；「语音转文字」是纯 CPU 推理，长音频要等。
- PDF → Word 对复杂排版会降级；带打开密码的文档要先解密。
- RAR 只能解压，不能创建。
- 软件没有数字签名，部分杀毒软件会误报。
- 与手机版的兼容性仍需手机真机样本锁定，见 [`docs/兼容性变体说明.md`](docs/兼容性变体说明.md)。

## 许可与声明

- 本项目自有代码：MIT，见 [`LICENSE`](LICENSE)。
- 第三方组件与移植来源（leetools、SheetJS、pdf.js、ffmpeg、LibreOffice、7-Zip、yt-dlp 等）及分发义务：见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
- 图片混淆模式与图夹容器的互通实现为独立编写，不含第三方应用的代码、资源或安装包。
- 请勿用本软件侵犯他人权益或规避合法的技术措施。软件按「原样」提供，不含任何担保。
