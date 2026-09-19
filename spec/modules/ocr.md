# 模块：文字识别（ocr）

> 更新记录：v0.1（2026-09-19）新增模块。需求由用户 2026-09-19 提出（「扫描版 PDF 的问题你也解决一下，确实有这个需求」）。

## 目标
让扫描件「活」过来：给扫描版 PDF 叠一层**隐形文字层**做成可搜索 PDF（Ctrl+F 能搜、能选中复制、原貌不变），并支持导出纯文本 / Word；配套扫描件预处理与压缩瘦身。

## 范围
目录 `src/tools/ocr/`，id `ocr`，左侧名「文字识别」，group `doc`，order 24，图标 🔍。

- 输入：图片（PNG/JPG/WebP/BMP 等）+ **扫描版 PDF（逐页识别）**。
- 输出（可多选）：
  1. **可搜索 PDF**（隐形文字层，原页面不动，只叠加不可见文字）
  2. **纯文本 .txt**
  3. **Word .docx**（段落纯文本 + 分页，不做版式还原）
- **扫描件预处理**（提升识别率）：去灰底（Otsu/自适应阈值）、纠偏（投影方差搜索微角度）、锐化（USM）、黑白化。
- **扫描 PDF 压缩瘦身**：复用 `shared/pdfops.js`（档位 + 灰度开关）。
- 语言：单模型覆盖简体中文 / 英文 / 日文 / 繁体（PP-OCRv5 mobile），界面作为说明而非选项。
- 选中项可预览：页面缩略图 + **识别文字框叠加** + 可复制的识别文本。

## 关键技术决策
1. **引擎跑在 Electron 主进程**（`ppu-paddle-ocr` + `onnxruntime-node`，N-API 原生模块，ABI 稳定）。
   - 原因：主进程**没有渲染进程的 CSP 限制**，不必为 WASM 放宽 `script-src`（加 `wasm-unsafe-eval`）、不必加 `worker-src blob:` / `connect-src blob:`，也不用把 20MB 模型搬成 blob URL。**CSP 保持原样不动**。
   - 主进程通过 `ocr:recognize` / `ocr:status` / `ocr:cancel` / `ocr:font` 四个 IPC 提供服务（见 `main.js`）。
2. **隐形文字层用 `renderMode: TextRenderingMode.Invisible`（PDF 的 Tr=3）**：
   - 这是「真正隐形」——不依赖透明度，Ctrl+F、复制粘贴、屏幕阅读器都正常。
   - `@cantoo/pdf-lib` 的 `drawText` 直接支持该选项（比手动 pushOperators 干净）。
   - **必须配 `@cantoo/fontkit` 做子集化**（每个 PDF 只嵌入实际用到的字形）。实测：17.7MB 字体 + 一页 1791 字符 → **PDF 仅 9.2KB**。
3. **fontkit 在界面进程走 UMD**（与 pdf-edit 同一坑）：其 ESM 产物含裸模块名，无打包器时浏览器解析失败。
4. **坐标换算**（OCR 是像素坐标 y 向下，PDF 是点坐标 y 向上）：
   `ptsPerPx = 页高(pts) / 渲染高(px)`；`x = box.x × ptsPerPx`、`size = box.height × ptsPerPx`、`y = 页高 − box.y × ptsPerPx − size`。
   开了纠偏时，识别框先落回原图坐标（绕渲染图中心反旋）再换算。
5. **Word 导出零新增依赖**：手写最小 OOXML（`[Content_Types].xml` + `_rels/.rels` + `word/document.xml`）后用随包的 JSZip 打包。

## 加装包
`app/addons/ocr/`（不进 git，pack.js 步骤 5f）：
- `det.onnx`（4.5MB，PP-OCRv5_mobile_det）、`rec.onnx`（15.8MB，PP-OCRv5_mobile_rec）、`dict.txt`（72KB）
- `fonts/NotoSansSC-VF.ttf`（17MB，SIL OFL 1.1）——与 pdf-edit 共用一份，避免重复体积
- 运行时依赖（`onnxruntime-node` / `@napi-rs/canvas` / `opencv-js` 等约 115MB）随主包 node_modules 复制；**`onnxruntime-node` 只带 Windows x64**，其余平台二进制在打包时剔除（省约 220MB，见 pack.js 步骤 4c）

## 非目标
- 不做 OCR 结果的可视化编辑（改错字、拖框调位置）。
- 不做版面还原（多栏、表格结构）——输出按「行」组织，Word 里是纯段落。
- 不做手写体专项优化（PP-OCRv5 对手写有基本能力，但不保证）。

## 已知限制
- `/Rotate` 非 0 的旋转页**不叠加文字层**（坐标系会错），只在汇总里如实上报页号。
- 字体不覆盖的生僻字会丢，界面会提示「N 个字符未能嵌入」。
- 文本层的行序按「从上到下、行内从左到右」，多栏排版可能顺序不理想（PDF 文本层固有问题）。
- 中值去噪实测会把召回从 100% 拉到 61%（合成夹具），故**默认关闭**（能力保留）。
- 模型缺失时工具禁用并提示放置路径；字体缺失时「可搜索 PDF」不可用，但「纯文本」仍可用。

## 依赖
- `@cantoo/pdf-lib` + `@cantoo/fontkit`、`shared/pdfops.js`、`jszip`；主进程 OCR IPC。
- 不依赖任何其它工具。

## 验证结论（2026-09-19 实测回填）
- **引擎闸门**（`--ocr-poc`）：3/3 合成中文夹具召回 **100%**，单张 281~570ms，init 275ms，**网络请求 0 次**。
- **隐形文字层**：899B 底 PDF + 9 字隐形层 → 4029B，pdfjs 读回完全命中；真实 Electron 里 1000×320 图 → 可搜索 PDF 20.5KB，读回「番茄图片混淆工具箱离线文字识别测试」。
- **多页扫描件**：190.7KB → 200.8KB，两页均可搜索（`getTextContent()` 关键词命中 3/3）。
- **压缩**：4 页扫描式样本 195KB → 113KB，页数不变、可渲染。
- **纯逻辑单测**：坐标换算（含比例校正，固定输入→固定输出）、`linesToText` 排序补空格、预处理（Otsu/自适应阈值/去脏点/纠偏检出 −4°/框回映射）、`linesToDocx` 结构+内容，全部通过（18/18）。
- `--pdf-ocr-test`：`ok:true`（核心自检 + 界面走查全过）。

## 关于测试阈值的说明（重要）
合成夹具（canvas 画的图 + 噪声/灰底/倾斜）上，中文召回**不可能次次 100%**——个别字符在噪声或纠偏图上识别偏差是常态。因此自检的判据对齐项目闸门：
- 召回 **≥ 0.85** 为达标（项目闸门是 ≥0.80）；
- 预处理版要求「≥0.85 绝对下限」且「不低于未处理版 −0.05」（未处理版已满分时只卡绝对下限——满分之上没有提升空间，抖动正常）；
- 但**必须保留关键词命中断言**：如果产出的 PDF 完全搜不到文字或只有乱码，无论召回数字都判失败。