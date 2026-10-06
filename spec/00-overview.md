# 00-overview — 番茄图片混淆 桌面版

## 项目定位
把安卓端同名 App 的图片混淆 / 解混淆能力重写到 Windows 电脑上，做成**解压即用的免安装绿色软件**：纯离线、与手机版互相兼容。
软件按**工具箱**形态搭建：左侧列出所有工具，右侧是当前工具的界面；「图片混淆」是第一个工具，其余工具按同一套模板低成本接入。

## 目标用户
- 主要使用者：作者身边的朋友/同事（非技术用户，需要傻瓜化操作与内置说明）。
- 使用场景：在电脑上对图片做混淆（打乱像素，防内容被直接识别）与解混淆（还原原图）；后续扩展为常用文件处理工具箱。

## 总体边界

**做什么**
1. 工具箱框架：左侧分组导航 + 工具注册机制 + 新工具模板；一个工具一个自包含目录。
2. 第一个工具「图片混淆」做完整：6 种混淆/解混淆模式（空间曲线(番茄图 gilbert)、方块混淆(B)、像素混淆(C)、行像素混淆(C2)、兼容PE 行模式(PE1)、兼容PE 行+列(PE2)），与安卓版互相兼容。
3. 在此基础上扩展为常用文件处理工具箱：图片 / 视频 / 音频 / 文档 / 压缩 / 系统 六组共 23 个工具，各自目标与边界见 `modules/`。
4. 单张处理 + 批量处理（多文件 / 整个文件夹）；拖拽进窗口、剪贴板粘贴、复制或另存结果。
5. 可调参数与本地持久化：方块数（默认 32×32）、JPG 画质（默认 95）、默认密钥（默认 0.666）、输出目录与重名规则等。
6. 内置图文帮助与《使用说明.txt》，每种模式、密钥规则、兼容性注意事项都写得让非技术用户能看懂。

**明确不做什么**
1. 不做手机端 App；不改动安卓版既有算法与默认参数（只做「相同规则」的实现与可调覆盖）。
2. 除「视频下载」（`modules/videodl.md`，**天生需要联网**，是本清单唯一例外）外全部纯离线：无更新检查、无云同步、无账号。
3. 不做通用图片编辑器（图层、滤镜链、手写批注）——只做工具箱里成型的处理工具。
4. 工具之间不互相依赖；新功能一律新目录 + registry 一行，不改既有工具。

## 模块划分（与 modules/ 一一对应）
| 模块 | 文件 | 一句话职责 |
|---|---|---|
| 工具箱框架 | `modules/toolkit.md` | 工具注册、左侧导航、工具生命周期、新工具接入约定 |
| 算法引擎 | `modules/engine.md` | 6 种模式的正/反向像素重排，密钥解析（属「图片混淆」工具） |
| 图片读写 | `modules/imageio.md` | 解码/编码图片、填充与格式规则（gilbert→JPG q95，其余→PNG），跨工具共享 |
| 界面交互 | `modules/ui.md` | 现代风外观（浅色/深色见 `theme`）、工具导航、预览、拖拽、剪贴板、进度 |
| 批量与文件 | `modules/batch.md` | 多文件/文件夹导入、批量处理与保存命名（属「图片混淆」工具） |
| 参数设置 | `modules/settings.md` | 可调参数与本地持久化，跨工具共享 |
| 外观主题 | `modules/theme.md` | 浅色/深色/跟随系统；只覆盖主题变量，工具零改动适配 |
| 跨工具任务队列 | `modules/task-queue.md` | 任务归属队列（不归属工具页）+ 任务中心；切走工具页任务照跑 |
| 设置导入导出 | `modules/settings-io.md` | 设置备份成 json，换电脑一键带走（只合并已知键） |
| PDF 转格式 | `modules/pdf-convert.md` | PDF/图片/Office 互转与页面操作（第二个工具；LibreOffice 为可选加装包） |
| 文档格式转换 | `modules/doc-convert.md` | 老版办公文档（doc/xls/ppt/pps/rtf，含 Excel 2003 XML「假 .xls」）→ docx/xlsx/pptx/PDF（LibreOffice 随包） |
| PDF 编辑整理 | `modules/pdf-edit.md` | 压缩瘦身 / 水印 / 页码 / 旋转 / 重排 / 加密解密 |
| 文字识别 | `modules/ocr.md` | 扫描件 → 可搜索 PDF / 纯文本 / Word；预处理与压缩（ocr 加装包） |
| 图片压缩 | `modules/image-compress.md` | 批量压缩图片体积（画质/尺寸/目标大小），纯内核能力 |
| 图片变清晰 | `modules/image-enhance.md` | 锐化/降噪/明暗微调/清晰放大（USM，非 AI 超分） |
| 图片格式转换 | `modules/image-convert.md` | PNG/JPG/WebP/BMP/ICO/TIFF/GIF/AVIF 互转 |
| 图片批量工具 | `modules/image-batch.md` | 批量重命名 / 加水印 / 长图拼接 / 九宫格切图（四个小工具，纯 canvas） |
| 文件藏图 | `modules/imghide.md` | 把文件藏进图片 / 从图片取出文件（与外部「图夹」V6 容器格式双向互通；PNG·GIF 载体 + 密码） |
| 视频播放器 | `modules/player.md` | 软件内直接播视频；内核不认的格式自动换封装/重编码（ffmpeg 随包） |
| 视频下载 | `modules/videodl.md` | 粘贴链接下载网络视频（抖音/小红书/B站/YouTube/央视频/直链）；引擎可自更新（ytdlp 随包） |
| 视频格式转换 | `modules/video-convert.md` | MP4/WebM/MKV/MOV/AVI 互转（ffmpeg 随包） |
| 视频压缩 | `modules/video-compress.md` | 按画质档 / 目标体积压小视频（两遍编码 + 不达标自动重跑） |
| 动图与视频互转 | `modules/sticker-video.md` | GIF/WebP 动图/APNG ↔ 视频，含聊天表情预设 |
| 音频格式转换 | `modules/audio-convert.md` | 21 种音频格式互转 + 视频提取声音（ffmpeg 随包；APE/DSD 等可读） |
| 音频剪辑 | `modules/audio-edit.md` | 波形选区截取、多段拼接、淡入淡出、音量标准化 |
| 语音转文字 | `modules/transcribe.md` | 音频/视频 → 文字（中英日韩粤自动识别；字幕 SRT 可选；asr 加装包随包） |
| 文件压缩与解压 | `modules/archive.md` | 多格式压缩/解压（主流 + 非主流双向、RAR 等仅解压）、密码、分卷、免解压预览（7zip 加装包随包） |
| 软件卸载 | `modules/uninstall.md` | 一键启动随包内置的 HiBit 卸载工具（管理员权限；含残留清理） |

## 代码结构约定（新增工具时只动 tools/ 与 registry 一行）
```
app/src/
├─ shell/            框架：工具页容器（页面保活）、左侧导航、工具注册表、设计令牌、通用组件库
├─ tools/            一个工具一个文件夹（自包含：声明 + 界面 + 逻辑 + 样式）
│  ├─ obfuscate/     图片混淆（第一个工具）
│  ├─ pdf-convert/   PDF 转格式（第二个工具，见 modules/pdf-convert.md）
│  └─ _template/     新工具空白模板（复制改名即可）
└─ shared/           跨工具复用：图片读写、文件封装、设置读写
```
- 工具之间不互相依赖；要复用的能力一律放 `shared/`。
- 新增工具 = 复制 `_template` 文件夹改名 + 在 `shell/registry.js` 加一行；不改任何既有工具代码。

## 技术栈与运行环境
- Electron（自带内核的桌面框架）+ 原生 HTML/CSS/JS；不引入重型第三方依赖（PDF 工具使用纯 JS 的 pdfjs-dist / pdf-lib，仍属轻量；LibreOffice 仅作为可选加装包，不进主安装包）。
- 视频类工具随包分发 **ffmpeg 6.1.1 静态构建**（单文件 82.8 MB，GPL v3，来源与许可见 `addons/ffmpeg/说明.txt`）——这是「解压即用」的必要代价；无 ffmpeg 时其余工具不受影响。
- 目标系统：Windows 10/11 64 位。
- 交付形态：解压即用的绿色文件夹；版本起点 v1.0.0。

## 关键事实来源
- 混淆/解混淆的容器格式与模式规则由本人独立实现，只以「与安卓版互通」的可观察行为为对齐目标，不含、也不来源对方应用代码。
- 生态参考实现（交叉印证）：网页版「小番茄」JS 实现（gilbert）、`pyscramble`（Rust，MIT）、`PicEncrypt`（PE1/PE2 出处，开源）。
- 未证实项：PE1/PE2 native 内部「链式细节」存在两种候选实现，须用与安卓版互通的真机样本实测锁定。
- 上游参考实现：`github.com/Lyee0011/leetools`（`video-downloader`，自有代码 MIT）——「视频下载」工具的引擎与站点适配来源；移植范围、许可义务与加固改动见 `modules/videodl.md`。