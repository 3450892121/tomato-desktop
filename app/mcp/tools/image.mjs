// MCP 工具：图片压缩 / 变清晰 / 格式转换 / 加水印 / 长图拼接 / 九宫格切图
// 这些能力在 GUI 里依赖 OffscreenCanvas；MCP 用 @napi-rs/canvas 在 Node 里等价重实现。
// 原则：布局/规则/参数仍复用各工具 core/ 的纯函数，只有「画像素」这一层换实现。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { computeTargetSize, autoFormat } from '../../src/tools/compress/core/compress.js';
import { computeCells, namingForCells } from '../../src/tools/grid-slice/core/plan.js';
import { normalizeSizes, computeLayout, STITCH_DIRECTIONS, ALIGN_PRESETS } from '../../src/tools/stitch/core/plan.js';
import {
  WATERMARK_DEFAULTS, drawTextWatermark, drawImageWatermark,
  anchorRect, tilePositions, computeFontSize, measureTextWidth, escapeForMeasure,
  TEXT_FONT_FAMILY, contrastStrokeColor
} from '../../src/tools/watermark/core/draw.js';
import { PRESETS, presetById, applyEnhance, outputExtFor } from '../../src/tools/enhance/core/enhance.js';
import {
  TARGETS, targetInfo, needsFfmpeg, hasQuality, defaultQuality, fitLongEdge,
  outputBaseName, ffmpegArgs, pickIcoSizes, encodeIco
} from '../../src/tools/convert/core/convert.js';
import { encodeBmp } from '../../src/tools/convert/core/encoders.js';
import { decodeImageFile } from '../lib/image-node.mjs';
import {
  pixelsToCanvas, canvasToPixels, canvasToBuffer, loadCanvas, resizePixels, blurPixels
} from '../lib/canvas-ops.mjs';
import { appRoot, assertFile, resolveOutputPath, uniqueTargetPath } from '../lib/paths.mjs';
import { convertFile } from '../lib/ffmpeg-runner.mjs';

const QUALITIES = ['high', 'standard', 'small'];
const IMAGE_DECODABLE = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
const FFMPEG_INPUT = ['.tif', '.tiff', '.pcx', '.tga', '.psd', '.dds', '.jp2', '.j2k', '.heic', '.heif', '.hif', '.svg'];

function extOf(p) {
  return path.extname(p).toLowerCase();
}

function formatOf(ext) {
  return ext === '.jpg' || ext === '.jpeg' ? 'jpg'
    : ext === '.webp' ? 'webp'
      : ext === '.bmp' ? 'bmp'
        : ext === '.gif' ? 'gif'
          : 'png';
}

/** 把任意输入先变成 Canvas；Canvas 解不了的冷门格式先经 ffmpeg 出 PNG */
async function loadCanvasAny(file) {
  const ext = extOf(file);
  if (IMAGE_DECODABLE.includes(ext)) return loadCanvas(file);
  if (ext === '.heic' || ext === '.heif' || ext === '.hif') {
    const decode = (await import('heic-decode')).default;
    const { width, height, data } = await decode({ buffer: await fsp.readFile(file) });
    return pixelsToCanvas(data, width, height);
  }
  if (FFMPEG_INPUT.includes(ext)) {
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'tomato-mcp-img-'));
    try {
      const res = await convertFile({
        inputPath: file, outputDir: work, baseName: 'decoded', ext: '.png',
        args: ['-frames:v', '1']
      });
      if (!res.ok) throw new Error(res.message);
      return await loadCanvas(res.path);
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
  return loadCanvas(file);
}

export const compressTool = {
  name: 'image_compress',
  description:
    '批量压缩图片：可调输出格式（PNG/JPG/WebP）、画质、最长边、百分比、目标体积。'
    + ' 目标体积用二分画质逼近；PNG 压不动时会如实说明。',
  inputSchema: {
    type: 'object',
    required: ['inputs'],
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, minItems: 1, description: '要压缩的图片' },
      format: { type: 'string', enum: ['auto', 'png', 'jpg', 'webp'], description: '输出格式，默认 auto' },
      quality: { type: 'integer', minimum: 1, maximum: 100, description: '画质（JPG/WebP）' },
      longest_edge: { type: 'integer', minimum: 1, description: '最长边像素（只缩不放）' },
      percent: { type: 'number', minimum: 1, maximum: 100, description: '缩放到原图百分比' },
      target_bytes: { type: 'integer', minimum: 1, description: '目标字节数（二分画质逼近）' },
      output_dir: { type: 'string', description: '可选：输出目录' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const outputs = [];
    for (const raw of Array.isArray(args.inputs) ? args.inputs : []) {
      const input = assertFile(raw, '图片');
      const before = fs.statSync(input).size;
      const ext = extOf(input);
      const fmt = args.format && args.format !== 'auto' ? args.format : autoFormat(ext);
      const { pixels, width, height } = await decodeImageFile(input);
      const size = computeTargetSize(width, height, {
        longestEdge: Number(args.longest_edge) || 0,
        percent: Number(args.percent) || 0
      });
      const background = fmt === 'jpg' ? '#ffffff' : null;
      const canvas = resizePixels(pixels, width, height, size.width, size.height, background);

      let bytes;
      let usedQuality = Number(args.quality) || 82;
      let note = '';
      if (Number(args.target_bytes) > 0 && fmt !== 'png') {
        const target = Number(args.target_bytes);
        const at = (q) => canvasToBuffer(canvas, fmt, q);
        const hi = at(95);
        if (hi.length <= target) { bytes = hi; usedQuality = 95; }
        else {
          const lo = at(20);
          if (lo.length > target) {
            // 20 都超标：在 1~20 里继续找最小的，仍不达标就如实说明
            let best = lo;
            for (let q = 1; q < 20; q += 1) {
              const b = at(q);
              if (b.length < best.length) best = b;
            }
            bytes = best;
            usedQuality = 1;
            note = `已尽量压缩，仍未达到目标体积（${best.length} > ${target} 字节）`;
          } else {
            let low = 20;
            let high = 95;
            let best = { bytes: lo, quality: 20 };
            while (low <= high) {
              const mid = Math.round((low + high) / 2);
              const b = at(mid);
              if (b.length <= target) { best = { bytes: b, quality: mid }; low = mid + 1; }
              else high = mid - 1;
            }
            bytes = best.bytes;
            usedQuality = best.quality;
          }
        }
      } else {
        bytes = canvasToBuffer(canvas, fmt, usedQuality);
        if (Number(args.target_bytes) > 0 && fmt === 'png') {
          note = 'PNG 是无损格式，画质参数无效；要压到目标体积请改用 JPG/WebP';
        }
      }

      const base = path.basename(input, path.extname(input));
      const target = resolveOutputPath({
        output_dir: args.output_dir,
        base_name: `${base}_压缩`,
        ext: `.${fmt}`,
        fallbackDir: path.dirname(input)
      });
      await fsp.writeFile(target.path, bytes);
      outputs.push({
        input, output: target.path, before, after: bytes.length,
        width: size.width, height: size.height, format: fmt, quality: usedQuality,
        note
      });
    }
    return { ok: true, outputs };
  }
};

export const sliceTool = {
  name: 'image_slice',
  description: '九宫格/自定义切图：按行列切分图片，可调间距、留白、切缝颜色、编号顺序。',
  inputSchema: {
    type: 'object',
    required: ['input', 'rows', 'cols'],
    properties: {
      input: { type: 'string', description: '要切的图片' },
      rows: { type: 'integer', minimum: 1, maximum: 20, description: '行数' },
      cols: { type: 'integer', minimum: 1, maximum: 20, description: '列数' },
      gap: { type: 'integer', minimum: 0, description: '块与块之间的切缝像素' },
      margin: { type: 'integer', minimum: 0, description: '外圈留白像素' },
      seam_color: { type: 'string', description: '可选：切缝颜色（如 #ffffff）' },
      order: { type: 'string', enum: ['row', 'column'], description: '编号顺序，默认 row' },
      format: { type: 'string', enum: ['png', 'jpg'], description: '输出格式，默认 png' },
      quality: { type: 'integer', minimum: 1, maximum: 100, description: 'JPG 画质' },
      output_dir: { type: 'string', description: '可选：输出目录' },
      base_name: { type: 'string', description: '可选：文件名前缀' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const input = assertFile(args.input, '图片');
    const rows = Math.max(1, Math.min(20, Number(args.rows) || 1));
    const cols = Math.max(1, Math.min(20, Number(args.cols) || 1));
    const gap = Math.max(0, Number(args.gap) || 0);
    const margin = Math.max(0, Number(args.margin) || 0);
    const fmt = args.format === 'jpg' ? 'jpg' : 'png';
    const quality = Math.max(1, Math.min(100, Number(args.quality) || 92));
    const src = await loadCanvas(input);
    const realPlan = computeCells({ width: src.width, height: src.height, rows, cols, gap, margin });
    if (realPlan.cells.length === 0) throw new Error(realPlan.warnings[0] || '图片太小，无法切分');

    const outDir = path.resolve(args.output_dir || path.dirname(input));
    await fsp.mkdir(outDir, { recursive: true });
    const base = args.base_name || path.basename(input, path.extname(input));
    const names = namingForCells({ baseName: base, rows, cols, order: args.order === 'column' ? 'column' : 'row' });
    const half = Math.max(0, Math.floor((Math.min(realPlan.outW, realPlan.outH) - 1) / 2));
    const band = gap > 0 && args.seam_color ? Math.min(Math.max(1, Math.round(gap / 2)), half) : 0;
    const outputs = [];

    for (const cell of realPlan.cells) {
      const left = cell.col > 0 ? band : 0;
      const right = cell.col < cols - 1 ? band : 0;
      const top = cell.row > 0 ? band : 0;
      const bottom = cell.row < rows - 1 ? band : 0;
      const canvas = createCanvas(realPlan.outW, realPlan.outH);
      const ctx = canvas.getContext('2d');
      if (fmt === 'jpg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, realPlan.outW, realPlan.outH); }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, cell.sx, cell.sy, cell.sw, cell.sh, left, top,
        realPlan.outW - left - right, realPlan.outH - top - bottom);
      if (band > 0) {
        ctx.fillStyle = args.seam_color;
        if (left) ctx.fillRect(0, 0, left, realPlan.outH);
        if (right) ctx.fillRect(realPlan.outW - right, 0, right, realPlan.outH);
        if (top) ctx.fillRect(0, 0, realPlan.outW, top);
        if (bottom) ctx.fillRect(0, realPlan.outH - bottom, realPlan.outW, bottom);
      }
      const target = uniqueTargetPath(outDir, names[cell.index - 1], `.${fmt}`);
      await fsp.writeFile(target, canvasToBuffer(canvas, fmt, quality));
      outputs.push({ index: cell.index, output: target, width: realPlan.outW, height: realPlan.outH });
    }
    return { ok: true, outputs, rows, cols, outW: realPlan.outW, outH: realPlan.outH };
  }
};

export const stitchTool = {
  name: 'image_stitch',
  description: '长图拼接：竖拼/横拼，可统一尺寸、对齐、间距、外边距；不放大、只缩小。',
  inputSchema: {
    type: 'object',
    required: ['inputs'],
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, minItems: 1, description: '按顺序拼接的图片' },
      direction: { type: 'string', enum: STITCH_DIRECTIONS.map((d) => d.value), description: '竖拼/横拼' },
      mode: { type: 'string', enum: ['none', 'unify'], description: 'none=保持原样；unify=统一尺寸' },
      target_size: { type: 'integer', minimum: 1, description: '统一宽度（竖拼）或统一高度（横拼）' },
      gap: { type: 'integer', minimum: 0, description: '图片间距' },
      align: { type: 'string', enum: ALIGN_PRESETS.map((a) => a.value), description: '对齐方式' },
      margin: { type: 'integer', minimum: 0, description: '外边距' },
      format: { type: 'string', enum: ['png', 'jpg'], description: '输出格式' },
      quality: { type: 'integer', minimum: 1, maximum: 100, description: 'JPG 画质' },
      output_dir: { type: 'string', description: '可选：输出目录' },
      base_name: { type: 'string', description: '可选：输出文件名' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const inputs = (Array.isArray(args.inputs) ? args.inputs : []).map((p) => assertFile(p, '图片'));
    if (inputs.length === 0) throw new Error('inputs 不能为空');
    const meta = [];
    for (const p of inputs) {
      const img = await loadImage(await fsp.readFile(p));
      meta.push({ width: img.width, height: img.height });
    }
    const direction = args.direction === 'horizontal' ? 'horizontal' : 'vertical';
    const mode = args.mode === 'unify' ? 'unify' : 'none';
    const targetSize = Number(args.target_size) || 0;
    const gap = Math.max(0, Number(args.gap) || 0);
    const margin = Math.max(0, Number(args.margin) || 0);
    const align = ['center', 'start', 'end'].includes(args.align) ? args.align : 'center';
    const fmt = args.format === 'jpg' ? 'jpg' : 'png';
    const quality = Math.max(1, Math.min(100, Number(args.quality) || 92));

    const sizes = normalizeSizes({ items: meta, direction, mode, targetSize });
    const layout = computeLayout({ sizes, direction, gap, align, margin });
    if (layout.limitExceeded) throw new Error(layout.reason);

    const canvas = createCanvas(layout.canvasW, layout.canvasH);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, layout.canvasW, layout.canvasH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (let i = 0; i < inputs.length; i += 1) {
      const src = await loadCanvas(inputs[i]);
      const o = layout.offsets[i];
      ctx.drawImage(src, o.x, o.y, o.w, o.h);
    }

    const base = args.base_name || '长图拼接';
    const target = resolveOutputPath({
      output_dir: args.output_dir,
      base_name: base,
      ext: `.${fmt}`,
      fallbackDir: path.dirname(inputs[0])
    });
    await fsp.writeFile(target.path, canvasToBuffer(canvas, fmt, quality));
    return {
      ok: true, output: target.path, width: layout.canvasW, height: layout.canvasH,
      images: inputs.length, direction, format: fmt
    };
  }
};

function placeWatermarks(ctx, { canvasW, canvasH, itemW, itemH, position, margin, tileGapRatio }, drawOne) {
  if (position === 'tile') {
    const gapX = Math.round(itemW * (Number(tileGapRatio) || WATERMARK_DEFAULTS.tileGapRatio));
    const gapY = Math.round(itemH * (Number(tileGapRatio) || WATERMARK_DEFAULTS.tileGapRatio));
    const positions = tilePositions({ canvasW, canvasH, itemW, itemH, gapX, gapY });
    for (const p of positions) drawOne(ctx, p.x, p.y);
    return positions.length;
  }
  const rect = anchorRect({ canvasW, canvasH, itemW, itemH, position, margin });
  drawOne(ctx, rect.x, rect.y);
  return 1;
}

export const watermarkTool = {
  name: 'image_watermark',
  description: '给图片加水印：文字或图片印章；九宫格/平铺、字号、透明度、旋转、描边。',
  inputSchema: {
    type: 'object',
    required: ['input'],
    properties: {
      input: { type: 'string', description: '原图' },
      type: { type: 'string', enum: ['text', 'image'], description: '水印类型，默认 text' },
      text: { type: 'string', description: '文字水印内容（可含换行）' },
      stamp: { type: 'string', description: '图片水印的印章图片路径' },
      position: {
        type: 'string',
        enum: ['top-left', 'top-center', 'top-right', 'middle-left', 'center', 'middle-right',
          'bottom-left', 'bottom-center', 'bottom-right', 'tile'],
        description: '位置，默认 bottom-right'
      },
      size_percent: { type: 'number', minimum: 1, maximum: 100, description: '字号/印章宽度占图宽百分比' },
      opacity: { type: 'number', minimum: 0, maximum: 100, description: '透明度 0~100' },
      rotation: { type: 'number', description: '旋转角度（度）' },
      color: { type: 'string', description: '文字颜色（#rrggbb）' },
      stroke: { type: 'boolean', description: '是否描边' },
      stroke_color: { type: 'string', description: '描边颜色' },
      margin_percent: { type: 'number', minimum: 0, maximum: 25, description: '九宫格边距占短边百分比' },
      tile_gap_ratio: { type: 'number', minimum: 0, description: '平铺间距比例' },
      format: { type: 'string', enum: ['png', 'jpg'], description: '输出格式' },
      quality: { type: 'integer', minimum: 1, maximum: 100, description: 'JPG 画质' },
      output_dir: { type: 'string', description: '可选：输出目录' },
      base_name: { type: 'string', description: '可选：输出文件名' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const input = assertFile(args.input, '原图');
    const src = await loadCanvas(input);
    const width = src.width;
    const height = src.height;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(src, 0, 0, width, height);

    const type = args.type === 'image' ? 'image' : 'text';
    const opacity = args.opacity == null ? WATERMARK_DEFAULTS.opacity : args.opacity;
    const rotation = Number(args.rotation) || 0;
    const marginPercent = args.margin_percent == null ? WATERMARK_DEFAULTS.marginPercent : args.margin_percent;
    const margin = Math.max(0, Math.round((Math.min(width, height) * Math.min(25, Math.max(0, marginPercent))) / 100));
    const sizePercent = args.size_percent == null ? WATERMARK_DEFAULTS.sizePercent : args.size_percent;
    const tileGapRatio = args.tile_gap_ratio == null ? WATERMARK_DEFAULTS.tileGapRatio : args.tile_gap_ratio;
    const position = args.position || WATERMARK_DEFAULTS.position;

    if (type === 'image') {
      const stampPath = assertFile(args.stamp, '印章图片');
      const stamp = await loadImage(await fsp.readFile(stampPath));
      const dw = Math.max(1, Math.round((width * Math.max(1, Math.min(100, sizePercent))) / 100));
      const dh = Math.max(1, Math.round((dw * stamp.height) / stamp.width));
      placeWatermarks(ctx, { canvasW: width, canvasH: height, itemW: dw, itemH: dh, position, margin, tileGapRatio },
        (c, x, y) => drawImageWatermark(c, {
          bitmap: stamp, x: x + dw / 2, y: y + dh / 2, width: dw, height: dh, opacity, rotation
        }));
    } else {
      const text = escapeForMeasure(args.text || '');
      if (!String(text).trim()) throw new Error('文字水印：请输入 text');
      const fontSize = computeFontSize({ canvasW: width, baseSizePercent: sizePercent });
      const font = `700 ${fontSize}px ${TEXT_FONT_FAMILY}`;
      const lineHeight = fontSize * 1.25;
      ctx.font = font;
      const lines = String(text).split('\n');
      const itemW = Math.max(1, Math.ceil(Math.max(...lines.map((l) => measureTextWidth(ctx, l)))));
      const itemH = Math.max(1, Math.ceil(lineHeight * lines.length));
      const color = args.color || WATERMARK_DEFAULTS.color;
      const strokeColor = args.stroke_color || contrastStrokeColor(color);
      const strokeWidth = Math.max(1, Math.round((fontSize * (args.stroke_width_percent == null
        ? WATERMARK_DEFAULTS.strokeWidthPercent : args.stroke_width_percent)) / 100));
      placeWatermarks(ctx, { canvasW: width, canvasH: height, itemW, itemH, position, margin, tileGapRatio },
        (c, x, y) => drawTextWatermark(c, {
          text, x: x + itemW / 2, y: y + itemH / 2, font, color,
          opacity, rotation, stroke: args.stroke !== false, strokeColor, strokeWidth, lineHeight
        }));
    }

    const fmt = args.format === 'jpg' ? 'jpg' : 'png';
    if (fmt === 'jpg') {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
    const base = args.base_name || `${path.basename(input, path.extname(input))}_水印`;
    const target = resolveOutputPath({
      output_dir: args.output_dir,
      base_name: base,
      ext: `.${fmt}`,
      fallbackDir: path.dirname(input)
    });
    await fsp.writeFile(target.path, canvasToBuffer(canvas, fmt, args.quality || 92));
    return { ok: true, output: target.path, width, height, type, position, format: fmt };
  }
};

function findRealesrgan() {
  const dir = path.join(appRoot(), 'addons', 'realesrgan');
  const exe = path.join(dir, 'realesrgan-ncnn-vulkan.exe');
  return fs.existsSync(exe) ? { dir, exe } : null;
}

async function runAiUpscale({ input, scale, model, outputDir }) {
  const bin = findRealesrgan();
  if (!bin) throw new Error('未检测到 AI 放大加装包（把 addons/realesrgan 放回软件目录）');
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'tomato-mcp-ai-'));
  const outPath = path.join(work, 'out.png');
  try {
    const args = ['-i', input, '-o', outPath, '-s', String(scale), '-n', model, '-f', 'png'];
    const t0 = Date.now();
    const res = await new Promise((resolve) => {
      const child = spawn(bin.exe, args, { cwd: bin.dir, windowsHide: true });
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* ignore */ } }, 30 * 60 * 1000);
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 200000) stderr = stderr.slice(-100000);
      });
      child.stdout.on('data', () => {});
      child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stderr: String(err.message || err), timedOut }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr, timedOut }); });
    });
    if (res.code !== 0 || !fs.existsSync(outPath)) {
      const vkFail = /vkCreateInstance|Vulkan|no device|failed to create/i.test(res.stderr || '');
      throw new Error(vkFail
        ? '本机显卡不支持 Vulkan（或驱动过旧），AI 放大用不了'
        : `AI 放大失败（退出码 ${res.code}）${String(res.stderr || '').trim().slice(-160)}`);
    }
    const img = await loadImage(await fsp.readFile(outPath));
    const base = path.basename(String(input), path.extname(String(input)));
    const target = uniqueTargetPath(outputDir || path.dirname(String(input)), `${base}_AI放大${scale}x`, '.png');
    const bytes = await fsp.readFile(outPath);
    await fsp.writeFile(target, bytes);
    return { ok: true, output: target, width: img.width, height: img.height, scale, model, ms: Date.now() - t0 };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export const enhanceTool = {
  name: 'image_enhance',
  description:
    '图片变清晰：锐化/降噪/明暗/清晰放大 2×；预设含 AI 放大 4×（需 Vulkan 显卡）。'
    + ' AI 预设会调用随包 Real-ESRGAN。',
  inputSchema: {
    type: 'object',
    required: ['input'],
    properties: {
      input: { type: 'string', description: '原图' },
      preset: { type: 'string', enum: PRESETS.map((p) => p.id), description: '预设 id，默认 auto' },
      params: { type: 'object', description: '可选：覆盖预设参数（sharpen/radius/threshold/denoise/brightness/contrast/saturation/scale）' },
      output_dir: { type: 'string', description: '可选：输出目录' },
      base_name: { type: 'string', description: '可选：输出文件名' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const input = assertFile(args.input, '原图');
    const preset = presetById(args.preset || 'auto');
    const params = { ...preset, ...(args.params || {}) };
    if (preset.ai) {
      const res = await runAiUpscale({
        input, scale: preset.ai.scale, model: preset.ai.model,
        outputDir: args.output_dir ? path.resolve(args.output_dir) : undefined
      });
      return { ...res, preset: preset.id };
    }

    const { pixels, width, height } = await decodeImageFile(input);
    let outPixels = pixels;
    let outW = width;
    let outH = height;
    const scale = Number(params.scale) || 1;
    if (scale > 1) {
      const canvas = resizePixels(pixels, width, height, Math.round(width * scale), Math.round(height * scale), null);
      outPixels = canvasToPixels(canvas);
      outW = canvas.width;
      outH = canvas.height;
    }
    outPixels = await applyEnhance(outPixels, outW, outH, params, blurPixels);

    const ext = outputExtFor(extOf(input));
    const fmt = ext === '.jpg' ? 'jpg' : 'png';
    const base = args.base_name || `${path.basename(input, path.extname(input))}_清晰`;
    const target = resolveOutputPath({
      output_dir: args.output_dir,
      base_name: base,
      ext,
      fallbackDir: path.dirname(input)
    });
    await fsp.writeFile(target.path, canvasToBuffer(pixelsToCanvas(outPixels, outW, outH), fmt, 95));
    return { ok: true, output: target.path, width: outW, height: outH, preset: preset.id, format: fmt };
  }
};

export const convertTool = {
  name: 'image_convert',
  description:
    '图片格式转换：PNG/JPG/WebP/BMP/ICO/TIFF/GIF/AVIF；输入支持 HEIC/HEIF 与 TIFF/PCX/TGA/PSD/DDS/JPEG2000。'
    + ' 可限制最长边；BMP/ICO 用自研编码，TIFF/GIF/AVIF 走随包 ffmpeg。',
  inputSchema: {
    type: 'object',
    required: ['inputs', 'target'],
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, minItems: 1, description: '要转换的图片' },
      target: { type: 'string', enum: TARGETS.map((t) => t.value), description: '输出格式' },
      quality: { type: 'integer', minimum: 1, maximum: 100, description: 'JPG/WebP 画质或 AVIF CRF' },
      max_edge: { type: 'integer', minimum: 1, description: '最长边像素（只缩不放）' },
      output_dir: { type: 'string', description: '可选：输出目录' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const target = TARGETS.find((t) => t.value === args.target);
    if (!target) throw new Error(`不支持的输出格式：${args.target}`);
    const quality = Number.isInteger(args.quality) ? args.quality : defaultQuality(target.value);
    const outputs = [];

    for (const raw of Array.isArray(args.inputs) ? args.inputs : []) {
      const input = assertFile(raw, '图片');
      const base = path.basename(input, path.extname(input));
      const outBase = outputBaseName(base, target.value);

      if (needsFfmpeg(target.value)) {
        const res = await convertFile({
          inputPath: input, outputDir: args.output_dir, baseName: outBase,
          ext: target.ext, args: ffmpegArgs(target.value, quality)
        });
        if (!res.ok) throw new Error(res.message);
        outputs.push({ input, output: res.path, size: res.size, format: target.value });
        continue;
      }

      const canvas0 = await loadCanvasAny(input);
      const fit = fitLongEdge(canvas0.width, canvas0.height, Number(args.max_edge) || 0);
      const canvas = fit.scaled
        ? resizePixels(canvasToPixels(canvas0), canvas0.width, canvas0.height, fit.width, fit.height,
          target.value === 'jpg' ? '#ffffff' : null)
        : canvas0;

      let bytes;
      if (target.value === 'bmp') {
        bytes = Buffer.from(encodeBmp(canvasToPixels(canvas), canvas.width, canvas.height));
      } else if (target.value === 'ico') {
        const sizes = pickIcoSizes(canvas.width, canvas.height);
        const list = [];
        for (const size of sizes) {
          const k = Math.min(size / canvas.width, size / canvas.height);
          const w = Math.max(1, Math.round(canvas.width * k));
          const h = Math.max(1, Math.round(canvas.height * k));
          const dst = createCanvas(size, size);
          const dctx = dst.getContext('2d');
          dctx.imageSmoothingEnabled = true;
          dctx.imageSmoothingQuality = 'high';
          dctx.drawImage(canvas, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
          list.push({ width: size, height: size, bytes: dst.toBuffer('image/png') });
        }
        bytes = Buffer.from(encodeIco(list));
      } else {
        bytes = canvasToBuffer(canvas, target.value, quality);
      }

      const out = resolveOutputPath({
        output_dir: args.output_dir,
        base_name: outBase,
        ext: target.ext,
        fallbackDir: path.dirname(input)
      });
      await fsp.writeFile(out.path, bytes);
      outputs.push({ input, output: out.path, size: bytes.length, format: target.value });
    }
    return { ok: true, target: target.value, outputs };
  }
};

export const aiUpscaleTool = {
  name: 'ai_upscale',
  description: 'AI 超分放大（Real-ESRGAN，需支持 Vulkan 的显卡）；输入 PNG/JPG/WebP，输出 PNG。',
  inputSchema: {
    type: 'object',
    required: ['input'],
    properties: {
      input: { type: 'string', description: '原图' },
      scale: { type: 'integer', enum: [2, 3, 4], description: '放大倍数，默认 4' },
      model: { type: 'string', description: '模型名，默认 realesrgan-x4plus' },
      output_dir: { type: 'string', description: '可选：输出目录' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const input = assertFile(args.input, '原图');
    return runAiUpscale({
      input,
      scale: [2, 3, 4].includes(Number(args.scale)) ? Number(args.scale) : 4,
      model: typeof args.model === 'string' && args.model ? args.model : 'realesrgan-x4plus',
      outputDir: args.output_dir ? path.resolve(args.output_dir) : undefined
    });
  }
};

export default [
  compressTool, enhanceTool, convertTool, watermarkTool, stitchTool, sliceTool, aiUpscaleTool
];
