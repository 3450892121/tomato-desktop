# Changelog (English)

This is a curated English summary of recent releases. The complete, authoritative history is in
[`CHANGELOG.md`](CHANGELOG.md) (Chinese).

## Unreleased — Qoder / Trae / WorkBuddy / ZCode one-click setup + agent setup check

- Added Trae / WorkBuddy / ZCode setup + removal scripts: `一键接入Trae.cmd`, `一键接入WorkBuddy.cmd`, `一键接入ZCode.cmd` and the matching `一键移除…接入.cmd`, backed by `setup-agent-mcp.ps1` / `uninstall-agent-mcp.ps1`.
  - Trae writes `%APPDATA%\Trae CN\User\mcp.json` (or `Trae\User\mcp.json`) with `{command,args,cwd,env}` (Trae's schema has no `type` field).
  - WorkBuddy writes `~/.workbuddy/mcp.json` with `{type:"stdio",command,args,cwd,env}`; a **one-time Trust click** in "MCP 服务管理" is required before the chat can see the tools.
  - ZCode writes `~/.zcode/cli/config.json` under `mcp.servers` with `{type:"stdio",command,args,cwd,env,timeoutMs}`; its MCP page toggle must be on.
  - Field shapes were read from each client's own installed code/schema, not copied from another client.
- Added `一键接入Qoder.cmd` / `一键移除Qoder接入.cmd` and `setup-qoder-mcp.ps1` / `uninstall-qoder-mcp.ps1`:
  - writes `mcpServers.tomato-toolbox` in `~/.qoder-cn/settings.json` (backup first; other MCP servers and providers preserved);
  - installs the Skill to `~/.qoder-cn/skills/tomato-toolbox`;
  - starts MCP through the app's own executable with `ELECTRON_RUN_AS_NODE=1`;
  - no JSON editing, no commands, no Node.js installation.
- Added `一键体检Agent接入.cmd` / `verify-agent-mcp.ps1`: read-only check of DSH / Qoder (CN + international) / Trae (CN + international) / WorkBuddy / ZCode / Claude Desktop; validates config paths and Skill, and **actually starts each configured MCP server to count tools** (41 expected). Reports healthy / broken / not integrated, names the failing step, exits 1 on problems (`-NoProbe` skips launching, `-Json` for machine output). Never changes config.
- Hardened setup/uninstall scripts: backups never overwrite (same-second runs get `-2`, `-3`); read-back verification after writing with automatic rollback; invalid JSON / wrong shape leaves the file byte-identical; Skill install now backs up, removes, then reinstalls and verifies `SKILL.md`; DSH removal now removes the Skill too (backup under `~/.dsh/skill-backups/`) and exits cleanly when DSH is absent.
- Tests: new `tests/agent-mcp-scripts.test.mjs` (16 cases, wired into `npm test`) covers preservation of other servers/providers/Chinese comments, idempotent re-setup, non-overwriting backups, clean removal, refusal to touch broken configs, creating a missing config, Trae's missing `type`, WorkBuddy's HTTP entry preservation, ZCode's nested `mcp.servers`, and a real MCP launch from the generated config (41 tools).
- Verified on the real machine: Qoder called `mcp__tomato_toolbox__libreoffice_status` successfully; after removal + full restart it reported no Tomato tools; after re-setup + restart it reported 41 tools. DSH was removed, verified, and restored byte-for-byte (SHA256 match).
  - Trae CN: called `libreoffice_status` successfully; after removal + restart it answered "none"; after re-setup + restart the call worked again.
  - WorkBuddy: MCP manager showed a Trust button, then `41/41 tools enabled`; a real chat call succeeded; after removal + restart the server disappeared; after re-setup it returned with 41/41.
  - ZCode: MCP page showed `tomato-toolbox` connected (stdio), and its edit page read back command/args/env correctly; after removal + restart it disappeared; after re-setup it came back connected. ZCode has no model configured on this machine, so only connect/recognise was verified (no paid model config was changed).
  - `一键体检` reports DSH / Qoder CN / Trae CN / WorkBuddy / ZCode all healthy with 41 tools; Qoder international and Trae international are not integrated.
- Skill self-check accepts both `mcp__tomato-toolbox__` (DSH) and `mcp__tomato_toolbox__` (Qoder).
- Packaging: `pack.js` copies the Qoder scripts plus the new check script; a full release build is pending.

## v2.15.0 — 2026-10-18

**One-click MCP setup (DSH first); documentation overhaul.**

- Added `一键接入DSH.cmd` / `一键移除DSH接入.cmd`:
  - writes `~/.dsh/profiles/*/cordis.patch.yml` (backup first);
  - installs the Skill to `~/.dsh/skills/tomato-toolbox`;
  - starts MCP through the app's own executable with `ELECTRON_RUN_AS_NODE=1`;
  - no JSON editing, no commands, no Node.js installation;
  - `toolCallTimeoutMs` set to 1 hour for long media jobs.
- Added `setup-dsh-mcp.ps1` / `uninstall-dsh-mcp.ps1`; both tested on Windows PowerShell 5.1 and PowerShell 7.
- Packaged both scripts into the release folder.
- Documentation restructured into a main README + sub-documents, with Chinese and English versions, and v2.15.0 release notes.
- The generated config was tested against a temporary DSH profile and launched all 41 MCP tools.
- One-click setup currently targets DSH only; other clients still use manual JSON.

## v2.14.1 — 2026-10-18

**MCP security hardening.**

- **Path allowlist**: default home / temp / app; override with `TOMATO_MCP_ALLOWED_ROOTS`.
- **Audit log**: every `tools/call` appends to `userdata/mcp-audit.jsonl`; password/secret/token redacted.
- **Read-only mode**: `TOMATO_MCP_READONLY=1` exposes only query/status tools.
- **No overwrite**: `archive_extract` rejects `replace`; `file_rename_batch` rejects `overwrite`.
- **Explicit boundary**: most tools execute immediately with no confirmation dialog; only Video Download has a human-approval gate. The audit log is after-the-fact and MCP is not a sandbox.
- MCP tests increased from 18 to 21 (path rejection, audit log/redaction, read-only mode, no-overwrite).
- Packaged MCP smoke increased from 8 to 9 (path allowlist + audit log in the packaged build).

## v2.14.0 — 2026-10-18

**Local MCP server + video-download approval + Skill package.**

- 41 MCP tools covering 21 GUI tools; Video Player and Software Uninstall are not exposed.
- Local stdio JSON-RPC (`initialize` / `tools/list` / `tools/call`); no port, no service.
- Video Download requires GUI approval; the approval file is written only by the GUI and read by MCP.
- Skill at `skills/tomato-toolbox/` with `SKILL.md` + `references/tools.md`.
- Packaged build includes `mcp/`, pdfjs legacy, the Skill, and the agent guide.

## v2.13.0 — 2026-10-04

**Document conversion tool (23rd tool) and legacy input formats.**

- Old Word / Excel / PPT / RTF and Excel 2003 XML "fake .xls" → docx / xlsx / pptx / PDF via bundled LibreOffice.
- Image Convert adds TIFF / PCX / TGA / PSD / DDS / JPEG2000 input (via bundled ffmpeg).
- Video Convert adds asf / 3g2 / f4v / mts / m2ts; Audio Convert adds shn / voc / mka.

For earlier releases, see [`CHANGELOG.md`](CHANGELOG.md).
