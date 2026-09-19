// ffmpeg 共用能力（跨工具复用，放 shared/）
// 使用方：视频格式转换（src/tools/video-convert）、动图与视频互转（src/tools/sticker）、
//         图片格式转换的 TIFF/GIF/AVIF 输出（src/tools/convert）。
// 说明：真正的进程调用在主进程（main.js 的 ffmpeg:* IPC）；本文件负责界面侧统一封装与
//       「编码参数怎么拼」这层可复用逻辑，保证各工具产出一致。目标与规则见 spec/modules/video-convert.md。

/** ffmpeg 加装包状态：{found, where:'addon'|'system'|null, version} */
export function ffmpegStatus() {
  return window.desktop.ffmpegStatus();
}

/** 读取媒体信息：{ok, durationSec, width, height, fps, hasAudio, videoCodec, format} */
export function probeMedia(filePath) {
  return window.desktop.ffmpegProbe(filePath);
}

/**
 * 文件 → 文件 转码（结果直接写到输出目录，重名自动加序号）
 * options: { inputPath, outputDir?, baseName?, ext, inputArgs?, args, durationMs?, jobId? }
 * 返回：{ok, path, size, ms} 或 {ok:false, message}
 */
export function convertMedia(options) {
  return window.desktop.ffmpegConvert(options);
}

/** 图片字节 → 字节（TIFF/GIF/AVIF 等内核编不了的格式走这里） */
export function transformImageBytes(bytes, ext, args) {
  return window.desktop.ffmpegTransform({ bytes, ext, args });
}

/** 取消某个正在跑的任务（jobId 用 convertMedia 里传入的同一个） */
export function cancelMediaJob(jobId) {
  return window.desktop.ffmpegCancel(jobId);
}

/** 订阅进度（返回取消订阅函数，工具 unmount 时务必调用） */
export function onMediaProgress(callback) {
  return window.desktop.ffmpegOnProgress(callback);
}

// —— 编码参数拼装（统一在这里，避免各工具各写一套导致产出不一致） ——

/** 质量档 → 视频/音频参数 */
export const QUALITY_PRESETS = {
  high: { crf: 20, audioBitrate: '192k', label: '高质量' },
  standard: { crf: 23, audioBitrate: '128k', label: '标准' },
  small: { crf: 28, audioBitrate: '96k', label: '小体积' }
};

/** 目标分辨率档位（高度；0 = 保持原样） */
export const RESOLUTION_PRESETS = [
  { value: 0, label: '保持原样' },
  { value: 2160, label: '2160p（4K）' },
  { value: 1080, label: '1080p（全高清）' },
  { value: 720, label: '720p（高清）' },
  { value: 480, label: '480p' },
  { value: 360, label: '360p（省流量）' }
];

/** 偶数化（yuv420p 要求宽高为偶数） */
export function evenSize(n) {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/**
 * 按「高度不超过 targetHeight」等比缩放；targetHeight 为 0/缺省时只做偶数化。
 * 返回 {w, h}；源尺寸未知时返回 null（调用方跳过缩放）。
 */
export function fitSize(srcW, srcH, targetHeight) {
  if (!srcW || !srcH) return null;
  let w = srcW;
  let h = srcH;
  if (targetHeight && targetHeight < srcH) {
    h = targetHeight;
    w = Math.round(srcW * (targetHeight / srcH));
  }
  return { w: evenSize(w), h: evenSize(h) };
}

/** 按「宽度不超过 targetWidth」等比缩放；targetWidth 为 0/缺省时只做偶数化 */
export function fitSizeByWidth(srcW, srcH, targetWidth) {
  if (!srcW || !srcH) return null;
  let w = srcW;
  let h = srcH;
  if (targetWidth && targetWidth < srcW) {
    w = targetWidth;
    h = Math.round(srcH * (targetWidth / srcW));
  }
  return { w: evenSize(w), h: evenSize(h) };
}

/** 分辨率档位 → 缩放滤镜参数（保持宽高比，只降不升） */
export function scaleToHeightArgs(srcW, srcH, targetHeight) {
  const size = fitSize(srcW, srcH, targetHeight);
  if (!size) return [];
  return ['-vf', `scale=${size.w}:${size.h}`];
}

/**
 * 视频输出编码参数
 * @param {'mp4'|'webm'|'mkv'|'mov'|'avi'} target
 * @param {'high'|'standard'|'small'} quality
 * @param {{mute?: boolean}} [options]
 */
export function videoEncodeArgs(target, quality = 'standard', options = {}) {
  const q = QUALITY_PRESETS[quality] || QUALITY_PRESETS.standard;
  const mute = !!options.mute;
  switch (target) {
    case 'webm':
      return [
        '-c:v', 'libvpx-vp9', '-crf', String(q.crf), '-b:v', '0', '-row-mt', '1',
        ...(mute ? ['-an'] : ['-c:a', 'libopus', '-b:a', q.audioBitrate])
      ];
    case 'avi': {
      const qv = q.crf <= 20 ? 3 : q.crf <= 23 ? 5 : 8; // mpeg4 用 -q:v（1 最好 / 31 最差）
      return [
        '-c:v', 'mpeg4', '-q:v', String(qv),
        ...(mute ? ['-an'] : ['-c:a', 'libmp3lame', '-b:a', q.audioBitrate])
      ];
    }
    case 'mkv':
      return [
        '-c:v', 'libx264', '-crf', String(q.crf), '-preset', 'medium', '-pix_fmt', 'yuv420p',
        ...(mute ? ['-an'] : ['-c:a', 'aac', '-b:a', q.audioBitrate])
      ];
    case 'mov':
    case 'mp4':
    default:
      return [
        '-c:v', 'libx264', '-crf', String(q.crf), '-preset', 'medium', '-pix_fmt', 'yuv420p',
        ...(mute ? ['-an'] : ['-c:a', 'aac', '-b:a', q.audioBitrate]),
        '-movflags', '+faststart' // 便于网页/微信边下边播
      ];
  }
}

/** 输出容器信息：扩展名 + 文件选择框用 */
export const VIDEO_TARGETS = [
  { value: 'mp4', ext: '.mp4', label: 'MP4（H.264 + AAC，最通用）' },
  { value: 'webm', ext: '.webm', label: 'WebM（VP9 + Opus，体积小）' },
  { value: 'mkv', ext: '.mkv', label: 'MKV（H.264 + AAC，归档）' },
  { value: 'mov', ext: '.mov', label: 'MOV（H.264 + AAC，苹果/剪辑）' },
  { value: 'avi', ext: '.avi', label: 'AVI（MPEG-4 + MP3，老设备）' }
];

/**
 * 视频 → GIF 的高质量参数（两遍调色板；业界常用写法）
 * @param {{fps?:number, width?:number, colors?:number, loop?:number, srcW?:number, srcH?:number}} o
 */
export function videoToGifArgs(o = {}) {
  const fps = o.fps || 15;
  const colors = o.colors || 256;
  const loop = typeof o.loop === 'number' ? o.loop : 0;
  const size = fitSizeByWidth(o.srcW, o.srcH, o.width || 0);
  const scale = size ? `scale=${size.w}:${size.h}:flags=lanczos` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const filter = `${scale},fps=${fps},split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
  return ['-filter_complex', filter, '-loop', String(loop)];
}

/** 视频 → WebP 动图 参数 */
export function videoToWebpArgs(o = {}) {
  const fps = o.fps || 15;
  const loop = typeof o.loop === 'number' ? o.loop : 0;
  const size = fitSizeByWidth(o.srcW, o.srcH, o.width || 0);
  const vf = size ? `scale=${size.w}:${size.h}:flags=lanczos,fps=${fps}` : `fps=${fps}`;
  return ['-c:v', 'libwebp_anim', '-loop', String(loop), '-q:v', String(o.quality || 75), '-compression_level', '6', '-vf', vf];
}

/** 视频 → APNG 参数 */
export function videoToApngArgs(o = {}) {
  const fps = o.fps || 15;
  const size = fitSizeByWidth(o.srcW, o.srcH, o.width || 0);
  const vf = size ? `scale=${size.w}:${size.h}:flags=lanczos,fps=${fps}` : `fps=${fps}`;
  // 注意：APNG 按惯例使用 .png 后缀，必须显式指定 `-f apng`，
  //      否则 ffmpeg 会按扩展名推断成单帧 image2 输出并失败（实测退出码 -22）。
  return ['-c:v', 'apng', '-plays', String(o.loop === 1 ? 1 : 0), '-f', 'apng', '-vf', vf];
}

/** 动图/视频 → 通用视频（GIF 等无音轨输入用；尺寸偶数化 + yuv420p） */
export function animToVideoArgs(o = {}) {
  const size = fitSize(o.srcW, o.srcH, o.targetHeight || 0);
  const vf = size ? `scale=${size.w}:${size.h},format=yuv420p` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p';
  return ['-vf', vf, ...(o.fps ? ['-r', String(o.fps)] : [])];
}

// —— 音频（音频格式转换工具用；目标与实测依据见 spec/modules/audio-convert.md） ——

/** 音频音质档 → 各编码器参数（无损格式忽略本档位） */
export const AUDIO_QUALITY_PRESETS = {
  high: { label: '高品质', mp3: '320k', aac: '256k', opus: '192k', vorbis: '6', wma: '192k', ac3: '384k', mp2: '320k', speex: '8' },
  standard: { label: '标准', mp3: '192k', aac: '192k', opus: '96k', vorbis: '4', wma: '128k', ac3: '192k', mp2: '160k', speex: '5' },
  small: { label: '省空间', mp3: '128k', aac: '128k', opus: '64k', vorbis: '2', wma: '64k', ac3: '128k', mp2: '128k', speex: '3' }
};

/**
 * 音频输出格式清单（实测全部可用，见 spec/modules/audio-convert.md）
 * group: common 常用 / more 更多；lossless: 无损（无需选音质）
 */
export const AUDIO_TARGETS = [
  { value: 'mp3', ext: '.mp3', group: 'common', label: 'MP3（最通用，推荐）' },
  { value: 'm4a', ext: '.m4a', group: 'common', label: 'M4A（AAC，苹果/手机通用）' },
  { value: 'wav', ext: '.wav', group: 'common', lossless: true, label: 'WAV（无损，体积大）' },
  { value: 'flac', ext: '.flac', group: 'common', lossless: true, label: 'FLAC（无损，体积小）' },
  { value: 'ogg', ext: '.ogg', group: 'common', label: 'OGG（Vorbis，开源格式）' },
  { value: 'opus', ext: '.opus', group: 'common', label: 'Opus（体积最小）' },
  { value: 'wma', ext: '.wma', group: 'more', label: 'WMA（Windows Media）' },
  { value: 'amr', ext: '.amr', group: 'more', label: 'AMR（手机录音，语音专用）' },
  { value: 'aac', ext: '.aac', group: 'more', label: 'AAC 裸流（.aac）' },
  { value: 'm4a-alac', ext: '.m4a', group: 'more', lossless: true, label: 'M4A 无损（ALAC，苹果无损）' },
  { value: 'aiff', ext: '.aiff', group: 'more', lossless: true, label: 'AIFF（苹果无损）' },
  { value: 'caf', ext: '.caf', group: 'more', lossless: true, label: 'CAF（苹果容器+无损）' },
  { value: 'wv', ext: '.wv', group: 'more', lossless: true, label: 'WavPack（无损 .wv）' },
  { value: 'tta', ext: '.tta', group: 'more', lossless: true, label: 'TTA（无损 .tta）' },
  { value: 'ac3', ext: '.ac3', group: 'more', label: 'AC3（影视格式）' },
  { value: 'eac3', ext: '.eac3', group: 'more', label: 'EAC3（影视格式）' },
  { value: 'mp2', ext: '.mp2', group: 'more', label: 'MP2（老式广播）' },
  { value: 'spx', ext: '.spx', group: 'more', label: 'Speex（语音 .spx）' },
  { value: 'au', ext: '.au', group: 'more', lossless: true, label: 'AU（Sun/Unix 老格式）' },
  { value: 'w64', ext: '.w64', group: 'more', lossless: true, label: 'W64（索尼 Wave64）' },
  { value: 'ra', ext: '.ra', group: 'more', label: 'RealAudio（老式 .ra）' }
];

/**
 * 音频输出编码参数
 * @param {string} target AUDIO_TARGETS 的 value
 * @param {'high'|'standard'|'small'} quality 音质档（无损格式忽略）
 */
export function audioEncodeArgs(target, quality = 'standard') {
  const q = AUDIO_QUALITY_PRESETS[quality] || AUDIO_QUALITY_PRESETS.standard;
  switch (target) {
    case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', q.mp3];
    case 'm4a': return ['-c:a', 'aac', '-b:a', q.aac];
    case 'wav': return ['-c:a', 'pcm_s16le'];
    case 'flac': return ['-c:a', 'flac', '-compression_level', '5'];
    case 'ogg': return ['-c:a', 'libvorbis', '-q:a', q.vorbis];
    case 'opus': return ['-c:a', 'libopus', '-b:a', q.opus];
    case 'wma': return ['-c:a', 'wmav2', '-b:a', q.wma];
    // AMR 是窄带语音编码：必须 8kHz 单声道、码率固定（12.2k 为其最高档）
    case 'amr': return ['-c:a', 'libopencore_amrnb', '-ar', '8000', '-ac', '1', '-b:a', '12.2k'];
    case 'aac': return ['-c:a', 'aac', '-b:a', q.aac];
    case 'm4a-alac': return ['-c:a', 'alac'];
    case 'aiff': return ['-c:a', 'pcm_s16be'];
    case 'caf': return ['-c:a', 'alac'];
    case 'wv': return ['-c:a', 'wavpack'];
    case 'tta': return ['-c:a', 'tta'];
    case 'ac3': return ['-c:a', 'ac3', '-b:a', q.ac3];
    case 'eac3': return ['-c:a', 'eac3', '-b:a', q.ac3];
    // MP2 在低采样率（≤24kHz）下只允许 ≤160k 码率，统一重采样 44.1kHz 规避非法参数
    case 'mp2': return ['-c:a', 'mp2', '-ar', '44100', '-b:a', q.mp2];
    case 'spx': return ['-c:a', 'libspeex', '-q:a', q.speex];
    case 'au': return ['-c:a', 'pcm_s16be'];
    case 'w64': return ['-c:a', 'pcm_s16le'];
    case 'ra': return ['-c:a', 'real_144'];
    default: return ['-c:a', 'libmp3lame', '-b:a', q.mp3];
  }
}