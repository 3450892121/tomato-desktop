# 模块：图片格式转换（image-convert）

> 更新记录：v0.1（2026-09-18）新增模块（用户需求：「图片格式转换」，尽量覆盖主流格式）。

## 目标
批量把图片在主流格式之间互转，产物要能被系统与其他软件正常打开。

## 范围
工具目录 `src/tools/convert/`，id `img-convert`，左侧名「图片格式转换」，order 40，图标 🔄。

### 输入（内核解码）
PNG / JPG / WebP / GIF（取首帧）/ BMP / ICO / AVIF / SVG（自带尺寸时）。

### 输出
| 格式 | 实现 | 说明 |
|---|---|---|
| PNG | 内核编码 | 无损，保留透明 |
| JPG | 内核编码 | 画质可调；透明像素按所选底色（白/黑）填充 |
| WebP | 内核编码 | 画质可调，保留透明，体积通常最小 |
| BMP | 自研编码器 | 32 位 BGRA（BITMAPV4HEADER + BI_BITFIELDS），保留透明 |
| ICO | 自研封装 | 内含 16/32/48/64/128/256 多尺寸 PNG，用作程序图标 |
| TIFF | ffmpeg | LZW 压缩（体积友好） |
| GIF（静态） | ffmpeg | 单帧 GIF；动图请用「动图与视频互转」 |
| AVIF | ffmpeg | libaom AV1 静图，画质可调 |

- 选项：输出格式、画质（JPG/WebP/AVIF）、尺寸（不变 / 最长边 N）、透明底色（白/黑，用于 JPG）。
- 批量：逐张转换，显示 原格式 → 新格式 与新文件大小；产物与原文件同目录（重名加序号）。

## 非目标
- 不支持 HEIC / HEIF 输入：Chromium 内核不解码，ffmpeg 6.1 静态构建也未带 libheif（界面明确提示「暂不支持」而不是失败得莫名其妙）。
- 不做动图互转（GIF/WebP 动图 ↔ 视频见「动图与视频互转」模块）。
- 不做 PDF ↔ 图片（见「PDF 转格式」模块）。

## 技术选型与依据
- 内核编解码：`shared/imageio.js`（PNG/JPG/WebP）。
- BMP 结构：`BITMAPV4HEADER` + `BI_BITFIELDS`（含 alpha 掩码），来源为 Microsoft Windows 官方文档（BITMAPV4HEADER / BMP 格式）；Windows 图片查看器与常见编辑器均可打开。
- ICO 结构：ICONDIR + 各尺寸 PNG 数据（Vista 起支持 PNG 压缩的图标项），来源为 ICO 文件格式公开文档。
- TIFF / GIF / AVIF：包内 ffmpeg 6.1.1（命令见 `addons/ffmpeg/说明.txt`）。

## 已知限制
- SVG 转其它格式按内核渲染结果（不支持外部引用资源）。
- 大图转 BMP/TIFF 体积会显著变大（无压损格式的正常现象）。

## 验证结论（2026-09-18 实测回填）
- `--media-test`：BMP 头 `BM`、96×64 = 24,698 B；ICO 类型 1、含 2 个尺寸项；两者均能被 ffmpeg 完整解码；TIFF（LZW）15,269 B、静态 GIF 4,514 B、AVIF 5,017 B 生成成功且可解码。
- `--media-ui-test`：PNG → PNG 转换成功落盘，界面状态「转换完成：成功 N 个」。
- HEIC 提示逻辑已在界面文案中落实（内核与 ffmpeg 静态包均无 HEIC 解码，实测确认构建无 libheif）。