---
name: tomato-toolbox
description: 用本地「番茄工具箱」处理图片/视频/音频/文档/压缩文件。当用户要求批量压缩图片、图片混淆/解混淆、文件藏图、视频转码/压缩、动图互转、音频转换/剪辑、语音转文字、PDF/文档转换、OCR、或压缩解压时使用。优先调用 tomato-toolbox MCP 工具，不要自己拼 ffmpeg/7z/Python 命令。
whenToUse: 用户要在本机处理媒体/文档文件，且已经配置好 tomato-toolbox MCP server。涉及「压缩、转格式、混淆、藏图、OCR、转文字、合并/拆分 PDF、压缩包」等关键词时优先加载本技能。
---

# 番茄工具箱（MCP）

这是一个**本地**工具箱：所有处理都在用户电脑上完成，除了「视频下载」之外不需要联网。
执行入口是 MCP 工具，不是命令行。**不要自己写 ffmpeg / 7z / Python 命令去替代它**——那会绕过项目的防覆盖、路径安全和格式校验。

## 铁律（违反任何一条就停下）

1. **先确认 MCP 可用**：先 `tools/list`，确认有 `image_obfuscate` / `archive_create` 等工具；没有就告诉用户去配置 MCP（见 `docs/Agent接入说明.md`），不要改用 shell 硬做。
2. **绝不覆盖原文件**：所有产物都让工具自己命名（重名自动加序号）；不要传一个已存在的 `output` 去覆盖。
3. **批量重命名先预览**：`file_rename_batch` 默认 `dry_run=true`；先把预览给用户看，确认后再 `dry_run=false`。
4. **视频下载必须先授权**：没有授权时工具返回 `NEEDS_APPROVAL`；让用户去软件「视频下载」页点「允许一次」或打开「本次运行有效」，不要绕过。
5. **密码不写日志/回复**：压缩包、图夹的密码只放在工具参数里，不要复述。
6. **做完必须验证**：产物存在、体积 > 0、格式对（PNG/JPG/PDF/ZIP 魔数）、页数/尺寸/往返一致。不要只说「已完成」。
7. **缺加装包如实说**：返回「未检测到 ffmpeg / 7-Zip / LibreOffice / OCR / ASR」时，告诉用户缺哪个、放回 `addons/`，不要假装成功。

## 工具地图

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

## 安全边界

- **视频下载是唯一联网工具**：默认每次要用户授权；`NEEDS_APPROVAL` 不是错误，是等用户点授权。
- **不暴露原始命令**：MCP 工具只接受高层参数；不要试图传 `ffmpeg args` / `7z args`。
- **不删用户文件**：本工具不提供删除；清理请让用户自己做。
- **不碰系统目录**：输出目录只放在用户指定的工作目录。
- **大文件先估算**：GB 级视频/大量图片先提醒耗时与磁盘占用。

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
