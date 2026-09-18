# 模块：PDF 转格式（pdf-convert）

> 更新记录：v0.1（2026-09-18）新增模块。范围由用户 2026-09-18 选定的「第一期方向」确定；技术选型依据见文末，来源为公开文档与 2026 年第三方对比测试（细节标注「待实测」的均为推断，未经项目内验证）。

## 目标
把电脑上最常见的 PDF 相关转换做成**一个入口、多个方向**的傻瓜工具：PDF 转图片、图片转 PDF、PDF 合并/拆分/提取页、Word/Excel 转 PDF、PDF 转 Word。保持与主程序一致的定位：**纯离线、免安装绿色、界面自带说明**。

## 范围（第一期，共 5 个方向）
工具形态：一个工具（`src/tools/pdf-convert/`，id `pdf-convert`，左侧名「PDF 转格式」，order 20），界面顶部选「转换方向」，下方随方向切换参数区——与图片混淆工具的多模式交互保持一致。

### 1. PDF → 图片（PNG/JPG）
- 页范围：全部（默认）/ 指定页（如 `1-3,5`）。
- 清晰度档位：1× / 2× / 3×（约 72 / 144 / 216 DPI，默认 2×）——DPI 换算为推断，待实测。
- 格式：PNG（默认，无损）/ JPG（画质可调，默认 90）。
- 批量：一次可加多个 PDF；每个 PDF 导出到「原文件同目录的 `<原文件名>_图片` 文件夹」，命名 `页001.png` 起（重名自动加序号）。
- 扫描件天然支持（逐页光栅化，与文本层无关）。

### 2. 图片 → PDF（多图合成一份）
- 输入支持 JPG/PNG；其他格式（webp 等）先经 `shared/imageio.js` 解码再嵌入（推断可行，待验证）。
- 顺序 = 列表顺序，支持上下移动调整。
- 页面：按图片原始尺寸建页；可选「适应 A4」与「页边距（无 / 小 / 中）」。
- JPG 直接嵌入不重编码；PNG 无损重打包。

### 3. PDF 合并 / 拆分 / 提取页
- 合并：多份 PDF 按列表顺序合成一份。
- 拆分：每个页面一个文件 / 每 N 页一个文件。
- 提取：输入页码范围（如 `1-3,5-7`）抽成一个新 PDF（兼作重排/删页手段）。

### 4. Word/Excel → PDF
- **已装 LibreOffice 加装包**：走 `soffice --headless --convert-to pdf`（高保真；支持 .doc/.docx/.xls/.xlsx）。
- **未装加装包**（内置降级）：`.docx` → docx-preview 渲染 → Electron 内置 `printToPDF`；`.xlsx` → SheetJS 读取 → 渲染表格 → `printToPDF`。仅支持 .docx/.xlsx；文本类文档效果好，复杂版式一般；旧版 .doc/.xls 提示需加装包。

### 5. PDF → Word（.docx）
- **必须依赖 LibreOffice 加装包**，命令：`soffice --headless --infilter="writer_pdf_import" --convert-to docx --outdir <目录> <文件>`。
- **关键**：必须显式指定 `writer_pdf_import` 过滤器；缺省时 LibreOffice 会走 Draw 通道，输出一堆散架文本框（来源见选型依据）。
- 未装加装包：界面提示「获取并放置加装包」的操作说明，**不提供降级**（避免"转出来不像"的预期落差）。
- 效果如实提示：单栏文档良好；多栏/复杂表格还原有限（第三方测试：LibreOffice 77/125 分 vs pdf2docx 93/125）。

## LibreOffice 加装包（可选件）
- 形态：独立文件夹 `addons/libreoffice/`，放在软件目录下；**不进 git、不进主安装包**（体积约 300–700 MB，估算，待实测）。
- 探测：启动时检查 `addons/libreoffice/program/soffice.com` 是否存在；界面显示「已安装 / 未安装」及获取说明。
- 便携化：调用时传 `-env:UserInstallation=file:///<软件目录>/addons/libreoffice-profile`，不写系统目录。
- 串行执行：LibreOffice 内部排队转换，不支持并行（来源见选型依据），批量时依次调用并显示进度。
- 许可：MPL-2.0（宽松，允许随包分发）。

## 输入 / 输出
- 输入：PDF 文件（多选 / 拖拽 / 文件夹）、图片文件、Word/Excel 文件、页范围与参数。
- 输出：图片序列、PDF 文件、docx 文件；保存位置遵循现有 `settings` 输出目录规则（默认原文件旁边），重名自动加序号，不覆盖已有文件。

## 非目标（本期不做）
- 不做加密 / 解密 / 压缩 / 旋转 / 水印 / OCR（扫描件转文字）；不做 PDF→Excel/PPT。
- **不捆绑任何 AGPL 工具**：不内置 Ghostscript（压缩）、不内置 PyMuPDF / pdf2docx（PDF→Word）——许可红线，见选型依据。
- 不做旧版 .doc/.xls/.ppt 的内置降级（需加装包）。
- 不做联网（加装包为用户自行放置的本地文件）。

## 选型依据（含来源）
- 读取/渲染：**pdfjs-dist**（Apache-2.0，Mozilla）——在 Electron 界面进程内渲染，零原生依赖；npm 当前 6.3.x。
- 生成/编辑：**pdf-lib**（MIT）——图片嵌入、页面合并/拆分/提取。
- 后续增强（本期不做）：@cantoo/pdf-lib（MIT，活跃分支，AES-256 加密解密）或 qpdf（Apache-2.0）。
- Office→PDF 降级：**docx-preview**（Apache-2.0）+ **SheetJS CE**（Apache-2.0）+ Electron 内置 `printToPDF`（无额外依赖）。
- 高保真 / PDF→Word：**LibreOffice 便携版**（MPL-2.0）；CLI 参数与过滤器：LibreOffice 官方帮助（`--convert-to`、`--infilter`）；质量对比与 `writer_pdf_import` 关键细节：pdf4.dev《Open source PDF to Word converters: 5 tools tested (2026)》《Best PDF-to-Word converters 2026》。
- 规避 AGPL：Ghostscript（AGPL 或商业双许可，Artifex 官网）、PyMuPDF（AGPL-3.0，PyPI）——均不捆绑分发。

## 开放问题（实现前/中必须验证，验证结论回填本节）
1. **pdfjs worker 打包后路径**（asar 内）是否正常——开发第一步先做最小验证（spike），不通过不进入正式开发。
2. LibreOffice 便携包可精简到多小、启动与单文档转换耗时实测。
3. 加装包的分发形式（第二个压缩包 / 放置说明图示）——待用户确定。
4. 图片→PDF 对 webp 等格式的重编码路径（走 imageio 解码）——待验证。
5. 内置降级（docx-preview + printToPDF）的实际版式效果——需用真实文档实测。

## 依赖的其他模块
- 依赖 `imageio`（非 JPG/PNG 图片解码）、`settings`（输出目录、重名序号规则）、`ui`（样式令牌与通用组件）。
- 遵守工具箱约定：工具自包含，不 import 其他工具；可复用能力如需抽出，放 `src/shared/`。