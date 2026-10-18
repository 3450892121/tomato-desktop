# 番茄工具箱 · MCP server（第一批）

让支持 MCP 的 agent（DSH / Claude Desktop / Qoder / Trae 等）直接调用本软件的本地能力。
不需要开 GUI；GUI 仍然是给人用的入口，两边共用同一批 core 模块与加装包。

## 小白一键接入（DSH，推荐）

**不需要改 JSON、不需要敲命令、不需要装 Node。**

1. 双击软件目录里的 `一键接入DSH.cmd`；
2. 完全退出并重启 DeepSeek Harness；
3. 在 DSH 里直接说「用番茄工具箱把…」。

脚本会自动写 `~/.dsh/profiles/*/cordis.patch.yml`（先备份）、安装 Skill、用软件自己的 exe 以 Node 模式启动 MCP。撤掉用 `一键移除DSH接入.cmd`（Skill 一起移除，备份在 `~/.dsh/skill-backups/`）。

## 小白一键接入（Qoder，推荐）

**不需要改 JSON、不需要敲命令、不需要装 Node。**

1. **先完全退出 Qoder**；
2. 双击软件目录里的 `一键接入Qoder.cmd`；
3. 打开 Qoder，**新开一个对话**，直接说「用番茄工具箱把…」。

脚本会自动写 `~/.qoder-cn/settings.json` 的 `mcpServers.tomato-toolbox`（先备份；其它 MCP 与 providers 保留）、安装 Skill 到 `~/.qoder-cn/skills/tomato-toolbox`、用软件自己的 exe 以 Node 模式启动 MCP。撤掉用 `一键移除Qoder接入.cmd`。

> Qoder 工具名前缀是 `mcp__tomato_toolbox__`（下划线）；DSH 是 `mcp__tomato-toolbox__`（横线）。

## 接入体检（推荐）

双击软件目录里的 `一键体检Agent接入.cmd`（或运行 `app/tools/verify-agent-mcp.ps1`）：

- 检查 DSH / Qoder / Trae / WorkBuddy / ZCode / Claude Desktop 的配置、路径、Skill；
- 对已接入的**真的启动一遍 MCP**，要求返回工具列表（正常 41 个）；
- 只读、不改配置；`-NoProbe` 跳过启动，`-Json` 输出机器可读结果；
- 有异常时退出码为 1，可直接接 CI。

`Trae` / `WorkBuddy` / `ZCode` / `Claude` 目前没有一键脚本，体检只报状态。

## 运行（开发/手动）

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

> Qoder 的自定义 MCP 存在 `~/.qoder-cn/settings.json` 的 `mcpServers` 里，条目需要 `"type": "stdio"`，建议带 `cwd`；完整示例见 `docs/Agent接入说明.md`。

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

## 安全约定（强制 vs 约定）

### 服务端强制
- **路径白名单**：读写默认只允许「用户目录 / 系统临时目录 / 软件目录」。需要别的盘/目录，设 `TOMATO_MCP_ALLOWED_ROOTS`（分号分隔）。
- **不覆盖**：产物重名自动加序号（`uniqueTargetPath`）；`archive_extract` 拒绝 `overwrite:"replace"`，`file_rename_batch` 拒绝 `conflict:"overwrite"`。
- **不删文件**：没有删除工具。
- **只读模式**：`TOMATO_MCP_READONLY=1` 时只暴露 `media_probe` / `archive_list` / `pdf_page_count` / `ocr_recognize` / status 等只读工具。
- **审计日志**：每次调用写 `userdata/mcp-audit.jsonl`；password/secret/token 字段脱敏。
- **视频下载授权**：只有 GUI 能写授权文件，MCP 只读；无授权返回 `NEEDS_APPROVAL`。

### 不是强制（使用前要知道）
- **大多数工具是调用即执行**，没有人工确认弹窗；只有视频下载有闸门。
- **密码会进入客户端上下文**；审计日志脱敏不等于客户端看不到。
- **审计是事后记录**，不能阻止一次错误调用。
- **不是沙箱**：MCP 进程以当前用户权限运行，白名单只挡明显越界路径。

### 其它
- 不向 agent 暴露原始 `ffmpeg` / `7z` 参数，只接受高层参数，避免命令注入。
- 批量重命名默认只预览；`dry_run=false` 才落盘。
- 不需要常驻后台：stdio 子进程，客户端关闭即退出；不监听端口、不装服务。

## 当前状态

- 第一~四批全部接入：共 41 个 MCP 工具，覆盖 21 个 GUI 工具（视频播放器、软件卸载按需求不暴露）。
- MCP 冒烟测试：**21 项**，含真实 ffmpeg / OCR / ASR / LibreOffice / pdfjs 渲染 / Canvas 像素管线 / 授权后真实下载 / 路径白名单 / 审计日志 / 只读模式。
- 现有 `npm test` 保持全绿。
- **打包产物已实测**：`node tests/pack-mcp-smoke.mjs` 9/9（产物内 41 个工具、addons 路径、pdfjs legacy、@napi-rs/canvas、heic-decode、OCR 全部可用）。

