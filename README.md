# 番茄工具箱 桌面版

Windows 上的**免安装绿色版**文件处理工具箱：解压就能用，23 个工具按六组列在左侧导航里，
除「视频下载」外全部**纯离线**运行。做的都是日常杂活——图片混淆、格式转换、压缩解压、
PDF 与老文档处理、语音转文字、视频下载与压缩、把文件藏进图片。

- 目标用户是**非技术用户**：每个工具页自带图文说明，参数有合理默认值，输出文件绝不覆盖原文件。
- 「图片混淆」与安卓版同名 App 互相兼容：电脑上打的图手机能解，手机打的图电脑能解。
- 只有「视频下载」需要联网（它的本职就是下载网络视频）；断网时其余 22 个工具照常工作。

## 工具清单

| 分组 | 工具 |
|---|---|
| 图片 | 图片混淆 / 图片压缩 / 图片变清晰 / 图片格式转换 / 批量重命名 / 加水印 / 长图拼接 / 九宫格切图 / 文件藏图 |
| 视频 | 视频下载 / 视频播放器 / 视频格式转换 / 视频压缩 / 动图与视频互转 |
| 音频 | 音频格式转换 / 音频剪辑 / 语音转文字 |
| 文档 | PDF 转格式 / 文档格式转换 / PDF 编辑整理 / 文字识别 |
| 压缩 | 压缩与解压 |
| 系统 | 软件卸载 |

各工具的目标、边界、选型依据与已知限制写在 `spec/modules/` 里，一个模块一个文件；
全局地图见 `spec/00-overview.md`。

---

## 一、直接下成品包（不用碰代码）

Releases 里有免安装版 `tomato-desktop-v2.13.0-win64.zip`（约 812 MB）：解压到任意文件夹，
双击里面的 `番茄图片混淆桌面版.exe` 即可。配置写在同目录的 `userdata/` 里（不写注册表、不写系统目录），
整个文件夹拷给别人就是同一套东西；`docs/使用说明.txt` 随包分发给使用者。

成品包里已经放了 ffmpeg、LibreOffice、Real-ESRGAN、FunASR、OCR 模型、7-Zip、yt-dlp 等加装包。
出于第三方许可，包里**没有放**两样东西：

- HiBit Uninstaller（`addons/hibit/`）——官网未明文允许再分发。所以「软件卸载」工具会提示缺加装包；
  想去 HiBit 官网下便携版，把 `HiBitUninstaller-Portable.exe` 放进 `addons/hibit/` 就恢复，其余工具不受影响。
- 两个 `.heic` 自检夹具（`resources/app/tests/assets/`）——Nokia HEIF License 限定非商业测试用途。
  只影响开发者跑 `--media-test` 的 HEIC 段。

想自己打一份：按第二节装好依赖，把要随包的加装包放进 `app/addons/`（缺哪个就少哪个功能，打包会如实提示），
再跑 `npm run pack`，产物在 `app/release/` 里。

## 二、从源码跑起来

前置：Windows 10/11 64 位、Node.js 22+（自带 npm）。

```bash
cd app
npm install          # 装依赖（含 Electron）
npm start            # 打开软件窗口
npm test             # 纯逻辑单测（297 项，不需要网络，也不需要加装包）
npm run pack         # 打成免安装版，产物在 app/release/
```

中国大陆网络慢就用镜像：

```bash
npm install --registry=https://registry.npmmirror.com
# Electron 二进制走镜像（PowerShell）：
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
```

### 加装包（可选，但视频/文档/AI 类工具依赖它）

八个外部程序（ffmpeg、LibreOffice、Real-ESRGAN、FunASR、OCR 模型、7-Zip、yt-dlp、HiBit）
体积约 1.5 GB、许可各异，所以**不进仓库**；打包时由 `tools/pack.js` 从 `app/addons/<名字>/` 取用。

- 放哪个版本、放在哪、缺了会怎样：见 `docs/加装包说明.txt`
- 各自的许可与随分发要尽的义务：见 `THIRD-PARTY-NOTICES.md`
- 缺少某个加装包时，对应工具页显示引导并禁用按钮，**其它工具完全不受影响**

## 三、目录结构

```
app/
├─ main.js / preload.js      主进程与安全桥（窗口、文件对话框、子进程、IPC）
├─ src/shell/                工具箱框架：工具注册表、分组导航、工具页容器与保活、
│                            任务队列、设计令牌 theme.css、通用组件库
├─ src/tools/<工具名>/       一个工具一个目录，自包含：index.js（声明）+ ui.js + core/ + styles.css
│  └─ _template/             新工具空白模板
├─ src/shared/               跨工具复用能力：图片读写、ffmpeg 封装、HEIC 解码、文件封装、设置
├─ vendor/xlsx/              SheetJS 单文件（含 LICENSE 与来源说明）
├─ tests/                    纯逻辑单测 + 自检与界面自动测试
├─ tools/pack.js             打包脚本（产物瘦身、快捷方式同步、设置迁移；步骤注释即流程文档）
└─ addons/                   加装包（不入库）
docs/                        随包分发的《使用说明.txt》《加装包说明.txt》
spec/                        模块规格：目标、边界、选型依据、已知限制
```

## 四、加一个新工具（四条约定）

1. 复制 `app/src/tools/_template/` 为 `app/src/tools/<工具名>/`，改 `id` / `name` / `icon` / `group` / `order`。
2. 在 `app/src/shell/registry.js` 的 `TOOLS` 里加一行 import 与一项。
3. **工具之间禁止互相 import**；确实要复用的能力抽到 `src/shared/`。
4. 样式只写在自己的 `styles.css` 里，颜色 / 字号 / 间距必须引用 `shell/theme.css` 的变量——
   这样切换深色模式与调整主题时，工具侧不需要改代码。

新工具与新增测试文件都要加进 `tools/pack.js` 的文件白名单，否则产物里没有它们。

## 五、怎么验证改动

- `npm test`：纯逻辑单测；单个文件也可以 `node tests/xxx.test.mjs` 直接跑。
- 自检与界面自动测试通过 Electron 启动开关运行：

```bash
cd app
.\node_modules\electron\dist\electron.exe . --smoke-test      # 冒烟：工具数与 registry 实况一致
.\node_modules\electron\dist\electron.exe . --ui-test         # 图片混淆全流程，像素级校验
.\node_modules\electron\dist\electron.exe . --archive-test    # 压缩解压：13 种格式真实往返
```

结果写在 `%TEMP%\tomato-*.json`，看 `pass:true` / `ok:true` 判过；界面测试截图在 `%TEMP%\tomato-uitest`。
全部开关列在 `main.js` 顶部的注释里，每个工具的验证口径见 `spec/modules/` 对应模块的「测试」节。
两个注意：跑 `--ui-test` 前先清空 `userdata/settings.json`（它要求默认导航档案）；
「文件藏图」与「视频下载」的 `verified` 字段需要拿外部原版实现与联网更新项当裁判，
在纯净环境里 `ok:true / verified:false` 是预期结果。

## 六、已知限制

- 网站改版会让「视频下载」对特定站点解析失败（此类工具的固有风险）；软件内提供引擎自更新入口。
- 「图片变清晰」的 AI 放大需要 Vulkan 显卡；「语音转文字」为纯 CPU 推理，长音频要耐心。
- PDF → Word 对复杂排版会降级（提供两种输出方式以避开超大文档卡死）；带打开密码的文档无法转换。
- RAR 只支持解压（专有格式，免费工具无法创建），界面如实标注。
- HEIC 自检夹具因许可限制不随仓库分发，见 `app/tests/assets/说明.txt`。

## 许可与声明

- 本项目自有代码：MIT，见 `LICENSE`。
- 第三方组件与移植来源（leetools、SheetJS、pdf.js、ffmpeg、LibreOffice、7-Zip、yt-dlp 等）
  及其分发义务：见 `THIRD-PARTY-NOTICES.md`。
- 图片混淆模式与图夹容器的互通实现为独立编写，不含第三方应用的代码、资源或安装包。
- 请勿用本软件侵犯他人权益或规避合法的技术措施。软件按「原样」提供，不含任何担保。
