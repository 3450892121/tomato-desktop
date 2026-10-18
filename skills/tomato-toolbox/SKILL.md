---
name: tomato-toolbox
description: 用本地「番茄工具箱」处理图片/视频/音频/文档/压缩文件。当用户要求批量压缩图片、图片混淆/解混淆、文件藏图、视频转码/压缩、动图互转、音频转换/剪辑、语音转文字、PDF/Word/Excel/PPT 文档转换（含手机打不开的 xls/xlsx/doc/docx/ppt）、OCR、或压缩解压时使用。优先调用 tomato-toolbox MCP 工具，不要自己拼 ffmpeg/7z/Python/Excel 命令。
whenToUse: 用户要在本机处理媒体/文档文件。涉及「压缩、转格式、混淆、藏图、OCR、转文字、合并/拆分 PDF、压缩包、老 Excel/Word/PPT、手机打不开的 xls/xlsx/doc/docx/ppt」等关键词时优先加载本技能；即使 MCP 还没连上也要先加载，按「开工前自检」处理。
---

# 番茄工具箱（MCP）

这是一个**本地**工具箱：所有处理都在用户电脑上完成，除了「视频下载」之外不需要联网。
执行入口是 MCP 工具，不是命令行。**不要自己写 ffmpeg / 7z / Python 命令去替代它**——那会绕过项目的防覆盖、路径安全和格式校验。

> **用户是小白时**：不要让他改 JSON / 敲命令。让他双击软件目录的 **`一键接入DSH.cmd`**，完全退出并重启 DSH 即可；脚本会自动写配置、装本 Skill、用软件自己的 exe 启动 MCP（不需要装 Node）。撤掉用 `一键移除DSH接入.cmd`。

## 0. 开工前自检（必须）

在动手前，先看当前工具列表里有没有 **`mcp__tomato-toolbox__`** 前缀（例如 `mcp__tomato-toolbox__doc_convert`）。

- **有**：用这些工具；下面工具地图里写的是去掉前缀后的名字。
- **没有**：立刻停下，告诉用户：
  > 番茄工具箱的 MCP 没连上，我先不做。请双击软件目录的 `一键接入DSH.cmd`，完全退出并重启 DSH；然后再叫我。

  **不要**改用 PowerShell / Python / openpyxl / Excel COM / ffmpeg 命令静默替代。只有用户明确说「不用工具箱，你直接用代码做」时才允许替代，并在回复里说明这是替代方案。

> 这条是为了防止「明明装了工具箱，AI 却用 Excel/脚本硬做」——那会绕过不覆盖、路径白名单、审计日志，也让用户以为工具没生效。

## 铁律（违反任何一条就停下）

1. **先确认 MCP 可用**：先找 `mcp__tomato-toolbox__*`；没有就按第 0 步停下，不要改用 shell / Excel / Python 硬做。
2. **绝不覆盖原文件**：所有产物都让工具自己命名（重名自动加序号）；不要传一个已存在的 `output` 去覆盖。
3. **批量重命名先预览**：`file_rename_batch` 默认 `dry_run=true`；先把预览给用户看，确认后再 `dry_run=false`。
4. **视频下载必须先授权**：没有授权时工具返回 `NEEDS_APPROVAL`；让用户去软件「视频下载」页点「允许一次」或打开「本次运行有效」，不要绕过。
5. **密码不写日志/回复**：压缩包、图夹的密码只放在工具参数里，不要复述；审计日志会脱敏，但客户端/模型仍能看到参数。
6. **做完必须验证**：产物存在、体积 > 0、格式对（PNG/JPG/PDF/ZIP 魔数）、页数/尺寸/往返一致。不要只说「已完成」。
7. **缺加装包如实说**：返回「未检测到 ffmpeg / 7-Zip / LibreOffice / OCR / ASR」时，告诉用户缺哪个、放回 `addons/`，不要假装成功。

## 工具地图

> DSH 里实际工具名带前缀：`mcp__tomato-toolbox__` + 下面写的名字。  
> 例如 `doc_convert` → `mcp__tomato-toolbox__doc_convert`。

### 图片
`image_obfuscate` 混淆/解混淆（6 模式，可逆）
`image_hide_files` / `image_unhide_files` 文件藏图（图夹）打包/解包
`image_compress` 压缩（画质/尺寸/目标体积）
`image_enhance` 变清晰（锐化/降噪/2×）；`ai_upscale` AI 超分
`image_convert` PNG/JPG/WebP/BMP/ICO/TIFF/GIF/AVIF；HEIC/PSD/TIFF 输入
`image_watermark` 文字/图片水印
`image_stitch` 长图拼接
`image_slice` 九宫格/自定义切图

### 视频 / 音频
`media_probe` 读取媒体信息
`video_convert` 视频格式转换
`video_compress` 画质档 / 目标体积
`sticker_convert` GIF/WebP/APNG ↔ MP4/WebM
`audio_convert` 21 种音频输出 + 视频提取声音
`audio_edit` 截取 / 拼接 / 淡入淡出 / 响度标准化
`asr_status` / `asr_transcribe` 语音引擎状态 / 转文字

### 文档
`pdf_images_to_pdf` / `pdf_merge` / `pdf_split` / `pdf_extract_pages` / `pdf_page_count`
`pdf_to_images` PDF 每页渲染成图片
`pdf_compress` PDF 压缩瘦身
`pdf_edit` 水印 / 页码 / 旋转 / 重排 / 加密 / 解密
`pdf_office_to_pdf` / `pdf_to_word`
`doc_convert` doc/xls/ppt/pps/rtf → docx/xlsx/pptx/PDF
> 老 `.xls`、教务系统导出的「假 .xls」（Excel 2003 XML）也走 `doc_convert`，不要用 Excel COM / openpyxl / PowerShell 手工转；只有在用户明确要求「不用工具箱」时才替代。
`libreoffice_status`
`ocr_status` / `ocr_recognize` / `ocr_searchable_pdf` / `ocr_to_docx`

### 文件 / 压缩
`file_rename_batch` 批量重命名
`archive_create` / `archive_extract` / `archive_list`

### 受限
`video_download` / `video_download_status` / `video_download_cancel`

完整参数见 `references/tools.md`。

## 常用配方

### 1. 批量图片压缩
1. 先问清目标：格式（JPG/WebP/PNG）、画质、最长边、目标体积；
2. 调 `image_compress`（可分批，避免一次太多）；
3. 汇总前后体积，给出节省比例；
4. 抽查 1~2 个产物能否解码。

### 2. 图片混淆批量加/解密
1. 确认模式与密钥（gilbert 不需要；b/c/c2 字符串；pe1/pe2 是 0~1 小数）；
2. 对每张调 `image_obfuscate`；
3. **必须做往返验证**：把产物再 `direction=decrypt` 一次，与原件逐像素比对；
4. 报告成功/失败清单。

### 3. 文件藏图并验证
1. `image_hide_files`（fast 任意表图、无密码；pro 需 PNG/GIF、可加密码）；
2. 立刻 `image_unhide_files` 回读；
3. 对每个文件比对字节数/哈希；
4. 告诉用户产物路径与「图夹图」命名。

### 4. 扫描件 → 可搜索 PDF
1. `ocr_status` 确认引擎；
2. `ocr_searchable_pdf` 生成；
3. 用 `pdf_page_count` 校验页数；
4. 需要更小体积再 `pdf_compress`；
5. 告诉用户「Ctrl+F 可搜、可复制」。

### 5. 会议录音/视频 → 文字
1. `asr_status` 确认引擎；
2. `asr_transcribe` 输出 SRT；
3. 要 txt 就同时保存 `.txt`；
4. 报告字数、时长、语言（中英日韩粤自动）。

### 6. 视频压到指定大小
1. `media_probe` 拿时长/分辨率；
2. `video_compress` `mode=size`、`target_mb`；
3. 工具会自动两遍编码 + 超标降码率重跑；
4. 返回 `verified` 字段；未达标如实说。

### 7. 视频 → GIF / 表情包
1. `media_probe`；
2. `sticker_convert` 选 `gif`/`webp`/`apng`，给 fps/宽度；
3. 要控制体积就给 `target_mb`（自动降档）；
4. 校验输出能被解码。

### 8. 备份并分卷
1. `archive_create` 选 `7z`/`zip`；需要分卷给 `volume_bytes`；
2. `archive_list` 校验条目；
3. 需要时 `archive_extract` 到新目录，逐字节比对关键文件。

## 安全边界（哪些是强制，哪些只是规矩）

### 服务端强制的
- **路径白名单**：读写默认只允许「用户目录 / 系统临时目录 / 软件目录」；其它盘/目录会被拒绝，除非用户设置 `TOMATO_MCP_ALLOWED_ROOTS`。
- **不覆盖**：所有产物重名自动加序号；`archive_extract` 不允许 `overwrite:"replace"`，`file_rename_batch` 不允许 `conflict:"overwrite"`（要覆盖请让用户去软件界面）。
- **不删文件**：MCP 没有删除工具。
- **只读模式**：用户设 `TOMATO_MCP_READONLY=1` 时，只暴露 `media_probe` / `archive_list` / `pdf_page_count` / `ocr_recognize` / 各 status 等只读工具，写工具既不列出也拒绝调用。
- **审计日志**：每次调用写 `userdata/mcp-audit.jsonl`（工具、参数、耗时、结果、客户端；password/secret/token 字段脱敏）。
- **视频下载**：默认每次要用户授权；`NEEDS_APPROVAL` 不是错误，是等用户点授权。

### 不是强制的（要靠你和用户）
- **大多数工具是调用即执行，没有人工确认弹窗**：只有视频下载有授权闸门。写文件/改名/压缩/转换前，你要先向用户说明计划；高风险操作先预览。
- **密码在参数里**：审计日志会脱敏，但客户端/模型上下文仍能看到参数；不要把密码复述到回复里。
- **白名单可以被人为放宽**：用户设了 `TOMATO_MCP_ALLOWED_ROOTS` 后，那些目录就可写；这是用户的显式选择。
- **审计是事后记录，不是拦截**：它能追溯，但不能阻止一次错误调用。

### 通用规矩
- **不暴露原始命令**：MCP 工具只接受高层参数；不要试图传 `ffmpeg args` / `7z args`。
- **大文件先估算**：GB 级视频/大量图片先提醒耗时与磁盘占用。
- **做完必须验证**：见下一节。

## 交付前自检

- 产物路径存在、体积 > 0；
- 图片能解码、PDF 页数对、ZIP 能列出、视频有画面+声音；
- 需要可逆的操作（混淆/藏图）必须做往返比对；
- 返回结果里带 `outputs` / `path` / `warnings`，不要只回「成功」。

## 故障排查

| 现象 | 处理 |
|---|---|
| `未知工具` | MCP server 没配好或版本旧；让用户按 `docs/Agent接入说明.md` 重配并重启客户端 |
| `NEEDS_APPROVAL` | 让用户到软件「视频下载」页点「允许一次」或开「本次运行有效」 |
| `未检测到 ffmpeg/7-Zip/LibreOffice/OCR/ASR` | 让用户把对应 `addons/...` 放回软件目录 |
| `不支持的图片格式` | 先用 `image_convert` 转 PNG/JPG，或等 HEIC/PSD 输入支持 |
| PDF 渲染报 pdfjs | 确认是打包版（含 `pdfjs-dist/legacy`）或开发树 `node_modules` 完整 |
| OCR/ASR 很慢 | 首次加载模型；纯 CPU 正常，告知用户耐心等 |
