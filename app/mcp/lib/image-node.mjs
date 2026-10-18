// MCP 侧的图片编解码（Node 环境，用 @napi-rs/canvas）
//
// 为什么不用 src/shared/imageio.js：那个文件跑在浏览器渲染进程里，用的是
// createImageBitmap / OffscreenCanvas，Node 里没有。这里用同一套语义
// （RGBA 像素 + 宽高）在 Node 里重实现，保证混淆等 core 算法拿到的数据形状一致。
//
// 支持范围：PNG / JPG / WebP（实测 @napi-rs/canvas 都能解、都能编）。
// HEIC / AVIF / TIFF / PSD 等冷门格式不在这里处理——它们要靠随包 ffmpeg / libheif，
// 属于后续批次的「图片格式转换」工具。
import fsp from 'node:fs/promises';
import { createCanvas, loadImage, ImageData } from '@napi-rs/canvas';

/** 与 GUI 侧一致：4000 万像素上限，超过明确报错而不是吃光内存 */
const MAX_PIXELS = 40_000_000;

function tooLarge(width, height) {
  return width * height > MAX_PIXELS;
}

/**
 * 图片字节 → RGBA
 * @param {Buffer|Uint8Array} bytes
 * @returns {Promise<{pixels: Uint8ClampedArray, width: number, height: number}>}
 */
export async function decodeImageBytes(bytes) {
  let img;
  try {
    img = await loadImage(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  } catch {
    throw new Error('解码图片失败：MCP 这批只支持 PNG / JPG / WebP（HEIC、AVIF、TIFF 等请等「图片格式转换」批次）');
  }
  const width = img.width;
  const height = img.height;
  if (!width || !height) throw new Error('解码图片失败：宽或高为 0');
  if (tooLarge(width, height)) {
    throw new Error(`图片过大（${width}×${height}，超过 ${MAX_PIXELS / 1_000_000} 万像素上限）`);
  }
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { pixels: ctx.getImageData(0, 0, width, height).data, width, height };
}

/** 图片文件 → RGBA */
export async function decodeImageFile(filePath) {
  return decodeImageBytes(await fsp.readFile(filePath));
}

/**
 * RGBA → 图片字节
 * @param {Uint8ClampedArray} pixels
 * @param {number} width
 * @param {number} height
 * @param {'png'|'jpg'|'webp'} format
 * @param {number} [quality] 1~100（JPG / WebP 有效）
 * @returns {Buffer}
 */
export function encodeImageBytes(pixels, width, height, format = 'png', quality = 92) {
  if (!pixels || pixels.length !== width * height * 4) {
    throw new Error('像素缓冲长度与尺寸不匹配');
  }
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  const q = Math.max(1, Math.min(100, Number(quality) || 92));
  if (format === 'jpg') return canvas.toBuffer('image/jpeg', q);
  if (format === 'webp') return canvas.toBuffer('image/webp', q);
  return canvas.toBuffer('image/png');
}

/** 把图片字节存盘（由调用方先分配好不重名的路径） */
export async function writeImageBytes(target, pixels, width, height, format, quality) {
  await fsp.writeFile(target, encodeImageBytes(pixels, width, height, format, quality));
  return target;
}
