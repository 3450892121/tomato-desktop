# 第三方组件与许可声明

本仓库的**自有代码**采用 MIT 许可（见根目录 `LICENSE`）。以下部件来自第三方，各自遵守自己的许可；
本文件说明它们是什么、授权条款、以及随软件分发时你要额外尽到的义务。

---

## 1. npm 依赖（`app/package.json`）

| 包 | 版本 | 许可 | 用途 |
|---|---|---|---|
| electron | 44.4.2 | MIT | 桌面运行时（devDependency） |
| pdfjs-dist | 6.3.289 | Apache-2.0 | PDF 渲染与文本提取 |
| pdf-lib | 1.17.1 | MIT | PDF 页面操作 |
| @cantoo/pdf-lib | 2.11.1 | MIT | pdf-lib 活跃分支（加密 PDF 支持） |
| @cantoo/fontkit | 2.0.12 | MIT | 字体子集化（可搜索 PDF 的文字层） |
| docx-preview | 0.4.0 | Apache-2.0 | Word 预览（PDF 转格式的内置降级） |
| heic-decode | 2.1.0 | ISC | HEIC 解码入口 |
| libheif-js | 1.23.2 | LGPL-3.0 | HEIC 实际解码引擎（heic-decode 的依赖，见下条说明） |
| ppu-paddle-ocr | 6.6.0 | MIT | 文字识别运行时 |
| onnxruntime-node | 1.30.0 | MIT | OCR 推理引擎 |

`libheif-js` 是 LGPL-3.0：按**未修改的独立 npm 包**随包分发并保留其 `LICENSE`，不并入本项目代码。
你在自己的产品里替换或修改它时，需按 LGPL-3.0 提供该库的源码或修改版本。

---

## 2. 仓库内自带的第三方文件（已进 git）

| 位置 | 内容 | 许可 |
|---|---|---|
| `app/vendor/xlsx/xlsx.full.min.js` | SheetJS 社区版 0.20.3（官方分发货道 cdn.sheetjs.com），「PDF 转格式」的 xlsx 降级解析用 | Apache-2.0（同目录 `LICENSE`） |
| `app/src/tools/videodl/UPSTREAM-LICENSE.txt`、`UPSTREAM-NOTICE.txt` | 上游 leetools 的许可文本与署名，必须随分发保留 | MIT |

为什么 SheetJS 走 `vendor/` 而不走 npm：npm 上的 `xlsx` 停在 0.18.5，带已知漏洞
（CVE-2023-30533 原型污染、CVE-2024-22363 ReDoS），官方已不在 npm 发新版。详见同目录 `说明.txt`。

---

## 3. 移植来源（「视频下载」工具）

- 上游：`github.com/Lyee0011/leetools` 的 `video-downloader`，**MIT License, Copyright (c) 2026 Xiaoyi（小伊）**。
- 移植范围：下载引擎逻辑（yt-dlp 任务、抖音 / 央视频解析、网页兜底、音画校验、防覆盖、代理探测）
  与 B 站 yt-dlp 插件（`app/src/tools/videodl/plugins/leetools/`）。
- 未移植：HTTP 服务层、内嵌网页界面、bootstrap 下载脚本；界面为本项目重画。
- 义务：MIT 要求在所有副本中保留版权与许可声明——本仓库已在工具目录内附上游 `LICENSE` 文本与本文件说明。

---

## 4. 互通兼容（不含对方代码）

「图片混淆」的 6 种模式与「文件藏图」的容器格式，目标是与安卓版同名 App、以及外部「图夹」类网站/APP
**互相能解**。做法是把对方**可观察到的外部行为**（文件名规则、容器布局、分隔符、参数默认值、保存格式）
当作接口来对齐，代码全部由本项目自己编写：

- 本仓库不含对方的源代码、图标、素材或安装包。
- 图片混淆的规则来自对对方 APK 的可观察行为分析；「文件藏图」另参考了对方公网上未混淆的明文 worker。
  开发期把那份明文 worker 留在本机 `.tools/` 下当互通验证的「裁判」（已被 `.gitignore` 忽略，不入库、不随包分发）；
  该文件缺失时相关断言会如实标注「不可用」并跳过，不影响其余自检。
- 若权利人要求停止这种互操作，删除 `app/src/tools/imghide/` 与 `app/src/tools/obfuscate/` 即可整体下线这两个工具，其余工具不受影响。

---

## 5. 加装包（`app/addons/`，不进 git，打包时自备）

这些是独立可执行程序 / 模型，由 `tools/pack.js` 在打包时放入产物；本仓库**不分发**它们。
把它们随你的软件一起分发时，请按下表保留许可文本并尽到对应义务。

| 目录 | 组件 | 许可 | 你要尽的义务 |
|---|---|---|---|
| `addons/ffmpeg/` | FFmpeg 6.1.1 静态构建（gyan.dev release-essentials） | GPL v3 | 随分发附 `LICENSE.txt` 与版本来源说明，并提供源码获取途径（或用带 "GNU GPL" 配置的构建并附对应源码链接） |
| `addons/libreoffice/` | LibreOffice 26.2.6 | MPL-2.0（多许可之一） | 保留其 `LICENSE.html` / `license.txt` / `NOTICE`；改动其源码需按 MPL 开放该文件 |
| `addons/7zip/` | 7-Zip 26.03（7z.exe + 7z.dll） | LGPL-2.1+，其中 RAR 部分附 **unRAR 限制**（不得用该部分代码实现 RAR 压缩） | 保留 `License.txt`；本软件对 RAR 只做解压，界面也如实标注 |
| `addons/realesrgan/` | Real-ESRGAN v0.2.5.0（内含腾讯 ncnn 静态库） | BSD-3-Clause（Copyright (c) 2021, Xintao Wang） | 保留 `LICENSE.txt` 与版权声明 |
| `addons/asr/` | FunASR / SenseVoice 运行时与模型 | MIT（Copyright (c) 2025 FunASR） | 保留 `LICENSE.txt` |
| `addons/ocr/` | PP-OCRv5 模型 det.onnx / rec.onnx / dict.txt | Apache-2.0（PaddlePaddle） | 保留许可与来源说明 |
| `addons/ocr/fonts/` | Noto Sans SC 可变字体 | SIL Open Font License 1.1 | 允许随软件分发与嵌入文档；不得单独卖字体本身 |
| `addons/ytdlp/` | yt-dlp（PyInstaller 组合产物 exe） | 源码 Unlicense（公有领域）；exe 组合产物按 GPLv3+ 分发 | 附许可说明与对应源码版本；exe 含其它依赖，需一并保留其声明 |
| `addons/ytdlp/node/` | Node.js v22.20.0（可选，YouTube 挑战用） | MIT 及捆绑依赖许可 | 保留其 `LICENSE` |
| `addons/hibit/` | HiBit Uninstaller 4.0.10 便携版 | 官网标注「个人与商业使用均免费」，但**未明文许可再分发** | 风险提示：随包分发该 exe 的再分发权限依据不足。删除本目录即可整体下线「软件卸载」工具，其余工具不受影响 |

---

## 6. 测试素材（本仓库不附带）

`app/tests/assets/说明.txt` 记录了 HEIC 自检夹具的来源与准备方法：
nokiatech/heif 的公开样例图采用 **Nokia HEIF License v2.1**，其授权范围限定为非商业的评估 / 测试 / 学术研究，
与本项目源码的 MIT 许可不兼容，所以这两个 `.heic` 文件不在本仓库内。
自行下载放入即可运行 `--media-test` 的 HEIC 段，或改用你自己设备拍摄的 HEIC。

---

## 7. 一句话总结

- 你自己的改动与本项目代码：MIT，随便用，保留版权声明即可。
- 上面第 1、2、3 条：跟着走就行，声明已随仓库附好。
- 第 5 条加装包：**分发编译产物时才产生义务**（GPL/LGPL 的源码提供、许可文本保留），逐条按要求带文件。
- 第 4 条互通、第 6 条素材：不含对方代码；素材需要你自己下载。
