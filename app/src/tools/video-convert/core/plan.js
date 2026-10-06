// 工具：视频格式转换 —— 业务逻辑（与界面解耦）
// 职责：把「界面选好的参数」翻译成 ffmpeg 参数与显示文案。
// 编码参数一律复用 shared/ffmpeg.js 的现成函数，本文件不重复实现，保证各工具产出一致。

import { VIDEO_TARGETS, scaleToHeightArgs, videoEncodeArgs } from '../../../shared/ffmpeg.js';

/** ffmpeg 可解的主流视频扩展名（与主进程文件对话框的筛选保持一致） */
export const VIDEO_EXTS = [
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv',
  '.m4v', '.ts', '.3gp', '.mpg', '.mpeg', '.vob', '.rmvb', '.ogv',
  // v2.13.0 起补充的老格式/常见封装（demuxer 均已用随包 ffmpeg 验证在位）：
  // asf（wmv 同容器）、3g2/f4v（mp4 同容器）、mts/m2ts（AVCHD/蓝光 MPEG-TS）
  '.asf', '.3g2', '.f4v', '.mts', '.m2ts'
];

/** 输出容器信息；传入未知值时退回列表首项（MP4），避免界面异常 */
export function targetOf(value) {
  return VIDEO_TARGETS.find((t) => t.value === value) || VIDEO_TARGETS[0];
}

/**
 * 生成单个文件的转码计划
 * @param {{width:number,height:number,durationSec:number}} item 已探测的媒体信息
 * @param {{target:string,height:number,quality:string,mute:boolean}} params 界面参数
 * @returns {{ext:string,args:string[],durationMs:number}}
 */
export function buildPlan(item, params) {
  const target = targetOf(params.target);
  const args = [
    ...scaleToHeightArgs(item.width, item.height, params.height),
    ...videoEncodeArgs(target.value, params.quality, { mute: params.mute })
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

/** 列表项右侧的元信息：时长 ｜ 分辨率 ｜ 音轨 ｜ 编码 */
export function formatMeta(item) {
  const parts = [];
  parts.push(formatDuration(item.durationSec));
  if (item.width && item.height) parts.push(`${item.width}×${item.height}`);
  parts.push(item.hasAudio ? '含声音' : '无声');
  if (item.videoCodec) parts.push(item.videoCodec);
  return parts.join(' ｜ ');
}

/** 从完整路径取文件名（界面展示用，不依赖主进程） */
export function baseNameOf(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || '';
}