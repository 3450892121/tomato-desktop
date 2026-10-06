// 工具：九宫格切图 —— 纯逻辑（切分计算 / 编号命名 / 体积估算）
// 说明：本文件不依赖任何浏览器 API（不含 canvas / DOM），可在 Node 里直接单测；
//       真正的裁切与编码在 ui.js 的 sliceImage（用内核 OffscreenCanvas 完成）。
// 目标与规则见 spec/modules/grid-slice.md。

/**
 * 切分预设。rows × cols：1×3 = 竖切三条、3×1 = 横切三条。
 * value='custom' 表示行列数由界面上的自定义输入决定（rows/cols 为 0，仅作占位）。
 */
export const GRID_PRESETS = [
  { value: '3x3', label: '九宫格 3×3', rows: 3, cols: 3 },
  { value: '2x2', label: '四宫格 2×2', rows: 2, cols: 2 },
  { value: '1x3', label: '竖切三条 1×3', rows: 1, cols: 3 },
  { value: '3x1', label: '横切三条 3×1', rows: 3, cols: 1 },
  { value: 'custom', label: '自定义行列数…', rows: 0, cols: 0 }
];

/** 每块的最小可用边长：小于它在手机上会糊得看不清，界面据此给出警告 */
export const MIN_CELL = 8;

/** 行列数允许的最大值（防止手滑输个大数把内存撑爆） */
export const MAX_LINES = 20;

/** 编号的小块数量：两位补零（_01…_09），排文件时顺序不会乱；超过 99 时自然变成三位 */
const PAD = 2;

function toInt(value, fallback) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 计算切分网格。
 * 规则：外圈留白 margin 先扣掉，块与块之间扣 gap 的切缝；剩下的可用区域按行列均分（向下取整），
 *       所以每一块尺寸完全一致（发出去才整齐），最右侧/最底部的余数像素不参与切图。
 * @param {{width: number, height: number, rows: number, cols: number, gap?: number, margin?: number}} options
 * @returns {{cells: Array<{index: number, row: number, col: number, sx: number, sy: number, sw: number, sh: number}>,
 *            outW: number, outH: number, warnings: string[]}}
 *          cells 按行优先排列（index 从 1 开始）；outW/outH 是每一块的输出尺寸；
 *          warnings 非空表示图片太小，界面应阻止执行。
 */
export function computeCells({ width, height, rows, cols, gap = 0, margin = 0 } = {}) {
  const warnings = [];
  const w = toInt(width, 0);
  const h = toInt(height, 0);
  const R = toInt(rows, 0);
  const C = toInt(cols, 0);
  const g = Math.max(0, toInt(gap, 0));
  const m = Math.max(0, toInt(margin, 0));

  if (w <= 0 || h <= 0) {
    warnings.push('图片尺寸无效，无法切分');
    return { cells: [], outW: 0, outH: 0, warnings };
  }
  if (R < 1 || C < 1) {
    warnings.push('行列数必须是 1 或更大的整数');
    return { cells: [], outW: 0, outH: 0, warnings };
  }

  const usableW = w - m * 2 - g * (C - 1);
  const usableH = h - m * 2 - g * (R - 1);
  const outW = Math.floor(usableW / C);
  const outH = Math.floor(usableH / R);

  if (outW <= 0 || outH <= 0) {
    warnings.push(`图片太小：${w}×${h} 放不下 ${R}×${C} 的切分（含 ${g}px 切缝、${m}px 留白）`);
    return { cells: [], outW: 0, outH: 0, warnings };
  }
  if (outW < MIN_CELL || outH < MIN_CELL) {
    warnings.push(`每块只有 ${outW}×${outH} 像素，太小了（建议至少 ${MIN_CELL}×${MIN_CELL}）：请换更大的图，或减少行列数 / 切缝`);
  }

  const cells = [];
  for (let r = 0; r < R; r += 1) {
    for (let c = 0; c < C; c += 1) {
      cells.push({
        index: r * C + c + 1,
        row: r,
        col: c,
        sx: m + c * (outW + g),
        sy: m + r * (outH + g),
        sw: outW,
        sh: outH
      });
    }
  }
  return { cells, outW, outH, warnings };
}

/**
 * 生成每块的文件名（不含扩展名），返回数组与 cells 一一对应（按行优先的 cell 顺序）。
 * order='row'    按行编号：从左上到右下自然读数，符合朋友圈九宫格习惯（默认）；
 * order='column' 按列编号：第 1 列从上到下，再第 2 列……
 * 例（baseName='照片'，3×3）：按行 = 照片_01…照片_09；按列 = 照片_01、照片_04、照片_07、照片_02…
 */
export function namingForCells({ baseName, rows, cols, order = 'row' } = {}) {
  const R = Math.max(0, toInt(rows, 0));
  const C = Math.max(0, toInt(cols, 0));
  const base = String(baseName == null ? '' : baseName);
  const names = new Array(R * C);
  for (let r = 0; r < R; r += 1) {
    for (let c = 0; c < C; c += 1) {
      const cellIndex = r * C + c;                       // cells 数组里的下标（按行优先）
      const number = order === 'column' ? c * R + r + 1 : cellIndex + 1;
      names[cellIndex] = `${base}_${String(number).padStart(PAD, '0')}`;
    }
  }
  return names;
}

/** 各格式的经验字节/像素比（仅供「大概多大」提示，不是精确预测） */
const BYTES_PER_PIXEL = { png: 1.6, jpg: 0.45, webp: 0.35 };

/**
 * 粗略估算产出体积（用于界面上的「预计约 xx」提示）
 * @returns {{perFile: number, total: number}} 每块字节数、所有块合计字节数
 */
export function estimateTotalBytes({ outW, outH, count, format = 'png' } = {}) {
  const bpp = BYTES_PER_PIXEL[String(format).toLowerCase()] || BYTES_PER_PIXEL.png;
  const perFile = Math.max(0, Math.round(toInt(outW, 0) * toInt(outH, 0) * bpp));
  return { perFile, total: perFile * Math.max(0, toInt(count, 0)) };
}

/** 体积格式化：B / KB / MB / GB */
export function formatSize(bytes) {
  const n = Number(bytes);
  const v = Number.isFinite(n) ? Math.max(0, n) : 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(2)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${Math.round(v)} B`;
}

/** 取路径里的文件名（去掉目录与最后一个扩展名）；`.gitignore` 这类纯扩展名保持原样 */
export function baseNameOf(path) {
  const name = String(path == null ? '' : path).split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}