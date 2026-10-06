// 工具：文档格式转换 —— 转换规则与显示文案（与界面解耦，方便单独测试）
// 目标与范围见 spec/modules/doc-convert.md
// 转换引擎是主进程的 libreoffice:convert（随包 LibreOffice --convert-to）；本文件只负责
// 「哪些文件能转、转成什么」这层规则，保证界面不出现不可能的转换组合。

/** 可接受的输入扩展名（带点、小写）。
 *  注意 .doc/.xls/.ppt 同时涵盖「2003 XML 假扩展名」文件（教务系统导出的内容是 XML 的 .xls 等）——
 *  LibreOffice 按内容识别，扩展名不影响转换；我们这里也只按扩展名收。 */
export const DOC_EXTS = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pps', '.rtf'];

/** 家族：Word 文字 / Excel 表格 / PPT 演示。只有同族之间才谈得上「老格式 → 新格式」 */
export const FAMILY_OF = {
  '.doc': 'word', '.docx': 'word', '.rtf': 'word',
  '.xls': 'excel', '.xlsx': 'excel',
  '.ppt': 'ppt', '.pps': 'ppt', '.pptx': 'ppt'
};

/** 智能模式：老格式 → 对应新格式；已是新格式的键不存在（计划阶段会给「无需转换」提示） */
export const AUTO_TARGET = {
  '.doc': 'docx', '.rtf': 'docx',
  '.xls': 'xlsx',
  '.ppt': 'pptx', '.pps': 'pptx'
};

/** 家族 → 新格式扩展名（「XX 文档（新格式）」列表项元信息用） */
export const FAMILY_NEW_EXT = { word: '.docx', excel: '.xlsx', ppt: '.pptx' };

/** 输出目标下拉（value 与 libreoffice:convert 的 target 一致） */
export const TARGETS = [
  { value: 'auto', label: '智能（推荐）：老格式转成对应新格式' },
  { value: 'docx', label: 'Word 文档（.docx）' },
  { value: 'xlsx', label: 'Excel 表格（.xlsx）' },
  { value: 'pptx', label: 'PowerPoint 演示（.pptx）' },
  { value: 'pdf', label: 'PDF 文档（.pdf，全部支持）' }
];

/** 按 value 取目标信息；未知值回落到智能模式 */
export function targetOf(value) {
  return TARGETS.find((t) => t.value === value) || TARGETS[0];
}

/**
 * 单个文件的转换计划（纯函数；界面转换与单测共用）
 * @param {string} ext 输入扩展名（带点、小写）
 * @param {{target: string}} params 界面参数（auto/docx/xlsx/pptx/pdf）
 * @returns {{ok: true, target: string, ext: string, note?: string} | {ok: false, reason: string}}
 */
export function planOne(ext, params) {
  const family = FAMILY_OF[ext];
  if (!family) return { ok: false, reason: '不是支持的文档格式' };

  const mode = params && params.target;
  if (mode === 'auto' || !mode) {
    const auto = AUTO_TARGET[ext];
    if (!auto) {
      return { ok: false, reason: `已经是新格式，无需转换（要转 PDF 请选「PDF 文档」）` };
    }
    return { ok: true, target: auto, ext: '.' + auto };
  }

  if (mode === 'pdf') return { ok: true, target: 'pdf', ext: '.pdf' };

  // 手动指定 docx/xlsx/pptx：必须同家族、且不能与输入扩展名相同
  const targetFamily = mode === 'docx' ? 'word' : mode === 'xlsx' ? 'excel' : 'ppt';
  if (family !== targetFamily) {
    const familyName = family === 'word' ? '文字文档' : family === 'excel' ? '表格' : '演示文稿';
    return { ok: false, reason: `${ext} 是${familyName}，转不成 .${mode}（不是同一类文档）` };
  }
  if (ext === '.' + mode) {
    return { ok: false, reason: `已经是 .${mode}，无需转换` };
  }
  return { ok: true, target: mode, ext: '.' + mode };
}

/** 列表项元信息：扩展名 + 家族 + 智能模式的目标 */
export function formatMeta(ext) {
  const family = FAMILY_OF[ext];
  if (!family) return ext.toUpperCase();
  const familyName = family === 'word' ? '文字' : family === 'excel' ? '表格' : '演示';
  const auto = AUTO_TARGET[ext];
  return auto
    ? `${ext.toUpperCase()} · ${familyName} → 转 .${auto}`
    : `${ext.toUpperCase()} · ${familyName}（已是新格式）`;
}

/** 字节 → 人类可读（B / KB / MB） */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 从完整路径取文件名（界面展示用，不依赖主进程） */
export function baseNameOf(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || '';
}
