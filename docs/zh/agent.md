# Agent 接入（MCP / Skill）

[文档中心](../README.md) · [安全说明](security.md) · [详细接入说明](../Agent接入说明.md) · [English](../en/agent.md)

## 1. 是什么

软件内置一个**本地 MCP server**，让支持 MCP 的 Agent（DSH / Claude Desktop / Qoder / Trae 等）调用同一批能力：

- **41 个工具接口**，覆盖 **21 个 GUI 工具**；
- **不暴露**视频播放器、软件卸载；
- 不需要打开 GUI（视频下载授权除外）；
- 本地 stdio，不监听端口、不装服务、不开机自启。

配套 Skill：`skills/tomato-toolbox/`，教 Agent 何时用、按什么顺序用、什么不能做、做完怎么验证。

## 2. 一键接入（支持 DSH / Qoder；MCP 通用）

**不需要改 JSON、不需要敲命令、不需要装 Node。**

### DSH

1. 双击软件目录里的 `一键接入DSH.cmd`；
2. 看到「已接入」后，**完全退出** DeepSeek Harness（不是关窗口，是退出程序）再打开；
3. 直接说：
   > 用番茄工具箱把这个文件夹的图片压到 500KB 以内

脚本会自动写 `~/.dsh/profiles/*/cordis.patch.yml`（先备份）、把 Skill 装到 `~/.dsh/skills/tomato-toolbox`、用软件自己的 exe 以 Node 模式启动 MCP（不需要系统 Node）。撤掉：双击 `一键移除DSH接入.cmd`（先备份配置；Skill 保留）。

### Qoder

1. **先完全退出 Qoder**；
2. 双击软件目录里的 `一键接入Qoder.cmd`；
3. 打开 Qoder，**新开一个对话**，直接说：
   > 用番茄工具箱把这个文件夹的图片压到 500KB 以内

脚本会自动写 `~/.qoder-cn/settings.json` 的 `mcpServers.tomato-toolbox`（先备份；其它 MCP 与 providers 保留）、把 Skill 装到 `~/.qoder-cn/skills/tomato-toolbox`、用软件自己的 exe 以 Node 模式启动 MCP。撤掉：双击 `一键移除Qoder接入.cmd`。

Qoder 工具名前缀是 `mcp__tomato_toolbox__`；DSH 是 `mcp__tomato-toolbox__`。

> 旧对话的工具列表在开始时就定了；Qoder 装完必须**新开对话**。其它客户端按下一节手动配置。

## 3. 手动配置（其它客户端）

### 3.1 启动命令

开发树：

```text
command: node
args: ["<repo>/app/mcp/server.mjs"]
```

打包版（推荐用软件 exe，不需要装 Node）：

```text
command: "<软件目录>/番茄图片混淆桌面版.exe"
args: ["<软件目录>/resources/app/mcp/server.mjs"]
env:
  ELECTRON_RUN_AS_NODE: "1"
  TOMATO_USERDATA_DIR: "<软件目录>/userdata"
```

### 3.2 DSH 配置示例

```yaml
- insert:
    - id: mcp-tomato-toolbox
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: tomato-toolbox
        transport: stdio
        command: 'C:/path/to/番茄图片混淆桌面版.exe'
        args: ['C:/path/to/resources/app/mcp/server.mjs']
        cwd: 'C:/path/to/resources/app'
        env:
          ELECTRON_RUN_AS_NODE: '1'
          TOMATO_USERDATA_DIR: 'C:/path/to/userdata'
        toolCallTimeoutMs: 3600000
```

### 3.3 Claude Desktop / 其它 JSON 客户端

```json
{
  "mcpServers": {
    "tomato-toolbox": {
      "command": "C:/path/to/番茄图片混淆桌面版.exe",
      "args": ["C:/path/to/resources/app/mcp/server.mjs"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "TOMATO_USERDATA_DIR": "C:/path/to/userdata"
      }
    }
  }
}
```

### 3.4 Qoder

Qoder 的自定义 MCP 在 `~/.qoder-cn/settings.json`（国际版 `~/.qoder/settings.json`）的 `mcpServers` 里，stdio 条目：

```json
{
  "mcpServers": {
    "tomato-toolbox": {
      "type": "stdio",
      "command": "C:/path/to/番茄图片混淆桌面版.exe",
      "args": ["C:/path/to/resources/app/mcp/server.mjs"],
      "cwd": "C:/path/to/resources/app",
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "TOMATO_USERDATA_DIR": "C:/path/to/userdata"
      }
    }
  }
}
```

改完完全退出 Qoder 再打开，并新开对话。Qoder 会把前缀规范成 `mcp__tomato_toolbox__`。

完整字段、开发树路径、排错见 [`Agent接入说明.md`](../Agent接入说明.md)。

## 4. 环境变量

| 变量 | 作用 |
|---|---|
| `TOMATO_USERDATA_DIR` | 指定 `userdata`（审计日志、视频下载授权） |
| `TOMATO_MCP_ALLOWED_ROOTS` | 路径白名单，分号分隔；默认用户目录 / 临时目录 / 软件目录 |
| `TOMATO_MCP_READONLY` | `1` = 只读模式，只暴露查询/状态类工具 |

示例：

```json
"env": {
  "ELECTRON_RUN_AS_NODE": "1",
  "TOMATO_USERDATA_DIR": "D:/TomatoToolbox/userdata",
  "TOMATO_MCP_ALLOWED_ROOTS": "D:/AI工作区;D:/输出",
  "TOMATO_MCP_READONLY": "1"
}
```

## 5. 视频下载授权

- 默认**每次**都要授权；
- 无授权时 `video_download` 返回 `NEEDS_APPROVAL`，零下载；
- 到软件「视频下载」页点「允许一次」，或打开「允许 AI 助手直接下载（本次运行有效）」；
- 授权文件只由 GUI 写，MCP 只读；
- 关掉软件，session 授权失效。

## 6. 安全边界（必读）

**服务端强制：**

- 路径白名单；
- 产物不覆盖（重名加序号；`archive_extract` / `file_rename_batch` 拒绝覆盖参数）；
- 不提供删除工具；
- 只读模式；
- 审计日志 `userdata/mcp-audit.jsonl`（password/secret/token 脱敏）；
- 视频下载人工闸门。

**不是强制：**

- 大多数工具**调用即执行**，没有人工确认弹窗；
- 密码会进入客户端上下文；
- 审计是事后记录，不是拦截；
- **不是沙箱**：MCP 以当前用户权限运行；
- 白名单可以被人为放宽。

详见 [安全说明](security.md)。

## 7. Skill

- 仓库：[`skills/tomato-toolbox/SKILL.md`](../../skills/tomato-toolbox/SKILL.md)
- 工具参数：[`skills/tomato-toolbox/references/tools.md`](../../skills/tomato-toolbox/references/tools.md)
- DSH 安装位置：`~/.dsh/skills/tomato-toolbox/`
- Qoder 安装位置：`~/.qoder-cn/skills/tomato-toolbox/`
- 打包版：`<软件目录>/skills/tomato-toolbox/`
- 其它客户端：把整个文件夹放进它的 skills 目录；没有 skills 机制就只配 MCP。

Skill 是**流程指导**，不是执行代码；执行仍走 MCP 工具。

## 8. 常见问题

**DSH 里没有工具？**
完全退出并重启 DSH；确认 `cordis.patch.yml` 里有 `mcp-tomato-toolbox`；看 DSH 日志里的 MCP 报错。

**Qoder 里没有工具？**
先完全退出重开，并且新开对话；确认 `~/.qoder-cn/settings.json` 的 `mcpServers.tomato-toolbox` 存在；Qoder 里的工具名前缀是 `mcp__tomato_toolbox__`。

**`NEEDS_APPROVAL`？**
去「视频下载」页授权，再让 Agent 重试。

**工具报「不在允许范围」？**
把目录加进 `TOMATO_MCP_ALLOWED_ROOTS`，或把文件放到用户目录 / 软件目录 / 临时目录。

**想只查询不改文件？**
设 `TOMATO_MCP_READONLY=1`。

**第三方客户端兼容性？**
核心 `initialize` / `tools/list` / `tools/call` 已实现；未实现 elicitation、progress、cancellation、resources 内容等高级能力。
