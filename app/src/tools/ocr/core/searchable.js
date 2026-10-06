// 工具：文字识别 —— 纯逻辑层（给扫描件叠「隐形文字层」，做成可搜索 PDF）
//
// 原理：扫描版 PDF 的页面是一张图，pdfjs 取不到任何文字（不能搜、不能选、不能复制）。
//       这里用 pdf-lib 在原页面上再画一层 **RenderMode=Invisible 的文字**：
//       看起来和原来一模一样，但 Ctrl+F 能搜到、能选中复制、能被其它工具提取。
//
// 依赖：@cantoo/pdf-lib（支持加密与 renderMode 的分支）+ @cantoo/fontkit（中文字体子集化）。
//       必须用 @cantoo/fontkit，不能用 @pdf-lib/fontkit（后者 API 不匹配，实测报 pos 未定义）。
//       加载方式见下方 loadFontkit()：它的 ESM 产物带裸模块名（restructure 等），
//       无打包器的渲染进程直接 import 会失败，故浏览器端改走它的 UMD 产物。
//
// 坐标系：OCR 给的是渲染位图的像素坐标（y 向下），PDF 是点坐标（y 向上）。
//         换算见 convert.js 的 computePdfTextPlacement；若开了「纠偏」，识别框先在
//         「旋转后的图」上，需要用 preprocess.unrotateBox 折算回原图坐标再换算（见 pageAngles）。
import { PDFDocument, TextRenderingMode } from '../../../../node_modules/@cantoo/pdf-lib/dist/pdf-lib.esm.js';
import { computePdfTextPlacement, linesToFragments } from './convert.js';
import { unrotateBox } from './preprocess.js';

/** fontkit 的 UMD 产物路径（浏览器端经 <script> 加载；与 PDF 工具 office-print.html 同一做法） */
const FONTKIT_UMD = new URL('../../../../node_modules/@cantoo/fontkit/dist/fontkit.umd.min.js', import.meta.url).href;

let fontkitLoading = null;

/**
 * 取字体引擎（pdf-lib 做字体子集化必需）
 * - 渲染进程：@cantoo/fontkit 的 ESM 产物（browser-module.mjs）里是裸模块名
 *   （restructure / brotli / dfa / fflate），没有打包器时浏览器会报
 *   「Failed to resolve module specifier」，所以改用它自带的 UMD 产物经 <script> 加载
 *   （CSP script-src 'self' 允许，本项目 PDF 工具已有同样先例）。
 * - node：直接 import（Node 自己会解析裸模块名），方便纯逻辑单测。
 * @returns {Promise<object>} fontkit 对象（含 create）
 */
function loadFontkit() {
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

/** 判断字节是否为 JPEG（FF D8） */
export function isJpegBytes(bytes) {
  return !!bytes && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** 判断字节是否为 PNG（89 50 4E 47） */
export function isPngBytes(bytes) {
  return !!bytes && bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

/**
 * 把若干张图片装订成一份 PDF（每张一页，页面尺寸 = 图片像素尺寸，1px = 1pt）。
 * 用途：用户直接拖进来的是图片（照片/截图）却想要「可搜索 PDF」时，先装订再叠文字层。
 * @param {Array<{bytes: Uint8Array|ArrayBuffer}>} images
 * @returns {Promise<{bytes: Uint8Array, sizes: Array<{width:number,height:number}>}>}
 */
export async function imagesToPdf(images) {
  const list = Array.isArray(images) ? images : [];
  if (list.length === 0) throw new Error('没有可装订的图片');
  const doc = await PDFDocument.create();
  const sizes = [];
  for (const item of list) {
    const bytes = item && item.bytes ? item.bytes : item;
    if (!bytes || !bytes.length) throw new Error('图片数据为空');
    // pdf-lib 只能按真实格式嵌入，先把明显不是 PNG/JPG 的挡在门外（否则报错很难懂）
    if (!isJpegBytes(bytes) && !isPngBytes(bytes)) throw new Error('只支持 PNG / JPG 图片装订成 PDF');
    const image = isJpegBytes(bytes) ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const page = doc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    sizes.push({ width: image.width, height: image.height });
  }
  return { bytes: await doc.save(), sizes };
}

/**
 * 在原 PDF 的每一页上叠隐形文字层
 *
 * @param {object} input
 * @param {Uint8Array|ArrayBuffer} input.pdfBytes 原 PDF（扫描件）字节；图片输入请先用 imagesToPdf 装订
 * @param {Array<Array>} input.pageLines 每页的 OCR 结果（二维数组），下标 = 页码-1
 * @param {Uint8Array|ArrayBuffer} input.fontBytes 中文字体字节（ctx.ocrFont()）
 * @param {number} [input.renderScale] 渲染 OCR 位图时用的倍率（像素/点），默认 1
 * @param {Array<number>} [input.pageAngles] 每页纠偏时旋转的角度（度）；给了就把框折算回原图
 * @param {number} [input.minConfidence] 低于该置信度的片段不写入文字层（默认 0，即全写）
 * @returns {Promise<{bytes: Uint8Array, pages: number, drawnFragments: number, embeddedChars: number,
 *                    missingChars: number, missingSamples: string[], rotatedPages: number[]}>}
 */
export async function linesToSearchablePdf({
  pdfBytes, pageLines, fontBytes, renderScale = 1, pageAngles = null, minConfidence = 0
} = {}) {
  const src = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  if (!fontBytes || !fontBytes.length) throw new Error('缺少中文字体，无法生成可搜索 PDF');

  const doc = await PDFDocument.load(src, { ignoreEncryption: true });
  doc.registerFontkit(await loadFontkit());
  const font = await doc.embedFont(fontBytes, { subset: true });

  const pages = doc.getPages();
  const linesPerPage = Array.isArray(pageLines) ? pageLines : [];
  const angles = Array.isArray(pageAngles) ? pageAngles : [];

  let drawnFragments = 0;
  let embeddedChars = 0;
  let missingChars = 0;
  const missingSamples = [];
  const rotatedPages = [];

  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    const rotation = page.getRotation().angle || 0;
    if (Math.abs(rotation % 360) > 0.01) {
      // 旋转页的「视觉方向」与 pdf-lib 的绘制坐标不是一个坐标系，硬画会错位，宁可不画并如实上报
      rotatedPages.push(i + 1);
      continue;
    }
    const { width: pageWidthPts, height: pageHeightPts } = page.getSize();
    const renderedHeightPx = pageHeightPts * renderScale;
    const renderedWidthPx = pageWidthPts * renderScale;
    const angle = Number.isFinite(angles[i]) ? angles[i] : 0;
    const fragments = linesToFragments(linesPerPage[i] || [], { minConfidence });

    for (const frag of fragments) {
      // 开了纠偏：识别框在「旋转后的渲染图」上，先绕渲染图中心反向转回原图坐标
      const box = angle
        ? unrotateBox(frag.box, { angleDeg: angle, width: renderedWidthPx, height: renderedHeightPx })
        : frag.box;
      const { x, y, size } = computePdfTextPlacement({
        box, renderScale, pageHeightPts, renderedHeightPx
      });
      try {
        page.drawText(frag.text, {
          x, y, size, font, renderMode: TextRenderingMode.Invisible
        });
        drawnFragments += 1;
        embeddedChars += frag.text.length;
      } catch {
        // 字体不含这些字（生僻字/特殊符号）：逐个字符确认，统计后交给界面提示
        for (const ch of frag.text) {
          try {
            font.widthOfTextAtSize(ch, size);
          } catch {
            missingChars += 1;
            if (missingSamples.length < 20 && !missingSamples.includes(ch)) missingSamples.push(ch);
          }
        }
      }
    }
  }

  return {
    bytes: await doc.save(),
    pages: pages.length,
    drawnFragments,
    embeddedChars,
    missingChars,
    missingSamples,
    rotatedPages
  };
}