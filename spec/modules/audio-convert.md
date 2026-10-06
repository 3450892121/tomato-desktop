# 模块：音频格式转换（audio-convert）

## 目标
批量把音频转成主流格式（并覆盖实测可用的少见格式），也支持把视频里的声音提取成音频；选项傻瓜化（输出格式 + 音质三档），有进度可取消、纯离线。

## 范围
工具目录 `src/tools/audio-convert/`，id `audio-convert`，左侧名「音频格式转换」，新分组「音频」（audio，排在「视频」之后），order 70，图标 🎵。

- 输入：全部 ffmpeg 可解音频格式（mp3 / wav / flac / m4a / aac / ogg / opus / wma / amr / aiff / ape / dsf / mpc / tak / wv / tta / ac3 / eac3 / mp2 / spx / caf / au / w64 / ra / oma 等）；
  另支持视频文件（mp4 / mov / mkv / avi / webm / flv / wmv / m4v / ts / 3gp / mpg / mpeg / vob / rmvb / ogv）——自动提取音轨（`-vn`）。
- 输出 21 种，下拉框按「常用 / 更多」分组：
  | 分组 | 格式 |
  |---|---|
  | 常用 | MP3（推荐）｜M4A(AAC)｜WAV｜FLAC｜OGG｜Opus |
  | 更多 | WMA｜AMR（手机录音）｜AAC 裸流｜M4A(ALAC)｜AIFF｜CAF｜WavPack(.wv)｜TTA｜AC3｜EAC3｜MP2｜Speex｜AU｜W64｜RealAudio |
- 音质三档：高品质 / 标准（默认）/ 省空间；无损格式（WAV/FLAC/ALAC/AIFF/CAF/WavPack/TTA/AU/W64）忽略音质档（界面禁用并提示「无损格式无需选择音质」）。
- 附加：默认保留标签（`-map_metadata 0` + ID3v2.3）；AMR 自动 8kHz 单声道（窄带语音）；MP2 自动重采样 44.1kHz（规避非法码率，见下）；视频输入自动去视频轨。
- 保存：与原文件同目录（重名加序号），可用「设置 → 输出目录」覆盖。
- 文件列表信息：时长 ｜ 格式 ｜ 采样率 ｜ 声道 ｜ 大小。

## 非目标
- 不做音频剪辑（裁剪/合并/淡入淡出）、音量均衡、变声、降噪。
- 不暴露采样率/声道选项（按格式自动适配，音质优先保持原样）。
- 不做 APE / DSD / Musepack / TAK 的输出编码（ffmpeg 无编码器，仅能作为输入读取后转出）。
- 不做 MIDI 转换、OMA 容器输出（调查确认实现不了）。

## 技术选型与依据
- 内核：沿用现有 **ffmpeg 6.1.1 加装包**（GPL v3，gyan.dev release-essentials），无需新增任何依赖；**21 种输出格式全部实测转码 + 回读校验通过**。
- 编码器映射：mp3→libmp3lame；m4a/aac→aac 原生；m4a(ALAC)/caf→alac；flac→flac；ogg→libvorbis；opus→libopus；wma→wmav2；amr→libopencore_amrnb；ac3/eac3/mp2→原生；spx→libspeex；wv→wavpack；tta→tta；wav/w64→pcm_s16le；aiff/au→pcm_s16be；ra→real_144。
- 输入侧额外可读（无编码器，仅解码）：APE（Monkey's Audio）、DSD（.dsf）、Musepack（.mpc）、TAK——「非主流但可实现」的部分。
- 参数约束：22.05kHz 低采样率下 MP2 的 192k 非法（MPEG-2 LSF 码率上限 160k，错误 `bitrate 192 is not allowed in mp2`）→ MP2 输出固定 `-ar 44100`；AMR-NB 必须 8kHz 单声道；Opus 由 ffmpeg 自动重采样 48kHz。
- 标签保留实测：`-map_metadata 0` 经 MP3 往返后 title/artist 保留成功。
- 视频提取音频实测：MP4 → MP3 / M4A 通过。
- 调查排除项：OMA 容器（写头失败 `Could not write header`）、Ogg-FLAC（需显式 `-f ogg`，放弃）、MIDI（ffmpeg 不支持）。

## 已知限制
- 加装包缺失时显示「未检测到 ffmpeg」与放置说明，不静默失败。
- RealAudio / MP2 / Speex / AU / W64 等为少见老格式，选项文案标注用途，不推荐日常使用。
- RealAudio(.ra) 产物为老式 RealMedia 容器、不写时长索引（实测 `Duration: 00:00:00.00`），播放器可正常播放但部分工具不显示时长；属该格式固有特性。
- 有损格式互转有音质损失（属正常）；无损列表里不提供「无损直拷」优化（本期不做流复制）。
