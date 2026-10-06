# 模块：视频格式转换（video-convert）

## 目标
批量把视频转成主流格式（MP4/WebM/MKV/MOV/AVI），选项傻瓜化（分辨率 + 质量两档），有进度可取消、可离线使用。

## 范围
工具目录 `src/tools/video-convert/`，id `video-convert`，左侧名「视频格式转换」，order 60，图标 🎬。

- 输入：MP4 / MOV / MKV / AVI / WebM / FLV / WMV / M4V / TS / 3GP / MPG / MPEG / VOB / RMVB 等 ffmpeg 可解格式（添加时读取时长与分辨率显示在列表）。
- 输出方向：
  | 输出 | 视频编码 | 音频编码 | 适用 |
  |---|---|---|---|
  | MP4（默认） | H.264 | AAC | 最通用：手机/电视/微信/剪辑软件 |
  | WebM | VP9 | Opus | 网页与体积优先 |
  | MKV | H.264 | AAC | 多轨容器/归档 |
  | MOV | H.264 | AAC | 苹果设备/剪辑 |
  | AVI | MPEG-4 | MP3 | 老设备、老软件 |
- 分辨率：保持原样（默认）/ 2160p / 1080p / 720p / 480p / 360p（只降不升，等比缩放，奇数边自动偶数化）。
- 质量：高质量（CRF 20 / 音频 192k）/ 标准（CRF 23 / 128k，默认）/ 小体积（CRF 28 / 96k）。
- 附加：可选「去掉声音」；批量队列串行处理；显示百分比 + 处理速度；可取消当前任务（结束 ffmpeg 进程树）。
- 保存：与原视频同目录（重名加序号），可用「设置 → 输出目录」覆盖。

## 非目标
- 不做剪辑（裁剪/拼接/加水印/字幕烧录）。
- 不做硬件加速编码：目标机器未必有 NVENC/QSV/AMF，统一 CPU 保证「任何机器都能跑」。
- 不做音频提取、不做 GIF（分别在「动图与视频互转」与后续需求中考虑）。

## 技术选型与依据
- 转码内核：**ffmpeg 6.1.1**（GPL v3，gyan.dev `release-essentials` 静态构建，单文件 82.8 MB），随包放 `addons/ffmpeg/ffmpeg.exe`；已在项目内实测：libx264 / libx265 / libvpx / libvpx-vp9 / libaom-av1 / AAC / MP3 / Opus 编码器与 mp4/webm/matroska/mov/avi 封装器齐备。
- 调用方式：主进程 `spawn`，参数含 `-progress pipe:1 -nostats`，解析 `out_time_ms` 显示进度；取消用 `taskkill /pid <pid> /T /F`（与 LibreOffice 同一套路，见 main.js）。
- 许可：GPL v3 二进制随个人工具分发，许可证与来源说明随包放 `addons/ffmpeg/LICENSE.txt` 与 `说明.txt`。

## 已知限制
- 转码是重编码，有画质损失（属正常）；相同编码的「无损直拷」不在本期。
- 速度取决于 CPU 与视频时长（1080p 时长 1 分钟约需 10~60 秒，视机器而定）；界面有进度与速度提示。
- 加装包缺失时（如开发态未放 addons），工具显示「未检测到 ffmpeg」并给出放置说明，不静默失败。
