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
  return ['-c:v', 'apng', '-plays', String(o.loop === 1 ? 1 : 0), '-vf', vf];
}

/** 动图/视频 → 通用视频（GIF 等无音轨输入用；尺寸偶数化 + yuv420p） */
export function animToVideoArgs(o = {}) {
  const size = fitSize(o.srcW, o.srcH, o.targetHeight || 0);
  const vf = size ? `scale=${size.w}:${size.h},format=yuv420p` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p';
  return ['-vf', vf, ...(o.fps ? ['-r', String(o.fps)] : [])];
}