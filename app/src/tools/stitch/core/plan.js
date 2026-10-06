// 工具：长图拼接 —— 纯逻辑（尺寸归一 + 画布布局）
// 说明：本文件不依赖任何浏览器 API（不碰 canvas / DOM），可直接在 node 下单测。
//       绘制与编码在 ui.js 的 composeStitch；界面与流程编排在 ui.js。

/** 拼接方向（界面下拉用；顺序即界面顺序） */
export const STITCH_DIRECTIONS = [
  { value: 'vertical', label: '竖拼（从上到下）' },
  { value: 'horizontal', label: '横拼（从左到右）' }
];

/** 对齐方式：垂直于拼接方向的轴线上如何摆放（竖拼=左右对齐，横拼=上下对齐） */
export const ALIGN_PRESETS = [
  { value: 'center', label: '居中' },
  { value: 'start', label: '起始（左 / 上）' },
  { value: 'end', label: '末尾（右 / 下）' }
];

/**
 * 浏览器 canvas 的安全上限（Chromium 常见限制）。
 * 超过就明确拒绝执行并给出原因，而不是等浏览器抛异常 / 白屏。
 */
export const MAX_CANVAS_EDGE = 16384;
export const MAX_CANVAS_AREA = 160_000_000; // 1.6 亿像素

/** 取一项的宽或高（兼容 {width,height} 与 {w,h} 两种写法） */
function dimOf(item, key) {
  if (!item) return 0;
  const v = key === 'w' ? (item.w !== undefined ? item.w : item.width) : (item.h !== undefined ? item.h : item.height);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
}

/**
 * 按参数把每张图的绘制尺寸算出来。
 * @param {{items?: Array<{width?: number, height?: number, w?: number, h?: number}>, direction?: 'vertical'|'horizontal', mode?: 'none'|'unify', targetSize?: number}} options
 * @returns {Array<{w: number, h: number}>} 与 items 一一对应的绘制尺寸
 *
 * mode='none'：保持原样。
 * mode='unify'：竖拼统一宽度 / 横拼统一高度，按 targetSize；未给 targetSize 时取列表里最大那个作为目标。
 * 约定：**只缩不放**——比目标大的图缩到目标，比目标小的图保持原样（放大只会糊）。
 *       未给 targetSize 时目标＝列表最大值，因此此时不会放大任何图（结果等同保持原样）；
 *       界面会把「当前最大值」预填进输入框，用户改小即生效。
 */
export function normalizeSizes({ items = [], direction = 'vertical', mode = 'none', targetSize = 0 } = {}) {
  const vertical = direction !== 'horizontal';
  const base = (items || []).map((it) => ({ w: dimOf(it, 'w'), h: dimOf(it, 'h') }));
  if (mode !== 'unify' || base.length === 0) return base;

  const wanted = Math.round(Number(targetSize) || 0);
  const target = wanted > 0
    ? wanted
    : Math.max(...base.map((s) => (vertical ? s.w : s.h)));

  return base.map((s) => {
    const cur = vertical ? s.w : s.h;
    const scale = Math.min(target / cur, 1); // 只缩不放
    if (scale >= 1) return { w: s.w, h: s.h };
    return {
      w: Math.max(1, Math.round(s.w * scale)),
      h: Math.max(1, Math.round(s.h * scale))
    };
  });
}

/** 在容器里按对齐方式算偏移（结果不会是负数） */
function alignOffset(container, item, align) {
  if (align === 'start') return 0;
  if (align === 'end') return Math.max(0, container - item);
  return Math.max(0, Math.round((container - item) / 2));
}

/**
 * 算出拼接后整张画布的尺寸与每张图的落点。
 * @param {{sizes?: Array<{w: number, h: number}>, direction?: 'vertical'|'horizontal', gap?: number, align?: 'center'|'start'|'end', margin?: number}} options
 * @returns {{canvasW: number, canvasH: number, offsets: Array<{x: number, y: number, w: number, h: number}>, limitExceeded: boolean, reason: string}}
 *          limitExceeded 为 true 时 reason 可直接展示给用户；界面应阻止执行。
 */
export function computeLayout({ sizes = [], direction = 'vertical', gap = 0, align = 'center', margin = 0 } = {}) {
  const vertical = direction !== 'horizontal';
  const g = Math.max(0, Math.round(Number(gap) || 0));
  const m = Math.max(0, Math.round(Number(margin) || 0));
  const list = (sizes || []).map((s) => ({ w: dimOf(s, 'w'), h: dimOf(s, 'h') }));

  let canvasW;
  let canvasH;
  let contentW;
  let contentH;

  if (list.length === 0) {
    canvasW = m * 2;
    canvasH = m * 2;
    contentW = 0;
    contentH = 0;
  } else {
    const sumW = list.reduce((a, s) => a + s.w, 0) + g * (list.length - 1);
    const sumH = list.reduce((a, s) => a + s.h, 0) + g * (list.length - 1);
    contentW = vertical ? Math.max(...list.map((s) => s.w)) : sumW;
    contentH = vertical ? sumH : Math.max(...list.map((s) => s.h));
    canvasW = contentW + m * 2;
    canvasH = contentH + m * 2;
  }

  const offsets = [];
  let cursor = 0;
  for (const s of list) {
    if (vertical) {
      offsets.push({ x: m + alignOffset(contentW, s.w, align), y: m + cursor, w: s.w, h: s.h });
      cursor += s.h + g;
    } else {
      offsets.push({ x: m + cursor, y: m + alignOffset(contentH, s.h, align), w: s.w, h: s.h });
      cursor += s.w + g;
    }
  }

  const reasons = [];
  if (canvasW > MAX_CANVAS_EDGE || canvasH > MAX_CANVAS_EDGE) {
    reasons.push(`单边超过 ${MAX_CANVAS_EDGE} 像素（当前 ${canvasW} × ${canvasH}）`);
  }
  if (canvasW * canvasH > MAX_CANVAS_AREA) {
    reasons.push(`总面积超过 ${(MAX_CANVAS_AREA / 100000000).toFixed(1)} 亿像素（当前 ${(canvasW * canvasH / 100000000).toFixed(1)} 亿）`);
  }
  const limitExceeded = reasons.length > 0;

  return {
    canvasW,
    canvasH,
    offsets,
    limitExceeded,
    reason: limitExceeded
      ? `拼出来的画布太大：${reasons.join('；')}。请减少图片数量，或把「统一尺寸」调小。`
      : ''
  };
}

/** 字节数转成人看的大小（B / KB / MB / GB） */
export function formatSize(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n >= 1024 * 1024 * 1024) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** 从完整路径里取文件名（不含扩展名）；兼容 \ 与 / 两种分隔符 */
export function baseNameOf(filePath) {
  const s = String(filePath || '');
  const last = s.split(/[\\/]/).pop() || '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

/**
 * 粗略估算输出体积（仅供提前提示，不作任何保证）。
 * 经验取值：截图类长图 PNG 约 0.3~1 字节/像素，照片类更大，这里统一按 1 字节/像素估。
 */
export function estimateOutputBytes({ canvasW = 0, canvasH = 0 } = {}) {
  const px = Math.max(0, Math.round(Number(canvasW) || 0)) * Math.max(0, Math.round(Number(canvasH) || 0));
  return Math.round(px);
}