# agent-mcp — Agent 入口（MCP server）

> 状态：已实现（v2.14.0 起的增量能力）。本文是目标规格与边界，实现见 `app/mcp/`。

## 目标
让同一个软件既给人用（GUI），也给 agent 用（MCP）：
- 人：照旧点界面，行为不变；
- agent：通过本地 MCP server 调用同一批 core / 加装包，不需要开窗口。

## 范围
- 暴露 **21 个 GUI 工具**对应的能力（41 个 MCP 工具）。
- **不暴露**「视频播放器」与「软件卸载」：
  - 播放器是看画面的交互；「准备可播放副本」已由视频转换覆盖；
  - 卸载是破坏性操作 + UAC，必须由人操作。
- 传输：stdio（一行一条 JSON-RPC 2.0）。不做远程 HTTP、不做多用户/鉴权。
- 配套 Skill：`skills/tomato-toolbox/`（`SKILL.md` + `references/tools.md`），教 agent 何时用、按什么顺序用、什么不能做、做完怎么验证；执行仍走 MCP 工具。打包版随包在 `<软件目录>/skills/tomato-toolbox/`。

## 架构
```
GUI (Electron) ──IPC──┐
                      ├─ 同一批 core / addons（ffmpeg/7z/LibreOffice/OCR/ASR/Real-ESRGAN/libheif）
Agent ──MCP(stdio)────┘
```
- `app/mcp/server.mjs`：协议层（initialize / tools/list / tools/call）。
- `app/mcp/tools/*.mjs`：工具定义与参数校验。
- `app/mcp/lib/*`：Node 侧的 ffmpeg / LibreOffice / pdfjs / Canvas / 路径工具。
- 不复制 GUI 的 UI 代码；能复用 core 的直接 import。

## 视频下载授权（硬约束）
- 默认「每次询问」；用户可在「视频下载」页打开「允许 AI 助手直接下载（本次运行有效）」，或点「允许一次」。
- 授权文件：`userdata/videodl-agent-approvals.json`，**只由 GUI 写**；MCP 只读。
- 没有有效授权时，`video_download` 返回 `NEEDS_APPROVAL`，不产生任何下载。
- 软件退出时清空 session 授权（不跨重启）。
- agent 不能通过任何 MCP 工具修改该文件。

## 安全约定
- 所有产物走 `uniqueTargetPath`：重名加序号，绝不覆盖。
- 不向 agent 暴露原始 `ffmpeg` / `7z` 参数，只接受高层参数。
- 批量重命名默认 `dry_run=true`；`false` 才落盘。
- 密码类参数不写日志。
- 路径必须是调用方显式给出的绝对路径；不做隐式系统目录写入。

## 验收
- `node tests/mcp.test.mjs`：18 项，含真实 ffmpeg / OCR / ASR / LibreOffice / pdfjs 渲染 / Canvas 像素管线 / 授权后真实下载。
- `node tests/pack-mcp-smoke.mjs`：8 项，在打包产物上验证 41 个工具、addons 路径、pdfjs legacy、@napi-rs/canvas、heic-decode、OCR。
- `npm test`：现有纯逻辑测试 + MCP 测试全绿。
- `--smoke-test`：GUI 23 个工具仍正常。

## 非目标
- 不做远程 MCP、不做云端 OCR/ASR、不做账号体系。
- 不把播放器/卸载做成 agent 工具。
- 不承诺与 GUI 的每个像素细节完全一致（Canvas 管线已按同一套 core 规则重实现，测试以产物可读/尺寸/格式/逐字节为主）。
