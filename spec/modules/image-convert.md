# 模块：图片格式转换（image-convert）

> 更新记录：v0.1（2026-09-18）新增模块（用户需求：「图片格式转换」，尽量覆盖主流格式）。
> v2.10.0（2026-09-23）输入侧新增 HEIC / HEIF / HIF（手机拍照格式 → 通用格式；用户需求）。

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
  saschazar21 用官方 libheif 1.23 源码构建的 WASM 包，含 libde265 解码器）。选型实测依据（2026-09-23）：
  - Electron 44 的 Chromium `createImageBitmap`/`Image` 均不解码 HEIC（即使系统装有 HEIF 扩展，探针实测 FAIL）；
  - 包内 ffmpeg 6.1.1 不认 HEIF 容器（`Invalid data found`），FFmpeg master 的 libavformat 也仍无 HEIF demuxer（源码确认）；
  - Windows WIC（PowerShell 调用）能解但要逐张起进程、且依赖系统装了「HEIF 图像扩展 + HEVC 视频扩展」，不满足纯离线开箱即用；
  - libheif WASM 在主进程 Node 环境实测可用（1.4MP 约 80ms），对 irot 旋转文件的输出与 Windows WIC 逐像素一致（均值差 2.1，与未旋转基线相同），
    即竖拍照片方向正确。libheif-js 的 LGPL-3.0 以独立未修改 npm 包随包分发并附 LICENSE（与 GPL ffmpeg / LGPL 7zip 同等处理）。
- 已知限制：10-bit HDR HEIC（iPhone「高效」HDR 拍摄）按引擎能力输出 8 位（未逐项实测，标注为推断）。

## 已知限制
- SVG 转其它格式按内核渲染结果（不支持外部引用资源）。
- 大图转 BMP/TIFF 体积会显著变大（无压损格式的正常现象）。

## 验证结论（2026-09-18 实测回填；HEIC 部分v2.10.0 回填）
- `--media-test`：BMP 头 `BM`、96×64 = 24,698 B；ICO 类型 1、含 2 个尺寸项；两者均能被 ffmpeg 完整解码；TIFF（LZW）15,269 B、静态 GIF 4,514 B、AVIF 5,017 B 生成成功且可解码。
- `--media-ui-test`：PNG → PNG 转换成功落盘，界面状态「转换完成：成功 N 个」。
- HEIC（2026-09-23，v2.10.0）：`--media-test` 的 `heic` 段全绿——普通样本 1440×960、irot 旋转样本 960×1440，旋转映射抽样 300 点 maxDiff=0（逐像素精确）；坏字节返回「不是有效的 HEIC/HEIF 文件（或文件已损坏）」且引擎自愈（`recover:true`）；HEIC→PNG 经真实 IPC 链路落盘并被 ffmpeg 完整解码（`pngDecodable:true`）。全套 26 项自检（算法 247 项 + 冒烟 + 端到端 + 各工具自检与界面自动测试）随本版本全绿。