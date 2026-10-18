// MCP 工具：PDF 组装（图片→PDF / 合并 / 拆分 / 提取页 / 页数）
// 直接复用 src/tools/pdf-convert/core/build.js（pdf-lib，纯 JS，不依赖 Electron）。
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  sniffImageType, imagesToPdf, mergePdfs, splitPdf, extractPages, getPageCount
} from '../../src/tools/pdf-convert/core/build.js';
import { parsePageRange } from '../../src/tools/pdf-convert/core/pages.js';
import { PDF_COMPRESS_PRESETS, presetOf } from '../../src/shared/pdfops.js';
import { PDFDocument } from '../../node_modules/@cantoo/pdf-lib/dist/pdf-lib.esm.js';
import { openPdfNode, renderPdfPage, closePdfNode } from '../lib/pdf-render.mjs';
import { canvasToBuffer, canvasToPixels, pixelsToCanvas } from '../lib/canvas-ops.mjs';
import { assertFile, assertDir, resolveOutputPath, uniqueTargetPath } from '../lib/paths.mjs';

async function readImages(paths) {
  const out = [];
  for (const p of paths) {
    const abs = assertFile(p, '图片');
    const bytes = await fsp.readFile(abs);
    const type = sniffImageType(bytes);
    if (!type) throw new Error(`图片不是 PNG/JPG，pdf-lib 不能直接嵌入：${abs}`);
    out.push({ bytes, type });
  }
  if (out.length === 0) throw new Error('images 不能为空');
  return out;
}

async function writePdf(target, bytes) {
  await fsp.writeFile(target, Buffer.from(bytes));
  return target;
}

export const imagesToPdfTool = {
  name: 'pdf_images_to_pdf',
  description: '把多张 PNG/JPG 图片按顺序合成一份 PDF，每张一页。可选原尺寸或 A4 居中。',
  inputSchema: {
    type: 'object',
    required: ['images'],
    properties: {
      images: { type: 'array', items: { type: 'string' }, minItems: 1, description: '图片路径列表（顺序即页序）' },
      output: { type: 'string', description: '可选：输出 PDF 路径（重名自动加序号）' },
      output_dir: { type: 'string', description: '可选：输出目录（默认第一张图同目录）' },
      base_name: { type: 'string', description: '可选：输出文件名（不含扩展名）' },
      page_mode: { type: 'string', enum: ['original', 'a4'], description: 'original=按图片尺寸；a4=缩放到 A4，默认 original' },
      margin: { type: 'number', minimum: 0, description: 'A4 模式的页边距（PDF 点），默认 0' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const list = Array.isArray(args.images) ? args.images : [];
    const images = await readImages(list);
    const bytes = await imagesToPdf(images, {
      pageMode: args.page_mode === 'a4' ? 'a4' : 'original',
      margin: Number(args.margin) || 0
    });
    const target = resolveOutputPath({
      output: args.output,
      output_dir: args.output_dir,
      base_name: args.base_name || '图片合成',
      ext: '.pdf',
      fallbackDir: path.dirname(path.resolve(list[0]))
    });
    await writePdf(target.path, bytes);
    return { ok: true, output: target.path, pages: images.length, size: (await fsp.stat(target.path)).size };
  }
};

export const mergeTool = {
  name: 'pdf_merge',
  description: '按顺序合并多份 PDF，生成一份新 PDF。',
  inputSchema: {
    type: 'object',
    required: ['pdfs'],
    properties: {
      pdfs: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'PDF 路径列表（顺序即合并顺序）' },
      output: { type: 'string', description: '可选：输出 PDF 路径（重名自动加序号）' },
      output_dir: { type: 'string', description: '可选：输出目录（默认第一个 PDF 同目录）' },
      base_name: { type: 'string', description: '可选：输出文件名（不含扩展名）' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const list = (Array.isArray(args.pdfs) ? args.pdfs : []).map((p) => assertFile(p, 'PDF'));
    if (list.length === 0) throw new Error('pdfs 不能为空');
    const buffers = [];
    for (const p of list) buffers.push(new Uint8Array(await fsp.readFile(p)));
    const bytes = await mergePdfs(buffers);
    const target = resolveOutputPath({
      output: args.output,
      output_dir: args.output_dir,
      base_name: args.base_name || '合并结果',
      ext: '.pdf',
      fallbackDir: path.dirname(list[0])
    });
    await writePdf(target.path, bytes);
    return { ok: true, output: target.path, files: list.length, size: (await fsp.stat(target.path)).size };
  }
};

export const splitTool = {
  name: 'pdf_split',
  description: '把一份 PDF 按「每 N 页」拆成多个 PDF。',
  inputSchema: {
    type: 'object',
    required: ['pdf'],
    properties: {
      pdf: { type: 'string', description: '源 PDF 路径' },
      every_n: { type: 'integer', minimum: 1, description: '每几页一个文件，默认 1' },
      output_dir: { type: 'string', description: '可选：输出目录（默认源 PDF 同目录）' },
      base_name: { type: 'string', description: '可选：输出文件名前缀（默认源文件名）' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const src = assertFile(args.pdf, 'PDF');
    const everyN = Number.isInteger(args.every_n) && args.every_n > 0 ? args.every_n : 1;
    const outDir = assertDir(args.output_dir || path.dirname(src), '输出目录');
    const base = args.base_name || path.basename(src, path.extname(src));
    const bytes = new Uint8Array(await fsp.readFile(src));
    const parts = await splitPdf(bytes, { everyN });
    const outputs = [];
    for (const part of parts) {
      const target = uniqueTargetPath(outDir, `${base}_${part.start}-${part.end}`, '.pdf');
      await writePdf(target, part.bytes);
      outputs.push(target);
    }
    return { ok: true, outputs, parts: parts.length };
  }
};

export const extractPagesTool = {
  name: 'pdf_extract_pages',
  description: '从 PDF 中提取指定页（页码从 1 起，顺序即输出顺序，可重复），生成一份新 PDF。',
  inputSchema: {
    type: 'object',
    required: ['pdf', 'pages'],
    properties: {
      pdf: { type: 'string', description: '源 PDF 路径' },
      pages: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, description: '页码列表（1 起）' },
      output: { type: 'string', description: '可选：输出 PDF 路径（重名自动加序号）' },
      output_dir: { type: 'string', description: '可选：输出目录（默认源 PDF 同目录）' },
      base_name: { type: 'string', description: '可选：输出文件名（不含扩展名）' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const src = assertFile(args.pdf, 'PDF');
    const pages = (Array.isArray(args.pages) ? args.pages : []).filter((n) => Number.isInteger(n) && n > 0);
    if (pages.length === 0) throw new Error('pages 不能为空');
    const bytes = new Uint8Array(await fsp.readFile(src));
    const out = await extractPages(bytes, pages);
    const target = resolveOutputPath({
      output: args.output,
      output_dir: args.output_dir,
      base_name: args.base_name || `${path.basename(src, path.extname(src))}_提取页`,
      ext: '.pdf',
      fallbackDir: path.dirname(src)
    });
    await writePdf(target.path, out);
    return { ok: true, output: target.path, pages, size: (await fsp.stat(target.path)).size };
  }
};

export const pageCountTool = {
  name: 'pdf_page_count',
  description: '读取 PDF 页数（不修改内容）。',
  inputSchema: {
    type: 'object',
    required: ['pdf'],
    properties: { pdf: { type: 'string', description: 'PDF 路径' } },
    additionalProperties: false
  },
  async handler(args = {}) {
    const src = assertFile(args.pdf, 'PDF');
    const bytes = new Uint8Array(await fsp.readFile(src));
    return { ok: true, pdf: src, pages: await getPageCount(bytes) };
  }
};

export const pdfToImagesTool = {
  name: 'pdf_to_images',
  description: '把 PDF 每页渲染成图片（PNG/JPG），可指定页码、渲染倍率、画质。',
  inputSchema: {
    type: 'object',
    required: ['input'],
    properties: {
      input: { type: 'string', description: '源 PDF' },
      pages: {
        oneOf: [
          { type: 'array', items: { type: 'integer', minimum: 1 } },
          { type: 'string', description: '页码范围，如 "1-3,5"' }
        ],
        description: '可选：要渲染的页（默认全部）'
      },
      scale: { type: 'number', minimum: 0.5, maximum: 4, description: '渲染倍率，默认 2（约 144DPI）' },
      format: { type: 'string', enum: ['png', 'jpg'], description: '输出格式，默认 png' },
      quality: { type: 'integer', minimum: 1, maximum: 100, description: 'JPG 画质' },
      output_dir: { type: 'string', description: '可选：输出目录（默认源 PDF 同目录）' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const input = assertFile(args.input, 'PDF');
    const bytes = new Uint8Array(await fsp.readFile(input));
    const pdf = await openPdfNode(bytes);
    try {
      const total = pdf.numPages;
      let pages;
      if (Array.isArray(args.pages) && args.pages.length) pages = args.pages.filter((n) => Number.isInteger(n) && n >= 1 && n <= total);
      else if (typeof args.pages === 'string' && args.pages.trim()) pages = parsePageRange(args.pages, total);
      else pages = Array.from({ length: total }, (_, i) => i + 1);
      if (pages.length === 0) throw new Error('没有可渲染的页');

      const fmt = args.format === 'jpg' ? 'jpg' : 'png';
      const quality = Math.max(1, Math.min(100, Number(args.quality) || 92));
      const outDir = assertDir(args.output_dir || path.dirname(input), '输出目录');
      const base = path.basename(input, path.extname(input));
      const outputs = [];
      for (const pageNo of pages) {
        const { canvas, width, height } = await renderPdfPage(pdf, pageNo, { scale: Number(args.scale) || 2 });
        const target = uniqueTargetPath(outDir, `${base}_第${pageNo}页`, `.${fmt}`);
        await fsp.writeFile(target, canvasToBuffer(canvas, fmt, quality));
        outputs.push({ page: pageNo, output: target, width, height });
      }
      return { ok: true, outputs, pages: outputs.length, format: fmt };
    } finally {
      await closePdfNode(pdf);
    }
  }
};

export const pdfCompressTool = {
  name: 'pdf_compress',
  description:
    'PDF 压缩瘦身（扫描件最有效）：按档位把每页重新渲染成 JPEG 再装箱；'
    + ' 可转灰度、可设目标体积（超标自动降档重试）。',
  inputSchema: {
    type: 'object',
    required: ['input'],
    properties: {
      input: { type: 'string', description: '源 PDF' },
      preset: { type: 'string', enum: PDF_COMPRESS_PRESETS.map((p) => p.value), description: '压缩档位，默认 standard' },
      grayscale: { type: 'boolean', description: '是否转灰度（黑白文档更省体积）' },
      max_mb: { type: 'number', minimum: 0.1, description: '可选：目标体积（MB），超标自动降档' },
      pages: {
        oneOf: [
          { type: 'array', items: { type: 'integer', minimum: 1 } },
          { type: 'string' }
        ],
        description: '可选：只处理这些页（输出 PDF 只含这些页）'
      },
      password: { type: 'string', description: '可选：源 PDF 密码' },
      output: { type: 'string', description: '可选：输出 PDF 路径' },
      output_dir: { type: 'string', description: '可选：输出目录' },
      base_name: { type: 'string', description: '可选：输出文件名' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const input = assertFile(args.input, 'PDF');
    const sourceBytes = new Uint8Array(await fsp.readFile(input));
    const originalBytes = sourceBytes.length;
    const pdf = await openPdfNode(sourceBytes, { password: args.password || '' });
    try {
      const total = pdf.numPages;
      let targets;
      if (Array.isArray(args.pages) && args.pages.length) targets = args.pages.filter((n) => Number.isInteger(n) && n >= 1 && n <= total);
      else if (typeof args.pages === 'string' && args.pages.trim()) targets = parsePageRange(args.pages, total);
      else targets = Array.from({ length: total }, (_, i) => i + 1);
      if (targets.length === 0) throw new Error('没有可处理的页');

      const start = presetOf(args.preset || 'standard');
      const order = PDF_COMPRESS_PRESETS.map((p) => p.value);
      const ladder = PDF_COMPRESS_PRESETS.slice(Math.max(0, order.indexOf(start.value)));
      const maxBytes = Number(args.max_mb) > 0 ? Number(args.max_mb) * 1024 * 1024 : 0;
      let last = null;
      let attempt = 0;

      for (const cfg of ladder) {
        attempt += 1;
        const out = await PDFDocument.create();
        for (const pageNo of targets) {
          const rendered = await renderPdfPage(pdf, pageNo, { scale: cfg.scale });
          let canvas = rendered.canvas;
          if (args.grayscale) {
            const pixels = canvasToPixels(canvas);
            for (let i = 0; i < pixels.length; i += 4) {
              const g = Math.round(0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]);
              pixels[i] = g; pixels[i + 1] = g; pixels[i + 2] = g;
            }
            canvas = pixelsToCanvas(pixels, rendered.width, rendered.height);
          }
          const jpg = canvas.toBuffer('image/jpeg', cfg.quality);
          const img = await out.embedJpg(jpg);
          const page = out.addPage([rendered.viewport.width, rendered.viewport.height]);
          page.drawImage(img, { x: 0, y: 0, width: rendered.viewport.width, height: rendered.viewport.height });
        }
        const bytes = await out.save();
        last = { bytes, preset: cfg.value, scale: cfg.scale, quality: cfg.quality, attempt };
        if (!maxBytes || bytes.length <= maxBytes) break;
        if (cfg === ladder[ladder.length - 1]) break;
      }

      const base = args.base_name || `${path.basename(input, path.extname(input))}_压缩`;
      const target = resolveOutputPath({
        output: args.output,
        output_dir: args.output_dir,
        base_name: base,
        ext: '.pdf',
        fallbackDir: path.dirname(input)
      });
      await fsp.writeFile(target.path, Buffer.from(last.bytes));
      return {
        ok: true,
        output: target.path,
        before: originalBytes,
        after: last.bytes.length,
        pages: targets.length,
        preset: last.preset,
        scale: last.scale,
        quality: last.quality,
        attempts: attempt,
        grayscale: !!args.grayscale,
        reached_target: maxBytes ? last.bytes.length <= maxBytes : null
      };
    } finally {
      await closePdfNode(pdf);
    }
  }
};

export default [imagesToPdfTool, mergeTool, splitTool, extractPagesTool, pageCountTool, pdfToImagesTool, pdfCompressTool];
