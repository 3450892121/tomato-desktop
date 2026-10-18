// MCP 工具：文档格式转换 / Office→PDF / PDF→Word（LibreOffice）
// 规则复用 src/tools/doc-convert/core/plan.mjs；执行走 MCP 自己的 LibreOffice runner。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { planOne, TARGETS } from '../../src/tools/doc-convert/core/plan.mjs';
import { convertWithLibreOffice, libreofficeStatus } from '../lib/libreoffice-runner.mjs';
import { assertFile, assertDir, resolveOutputPath, uniqueTargetPath } from '../lib/paths.mjs';

export const statusTool = {
  name: 'libreoffice_status',
  description: '检查 LibreOffice 加装包是否就绪（文档转换/Office→PDF/PDF→Word 需要）。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler() {
    return { ok: true, ...libreofficeStatus() };
  }
};

export const docConvertTool = {
  name: 'doc_convert',
  description:
    '老版办公文档转换：doc/xls/ppt/pps/rtf → docx/xlsx/pptx/PDF；也支持已是新格式的文档转 PDF。'
    + ' 智能模式（auto）会把老格式转成对应的新格式。',
  inputSchema: {
    type: 'object',
    required: ['inputs', 'target', 'output_dir'],
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, minItems: 1, description: '文档文件' },
      target: { type: 'string', enum: TARGETS.map((t) => t.value), description: '输出目标' },
      output_dir: { type: 'string', description: '输出目录' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    if (!libreofficeStatus().found) throw new Error('未检测到 LibreOffice（把 addons/libreoffice 放回软件目录）');
    const outDir = assertDir(args.output_dir, '输出目录');
    await fsp.mkdir(outDir, { recursive: true });
    const outputs = [];
    for (const raw of Array.isArray(args.inputs) ? args.inputs : []) {
      const input = assertFile(raw, '文档');
      const ext = path.extname(input).toLowerCase();
      const plan = planOne(ext, { target: args.target });
      if (!plan.ok) throw new Error(`${path.basename(input)}：${plan.reason}`);
      const res = await convertWithLibreOffice({ inputPath: input, target: plan.target });
      if (!res.ok) throw new Error(res.message);
      const base = path.basename(input, path.extname(input));
      const target = uniqueTargetPath(outDir, base, plan.ext);
      await fsp.writeFile(target, res.bytes);
      outputs.push({ input, output: target, size: res.bytes.length, target: plan.target });
    }
    return { ok: true, outputs };
  }
};

export const officeToPdfTool = {
  name: 'pdf_office_to_pdf',
  description: 'Word/Excel/PPT 文档 → PDF（LibreOffice 高保真转换）。',
  inputSchema: {
    type: 'object',
    required: ['input'],
    properties: {
      input: { type: 'string', description: '源文档' },
      output: { type: 'string', description: '可选：输出 PDF 路径（重名自动加序号）' },
      output_dir: { type: 'string', description: '可选：输出目录（默认源文件同目录）' },
      base_name: { type: 'string', description: '可选：输出文件名（不含扩展名）' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const input = assertFile(args.input, '文档');
    const res = await convertWithLibreOffice({ inputPath: input, target: 'pdf' });
    if (!res.ok) throw new Error(res.message);
    const target = resolveOutputPath({
      output: args.output,
      output_dir: args.output_dir,
      base_name: args.base_name || path.basename(input, path.extname(input)),
      ext: '.pdf',
      fallbackDir: path.dirname(input)
    });
    await fsp.writeFile(target.path, res.bytes);
    return { ok: true, output: target.path, size: res.bytes.length, ms: res.ms };
  }
};

export const pdfToWordTool = {
  name: 'pdf_to_word',
  description: 'PDF → Word（docx）。mode=layout 保真排版；mode=text 把浮动文本框压平成可编辑段落。',
  inputSchema: {
    type: 'object',
    required: ['input'],
    properties: {
      input: { type: 'string', description: '源 PDF' },
      mode: { type: 'string', enum: ['layout', 'text'], description: '排版模式，默认 layout' },
      output: { type: 'string', description: '可选：输出 docx 路径（重名自动加序号）' },
      output_dir: { type: 'string', description: '可选：输出目录（默认源 PDF 同目录）' },
      base_name: { type: 'string', description: '可选：输出文件名（不含扩展名）' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const input = assertFile(args.input, 'PDF');
    const res = await convertWithLibreOffice({
      inputPath: input,
      target: 'docx',
      mode: args.mode === 'text' ? 'text' : 'layout'
    });
    if (!res.ok) throw new Error(res.message);
    const target = resolveOutputPath({
      output: args.output,
      output_dir: args.output_dir,
      base_name: args.base_name || path.basename(input, path.extname(input)),
      ext: '.docx',
      fallbackDir: path.dirname(input)
    });
    await fsp.writeFile(target.path, res.bytes);
    return { ok: true, output: target.path, size: res.bytes.length, ms: res.ms, flatten: res.flatten };
  }
};

export default [statusTool, docConvertTool, officeToPdfTool, pdfToWordTool];
