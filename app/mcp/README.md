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

## 第一批工具（15 个）

| 工具 | 作用 |
|---|---|
| `image_obfuscate` | 图片混淆/解混淆（6 模式，逐像素可逆） |
| `image_hide_files` | 把文件藏进图片（图夹） |
| `image_unhide_files` | 从图夹图片取出文件 |
| `archive_create` | 压缩（ZIP/7Z/TAR/GZIP/BZIP2/XZ/ZSTD/BROTLI 等） |
| `archive_extract` | 解压（RAR 等仅解压） |
| `archive_list` | 免解压预览压缩包内容 |
| `pdf_images_to_pdf` | 多张 PNG/JPG → 一份 PDF |
| `pdf_merge` | 合并 PDF |
| `pdf_split` | 按每 N 页拆分 PDF |
| `pdf_extract_pages` | 提取指定页 |
| `pdf_page_count` | 读取 PDF 页数 |
| `file_rename_batch` | 批量重命名（默认 `dry_run=true`，先预览） |
| `video_download` | 下载网络视频（**必须先由用户在 GUI 授权**） |
| `video_download_status` | 查询下载任务 |
| `video_download_cancel` | 取消下载任务 |

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

- 第一批（纯 Node）：已实现并通过 `node tests/mcp.test.mjs`（9 项）。
- 第二批（ffmpeg / OCR / ASR / PDF 编辑）：待做。
- 第三批（Canvas 类：压缩/增强/水印/拼接/切图/格式转换）：待做。
- 第四批（文档格式转换 + 打包进产物）：待做。
