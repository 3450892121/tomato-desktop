# 模块：文档格式转换（doc-convert）

> 更新记录：v0.1（2026-10-04）新增模块（用户需求：把老办公文档转成通用格式；起因是一份教务系统导出的「假 .xls」——Excel 2003 XML 内容 + .xls 扩展名，手机端打不开）。

## 目标
把老版 Office 文档（97-2003 与「2003 XML」系）批量转成现代通用格式（docx / xlsx / pptx / PDF），产物在手机、新电脑、微信/QQ 预览里都能直接打开。典型场景：
- 教务/办公系统导出的 **假 .xls**（内容是 Excel 2003 XML SpreadsheetML）：Excel 打开弹「格式与扩展名不符」警告，手机 WPS/预览按扩展名判断直接打不开 → 转成真 .xlsx。
- 老 .doc / .xls / .ppt / .pps / .rtf → 对应新格式。

## 范围
工具目录 `src/tools/doc-convert/`，id `doc-convert`，左侧名「文档格式转换」，分组 doc，order 26，图标 📄。
引擎 = **随包 LibreOffice 加装包**（`addons/libreoffice/`，MPL 2.0，与「PDF 转格式」共用同一套查找/短路径联接/超时杀树机制），经 `libreoffice:convert` IPC 调用（target 白名单扩至 pdf/docx/xlsx/pptx）。

### 输入
| 扩展名 | 实际内容 | 转换目标（智能模式） |
|---|---|---|
| .doc | Word 97-2003 二进制 / Word 2003 XML | .docx |
| .docx | 现代格式（已是新格式 → 智能模式提示无需转换；可手动选 PDF） | — / .pdf |
| .xls | Excel 97-2003 二进制（BIFF）/ **Excel 2003 XML（假 .xls）** | .xlsx |
| .xlsx | 现代格式（同 .docx 处理） | — / .pdf |
| .ppt | PowerPoint 97-2003 | .pptx |
| .pps | PowerPoint 放映格式 | .pptx |
| .pptx | 现代格式（同 .docx 处理） | — / .pdf |
| .rtf | 富文本（写字板/老系统常用） | .docx |

### 输出
- **智能（推荐）**：按上表「老格式 → 对应新格式」自动选目标；已经是新格式的文件不动并提示。
- **手动指定** docx / xlsx / pptx / PDF：跨家族强制（如 xls→docx）与同扩展名转换会被拒绝并给可读原因。
- 产物与原文件同目录（重名自动加序号，走主进程 uniqueTargetPath）；列表逐项显示「原格式 → 新格式」与结果。

## 非目标
- 不做 PDF→Word（「PDF 转格式」已有，含可编辑文本压平）。
- 不做「新格式 → 老格式」倒退转换（与工具目标相反）。
- 不支持金山 WPS 2000 时代的 .wps/.et/.dps（Kingsoft 私有格式，LibreOffice 无导入过滤器；新版 WPS 的 .wps 实为 docx 变体，重命名为 .docx 即可打开——在工具说明里告知）。
- 不做内容编辑、样式微调；保真度以 LibreOffice 导入导出过滤器为准。

## 技术选型与依据
- **LibreOffice headless `--convert-to`**：唯一同时满足「纯离线 + 免费 + 保真度可接受 + 已随包」的引擎；本机实测（2026-10-04）：教务系统导出的 Excel 2003 XML 假 .xls 经 `--convert-to xlsx`（Calc Office Open XML 过滤器）转换成功，产物可被 SheetJS 读回。与「PDF 转格式」共用 `libreoffice:convert`（独立 profile、短路径联接、动态超时、taskkill 杀树），不新增进程管理代码。
- SheetJS（vendor/xlsx 0.20.3，社区版）**能解析** Excel 2003 XML（实测用户样本 61 行数据完整读出），但只保数据不保样式（列宽/合并单元格/字体丢失），且其 `readFile`/`writeFile` 的 fs 直读直写分支在本项目运行环境不可用（须用 `XLSX.read/write` 的 buffer 型；首次误判为「解析不了」，实为 fs 分支问题）。故转换引擎选 LibreOffice 保真；SheetJS 仅用于测试期读回校验，「无 LibreOffice 时 xls→xlsx 的数据级降级」列为后续可选增强。
- 无 LibreOffice 加装包时：工具页状态提示「把加装包解压到软件目录的 addons/libreoffice」，运行按钮禁用（与音频工具对 ffmpeg 的降级同款）。
- 队列：走任务队列 **cpu 通道（串行）**——LibreOffice 转换共用同一 profile 目录，并发起多个 soffice 实例会撞 profile 锁；取消语义=在跑的转换等它自然结束后丢弃产物（profile 不留锁，队列后续任务不受影响）。

## 已知限制
- 样式保真取决于 LibreOffice 过滤器：复杂公式/图表/艺术字可能降级（数据与文字内容保留）。
- 加密文档（打开密码）无法转换，报「源文件可能已加密或格式不受支持」。
- .rtf → .docx 保留文字与基本格式；复杂排版（文本框等）可能简化。
- 完全损坏/非文档的垃圾文件：LibreOffice 的内容嗅探可能不报错而「转出一张空表格」（实测行为）——工具侧不做内容校验，坏输入的产物可能是空文档。

## 验证（v2.13.0 实测回填，2026-10-04）
- `tests/docconvert.test.mjs`：11 项纯逻辑全绿（挂 npm test，合计 297 项）。
- `--doc-test`（引擎级，`ok:true`）：程序内生成「假 .xls」（Excel 2003 XML，**行必须包在 `<Table>` 里**，缺了 LibreOffice 会转出空表）/ 真 BIFF .xls / RTF / 坏文件夹具，经渲染进程走真实 IPC 转 xlsx/docx/pdf；xlsx 单元格与 docx 正文读回一致、PDF 魔数正确、坏文件给确定结果（LibreOffice 对垃圾字节可能转出空表而非报错——固有嗅探行为，列入已知限制）。**本文件不直接起子进程**（Mimosa 安全钩子要求，转换一律走真实 IPC，由主进程调 soffice）。
- `--doc-ui-test`（界面级，`pass:true`）：切工具 → 添加夹具（独占前缀「测试老文档」）→ 智能转换 → 产物落盘且内容读回一致 → 清空 → **收尾自清家族文件**（pdf-convert 的测试对话框按扩展名全收，残留会把它的「成功 2 个」污染成「成功 4 个」——当天踩到）。
- 回归：smoke（tools=23）、self、media（含 oldimage 段）、media-ui、theme、audio、pdf、pdf-ui 全绿。
- 已知边界：.doc/.ppt 的真实二进制夹具测试里造不出来（需外部生产器），它们与 rtf→docx 走完全相同的处理链（同一 handler、同一白名单、同族导入过滤器由 LibreOffice 按内容自选），家族映射由纯逻辑单测钉住。
