// PDF 工具界面自动测试（仅 `electron . --pdf-ui-test` 时运行）
// 作用：像真人一样点按钮，走完 PDF 工具五个方向的完整流程，逐步截图留证，并做结果文件校验：
//   ① PDF→图片（批量两份，逐页导出）  ② 图片→PDF（多图合成）
//   ③ 合并（6 页）/ 拆分（3 个文件）/ 提取页（2 页）  ④ Word/Excel→PDF（内置降级）
//   ⑤ PDF→Word（无加装包时应给出明确提示，不产生文件）
// 说明：测试模式下文件对话框直接返回测试目录里的对应类型文件（见 main.js 的 uiTest 分支）。
// 结果写入 %TEMP%/tomato-pdf-ui-test.json，截图落在 %TEMP%/tomato-uitest。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');

// 依赖按显式路径引用 UMD 产物（兼容开发态与绿色版）
const { PDFDocument, rgb, StandardFonts } = require(path.join(__dirname, '..', 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.js'));
const { makeSamples } = require('./pdf-test.js');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-pdf-ui-test.json');

/** 与主进程一致的 LibreOffice 探测（决定本测试走「加装包高保真」还是「内置降级」分支） */
function detectLibreOffice() {
  // 与 main.js 的 PORTABLE_DIR 保持一致：打包态看 exe 所在目录，开发态看 app 目录
  const { app } = require('electron');
  const base = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
  const addon = path.join(base, 'addons', 'libreoffice');
  const candidates = [
    path.join(addon, 'program', 'soffice.com'),
    path.join(addon, 'program', 'soffice.exe'),
    'C:\\Program Files\\LibreOffice\\program\\soffice.com',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com'
  ];
  return candidates.some((p) => require('fs').existsSync(p));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 造一份多页测试 PDF（纯色矩形 + 页码文字），用于读回校验 */
async function makeSamplePdf(filePath, { pages = 3, red = true, label = 'PDF' } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([400, 300]);
    const color = red ? rgb(0.85, 0.2, 0.15) : rgb(0.15, 0.3, 0.8);
    page.drawRectangle({ x: 30, y: 30, width: 140, height: 100, color });
    page.drawText(`${label} PAGE ${i}`, { x: 40, y: 220, size: 22, font, color: rgb(0.1, 0.1, 0.1) });
  }
  await fs.writeFile(filePath, await doc.save());
}

/** 读回 PDF 页数（校验产出文件） */
async function pdfInfo(file) {
  try {
    const doc = await PDFDocument.load(await fs.readFile(file));
    const stat = await fs.stat(file);
    return { ok: true, pages: doc.getPageCount(), bytes: stat.size };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function runPdfUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [] };
  const loAvailable = detectLibreOffice();

  await fs.mkdir(TEST_DIR, { recursive: true });

  // —— 清理上次夹具与产物，保证重复运行结果干净 ——
  //    注意：%TEMP%/tomato-uitest 是所有界面测试共用的夹具目录，历史运行可能留下各种文件；
  //    删除带 try/catch 并做二次复查（曾因残留 PDF 混进文件列表，把合并/拆分步骤误判为失败）
  const cleanRemoved = [];
  const cleanFailures = [];
  const cleanPass = async () => {
    for (const f of await fs.readdir(TEST_DIR)) {
      if (/\.(pdf|docx|xlsx)$/i.test(f) || f.startsWith('测试原图') || f.endsWith('_图片')) {
        try {
          await fs.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
          cleanRemoved.push(f);
        } catch (err) {
          cleanFailures.push(`${f}: ${err.message}`);
        }
      }
    }
  };
  await cleanPass();
  await cleanPass(); // 二次复查：极端情况下（文件被短暂占用后释放）第二遍能清干净
  result.steps.清理 = { removed: cleanRemoved, failures: cleanFailures };

  // —— 夹具：2 份 PDF（各 3 页）+ docx/xlsx + 2 张图片 ——
  await makeSamplePdf(path.join(TEST_DIR, '测试样本.pdf'), { red: true, label: 'RED' });
  await makeSamplePdf(path.join(TEST_DIR, '测试样本2.pdf'), { red: false, label: 'BLUE' });
  await makeSamples(TEST_DIR);
  await evalJs(`(async () => {
    const { encodeImageToBytes } = await import('../shared/imageio.js');
    const mk = async (w, h, name, tint) => {
      const px = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = (x + y * w) * 4;
        px[p] = Math.round((x / (w - 1)) * 255);
        px[p + 1] = Math.round((y / (h - 1)) * 255);
        px[p + 2] = tint ? 200 : 80;
        px[p + 3] = 255;
      }
      const bytes = await encodeImageToBytes(px, w, h, { format: 'png' });
      return window.desktop.saveImageNextTo({
        sourcePath: ${JSON.stringify(path.join(TEST_DIR, 'seed.png'))},
        baseName: name, ext: '.png', bytes
      });
    };
    return [await mk(160, 120, '测试原图PDF1', false), await mk(120, 90, '测试原图PDF2', true)];
  })()`);

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-${name}.png`);
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
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
        lastErr = new Error('截图为空');
      } catch (err) {
        lastErr = err;
        await wait(400);
      }
    }
    result.shotErrors = result.shotErrors || [];
    result.shotErrors.push(`${name}: ${lastErr ? lastErr.message : '未知错误'}`);
    return false;
  };

  const status = () => evalJs('document.getElementById("statusText").textContent');
  /** 轮询状态栏直到满足条件（转换类步骤耗时不定：LibreOffice 首次启动/大文档会慢） */
  const waitForStatusText = async (predicate, timeoutMs) => {
    const t0 = Date.now();
    for (;;) {
      const text = await status();
      if (predicate(text)) return text;
      if (Date.now() - t0 > timeoutMs) return `超时未完成：${text}`;
      await wait(400);
    }
  };
  const click = (id) => evalJs(`document.getElementById(${JSON.stringify(id)}).click()`);
  const setDirection = async (id) => {
    await evalJs(`(() => {
      const s = document.getElementById('pdfDirection');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await wait(300);
  };
  const setSelect = async (id, value) => {
    await evalJs(`(() => { document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; return true; })()`);
    await wait(120);
  };
  const setInput = async (id, value) => {
    await evalJs(`(() => { document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; return true; })()`);
    await wait(120);
  };

  // 0) 切到 PDF 工具（等工具列表渲染出来再点，避免窗口刚打开时的渲染竞态）
  await evalJs(`(async () => {
    for (let i = 0; i < 30; i++) {
      const btn = [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === 'pdf-convert');
      if (btn) { btn.click(); return true; }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('左侧工具列表里没有找到 PDF 工具');
  })()`);
  await wait(500);
  await shot('p01-打开PDF工具');
  result.steps.initialStatus = await status();

  // 1) PDF → 图片（两份 PDF，各 3 页）
  await setDirection('pdf-to-image');
  await click('pdfAddBtn');
  await wait(1500);
  result.steps.pdfToImageAdded = await status();
  await setSelect('pdfScale', '1');
  await click('pdfRunBtn');
  await wait(3000);
  result.steps.pdfToImageRun = await status();
  await shot('p02-PDF转图片完成');
  result.checks.imageExportDirs = {
    dir1: (await fs.readdir(path.join(TEST_DIR, '测试样本_图片')).catch(() => [])).sort(),
    dir2: (await fs.readdir(path.join(TEST_DIR, '测试样本2_图片')).catch(() => [])).sort()
  };
  // 导出的第一页应确实渲染出红色矩形（防止空白图）
  result.checks.exportedPage1 = await evalJs(`(async () => {
    const { decodeImageFromBytes } = await import('../shared/imageio.js');
    const bytes = await window.desktop.readFile(${JSON.stringify(path.join(TEST_DIR, '测试样本_图片', '页001.png'))});
    const img = await decodeImageFromBytes(bytes);
    let red = 0;
    for (let i = 0; i < img.pixels.length; i += 4) if (img.pixels[i] > 180 && img.pixels[i + 1] < 120) red += 1;
    return { w: img.width, h: img.height, redPixels: red };
  })()`);

  // 2) 图片 → PDF（两张图合成）
  await setDirection('image-to-pdf');
  await click('pdfAddBtn');
  await wait(1800);
  result.steps.imageToPdfAdded = await status();
  await click('pdfRunBtn');
  await wait(2000);
  result.steps.imageToPdfRun = await status();
  await shot('p03-图片转PDF完成');
  result.checks.imageToPdfFile = await pdfInfo(path.join(TEST_DIR, '测试原图PDF1_合并.pdf'));
  // 归档证据后移除产物：避免它混进后面「合并」步骤的文件选择（测试桩会返回目录内全部 PDF）
  const evidenceDir = path.join(os.tmpdir(), 'tomato-pdf-evidence');
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.rename(
    path.join(TEST_DIR, '测试原图PDF1_合并.pdf'),
    path.join(evidenceDir, '图片转PDF-合并结果.pdf')
  ).catch(() => {});

  // 3) 合并（两份 3 页 → 6 页）
  await setDirection('page-ops');
  await click('pdfAddBtn');
  await wait(1500);
  await click('pdfRunBtn');
  await wait(3000);
  result.steps.mergeRun = await status();
  await shot('p04-合并完成');
  result.checks.mergedFile = await pdfInfo(path.join(TEST_DIR, '测试样本_合并.pdf'));
  // 归档合并产物：避免它混进后面「拆分/提取」的文件选择（测试桩返回目录内全部 PDF）
  await fs.rename(
    path.join(TEST_DIR, '测试样本_合并.pdf'),
    path.join(path.join(os.tmpdir(), 'tomato-pdf-evidence'), '合并结果-6页.pdf')
  ).catch(() => {});

  // 4) 拆分（只留 1 份 PDF → 3 个单页文件）
  await fs.rm(path.join(TEST_DIR, '测试样本2.pdf'), { force: true });
  await click('pdfClearBtn');
  await wait(250);
  await click('pdfAddBtn');
  await wait(1200);
  await setSelect('pdfSubOp', 'split');
  await click('pdfRunBtn');
  await wait(3000);
  result.steps.splitRun = await status();
  result.checks.splitFiles = (await fs.readdir(TEST_DIR)).filter((f) => f.startsWith('测试样本_页')).sort();

  // 5) 提取页（1-2 页 → 2 页新文件）
  await setSelect('pdfSubOp', 'extract');
  await setInput('pdfExtractRange', '1-2');
  await click('pdfRunBtn');
  await wait(2500);
  result.steps.extractRun = await status();
  await shot('p05-拆分与提取完成');
  result.checks.extractedFile = await pdfInfo(path.join(TEST_DIR, '测试样本_提取.pdf'));

  // 6) Word/Excel → PDF（装了加装包走高保真，否则走内置降级）
  await setDirection('office-to-pdf');
  await click('pdfAddBtn');
  await wait(1500);
  result.steps.officeAdded = await status();
  result.checks.loAvailable = loAvailable;
  result.checks.loNote = await evalJs('document.getElementById("pdfLoNote") ? document.getElementById("pdfLoNote").textContent : ""');
  await click('pdfRunBtn');
  result.steps.officeRun = await waitForStatusText((t) => t.startsWith('转换完成'), loAvailable ? 120000 : 20000);
  await shot('p06-WordExcel转PDF完成');
  const officeOut = (await fs.readdir(TEST_DIR)).filter((f) => /^内置降级测试.*\.pdf$/.test(f)).sort();
  result.checks.officeOutputs = officeOut;
  result.checks.officeFirst = officeOut.length ? await pdfInfo(path.join(TEST_DIR, officeOut[0])) : null;

  // 7) PDF → Word：无加装包应明确提示且不产出；有加装包应成功产出 .docx
  await setDirection('pdf-to-word');
  result.checks.wordModeOptions = await evalJs(`(() => {
    const s = document.getElementById('pdfWordMode');
    return s ? [...s.options].map((o) => o.value) : [];
  })()`);
  await click('pdfAddBtn');
  await wait(1000);
  await click('pdfRunBtn');
  if (loAvailable) {
    result.steps.pdfToWordRun = await waitForStatusText((t) => t.startsWith('转换完成') || t.includes('失败'), 120000);
    await shot('p07-PDF转Word完成');
  } else {
    await wait(800);
    result.steps.pdfToWordGuard = await status();
    await shot('p07-PDF转Word缺少加装包提示');
  }
  result.checks.docxOutputFiles = (await fs.readdir(TEST_DIR)).filter((f) => f.endsWith('.docx')).sort();

  // 收尾：切回图片混淆，避免影响其他测试
  await evalJs(`(() => {
    const back = [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === 'obfuscate');
    if (back) back.click();
    return true;
  })()`);
  await wait(300);

  // —— 汇总判定 ——
  const c = result.checks;
  result.pass =
    result.steps.pdfToImageAdded.includes('已添加 2 项') &&
    result.steps.pdfToImageRun.includes('成功 6 页') &&
    !result.steps.pdfToImageRun.includes('失败') &&
    c.imageExportDirs.dir1.join(',') === '页001.png,页002.png,页003.png' &&
    c.imageExportDirs.dir2.length === 3 &&
    c.exportedPage1.redPixels > 1000 &&
    result.steps.imageToPdfAdded.includes('已添加 2 项') &&
    result.steps.imageToPdfRun.includes('已生成 PDF') &&
    c.imageToPdfFile.ok === true && c.imageToPdfFile.pages === 2 &&
    result.steps.mergeRun.includes('合并完成') &&
    c.mergedFile.ok === true && c.mergedFile.pages === 6 &&
    result.steps.splitRun.includes('拆分完成：共 3 个文件') &&
    c.splitFiles.length === 3 &&
    result.steps.extractRun.includes('提取完成：2 页') &&
    c.extractedFile.ok === true && c.extractedFile.pages === 2 &&
    result.steps.officeRun.includes('转换完成：成功 2 个') &&
    c.officeOutputs.length === 2 &&
    c.officeFirst && c.officeFirst.ok === true && c.officeFirst.pages >= 1 &&
    // PDF → Word：无加装包应提示不产出；有加装包应成功产出 .docx（排除测试样例本身）
    // 另校验「输出方式」选项存在（默认 text=可编辑文本）且转换结果如实标注了所用模式
    c.wordModeOptions.length === 2 && c.wordModeOptions[0] === 'text' &&
    (loAvailable
      ? String(result.steps.pdfToWordRun || '').startsWith('转换完成：成功') &&
        String(result.steps.pdfToWordRun || '').includes('可编辑文本模式') &&
        c.docxOutputFiles.some((f) => f.startsWith('测试样本'))
      : result.steps.pdfToWordGuard.includes('需要 LibreOffice 加装包') &&
        c.docxOutputFiles.every((f) => f === '内置降级测试.docx'));

  return result;
}

function writeResult(payload) {
  try {
    require('fs').writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[pdf-ui-test] 结果文件写入失败：', err.message);
  }
}

module.exports = { runPdfUiTest, writeResult, TEST_DIR, RESULT_FILE };