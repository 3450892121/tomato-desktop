// 工具：动图与视频互转 —— 业务逻辑（与界面解耦）
// 职责：文件类型判定、输出格式映射、ffmpeg 参数拼装与「目标大小」降档策略。
// 所有编码参数复用 shared/ffmpeg.js 的现成函数，本文件不重复实现。

import {
  videoToGifArgs, videoToWebpArgs, videoToApngArgs, animToVideoArgs, videoEncodeArgs
} from '../../../shared/ffmpeg.js';

/** 视频扩展名（与主进程文件对话框筛选一致） */
export const VIDEO_EXTS = [
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv',
  '.m4v', '.ts', '.3gp', '.mpg', '.mpeg', '.vob', '.rmvb', '.ogv'
];
/** 动图扩展名（APNG 惯例使用 .png，另见 classifyExt 的探测判断） */
export const ANIM_EXTS = ['.gif', '.webp', '.apng'];
/** 拖拽文件夹展开时用的扩展名：额外带上 .png（本工具导出的 APNG 就是 .png 后缀） */
export const MEDIA_EXTS = [...ANIM_EXTS, ...VIDEO_EXTS, '.png'];

/** 输出方向：动图三种 + 视频两种 */
export const OUTPUTS = [
  { value: 'gif', ext: '.gif', kind: 'anim', label: 'GIF（兼容性最好）' },
  { value: 'webp', ext: '.webp', kind: 'anim', label: 'WebP 动图（体积小）' },
  { value: 'apng', ext: '.png', kind: 'anim', label: 'APNG（.png 后缀，画质好）' },
  { value: 'mp4', ext: '.mp4', kind: 'video', label: 'MP4 视频（H.264，最通用）' },
  { value: 'webm', ext: '.webm', kind: 'video', label: 'WebM 视频（VP9，体积小）' }
];

export function outputOf(value) {
  return OUTPUTS.find((o) => o.value === value) || OUTPUTS[0];
}

export function isAnimOutput(value) {
  return outputOf(value).kind === 'anim';
}

/**
 * 判定文件类型
 * @param {string} ext 扩展名（含点，小写）
 * @param {object} probe ffmpeg 探测结果
 * @returns {'anim'|'video'|null} null 表示不支持
 */
export function classifyExt(ext, probe) {
  const e = String(ext || '').toLowerCase();
  if (e === '.gif' || e === '.webp' || e === '.apng') return 'anim';
  if (e === '.png') {
    // APNG 按惯例使用 .png 后缀：只能靠探测出的封装名区分；静态 PNG 不成动画
    const fmt = String((probe && probe.format) || '').toLowerCase();
    return fmt.includes('apng') ? 'anim' : null;
  }
  if (VIDEO_EXTS.includes(e)) return 'video';
  return null;
}

/** 动图输出参数：GIF / WebP / APNG 分派到 shared 里对应的拼装函数 */
export function animArgs(output, o = {}) {
  if (output === 'webp') return videoToWebpArgs(o);
  if (output === 'apng') return videoToApngArgs(o);
  return videoToGifArgs(o);
}

/** 动图/视频 → 视频 参数（动图无音轨，统一静音） */
export function videoArgs(o = {}) {
  return [
    ...animToVideoArgs({ srcW: o.srcW, srcH: o.srcH, targetHeight: o.targetHeight, fps: o.fps }),
    ...videoEncodeArgs(o.target, 'standard', { mute: true })
  ];
}

/** 档位描述（结果文案用）：240 宽 / 12 帧（+ 色数） */
export function describeRung(r) {
  const width = r.width ? `${r.width} 宽` : '保持原始宽';
  const colors = r.colors && r.colors < 256 ? ` / ${r.colors} 色` : '';
  return `${width} / ${r.fps} 帧${colors}`;
}

/**
 * 「目标大小」降档档位：基准 → 降帧 → 缩宽 → 再降帧 →（GIF 才降色数）
 * 每档在上一档基础上继续降低，命中上限即停。
 */
export function sizeLadder(base, isGif) {
  const rungs = [{ ...base, label: describeRung(base) }];
  let cur = { ...base };
  const steps = [
    (p) => ({ ...p, fps: Math.max(8, (p.fps || 15) - 2) }),
    (p) => ({ ...p, width: p.width ? Math.max(160, Math.round(p.width * 0.8)) : p.width }),
    (p) => ({ ...p, fps: Math.max(8, (p.fps || 15) - 2) })
  ];
  if (isGif) {
    steps.push((p) => ({ ...p, colors: 128 }));
    steps.push((p) => ({ ...p, colors: 64 }));
  }
  for (const step of steps) {
    const next = step(cur);
    // 「保持原始宽」等情况下某一步可能无效，跳过重复档位（避免重复产出同一份文件）
    if (next.fps === cur.fps && next.width === cur.width && next.colors === cur.colors) continue;
    cur = next;
    rungs.push({ ...cur, label: describeRung(cur) });
  }
  return rungs;
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

/** 列表项元信息：类型 ｜ 时长 ｜ 分辨率（视频再加音轨） */
export function formatMeta(item) {
  const parts = [item.type === 'anim' ? '动图' : '视频'];
  parts.push(formatDuration(item.durationSec));
  if (item.width && item.height) parts.push(`${item.width}×${item.height}`);
  if (item.type === 'video') parts.push(item.hasAudio ? '含声音' : '无声');
  return parts.join(' ｜ ');
}

/** 从完整路径取文件名（界面展示用，不依赖主进程） */
export function baseNameOf(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || '';
}