# 安全说明

[文档中心](../README.md) · [Agent 接入](agent.md) · [English](../en/security.md)

> 这一页把「已经强制的」和「只是约定 / 没做的」分开写。不要把这里的任何一条理解成「绝对安全」。

## 1. 威胁模型

软件是**本地桌面工具**，默认假设：

- 运行软件的人是这台电脑的主人；
- 本机没有恶意软件；
- 连接的 Agent 客户端是用户自己信任的；
- 用户知道 AI 可能会处理错文件。

它**不防**：

- 同用户的恶意进程；
- 被攻破的 Agent 客户端；
- 用户主动把文件放到白名单外又自己放宽；
- 物理接触电脑的人。

## 2. 服务端强制的

### 2.1 路径白名单

默认只允许：

- 用户目录（含桌面 / 文档 / 下载）；
- 系统临时目录；
- 软件目录。

其它盘 / 目录会被拒绝。需要处理别的目录，显式设置：

```text
TOMATO_MCP_ALLOWED_ROOTS=D:\素材;E:\输出
```

白名单在 `assertFile` / `assertDir` / `resolveOutputPath` / ffmpeg / LibreOffice / 重命名 / 视频下载输出目录上统一校验。

### 2.2 不覆盖

- 所有产物重名自动加序号；
- `archive_extract` 拒绝 `overwrite:"replace"`；
- `file_rename_batch` 拒绝 `conflict:"overwrite"`；
- 视频下载使用 `--no-overwrites` + `wx` 写入。

要覆盖已有文件，请用 GUI，MCP 不提供。

### 2.3 不删除

MCP 没有删除工具；「软件卸载」也不暴露给 Agent。

### 2.4 只读模式

设置 `TOMATO_MCP_READONLY=1` 后，只暴露：

`media_probe` / `archive_list` / `pdf_page_count` / `ocr_recognize` / `ocr_status` / `asr_status` / `libreoffice_status` / `video_download_status`。

写工具既不列出，也拒绝调用。

### 2.5 审计日志

每次 `tools/call` 追加：

```text
userdata/mcp-audit.jsonl
```

记录时间、工具、参数、耗时、结果、客户端 `clientInfo`；`password / secret / token` 字段递归脱敏。

**它是事后记录，不是拦截。** 也不会自动轮转；长期使用可以自己清理或归档。

### 2.6 视频下载授权

- 默认每次询问；
- 无授权返回 `NEEDS_APPROVAL`，零下载；
- 授权文件只由 GUI 写，MCP 只读；
- 关掉软件，session 授权失效。

> 授权文件没有签名 / HMAC。同用户的恶意进程理论上可以伪造；这是本地桌面软件的威胁模型，不是密码学保证。

## 3. 不是强制的

### 3.1 大多数工具调用即执行

只有视频下载有 GUI 授权闸门。图片压缩、格式转换、PDF、OCR、压缩解压、批量重命名等，Agent 一调用就会真的写文件。

没有「每次写操作弹窗确认」。要彻底做到每一步人工确认，需要 MCP elicitation 或 GUI 审批，目前**没有实现**。

### 3.2 密码会进入客户端上下文

审计日志会脱敏，但 Agent 客户端 / 模型仍然能看到工具参数。不要把密码贴在聊天里；需要密码时让用户在软件里操作，或接受它进入上下文。

### 3.3 不是沙箱

MCP 进程以当前用户权限运行；白名单只挡明显越界路径，不限制：

- 进程、网络（视频下载本来就要联网）；
- 读取白名单内任意文件；
- 写白名单内任意新文件；
- 调用 ffmpeg / LibreOffice 等外部程序。

## 4. 推荐用法

### 日常只读

```text
TOMATO_MCP_READONLY=1
```

浏览、查询、OCR、探测用它；要处理文件时再临时关掉。

### 只给一个工作目录

```text
TOMATO_MCP_ALLOWED_ROOTS=D:\AI工作区
```

不要一上来就给整个用户目录；需要时再加。

### 重要文件先备份

工具保证不覆盖原文件，但没有「撤销」；批量任务前先备份。

### 批量重命名先预览

让 Agent 先 `dry_run=true` 给你看计划，确认后再落盘。

### 视频下载保持默认「每次询问」

不要把 session 授权长期打开；用完关掉软件即失效。

### 偶尔看审计日志

```text
userdata/mcp-audit.jsonl
```

能追溯谁在什么时候调了什么；发现异常就断开 Agent、收紧白名单。

## 5. 已知缺口

- 没有通用「每次写操作人工确认」；
- 授权文件没有签名；
- 审计不自动轮转；
- 没有内置撤销 / 回收站；
- 真实第三方 MCP 客户端兼容性未逐一实测；
- 视频下载依赖 yt-dlp，站点改版可能失败，引擎更新需要联网。
