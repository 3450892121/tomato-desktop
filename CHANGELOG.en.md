# Changelog (English)

This is a curated English summary of recent releases. The complete, authoritative history is in
[`CHANGELOG.md`](CHANGELOG.md) (Chinese).

## v2.15.0 — 2026-10-18

**One-click DSH setup; documentation overhaul.**

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
