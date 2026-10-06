// PDF 通用操作（跨工具复用，放 shared/）
// 使用方：「PDF 编辑整理」（pdf-edit）与「文字识别」（ocr）——两者都需要「把 PDF 压小」，
//         而项目约定工具之间禁止互相 import，所以放在共享层。
// 实现方式：用 pdfjs 把每页渲染成位图 → 按档位重新编码（JPG）→ 用 pdf-lib 重新装箱。
//         这是「扫描件 PDF」唯一有效的压缩路径：扫描件的体积几乎全是页面位图，
//         重压位图才能真正瘦身（对原生文字版 PDF 会让文字变成图片，故界面需明确提示）。
//
// 分层说明：本文件自带一份最小的 pdfjs 装配（不 import 任何工具目录）——shared 是最底层，
//         不能反向依赖 tools/。渲染管线与「PDF 转格式」工具同源，但各自独立维护。
import { PDFDocument } from '../../node_modules/pdf-lib/dist/pdf-lib.esm.js';
import * as pdfjsLib from '../../node_modules/pdfjs-dist/build/pdf.mjs';

const PDFJS_ROOT = new URL('../../node_modules/pdfjs-dist/', import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.mjs', PDFJS_ROOT).href;
const CMAP_URL = new URL('cmaps/', PDFJS_ROOT).href;
const STANDARD_FONT_DATA_URL = new URL('standard_fonts/', PDFJS_ROOT).href;

/** pdfjs 版本（自检输出用） */
export const PDFJS_VERSION = pdfjsLib.version;

/**
 * 打开 PDF（与 PDF 工具同一套错误文案，保证用户看到一致的提示）
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {string} [password]
 * @returns {Promise<object>} pdfjs 的 PDFDocumentProxy
 */
export async function openPdfDoc(bytes, password) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // pdfjs 会把 data 的底层 ArrayBuffer 转移给 worker，先复制一份，保证调用方字节仍可复用
  const task = pdfjsLib.getDocument({
    data: src.slice(),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    password: password || undefined
  });
  try {
    return await task.promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') throw new Error('这个 PDF 有打开密码，需要先输入密码。');
    if (err && err.name === 'InvalidPDFException') throw new Error('文件不是有效的 PDF（或已损坏）。');
    throw new Error(`打开 PDF 失败：${(err && err.message) || err}`);
  }
}

/**
 * 渲染指定页为 RGBA 像素
 * @param {object} pdf PDFDocumentProxy
 * @param {number} pageNumber 页码（1 起）
 * @param {{scale?: number}} [options] scale=1 约 72DPI
 */
export async function renderPdfPage(pdf, pageNumber, { scale = 2 } = {}) {
  const page = await pdf.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    await page.render({ canvas, viewport }).promise;
    const imageData = context.getImageData(0, 0, width, height);
    return { pixels: imageData.data, width, height, viewport };
  } finally {
    page.cleanup();
  }
}

/** 压缩档位（数值是渲染倍率，与 PDF 工具的「清晰度档」同一套语义：1× ≈ 72 DPI、2× ≈ 144 DPI、3× ≈ 216 DPI） */
export const PDF_COMPRESS_PRESETS = [
  { value: 'light', label: '轻度（保持清晰，1.5×）', scale: 1.5, quality: 82 },
  { value: 'standard', label: '标准（推荐，1.2×）', scale: 1.2, quality: 72 },
  { value: 'strong', label: '强力（明显变小，1.0×）', scale: 1.0, quality: 60 },
  { value: 'extreme', label: '极限（很小，0.75×）', scale: 0.75, quality: 45 }
];

/** 取档位配置；未知档位退回「标准」 */
export function presetOf(value) {
  return PDF_COMPRESS_PRESETS.find((p) => p.value === value) || PDF_COMPRESS_PRESETS[1];
}

/** 灰度化像素（就地改写）：扫描件多为黑白文档，灰度能再省一截 */
function toGrayscale(pixels) {
  for (let i = 0; i < pixels.length; i += 4) {
    // 0.2126/0.7152/0.0722 为 ITU-R BT.709 亮度权重
    const g = Math.round(0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]);
    pixels[i] = g;
    pixels[i + 1] = g;
    pixels[i + 2] = g;
  }
  return pixels;
}

/** 像素 → JPEG 字节（走 Chromium 编码器；质量 0~100） */
async function encodeJpeg(pixels, width, height, quality) {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 压缩 PDF
 * @param {Uint8Array|ArrayBuffer} bytes PDF 字节
 * @param {{preset?: string, grayscale?: boolean, maxMB?: number, pages?: number[], password?: string,
 *          onProgress?: (done:number, total:number)=>void, shouldCancel?: ()=>boolean}} [options]
 *   preset：压缩档位（见 PDF_COMPRESS_PRESETS）
 *   grayscale：是否转灰度（黑白文档更省体积）
 *   maxMB：目标体积（MB，0/缺省表示不设目标）；设了目标时先按档位压，**仍超标就自动降一档重来**（最多降到最低档）
 *   pages：只处理这些页（1 基页码数组，缺省＝全部）；输出 PDF 只包含这些页
 * @returns {Promise<{bytes: Uint8Array, originalBytes: number, pages: number, scale: number, quality: number,
 *                    preset: string, grayscale: boolean, attempts: number, cancelled: boolean}>}
 */
export async function compressPdf(bytes, options = {}) {
  const src = await openPdfDoc(bytes, options.password || '');
  try {
    return await compressPdfWithDoc(src, bytes, options);
  } finally {
    await releasePdfDoc(src);
  }
}

/**
 * 释放 pdfjs 文档。不释放的话页面与字体缓存会留在 worker 侧只涨不落，
 * 批量压缩几十个 PDF 的长批次可能 OOM（pdf-edit 的 closePdfDoc 只管它自己打开的那些）。
 * 与 pdf-edit/core/ops.js 的同名逻辑一致：pdfjs 6 起 PDFDocumentProxy 上不再有 destroy()，
 * 要经 loadingTask.destroy()。（shared 不能反向 import 工具目录，所以这里各自实现。）
 */
async function releasePdfDoc(doc) {
  try {
    if (!doc) return;
    if (typeof doc.destroy === 'function') await doc.destroy();
    else if (doc.loadingTask && typeof doc.loadingTask.destroy === 'function') await doc.loadingTask.destroy();
  } catch { /* 已经释放过了 */ }
}

/** 源文档已打开后的压缩主流程；文档由 compressPdf 负责释放，这里不要动它 */
async function compressPdfWithDoc(src, bytes, options) {
  const { grayscale = false, maxMB = 0, pages = null, onProgress, shouldCancel } = options;
  const originalBytes = (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).length;

  // 档位序列：从用户选的档位开始，若设了目标体积则依次降档重试
  const preset = presetOf(options.preset);
  const order = PDF_COMPRESS_PRESETS.map((p) => p.value);
  const startIdx = Math.max(0, order.indexOf(preset.value));
  const ladder = PDF_COMPRESS_PRESETS.slice(startIdx);

  const totalPages = src.numPages;
  const targets = Array.isArray(pages) && pages.length
    ? pages.filter((n) => Number.isInteger(n) && n >= 1 && n <= totalPages)
    : Array.from({ length: totalPages }, (_, i) => i + 1);

  let attempt = 0;
  let lastResult = null;

  for (const cfg of ladder) {
    attempt += 1;
    const out = await PDFDocument.create();
    let done = 0;
    for (const pageNo of targets) {
      if (shouldCancel && shouldCancel()) {
        return { ...(lastResult || {}), cancelled: true, attempts: attempt - 1 };
      }
      const rendered = await renderPdfPage(src, pageNo, { scale: cfg.scale });
      let pixels = rendered.pixels;
      if (grayscale) pixels = toGrayscale(pixels);
      const jpgBytes = await encodeJpeg(pixels, rendered.width, rendered.height, cfg.quality);

      // 页面尺寸按「原页面的显示尺寸」建，保证打印比例不变
      const img = await out.embedJpg(jpgBytes);
      const p = out.addPage([rendered.viewport.width, rendered.viewport.height]);
      p.drawImage(img, { x: 0, y: 0, width: rendered.viewport.width, height: rendered.viewport.height });

      done += 1;
      if (onProgress) onProgress(done, targets.length);
    }
    const outBytes = await out.save();
    lastResult = {
      bytes: outBytes,
      originalBytes,
      pages: targets.length,
      scale: cfg.scale,
      quality: cfg.quality,
      preset: cfg.value,
      grayscale,
      attempts: attempt,
      cancelled: false
    };

    // 没设目标体积，或已经达标 → 收工
    if (!maxMB || outBytes.length <= maxMB * 1024 * 1024) break;
    // 已到最低档还超标 → 如实返回（不再降）
    if (cfg === ladder[ladder.length - 1]) break;
  }

  return lastResult;
}