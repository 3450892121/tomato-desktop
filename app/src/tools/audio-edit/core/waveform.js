// 工具：音频剪辑 —— 业务逻辑（与界面解耦，纯函数为主，可用 Node 直接单测）
// 职责：① 解析降采样 WAV、算波形峰值、波形坐标换算与选区合法化；
//       ② 把「界面选好的参数」翻译成 ffmpeg 参数与显示文案。
// 编码参数一律复用 shared/ffmpeg.js 的现成函数（atrimArgs / audioFilterArgs / concatAudioArgs / audioEncodeArgs），
// 本文件不重复实现，保证各工具产出一致。目标与实测依据见 spec/modules/audio-edit.md。

import {
  AUDIO_TARGETS, AUDIO_QUALITY_PRESETS, audioEncodeArgs,
  atrimArgs, audioFilterArgs, concatAudioArgs
} from '../../../shared/ffmpeg.js';

// —— 输入扩展名（与「音频格式转换」保持一致：音频 + 视频自动取音轨） ——

/** ffmpeg 可解的主流音频扩展名 */
export const AUDIO_EXTS = [
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wma', '.amr',
  '.aiff', '.aif', '.ape', '.dsf', '.mpc', '.tak', '.wv', '.tta', '.ac3', '.eac3',
  '.mp2', '.spx', '.caf', '.au', '.w64', '.ra', '.rm', '.oma'
];

/** 也可以作为输入的视频扩展名：自动提取音轨（-vn） */
export const VIDEO_INPUT_EXTS = [
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv', '.m4v',
  '.ts', '.3gp', '.mpg', '.mpeg', '.vob', '.rmvb', '.ogv'
];

/** 全部可添加的输入扩展名 */
export const INPUT_EXTS = [...AUDIO_EXTS, ...VIDEO_INPUT_EXTS];

/** 波形默认分桶数（画布宽度无关，绘制时按比例拉伸，保证不同窗口宽度下观感一致） */
export const WAVE_BUCKETS = 1024;

/** 波形降采样参数：8kHz 单声道 WAV，足够画波形、体积小 */
export const WAVE_SAMPLE_ARGS = ['-ac', '1', '-ar', '8000'];

/** 超过这个时长（毫秒）提醒用户「波形生成可能较慢」（30 分钟） */
export const WAVE_SLOW_MS = 30 * 60 * 1000;

/** 输出格式信息；传入未知值时退回列表首项（MP3），避免界面异常 */
export function targetOf(value) {
  return AUDIO_TARGETS.find((t) => t.value === value) || AUDIO_TARGETS[0];
}

// —— WAV 解析与波形（纯计算，不碰 DOM） ——

function toUint8(bytes) {
  if (!bytes) return null;
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  return null;
}

function readAscii(view, offset, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const code = view[offset + i];
    if (code === undefined) return out;
    out += String.fromCharCode(code);
  }
  return out;
}

const EMPTY_WAV = () => ({ sampleRate: 0, channels: 0, samples: new Float32Array(0), durationMs: 0 });

/**
 * 解析 16-bit PCM WAV（transformImageBytes 降采样后返回的就是这种）。
 * 多声道按平均混为单声道（波形只需单声道；返回的 samples 长度 = 帧数）。
 * @returns {{sampleRate:number, channels:number, samples:Float32Array, durationMs:number}}
 */
export function parseWav(bytes) {
  const view = toUint8(bytes);
  if (!view || view.length < 44) return EMPTY_WAV();
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') return EMPTY_WAV();
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);

  let fmt = null;
  let dataOffset = -1;
  let dataLen = 0;
  let pos = 12;
  while (pos + 8 <= view.length) {
    const id = readAscii(view, pos, 4);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ' && body + 16 <= view.length) {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bitsPerSample: dv.getUint16(body + 14, true)
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLen = Math.max(0, Math.min(size, view.length - body));
    }
    pos = body + size + (size % 2); // RIFF 块按偶数字节对齐
  }

  // 只处理 PCM（format=1）16-bit；其余（浮点/压缩 WAV）返回空，界面会提示无法生成波形
  if (!fmt || dataOffset < 0 || fmt.format !== 1 || fmt.bitsPerSample !== 16 || fmt.channels < 1 || fmt.sampleRate <= 0) {
    return EMPTY_WAV();
  }
  const frames = Math.floor(dataLen / 2 / fmt.channels);
  const samples = new Float32Array(frames);
  const channels = fmt.channels;
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) {
      sum += dv.getInt16(dataOffset + (i * channels + c) * 2, true);
    }
    samples[i] = sum / channels / 32768;
  }
  return {
    sampleRate: fmt.sampleRate,
    channels,
    samples,
    durationMs: fmt.sampleRate > 0 ? (frames / fmt.sampleRate) * 1000 : 0
  };
}

/**
 * 把采样点分成 buckets 段，每段取绝对值峰值（0~1），用于画波形。
 * @param {Float32Array|number[]} samples
 * @param {number} buckets
 * @returns {Float32Array} 长度 = buckets
 */
export function buildPeaks(samples, buckets) {
  const n = Math.max(0, Math.floor(Number(buckets) || 0));
  const out = new Float32Array(n);
  const len = samples ? samples.length : 0;
  if (n === 0 || len === 0) return out;
  for (let b = 0; b < n; b += 1) {
    const start = Math.floor((b * len) / n);
    let end = Math.floor(((b + 1) * len) / n);
    if (end <= start) end = start + 1;
    if (end > len) end = len;
    let peak = 0;
    for (let i = start; i < end; i += 1) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    out[b] = peak;
  }
  return out;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 时间（毫秒）→ 画布横坐标（像素），夹紧到 [0, width] */
export function msToPx(ms, durationMs, width) {
  const w = Number(width) || 0;
  if (!(durationMs > 0) || w <= 0) return 0;
  return clamp(((Number(ms) || 0) / durationMs) * w, 0, w);
}

/** 画布横坐标（像素）→ 时间（毫秒），夹紧到 [0, durationMs] */
export function pxToMs(px, durationMs, width) {
  const w = Number(width) || 0;
  if (w <= 0 || !(durationMs > 0)) return 0;
  return clamp(((Number(px) || 0) / w) * durationMs, 0, durationMs);
}

/**
 * 合法化选区：夹紧到 [0, durationMs]，并保证 start < end（非法时回退为「start 到结尾」或全选）。
 * @returns {{startMs:number, endMs:number}}
 */
export function normalizeSelection({ startMs, endMs, durationMs } = {}) {
  const d = Math.max(0, Number(durationMs) || 0);
  if (d <= 0) return { startMs: 0, endMs: 0 };
  let s = clamp(Math.round(Number(startMs) || 0), 0, d);
  let e = clamp(Math.round(Number(endMs) || 0), 0, d);
  if (e <= s) {
    e = d;
    if (e <= s) s = 0; // start 已在结尾：退回全选
  }
  return { startMs: s, endMs: e };
}

// —— 时间文案 ——

/** 毫秒 → mm:ss.SSS（超过 1 小时显示 h:mm:ss.SSS） */
export function formatTimeMs(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const msec = total % 1000;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const mss = String(msec).padStart(3, '0');
  return h > 0 ? `${h}:${mm}:${ss}.${mss}` : `${mm}:${ss}.${mss}`;
}

/** "mm:ss.SSS" / "mm:ss" / "h:mm:ss.SSS" / 纯秒数 → 毫秒；无法解析返回 NaN */
export function parseTimeToMs(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return NaN;
  const parts = s.split(':');
  if (parts.length > 3) return NaN;
  let total = 0;
  for (const part of parts) {
    if (!/^\d*(?:\.\d+)?$/.test(part) || part === '') return NaN;
    total = total * 60 + Number(part);
  }
  return Number.isFinite(total) ? Math.round(total * 1000) : NaN;
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

/** 声道布局 → 中文文案 */
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

/** 从完整路径取文件名（界面展示用，不依赖主进程） */
export function baseNameOf(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || '';
}

/** 列表项元信息：时长 ｜ 格式 ｜ 采样率 ｜ 声道 */
export function formatMeta(item) {
  const parts = [formatDuration(item.durationSec)];
  if (item.isVideo) parts.push('视频（提取声音）');
  else if (item.format) parts.push(item.format);
  const sr = formatSampleRate(item.sampleRate);
  if (sr) parts.push(sr);
  if (item.channelText) parts.push(item.channelText);
  return parts.join(' ｜ ');
}

// —— 剪辑计划 ——

/** 有码率可估算的输出格式 → AUDIO_QUALITY_PRESETS 里的字段名 */
const BITRATE_KEYS = {
  mp3: 'mp3', m4a: 'aac', aac: 'aac', opus: 'opus',
  wma: 'wma', ac3: 'ac3', eac3: 'ac3', mp2: 'mp2'
};

/** 粗略估算输出体积（字节；无法估算时返回 0） */
function estimateBytes(target, quality, durationMs) {
  const dur = Math.max(0, Number(durationMs) || 0) / 1000;
  if (dur <= 0) return 0;
  const key = BITRATE_KEYS[target.value];
  if (!key) {
    // 无损 WAV：按 44.1kHz 立体声 16-bit 粗估（实际取决于源）
    return target.value === 'wav' ? Math.round(dur * 44100 * 2 * 2) : 0;
  }
  const q = AUDIO_QUALITY_PRESETS[quality] || AUDIO_QUALITY_PRESETS.standard;
  const kbps = parseFloat(q[key]);
  if (!Number.isFinite(kbps)) return 0;
  return Math.round(((kbps * 1000) / 8) * dur);
}

/** 判断参数里是否含任何需要重编码的滤镜（音量/淡入淡出） */
export function hasAudioFilter(params = {}) {
  const gain = params.gainDb;
  return gain === 'normalize'
    || (Number.isFinite(gain) && gain !== 0)
    || Number(params.fadeInMs) > 0
    || Number(params.fadeOutMs) > 0;
}

/**
 * 生成剪辑计划（纯函数）
 * @param {{ext?:string,isVideo?:boolean,durationMs?:number}} item 已探测的媒体信息
 * @param {{startMs?:number,endMs?:number,gainDb?:number|'normalize',fadeInMs?:number,fadeOutMs?:number,
 *          target?:string,quality?:string,concatCount?:number,segmentDurationsMs?:number[],
 *          totalDurationMs?:number}} params 界面参数
 * @returns {{mode:'single'|'concat', ext:string, args:string[], inputArgs:string[], inputCount:number,
 *            durationMs:number, estimated:number, copy:boolean, hasFilter:boolean,
 *            concat:boolean, needsMultipleInputs:boolean}}
 *   - mode='single'：单文件剪辑（inputArgs 插在 -i 前做截取；args 为输出侧参数）；
 *   - mode='concat'：按列表顺序拼接（inputPaths 交给 convertMediaMulti；截取/滤镜不适用，
 *     故 inputArgs 为空、args 只含 concat 滤镜 + 编码参数）；
 *   - durationMs：预计输出时长（进度折算用；拼接时为各段之和）；
 *   - estimated：预计输出体积（字节，0=无法估算）；
 *   - copy：是否走「不重编码」极速路径（仅单文件）；needsMultipleInputs：是否必须走多输入 IPC。
 */
export function buildEditPlan(item, params = {}) {
  const target = targetOf(params.target);
  const src = item || {};
  const srcDurationMs = Math.max(0, Math.round(Number(src.durationMs) || 0));
  const concatCount = Math.max(0, Math.floor(Number(params.concatCount) || 0));
  const encodeArgs = audioEncodeArgs(target.value, params.quality);
  const videoArgs = src.isVideo ? ['-vn'] : []; // 视频输入只取声音

  // 拼接：用 concat 滤镜一次读入多段（走多输入 IPC convertMediaMulti）
  if (concatCount >= 2) {
    // 总时长：优先显式传入，其次各段时长求和，最后退回单段时长
    const segs = Array.isArray(params.segmentDurationsMs) ? params.segmentDurationsMs : null;
    const sumMs = segs && segs.length
      ? segs.reduce((acc, v) => acc + Math.max(0, Math.round(Number(v) || 0)), 0)
      : srcDurationMs;
    const totalMs = Number(params.totalDurationMs) > 0 ? Math.round(Number(params.totalDurationMs)) : sumMs;
    return {
      mode: 'concat',
      ext: target.ext,
      args: [...concatAudioArgs({ count: concatCount }), ...encodeArgs],
      inputArgs: [],
      inputCount: concatCount,
      durationMs: totalMs,
      estimated: estimateBytes(target, params.quality, totalMs),
      copy: false,
      hasFilter: false,
      concat: true,
      needsMultipleInputs: true
    };
  }

  const sel = normalizeSelection({ startMs: params.startMs, endMs: params.endMs, durationMs: srcDurationMs });
  const clipMs = Math.max(0, sel.endMs - sel.startMs);
  const inputArgs = atrimArgs({ startMs: sel.startMs, endMs: sel.endMs });
  const filterArgs = audioFilterArgs({
    gainDb: params.gainDb,
    fadeInMs: params.fadeInMs,
    fadeOutMs: params.fadeOutMs,
    durationMs: clipMs
  });
  const hasFilter = filterArgs.length > 0;

  // 只截取、无任何滤镜，且目标容器与源容器一致 → 直接复制音频流，几乎瞬间完成
  const canCopy = !hasFilter && !src.isVideo && !!src.ext && src.ext.toLowerCase() === target.ext.toLowerCase();
  if (canCopy) {
    return {
      mode: 'single',
      ext: target.ext,
      args: ['-c:a', 'copy'],
      inputArgs,
      inputCount: 1,
      durationMs: clipMs,
      estimated: 0,
      copy: true,
      hasFilter: false,
      concat: false,
      needsMultipleInputs: false
    };
  }

  const args = [
    ...videoArgs,
    ...filterArgs,
    ...encodeArgs,
    '-map_metadata', '0',                                      // 保留标题/歌手等标签
    ...(target.ext === '.mp3' ? ['-id3v2_version', '3'] : [])  // ID3v2.3：老设备兼容性更好
  ];
  return {
    mode: 'single',
    ext: target.ext,
    args,
    inputArgs,
    inputCount: 1,
    durationMs: clipMs,
    estimated: estimateBytes(target, params.quality, clipMs),
    copy: false,
    hasFilter,
    concat: false,
    needsMultipleInputs: false
  };
}
