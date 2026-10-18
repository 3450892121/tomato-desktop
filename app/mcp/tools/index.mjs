// MCP 工具注册表（第一批：纯 Node，不需要 Electron）
import obfuscate from './obfuscate.mjs';
import imghide from './imghide.mjs';
import archive from './archive.mjs';
import pdf from './pdf.mjs';
import rename from './rename.mjs';
import videodl from './videodl.mjs';
import media from './media.mjs';
import ocr from './ocr.mjs';
import asr from './asr.mjs';
import pdfEdit from './pdf-edit.mjs';
import image from './image.mjs';
import office from './office.mjs';

const groups = [obfuscate, imghide, archive, pdf, pdfEdit, rename, media, ocr, asr, image, office, videodl];

/** 扁平化后的工具列表（每个元素：{name, description, inputSchema, handler}） */
export const tools = groups.flatMap((g) => (Array.isArray(g) ? g : [g]));

/**
 * 只读模式（TOMATO_MCP_READONLY=1）下允许的工具：
 * 只返回信息、不写盘。其余工具在只读模式下既不列出、也拒绝调用。
 */
const READONLY_TOOLS = new Set([
  'media_probe',
  'pdf_page_count',
  'archive_list',
  'ocr_status',
  'ocr_recognize',
  'asr_status',
  'libreoffice_status',
  'video_download_status'
]);

export function isReadOnlyMode() {
  const v = String(process.env.TOMATO_MCP_READONLY || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** 当前模式下可见的工具（只读模式会过滤掉写操作） */
export function visibleTools() {
  return isReadOnlyMode() ? tools.filter((t) => READONLY_TOOLS.has(t.name)) : tools;
}

/** 按名字找工具（只读模式下拒绝写工具） */
export function findTool(name) {
  const tool = tools.find((t) => t.name === name) || null;
  if (!tool) return null;
  if (isReadOnlyMode() && !READONLY_TOOLS.has(tool.name)) return null;
  return tool;
}

/** tools/list 只需要元数据，不要把 handler 暴露给客户端 */
export function publicToolList() {
  return visibleTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }));
}
