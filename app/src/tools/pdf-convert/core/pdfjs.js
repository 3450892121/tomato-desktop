// PDF 读取与页面渲染（「PDF 转格式」工具核心能力）
// 实现说明：
//  - 本项目没有打包器，界面进程（浏览器环境）无法解析裸模块名，因此直接用相对路径
//    引用 node_modules 里的 pdfjs ESM 构建产物；打包时由 tools/pack.js 把 pdfjs-dist
//    复制到 resources/app/node_modules/ 下，保证绿色版里同样的相对路径依然成立。
//  - 中文等 CID 字体的 PDF 需要外部 cmaps / 标准字体数据，这里指向随包的离线副本。
//  - 渲染用真实 <canvas>（pdfjs 6 的 canvas 参数要求 DOM canvas），像素再交给 shared/imageio 编码。
import * as pdfjsLib from '../../../../node_modules/pdfjs-dist/build/pdf.mjs';

const PDFJS_ROOT = new URL('../../../../node_modules/pdfjs-dist/', import.meta.url);

// 解析线程：worker 与主构建同目录（打包后相对关系保持不变）
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.mjs', PDFJS_ROOT).href;

const CMAP_URL = new URL('cmaps/', PDFJS_ROOT).href;
const STANDARD_FONT_DATA_URL = new URL('standard_fonts/', PDFJS_ROOT).href;

/** pdfjs 版本（自检输出用） */
export const PDFJS_VERSION = pdfjsLib.version;

/**
 * 打开 PDF 文档
 * @param {ArrayBuffer|Uint8Array} bytes PDF 文件字节
 * @param {string} [password] 加密 PDF 的打开密码
 * @returns {Promise<object>} pdfjs 的 PDFDocumentProxy
 */
export async function openPdf(bytes, password) {
  // 重要：pdfjs 会把 data 的底层 ArrayBuffer 转移（transfer）给 worker，原数组随即失效。
  // 这里先复制一份，保证调用方传入的字节仍可复用（同一份 PDF 常要「渲染 + 结构操作」多处使用）。
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const data = src.slice();
  const task = pdfjsLib.getDocument({
    data,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    password: password || undefined
  });
  try {
    return await task.promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') {
      throw new Error('这个 PDF 有打开密码，需要先输入密码。');
    }
    if (err && err.name === 'InvalidPDFException') {
      throw new Error('文件不是有效的 PDF（或已损坏）。');
    }
    throw new Error(`打开 PDF 失败：${(err && err.message) || err}`);
  }
}

/**
 * 渲染指定页为 RGBA 像素
 * @param {object} pdf PDFDocumentProxy
 * @param {number} pageNumber 页码（1 起）
 * @param {{scale?: number}} [options] scale=1 约 72DPI，2 约 144DPI，3 约 216DPI
 * @returns {Promise<{pixels: Uint8ClampedArray, width: number, height: number}>}
 */
export async function renderPageToPixels(pdf, pageNumber, { scale = 2 } = {}) {
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
    return { pixels: imageData.data, width, height };
  } finally {
    page.cleanup();
  }
}