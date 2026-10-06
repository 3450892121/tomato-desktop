# 模块：图片格式转换（image-convert）

## 目标
批量把图片在主流格式之间互转，产物要能被系统与其他软件正常打开。

## 范围
工具目录 `src/tools/convert/`，id `img-convert`，左侧名「图片格式转换」，order 40，图标 🔄。

### 输入
- 内核解码：PNG / JPG / WebP / GIF（取首帧）/ BMP / ICO / AVIF / SVG（自带尺寸时）。
- HEIC / HEIF / HIF（iPhone 等手机默认拍照格式，含索尼/佳能等相机的 .hif）：
  引擎 = `heic-decode`（ISC）+ `libheif-js`（LGPL-3.0，官方 libheif 1.23 的 WASM 构建），
  跑在**主进程 worker 线程**（WASM 解码是同步计算，放主线程会卡住整窗 IPC），
  渲染进程经 IPC `heic:decode` 拿 RGBA。不依赖系统 HEIF 编解码器扩展，纯离线开箱即用。
- 老图片格式（v2.13.0）：TIFF（.tif/.tiff）/ PCX / TGA / PSD / DDS / JPEG2000（.jp2/.j2k）。
  Chromium 内核解不了，经 `ffmpeg:transform-file` 按路径交给随包 ffmpeg 出首帧 PNG
  （`-frames:v 1`），再进 canvas——大 PSD 不整份读进界面进程；需 ffmpeg 加装包，
  未装时对该类文件给出明确提示（其余格式不受影响）。多页 TIFF/分层 PSD 取首帧/合并结果。

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
- 不做 HEIC 输出（用户诉求是「手机格式转通用格式」，YAGNI）。
- 不做动图互转（GIF/WebP 动图 ↔ 视频见「动图与视频互转」模块）。
- 不做 PDF ↔ 图片（见「PDF 转格式」模块）。

## 技术选型与依据
- 内核编解码：`shared/imageio.js`（PNG/JPG/WebP）。
- BMP 结构：`BITMAPV4HEADER` + `BI_BITFIELDS`（含 alpha 掩码），来源为 Microsoft Windows 官方文档（BITMAPV4HEADER / BMP 格式）；Windows 图片查看器与常见编辑器均可打开。
- ICO 结构：ICONDIR + 各尺寸 PNG 数据（Vista 起支持 PNG 压缩的图标项），来源为 ICO 文件格式公开文档。
- TIFF / GIF / AVIF：包内 ffmpeg 6.1.1（命令见 `addons/ffmpeg/说明.txt`）。
- HEIC/HEIF/HIF 解码：`heic-decode@2.1.0`（ISC 壳）+ `libheif-js@1.23.2`（LGPL-3.0，
  saschazar21 用官方 libheif 1.23 源码构建的 WASM 包，含 libde265 解码器）。选型实测依据：
  - Electron 44 的 Chromium `createImageBitmap`/`Image` 均不解码 HEIC（即使系统装有 HEIF 扩展，探针实测 FAIL）；
  - 包内 ffmpeg 6.1.1 不认 HEIF 容器（`Invalid data found`），FFmpeg master 的 libavformat 也仍无 HEIF demuxer（源码确认）；
  - Windows WIC（PowerShell 调用）能解但要逐张起进程、且依赖系统装了「HEIF 图像扩展 + HEVC 视频扩展」，不满足纯离线开箱即用；
  - libheif WASM 在主进程 Node 环境实测可用（1.4MP 约 80ms），对 irot 旋转文件的输出与 Windows WIC 逐像素一致（均值差 2.1，与未旋转基线相同），
    即竖拍照片方向正确。libheif-js 的 LGPL-3.0 以独立未修改 npm 包随包分发并附 LICENSE（与 GPL ffmpeg / LGPL 7zip 同等处理）。
- 已知限制：10-bit HDR HEIC（iPhone「高效」HDR 拍摄）按引擎能力输出 8 位（未逐项实测，标注为推断）。

## 已知限制
- SVG 转其它格式按内核渲染结果（不支持外部引用资源）。
- 大图转 BMP/TIFF 体积会显著变大（无压损格式的正常现象）。
