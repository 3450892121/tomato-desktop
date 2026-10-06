// PDF 工具自检：`electron . --pdf-test`
// 在界面进程里验证：pdfjs 加载（含 worker 路径与 cmaps 配置）、pdf-lib 生成、
// 「图片→PDF→渲染→像素校验→编码 PNG」全链路，以及合并/拆分/提取页与页码解析。
// 结果同时写入 %TEMP%/tomato-pdf-test.json：GUI 进程的 stdout 在部分环境下抓不到，
// 落盘文件既是调试依据，也是验收证据（含失败时的错误、堆栈与界面进程日志）。
// 自检采用「分步执行」：任一步失败也保留前面已完成的中间结果，方便定位。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 依赖按显式路径引用 UMD 产物（兼容开发态与绿色版：绿色版没有 npm 的模块解析）
const dep = (pkg, file) => path.join(__dirname, '..', 'node_modules', pkg, file);
// SheetJS 走本地内置（vendor/，0.20.3）：npm 版停在 0.18.5 有已知漏洞，见 app/vendor/xlsx/说明.txt
const vendor = (dir, file) => path.join(__dirname, '..', 'vendor', dir, file);
const JSZip = require(dep('jszip', 'dist/jszip.min.js'));
const XLSX = require(vendor('xlsx', 'xlsx.full.min.js'));

/** 自检结果文件（固定路径，便于验收脚本读取） */
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-pdf-test.json');
/** 内置降级测试用的样本目录 */
const SAMPLE_DIR = path.join(os.tmpdir(), 'tomato-pdf-test-samples');

/** 造样本：最小可用 .docx（纯 XML 打包）与 .xlsx（SheetJS 生成），用于验证内置降级链路 */
async function makeSamples(targetDir = SAMPLE_DIR) {
  await fs.promises.mkdir(targetDir, { recursive: true });

  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>内置降级测试文档 DOCX FALLBACK TEST</w:t></w:r></w:p>
    <w:p><w:r><w:t>第二段：验证多段文本能正常排版输出。</w:t></w:r></w:p>
  </w:body>
</w:document>`);
  const docxPath = path.join(targetDir, '内置降级测试.docx');
  await fs.promises.writeFile(docxPath, await zip.generateAsync({ type: 'nodebuffer' }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['内置降级测试 XLSX FALLBACK TEST', 'B1'],
    ['第二行', 42],
    ['第三行', 3.14]
  ]), 'Sheet1');
  // 注意：不用 XLSX.writeFile —— 浏览器构建在 Electron 主进程里的环境判定不稳定，
  // 统一自己写盘（Node 侧 write 返回 Buffer），dev 与绿色版行为一致。
  const xlsxPath = path.join(targetDir, '内置降级测试.xlsx');
  await fs.promises.writeFile(xlsxPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

  return { docxPath, xlsxPath };
}

function writeResult(payload) {
  try {
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[pdf-test] 结果文件写入失败：', err.message);
  }
  return RESULT_FILE;
}

/** 注入界面进程执行的检测脚本（与主进程自检同一套路：executeJavaScript + JSON 回传） */
const PDF_TEST_SCRIPT = `
  (async () => {
    const result = { steps: {}, failures: [] };
    const step = async (name, fn) => {
      try {
        result.steps[name] = await fn();
      } catch (err) {
        result.failures.push(name + ': ' + (err && err.message ? err.message : String(err)));
      }
    };
    const at = (pix, W, x, y) => { const p = (y * W + x) * 4; return [pix[p], pix[p + 1], pix[p + 2]].join(','); };

    const build = await import('../tools/pdf-convert/core/build.js');
    const pdfjs = await import('../tools/pdf-convert/core/pdfjs.js');
    const pages = await import('../tools/pdf-convert/core/pages.js');
    const imageio = await import('../shared/imageio.js');
    const samples = __SAMPLES__;
    result.pdfjsVersion = pdfjs.PDFJS_VERSION;

    // 测试图：A = 红底 + 左侧白竖条（PNG）；B = 蓝色渐变（JPG）
    const w = 120, h = 80;
    const A = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const white = x < 12;
      A[p] = white ? 255 : 220; A[p + 1] = white ? 255 : 40; A[p + 2] = white ? 255 : 40; A[p + 3] = 255;
    }
    const B = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      B[p] = 30; B[p + 1] = 60; B[p + 2] = Math.round((y / (h - 1)) * 220 + 20); B[p + 3] = 255;
    }
    const pngBytes = await imageio.encodeImageToBytes(A, w, h, { format: 'png' });
    const jpgBytes = await imageio.encodeImageToBytes(B, w, h, { format: 'jpg', quality: 92 });
    result.steps.encode = { pngSize: pngBytes.length, jpgSize: jpgBytes.length };

    result.steps.sniff = {
      png: build.sniffImageType(pngBytes),
      jpg: build.sniffImageType(jpgBytes)
    };

    // 图片 → PDF（两页）
    let pdfBytes;
    await step('imagesToPdf', async () => {
      pdfBytes = await build.imagesToPdf([
        { bytes: pngBytes, type: 'png' },
        { bytes: jpgBytes, type: 'jpg' }
      ]);
      const head = Array.from(pdfBytes.slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return { size: pdfBytes.length, headHex: head, isUint8: pdfBytes instanceof Uint8Array };
    });

    // 量 PDF 页数（走 pdf-lib 读回）
    await step('getPageCount', async () => ({ pages: await build.getPageCount(pdfBytes) }));

    // PDF → 渲染（验证 worker / cmaps 配置与画布输出）
    let pdf;
    await step('openPdf', async () => {
      pdf = await pdfjs.openPdf(pdfBytes);
      return { numPages: pdf.numPages };
    });
    await step('renderPage1', async () => {
      const page1 = await pdfjs.renderPageToPixels(pdf, 1, { scale: 1.5 });
      return {
        size: page1.width + 'x' + page1.height,
        leftPx: at(page1.pixels, page1.width, Math.round(page1.width * 0.05), Math.round(page1.height / 2)),
        rightPx: at(page1.pixels, page1.width, Math.round(page1.width * 0.6), Math.round(page1.height / 2)),
        outPngSize: (await imageio.encodeImageToBytes(page1.pixels, page1.width, page1.height, { format: 'png' })).length
      };
    });
    await step('renderPage2', async () => {
      const page2 = await pdfjs.renderPageToPixels(pdf, 2, { scale: 1 });
      return {
        size: page2.width + 'x' + page2.height,
        topPx: at(page2.pixels, page2.width, Math.round(page2.width / 2), Math.round(page2.height * 0.06)),
        bottomPx: at(page2.pixels, page2.width, Math.round(page2.width / 2), Math.round(page2.height * 0.94))
      };
    });

    // 合并 / 拆分 / 提取页
    await step('merge', async () => ({ pages: await build.getPageCount(await build.mergePdfs([pdfBytes, pdfBytes])) }));
    await step('split', async () => {
      const parts = await build.splitPdf(pdfBytes, { everyN: 1 });
      return { count: parts.length, ranges: parts.map((p) => p.start + '-' + p.end).join(',') };
    });
    await step('extract', async () => {
      const picked = await build.extractPages(pdfBytes, [2, 1]);
      const pickedPdf = await pdfjs.openPdf(picked);
      const first = await pdfjs.renderPageToPixels(pickedPdf, 1, { scale: 1 });
      return { pages: pickedPdf.numPages, firstTopPx: at(first.pixels, first.width, Math.round(first.width / 2), Math.round(first.height * 0.06)) };
    });

    // 页码范围解析
    await step('pageRange', async () => ({
      range1: pages.parsePageRange('1-2, 5', 6).join(','),
      rangeAll: String(pages.parsePageRange('', 6)),
      text: pages.formatPageRange([1, 2, 3, 5, 6])
    }));

    // 内置降级：docx / xlsx → PDF（隐藏窗口渲染 + printToPDF），并检查页面确实渲染出了内容
    await step('fallbackDocx', async () => {
      const res = await window.desktop.officeToPdf({ inputPath: samples.docxPath, kind: 'docx' });
      if (!res || !res.ok) throw new Error((res && res.message) || 'officeToPdf 调用失败');
      const head = String.fromCharCode(...res.bytes.slice(0, 5));
      const doc = await pdfjs.openPdf(res.bytes);
      const p1 = await pdfjs.renderPageToPixels(doc, 1, { scale: 1 });
      let dark = 0;
      for (let i = 0; i < p1.pixels.length; i += 4) if (p1.pixels[i] < 128 && ++dark > 20) break;
      return { head, pages: doc.numPages, page1: p1.width + 'x' + p1.height, hasText: dark > 20, bytes: res.bytes.length, ms: res.ms };
    });
    await step('fallbackXlsx', async () => {
      const res = await window.desktop.officeToPdf({ inputPath: samples.xlsxPath, kind: 'xlsx' });
      if (!res || !res.ok) throw new Error((res && res.message) || 'officeToPdf 调用失败');
      const doc = await pdfjs.openPdf(res.bytes);
      const p1 = await pdfjs.renderPageToPixels(doc, 1, { scale: 1 });
      let dark = 0;
      for (let i = 0; i < p1.pixels.length; i += 4) if (p1.pixels[i] < 128 && ++dark > 20) break;
      return { pages: doc.numPages, page1: p1.width + 'x' + p1.height, hasContent: dark > 20, bytes: res.bytes.length, ms: res.ms };
    });

    // LibreOffice 分支：装了加装包才实际执行（没装记 skipped，不算失败）
    await step('libreoffice', async () => {
      const status = await window.desktop.libreofficeStatus();
      if (!status || !status.found) return { skipped: '未检测到 LibreOffice（加装包未安装）' };

      // ① docx → PDF（走 soffice，高保真通道）
      const r1 = await window.desktop.libreofficeConvert({ inputPath: samples.docxPath, target: 'pdf' });
      if (!r1 || !r1.ok) throw new Error('docx→pdf 失败：' + ((r1 && r1.message) || '未知原因'));
      const doc1 = await pdfjs.openPdf(r1.bytes);
      const p1 = await pdfjs.renderPageToPixels(doc1, 1, { scale: 1 });
      let dark = 0;
      for (let i = 0; i < p1.pixels.length; i += 4) if (p1.pixels[i] < 128 && ++dark > 20) break;

      // ② 先落一份磁盘上的 PDF，再用它做 PDF → Word（docx）
      const onePage = await build.imagesToPdf([{ bytes: pngBytes, type: 'png' }]);
      const pdfPath = await window.desktop.saveImageNextTo({
        sourcePath: samples.docxPath, baseName: 'lo-test-input', ext: '.pdf', bytes: onePage
      });
      const r2 = await window.desktop.libreofficeConvert({ inputPath: pdfPath, target: 'docx' });
      if (!r2 || !r2.ok) throw new Error('pdf→docx 失败：' + ((r2 && r2.message) || '未知原因'));

      // docx 是 zip：检查 PK 头 + 内含 word/document.xml（zip 的文件名在头部是明文）
      const isZip = r2.bytes[0] === 0x50 && r2.bytes[1] === 0x4b;
      let hasDocXml = false;
      const needle = 'word/document.xml';
      outer: for (let i = 0; i < r2.bytes.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (r2.bytes[i + j] !== needle.charCodeAt(j)) continue outer;
        }
        hasDocXml = true;
        break;
      }

      // ③ PDF → Word「可编辑文本」模式：用 ① 产出的含文字 PDF，验证浮动对象被压平
      const textPdfPath = await window.desktop.saveImageNextTo({
        sourcePath: samples.docxPath, baseName: 'lo-text-input', ext: '.pdf', bytes: r1.bytes
      });
      const r3 = await window.desktop.libreofficeConvert({ inputPath: textPdfPath, target: 'docx', mode: 'text' });
      if (!r3 || !r3.ok) throw new Error('pdf→docx(可编辑文本) 失败：' + ((r3 && r3.message) || '未知原因'));
      const f3 = r3.flatten || {};
      if (f3.anchors > 0 && f3.applied !== true) throw new Error('压平未执行：' + (f3.error || '未知原因'));
      if (f3.anchors > 0 && !(f3.paragraphs > 0)) throw new Error('压平后没有产出文字段落');

      return {
        where: status.where,
        docxToPdf: { pages: doc1.numPages, hasText: dark > 20, bytes: r1.bytes.length, ms: r1.ms },
        pdfToDocx: { isZip, hasDocXml, bytes: r2.bytes.length, ms: r2.ms },
        pdfToWordText: {
          anchors: f3.anchors, applied: f3.applied, paragraphs: f3.paragraphs, images: f3.images,
          docXmlMB: f3.docXmlAfter ? +(f3.docXmlAfter / 1048576).toFixed(2) : null,
          bytes: r3.bytes.length, ms: r3.ms
        }
      };
    });

    // 界面接线冒烟：切到 PDF 工具，检查注册、挂载与方向切换；最后切回图片混淆
    await step('ui', async () => {
      // 等工具列表渲染出来再点（窗口刚打开时列表可能还没渲染，避免误报「未出现」）
      let navItem = null;
      for (let i = 0; i < 30 && !navItem; i++) {
        navItem = [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === 'pdf-convert');
        if (!navItem) await new Promise((r) => setTimeout(r, 100));
      }
      if (!navItem) throw new Error('左侧未出现「PDF 转格式」');
      navItem.click();
      await new Promise((r) => setTimeout(r, 400));
      const dirSel = document.querySelector('#pdfDirection');
      const dirCount = dirSel ? dirSel.querySelectorAll('option').length : 0;
      const runBtn = document.querySelector('#pdfRunBtn');
      const addBtn = document.querySelector('#pdfAddBtn');
      if (!dirSel || !runBtn || !addBtn) throw new Error('PDF 工具界面元素缺失');
      // 逐一切换方向，确认参数区能正常重建、不报错
      const labels = [];
      for (const opt of dirSel.querySelectorAll('option')) {
        dirSel.value = opt.value;
        dirSel.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 120));
        labels.push(opt.value + ':' + runBtn.textContent);
      }
      const backItem = [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === 'obfuscate');
      if (backItem) backItem.click();
      await new Promise((r) => setTimeout(r, 200));
      return {
        dirCount,
        runLabels: labels.join(' | '),
        version: document.getElementById('appVersion') ? document.getElementById('appVersion').textContent : ''
      };
    });

    return JSON.stringify(result);
  })()
`;

/**
 * 运行 PDF 自检
 * @param {import('electron').BrowserWindow} win
 * @returns {Promise<object>} 自检结果（含 workerFallback 标记）
 */
async function runPdfTest(win) {
  const consoleLines = [];
  const onConsole = (...args) => {
    // Electron 32+ 为 (event, details)；旧版为 (event, level, message, line, sourceId)
    const details = args[1] && typeof args[1] === 'object' ? args[1] : null;
    const message = details && typeof details.message === 'string' ? details.message : String(args[2] ?? '');
    if (message) consoleLines.push(message);
  };
  win.webContents.on('console-message', onConsole);
  try {
    // 先造内置降级用的样本（.docx / .xlsx），再把路径注入检测脚本
    const samples = await makeSamples();
    const script = PDF_TEST_SCRIPT.replace('__SAMPLES__', JSON.stringify(samples));
    const out = await win.webContents.executeJavaScript(script);
    const json = JSON.parse(out);
    json.workerFallback = consoleLines.some((l) => /fake worker/i.test(l)) ? 'yes' : 'no';
    writeResult({ ok: json.failures.length === 0, at: new Date().toISOString(), result: json, consoleLines });
    return json;
  } catch (err) {
    writeResult({
      ok: false,
      at: new Date().toISOString(),
      error: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : '',
      consoleLines
    });
    throw err;
  } finally {
    win.webContents.removeListener('console-message', onConsole);
  }
}

module.exports = { runPdfTest, makeSamples, RESULT_FILE, SAMPLE_DIR };