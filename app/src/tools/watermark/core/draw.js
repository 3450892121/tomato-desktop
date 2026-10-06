// 工具：加水印 —— 水印绘制核心
// 分层：位置 / 字号 / 文本测量等纯计算可在 node 里单测；
//       像素绘制依赖内核 Canvas（OffscreenCanvas / HTMLCanvasElement），不引入任何第三方图像库。
// 规则：水印一律画在原图之上（不裁剪原图、不改尺寸）。

/** 水印位置：九宫格 + 平铺（界面按钮与坐标计算共用同一份定义） */
export const WATERMARK_POSITIONS = [
  { value: 'top-left', label: '左上' },
  { value: 'top-center', label: '上中' },
  { value: 'top-right', label: '右上' },
  { value: 'middle-left', label: '左中' },
  { value: 'center', label: '居中' },
  { value: 'middle-right', label: '右中' },
  { value: 'bottom-left', label: '左下' },
  { value: 'bottom-center', label: '下中' },
  { value: 'bottom-right', label: '右下' },
  { value: 'tile', label: '平铺' }
];

/** 默认参数（界面与测试共用） */
export const WATERMARK_DEFAULTS = {
  type: 'text',                 // 'text' 文字水印 / 'image' 图片水印
  text: '',                     // 文字内容（可含换行）
  position: 'bottom-right',     // 九宫格值或 'tile'
  sizePercent: 6,               // 文字水印 = 字号占图宽百分比；图片水印 = 印章宽占图宽百分比
  opacity: 80,                  // 透明度（0~100）
  rotation: 0,                  // 旋转角度（度，绕水印自身中心）
  color: '#ffffff',             // 文字填充色
  stroke: true,                 // 文字描边（浅色背景也能看清）
  strokeColor: '#000000',       // 描边颜色（界面按填充色自动取对比色）
  strokeWidthPercent: 6,        // 描边宽度占字号百分比
  marginPercent: 4,             // 九宫格边距占「短边」百分比
  tileGapRatio: 0.6,            // 平铺间距占单个水印尺寸的比例
  format: 'png',                // 'png' | 'jpg'
  quality: 92                   // JPG 画质（1~100）
};

/** 文字水印字体族（与界面显示一致，避免测量与绘制不一致） */
export const TEXT_FONT_FAMILY = '"Microsoft YaHei", "Segoe UI", "PingFang SC", Arial, sans-serif';
/** 平铺数量上限：极小间距会生成海量水印，这里兜底防止卡死 */
const MAX_TILE_ITEMS = 4000;

function toNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 透明度归一化：界面传 0~100，绘制用 0~1（已传入 0~1 的原样接受） */
function normalizeOpacity(value) {
  const n = toNum(value, 1);
  return clamp(n > 1 ? n / 100 : n, 0, 1);
}

/**
 * 九宫格定位：返回水印外接矩形左上角坐标（平铺返回 null）
 * 纯函数，可直接单测。
 * @param {{canvasW:number, canvasH:number, itemW:number, itemH:number, position:string, margin?:number}} cfg
 * @returns {{x:number, y:number}|null}
 */
export function anchorRect({ canvasW, canvasH, itemW, itemH, position, margin = 0 }) {
  if (position === 'tile') return null;
  const known = WATERMARK_POSITIONS.some((p) => p.value === position);
  const pos = known ? position : 'center'; // 未知取值回落到居中，保证不会画出画布
  const m = Math.max(0, toNum(margin, 0));

  const rawX = pos.endsWith('-left') ? m
    : pos.endsWith('-right') ? canvasW - itemW - m
      : (canvasW - itemW) / 2;
  const rawY = pos.startsWith('top') ? m
    : pos.startsWith('bottom') ? canvasH - itemH - m
      : (canvasH - itemH) / 2;
  return { x: Math.round(rawX), y: Math.round(rawY) };
}

/**
 * 平铺坐标：从左上角开始按「单个水印尺寸 + 间距」逐格铺满整张图
 * 纯函数，可直接单测。
 * @param {{canvasW:number, canvasH:number, itemW:number, itemH:number, gapX?:number, gapY?:number}} cfg
 * @returns {{x:number, y:number}[]}
 */
export function tilePositions({ canvasW, canvasH, itemW, itemH, gapX = 0, gapY = 0 }) {
  const stepX = Math.max(1, Math.round(itemW) + Math.round(toNum(gapX, 0)));
  const stepY = Math.max(1, Math.round(itemH) + Math.round(toNum(gapY, 0)));
  const out = [];
  for (let y = 0; y < canvasH && out.length < MAX_TILE_ITEMS; y += stepY) {
    for (let x = 0; x < canvasW && out.length < MAX_TILE_ITEMS; x += stepX) {
      out.push({ x, y });
    }
  }
  return out;
}

/**
 * 字号按图宽百分比换算：不同尺寸的图片观感一致
 * 纯函数，可直接单测。
 * @param {{canvasW:number, baseSizePercent:number}} cfg
 * @returns {number} 像素字号（至少 8px）
 */
export function computeFontSize({ canvasW, baseSizePercent }) {
  const pct = toNum(baseSizePercent, WATERMARK_DEFAULTS.sizePercent);
  return Math.max(8, Math.round((toNum(canvasW, 0) * pct) / 100));
}

/** 统一换行符并展开制表符，保证「测量宽度」与「实际绘制」用的是同一段文本 */
export function escapeForMeasure(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ');
}

/**
 * 测量文本宽度（会临时设置字体，测完还原）
 * 纯函数（只依赖传入的 ctxlike.measureText），可直接单测。
 * @param {{font?:string, measureText:(t:string)=>{width:number}}} ctxlike
 * @param {string} text
 * @param {string} [font]
 * @returns {number}
 */
export function measureTextWidth(ctxlike, text, font) {
  const prev = ctxlike.font;
  if (font) ctxlike.font = font;
  const width = ctxlike.measureText(escapeForMeasure(text)).width;
  if (font && prev !== undefined) ctxlike.font = prev;
  return width;
}

/** 从 font 字符串里取字号（如 `700 60px "Microsoft YaHei"` → 60） */
export function fontSizeFromFont(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font || ''));
  return m ? Number(m[1]) : 0;
}

/** 解析 #rgb / #rrggbb 为 {r,g,b}；解析不了返回 null */
function parseHexColor(hex) {
  const s = String(hex || '').trim().replace(/^#/, '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}

/**
 * 取与填充色对比明显的描边色：浅色文字配黑边、深色文字配白边
 * 纯函数，可直接单测。
 * @param {string} fillHex 填充色（#rgb / #rrggbb）
 * @returns {string} '#000000' 或 '#ffffff'
 */
export function contrastStrokeColor(fillHex) {
  const rgb = parseHexColor(fillHex);
  if (!rgb) return '#000000';
  const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

/**
 * 绘制文字水印：以 (x, y) 为中心，绕自身中心旋转
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} cfg { text, x, y, font, color, opacity, rotation, stroke, strokeColor, strokeWidth, lineHeight }
 */
export function drawTextWatermark(ctx, cfg = {}) {
  const {
    text = '',
    x = 0,
    y = 0,
    font = '',
    color = WATERMARK_DEFAULTS.color,
    opacity = 1,
    rotation = 0,
    stroke = false,
    strokeColor = WATERMARK_DEFAULTS.strokeColor,
    strokeWidth = 1,
    lineHeight = 0
  } = cfg;

  const lines = escapeForMeasure(text).split('\n');
  const lh = lineHeight > 0 ? lineHeight : fontSizeFromFont(font) * 1.25;

  ctx.save();
  ctx.globalAlpha = normalizeOpacity(opacity);
  ctx.translate(x, y);
  if (rotation) ctx.rotate((toNum(rotation, 0) * Math.PI) / 180);
  if (font) ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const startY = -((lines.length - 1) * lh) / 2;
  for (let i = 0; i < lines.length; i += 1) {
    const yy = startY + i * lh;
    if (stroke && strokeWidth > 0) {
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.strokeStyle = strokeColor;
      ctx.strokeText(lines[i], 0, yy);
    }
    ctx.fillStyle = color;
    ctx.fillText(lines[i], 0, yy);
  }
  ctx.restore();
  return lines.length;
}

/**
 * 绘制图片水印（印章 / LOGO）：以 (x, y) 为中心，绕自身中心旋转
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} cfg { bitmap, x, y, width, height, opacity, rotation }
 */
export function drawImageWatermark(ctx, cfg = {}) {
  const { bitmap, x = 0, y = 0, width = 0, height = 0, opacity = 1, rotation = 0 } = cfg;
  if (!bitmap || width <= 0 || height <= 0) return false;

  ctx.save();
  ctx.globalAlpha = normalizeOpacity(opacity);
  ctx.translate(x, y);
  if (rotation) ctx.rotate((toNum(rotation, 0) * Math.PI) / 180);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, -width / 2, -height / 2, width, height);
  ctx.restore();
  return true;
}

/**
 * 按平铺坐标逐个绘制
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} cfg 位置参数（可直接交给 tilePositions）或显式 { positions }
 * @param {(ctx:CanvasRenderingContext2D, x:number, y:number)=>void} drawOne 单个水印的绘制回调
 * @returns {number} 绘制个数
 */
export function drawTiled(ctx, cfg, drawOne) {
  const positions = Array.isArray(cfg.positions) ? cfg.positions : tilePositions(cfg);
  let n = 0;
  for (const p of positions) {
    drawOne(ctx, p.x, p.y);
    n += 1;
  }
  return n;
}

/** 建画布（内核优先用 OffscreenCanvas；浏览器环境退化为 <canvas>） */
function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** 画布编码成 blob（兼容 OffscreenCanvas.convertToBlob 与 HTMLCanvasElement.toBlob） */
function encodeCanvas(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('画布编码失败'))), type, quality);
  });
}

/** 按位置绘制单个水印：平铺走 tilePositions，其余走 anchorRect（坐标为水印外接矩形左上角） */
function placeWatermarks(ctx, { canvasW, canvasH, itemW, itemH, position, margin, tileGapRatio }, drawOne) {
  if (position === 'tile') {
    const gapX = Math.round(itemW * toNum(tileGapRatio, WATERMARK_DEFAULTS.tileGapRatio));
    const gapY = Math.round(itemH * toNum(tileGapRatio, WATERMARK_DEFAULTS.tileGapRatio));
    return drawTiled(ctx, { canvasW, canvasH, itemW, itemH, gapX, gapY }, drawOne);
  }
  const rect = anchorRect({ canvasW, canvasH, itemW, itemH, position, margin });
  drawOne(ctx, rect.x, rect.y);
  return 1;
}

/**
 * 给一张原图加水印：建同尺寸画布 → 画原图 → 叠加水印 → 编码
 * @param {{bitmap: (ImageBitmap|HTMLCanvasElement|OffscreenCanvas), config?: object}} input
 * @returns {Promise<{blob: Blob, width: number, height: number, type: string}>}
 */
export async function renderWatermark({ bitmap, config = {} }) {
  if (!bitmap || !bitmap.width || !bitmap.height) throw new Error('renderWatermark：缺少有效的原图');

  const cfg = { ...WATERMARK_DEFAULTS, ...config };
  const width = bitmap.width;
  const height = bitmap.height;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);

  const opacity = cfg.opacity;
  const rotation = toNum(cfg.rotation, 0);
  const margin = Math.max(0, Math.round((Math.min(width, height) * clamp(toNum(cfg.marginPercent, WATERMARK_DEFAULTS.marginPercent), 0, 25)) / 100));

  if (cfg.type === 'image') {
    const stamp = cfg.stamp;
    if (!stamp || !stamp.bitmap || !stamp.width || !stamp.height) throw new Error('图片水印：请先选择印章图片');
    const dw = Math.max(1, Math.round((width * clamp(toNum(cfg.sizePercent, WATERMARK_DEFAULTS.sizePercent), 1, 100)) / 100));
    const dh = Math.max(1, Math.round((dw * stamp.height) / stamp.width));
    placeWatermarks(ctx, { canvasW: width, canvasH: height, itemW: dw, itemH: dh, position: cfg.position, margin, tileGapRatio: cfg.tileGapRatio },
      (c, x, y) => drawImageWatermark(c, {
        bitmap: stamp.bitmap, x: x + dw / 2, y: y + dh / 2, width: dw, height: dh, opacity, rotation
      }));
  } else {
    const fontSize = computeFontSize({ canvasW: width, baseSizePercent: cfg.sizePercent });
    const font = `700 ${fontSize}px ${TEXT_FONT_FAMILY}`;
    const text = escapeForMeasure(cfg.text);
    if (!text.trim()) throw new Error('文字水印：请输入水印文字');
    const lineHeight = fontSize * 1.25;
    ctx.font = font;
    const lines = text.split('\n');
    const itemW = Math.max(1, Math.ceil(Math.max(...lines.map((l) => measureTextWidth(ctx, l)))));
    const itemH = Math.max(1, Math.ceil(lineHeight * lines.length));
    const strokeWidth = Math.max(1, Math.round((fontSize * clamp(toNum(cfg.strokeWidthPercent, WATERMARK_DEFAULTS.strokeWidthPercent), 0, 50)) / 100));
    placeWatermarks(ctx, { canvasW: width, canvasH: height, itemW, itemH, position: cfg.position, margin, tileGapRatio: cfg.tileGapRatio },
      (c, x, y) => drawTextWatermark(c, {
        text, x: x + itemW / 2, y: y + itemH / 2, font, color: cfg.color, opacity, rotation,
        stroke: !!cfg.stroke, strokeColor: cfg.strokeColor, strokeWidth, lineHeight
      }));
  }

  const format = cfg.format === 'jpg' || cfg.format === 'jpeg' ? 'jpg' : 'png';
  if (format === 'jpg') {
    // JPG 不支持透明：在已有内容之下补一层白底，避免内核按黑色合成
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  const type = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const blob = await encodeCanvas(canvas, type, clamp(toNum(cfg.quality, WATERMARK_DEFAULTS.quality), 1, 100) / 100);
  if (!blob) throw new Error('水印结果编码失败');
  return { blob, width, height, type };
}