# Agent access (MCP / Skill)

[Documentation](../README.md) · [Security](security.md) · [Detailed guide (Chinese)](../Agent接入说明.md) · [中文](../zh/agent.md)

## 1. What it is

The app ships a **local MCP server** so MCP-capable agents (DSH, Claude Desktop, Qoder, Trae, etc.) can call the same capabilities:

- **41 tool endpoints** covering **21 GUI tools**;
- **Video Player and Software Uninstall are not exposed**;
- No GUI needed (except video-download approval);
- Local stdio: no port, no service, no autostart.

The Skill lives in `skills/tomato-toolbox/` and teaches the agent when to use tools, in what order, what not to do, and how to verify results.

## 2. One-click setup (DSH / Qoder; MCP is general-purpose)

**No JSON editing, no commands, no Node.js installation.**

### DSH

1. Double-click `一键接入DSH.cmd` in the app folder.
2. Fully quit and restart DeepSeek Harness (quit the process, not just the window).
3. Ask:
   > Use Tomato Toolbox to compress the images in this folder to under 500 KB.

The script writes `~/.dsh/profiles/*/cordis.patch.yml` (with a backup), installs the Skill to `~/.dsh/skills/tomato-toolbox`, and starts MCP through the app's own executable in Node mode. To undo: double-click `一键移除DSH接入.cmd` (backs up the config; removes the Skill too, backed up under `~/.dsh/skill-backups/`).

### Qoder

1. **Fully quit Qoder first.**
2. Double-click `一键接入Qoder.cmd` in the app folder.
3. Open Qoder and **start a new conversation**; ask:
   > Use Tomato Toolbox to compress the images in this folder to under 500 KB.

The script writes `mcpServers.tomato-toolbox` in `~/.qoder-cn/settings.json` (with a backup; other MCP servers and providers are preserved), installs the Skill to `~/.qoder-cn/skills/tomato-toolbox`, and starts MCP through the app's own executable. To undo: double-click `一键移除Qoder接入.cmd`.

Qoder's tool prefix is `mcp__tomato_toolbox__`; DSH's is `mcp__tomato-toolbox__`.

**Check it after setup**: double-click `一键体检Agent接入.cmd`. It checks configs and Skills for DSH / Qoder / Trae / WorkBuddy / ZCode and actually starts each MCP server to count tools; it is read-only and reports exactly which step failed. Trae / WorkBuddy / ZCode / Claude currently require manual setup and will be reported as "not integrated".

> Existing conversations keep the tool list they started with; after installing, **start a new Qoder conversation**. Other clients use the manual setup below.

## 3. Manual setup

### 3.1 Command

From source:

```text
command: node
args: ["<repo>/app/mcp/server.mjs"]
```

Packaged build (recommended; no Node install):

```text
command: "<app>/番茄图片混淆桌面版.exe"
args: ["<app>/resources/app/mcp/server.mjs"]
env:
  ELECTRON_RUN_AS_NODE: "1"
  TOMATO_USERDATA_DIR: "<app>/userdata"
```

### 3.2 DSH config

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

### 3.3 Claude Desktop / JSON clients

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

Qoder stores custom MCP servers in `~/.qoder-cn/settings.json` (international: `~/.qoder/settings.json`), under `mcpServers`:

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

Fully quit and reopen Qoder, then start a new conversation. Qoder normalizes the prefix to `mcp__tomato_toolbox__`.

Full fields, source-tree paths, and troubleshooting: [`Agent接入说明.md`](../Agent接入说明.md) (Chinese).

## 4. Environment variables

| Variable | Purpose |
|---|---|
| `TOMATO_USERDATA_DIR` | `userdata` location (audit log, video-download approval) |
| `TOMATO_MCP_ALLOWED_ROOTS` | Path allowlist, semicolon-separated; defaults to home / temp / app folder |
| `TOMATO_MCP_READONLY` | `1` = read-only mode, only query/status tools |

Example:

```json
"env": {
  "ELECTRON_RUN_AS_NODE": "1",
  "TOMATO_USERDATA_DIR": "D:/TomatoToolbox/userdata",
  "TOMATO_MCP_ALLOWED_ROOTS": "D:/AI-Workspace;D:/Output",
  "TOMATO_MCP_READONLY": "1"
}
```

## 5. Video-download approval

- Asks **every time** by default;
- Without approval, `video_download` returns `NEEDS_APPROVAL` and downloads nothing;
- Approve in the app's Video Download page: **Allow once**, or **Allow the AI assistant to download (this run)**;
- Only the GUI writes the approval file; MCP reads it;
- Closing the app clears the session grant.

## 6. Security boundary (read this)

**Enforced by the server:**

- path allowlist;
- no overwrite (unique output names; `archive_extract` / `file_rename_batch` reject overwrite options);
- no delete tool;
- read-only mode;
- audit log at `userdata/mcp-audit.jsonl` (password/secret/token redacted);
- video-download human approval.

**Not enforced:**

- most tools **execute immediately** with no confirmation dialog;
- passwords enter the client/model context;
- the audit log is after-the-fact, not a blocker;
- **not a sandbox**: MCP runs with the current user's privileges;
- the user can widen the allowlist.

See [Security](security.md).

## 7. Skill

- Repository: [`skills/tomato-toolbox/SKILL.md`](../../skills/tomato-toolbox/SKILL.md)
- Tool reference: [`skills/tomato-toolbox/references/tools.md`](../../skills/tomato-toolbox/references/tools.md)
- DSH install path: `~/.dsh/skills/tomato-toolbox/`
- Qoder install path: `~/.qoder-cn/skills/tomato-toolbox/`
- Packaged copy: `<app>/skills/tomato-toolbox/`
- Other clients: copy the folder into their skills directory; clients without skills can use MCP only.

The Skill is guidance, not executable code; execution still goes through MCP tools.

## 8. Troubleshooting

**DSH shows no tools.**
Fully quit and restart DSH; verify `mcp-tomato-toolbox` in `cordis.patch.yml`; check DSH logs for MCP errors.

**Qoder shows no tools.**
Fully quit and reopen Qoder, and start a new conversation; confirm `mcpServers.tomato-toolbox` exists in `~/.qoder-cn/settings.json`; the tool prefix is `mcp__tomato_toolbox__`.

**`NEEDS_APPROVAL`.**
Approve in the Video Download page, then retry.

**"Outside the allowed roots".**
Add the folder to `TOMATO_MCP_ALLOWED_ROOTS`, or move the file into home / app / temp.

**Read-only queries only.**
Set `TOMATO_MCP_READONLY=1`.

**Third-party client compatibility.**
Core `initialize` / `tools/list` / `tools/call` are implemented; elicitation, progress, cancellation, and resources content are not.
