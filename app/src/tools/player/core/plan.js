// 工具：视频播放器 —— 播放计划与文案（纯逻辑，可单测；界面只负责照做）
// 职责：判断「这个视频能不能直接播」，不能就直接给出「怎么准备一份可播放副本」的 ffmpeg 参数。
// 依据：Electron 内核（Chromium）实际支持的容器/编码 + ffmpeg 探测出的编码名（见 shared/ffmpeg.js 的 probeMedia）。
//      目标、取舍与实测回填见 spec/modules/player.md。

/**
 * 播放方式档位，从轻到重排列：播放失败时按这个顺序往上升级（见 nextMode）。
 * - direct：原文件直接播（内核原生支持，零等待、零磁盘占用）
 * - remux：无损换封装（画面与声音都直拷，只换 MP4 外壳；MKV/FLV 这类容器用）
 * - remux-audio：画面直拷、音轨转 AAC（画面原生但音轨不能进 MP4，如 AC3/WMA）
 * - transcode：重编码（画面编码内核解不了，如 MPEG-4 ASP / WMV / RMVB）
 */
export const PLAYBACK_MODES = ['direct', 'remux', 'remux-audio', 'transcode'];

/**
 * Chromium 能直接解复用的容器。
 * mkv 故意不列入：Chromium 只把 WebM 当标准容器，mkv 是否可播随版本而异，
 * 统一走「无损换封装」——对用户是秒级的事，却能把「有时能播有时不能」变成稳定行为。
 */
export const NATIVE_CONTAINERS = ['mp4', 'm4v', 'mov', 'webm', 'ogv'];

/** Chromium 能解码的视频编码（hevc 取决于系统解码器：先试直放，失败会自动升档重编码） */
export const NATIVE_VIDEO_CODECS = ['h264', 'avc1', 'vp8', 'vp9', 'av1', 'hevc', 'h265'];

/** Chromium 能解码的音频编码 */
export const NATIVE_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];

/** MP4 容器能无损容纳的音频编码（换封装时音轨可以直拷，不必重编码） */
export const MP4_SAFE_AUDIO = ['aac', 'mp3'];

/** 播放器能打开的视频扩展名（与主进程 VIDEO_EXTS 对齐；带不带点都能传） */
export const PLAYER_EXTS = [
  'mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'm4v', 'ts', '3gp', 'mpg', 'mpeg', 'vob', 'rmvb', 'ogv'
];

/** 扩展名归一化：'.MP4'/ 'MP4' → 'mp4' */
export function normalizeExt(ext) {
  return String(ext || '').toLowerCase().replace(/^\./, '');
}

/** 编码名归一化：ffmpeg 会给出 avc1 / h265 这类别名，统一成常用叫法 */
export function normalizeCodec(codec) {
  const c = String(codec || '').toLowerCase().trim();
  const alias = { avc1: 'h264', h265: 'hevc', mp4a: 'aac', 'mpeg-4': 'mpeg4' };
  return alias[c] || c;
}

/** 编码名 → 界面上给人看的写法（h264 → H.264；认不出来的原样大写，绝不吞掉信息） */
const CODEC_LABELS = {
  h264: 'H.264', hevc: 'H.265/HEVC', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', mpeg1video: 'MPEG-1',
  msmpeg4v2: 'MS-MPEG4 v2', msmpeg4v3: 'MS-MPEG4 v3', wmv1: 'WMV1', wmv2: 'WMV2', wmv3: 'WMV3',
  vc1: 'VC-1', flv1: 'Sorenson H.263', h263: 'H.263', rv30: 'RealVideo 3', rv40: 'RealVideo 4',
  vp8: 'VP8', vp9: 'VP9', av1: 'AV1', theora: 'Theora', mjpeg: 'MJPEG',
  aac: 'AAC', mp3: 'MP3', mp2: 'MP2', ac3: 'AC3', eac3: 'EAC3', opus: 'Opus', vorbis: 'Vorbis',
  flac: 'FLAC', wmav1: 'WMA v1', wmav2: 'WMA v2', dts: 'DTS', truehd: 'TrueHD',
  pcm_s16le: 'PCM', pcm_s16be: 'PCM', pcm_u8: 'PCM', amr_nb: 'AMR', cook: 'RealAudio'
};

/** 编码名 → 人看的写法（空值返回空串，调用方据此省略这一段文案） */
export function displayCodec(codec) {
  const c = normalizeCodec(codec);
  if (!c) return '';
  return CODEC_LABELS[c] || c.toUpperCase();
}

/**
 * 生成播放计划。
 * @param {{ext?: string, probe?: {videoCodec?: string, audioCodec?: string, hasAudio?: boolean}|null}} input
 * @returns {{mode: 'direct'|'remux'|'remux-audio'|'transcode', reason: string, needsFfmpeg: boolean}}
 */
export function planPlayback({ ext, probe } = {}) {
  const e = normalizeExt(ext);
  const v = normalizeCodec(probe && probe.videoCodec);
  const a = normalizeCodec(probe && probe.audioCodec);
  const hasAudio = !!(probe && probe.hasAudio);

  const containerOk = NATIVE_CONTAINERS.includes(e);
  // 探测失败时（没有 ffmpeg / 探测不出）不武断：扩展名原生就先直接试，播不了再升档
  const videoOk = v ? NATIVE_VIDEO_CODECS.includes(v) : containerOk;
  const audioOk = !hasAudio || (a ? NATIVE_AUDIO_CODECS.includes(a) : true);
  const audioInMp4 = !hasAudio || MP4_SAFE_AUDIO.includes(a);

  if (containerOk && videoOk && audioOk) {
    return { mode: 'direct', reason: '直接播放（这个格式内核原生支持）', needsFfmpeg: false };
  }
  if (videoOk && audioInMp4) {
    return {
      mode: 'remux',
      reason: `把 ${e.toUpperCase()} 无损换封装成 MP4 后播放（画面与声音都不重编码，秒级完成）`,
      needsFfmpeg: true
    };
  }
  if (videoOk) {
    return {
      mode: 'remux-audio',
      reason: `画面直接复制、音轨（${displayCodec(a)}）转成 AAC 后播放`,
      needsFfmpeg: true
    };
  }
  return {
    mode: 'transcode',
    reason: `画面编码（${displayCodec(v) || '未知'}）内核不支持，重编码成 H.264 后播放`,
    needsFfmpeg: true
  };
}

/** 播放失败时的升档路径；已到最重档返回 null（说明再折腾也播不了） */
export function nextMode(mode) {
  const i = PLAYBACK_MODES.indexOf(mode);
  if (i < 0) return null;
  return PLAYBACK_MODES[i + 1] || null;
}

/**
 * 准备副本的 ffmpeg 参数（不含输入/输出文件名，主进程会拼）。
 * 只取第一条视频 + 第一条音轨：多音轨/字幕/数据流塞进 MP4 会让封装直接失败。
 * @param {'remux'|'remux-audio'|'transcode'} mode
 * @param {{audioCodec?: string}} [probe]
 * @returns {string[]}
 */
export function buildPrepareArgs(mode, probe = {}) {
  const maps = ['-map', '0:v:0?', '-map', '0:a:0?'];
  const a = normalizeCodec(probe.audioCodec);
  switch (mode) {
    case 'remux': {
      const args = [...maps, '-c:v', 'copy', '-c:a', 'copy'];
      // TS 里的 AAC 是 ADTS 封装，进 MP4 必须过一遍 bitstream filter（否则 moov 里写不出正确采样信息）
      if (a === 'aac') args.push('-bsf:a', 'aac_adtstoasc');
      return [...args, '-movflags', '+faststart'];
    }
    case 'remux-audio':
      return [...maps, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
    case 'transcode':
    default:
      // 与「视频格式转换」的高质量档一致（libx264 CRF 20 + AAC 192k + faststart），避免各工具产出不一致
      return [...maps, '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
  }
}

/** 播放方式 → 界面上一句话（准备完成后显示，让用户知道发生了什么） */
export function describeMode(mode, probe = {}) {
  const v = displayCodec(probe.videoCodec);
  const a = displayCodec(probe.audioCodec);
  switch (mode) {
    case 'direct':
      return '直接播放（原文件，未做任何改动）';
    case 'remux':
      return '无损换封装为 MP4 后播放（画面与声音未重编码，原文件未改动）';
    case 'remux-audio':
      return `画面直拷、音轨 ${a || '原音轨'} → AAC 后播放（原文件未改动）`;
    case 'transcode':
      return `已重编码为 H.264${v ? `（原画面编码 ${v} 内核不支持）` : ''}，原文件未改动`;
    default:
      return '播放中';
  }
}

/** 本地文件 → 媒体协议 URL（协议由主进程注册，支持 Range 分块读取） */
export function mediaUrl(filePath) {
  return `tomato-media://local/${encodeURIComponent(String(filePath || ''))}`;
}

/** 秒 → 00:12 / 1:02:03（时长未知或非法时显示 00:00） */
export function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/** 字节 → 可读体积（元信息里显示副本大小用） */
export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 探测结果 → 一行元信息：1920×1080 ｜ 03:21 ｜ H.264 / AAC */
export function describeProbe(probe, ext) {
  if (!probe) return `${(normalizeExt(ext) || '').toUpperCase()} 视频`;
  const parts = [];
  if (probe.width && probe.height) parts.push(`${probe.width}×${probe.height}`);
  if (probe.durationSec > 0) parts.push(formatTime(probe.durationSec));
  const codecs = [displayCodec(probe.videoCodec), probe.hasAudio ? displayCodec(probe.audioCodec) : '']
    .filter(Boolean)
    .join(' / ');
  if (codecs) parts.push(codecs);
  if (!probe.hasAudio) parts.push('无音轨');
  return parts.join(' ｜ ');
}