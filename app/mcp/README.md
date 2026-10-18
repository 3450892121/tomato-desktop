# 番茄工具箱 · MCP server（第一批）

让支持 MCP 的 agent（DSH / Claude Desktop / Qoder / Trae 等）直接调用本软件的本地能力。
不需要开 GUI；GUI 仍然是给人用的入口，两边共用同一批 core 模块与加装包。

## 运行

```powershell
# 在仓库根目录
node app/mcp/server.mjs
```

stdio 传输：客户端把 MCP server 当子进程启动，通过 stdin/stdout 走 JSON-RPC。
**stdout 只输出协议消息；日志在 stderr。**

## 客户端配置（stdio）

把下面的路径换成你机器上的真实路径：

```json
{
  "mcpServers": {
    "tomato-toolbox": {
      "command": "node",
      "args": ["C:/你的仓库/app/mcp/server.mjs"],
      "env": {
        "TOMATO_USERDATA_DIR": "C:/你的仓库/app/userdata"
      }
    }
  }
}
```

> `TOMATO_USERDATA_DIR` 用于让 MCP 找到 GUI 写的授权文件。
> 开发态就是 `app/userdata`；打包态应指向 exe 同目录的 `userdata`。

## 已接入工具（41 个）

### 图片
| 工具 | 作用 |
|---|---|
| `image_obfuscate` | 图片混淆/解混淆（6 模式，逐像素可逆） |
| `image_hide_files` / `image_unhide_files` | 文件藏图（图夹）打包 / 解包 |
| `image_compress` | 图片压缩（画质/尺寸/目标体积） |
| `image_enhance` / `ai_upscale` | 变清晰（锐化/降噪/2×）/ AI 超分 4× |
| `image_convert` | PNG/JPG/WebP/BMP/ICO/TIFF/GIF/AVIF；HEIC/PSD/TIFF 等输入 |
| `image_watermark` | 文字/图片水印（九宫格 + 平铺） |
| `image_stitch` | 长图拼接（竖/横、统一尺寸、对齐） |
| `image_slice` | 九宫格/自定义切图 |

### 视频 / 音频
| 工具 | 作用 |
|---|---|
| `media_probe` | 读取时长/分辨率/编码/音轨 |
| `video_convert` | MP4/WebM/MKV/MOV/AVI 互转 |
| `video_compress` | 画质档 / 目标体积两遍编码 + 自动重跑 |
| `sticker_convert` | GIF/WebP/APNG ↔ MP4/WebM |
| `audio_convert` | 21 种音频输出 + 视频提取声音 |
| `audio_edit` | 截取 / 拼接 / 淡入淡出 / 响度标准化 |
| `asr_status` / `asr_transcribe` | 语音引擎状态 / 音频视频转文字 |

### 文档
| 工具 | 作用 |
|---|---|
| `pdf_images_to_pdf` / `pdf_merge` / `pdf_split` / `pdf_extract_pages` / `pdf_page_count` | PDF 组装与页面操作 |
| `pdf_to_images` | PDF 每页渲染成图片 |
| `pdf_compress` | PDF 压缩瘦身（扫描件最有效） |
| `pdf_edit` | 水印 / 页码 / 旋转 / 重排 / 加密 / 解密 |
| `pdf_office_to_pdf` / `pdf_to_word` | Office→PDF / PDF→Word |
| `doc_convert` | doc/xls/ppt/pps/rtf → docx/xlsx/pptx/PDF |
| `libreoffice_status` | 检查 LibreOffice 加装包 |
| `ocr_status` / `ocr_recognize` | OCR 引擎状态 / 图片文字识别 |
| `ocr_searchable_pdf` | 扫描版 PDF → 可搜索 PDF |
| `ocr_to_docx` | 图片/扫描 PDF → 可编辑 Word |

### 文件 / 压缩
| 工具 | 作用 |
|---|---|
| `file_rename_batch` | 批量重命名（默认 `dry_run=true`） |
| `archive_create` / `archive_extract` / `archive_list` | 压缩 / 解压 / 免解压预览 |

### 受限
| 工具 | 作用 |
|---|---|
| `video_download` | 下载网络视频（**必须先由用户在 GUI 授权**） |
| `video_download_status` / `video_download_cancel` | 查询 / 取消下载任务 |

## 视频下载的授权闸门

`video_download` 只读 `userdata/videodl-agent-approvals.json`；没有任何 MCP 工具能改它。

- 用户在「视频下载」页打开「允许 AI 助手直接下载（本次运行有效）」→ 写 session 授权（8 小时；软件退出时清掉）。
- 或点「允许一次」→ 写一次性授权（5 分钟，用完即焚）。
- 没有有效授权 → 工具返回 `{ ok:false, code:"NEEDS_APPROVAL" }`，不产生任何下载。

这是**服务端强制**，不是「agent 在聊天里问一句」。

## 安全约定

- 所有产物重名自动加序号，绝不覆盖已有文件（`uniqueTargetPath`）。
- 不向 agent 暴露原始 `ffmpeg` / `7z` 参数，只接受高层参数，避免命令注入。
- 批量重命名默认只预览；`dry_run=false` 才落盘。
- 密码类参数不写日志。
- 第一批只支持 PNG/JPG/WebP 图片；HEIC/AVIF/TIFF 等留给后续「图片格式转换」批次。

## 当前状态

- 第一~四批全部接入：共 41 个 MCP 工具，覆盖 21 个 GUI 工具（视频播放器、软件卸载按需求不暴露）。
- MCP 冒烟测试：18 项，含真实 ffmpeg / OCR / ASR / LibreOffice / pdfjs 渲染 / Canvas 像素管线 / 授权后真实下载。
- 现有 `npm test` 保持全绿。
- **打包产物已实测**：`node tests/pack-mcp-smoke.mjs` 8/8（产物内 41 个工具、addons 路径、pdfjs legacy、@napi-rs/canvas、heic-decode、OCR 全部可用）。
