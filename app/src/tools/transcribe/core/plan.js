// 工具：语音转文字 —— 业务逻辑（与界面解耦）
// 职责：输入扩展名、输出模式、SRT→纯文本推导、显示文案。
// 识别本身在主进程（asr:* IPC，调用 FunASR 加装包）；本文件不碰进程与文件读写。
// 目标与实测依据见 spec/modules/transcribe.md。

/** 可识别的音频扩展名（与主进程文件对话框筛选保持一致） */
export const AUDIO_EXTS = [
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wma', '.amr',
  '.aiff', '.aif', '.ape', '.dsf', '.mpc', '.tak', '.wv', '.tta', '.ac3', '.eac3',
  '.mp2', '.spx', '.caf', '.au', '.w64', '.ra', '.rm', '.oma'
];

/** 可识别的视频扩展名（自动提取音轨后识别） */
export const VIDEO_EXTS = [
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv', '.m4v',
  '.ts', '.3gp', '.mpg', '.mpeg', '.vob', '.rmvb', '.ogv'
];

/** 全部可添加的输入扩展名 */
export const INPUT_EXTS = [...AUDIO_EXTS, ...VIDEO_EXTS];

/** 输出内容三选一（value 与界面下拉一致） */
export const OUTPUT_MODES = [
  { value: 'txt', label: '纯文本（.txt，推荐）', exts: ['.txt'] },
  { value: 'srt', label: '字幕（.srt）', exts: ['.srt'] },
  { value: 'both', label: '文本 + 字幕', exts: ['.txt', '.srt'] }
];

/** 输出模式信息；未知值退回首项（纯文本），避免界面异常 */
export function modeOf(value) {
  return OUTPUT_MODES.find((m) => m.value === value) || OUTPUT_MODES[0];
}

/**
 * SRT 字幕 → 纯文本（去掉序号行与时间戳行，按段换行）
 * 说明：FunASR 的 --srt 输出是标准三段式（序号/时间戳/文本），文本行不会以时间戳开头。
 */
export function srtToText(srt) {
  if (!srt) return '';
  const blocks = String(srt).replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/);
  const lines = [];
  for (const block of blocks) {
    for (const line of block.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (/^\d+$/.test(t)) continue; // 序号行
      if (/^\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(t)) continue; // 时间戳行
      lines.push(t);
    }
  }
  return lines.join('\n');
}

/** 是否为合法 SRT（自检用：序号从 1 起严格递增、时间戳行数一致） */
export function isValidSrt(srt) {
  const text = String(srt || '').replace(/^\uFEFF/, '');
  const stamps = text.match(/^\d{1,2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2},\d{3}$/gm) || [];
  if (stamps.length === 0) return false;
  const indexes = (text.match(/^\d+$/gm) || []).map(Number);
  if (indexes.length < stamps.length) return false;
  return indexes.slice(0, stamps.length).every((n, i) => Number.isInteger(n) && n === i + 1);
}

/** 按输出模式生成待保存清单：[{ext, text}]（同一份识别结果，不重复跑模型） */
export function buildOutputs(srtText, mode) {
  const m = modeOf(mode);
  const text = srtToText(srtText);
  return m.exts.map((ext) => (ext === '.srt'
    ? { ext, text: `${String(srtText || '').trim()}\n` }
    : { ext, text: text ? `${text}\n` : '' }));
}

/** 剔除空白后的字数（列表里显示「xx 字」） */
export function countChars(text) {
  return String(text || '').replace(/\s+/g, '').length;
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
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 列表项右侧的元信息：时长 ｜ 格式 ｜ 大小 */
export function formatMeta(item) {
  const parts = [formatDuration(item.durationSec)];
  if (item.isVideo) parts.push('视频（提取声音）');
  else if (item.format) parts.push(item.format);
  const size = formatSize(item.size);
  if (size) parts.push(size);
  return parts.join(' ｜ ');
}

/** 从完整路径取文件名（界面展示用，不依赖主进程） */
export function baseNameOf(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || '';
}