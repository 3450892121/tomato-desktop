# Security

[Documentation](../README.md) · [Agent access](agent.md) · [中文](../zh/security.md)

> This page separates **what the server enforces** from **what is only a convention**. Nothing here is a guarantee of absolute safety.

## 1. Threat model

This is a **local desktop tool**. It assumes:

- the person using it owns the machine;
- the machine is not infected with malware;
- the connected agent client is trusted;
- the user understands the AI may process the wrong file.

It does **not** protect against:

- a malicious process running as the same user;
- a compromised agent client;
- a user who deliberately widens the allowlist;
- physical access to the machine.

## 2. Enforced by the server

### 2.1 Path allowlist

Default roots:

- the user's home directory (Desktop / Documents / Downloads included);
- the system temp directory;
- the app directory.

Other drives/directories are rejected. To allow them:

```text
TOMATO_MCP_ALLOWED_ROOTS=D:\assets;E:\output
```

The check is applied in `assertFile` / `assertDir` / `resolveOutputPath`, ffmpeg / LibreOffice runners, rename, and video-download output.

### 2.2 No overwrite

- duplicate output names get a numeric suffix;
- `archive_extract` rejects `overwrite:"replace"`;
- `file_rename_batch` rejects `conflict:"overwrite"`;
- video download uses `--no-overwrites` + `wx` writes.

Use the GUI if you really need to overwrite.

### 2.3 No delete

MCP has no delete tool; Software Uninstall is not exposed.

### 2.4 Read-only mode

With `TOMATO_MCP_READONLY=1`, only these are exposed:

`media_probe`, `archive_list`, `pdf_page_count`, `ocr_recognize`, `ocr_status`, `asr_status`, `libreoffice_status`, `video_download_status`.

Write tools are neither listed nor callable.

### 2.5 Audit log

Every `tools/call` appends to:

```text
userdata/mcp-audit.jsonl
```

It records time, tool, arguments, duration, result, and client `clientInfo`; `password / secret / token` fields are recursively redacted.

**It is after-the-fact.** It does not block a call, and it does not rotate automatically.

### 2.6 Video-download approval

- asks every time by default;
- no approval → `NEEDS_APPROVAL`, zero download;
- only the GUI writes the approval file; MCP reads it;
- closing the app clears the session grant.

> The approval file is not signed / HMAC'd. A same-user malicious process could forge it. That is acceptable for a local desktop app's threat model, but it is not a cryptographic guarantee.

## 3. Not enforced

### 3.1 Most tools run immediately

Only Video Download has a GUI approval gate. Image compression, conversion, PDF, OCR, archives, batch rename, etc. write files as soon as the agent calls them.

There is no per-write confirmation dialog. True per-step human approval would require MCP elicitation or a GUI approval flow; it is **not implemented**.

### 3.2 Passwords enter the client context

The audit log redacts them, but the agent client / model still sees tool arguments. Do not paste passwords into chat; let the user enter them in the GUI, or accept that they enter the context.

### 3.3 Not a sandbox

MCP runs with the current user's privileges. The allowlist only blocks clearly out-of-scope paths; it does not restrict:

- processes or network (Video Download is online by design);
- reading any file inside the allowed roots;
- writing new files inside the allowed roots;
- calling ffmpeg / LibreOffice and other external programs.

## 4. Recommended usage

### Read-only by default

```text
TOMATO_MCP_READONLY=1
```

Use it for browsing, queries, OCR, and probing; turn it off only for a specific file-processing task.

### One workspace

```text
TOMATO_MCP_ALLOWED_ROOTS=D:\AI-Workspace
```

Do not grant the whole home directory up front.

### Back up important files

The app does not overwrite originals, but it has no undo. Back up before batch jobs.

### Preview batch rename

Ask the agent to use `dry_run=true` first.

### Keep video approval on "ask every time"

Do not leave the session grant on; closing the app clears it.

### Check the audit log occasionally

```text
userdata/mcp-audit.jsonl
```

If something looks wrong, disconnect the agent and narrow the allowlist.

## 5. Known gaps

- no general per-write human confirmation;
- approval file is unsigned;
- audit log does not rotate;
- no built-in undo / recycle bin;
- real third-party MCP clients are not all tested;
- Video Download depends on yt-dlp and can break when sites change.
