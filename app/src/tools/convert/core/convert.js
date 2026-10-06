// 工具：图片格式转换 —— 转换规则与各格式编码实现
// 目标与范围见 spec/modules/image-convert.md
// 说明：PNG/JPG 走 shared/imageio.js 的内核编码；WebP 用内核 OffscreenCanvas.convertToBlob；
//       BMP/ICO 走本目录 encoders.js（自研结构）；TIFF/GIF/AVIF 走 ffmpeg 加装包。
import { encodeBmp, encodeIco, pickIcoSizes } from './encoders.js';

/** 可选输出格式（界面下拉用；顺序即界面顺序） */
export const TARGETS = [
  { value: 'png', ext: '.png', label: 'PNG（无损，保留透明）' },
  { value: 'jpg', ext: '.jpg', label: 'JPG（照片体积小，不支持透明）' },
  { value: 'webp', ext: '.webp', label: 'WebP（体积通常最小，保留透明）' },
  { value: 'bmp', ext: '.bmp', label: 'BMP（32 位，保留透明，体积大）' },
  { value: 'ico', ext: '.ico', label: 'ICO（多尺寸图标，保留透明）' },
  { value: 'tif', ext: '.tif', label: 'TIFF（LZW 压缩，需 ffmpeg）' },
  { value: 'gif', ext: '.gif', label: 'GIF（静态单帧，需 ffmpeg）' },
  { value: 'avif', ext: '.avif', label: 'AVIF（体积最小，需 ffmpeg）' }
];

/** 老图片格式（v2.13.0）：Chromium 内核解不了，解码走随包 ffmpeg 出首帧 PNG 再进 canvas。
 *  解码器已逐一用随包 ffmpeg 验证在位：tiff / pcx / targa(tga) / psd / dds / jpeg2000(jp2·j2k) */
export const FFMPEG_DECODE_EXTS = ['tif', 'tiff', 'pcx', 'tga', 'psd', 'dds', 'jp2', 'j2k'];
/** 拖入 / 选择时认可的输入扩展名（HEIC/HEIF/HIF 经主进程 libheif 引擎解码，见 shared/heic.js） */
export const INPUT_EXTS = [
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'avif', 'svg', 'heic', 'heif', 'hif',
  ...FFMPEG_DECODE_EXTS
];
/** 手机拍照格式：解码走主进程 HEIC 引擎（Chromium 内核解不了，见 spec/modules/image-convert.md） */
export const HEIF_EXTS = ['heic', 'heif', 'hif'];
/** 解码失败的统一提示 */
export const DECODE_FAIL_MESSAGE = '解码失败：文件已损坏或格式不支持';

/** 按 value 取格式信息；未知值回落到 PNG */
export function targetInfo(value) {
  return TARGETS.find((t) => t.value === value) || TARGETS[0];
}

/** 该格式是否依赖 ffmpeg 加装包 */
export function needsFfmpeg(value) {
  return value === 'tif' || value === 'gif' || value === 'avif';
}

/** 该格式是否有「画质」选项 */
export function hasQuality(value) {
  return value === 'jpg' || value === 'webp' || value === 'avif';
}

/** 各格式的默认画质（JPG 90 / WebP 85 / AVIF 30，与规格一致） */
export function defaultQuality(value) {
  if (value === 'webp') return 85;
  if (value === 'avif') return 30;
  return 90;
}

/**
 * 限制最长边（只缩小不放大；maxEdge 为空 / 不大于当前最长边时原样返回）
 * @returns {{width: number, height: number, scaled: boolean}}
 */
export function fitLongEdge(width, height, maxEdge) {
  const max = Math.max(width, height);
  if (!maxEdge || maxEdge <= 0 || max <= maxEdge) return { width, height, scaled: false };
  const k = maxEdge / max;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), scaled: true };
}

/**
 * 把透明像素按底色混合（JPG 不支持透明；alpha=255 时像素原样返回）
 * @param {Uint8ClampedArray} pixels RGBA
 * @param {{r: number, g: number, b: number}} color 底色
 * @returns {Uint8ClampedArray}
 */
export function flattenOnColor(pixels, color) {
  const out = new Uint8ClampedArray(pixels.length);
  const { r, g, b } = color;
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3] / 255;
    out[i] = pixels[i] * a + r * (1 - a);
    out[i + 1] = pixels[i + 1] * a + g * (1 - a);
    out[i + 2] = pixels[i + 2] * a + b * (1 - a);
    out[i + 3] = 255;
  }
  return out;
}

/** 高质量重采样（降尺寸 / 放大都用它） */
export function resizePixels(pixels, width, height, targetWidth, targetHeight) {
  const src = new OffscreenCanvas(width, height);
  src.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  const dst = new OffscreenCanvas(targetWidth, targetHeight);
  const dctx = dst.getContext('2d', { willReadFrequently: true });
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(src, 0, 0, targetWidth, targetHeight);
  return dctx.getImageData(0, 0, targetWidth, targetHeight).data;
}

/**
 * WebP 编码（内核支持，但 shared/imageio.js 只封装了 png/jpg，所以在这里补一个）
 * @param {Uint8ClampedArray} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} quality 1~100
 * @returns {Promise<Uint8Array>}
 */
export async function encodeWebp(pixels, width, height, quality = 85) {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  const blob = await canvas.convertToBlob({
    type: 'image/webp',
    quality: Math.max(0, Math.min(100, quality)) / 100
  });
  if (!blob || blob.type !== 'image/webp') throw new Error('当前内核不支持 WebP 编码');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 生成某个尺寸的图标 PNG：等比缩放到 size×size 内并居中，四周留透明边（保持比例不变形）
 * @returns {Promise<Uint8Array>} PNG 字节
 */
export async function makeIconPng(pixels, width, height, size) {
  const k = Math.min(size / width, size / height);
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));

  const src = new OffscreenCanvas(width, height);
  src.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  const dst = new OffscreenCanvas(size, size);
  const dctx = dst.getContext('2d');
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(src, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);

  const blob = await dst.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 组 ICO：按原图尺寸挑尺寸集 → 每个尺寸渲染成 PNG → 封装
 * @returns {Promise<Uint8Array>}
 */
export async function encodeIcon(pixels, width, height) {
  const sizes = pickIcoSizes(width, height);
  const list = [];
  for (const size of sizes) {
    list.push({ width: size, height: size, bytes: await makeIconPng(pixels, width, height, size) });
  }
  return encodeIco(list);
}

/** 老图片格式解码参数（与 shared/ffmpeg.js 的 transformFileToBytes 搭配：出首帧 PNG） */
export function ffmpegDecodeArgs() {
  return ['-frames:v', '1'];
}

/**
 * ffmpeg 参数（与 shared/ffmpeg.js 的 transformImageBytes 搭配使用）
 * @param {'tif'|'gif'|'avif'} value
 * @param {number} quality AVIF 用（作为 CRF，AV1 取值 0~63）
 * @returns {string[]}
 */
export function ffmpegArgs(value, quality) {
  if (value === 'tif') return ['-c:v', 'tiff', '-compression_algo', 'lzw'];
  if (value === 'gif') return ['-frames:v', '1', '-loop', '0', '-f', 'gif'];
  if (value === 'avif') {
    const crf = Math.max(0, Math.min(63, Math.round(Number(quality) || defaultQuality('avif'))));
    return ['-c:v', 'libaom-av1', '-crf', String(crf), '-still-picture', '1', '-f', 'avif'];
  }
  throw new Error('不需要 ffmpeg 的格式');
}

/** 输出文件名：ICO 加 `_icon` 后缀，避免与同名文件混淆；其余用原名 */
export function outputBaseName(baseName, value) {
  return value === 'ico' ? `${baseName}_icon` : baseName;
}

export { encodeBmp, encodeIco, pickIcoSizes };