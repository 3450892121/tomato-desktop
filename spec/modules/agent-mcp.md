# agent-mcp — Agent 入口（MCP server）

> 状态：已实现（v2.14.0 起；v2.15.0 增加 DSH 小白一键接入；当前开发线增加 Qoder 一键接入与接入体检）。本文是目标规格与边界，实现见 `app/mcp/`。

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
- 小白一键接入（DSH）：软件目录的 `一键接入DSH.cmd` 自动写 `~/.dsh/profiles/*/cordis.patch.yml`（先备份）、安装 Skill、用软件自己的 exe 以 Node 模式启动 MCP；不需要用户改 JSON/装 Node。`一键移除DSH接入.cmd` 可撤回（配置备份；Skill 一起移到 `~/.dsh/skill-backups/`）。
- 小白一键接入（Qoder）：软件目录的 `一键接入Qoder.cmd` 自动写 `~/.qoder-cn/settings.json` 的 `mcpServers.tomato-toolbox`（先备份）、安装 Skill 到 `~/.qoder-cn/skills/tomato-toolbox`、用软件自己的 exe 以 Node 模式启动 MCP；不需要用户改 JSON/装 Node。`一键移除Qoder接入.cmd` 可撤回（配置备份，Skill 移到 `~/.qoder-cn/skill-backups/`）。Qoder 会把 serverName 规范成 `tomato_toolbox`，工具名前缀为 `mcp__tomato_toolbox__`；装完需完全退出 Qoder 重开并新开对话。
- 小白一键接入（Trae / WorkBuddy / ZCode）：`一键接入Trae.cmd` / `一键接入WorkBuddy.cmd` / `一键接入ZCode.cmd`，共用 `setup-agent-mcp.ps1`：
  - Trae 写 `%APPDATA%\Trae CN\User\mcp.json`（国际版 `%APPDATA%\Trae\User\mcp.json`）的 `mcpServers.tomato-toolbox`，条目 `{command,args,cwd,env}`（该 schema 无 `type`）；Skill 到 `~/.trae-cn/skills`；
  - WorkBuddy 写 `~/.workbuddy/mcp.json`，条目 `{type:"stdio",command,args,cwd,env}`；**首次需用户在界面点「信任」**；Skill 到 `~/.workbuddy/skills`；
  - ZCode 写 `~/.zcode/cli/config.json` 的 `mcp.servers.tomato-toolbox`，条目 `{type:"stdio",command,args,cwd,env,timeoutMs}`；MCP 服务器页开关需打开；Skill 到 `~/.zcode/skills`；
  - 三者各自有 `一键移除…接入.cmd`（共用 `uninstall-agent-mcp.ps1`），配置与 Skill 一起移除并留备份。
- 接入体检：`一键体检Agent接入.cmd` / `verify-agent-mcp.ps1` 只读检查 DSH / Qoder / Trae / WorkBuddy / ZCode / Claude Desktop 的配置、路径与 Skill，并对已接入的**真的启动 MCP、要求返回工具列表**；异常时退出码 1、写明卡在哪一步。`-NoProbe` 跳过启动，`-Json` 输出机器可读结果。
- GUI 入口：左侧「系统 → Agent 接入」（`src/tools/agent-setup/`）。页面上每个「接入 / 移除」按钮与同名双击脚本等价，「一键体检」调 `verify-agent-mcp.ps1` 并把原始输出显示在页面里。主进程 `agent:run` 只接受固定动作白名单（动作 → 脚本/参数），渲染进程不能传任意脚本路径或参数；子进程用 UTF-8 输出、3 分钟超时。
- 接入/移除脚本的硬约束：写前备份且**备份不覆盖**（同秒多次运行会加序号）；写后读回校验，失败用备份回滚；坏 JSON / 结构不对时**一个字节都不改**；重复接入幂等；移除可重复执行且不误删其它 MCP / providers。
- 支持范围：一键脚本覆盖 DSH / Qoder / Trae / WorkBuddy / ZCode；Claude Desktop 仅体检 + 手动配置。新增客户端必须先从其源码/配置 schema 核实字段，禁止照搬；需要用户在客户端里额外确认的（WorkBuddy「信任」、ZCode 开关），脚本必须明确提示，不能假装已接通。

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

## 安全约定（强制 vs 约定）
### 服务端强制
- **路径白名单**：读写默认只允许「用户目录 / 系统临时目录 / 软件目录」；其它目录需 `TOMATO_MCP_ALLOWED_ROOTS` 显式放行。白名单外的输入/输出直接拒绝。
- **不覆盖**：所有产物走 `uniqueTargetPath`；`archive_extract` 拒绝 `overwrite:"replace"`，`file_rename_batch` 拒绝 `conflict:"overwrite"`。
- **不删文件**：MCP 不提供删除工具。
- **只读模式**：`TOMATO_MCP_READONLY=1` 时只暴露只读工具（media_probe / archive_list / pdf_page_count / ocr_recognize / status 类），写工具既不列出也拒绝。
- **审计日志**：每次 `tools/call` 写 `userdata/mcp-audit.jsonl`；password/secret/token 字段脱敏；记录客户端 clientInfo。
- **视频下载授权**：只有 GUI 能写授权文件，MCP 只读；无授权返回 `NEEDS_APPROVAL`。

### 不是强制（必须在文档/技能里说清）
- 大多数工具是**调用即执行**，没有人工确认弹窗；只有视频下载有闸门。
- 密码会进入客户端上下文；审计脱敏不等于客户端看不到。
- 审计是事后记录，不能阻止一次错误调用。
- **不是沙箱**：MCP 以当前用户权限运行；白名单只挡明显越界路径。

### 其它
- 不向 agent 暴露原始 `ffmpeg` / `7z` 参数，只接受高层参数。
- 批量重命名默认 `dry_run=true`；`false` 才落盘。
- 不需要常驻后台：stdio 子进程，客户端关闭即退出；不监听端口、不装服务。

## 验收
- `node tests/mcp.test.mjs`：**21 项**，含真实 ffmpeg / OCR / ASR / LibreOffice / pdfjs 渲染 / Canvas 像素管线 / 授权后真实下载 / 路径白名单 / 审计日志 / 只读模式 / 禁止覆盖。
- `node tests/pack-mcp-smoke.mjs`：9 项，在打包产物上验证 41 个工具、addons 路径、pdfjs legacy、@napi-rs/canvas、heic-decode、OCR、路径白名单与审计日志。
- `npm test`：现有纯逻辑测试 + MCP 测试全绿。
- `--smoke-test`：GUI 24 个工具仍正常。

## 非目标
- 不做远程 MCP、不做云端 OCR/ASR、不做账号体系。
- 不把播放器/卸载做成 agent 工具。
- 不承诺与 GUI 的每个像素细节完全一致（Canvas 管线已按同一套 core 规则重实现，测试以产物可读/尺寸/格式/逐字节为主）。

