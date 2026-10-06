// 工具：文字识别 —— 纯逻辑层（扫描件 → Word .docx）
//
// 目标：把识别出来的文字写成一份**可编辑的 Word**，只做「段落纯文本 + 分页」，
//       不做版式还原（排版还原需要另一套重活，不在本工具范围）。
//
// 依赖：JSZip（随包的 jszip.min.js，已由 tools/pack.js 复制；不新增任何依赖）。
//       它是 UMD 产物：node 里按 CommonJS 导出 → import 得到 default；
//       渲染进程里当 ES 模块执行 → 挂到 globalThis.JSZip。两种环境都能拿到。
//
// 写法：手写最小 OOXML 三件套（[Content_Types].xml + _rels/.rels + word/document.xml），
//       Word / WPS 都能直接打开。
import * as jszipNamespace from '../../../../node_modules/jszip/dist/jszip.min.js';

const JSZip = (jszipNamespace && jszipNamespace.default) || globalThis.JSZip;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** XML 文本转义（& < > " ' 与控制字符都要处理，否则 Word 会判定文件损坏） */
export function escapeXml(text) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 一个段落：run 里加 xml:space="preserve"，避免首尾空格被 Word 吃掉 */
function paragraph(text, { bold = false, empty = false } = {}) {
  if (empty || text === '') return '<w:p/>';
  const rPr = bold ? '<w:rPr><w:b/></w:rPr>' : '';
  return `<w:p><w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/**
 * 行数据 → .docx 字节
 * @param {Array<string|{text:string}>} rows 每行一个段落（空串会写成空段落，用来分隔页面）
 * @param {{title?: string}} [options] title 会作为加粗首段（一般传文件名）
 * @returns {Promise<Uint8Array>}（JSZip 3 只有异步打包，故这里是 Promise）
 */
export async function linesToDocx(rows, { title = '' } = {}) {
  if (!JSZip) throw new Error('JSZip 未加载，无法导出 Word');
  const list = Array.isArray(rows) ? rows : [];
  const body = [];
  if (title) body.push(paragraph(title, { bold: true }));
  for (const row of list) {
    const text = typeof row === 'string' ? row : (row && row.text) || '';
    body.push(paragraph(text, { empty: text === '' }));
  }
  if (body.length === 0) body.push(paragraph(''));

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body.join('\n')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body>
</w:document>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', RELS);
  zip.folder('word').file('document.xml', documentXml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/**
 * 多页识别结果 → 行数据（页与页之间插一个空段落分隔）
 * @param {Array<Array<{text:string}>>} pagesRows 每页的 linesToPlainRows() 结果
 * @returns {Array<string>}
 */
export function pagesToDocxRows(pagesRows) {
  const out = [];
  (Array.isArray(pagesRows) ? pagesRows : []).forEach((rows, i) => {
    if (i > 0) out.push('');
    for (const r of rows || []) out.push((r && r.text) || '');
  });
  return out;
}