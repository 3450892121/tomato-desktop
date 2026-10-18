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

/** 按名字找工具 */
export function findTool(name) {
  return tools.find((t) => t.name === name) || null;
}

/** tools/list 只需要元数据，不要把 handler 暴露给客户端 */
export function publicToolList() {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }));
}
