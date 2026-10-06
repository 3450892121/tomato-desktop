// 工具：音频格式转换 —— 业务逻辑（与界面解耦）
// 职责：把「界面选好的参数」翻译成 ffmpeg 参数与显示文案。
// 编码参数一律复用 shared/ffmpeg.js 的现成函数（audioEncodeArgs），本文件不重复实现，保证各工具产出一致。
// 目标与实测依据见 spec/modules/audio-convert.md。

import { AUDIO_TARGETS, audioEncodeArgs } from '../../../shared/ffmpeg.js';

/** ffmpeg 可解的主流音频扩展名（与主进程文件对话框的筛选保持一致） */
export const AUDIO_EXTS = [
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wma', '.amr',
  '.aiff', '.aif', '.ape', '.dsf', '.mpc', '.tak', '.wv', '.tta', '.ac3', '.eac3',
  '.mp2', '.spx', '.caf', '.au', '.w64', '.ra', '.rm', '.oma',
  // v2.13.0 起补充的老格式（demuxer/decoder 均已用随包 ffmpeg 验证在位）：
  // shn（Shorten）、voc（创新声卡老格式）、mka（Matroska 纯音频）
  '.shn', '.voc', '.mka'
];

/** 也可以作为输入的视频扩展名：自动提取音轨（-vn） */
export const VIDEO_INPUT_EXTS = [
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv', '.m4v',
  '.ts', '.3gp', '.mpg', '.mpeg', '.vob', '.rmvb', '.ogv',
  // v2.13.0 起补充的老格式/常见封装（demuxer 均已验证在位）：
  // asf（wmv 同容器）、3g2/f4v（mp4 同容器）、mts/m2ts（AVCHD/蓝光 MPEG-TS）
  '.asf', '.3g2', '.f4v', '.mts', '.m2ts'
];

/** 全部可添加的输入扩展名 */
export const INPUT_EXTS = [...AUDIO_EXTS, ...VIDEO_INPUT_EXTS];

/** 输出格式信息；传入未知值时退回列表首项（MP3），避免界面异常 */
export function targetOf(value) {
  return AUDIO_TARGETS.find((t) => t.value === value) || AUDIO_TARGETS[0];
}

/**
 * 生成单个文件的转换计划
 * @param {{isVideo:boolean,durationSec:number}} item 已探测的媒体信息
 * @param {{target:string,quality:string}} params 界面参数
 * @returns {{ext:string,args:string[],durationMs:number}}
 */
export function buildPlan(item, params) {
  const target = targetOf(params.target);
  const args = [
    ...(item.isVideo ? ['-vn'] : []),                            // 视频输入：只取声音
    ...audioEncodeArgs(target.value, params.quality),
    '-map_metadata', '0',                                        // 保留标题/歌手等标签（实测有效）
    ...(target.ext === '.mp3' ? ['-id3v2_version', '3'] : [])    // ID3v2.3：老设备/资源管理器读标签兼容性更好
  ];
  return { ext: target.ext, args, durationMs: Math.round((item.durationSec || 0) * 1000) };
}

/** 秒 → mm:ss（超过 1 小时显示 h:mm:ss）；未知时长显示 --:-- */
export function formatDuration(sec) {
  if (!sec || sec <= 0) return '--:--';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 字节 → 人类可读（B / KB / MB / GB） */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 采样率 → 显示文案：44100 →「44.1 kHz」 */
export function formatSampleRate(hz) {
  if (!hz || hz <= 0) return '';
  const k = hz / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
}

/** 声道布局 → 中文文案（'mono'/'stereo'/'1 channels'/'2 channels'/1/2 → 单声道/立体声） */
export function formatChannels(layout, count) {
  const l = String(layout || '').toLowerCase();
  let n = count;
  if (!n) {
    const m = /(\d+)\s*channels?/.exec(l);
    if (m) n = Number(m[1]);
  }
  if (l.includes('mono') || n === 1) return '单声道';
  if (l.includes('stereo') || n === 2) return '立体声';
  if (n > 2) return `${n} 声道`;
  return '';
}

/** 列表项右侧的元信息：时长 ｜ 格式 ｜ 采样率 ｜ 声道 */
export function formatMeta(item) {
  const parts = [formatDuration(item.durationSec)];
  if (item.isVideo) parts.push('视频（提取声音）');
  else if (item.format) parts.push(item.format);
  const sr = formatSampleRate(item.sampleRate);
  if (sr) parts.push(sr);
  if (item.channelText) parts.push(item.channelText);
  return parts.join(' ｜ ');
}

/** 从完整路径取文件名（界面展示用，不依赖主进程） */
export function baseNameOf(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || '';
}