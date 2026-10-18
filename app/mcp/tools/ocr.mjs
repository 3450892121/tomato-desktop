// MCP 工具：文字识别（PP-OCR，纯离线）
// 模型在 addons/ocr/（det.onnx / rec.onnx / dict.txt），运行时 ppu-paddle-ocr 走 ONNX Runtime。
// 第一批 MCP 只接图片输入；扫描版 PDF 需要先渲染成图片（后续 Canvas 批次再接）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { appRoot, assertFile, resolveOutputPath } from '../lib/paths.mjs';
import { openPdfNode, renderPdfPage, closePdfNode } from '../lib/pdf-render.mjs';
import { linesToSearchablePdf } from '../../src/tools/ocr/core/searchable.js';
import { linesToPlainRows } from '../../src/tools/ocr/core/convert.js';
import { linesToDocx, pagesToDocxRows } from '../../src/tools/ocr/core/docx.js';

const OCR_DIR = path.join(appRoot(), 'addons', 'ocr');
const MODEL = {
  detection: path.join(OCR_DIR, 'det.onnx'),
  recognition: path.join(OCR_DIR, 'rec.onnx'),
  charactersDictionary: path.join(OCR_DIR, 'dict.txt')
};
const FONT = path.join(OCR_DIR, 'fonts', 'NotoSansSC-VF.ttf');

let servicePromise = null;

function addonStatus() {
  const models = {};
  let found = true;
  for (const [key, file] of Object.entries(MODEL)) {
    const exists = fs.existsSync(file);
    models[key] = { file, exists, size: exists ? fs.statSync(file).size : 0 };
    if (!exists) found = false;
  }
  const fontExists = fs.existsSync(FONT);
  return {
    found,
    dir: OCR_DIR,
    models,
    font: { path: FONT, exists: fontExists, size: fontExists ? fs.statSync(FONT).size : 0 }
  };
}

function getService() {
  if (servicePromise) return servicePromise;
  servicePromise = (async () => {
    const status = addonStatus();
    if (!status.found) {
      throw new Error('未检测到文字识别加装包：请把 det.onnx / rec.onnx / dict.txt 放到 addons/ocr');
    }
    const { PaddleOcrService } = await import('ppu-paddle-ocr');
    const svc = new PaddleOcrService({ model: MODEL });
    await svc.initialize();
    return svc;
  })();
  return servicePromise;
}

async function recognizeBytes(bytes) {
  const svc = await getService();
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return svc.recognize(ab);
}

function fontBytes() {
  if (!fs.existsSync(FONT)) throw new Error('缺少中文字体（addons/ocr/fonts/NotoSansSC-VF.ttf），无法生成可搜索 PDF/Word');
  return fs.readFileSync(FONT);
}

export const statusTool = {
  name: 'ocr_status',
  description: '检查文字识别引擎是否就绪（模型文件、中文字体）。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler() {
    const st = addonStatus();
    return { ok: true, ...st, ready: !!servicePromise };
  }
};

export const recognizeTool = {
  name: 'ocr_recognize',
  description:
    '识别图片里的文字（中文/英文），返回全文、逐行片段、每段坐标与置信度。'
    + ' 当前 MCP 批次只支持 PNG/JPG/WebP 图片；扫描版 PDF 请先用 PDF 转图片。',
  inputSchema: {
    type: 'object',
    required: ['input'],
    properties: {
      input: { type: 'string', description: '图片路径（PNG / JPG / WebP）' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const input = assertFile(args.input, '图片');
    const ext = path.extname(input).toLowerCase();
    if (ext === '.pdf') throw new Error('当前 MCP 批次只支持图片；请先把 PDF 每页转成 PNG/JPG');
    if (!['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) {
      throw new Error(`不支持的图片格式：${ext || '未知'}`);
    }
    const bytes = await fsp.readFile(input);
    const svc = await getService();
    const t0 = Date.now();
    const r = await svc.recognize(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return {
      ok: true,
      input,
      text: r.text || '',
      lines: r.lines || [],
      confidence: r.confidence || 0,
      ms: Date.now() - t0
    };
  }
};

export const searchablePdfTool = {
  name: 'ocr_searchable_pdf',
  description:
    '把扫描版 PDF 做成「可搜索 PDF」：每页渲染→OCR→在原文上叠一层隐形文字，'
    + ' 看起来不变，但 Ctrl+F 能搜、能选中复制。需中文字体加装包。',
  inputSchema: {
    type: 'object',
    required: ['input'],
    properties: {
      input: { type: 'string', description: '扫描版 PDF' },
      scale: { type: 'number', minimum: 0.5, maximum: 4, description: 'OCR 渲染倍率，默认 2' },
      output: { type: 'string', description: '可选：输出 PDF 路径' },
      output_dir: { type: 'string', description: '可选：输出目录' },
      base_name: { type: 'string', description: '可选：输出文件名' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const input = assertFile(args.input, 'PDF');
    const bytes = new Uint8Array(await fsp.readFile(input));
    const scale = Number(args.scale) || 2;
    const pdf = await openPdfNode(bytes);
    const pageLines = [];
    try {
      for (let i = 1; i <= pdf.numPages; i += 1) {
        const { canvas } = await renderPdfPage(pdf, i, { scale });
        const png = canvas.toBuffer('image/png');
        const r = await recognizeBytes(png);
        pageLines.push(r.lines || []);
      }
    } finally {
      await closePdfNode(pdf);
    }
    const out = await linesToSearchablePdf({
      pdfBytes: bytes,
      pageLines,
      fontBytes: fontBytes(),
      renderScale: scale
    });
    const base = args.base_name || `${path.basename(input, path.extname(input))}_可搜索`;
    const target = resolveOutputPath({
      output: args.output,
      output_dir: args.output_dir,
      base_name: base,
      ext: '.pdf',
      fallbackDir: path.dirname(input)
    });
    await fsp.writeFile(target.path, Buffer.from(out.bytes));
    return {
      ok: true,
      output: target.path,
      pages: pageLines.length,
      drawn_fragments: out.drawnFragments,
      embedded_chars: out.embeddedChars,
      missing_chars: out.missingChars
    };
  }
};

export const toDocxTool = {
  name: 'ocr_to_docx',
  description: '把图片或扫描版 PDF 的识别结果导出成可编辑 Word（.docx，段落纯文本 + 分页）。',
  inputSchema: {
    type: 'object',
    required: ['input'],
    properties: {
      input: { type: 'string', description: '图片或扫描版 PDF' },
      scale: { type: 'number', minimum: 0.5, maximum: 4, description: 'PDF 渲染倍率，默认 2' },
      output: { type: 'string', description: '可选：输出 docx 路径' },
      output_dir: { type: 'string', description: '可选：输出目录' },
      base_name: { type: 'string', description: '可选：输出文件名' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const input = assertFile(args.input, '图片/PDF');
    const ext = path.extname(input).toLowerCase();
    const pagesRows = [];
    if (ext === '.pdf') {
      const bytes = new Uint8Array(await fsp.readFile(input));
      const pdf = await openPdfNode(bytes);
      try {
        for (let i = 1; i <= pdf.numPages; i += 1) {
          const { canvas } = await renderPdfPage(pdf, i, { scale: Number(args.scale) || 2 });
          const r = await recognizeBytes(canvas.toBuffer('image/png'));
          pagesRows.push(linesToPlainRows(r.lines || []));
        }
      } finally {
        await closePdfNode(pdf);
      }
    } else {
      const r = await recognizeBytes(await fsp.readFile(input));
      pagesRows.push(linesToPlainRows(r.lines || []));
    }
    const rows = pagesToDocxRows(pagesRows);
    const docx = await linesToDocx(rows, { title: path.basename(input) });
    const base = args.base_name || `${path.basename(input, path.extname(input))}_识别`;
    const target = resolveOutputPath({
      output: args.output,
      output_dir: args.output_dir,
      base_name: base,
      ext: '.docx',
      fallbackDir: path.dirname(input)
    });
    await fsp.writeFile(target.path, Buffer.from(docx));
    return { ok: true, output: target.path, pages: pagesRows.length, lines: rows.length };
  }
};

export default [statusTool, recognizeTool, searchablePdfTool, toDocxTool];
