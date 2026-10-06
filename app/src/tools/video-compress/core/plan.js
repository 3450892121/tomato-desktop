// 工具：视频压缩 —— 业务逻辑（与界面解耦，纯函数，可用 node 直接单测）
// 职责：把「界面选好的参数」翻译成 ffmpeg 参数与显示文案。
// 编码参数一律复用 shared/ffmpeg.js 的现成函数，本文件不重复实现，保证各工具产出一致。

import {
  scaleToHeightArgs, videoEncodeArgs,
  planTargetBitrate, twoPassArgs
} from '../../../shared/ffmpeg.js';

/** ffmpeg 可解的主流视频扩展名（与 video-convert 保持一致） */
export const VIDEO_EXTS = [
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv',
  '.m4v', '.ts', '.3gp', '.mpg', '.mpeg', '.vob', '.rmvb', '.ogv'
];

/**
 * 生成单个文件的压缩计划
 * @param {{width:number,height:number,durationSec:number}} item 已探测的媒体信息
 * @param {{mode:'quality'|'size', quality?:string, targetMB?:number, audioKbps?:number,
 *          height?:number, mute?:boolean, videoKbps?:number}} params 界面参数
 *   - videoKbps：仅在目标体积模式下生效，用于「不达标自动降码率重跑」时覆盖计算值
 * @returns {{mode:'single',ext:string,args:string[],durationMs:number}
 *          |{mode:'twoPass',ext:string,pass1Args:string[],pass2Args:string[],durationMs:number,videoKbps:number}}
 */
export function buildPlan(item, params = {}) {
  const durationMs = Math.round((item.durationSec || 0) * 1000);
  const mute = !!params.mute;

  if (params.mode === 'size') {
    // 目标体积模式固定输出 MP4（H.264 + AAC）：两遍编码参数就是为 mp4 定的
    const audioKbps = mute ? 0 : (Number(params.audioKbps) || 0);
    const videoKbps = Number.isFinite(params.videoKbps) && params.videoKbps > 0
      ? Math.round(params.videoKbps)
      : planTargetBitrate({
        durationSec: item.durationSec,
        targetMB: params.targetMB,
        audioKbps
      });
    return {
      mode: 'twoPass',
      ext: '.mp4',
      videoKbps,
      pass1Args: twoPassArgs({ pass: 1, videoKbps, audioKbps }),
      pass2Args: twoPassArgs({ pass: 2, videoKbps, audioKbps }),
      durationMs
    };
  }

  // 画质档模式：单遍 CRF 编码（画质优先，体积顺其自然）
  const args = [
    ...scaleToHeightArgs(item.width, item.height, params.height),
    ...videoEncodeArgs('mp4', params.quality, { mute })
  ];
  return { mode: 'single', ext: '.mp4', args, durationMs };
}

/**
 * 判定压缩结果是否达标（默认容差 5%：超出目标 5% 以内算达标）
 * @param {{sizeBytes:number, targetMB:number, tolerance?:number}} o
 * @returns {{ok:boolean, overBy:number}} overBy = 相对「目标体积」超出的字节数（含容差内的轻微超出；未超出目标为 0）
 */
export function verifyTarget({ sizeBytes, targetMB, tolerance = 0.05 } = {}) {
  const size = Number(sizeBytes) || 0;
  const targetBytes = (Number(targetMB) || 0) * 1024 * 1024;
  const tol = Number.isFinite(tolerance) ? tolerance : 0.05;
  const ok = targetBytes > 0 && size <= targetBytes * (1 + tol);
  return { ok, overBy: Math.max(0, Math.round(size - targetBytes)) };
}

/**
 * 不达标时的降档码率（×0.85，下限 50 kbps），用于自动重跑一次
 * @param {{videoKbps:number}} o
 * @returns {number} 降档后的视频码率（kbps）
 */
export function retryBitrate({ videoKbps } = {}) {
  const k = Number(videoKbps);
  if (!Number.isFinite(k) || k <= 0) return 50;
  return Math.max(50, Math.round(k * 0.85));
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

/** 列表项右侧的元信息：时长 ｜ 分辨率 ｜ 音轨 ｜ 体积 */
export function formatMeta(item) {
  const parts = [];
  parts.push(formatDuration(item.durationSec));
  if (item.width && item.height) parts.push(`${item.width}×${item.height}`);
  parts.push(item.hasAudio ? '含声音' : '无声');
  if (Number.isFinite(item.sizeBytes) && item.sizeBytes > 0) parts.push(formatSize(item.sizeBytes));
  return parts.join(' ｜ ');
}

/** 从完整路径取文件名（界面展示用，不依赖主进程） */
export function baseNameOf(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || '';
}
