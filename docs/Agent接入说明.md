# 给 AI 助手用（MCP 接入说明）

这个软件现在有两个人机入口：

- **人**：双击打开，照旧点界面。
- **AI 助手**：通过本地 MCP server 调用同一批能力，不用开窗口。

> 目前已经接入 **41 个 MCP 工具**，覆盖 21 个 GUI 工具（视频播放器、软件卸载按需求不暴露）。

---

## 一、先启动 MCP server

在软件目录（开发态是 `app/`）执行：

```powershell
node app/mcp/server.mjs
```

它走 stdio：客户端把它当子进程启动，通过标准输入/输出通信。
**不要把 stdout 的日志打进去**；日志都在 stderr。

---

## 二、在 agent 客户端里配置

把路径换成你机器上的真实路径：

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

打包版把路径换成软件目录：

```json
{
  "mcpServers": {
    "tomato-toolbox": {
      "command": "node",
      "args": ["C:/.../番茄图片混淆-桌面版-v<版本>-win64/resources/app/mcp/server.mjs"],
      "env": {
        "TOMATO_USERDATA_DIR": "C:/.../番茄图片混淆-桌面版-v<版本>-win64/userdata"
      }
    }
  }
}
```

- DSH / Claude Desktop / Qoder / Trae 等支持 MCP 的客户端都能用这段配置。
- `TOMATO_USERDATA_DIR` 指向软件目录的 `userdata`（打包态是 exe 同目录的 `userdata`）。
  它用于让 MCP 读到 GUI 写的「视频下载授权」文件。

### 配套 Skill（可选但推荐）

仓库里带了一个 Skill 包：`skills/tomato-toolbox/`

- `SKILL.md`：铁律、41 个工具地图、8 个常用配方、故障排查；
- `references/tools.md`：每个工具的完整参数。

它教 agent「什么时候用、按什么顺序用、什么不能做、做完怎么验证」，执行仍然走 MCP 工具。

**DSH**：已经把 `skills/tomato-toolbox/` 复制到 `~/.dsh/skills/tomato-toolbox/`。DSH 刷新技能目录/重启后，在技能列表里能看到 `tomato-toolbox`。

**打包版**：`<软件目录>/skills/tomato-toolbox/` 里也带了一份；`<软件目录>/Agent接入说明.md` 就是本文。

**其它客户端**：把 `skills/tomato-toolbox/` 整个文件夹放到该客户端的 skills 目录；没有 skills 机制的客户端可以忽略——只配 MCP 也能用，只是少了一层流程指导。

### 需要常驻后台吗

**不需要。** MCP server 是客户端按需启动的 stdio 子进程：
- 客户端打开/加载 MCP 时启动，客户端关闭时退出；
- 不监听端口、不装 Windows 服务、不写注册表、不开机自启；
- 只有「视频下载」需要 GUI 授权时才需要打开软件；其它工具不需要 GUI；
- 长任务（视频转码/下载）期间不要关客户端，否则子进程会跟着结束。

---

## 三、视频下载的授权

视频下载是唯一联网工具，默认**每次都要你授权**：

1. AI 调 `video_download`；
2. 如果没授权，工具返回 `NEEDS_APPROVAL`，不会下载任何东西；
3. 你在软件「视频下载」页二选一：
   - 打开「允许 AI 助手直接下载（本次运行有效）」——本次运行内不再问；
   - 点「允许一次」——只放行下一次（5 分钟有效）；
4. 让 AI 重试即可。

**AI 改不了这个开关**：授权文件只由软件界面写，MCP 只读。

---

## 四、能给 AI 用的能力（按类）

| 类别 | 能力 |
|---|---|
| 图片 | 混淆/解混淆、压缩、变清晰、AI 放大、格式转换、加水印、长图拼接、九宫格切图、文件藏图 |
| 视频 | 格式转换、视频压缩、动图互转、视频下载（受限）、媒体探测 |
| 音频 | 格式转换、剪辑、语音转文字 |
| 文档 | PDF 组装/合并/拆分/提取页、PDF→图片、PDF 压缩、PDF 编辑（水印/页码/旋转/重排/加密/解密）、Office→PDF、PDF→Word、文档格式转换、文字识别、可搜索 PDF、OCR→Word |
| 文件 | 批量重命名、压缩/解压/免解压预览 |

完整工具名与参数见 `app/mcp/README.md`。

---

## 五、安全与使用习惯

### 服务端强制的
- **路径白名单**：默认只允许「用户目录 / 系统临时目录 / 软件目录」。要处理别的盘，给 MCP server 加：
  ```json
  "env": { "TOMATO_MCP_ALLOWED_ROOTS": "D:\\素材;E:\\输出" }
  ```
  白名单之外的读写会被拒绝。
- **不覆盖**：产物重名自动加序号；`archive_extract` 不允许 `overwrite:"replace"`，`file_rename_batch` 不允许 `conflict:"overwrite"`（要覆盖请用软件界面）。
- **不删文件**：MCP 没有删除工具。
- **只读模式**：设 `TOMATO_MCP_READONLY=1`，只暴露查询/状态类工具，写工具既不列出也拒绝调用。
- **审计日志**：每次调用写 `userdata/mcp-audit.jsonl`（时间、工具、参数、耗时、结果、客户端；password/secret/token 字段脱敏）。
- **视频下载要授权**：默认每次问；「本次运行」授权关掉软件就失效。

### 不是强制的（必须知道）
- **大多数工具是「调用即执行」**：没有人工确认弹窗；只有视频下载有授权闸门。AI 说「开始处理」就会真的写文件。
- **密码会进入客户端上下文**：审计日志脱敏，但客户端/模型仍能看到参数；不要把密码贴在聊天里。
- **审计是事后记录**：能追溯，不能阻止一次错误调用。
- **白名单可以被用户放宽**：`TOMATO_MCP_ALLOWED_ROOTS` 是用户的显式选择。

### 通用习惯
- **重命名先预览**：默认 `dry_run=true`，确认后再落盘。
- **不暴露原始命令**：agent 只能选格式/画质/体积等高层参数，不能塞 ffmpeg/7z 原始参数。
- **大文件先估算**：GB 级视频/大量图片先问清耗时与磁盘空间。

---

## 六、常见问题

**Q：agent 说「未知工具」？**
A：客户端连到的 server 太旧，或配置的路径不对；确认 `app/mcp/server.mjs` 存在并重启客户端。

**Q：视频下载一直 `NEEDS_APPROVAL`？**
A：打开软件「视频下载」页，点「允许一次」，再让 AI 重试；或打开「本次运行有效」开关。

**Q：PDF 渲染/压缩报 pdfjs 错误？**
A：MCP 用的是 `pdfjs-dist/legacy` 构建；打包产物里已包含 `legacy/build`。开发态请确认 `app/node_modules/pdfjs-dist/legacy` 存在。

**Q：OCR/ASR 说缺加装包？**
A：把 `addons/ocr` 或 `addons/asr` 放回软件目录；缺包时其余工具不受影响。
