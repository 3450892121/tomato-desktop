// MCP 工具：文字识别（PP-OCR，纯离线）
// 模型在 addons/ocr/（det.onnx / rec.onnx / dict.txt），运行时 ppu-paddle-ocr 走 ONNX Runtime。
// 第一批 MCP 只接图片输入；扫描版 PDF 需要先渲染成图片（后续 Canvas 批次再接）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { appRoot, assertFile } from '../lib/paths.mjs';

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
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const svc = await getService();
    const t0 = Date.now();
    const r = await svc.recognize(ab);
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

export default [statusTool, recognizeTool];
