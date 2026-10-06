// 文档格式转换 · 界面自动测试（仅 `electron . --doc-ui-test` 时运行）
// 做法：像真人一样「切到文档格式转换 → 点添加（测试模式下对话框直接返回夹具）→ 点开始转换 → 等完成」，
//      每步截图；夹具 = 教务系统同款「假 .xls」（Excel 2003 XML）+ 手写 RTF，
//      产物（.xlsx / .docx）用 SheetJS / jszip 读回校验内容。本文件不直接起任何子进程。
// 结果写入 %TEMP%/tomato-doc-ui-test.json，截图落在 %TEMP%/tomato-uitest。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');

// 字面量相对路径 require（Node 按本文件位置解析到 app/vendor）
const XLSX = require('../vendor/xlsx/xlsx.full.min.js');
// 与 flatten-docx.cjs 同一惯用法：jszip 走 dist 的 UMD 产物——pack.js 4b 只把这一个文件
// 带进产物，`require('jszip')`（按 package.json 解析）在打包产物上会失败（v2.13.0 踩到）
const JSZip = require('../node_modules/jszip/dist/jszip.min.js');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-doc-ui-test.json');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 动态文件名 → 测试目录内的绝对路径。
 *  安全边界：只接受纯 basename（不许带任何路径分隔符），拼好后校验仍在 TEST_DIR 之内，
 *  绝不让 ../ 或绝对路径越过测试目录。 */
function inTestDir(name) {
  const raw = String(name);
  const base = path.basename(raw);
  if (base !== raw || base === '.' || base === '..') throw new Error(`非纯文件名：${raw}`);
  const full = path.join(TEST_DIR, base);
  if (!full.startsWith(TEST_DIR + path.sep)) throw new Error(`越界路径：${raw}`);
  return full;
}

function writeResult(payload) {
  fsSync.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

/** 教务系统同款「假 .xls」：Excel 2003 XML（SpreadsheetML）+ mso-application progid（与 doc-test 同构） */
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

/** 手写 RTF：非 ASCII 字符转 \uN?（带符号 16 位十进制，>32767 绕回负数） */
function makeRtf(text) {
  const esc = (s) => s.replace(/[\\{}]/g, '\\$&').split('').map((ch) => {
    let n = ch.charCodeAt(0);
    if (n <= 127) return ch;
    if (n > 32767) n -= 65536;
    return `\\u${n}?`;
  }).join('');
  return '{\\rtf1\\ansi{\\fonttbl{\\f0 SimSun;}}\\f0\\fs24 ' + esc(text) + '\\par}';
}

/** 产物文件名白名单：只认「测试老文档*」开头的纯 basename（.xlsx/.docx），其余一律不进文件读写。
 *  夹具前缀「测试老文档」为本工具独占（项目约定：每工具一个独立前缀，避免测试互相污染）。 */
const PRODUCED_NAME_RE = /^测试老文档[^\\/]+\.(xlsx|docx)$/i;
/** 本测试家族的完整前缀（夹具 + 产物一起算）：开始清理与**结束清理**都用它。
 *  结束必须清干净——pdf-convert 的测试对话框按扩展名全收（无夹具过滤），
 *  残留文件会被它当成输入，把「成功 2 个」污染成「成功 4 个」（v2.13.0 当天踩到）。 */
const FAMILY_RE = /^测试老文档/;

async function runDocUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [] };

  await fs.mkdir(TEST_DIR, { recursive: true });

  // —— 清理上次夹具与产物（只删「测试老文档*」家族，避免影响其它界面测试的夹具） ——
  const cleanBefore = (await fs.readdir(TEST_DIR)).filter((f) => FAMILY_RE.test(f));
  for (const name of cleanBefore) {
    await fs.rm(inTestDir(name), { recursive: true, force: true });
  }
  const cleanAfter = (await fs.readdir(TEST_DIR)).filter((f) => PRODUCED_NAME_RE.test(f));
  result.steps.清理 = { before: cleanBefore, after: cleanAfter };

  const shot = async (name) => {
    const file = inTestDir(`shot-${name}.png`);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        win.show();
        win.focus();
        if (wc.setBackgroundThrottling) wc.setBackgroundThrottling(false);
        await wait(200);
        const image = await wc.capturePage();
        if (image && !image.isEmpty()) {
          await fs.writeFile(file, image.toPNG());
          result.shots.push(file);
          return true;
        }
      } catch { /* 重试 */ }
      await wait(400);
    }
    return false;
  };

  // —— 界面操作小工具 ——
  const getStatus = () => evalJs('document.getElementById("statusText").textContent');
  const clickTool = (name) => evalJs(`(() => {
    const btn = [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.textContent.includes(${JSON.stringify(name)}));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  const clickSel = (sel) => evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.click();
    return true;
  })()`);

  /** 等一次运行结束：进度条先出现、再收起（或状态文案变化）才算完成 */
  async function waitForFinish(statusBefore, timeoutMs) {
    const t0 = Date.now();
    const readProgress = async () => JSON.parse(await evalJs(`JSON.stringify({
      status: document.getElementById('statusText').textContent,
      progressHidden: document.getElementById('progressBar').hidden
    })`));
    let appeared = false;
    while (Date.now() - t0 < 5000) {
      const o = await readProgress();
      if (!o.progressHidden) { appeared = true; break; }
      await wait(120);
    }
    let last = '';
    while (Date.now() - t0 < timeoutMs) {
      const o = await readProgress();
      last = o.status;
      if (o.progressHidden && (appeared || o.status !== statusBefore)) {
        return { ok: true, status: o.status, ms: Date.now() - t0, appeared };
      }
      await wait(250);
    }
    return { ok: false, status: last, timeout: true };
  }

  // —— 夹具（假 .xls + RTF；LibreOffice 按内容识别，扩展名不影响） ——
  const rows = [
    ['姓名', '学号', '班级'],
    ['张三', '2025001', '模具（3）251班']
  ];
  await fs.writeFile(inTestDir('测试老文档A.xls'), Buffer.from(makeFakeXmlXls(rows, '名单'), 'utf8'));
  await fs.writeFile(inTestDir('测试老文档B.rtf'), Buffer.from(makeRtf('文档转换测试：这一行文字应当出现在转换后的文档里。'), 'utf8'));

  await shot('35-文档测试起点');

  // —— 1) 切到文档格式转换，检查界面元素（目标下拉 5 项 / LibreOffice 状态就绪） ——
  result.steps.switch = await clickTool('文档格式转换');
  await wait(800);
  result.checks.界面 = JSON.parse(await evalJs(`(() => {
    const sel = document.querySelector('#dcTarget');
    const note = document.querySelector('#dcLoNote');
    const run = document.querySelector('#dcRunBtn');
    if (!sel || !note || !run) return JSON.stringify({ ok: false, reason: '界面元素缺失' });
    return JSON.stringify({
      ok: sel.options.length === 5 && sel.value === 'auto'
        && note.classList.contains('is-ok') && run.disabled === false,
      options: sel.options.length, value: sel.value, noteClass: note.className
    });
  })()`));

  // —— 2) 添加夹具（2 个：假 .xls / RTF），列表应显示智能目标 ——
  const before = new Set(await fs.readdir(TEST_DIR));
  result.steps.added = await clickSel('[data-add]');
  await wait(2200);
  result.checks.添加列表 = JSON.parse(await evalJs(`(() => {
    const items = [...document.querySelectorAll('#dcList .dc-item')];
    const metas = items.map((li) => (li.querySelector('.dc-item-meta') || {}).textContent || '');
    return JSON.stringify({
      ok: items.length === 2 && metas.some((m) => m.includes('转 .xlsx')) && metas.some((m) => m.includes('转 .docx')),
      count: items.length, metas
    });
  })()`));
  await shot('36-文档已添加');

  // —— 3) 点运行，等完成，校验产物内容 ——
  const statusBefore = await getStatus();
  result.steps.ran = await clickSel('[data-run]');
  const finish = await waitForFinish(statusBefore, 300000);
  await shot('37-文档完成');
  const after = await fs.readdir(TEST_DIR);
  // 只认白名单里的纯 basename（inTestDir 里再兜一层边界校验）
  const produced = after.filter((f) => !before.has(f) && PRODUCED_NAME_RE.test(f));

  let xlsxOk = false;
  let docxOk = false;
  const producedInfo = [];
  for (const name of produced) {
    const full = inTestDir(name);
    const info = { file: name, bytes: fsSync.statSync(full).size };
    try {
      if (/\.xlsx$/i.test(name)) {
        const wb = XLSX.read(fsSync.readFileSync(full), { type: 'buffer' });
        const rowsAll = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false });
        const nonEmpty = rowsAll.filter((r) => Array.isArray(r) && r.some((c) => c !== undefined && c !== null && c !== ''));
        info.cells = `${nonEmpty[0] && nonEmpty[0][0]}|${nonEmpty[1] && nonEmpty[1][0]}`;
        xlsxOk = info.cells === '姓名|张三';
      } else if (/\.docx$/i.test(name)) {
        const zip = await JSZip.loadAsync(fsSync.readFileSync(full));
        const docXml = await zip.file('word/document.xml').async('string');
        docxOk = docXml.replace(/<[^>]+>/g, '').includes('文档转换测试');
        info.textOk = docxOk;
      }
    } catch (err) {
      info.error = String(err && err.message || err);
    }
    producedInfo.push(info);
  }
  result.checks.转换产物 = {
    finish, produced: producedInfo,
    ok: !!finish.ok && produced.length === 2
      && produced.some((f) => /\.xlsx$/i.test(f)) && produced.some((f) => /\.docx$/i.test(f))
      && xlsxOk && docxOk
  };

  // —— 4) 清空按钮 ——
  result.steps.cleared = await clickSel('[data-clear]');
  await wait(400);
  result.checks.清空 = JSON.parse(await evalJs(`(() => {
    const items = document.querySelectorAll('#dcList .dc-item').length;
    const dropHidden = document.getElementById('dcDrop').hidden;
    return JSON.stringify({ ok: items === 0 && dropHidden === false, items, dropHidden });
  })()`));
  await shot('38-文档已清空');

  // —— 收尾：把本家族的夹具与产物全部清走，不留给后续测试（原因见 FAMILY_RE 注释） ——
  for (const name of (await fs.readdir(TEST_DIR)).filter((f) => FAMILY_RE.test(f))) {
    await fs.rm(inTestDir(name), { recursive: true, force: true });
  }
  const leftovers = (await fs.readdir(TEST_DIR)).filter((f) => FAMILY_RE.test(f));
  result.steps.收尾清理 = { leftovers };

  // —— 汇总 ——
  const keys = Object.keys(result.checks);
  result.pass = keys.length >= 4 && keys.every((k) => result.checks[k].ok === true)
    && result.steps.switch === true && result.steps.added === true
    && result.steps.ran === true
    && leftovers.length === 0;
  writeResult({ ok: !!result.pass, at: new Date().toISOString(), result });
  return result;
}

module.exports = { runDocUiTest, writeResult, TEST_DIR };
