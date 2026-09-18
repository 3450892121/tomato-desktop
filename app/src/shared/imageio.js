// 图片读写（共享能力）
// 放在 shared/ 的原因：未来「图片压缩」等工具也会用到同一套解码/编码能力。
// 实现说明：本文件运行在界面进程（渲染进程），使用系统内核自带的图片解码/编码能力
//          （createImageBitmap / OffscreenCanvas），不引入任何第三方图像库。
// 目标与规则见 spec/modules/imageio.md。

/** 像素总量上限（4000 万像素 ≈ 160MB RGBA 缓冲），超过则明确提示而不是崩溃 */
const MAX_PIXELS = 40_000_000;

/**
 * 解码图片字节为 RGBA 像素缓冲
 * @param {ArrayBuffer|Uint8Array} bytes 图片文件字节
 * @returns {Promise<{pixels: Uint8ClampedArray, width: number, height: number}>}
 */
export async function decodeImageFromBytes(bytes) {
  const blob = new Blob([bytes]);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error('解码图片失败，可能是格式不支持或文件损坏。');
  }

  const { width, height } = bitmap;
  if (width * height > MAX_PIXELS) {
    if (bitmap.close) bitmap.close();
    throw new Error(`图片过大（${width}×${height}，超过 ${MAX_PIXELS / 1_000_000} 万像素上限），已停止处理以免内存不足。`);
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();

  const imageData = ctx.getImageData(0, 0, width, height);
  return { pixels: imageData.data, width, height };
}

/**
 * 编码 RGBA 像素缓冲为图片字节
 * @param {Uint8ClampedArray} pixels
 * @param {number} width
 * @param {number} height
 * @param {{format?: 'png'|'jpg', quality?: number}} [options] quality 为 0~100（仅 JPG 有效）
 * @returns {Promise<Uint8Array>}
 */
export async function encodeImageToBytes(pixels, width, height, options = {}) {
  const { format = 'png', quality = 95 } = options;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);

  const type = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const blob = await canvas.convertToBlob({
    type,
    quality: format === 'jpg' ? Math.max(0, Math.min(100, quality)) / 100 : undefined
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 把像素缓冲画到目标 canvas（用于预览与缩略图，自动适配尺寸）
 * @param {HTMLCanvasElement} canvas
 * @param {Uint8ClampedArray} pixels
 * @param {number} width
 * @param {number} height
 */
export function drawPixelsToCanvas(canvas, pixels, width, height) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
}

/**
 * 生成缩略图数据（等比缩放，最长边为 maxSize）
 * @param {Uint8ClampedArray} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} maxSize
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function makeThumbnail(pixels, width, height, maxSize = 56) {
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));

  const src = new OffscreenCanvas(width, height);
  src.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);

  const thumb = document.createElement('canvas');
  thumb.width = tw;
  thumb.height = th;
  thumb.getContext('2d').drawImage(src, 0, 0, tw, th);
  return thumb;
}