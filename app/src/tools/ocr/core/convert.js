// 工具：文字识别 —— 纯逻辑层（识别结果 → 文本 / 框数据 / PDF 坐标换算）
//
// 约定：本文件不碰 DOM、不碰 Electron、不 import 任何工具目录，可在 node 里直接单测。
//
// 数据来源：主进程 OCR 引擎返回的 lines 是**二维数组**——
//   外层每个元素是一行，内层是这一行里的若干识别片段：
//   [[{ text, box:{x,y,width,height}, confidence }, ...], ...]
//   box 是**渲染图片的像素坐标**（原点左上、y 向下）。
//
// PDF 是 y 向上的点坐标，所以叠隐形文字层前必须做一次换算（见 computePdfTextPlacement）。

/** 行内片段拼接成一行时的「空格判定」：片段间距超过行高的一半，就认为原文本来有空格 */
const GAP_RATIO = 0.5;

const isBox = (b) => !!b && Number.isFinite(b.x) && Number.isFinite(b.y)
  && Number.isFinite(b.width) && Number.isFinite(b.height);
const xOf = (f) => (isBox(f && f.box) ? f.box.x : 0);
const byX = (a, b) => xOf(a) - xOf(b);

/** 过滤出「非空行」：丢掉空行与空片段，保证后续排序/拼接不会踩空 */
export function normalizeLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((row) => (Array.isArray(row) ? row : []))
    .map((row) => row.filter((f) => f && typeof f.text === 'string' && f.text.length > 0))
    .filter((row) => row.length > 0);
}

/** 把一行里的片段按 x 排序并拼接（间距大才补空格，中文不会被硬塞空格） */
function rowToText(row) {
  const items = [...row].sort(byX);
  let out = '';
  let prev = null;
  for (const it of items) {
    if (prev && isBox(prev.box) && isBox(it.box)) {
      const gap = it.box.x - (prev.box.x + prev.box.width);
      const h = Math.min(prev.box.height, it.box.height);
      if (gap > Math.max(1, h) * GAP_RATIO) out += ' ';
    }
    out += it.text;
    prev = it;
  }
  return out;
}

/**
 * 识别结果 → 纯文本（每行一条，行内片段按 x 排序；空行丢弃）
 * @param {Array} lines 二维数组（见文件头说明）
 * @returns {string}
 */
export function linesToText(lines) {
  return normalizeLines(lines).map(rowToText).join('\n');
}

/** 多个页面的识别结果 → 一份文本（页与页之间空一行） */
export function pagesToText(pagesLines) {
  return (Array.isArray(pagesLines) ? pagesLines : [])
    .map((l) => linesToText(l))
    .filter((t) => t.length > 0)
    .join('\n\n');
}

/** 合并若干矩形为外接矩形；没有有效矩形时返回零矩形 */
export function unionBox(boxes) {
  const list = (boxes || []).filter(isBox);
  if (list.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const b of list) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * 识别结果 → 行级数据（供预览画框、导出 Word 用）
 * @param {Array} lines 二维数组
 * @returns {Array<{text: string, box: {x,y,width,height}}>}
 */
export function linesToPlainRows(lines) {
  return normalizeLines(lines).map((row) => ({
    text: rowToText(row),
    box: unionBox(row.map((f) => f.box))
  }));
}

/**
 * 识别结果 → 片段级数据（供「隐形文字层」逐段定位用，比整行一个框更贴合原文）
 * @param {Array} lines 二维数组
 * @param {{minConfidence?: number}} [options] minConfidence>0 时丢掉低置信度片段
 * @returns {Array<{text: string, box: {x,y,width,height}, confidence: number}>}
 */
export function linesToFragments(lines, { minConfidence = 0 } = {}) {
  const out = [];
  for (const row of normalizeLines(lines)) {
    for (const f of [...row].sort(byX)) {
      if (!isBox(f.box)) continue;
      const conf = Number.isFinite(f.confidence) ? f.confidence : 1;
      if (conf < minConfidence) continue;
      out.push({ text: f.text, box: { x: f.box.x, y: f.box.y, width: f.box.width, height: f.box.height }, confidence: conf });
    }
  }
  return out;
}

/**
 * 把引擎/底层的英文报错换成用户看得懂的中文（引擎在主进程，提示语统一在这里收口）
 * @param {string} message
 * @returns {string}
 */
export function friendlyOcrMessage(message) {
  const m = String(message == null ? '' : message).trim();
  if (!m) return '识别失败';
  if (/unsupported image type|decode|invalid image|corrupt/i.test(m)) return '这个文件不是能识别的图片格式（支持 PNG / JPG）';
  if (/out of memory|memory limit|allocation failed/i.test(m)) return '图片太大导致内存不足：请换小一点的图片，或降低扫描分辨率';
  if (/no such file|ENOENT/i.test(m)) return '找不到文件，可能已被移动或删除';
  if (/font/i.test(m) && /missing|load/i.test(m)) return '字体加载失败：请确认 addons/ocr/fonts/NotoSansSC-VF.ttf 存在';
  return m;
}

/**
 * 像素坐标（渲染图，y 向下）→ PDF 点坐标（y 向上）
 *
 * 换算方式（关键，已按实测链路固定）：
 *   1) 实际比例 = 渲染图高 / 页面高（pts），即「每点多少像素」。
 *      传进来的 renderScale 是渲染时用的倍率（约等于该比例），
 *      再用 renderedHeightPx 校正一次 round/取整带来的偏差：
 *        pxPerPt = renderedHeightPx / pageHeightPts   （拿不到就退回 renderScale）
 *   2) ptsPerPx = 1 / pxPerPt
 *   3) x     = box.x * ptsPerPx
 *      size  = box.height * ptsPerPx            （字号取框高，把基线放在框底）
 *      y     = pageHeightPts - box.y * ptsPerPx - size
 *      —— 也就是常用的 y_pdf = 页高 - y_px * ptsPerPx - 字号
 *
 * @param {{box: {x,y,width,height}, renderScale?: number, pageHeightPts: number, renderedHeightPx?: number}} input
 * @returns {{x: number, y: number, size: number}}
 */
export function computePdfTextPlacement({ box, renderScale = 1, pageHeightPts, renderedHeightPx } = {}) {
  const pageH = Number(pageHeightPts) || 0;
  const fallback = Number(renderScale) > 0 ? Number(renderScale) : 1;
  const pxPerPt = (Number.isFinite(renderedHeightPx) && renderedHeightPx > 0 && pageH > 0)
    ? renderedHeightPx / pageH
    : fallback;
  const ptsPerPx = pxPerPt > 0 ? 1 / pxPerPt : 1;
  const b = isBox(box) ? box : { x: 0, y: 0, width: 0, height: 0 };
  const size = Math.max(1, b.height * ptsPerPx);
  const x = Math.max(0, b.x * ptsPerPx);
  const y = Math.max(0, pageH - b.y * ptsPerPx - size);
  return { x, y, size };
}