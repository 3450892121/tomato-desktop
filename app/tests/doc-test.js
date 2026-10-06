// 文档格式转换 · 引擎自检（仅 `electron . --doc-test` 时运行；见 spec/modules/doc-convert.md）
// 做法：程序内生成夹具——
//   ① 教务系统同款「假 .xls」（Excel 2003 XML / SpreadsheetML，扩展名 .xls 内容是 XML，WPS 实测样本同构）；
//   ② 真 .xls（SheetJS 生成的 BIFF8 二进制）；
//   ③ 手写 RTF（写字板格式，\uN 转义中文）；
//   ④ 坏文件（随机字节，验证明确报错）。
// 本文件**不直接起任何子进程**：所有转换都经渲染进程 window.desktop.libreofficeConvert 走真实 IPC
//（与界面点按钮同一条路），由主进程 libreoffice:convert 负责调随包 LibreOffice——
// 覆盖 target 白名单（xlsx/docx/pdf）与「仅 PDF 输入才加 infilter」的门（rtf→docx 若被误加
// writer_pdf_import 过滤器会直接失败，因此这条门有真实断言）。
// 产物用 SheetJS（xlsx 单元格）与 jszip（docx 正文文本）读回校验。
// 缺 LibreOffice 加装包 = 失败（加装包是普通资产，缺它该工具本身就坏了）。
// 已知边界：.doc / .ppt 的真实二进制夹具需要外部生产器，测试里造不出来；它们与 rtf→docx 走
// 完全相同的处理链（同一 handler、同一白名单、同族导入过滤器由 LibreOffice 按内容自选），
// 家族映射由 tests/docconvert.test.mjs 钉住。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');

// 字面量相对路径 require（Node 按本文件位置解析到 app/vendor；不用动态路径拼 require）
const XLSX = require('../vendor/xlsx/xlsx.full.min.js');
// jszip 与 flatten-docx.cjs 同一惯用法：走 dist 的 UMD 产物——pack.js 4b 只把这一个文件
// 带进产物，`require('jszip')`（按 package.json 解析）在打包产物上会失败（v2.13.0 踩到）
const JSZip = require('../node_modules/jszip/dist/jszip.min.js');

/** 教务系统同款「假 .xls」：Excel 2003 XML（SpreadsheetML）+ mso-application progid（WPS 保存的实测样本同构）；<Row> 必须整段包在 <Table> 里，否则 LibreOffice 转出空表（实测踩过，别去掉这层包裹） */
function makeFakeXmlXls(rows, sheetName) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cell = (v) => `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`;
  const row = (r) => `<Row>${r.map(cell).join('')}</Row>`;
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<?mso-application progid="Excel.Sheet"?>',
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    '<Styles><Style ss:ID="Default" ss:Name="Normal"><Font ss:FontName="宋体" ss:Size="11"/></Style></Styles>',
    `<Worksheet ss:Name="${esc(sheetName)}"><Table>${rows.map(row).join('')}</Table></Worksheet>`,
    '</Workbook>'
  ].join('\r\n');
}

/** 手写 RTF：非 ASCII 字符转 \uN?（RTF 的 \uN 是带符号 16 位十进制，>32767 要绕回负数） */
function makeRtf(text) {
  const esc = (s) => s.replace(/[\\{}]/g, '\\$&').split('').map((ch) => {
    let n = ch.charCodeAt(0);
    if (n <= 127) return ch;
    if (n > 32767) n -= 65536;
    return `\\u${n}?`;
  }).join('');
  return '{\\rtf1\\ansi{\\fonttbl{\\f0 SimSun;}}\\f0\\fs24 ' + esc(text) + '\\par}';
}

async function runDocTest(win) {
  const evalJs = (code) => win.webContents.executeJavaScript(code);
  const result = { ok: false, failures: [], checks: {} };
  const fail = (name, message) => { result.failures.push(`${name}: ${message}`); };

  const st = JSON.parse(await evalJs('(async () => JSON.stringify(await window.desktop.libreofficeStatus()))()'));
  if (!st.found) {
    fail('LibreOffice', '未检测到加装包（软件目录/addons/libreoffice）或系统安装');
    return result;
  }
  result.checks.libreoffice = { found: true, where: st.where };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tomato-doctest-'));

  try {
    // —— 夹具 ——
    const rows = [
      ['姓名', '学号', '班级'],
      ['张三', '2025001', '模具（3）251班'],
      ['李四', '2025002', '模具（3）251班']
    ];
    const fakeXls = path.join(dir, '名单-假xls.xls');
    await fs.writeFile(fakeXls, Buffer.from(makeFakeXmlXls(rows, '名单'), 'utf8'));

    const realWb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(realWb, XLSX.utils.aoa_to_sheet(rows), '名单');
    const realXls = path.join(dir, '名单-真xls.xls');
    // XLSX.write(type:'buffer') 拿字节自己落盘：writeFile 的直写分支在主进程环境不可用
    await fs.writeFile(realXls, XLSX.write(realWb, { bookType: 'xls', type: 'buffer' }));

    const rtfText = '文档转换测试：这一行文字应当出现在转换后的文档里。';
    const rtf = path.join(dir, '说明.rtf');
    await fs.writeFile(rtf, Buffer.from(makeRtf(rtfText), 'utf8'));

    const badXls = path.join(dir, '坏文件.xls');
    await fs.writeFile(badXls, Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) & 255)));

    // —— 转换：经渲染进程走真实 IPC（libreoffice:convert） ——
    const convert = async (name, inputPath, target, outPath) => {
      const r = JSON.parse(await evalJs(`(async () => {
        try {
          const res = await window.desktop.libreofficeConvert(${JSON.stringify({ inputPath, target })});
          if (!res.ok) return JSON.stringify({ ok: false, message: res.message });
          await window.desktop.writeFile(${JSON.stringify(outPath)}, res.bytes);
          return JSON.stringify({ ok: true, ms: res.ms, size: res.bytes.byteLength });
        } catch (err) {
          return JSON.stringify({ ok: false, message: String(err && err.message || err) });
        }
      })()`));
      result.checks[name] = { ...r, out: path.basename(outPath) };
      return r;
    };

    /** xlsx 产物读回校验：SheetJS 取单元格（XLSX.read 走纯解析，不经它的 fs 分支） */
    const readXlsx = async (file) => {
      const wb = XLSX.read(await fs.readFile(file), { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
      return { sheets: wb.SheetNames.join('|'), grid };
    };
    /** 取第一行非空行（LibreOffice 有时在表首留空行，别让它误伤断言） */
    const firstRow = (grid) => grid.find((r) => Array.isArray(r) && r.some((c) => c !== undefined && c !== null && c !== '')) || [];
    /** docx 产物读回校验：jszip 取正文文本（去标签后比对关键词） */
    const readDocxText = async (file) => {
      const zip = await JSZip.loadAsync(await fs.readFile(file));
      const docXml = await zip.file('word/document.xml').async('string');
      return docXml.replace(/<[^>]+>/g, '');
    };

    // ① 教务系统「假 .xls」→ xlsx（典型场景）
    const outFake = path.join(dir, '名单-假xls.xlsx');
    const r1 = await convert('假xls转xlsx', fakeXls, 'xlsx', outFake);
    if (r1.ok) {
      const { sheets, grid } = await readXlsx(outFake);
      const row0 = firstRow(grid);
      const row1 = firstRow(grid.slice(grid.indexOf(row0) + 1));
      if (!(row0[0] === '姓名' && row1[2] === '模具（3）251班')) {
        fail('假xls转xlsx', `内容不符：sheets=${sheets} grid=${JSON.stringify(grid).slice(0, 240)}`);
      }
    } else fail('假xls转xlsx', r1.message || '未生成产物');

    // ② 真 .xls（BIFF8）→ xlsx
    const outReal = path.join(dir, '名单-真xls.xlsx');
    const r2 = await convert('真xls转xlsx', realXls, 'xlsx', outReal);
    if (r2.ok) {
      const { grid } = await readXlsx(outReal);
      const row0 = firstRow(grid);
      const row1 = firstRow(grid.slice(grid.indexOf(row0) + 1));
      if (!(row0[0] === '姓名' && row1[0] === '张三' && row1[1] === '2025001')) {
        fail('真xls转xlsx', `内容不符：grid=${JSON.stringify(grid).slice(0, 240)}`);
      }
    } else fail('真xls转xlsx', r2.message || '未生成产物');

    // ③ RTF → docx（同时是「docx 目标 + 非 PDF 输入不加 infilter」的真实断言）
    const outDocx = path.join(dir, '说明.docx');
    const r3 = await convert('rtf转docx', rtf, 'docx', outDocx);
    if (r3.ok) {
      const text = await readDocxText(outDocx);
      if (!text.includes('文档转换测试')) fail('rtf转docx', `正文缺关键词：${text.slice(0, 120)}`);
    } else fail('rtf转docx', r3.message || '未生成产物');

    // ④ PDF 目标（白名单里的第四个 target）：产物必须是 %PDF- 开头
    const outPdf = path.join(dir, '说明.pdf');
    const r5 = await convert('rtf转pdf', rtf, 'pdf', outPdf);
    if (r5.ok) {
      const head = (await fs.readFile(outPdf)).subarray(0, 5).toString('latin1');
      if (head !== '%PDF-') fail('rtf转pdf', `PDF 魔数不符：${JSON.stringify(head)}`);
    } else fail('rtf转pdf', r5.message || '未生成产物');

    // ⑤ 坏文件：LibreOffice 对垃圾字节可能「转出空表格」而不是报错（其固有嗅探行为，
    // 已列入 spec 已知限制）——这里只断言「给出确定结果且不崩」：要么明确失败，
    // 要么成功且产物是能被 SheetJS 正常打开的 xlsx。
    const outBad = path.join(dir, '坏文件.xlsx');
    const r6 = await convert('坏文件有确定结果', badXls, 'xlsx', outBad);
    if (r6.ok) {
      try { await readXlsx(outBad); } catch (err) { fail('坏文件有确定结果', `产物不可读：${err.message}`); }
    }
  } catch (err) {
    fail('运行', err.stack || err.message);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  result.ok = result.failures.length === 0;
  return result;
}

module.exports = { runDocTest };
