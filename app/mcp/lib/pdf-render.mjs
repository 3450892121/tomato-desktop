// MCP 侧的 PDF 渲染（pdfjs legacy 构建 + @napi-rs/canvas）
//
// 为什么用 legacy 构建：pdfjs 的浏览器构建在 Node 里会踩 `Promise.try is not a function`，
// legacy 构建 + 下面几个 polyfill 才能在 Node 里渲染。实测能出 PNG（见 tests/mcp.test.mjs）。
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';

// pdfjs 在 Node 里需要的浏览器全局对象
globalThis.DOMMatrix = globalThis.DOMMatrix || DOMMatrix;
globalThis.ImageData = globalThis.ImageData || ImageData;
globalThis.Path2D = globalThis.Path2D || Path2D;
if (typeof Promise.try !== 'function') {
  Promise.try = (fn, ...args) => new Promise((resolve) => resolve(fn(...args)));
}

let pdfjsPromise = null;
function getPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      '../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url
    ).href;
    return pdfjs;
  });
  return pdfjsPromise;
}

/**
 * 打开 PDF
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {{password?: string}} [options]
 */
export async function openPdfNode(bytes, options = {}) {
  const pdfjs = await getPdfjs();
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes).slice();
  const task = pdfjs.getDocument({
    data,
    cMapUrl: new URL('../../node_modules/pdfjs-dist/cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href,
    password: options.password || undefined
  });
  try {
    return await task.promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') throw new Error('这个 PDF 有打开密码，需要先输入密码。');
    if (err && err.name === 'InvalidPDFException') throw new Error('文件不是有效的 PDF（或已损坏）。');
    throw new Error(`打开 PDF 失败：${(err && err.message) || err}`);
  }
}

/** 渲染一页为 Canvas */
export async function renderPdfPage(pdf, pageNumber, { scale = 2 } = {}) {
  const page = await pdf.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return { canvas, width, height, viewport };
  } finally {
    page.cleanup();
  }
}

/** 释放 PDF */
export async function closePdfNode(pdf) {
  try {
    if (pdf && pdf.loadingTask && typeof pdf.loadingTask.destroy === 'function') await pdf.loadingTask.destroy();
    else if (pdf && typeof pdf.cleanup === 'function') pdf.cleanup();
  } catch { /* 已释放 */ }
}
