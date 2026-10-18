# tomato-toolbox MCP 工具参考

> 41 个工具，覆盖 21 个 GUI 工具。所有工具都通过本地 MCP server 执行。
> 返回统一带 `ok`；成功通常有 `output` / `outputs` / `path`，失败是 `isError` 或 `{ ok:false, message }`。
>
> 安全相关环境变量：
> - `TOMATO_MCP_ALLOWED_ROOTS`：路径白名单（默认用户目录/临时目录/软件目录；分号分隔）。
> - `TOMATO_MCP_READONLY=1`：只读模式，只暴露查询/状态类工具。
> - `TOMATO_USERDATA_DIR`：userdata 位置（审计日志 `mcp-audit.jsonl` 与视频下载授权都在这）。

## 图片

### image_obfuscate
- 必填：`input`、`mode`（gilbert|b|c|c2|pe1|pe2）、`direction`（encrypt|decrypt）
- 可选：`key`、`output`、`output_dir`、`base_name`、`format`（auto|png|jpg|webp）、`quality`、`block_size`
- 说明：gilbert 不需要 key；b/c/c2 字符串；pe1/pe2 是 0~1 小数。b 模式输出尺寸会填充到 32 的倍数。

### image_hide_files
- 必填：`cover`（表图）、`items`（文件数组）
- 可选：`mode`（fast|pro，默认 fast）、`password`、`output_dir`、`base_name`
- 说明：fast 任意表图、无密码；pro 只支持 PNG/GIF 表图、可加密码。

### image_unhide_files
- 必填：`image`
- 可选：`password`、`output_dir`

### image_compress
- 必填：`inputs`（数组）
- 可选：`format`（auto|png|jpg|webp）、`quality`、`longest_edge`、`percent`、`target_bytes`、`output_dir`

### image_enhance
- 必填：`input`
- 可选：`preset`（auto|light|strong|denoise|upscale2x|ai-4x|ai-2x|ai-anime|custom）、`params`、`output_dir`、`base_name`
- 说明：AI 预设需要 Vulkan 显卡。

### ai_upscale
- 必填：`input`
- 可选：`scale`（2|3|4）、`model`、`output_dir`

### image_convert
- 必填：`inputs`、`target`（png|jpg|webp|bmp|ico|tif|gif|avif）
- 可选：`quality`、`max_edge`、`output_dir`
- 输入支援：PNG/JPG/WebP/GIF/BMP/HEIC/HEIF/HIF/TIFF/PCX/TGA/PSD/DDS/JP2/J2K/SVG。

### image_watermark
- 必填：`input`
- 可选：`type`（text|image）、`text`、`stamp`、`position`（九宫格或 tile）、`size_percent`、`opacity`、`rotation`、`color`、`stroke`、`stroke_color`、`margin_percent`、`tile_gap_ratio`、`format`、`quality`、`output_dir`、`base_name`

### image_stitch
- 必填：`inputs`
- 可选：`direction`（vertical|horizontal）、`mode`（none|unify）、`target_size`、`gap`、`align`（center|start|end）、`margin`、`format`、`quality`、`output_dir`、`base_name`

### image_slice
- 必填：`input`、`rows`、`cols`
- 可选：`gap`、`margin`、`seam_color`、`order`（row|column）、`format`、`quality`、`output_dir`

## 视频 / 音频

### media_probe
- 必填：`path`
- 返回：`durationSec`、`width`、`height`、`fps`、`hasVideo`、`hasAudio`、`videoCodec`、`audioCodec`、`sampleRate`

### video_convert
- 必填：`inputs`、`target`（mp4|webm|mkv|mov|avi）
- 可选：`quality`（high|standard|small）、`height`、`mute`、`output_dir`

### video_compress
- 必填：`inputs`、`mode`（quality|size）
- 可选：`quality`、`target_mb`、`audio_kbps`、`height`、`mute`、`output_dir`
- 说明：size 模式两遍编码；超出目标 5% 会自动降码率重跑一次。

### sticker_convert
- 必填：`inputs`、`output`（gif|webp|apng|mp4|webm）
- 可选：`fps`、`width`、`height`、`target_mb`、`output_dir`

### audio_convert
- 必填：`inputs`、`target`（21 种，见项目音频列表）
- 可选：`quality`（high|standard|small）、`output_dir`

### audio_edit
- 必填：`inputs`、`target`
- 可选：`quality`、`start_ms`、`end_ms`、`gain_db`（数字或 normalize）、`fade_in_ms`、`fade_out_ms`、`output_dir`
- 说明：`inputs` 给多个时按顺序拼接。

### asr_status
- 无参数。

### asr_transcribe
- 必填：`input`
- 可选：`format`（srt|txt|both）、`output_dir`
- 说明：首次调用加载约 240MB 模型。

## 文档

### pdf_images_to_pdf
- 必填：`images`
- 可选：`output`、`output_dir`、`base_name`、`page_mode`（original|a4）、`margin`

### pdf_merge
- 必填：`pdfs`
- 可选：`output`、`output_dir`、`base_name`

### pdf_split
- 必填：`pdf`
- 可选：`every_n`、`output_dir`、`base_name`

### pdf_extract_pages
- 必填：`pdf`、`pages`（1 起）
- 可选：`output`、`output_dir`、`base_name`

### pdf_page_count
- 必填：`pdf`

### pdf_to_images
- 必填：`input`
- 可选：`pages`（数组或 "1-3,5"）、`scale`、`format`（png|jpg）、`quality`、`output_dir`

### pdf_compress
- 必填：`input`
- 可选：`preset`（light|standard|strong|extreme）、`grayscale`、`max_mb`、`pages`、`password`、`output`、`output_dir`、`base_name`

### pdf_edit
- 必填：`input`、`operation`（watermark|page_numbers|rotate|reorder|encrypt|decrypt）
- 可选：`params`、`output`、`output_dir`、`base_name`
- params：
  - watermark：`text`、`fontSize`、`opacity`、`rotation`、`color`、`position`、`tile`、`margin`
  - page_numbers：`format`、`startAt`、`position`、`fontSize`、`margin`、`skipFirst`
  - rotate：`pages`、`angle`（90/180/270）
  - reorder：`order`（数组或 "3,1,2"）
  - encrypt：`userPassword`、`ownerPassword`、`permissions`
  - decrypt：`password`

### pdf_office_to_pdf
- 必填：`input`
- 可选：`output`、`output_dir`、`base_name`

### pdf_to_word
- 必填：`input`
- 可选：`mode`（layout|text）、`output`、`output_dir`、`base_name`

### doc_convert
- 必填：`inputs`、`target`（auto|docx|xlsx|pptx|pdf）、`output_dir`

### libreoffice_status
- 无参数。

### ocr_status
- 无参数。

### ocr_recognize
- 必填：`input`（PNG/JPG/WebP/BMP）
- 返回：`text`、`lines`（含坐标/置信度）、`confidence`、`ms`

### ocr_searchable_pdf
- 必填：`input`（扫描版 PDF）
- 可选：`scale`、`output`、`output_dir`、`base_name`

### ocr_to_docx
- 必填：`input`（图片或 PDF）
- 可选：`scale`、`output`、`output_dir`、`base_name`

## 文件 / 压缩

### file_rename_batch
- 必填：`items`（路径数组或 `{path,mtimeMs}`）、`rule`
- 可选：`sort`（none|time-asc|time-desc）、`conflict`（skip|auto）、`dry_run`（默认 true）
- 说明：MCP 侧不允许 `conflict:"overwrite"`；需要覆盖请让用户去软件界面。
- rule：`{mode:"seq",prefix,start,digits,keepName}` / `{mode:"replace",find,replace,useRegex}` / `{mode:"affix",prefix,suffix}` / `{mode:"date",pattern}`

### archive_create
- 必填：`inputs`、`format`（zip|7z|tar|gzip|tar.gz|bz2|tar.bz2|xz|tar.xz|zst|tar.zst|br|tar.br）、`output_dir`
- 可选：`level`、`password`、`encrypt`、`volume_bytes`、`base_name`

### archive_extract
- 必填：`archives`、`output_dir`
- 可选：`password`、`overwrite`（只允许 skip）、`tree`（keep|flatten）
- 说明：MCP 侧不允许 `overwrite:"replace"`；需要覆盖请让用户去软件界面。

### archive_list
- 必填：`archive`
- 可选：`password`

## 受限：视频下载

### video_download
- 必填：`url`、`output_dir`（绝对路径）
- 说明：没有用户授权时返回 `{ ok:false, code:"NEEDS_APPROVAL" }`，不会下载。
- 授权：用户在软件「视频下载」页点「允许一次」或打开「本次运行有效」。

### video_download_status
- 可选：`job_id`

### video_download_cancel
- 必填：`job_id`

## 错误码/字段

- `NEEDS_APPROVAL`：等用户授权，不是工具坏了。
- `ok:false` + `message`：参数/引擎/文件问题；把 message 原样告诉用户。
- `warnings`：非致命问题（例如压缩后仍未达目标体积），要转述。
- `verified`：媒体/压缩类结果是否达标；未达标如实说。
