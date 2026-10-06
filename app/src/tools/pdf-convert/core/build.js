// PDF 生成与页面操作：图片→PDF、合并、拆分、提取页（「PDF 转格式」工具核心能力）
// 说明：与 pdfjs.js 相同——无打包器环境，直接相对路径引用 node_modules 里的 pdf-lib ESM 产物；
//       打包时由 tools/pack.js 一并复制。pdf-lib 为纯 JS（MIT），无原生依赖。
import { PDFDocument } from '../../../../node_modules/pdf-lib/dist/pdf-lib.esm.js';

/** A4 尺寸（PDF 点，1pt = 1/72 英寸） */
const A4 = { width: 595.28, height: 841.89 };

/**
 * 判断图片字节类型（决定能否直接嵌入 PDF）
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {'jpg'|'png'|null} 其他格式需要先解码重编码后再嵌入
 */
export function sniffImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  return null;
}

/**
 * 多张图片合成一份 PDF，每张图一页
 * @param {{bytes: Uint8Array, type: 'jpg'|'png'}[]} images 图片列表（顺序即页序）
 * @param {{pageMode?: 'original'|'a4', margin?: number}} [options]
 *        pageMode='original'（默认）按图片原始尺寸建页；'a4' 缩放到 A4 内并居中
 *        margin：页边距（PDF 点，仅 a4 模式生效）
 * @returns {Promise<Uint8Array>}
 */
export async function imagesToPdf(images, options = {}) {
  const { pageMode = 'original', margin = 0 } = options;
  if (!images || images.length === 0) throw new Error('没有可合成 PDF 的图片');
  const doc = await PDFDocument.create();
  for (const img of images) {
    const embedded = img.type === 'jpg' ? await doc.embedJpg(img.bytes) : await doc.embedPng(img.bytes);
    if (pageMode === 'a4') {
      const page = doc.addPage([A4.width, A4.height]);
      const maxW = Math.max(1, A4.width - margin * 2);
      const maxH = Math.max(1, A4.height - margin * 2);
      const scale = Math.min(maxW / embedded.width, maxH / embedded.height);
      const w = embedded.width * scale;
      const h = embedded.height * scale;
      page.drawImage(embedded, { x: (A4.width - w) / 2, y: (A4.height - h) / 2, width: w, height: h });
    } else {
      const page = doc.addPage([embedded.width, embedded.height]);
      page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    }
  }
  return doc.save();
}

/** 打开已有 PDF（带友好错误信息） */
async function loadPdf(bytes) {
  try {
    return await PDFDocument.load(bytes);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (/encrypted/i.test(msg)) {
      throw new Error('这个 PDF 已加密，暂不支持直接处理（本期不做加密/解密）。');
    }
    throw new Error(`读取 PDF 失败：${msg}`);
  }
}

/**
 * 合并多份 PDF（按传入顺序）
 * @param {Uint8Array[]} list
 * @returns {Promise<Uint8Array>}
 */
export async function mergePdfs(list) {
  if (!list || list.length === 0) throw new Error('没有可合并的 PDF');
  const doc = await PDFDocument.create();
  for (const bytes of list) {
    const src = await loadPdf(bytes);
    const pages = await doc.copyPages(src, src.getPageIndices());
    for (const page of pages) doc.addPage(page);
  }
  return doc.save();
}

/**
 * 拆分 PDF：每 N 页一个文件
 * @param {Uint8Array} bytes
 * @param {{everyN?: number}} [options]
 * @returns {Promise<{start: number, end: number, bytes: Uint8Array}[]>} start/end 为 1 起页码
 */
export async function splitPdf(bytes, { everyN = 1 } = {}) {
  const n = Math.max(1, Math.floor(everyN));
  const src = await loadPdf(bytes);
  const total = src.getPageCount();
  const out = [];
  for (let start = 1; start <= total; start += n) {
    const end = Math.min(total, start + n - 1);
    const doc = await PDFDocument.create();
    const indices = [];
    for (let p = start; p <= end; p++) indices.push(p - 1);
    const pages = await doc.copyPages(src, indices);
    for (const page of pages) doc.addPage(page);
    out.push({ start, end, bytes: await doc.save() });
  }
  return out;
}

/**
 * 提取指定页生成新 PDF（兼作删页/重排）
 * @param {Uint8Array} bytes
 * @param {number[]} pageNumbers 页码数组（1 起，顺序即输出顺序，可重复）
 * @returns {Promise<Uint8Array>}
 */
export async function extractPages(bytes, pageNumbers) {
  if (!pageNumbers || pageNumbers.length === 0) throw new Error('没有选择要提取的页');
  const src = await loadPdf(bytes);
  const total = src.getPageCount();
  const doc = await PDFDocument.create();
  for (const p of pageNumbers) {
    if (p < 1 || p > total) throw new Error(`页码超出范围：${p}（该 PDF 共 ${total} 页）`);
  }
  const pages = await doc.copyPages(src, pageNumbers.map((p) => p - 1));
  for (const page of pages) doc.addPage(page);
  return doc.save();
}

/** 读取 PDF 页数（不修改内容） */
export async function getPageCount(bytes) {
  const src = await loadPdf(bytes);
  return src.getPageCount();
}