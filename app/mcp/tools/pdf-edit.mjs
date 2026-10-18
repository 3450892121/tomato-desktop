// MCP 工具：PDF 编辑整理（水印 / 页码 / 旋转 / 重排 / 加密 / 解密）
// 直接复用 src/tools/pdf-edit/core/ops.js（pdf-lib + fontkit，纯 JS）。
// 说明：PDF 压缩瘦身依赖 pdfjs 渲染 + Canvas，放到后续 Canvas 批次；这里先不接。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  addTextWatermark, addPageNumbers, rotatePages, reorderPages, encryptPdf
} from '../../src/tools/pdf-edit/core/ops.js';
import { PDFDocument } from '../../node_modules/@cantoo/pdf-lib/dist/pdf-lib.esm.js';
import { appRoot, assertFile, resolveOutputPath } from '../lib/paths.mjs';

const FONT_PATH = path.join(appRoot(), 'addons', 'ocr', 'fonts', 'NotoSansSC-VF.ttf');

function fontBytes() {
  try { return fs.readFileSync(FONT_PATH); } catch { return undefined; }
}

/**
 * Node 版解密：GUI 的 ops.decryptPdf 会用 pdfjs 复验密码，但 pdfjs 的浏览器构建在
 * Node v22 里会踩 `Promise.try is not a function`。这里直接用 pdf-lib：
 *   · 先不带密码 load，成功 = 本来就没加密；
 *   · 带密码 load，失败 = 密码不对；
 *   · 复制页面到新文档再保存，彻底去掉 /Encrypt。
 */
async function decryptPdfNode(bytes, password) {
  let encrypted = false;
  try {
    await PDFDocument.load(bytes);
  } catch (err) {
    if (/encrypt/i.test(String((err && err.message) || err))) encrypted = true;
    else throw new Error(`读取 PDF 失败：${(err && err.message) || err}`);
  }
  if (!encrypted) throw new Error('这个 PDF 没有打开密码，不需要解密。');
  if (!password) throw new Error('这个 PDF 有打开密码，请填写密码后再解密。');

  let doc;
  try {
    doc = await PDFDocument.load(bytes, { password });
  } catch {
    throw new Error('密码不对，打不开这个 PDF。');
  }
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, doc.getPageIndices());
  for (const page of pages) out.addPage(page);
  return out.save();
}

const OPERATIONS = ['watermark', 'page_numbers', 'rotate', 'reorder', 'encrypt', 'decrypt'];

export default {
  name: 'pdf_edit',
  description:
    'PDF 编辑整理：watermark=文字水印；page_numbers=页码；rotate=按页旋转；reorder=页面重排；'
    + 'encrypt=加打开密码；decrypt=去打开密码。每个操作参数见 params。产物重名自动加序号。',
  inputSchema: {
    type: 'object',
    required: ['input', 'operation'],
    properties: {
      input: { type: 'string', description: '源 PDF 路径' },
      operation: { type: 'string', enum: OPERATIONS, description: '要做的操作' },
      params: {
        type: 'object',
        description:
          'watermark: {text,fontSize,opacity,rotation,color,position,tile,margin}；'
          + 'page_numbers: {format,startAt,position,fontSize,margin,skipFirst}；'
          + 'rotate: {pages,angle}；reorder: {order}；'
          + 'encrypt: {userPassword,ownerPassword,permissions}；decrypt: {password}'
      },
      output: { type: 'string', description: '可选：输出 PDF 路径（重名自动加序号）' },
      output_dir: { type: 'string', description: '可选：输出目录（默认源 PDF 同目录）' },
      base_name: { type: 'string', description: '可选：输出文件名（不含扩展名）' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const src = assertFile(args.input, 'PDF');
    const operation = String(args.operation || '');
    if (!OPERATIONS.includes(operation)) throw new Error(`未知操作：${operation}`);
    const bytes = new Uint8Array(await fsp.readFile(src));
    const p = args.params && typeof args.params === 'object' ? args.params : {};
    const font = fontBytes();
    const t0 = Date.now();

    let out;
    if (operation === 'watermark') out = await addTextWatermark(bytes, { ...p, fontBytes: font });
    else if (operation === 'page_numbers') out = await addPageNumbers(bytes, { ...p, fontBytes: font });
    else if (operation === 'rotate') out = await rotatePages(bytes, { pages: p.pages, angle: p.angle });
    else if (operation === 'reorder') out = await reorderPages(bytes, { order: p.order });
    else if (operation === 'encrypt') {
      out = await encryptPdf(bytes, {
        userPassword: p.userPassword || '',
        ownerPassword: p.ownerPassword || '',
        permissions: p.permissions || {}
      });
    } else if (operation === 'decrypt') out = await decryptPdfNode(bytes, p.password || '');

    const base = args.base_name || `${path.basename(src, path.extname(src))}_${operation}`;
    const target = resolveOutputPath({
      output: args.output,
      output_dir: args.output_dir,
      base_name: base,
      ext: '.pdf',
      fallbackDir: path.dirname(src)
    });
    await fsp.writeFile(target.path, Buffer.from(out));
    return {
      ok: true,
      output: target.path,
      operation,
      size: (await fsp.stat(target.path)).size,
      ms: Date.now() - t0
    };
  }
};
