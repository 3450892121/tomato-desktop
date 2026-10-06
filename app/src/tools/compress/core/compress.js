// 工具：图片压缩 —— 业务逻辑（与界面解耦）
// 目标与规则见 spec/modules/image-compress.md。
// 实现说明：运行在界面进程，缩放/编码全部用系统内核的 OffscreenCanvas（不引入任何第三方库）。

/** 输出格式 → MIME（内核能编码的三种） */
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/**
 * 「自动」输出格式：保持原格式语义（PNG→PNG、WebP→WebP、JPG→JPG），其它一律按 JPG（最通用）。
 * 说明：PNG 是无损格式，压不动属正常；界面会提示照片建议选 JPG/WebP。
 */
export function autoFormat(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (e === 'png') return 'png';
  if (e === 'webp') return 'webp';
  return 'jpg';
}

/** 计算目标尺寸（纯函数，可单测）：longestEdge（最长边像素）与 percent（百分比）同时给出时取更小的那个 */
export function computeTargetSize(width, height, { longestEdge = 0, percent = 0 } = {}) {
  let scale = 1;
  if (percent > 0 && percent < 100) scale = percent / 100;
  if (longestEdge > 0) {
    const longest = Math.max(width, height);
    if (longest > longestEdge) scale = Math.min(scale, longestEdge / longest);
  }
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { width: w, height: h, scaled: w !== width || h !== height };
}

/** 把像素缓冲画到目标尺寸的画布（高质量重采样；background 非空时先铺底色，用于 JPG 去透明） */
function drawToCanvas(pixels, width, height, targetW, targetH, background) {
  const src = new OffscreenCanvas(width, height);
  src.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);

  const out = new OffscreenCanvas(targetW, targetH);
  const ctx = out.getContext('2d');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, targetW, targetH);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, targetW, targetH);
  return out;
}

/** 画布 → 字节（quality 仅 JPG / WebP 有效） */
async function canvasToBytes(canvas, format, quality) {
  const blob = await canvas.convertToBlob({
    type: MIME[format] || 'image/jpeg',
    quality: format === 'png' ? undefined : Math.max(1, Math.min(100, quality)) / 100
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 二分画质：在 [20, 95] 里找「不超目标大小」的最高画质；都不达标时返回最小的那份。
 * 返回 { bytes, quality, fits }
 */
async function binarySearchQuality(canvas, format, targetBytes) {
  let smallest = null;
  const probe = async (q) => {
    const bytes = await canvasToBytes(canvas, format, q);
    if (!smallest || bytes.length < smallest.bytes.length) smallest = { bytes, quality: q };
    return bytes;
  };

  const hiBytes = await probe(95);
  if (hiBytes.length <= targetBytes) return { bytes: hiBytes, quality: 95, fits: true };
  const loBytes = await probe(20);
  if (loBytes.length > targetBytes) return { ...smallest, fits: false };

  let best = { bytes: loBytes, quality: 20 };
  let low = 20;
  let high = 95;
  while (low <= high) {
    const mid = Math.round((low + high) / 2);
    const bytes = await probe(mid);
    if (bytes.length <= targetBytes) {
      best = { bytes, quality: mid };
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { ...best, fits: true };
}

/**
 * 压缩单张图（核心入口）
 * @param {Uint8ClampedArray} pixels RGBA 像素
 * @param {number} width
 * @param {number} height
 * @param {{format?: string, quality?: number, longestEdge?: number, percent?: number, targetBytes?: number}} options
 * @returns {Promise<{bytes: Uint8Array, width: number, height: number, format: string, quality: number, note: string}>}
 */
export async function compressPixels(pixels, width, height, options = {}) {
  const format = options.format || 'jpg';
  const quality = options.quality || 82;
  const size = computeTargetSize(width, height, options);
  const background = format === 'jpg' ? '#ffffff' : null; // JPG 无透明通道，白底合成

  let canvas = drawToCanvas(pixels, width, height, size.width, size.height, background);
  let curW = size.width;
  let curH = size.height;

  // 画质优先：一次编码即可
  if (!options.targetBytes) {
    const bytes = await canvasToBytes(canvas, format, quality);
    return { bytes, width: curW, height: curH, format, quality, note: '' };
  }

  // 指定大小：先二分画质，仍超标就按面积比缩边再试（最多 3 轮，避免无意义地越缩越小）
  let last = null;
  for (let round = 0; round < 3; round += 1) {
    const hit = await binarySearchQuality(canvas, format, options.targetBytes);
    last = hit;
    if (hit.fits) {
      return {
        bytes: hit.bytes, width: curW, height: curH, format, quality: hit.quality,
        note: round > 0 ? `为达标已缩至 ${curW}×${curH}` : ''
      };
    }
    if (round === 2) break;
    const ratio = Math.sqrt(options.targetBytes / hit.bytes.length) * 0.98;
    const nw = Math.max(64, Math.round(curW * ratio));
    const nh = Math.max(64, Math.round(curH * ratio));
    if (nw >= curW && nh >= curH) break;
    canvas = drawToCanvas(pixels, width, height, nw, nh, background);
    curW = nw;
    curH = nh;
  }

  return {
    bytes: last.bytes, width: curW, height: curH, format, quality: last.quality,
    note: '已尽量压缩，未能完全达到目标大小'
  };
}