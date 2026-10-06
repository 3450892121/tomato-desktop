// PDF → Word「可编辑文本」模式的压平后处理（见 spec/modules/pdf-convert.md §5a）
//
// 背景：LibreOffice 的 writer_pdf_import 走「按坐标重建页面」路线，把每一段文字都做成
//       绝对定位的浮动文本框（wp:anchor）。实测 195 页教材产出 20,339 个浮动对象
//       （document.xml 解压后 66.8 MB），Word 要为这两万个互相重叠的浮动框逐个排版，打开即卡死。
//       本模块把浮动文本框还原成普通段落、图片改为内嵌（wp:inline），产出 Word 能正常打开的文档。
//
// 说明：本模块由主进程（CommonJS）调用——66 MB 级 XML 的字符串处理放主进程可避免卡住界面进程，
//       故文件用 .cjs；jszip 走 dist 的 UMD 产物（与 tools/pack.js 已复制的文件一致，不额外引入依赖）。

'use strict';

const path = require('path');

const JSZIP_UMD = path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'jszip', 'dist', 'jszip.min.js');
// eslint-disable-next-line import/no-dynamic-require
const JSZip = require(JSZIP_UMD);

/** 同一视觉行的 y 容差（EMU，1 cm = 360000）；同一行的碎片 y 差值远小于此 */
const ROW_TOLERANCE_EMU = 40000;
/** 内嵌图片最大宽度（EMU，约 15.24 cm），避免整页背景图溢出页面 */
const MAX_IMAGE_WIDTH_EMU = 5486400;

/**
 * 从 startIdx 处的 <tag 找到配对的 </tag>，支持同名标签嵌套。
 * @returns {{contentStart:number, contentEnd:number, blockEnd:number}|null}
 */
function matchBlock(str, startIdx, tag) {
  const openRe = new RegExp(`<${tag}(?=[\\s/>])`, 'g');
  const closeRe = new RegExp(`</${tag}>`, 'g');
  let depth = 0;
  let i = startIdx;
  let contentStart = -1;
  while (i < str.length) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const o = openRe.exec(str);
    const c = closeRe.exec(str);
    if (!c) return null;
    if (o && o.index < c.index) {
      depth += 1;
      const gt = str.indexOf('>', o.index);
      if (str[gt - 1] === '/') depth -= 1; // 自闭合不计深度
      if (depth === 1 && contentStart === -1) contentStart = gt + 1;
      i = gt + 1;
    } else {
      depth -= 1;
      if (depth === 0) return { contentStart, contentEnd: c.index, blockEnd: c.index + c[0].length };
      i = c.index + c[0].length;
    }
  }
  return null;
}

/** 取出 XML 片段里的纯文本（标签去掉；制表/换行转空格；压缩连续空白）。文本在源 XML 中已转义，原样复用 */
function textOf(xml) {
  return xml
    .replace(/<w:tab\s*\/>/g, ' ')
    .replace(/<w:br\s*\/>/g, ' ')
    .replace(/<[^>]+>/g, '')
    // PDF 里没有 Unicode 映射的字形，LibreOffice 会落在私用区（实测本教材为 U+E009，共 2.3 万处，
    // 位置全在「图 3-109」这类间隔处）——Word 无对应字体只能显示成方框，按空白处理更合理。
    .replace(/[\uE000-\uF8FF]/g, ' ')
    .replace(/[\s\u00a0\u3000]+/g, ' ')
    .trim();
}

/** 仅当两侧都是 ASCII 字母数字时才补空格（中文之间不补，避免「肖军民 编著」这类多余空格） */
function needsSpace(prev, next) {
  const a = prev.slice(-1);
  const b = next.slice(0, 1);
  return /[0-9A-Za-z]/.test(a) && /[0-9A-Za-z]/.test(b);
}

function joinParts(parts) {
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    if (out && needsSpace(out, part)) out += ' ';
    out += part;
  }
  return out.trim();
}

const PAGE_BREAK_RE = /<w:br(?=[\s/>])[^>]*w:type="page"[^>]*\/>/g;

/** 统计片段里的分页符数量 */
function countPageBreaks(xml) {
  return (xml.match(PAGE_BREAK_RE) || []).length;
}

/** 取出一个文本框（w:txbxContent）里的文字：内部多个段落合并为一行 */
function boxText(inner) {
  const parts = [];
  let p = 0;
  for (;;) {
    const pi = inner.indexOf('<w:p', p);
    if (pi < 0) break;
    const pb = matchBlock(inner, pi, 'w:p');
    if (!pb) break;
    const t = textOf(inner.slice(pb.contentStart, pb.contentEnd));
    if (t) parts.push(t);
    p = pb.blockEnd;
  }
  return joinParts(parts);
}

/** 读取浮动对象的定位偏移（EMU）；取不到返回 null（这类对象不参与同行合并，避免被错误并到一起） */
function readOffset(xml, axis) {
  const re = new RegExp(`<wp:position${axis}[^>]*>\\s*<wp:posOffset>(-?\\d+)</wp:posOffset>`);
  const m = re.exec(xml);
  return m ? Number(m[1]) : null;
}

/**
 * 压平 docx：把浮动文本框还原成普通段落、图片改为内嵌。
 * 已压平（无浮动对象）时原样返回，不改动内容。
 * @param {Buffer|Uint8Array} bytes
 * @returns {Promise<{bytes: Buffer, stats: object}>}
 */
async function flattenDocx(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('不是有效的 docx（缺少 word/document.xml）');
  const docXml = await docFile.async('string');

  const bodyStart = docXml.indexOf('<w:body>');
  const bodyEnd = docXml.lastIndexOf('</w:body>');
  if (bodyStart < 0 || bodyEnd < 0) throw new Error('docx 结构异常（未找到 w:body）');

  const head = docXml.slice(0, bodyStart + '<w:body>'.length);
  const tail = docXml.slice(bodyEnd); // </w:body></w:document>
  const body = docXml.slice(bodyStart + '<w:body>'.length, bodyEnd);

  const anchorCount = (body.match(/<mc:AlternateContent/g) || []).length;
  if (anchorCount === 0) {
    // 没有浮动对象，本就无需压平
    return { bytes: Buffer.from(bytes), stats: { applied: false, anchors: 0 } };
  }

  // 末尾 sectPr（页面设置）原样保留
  let sectPr = '';
  const lastSect = body.lastIndexOf('<w:sectPr');
  if (lastSect >= 0) {
    const b = matchBlock(body, lastSect, 'w:sectPr');
    if (b) sectPr = body.slice(lastSect, b.blockEnd);
  }

  const out = [];
  let paragraphs = 0;
  let images = 0;
  let kept = 0;
  let docPrId = 1;

  let rowY = null;
  let rowParts = [];
  let pageBreaksEmitted = 0;
  const flushRow = () => {
    if (rowParts.length === 0) return;
    rowParts.sort((a, b) => a.x - b.x);
    const text = joinParts(rowParts.map((p) => p.text));
    rowParts = [];
    rowY = null;
    if (!text) return;
    out.push(`<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`);
    paragraphs += 1;
  };

  // 逐个顶层 <w:p> 处理：含浮动对象的拆出来压平，其余（如分页符段落）原样保留
  let cursor = 0;
  for (;;) {
    const pi = body.indexOf('<w:p', cursor);
    if (pi < 0) break;
    const pb = matchBlock(body, pi, 'w:p');
    if (!pb) break;
    cursor = pb.blockEnd;

    const para = body.slice(pi, pb.blockEnd);
    if (!para.includes('<mc:AlternateContent')) {
      // 分页符等普通段落：先收尾当前行，再原样保留（保留分页，便于与原 PDF 页面对照）
      flushRow();
      out.push(para);
      kept += 1;
      continue;
    }

    // 该段落里的每个浮动对象
    let c = 0;
    let breaksInsideObjects = 0;
    for (;;) {
      const ai = para.indexOf('<mc:AlternateContent', c);
      if (ai < 0) break;
      const ab = matchBlock(para, ai, 'mc:AlternateContent');
      if (!ab) break;
      const obj = para.slice(ai, ab.blockEnd);
      c = ab.blockEnd;
      breaksInsideObjects += countPageBreaks(obj);

      const txbxStart = obj.indexOf('<w:txbxContent');
      const blip = /<a:blip[^>]*r:embed="([^"]+)"/.exec(obj);
      const picStart = obj.indexOf('<pic:pic');

      // ① 图片（且不是文本框里的插图）→ 内嵌图片，独立成段
      if (blip && picStart >= 0 && (txbxStart < 0 || picStart < txbxStart)) {
        const picBlock = matchBlock(obj, picStart, 'pic:pic');
        const ext = /<wp:extent[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(obj);
        if (picBlock && ext) {
          flushRow();
          let w = Number(ext[1]);
          let h = Number(ext[2]);
          if (w > MAX_IMAGE_WIDTH_EMU) {
            h = Math.round((h * MAX_IMAGE_WIDTH_EMU) / w);
            w = MAX_IMAGE_WIDTH_EMU;
          }
          const picXml = obj.slice(picStart, picBlock.blockEnd);
          images += 1;
          out.push(
            '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
              `<wp:extent cx="${w}" cy="${h}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
              `<wp:docPr id="${docPrId++}" name="图片${images}"/>` +
              '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
              '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
              `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">${picXml}</a:graphicData>` +
              '</a:graphic></wp:inline></w:drawing></w:r></w:p>'
          );
          continue;
        }
      }

      // ② 文本框 → 文字，按视觉行合并
      if (txbxStart >= 0) {
        const tb = matchBlock(obj, txbxStart, 'w:txbxContent');
        if (!tb) continue;
        const text = boxText(obj.slice(tb.contentStart, tb.contentEnd));
        if (!text) continue;
        const x = readOffset(obj, 'H');
        const y = readOffset(obj, 'V');
        const sameRow = rowParts.length > 0 && rowY !== null && y !== null && Math.abs(y - rowY) <= ROW_TOLERANCE_EMU;
        if (!sameRow) flushRow();
        if (rowY === null) rowY = y;
        rowParts.push({ x: x === null ? 0 : x, text });
      }
    }

    // 段落里位于浮动对象之外的分页符：保留，便于与原 PDF 页面对照
    const pageBreaks = countPageBreaks(para) - breaksInsideObjects;
    for (let k = 0; k < pageBreaks; k += 1) {
      flushRow();
      out.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      pageBreaksEmitted += 1;
    }
  }
  flushRow();

  const newDoc = head + out.join('') + sectPr + tail;
  zip.file('word/document.xml', newDoc);
  const outBuf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  return {
    bytes: outBuf,
    stats: {
      applied: true,
      anchors: anchorCount,
      paragraphs,
      images,
      keptParagraphs: kept,
      pageBreaksEmitted,
      docXmlBefore: docXml.length,
      docXmlAfter: newDoc.length
    }
  };
}

module.exports = { flattenDocx };
