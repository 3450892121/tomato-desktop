// MCP 侧 Canvas 小工具（Node 环境，用 @napi-rs/canvas）
// 作用：把 GUI 里依赖 OffscreenCanvas 的像素管线，在 Node 里用等价方式重实现。
import fsp from 'node:fs/promises';
import { createCanvas, loadImage, ImageData } from '@napi-rs/canvas';

/** RGBA → Canvas */
export function pixelsToCanvas(pixels, width, height) {
  if (!pixels || pixels.length !== width * height * 4) throw new Error('像素缓冲长度与尺寸不匹配');
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas;
}

/** Canvas → RGBA */
export function canvasToPixels(canvas) {
  const ctx = canvas.getContext('2d');
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Canvas → 图片字节（png/jpg/webp） */
export function canvasToBuffer(canvas, format = 'png', quality = 92) {
  const q = Math.max(1, Math.min(100, Number(quality) || 92));
  if (format === 'jpg' || format === 'jpeg') return canvas.toBuffer('image/jpeg', q);
  if (format === 'webp') return canvas.toBuffer('image/webp', q);
  return canvas.toBuffer('image/png');
}

/** 图片文件 → Canvas（PNG/JPG/WebP/GIF 首帧/BMP） */
export async function loadCanvas(file) {
  let img;
  try {
    img = await loadImage(await fsp.readFile(file));
  } catch {
    throw new Error(`解码图片失败：${file}（MCP 这批支持 PNG/JPG/WebP/GIF/BMP；其它格式请先用图片格式转换）`);
  }
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return canvas;
}

/** 高质量缩放 RGBA；background 非空时先铺底色（JPG 去透明） */
export function resizePixels(pixels, width, height, targetW, targetH, background = null) {
  const src = pixelsToCanvas(pixels, width, height);
  const out = createCanvas(targetW, targetH);
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

/** 高斯模糊（用 Skia 的 ctx.filter；与 GUI 的 `ctx.filter = blur(Npx)` 同源） */
export function blurPixels(pixels, width, height, radius) {
  const src = pixelsToCanvas(pixels, width, height);
  const out = createCanvas(width, height);
  const ctx = out.getContext('2d');
  try {
    ctx.filter = `blur(${Math.max(0, Number(radius) || 0)}px)`;
  } catch { /* 旧内核不支持 filter 时退化为不模糊 */ }
  ctx.drawImage(src, 0, 0);
  return canvasToPixels(out);
}
