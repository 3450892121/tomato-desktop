// 工具：PDF 编辑整理 —— 纯逻辑层（PDF 操作，与界面完全解耦）
//
// 约定：本文件里的操作函数除压缩外都返回 Uint8Array（新 PDF 的字节），
//       压缩（compressPdfOp）直接透传 shared/pdfops.js 的结果对象
//       （含 bytes / 原体积 / 实际档位 / 是否取消等，界面需要展示「原大小 → 新大小」）。
//       取消统一抛 CancelledError（界面据此区分「用户取消」与「真失败」）。
//
// 依赖：@cantoo/pdf-lib（支持加密的 pdf-lib 社区分支）+ @cantoo/fontkit（字体子集化）
//       + shared/pdfops.js（压缩与 pdfjs 打开能力）。工具之间禁止互相 import。
import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees
} from '../../../../node_modules/@cantoo/pdf-lib/dist/pdf-lib.esm.js';
import { compressPdf, openPdfDoc } from '../../../shared/pdfops.js';
import { parsePageRange } from './pages.js';

// —— 字体引擎（fontkit）加载 ——
// 注意 1：必须用 @cantoo/fontkit（不是 @pdf-lib/fontkit）——后者与本分支 API 不匹配，
//        实测会报 "Cannot read properties of undefined (reading 'pos')"。
// 注意 2：它的 **ESM 产物**（browser-module.mjs）内部 import 了裸模块名
//        （restructure / brotli / dfa / fflate），本项目没有打包器，渲染进程直接 import
//        会抛「Failed to resolve module specifier」，所以浏览器端改走它自带的 UMD 产物，
//        经 <script> 动态加载（CSP script-src 'self' 允许同源脚本，与「文字识别」工具同一做法）。
// 注意 3：@cantoo/pdf-lib 的 dist/pdf-lib.esm.js 是单文件自包含产物（顶层零 import），可直接引用。
const FONTKIT_UMD = new URL('../../../../node_modules/@cantoo/fontkit/dist/fontkit.umd.min.js', import.meta.url).href;

let fontkitLoading = null;

/**
 * 取字体引擎（pdf-lib 做字体子集化必需）
 * - 渲染进程：<script> 加载 UMD 产物后从 globalThis.fontkit 取；
 * - Node（纯逻辑单测）：直接 import，Node 自己能解析裸模块名；
 * 用模块级 Promise 缓存，避免重复加载。
 * @returns {Promise<object>} fontkit 对象（含 create）
 */
export function loadFontkit() {
  if (!fontkitLoading) {
    fontkitLoading = (async () => {
      if (typeof document !== 'undefined') {
        if (globalThis.fontkit && typeof globalThis.fontkit.create === 'function') return globalThis.fontkit;
        await new Promise((resolve, reject) => {
          const el = document.createElement('script');
          el.src = FONTKIT_UMD;
          el.onload = () => resolve();
          el.onerror = () => reject(new Error('字体引擎加载失败（fontkit.umd.min.js）'));
          document.head.appendChild(el);
        });
        const fk = globalThis.fontkit;
        if (!fk || typeof fk.create !== 'function') throw new Error('字体引擎未就绪（fontkit）');
        return fk;
      }
      const mod = await import('@cantoo/fontkit');
      return mod.default || mod;
    })();
  }
  return fontkitLoading;
}

/** 用户主动取消时抛出（界面按 err.name === 'CancelledError' 判断） */
export class CancelledError extends Error {
  constructor() {
    super('已取消');
    this.name = 'CancelledError';
  }
}

/** 可选的九宫格位置 */
export const POSITIONS = [
  { value: 'top-left', label: '左上' },
  { value: 'top-center', label: '上中' },
  { value: 'top-right', label: '右上' },
  { value: 'middle-left', label: '左中' },
  { value: 'center', label: '居中' },
  { value: 'middle-right', label: '右中' },
  { value: 'bottom-left', label: '左下' },
  { value: 'bottom-center', label: '下中' },
  { value: 'bottom-right', label: '右下' }
];

// —— 中文字体 ——
// 设计说明：字体文件在**软件目录**的 addons/ocr/fonts/ 下（随包加装包）。
//           取字体有两条路，优先第一条：
//           ① 主进程的 `ocr:font` IPC（ctx.ocrFont）——路径由主进程按 PORTABLE_DIR 解析
//              （打包态 = exe 所在目录，开发态 = app/），**两种布局都对**，且与「文字识别」
//              工具共用同一个通道、同一份真相；
//           ② 回退：用 import.meta.url 相对解析出 file:// 路径再交给 ctx.readFile 读盘。
//           为什么必须有 ①：下面的相对深度 `../../../../` 只在**开发态**成立。打包后本文件位于
//           resources/app/src/tools/pdf-edit/core/，同样上溯四级只到 resources/app/，而 addons
//           在产物根目录（还要再上两级）——于是 ② 在产物上必然读不到字体，界面会误报
//           「中文字体缺失」，中文水印与中文页码静默降级成 Helvetica（中文显示为空白）。
//           字体确实缺失时仍然明确降级，界面提示不变。
const CJK_FONT_URL = new URL('../../../../addons/ocr/fonts/NotoSansSC-VF.ttf', import.meta.url);

/** 中文字体的本地绝对路径（开发态 = app/addons/ocr/fonts/NotoSansSC-VF.ttf） */
export function cjkFontPath() {
  // file:///C:/xxx → C:/xxx（Windows 盘符要去掉开头的斜杠）
  return decodeURIComponent(CJK_FONT_URL.pathname).replace(/^\/([A-Za-z]:)/, '$1');
}

/**
 * 读取中文字体字节
 * @param {(p: string) => Promise<Uint8Array>} readFile 一般是 ctx.readFile（回退路径用）
 * @param {() => Promise<{ok?: boolean, bytes?: Uint8Array}>} [ocrFont] 一般是 ctx.ocrFont（首选路径）
 * @returns {Promise<Uint8Array|null>} 读不到（未打包加装包/被删）返回 null，由调用方降级
 */
export async function loadCjkFontBytes(readFile, ocrFont) {
  if (typeof ocrFont === 'function') {
    try {
      const font = await ocrFont();
      if (font && font.ok && font.bytes && font.bytes.length) return font.bytes;
    } catch {
      // 主进程通道不可用时落到下面的相对路径回退
    }
  }
  if (typeof readFile !== 'function') return null;
  try {
    const bytes = await readFile(cjkFontPath());
    return bytes && bytes.length ? bytes : null;
  } catch {
    return null;
  }
}

/** 是否含 CJK（中文/日文/韩文）字符——决定内置 Helvetica 能否胜任 */
export function hasCjk(text) {
  return /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(String(text || ''));
}

/**
 * 释放 pdfjs 文档（真正结束解析线程/worker）
 * 说明：pdfjs 6 起 PDFDocumentProxy 上不再有 destroy()，要经 loadingTask.destroy()；
 *       两种形态都兜住，避免把「关不掉」当成正常（曾实测 proxy.destroy is not a function）。
 */
export async function closePdfDoc(pdf) {
  if (!pdf) return;
  try {
    if (typeof pdf.destroy === 'function') await pdf.destroy();
    else if (pdf.loadingTask && typeof pdf.loadingTask.destroy === 'function') await pdf.loadingTask.destroy();
  } catch {
    /* 释放异常忽略：不影响已完成的处理结果 */
  }
}

// —— 错误翻译：把库抛出的英文错误变成用户看得懂的中文 ——

/** 把 pdf-lib / pdfjs 的错误转成中文可读提示 */
export function toFriendlyError(err) {
  const msg = (err && err.message) || String(err);
  if (err && err.name === 'CancelledError') return err;
  if (/is encrypted|encrypted/i.test(msg)) {
    return new Error('这个 PDF 已加密，不能直接编辑：请先用本工具的「解密」去掉密码。');
  }
  if (/Password incorrect|NEEDS PASSWORD/i.test(msg)) {
    return new Error('密码不对，打不开这个 PDF。');
  }
  if (/InvalidPDF|not a PDF|Invalid PDF|No PDF header|Failed to parse/i.test(msg)) {
    return new Error('文件不是有效的 PDF（或已损坏）。');
  }
  if (/WinAnsi cannot encode/i.test(msg)) {
    return new Error('中文字体缺失：内置字体只能画英文与数字，中文会显示为空白。请改用英文/数字，或补上中文字体文件。');
  }
  return new Error(`处理失败：${msg}`);
}

/** 载入 PDF（加密文件给出明确提示，而不是抛英文错误） */
async function loadDoc(bytes) {
  try {
    return await PDFDocument.load(bytes);
  } catch (err) {
    throw toFriendlyError(err);
  }
}

/**
 * 选字体：优先嵌入中文字体（子集化）；失败或未提供则降级到内置 Helvetica。
 * @returns {{font: object, cjk: boolean}}
 */
async function pickFont(doc, fontBytes) {
  if (fontBytes && fontBytes.length) {
    try {
      const fk = await loadFontkit();
      doc.registerFontkit(fk);
      const font = await doc.embedFont(fontBytes, { subset: true });
      return { font, cjk: true };
    } catch (err) {
      console.warn('[pdf-edit] 中文字体嵌入失败，改用内置字体：', (err && err.message) || err);
    }
  }
  return { font: await doc.embedFont(StandardFonts.Helvetica), cjk: false };
}

/** 颜色解析：支持 '#rrggbb' / '#rgb' / {r,g,b}(0~1) / [r,g,b](0~255)；非法回退浅灰 */
export function parseColor(input) {
  const fallback = rgb(0.55, 0.55, 0.55);
  if (input == null || input === '') return fallback;
  if (typeof input === 'object' && !Array.isArray(input)) {
    if ([input.r, input.g, input.b].every((v) => typeof v === 'number')) return rgb(input.r, input.g, input.b);
    return fallback;
  }
  const arr = Array.isArray(input) ? input.map(Number) : null;
  if (arr && arr.length >= 3 && arr.every((v) => Number.isFinite(v))) {
    return rgb(arr[0] / 255, arr[1] / 255, arr[2] / 255);
  }
  const hex = String(input).trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return rgb(
      parseInt(hex[0] + hex[0], 16) / 255,
      parseInt(hex[1] + hex[1], 16) / 255,
      parseInt(hex[2] + hex[2], 16) / 255
    );
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return rgb(
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255
    );
  }
  return fallback;
}

const defaultMargin = (v) => (Number.isFinite(v) && v >= 0 ? v : 24);

/** 九宫格定位：返回文本左下角坐标（w/h 为文本外接尺寸，margin 为页边距） */
function anchorXY(position, pageW, pageH, w, h, margin) {
  const pos = POSITIONS.some((p) => p.value === position) ? position : 'center';
  const [vertical, horizontal] = pos === 'center' ? ['middle', 'center'] : pos.split('-');
  const x = horizontal === 'left' ? margin : horizontal === 'right' ? pageW - margin - w : (pageW - w) / 2;
  const y = vertical === 'top' ? pageH - margin - h : vertical === 'bottom' ? margin : (pageH - h) / 2;
  return { x, y };
}

/**
 * 压缩 PDF
 * @param {Uint8Array} bytes
 * @param {{preset?: string, grayscale?: boolean, maxMB?: number, pages?: number[], password?: string,
 *          onProgress?: (done:number,total:number)=>void, shouldCancel?: ()=>boolean}} [opts]
 * @returns {Promise<{bytes: Uint8Array, originalBytes: number, pages: number, scale: number, quality: number,
 *                    preset: string, grayscale: boolean, attempts: number, cancelled: boolean}>}
 *         （透传 shared/pdfops.js 的 compressPdf 结果）
 */
export async function compressPdfOp(bytes, opts = {}) {
  const { preset, grayscale, maxMB, pages, password, onProgress, shouldCancel } = opts;
  try {
    return await compressPdf(bytes, { preset, grayscale, maxMB, pages, password, onProgress, shouldCancel });
  } catch (err) {
    throw toFriendlyError(err);
  }
}

/**
 * 加文字水印（九宫格单点 / 全页平铺）
 * @param {Uint8Array} bytes
 * @param {{text: string, fontSize?: number, opacity?: number, rotation?: number, color?: string,
 *          position?: string, tile?: boolean, margin?: number, fontBytes?: Uint8Array,
 *          onProgress?: Function, shouldCancel?: Function}} opts
 * @returns {Promise<Uint8Array>}
 */
export async function addTextWatermark(bytes, opts = {}) {
  const {
    text, fontSize = 40, opacity = 0.2, rotation = 45, color, position = 'center',
    tile = false, margin = 24, fontBytes, onProgress, shouldCancel
  } = opts;

  const label = String(text == null ? '' : text);
  if (!label.trim()) throw new Error('水印文字不能为空。');
  if (!(Number(fontSize) > 0)) throw new Error('字号需大于 0。');
  const alpha = Math.min(1, Math.max(0.02, Number(opacity) || 0.2));
  const angle = Number(rotation) || 0;
  const pad = defaultMargin(Number(margin));
  const size = Number(fontSize);
  if (!fontBytes && hasCjk(label)) {
    throw new Error('中文字体缺失：中文会显示为空白。请改用英文/数字，或补上中文字体加装包。');
  }

  const doc = await loadDoc(bytes);
  const { font } = await pickFont(doc, fontBytes);
  const col = parseColor(color);
  const pages = doc.getPages();
  const textW = font.widthOfTextAtSize(label, size);
  const textH = font.heightAtSize(size);

  for (let i = 0; i < pages.length; i++) {
    if (shouldCancel && shouldCancel()) throw new CancelledError();
    const page = pages[i];
    const { width, height } = page.getSize();
    if (tile) {
      // 平铺：按文本尺寸推算步长，铺满整页（步长留足空隙，避免字叠字）
      const stepX = Math.max(textW + size * 3, 160);
      const stepY = Math.max(textH * 6, 140);
      for (let y = pad; y <= height; y += stepY) {
        for (let x = pad; x <= width; x += stepX) {
          page.drawText(label, { x, y, size, font, color: col, opacity: alpha, rotate: degrees(angle) });
        }
      }
    } else {
      const { x, y } = anchorXY(position, width, height, textW, textH, pad);
      page.drawText(label, { x, y, size, font, color: col, opacity: alpha, rotate: degrees(angle) });
    }
    // onProgress 允许返回 Promise（界面用它换帧，避免大文档把界面卡住）
    if (onProgress) await onProgress(i + 1, pages.length);
  }
  return doc.save();
}

/**
 * 加页码
 * @param {Uint8Array} bytes
 * @param {{format?: string, startAt?: number, position?: string, fontSize?: number, margin?: number,
 *          skipFirst?: boolean, fontBytes?: Uint8Array, onProgress?: Function, shouldCancel?: Function}} opts
 *        format 支持 {n}（当前页号）与 {total}（总页数）占位，如「第 {n} 页 / 共 {total} 页」
 * @returns {Promise<Uint8Array>}
 */
export async function addPageNumbers(bytes, opts = {}) {
  const {
    format = '第 {n} 页 / 共 {total} 页', startAt = 1, position = 'bottom-center',
    fontSize = 12, margin = 24, skipFirst = false, fontBytes, onProgress, shouldCancel
  } = opts;

  const start = Math.floor(Number(startAt));
  if (!Number.isFinite(start) || start < 1) throw new Error('起始页码需为不小于 1 的整数。');
  const size = Number(fontSize);
  if (!(size > 0)) throw new Error('字号需大于 0。');
  const template = String(format == null ? '' : format);
  if (!template.trim()) throw new Error('页码格式不能为空。');
  const pad = defaultMargin(Number(margin));
  if (!fontBytes && hasCjk(template)) {
    throw new Error('中文字体缺失：中文会显示为空白。请改用英文/数字，或补上中文字体加装包。');
  }

  const doc = await loadDoc(bytes);
  const { font } = await pickFont(doc, fontBytes);
  const pages = doc.getPages();
  const total = pages.length;

  for (let i = 0; i < total; i++) {
    if (shouldCancel && shouldCancel()) throw new CancelledError();
    if (skipFirst && i === 0) continue;
    const page = pages[i];
    const text = template.split('{n}').join(String(start + i)).split('{total}').join(String(total));
    const w = font.widthOfTextAtSize(text, size);
    const h = font.heightAtSize(size);
    const { width, height } = page.getSize();
    const { x, y } = anchorXY(position, width, height, w, h, pad);
    page.drawText(text, { x, y, size, font, color: rgb(0.15, 0.15, 0.15) });
    if (onProgress) await onProgress(i + 1, total);
  }
  return doc.save();
}

/** 全部页码（1 基） */
const allPages = (n) => Array.from({ length: n }, (_, i) => i + 1);

/**
 * 按页旋转（相对当前旋转角度叠加）
 * @param {Uint8Array} bytes
 * @param {{pages?: number[]|string|null, angle: number, onProgress?: Function, shouldCancel?: Function}} opts
 *        pages：要旋转的页（数组或 "1-3,5" 文本；留空 = 全部）
 * @returns {Promise<Uint8Array>}
 */
export async function rotatePages(bytes, opts = {}) {
  const { pages, angle, onProgress, shouldCancel } = opts;
  const a = Number(angle);
  if (![90, 180, 270].includes(a)) throw new Error('旋转角度只能选 90°、180° 或 270°。');

  const doc = await loadDoc(bytes);
  const total = doc.getPageCount();
  // pages 允许传文本（复用 pages.js 的解析规则）；界面通常已解析好再传数组
  let list = null;
  if (typeof pages === 'string') {
    list = parsePageRange(pages, total);
  } else if (Array.isArray(pages) && pages.length) {
    list = pages;
  }
  const targets = list && list.length ? list : allPages(total);

  const pageObjs = doc.getPages();
  for (let i = 0; i < targets.length; i++) {
    if (shouldCancel && shouldCancel()) throw new CancelledError();
    const no = Number(targets[i]);
    if (!Number.isInteger(no) || no < 1 || no > total) {
      throw new Error(`页码超出范围：${targets[i]}（该 PDF 共 ${total} 页）`);
    }
    const page = pageObjs[no - 1];
    page.setRotation(degrees((page.getRotation().angle + a) % 360));
    if (onProgress) await onProgress(i + 1, targets.length);
  }
  return doc.save();
}

/**
 * 页面重排（输出新页序的 PDF）
 * @param {Uint8Array} bytes
 * @param {{order: number[]|string, onProgress?: Function, shouldCancel?: Function}} opts
 *        order：新页序；数组（如 [3,1,2]，顺序即输出顺序）或文本（如 "3,1,2" / "2-3,1"，范围按升序展开）
 * @returns {Promise<Uint8Array>}
 */
export async function reorderPages(bytes, opts = {}) {
  const { order, onProgress, shouldCancel } = opts;
  const doc = await loadDoc(bytes);
  const total = doc.getPageCount();
  const seq = normalizeOrder(order, total);
  if (seq.length === 0) throw new Error('请填写新的页序（如 3,1,2 或 2-3,1）。');

  if (shouldCancel && shouldCancel()) throw new CancelledError();
  const out = await PDFDocument.create();
  const copied = await out.copyPages(doc, seq.map((n) => n - 1));
  for (let i = 0; i < copied.length; i++) {
    if (shouldCancel && shouldCancel()) throw new CancelledError();
    out.addPage(copied[i]);
    if (onProgress) await onProgress(i + 1, copied.length);
  }
  return out.save();
}

/** 把 order（数组或文本）规范成 1 基页码数组，保留用户给定顺序 */
export function normalizeOrder(order, totalPages) {
  const one = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`页序里的「${v}」不是有效的页码。`);
    if (totalPages && (n < 1 || n > totalPages)) {
      throw new Error(`页码超出范围：${n}（该 PDF 共 ${totalPages} 页）`);
    }
    return n;
  };

  if (Array.isArray(order)) {
    if (order.length === 0) return [];
    return order.map(one);
  }
  const raw = String(order == null ? '' : order).trim();
  if (!raw) return [];

  const seq = [];
  for (const part of raw.split(/[,，;；\s]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d+)\s*[-~～]\s*(\d+)$/) || part.match(/^(\d+)$/);
    if (!m) throw new Error(`页序格式不对：「${part}」（示例：3,1,2 或 2-3,1）`);
    const start = one(m[1]);
    const end = m[2] ? one(m[2]) : start;
    if (end < start) throw new Error(`页序范围不合法：「${part}」`);
    for (let p = start; p <= end; p++) seq.push(p);
  }
  return seq;
}

const PERMISSION_KEYS = [
  'printing', 'copying', 'modifying', 'annotating',
  'fillingForms', 'contentAccessibility', 'documentAssembly'
];

/**
 * 加密（给 PDF 加打开密码）
 * @param {Uint8Array} bytes
 * @param {{userPassword?: string, ownerPassword?: string,
 *          permissions?: {printing?: boolean, copying?: boolean, modifying?: boolean},
 *          onProgress?: Function, shouldCancel?: Function}} opts
 * @returns {Promise<Uint8Array>}
 */
export async function encryptPdf(bytes, opts = {}) {
  const { userPassword = '', ownerPassword = '', permissions = {}, shouldCancel } = opts;
  const user = String(userPassword || '');
  const owner = String(ownerPassword || '');
  if (!user && !owner) throw new Error('请至少设置一个密码（打开密码或所有者密码）。');
  if (shouldCancel && shouldCancel()) throw new CancelledError();

  const doc = await loadDoc(bytes);
  const perms = {};
  for (const k of PERMISSION_KEYS) {
    if (permissions && permissions[k] !== undefined) perms[k] = !!permissions[k];
  }
  try {
    // AES-256：ISO 32000-2 推荐、兼容主流阅读器；仅设所有者密码时，用同一个作打开密码
    doc.encrypt({ userPassword: user || undefined, ownerPassword: owner || user || undefined, permissions: perms, algorithm: 'AES-256' });
    return await doc.save();
  } catch (err) {
    throw toFriendlyError(err);
  }
}

/**
 * 解密（去掉打开密码，输出不加密的 PDF）
 * @param {Uint8Array} bytes
 * @param {{password?: string, onProgress?: Function, shouldCancel?: Function}} opts
 * @returns {Promise<Uint8Array>}
 */
export async function decryptPdf(bytes, opts = {}) {
  const { password = '', shouldCancel } = opts;
  if (shouldCancel && shouldCancel()) throw new CancelledError();

  // 先判断文件到底有没有加密（未加密时给友好提示，而不是白跑一趟）
  let encrypted = false;
  try {
    await PDFDocument.load(bytes);
  } catch (err) {
    if (/is encrypted|encrypted/i.test((err && err.message) || '')) encrypted = true;
    else throw toFriendlyError(err);
  }
  if (!encrypted) throw new Error('这个 PDF 没有打开密码，不需要解密。');
  if (!password) throw new Error('这个 PDF 有打开密码，请填写密码后再解密。');

  // 用 pdfjs 复验一次密码：它和日常阅读器走同一套判定，避免 pdf-lib 静默产出一份坏文件
  let pdf = null;
  try {
    pdf = await openPdfDoc(bytes, password);
  } catch {
    throw new Error('密码不对，打不开这个 PDF。');
  } finally {
    await closePdfDoc(pdf);
  }

  let doc;
  try {
    // 带密码载入：pdf-lib 会把内容解密到内存
    doc = await PDFDocument.load(bytes, { password });
  } catch (err) {
    throw toFriendlyError(err);
  }
  // 关键：**不能**直接 doc.save()——实测 pdf-lib 会把 /Encrypt 原样写回，
  //       产出的文件仍然「打不开（没有密码）」，等于没解密。
  //       正确做法：把页面复制进一份全新文档再保存，输出彻底不加密（只用公开 API）。
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, doc.getPageIndices());
  for (let i = 0; i < pages.length; i++) {
    if (shouldCancel && shouldCancel()) throw new CancelledError();
    out.addPage(pages[i]);
  }
  return out.save();
}