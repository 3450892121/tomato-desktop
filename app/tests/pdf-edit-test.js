// 「PDF 编辑整理」工具自检（`electron . --pdf-edit-test`）与界面自动测试（`--pdf-edit-ui-test`）
//
// 自检思路：
//  ① 用具名夹具（前缀「测试PDF编辑」）覆盖全部 7 个操作；
//  ② 每个操作都真实执行，并用 pdfjs / pdf-lib **读回断言**（加密能不能打开、页序、旋转、页码/水印文字、压缩前后体积）；
//  ③ 纯逻辑（页码范围、页序解析、参数校验）单独断言；
//  ④ 结果写 %TEMP%/tomato-pdf-edit-test.json，夹具只清自己前缀、开跑与收尾各清一次。
//
// 依赖说明：夹具与读回校验所需的 pdfjs / pdf-lib 都在界面进程里 import（与工具同一套路径），
//           确保「工具实际用的那份依赖」被测到。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-pdf-edit-test.json');
const UI_RESULT_FILE = path.join(os.tmpdir(), 'tomato-pdf-edit-ui-test.json');
/** 本工具夹具的专用前缀：只清自己造的文件，绝不碰其它测试的样本 */
const PREFIX = '测试PDF编辑';
/** 界面走查里加密/解密用的口令（加密后必须能被它打开，否则断言失败） */
const UI_PASSWORD = 'ui-pass-123';

function writeResult(file, payload) {
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[pdf-edit-test] 结果文件写入失败：', err.message);
  }
  return file;
}

/** 清理本工具夹具（只删「测试PDF编辑」前缀、所有扩展名） */
async function cleanFixtures() {
  const removed = [];
  const failures = [];
  let entries = [];
  try {
    entries = await fs.promises.readdir(TEST_DIR);
  } catch {
    return { removed, failures };
  }
  for (const f of entries) {
    if (!f.startsWith(PREFIX)) continue;
    try {
      await fs.promises.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
      removed.push(f);
    } catch (err) {
      failures.push(`${f}: ${err.message}`);
    }
  }
  return { removed, failures };
}

// ============================================================
// 一、PDF 操作链路自检（在界面进程里跑，含 pdfjs 渲染）
// ============================================================

const RENDERER_SCRIPT = `
  (async () => {
    const result = { steps: {}, failures: [] };
    const step = async (name, fn) => {
      try { result.steps[name] = await fn(); }
      catch (err) { result.failures.push(name + ': ' + (err && err.message ? err.message : String(err))); }
    };
    const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
    const throwsWith = async (fn, needle, label) => {
      try { await fn(); }
      catch (err) {
        const m = (err && err.message) || '';
        assert(m.includes(needle), label + ' 的报错信息不符（期望含「' + needle + '」，实际「' + m + '」）');
        return m;
      }
      throw new Error(label + ' 应当报错但没有报错');
    };

    const TEST_DIR = __TEST_DIR__;
    const lib = await import('../../node_modules/@cantoo/pdf-lib/dist/pdf-lib.esm.js');
    const ops = await import('../tools/pdf-edit/core/ops.js');
    const pagesMod = await import('../tools/pdf-edit/core/pages.js');
    const pdfops = await import('../shared/pdfops.js');
    const imageio = await import('../shared/imageio.js');
    const { PDFDocument, rgb, StandardFonts } = lib;

    const pdfText = async (pdf, n) => {
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      return tc.items.map((i) => i.str).join(' ');
    };
    const pageCount = async (bytes, password) => {
      const pdf = await pdfops.openPdfDoc(bytes, password);
      const n = pdf.numPages;
      await ops.closePdfDoc(pdf);
      return n;
    };
    /** 字节流里是否含某段 ASCII（用来直接检查 PDF 里还有没有 /Encrypt 条目） */
    const containsBytes = (bytes, needle) => {
      outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
        return true;
      }
      return false;
    };

    // —— 夹具：4 页；1~3 页各有不同颜色矩形与可见文字（用于验证页序），第 4 页是真随机噪声位图 ——
    // 噪声必须用 32 位安全 PRNG（Math.imul）：早先用 seed * 1103515245 会超出浮点精度、
    // 退化成极短周期，位图被 Flate 压到近乎为零，反而导致「压缩后比原文件大」的假失败。
    const w = 500, h = 700;
    const noise = new Uint8ClampedArray(w * h * 4);
    let seed = 123456789 >>> 0;
    const nextByte = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 24;
    };
    for (let i = 0; i < noise.length; i += 4) {
      noise[i] = nextByte(); noise[i + 1] = nextByte(); noise[i + 2] = nextByte(); noise[i + 3] = 255;
    }
    const noisePng = await imageio.encodeImageToBytes(noise, w, h, { format: 'png' });

    let fixtureBytes = null;
    let fixturePath = '';
    await step('fixture', async () => {
      const doc = await PDFDocument.create();
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const colors = [rgb(0.85, 0.2, 0.15), rgb(0.15, 0.65, 0.25), rgb(0.15, 0.3, 0.85)];
      for (let i = 1; i <= 3; i++) {
        const page = doc.addPage([400, 300]);
        page.drawRectangle({ x: 30, y: 30, width: 180, height: 120, color: colors[i - 1] });
        page.drawText('PAGE ' + i, { x: 40, y: 220, size: 24, font: bold, color: rgb(0.1, 0.1, 0.1) });
      }
      const img = await doc.embedPng(noisePng);
      const p4 = doc.addPage([w, h]);
      p4.drawImage(img, { x: 0, y: 0, width: w, height: h });
      fixtureBytes = await doc.save();
      fixturePath = await window.desktop.saveImageNextTo({
        targetDir: TEST_DIR, baseName: '测试PDF编辑-样本', ext: '.pdf', bytes: fixtureBytes
      });
      return { path: fixturePath, bytes: fixtureBytes.length, noisePng: noisePng.length, pages: 4 };
    });
    if (!fixtureBytes) return JSON.stringify(result);

    // —— 中文字体（缺失时明确降级） ——
    let fontBytes = null;
    await step('cjkFont', async () => {
      // 与工具走同一条路：先试主进程 ocr:font（路径由主进程按 PORTABLE_DIR 解析，开发态与
      // 打包产物都正确），再回退到 ops.cjkFontPath() 的相对路径。
      // 回退路径在产物上必然失败：本测试文件在 resources/app/tests/，而 addons 在产物根目录，
      // 相对深度对不上。曾经这里只试相对路径 → 产物上 fontBytes=null → 下面 watermarkCjk 与
      // pageNumbersSkipFirstCjk 两个中文用例被静默跳过，而整体仍报 ok:true（假绿）。
      const p = ops.cjkFontPath();
      let via = 'none';
      if (typeof window.desktop.ocrFont === 'function') {
        try {
          const f = await window.desktop.ocrFont();
          if (f && f.ok && f.bytes && f.bytes.length) { fontBytes = f.bytes; via = 'ocr:font'; }
        } catch { /* 落到下面的相对路径回退 */ }
      }
      if (!fontBytes) {
        try {
          fontBytes = await window.desktop.readFile(p);
          if (fontBytes && fontBytes.length) via = 'readFile(相对路径)';
        } catch (err) {
          fontBytes = null;
        }
      }
      return { path: p, via, found: !!(fontBytes && fontBytes.length), bytes: fontBytes ? fontBytes.length : 0 };
    });

    // —— 纯逻辑：页码范围 / 页序解析 / 参数校验 ——
    await step('pagesLogic', async () => ({
      range: pagesMod.parsePageRange('1-2, 5', 6).join(','),
      rangeAll: String(pagesMod.parsePageRange('', 6)),
      format: pagesMod.formatPageRange([1, 2, 3, 5, 6]),
      orderArray: ops.normalizeOrder([3, 1, 2], 4).join(','),
      orderText: ops.normalizeOrder('3,1,2', 4).join(','),
      orderRange: ops.normalizeOrder('2-3,1', 4).join(',')
    }));

    await step('validation', async () => {
      const out = {};
      out.badAngle = await throwsWith(() => ops.rotatePages(fixtureBytes, { angle: 45 }), '90', '非法旋转角度');
      out.emptyWatermark = await throwsWith(() => ops.addTextWatermark(fixtureBytes, { text: '  ' }), '水印文字', '空水印文字');
      out.noPassword = await throwsWith(() => ops.encryptPdf(fixtureBytes, {}), '请至少设置一个密码', '未设置密码');
      out.plainDecrypt = await throwsWith(() => ops.decryptPdf(fixtureBytes, { password: 'x' }), '没有打开密码', '解密未加密文件');
      out.badOrder = await throwsWith(() => ops.reorderPages(fixtureBytes, { order: '9' }), '页码超出范围', '越界页序');
      out.emptyOrder = await throwsWith(() => ops.reorderPages(fixtureBytes, { order: '' }), '请填写新的页序', '空页序');
      out.badFormat = await throwsWith(() => ops.addPageNumbers(fixtureBytes, { format: ' ' }), '页码格式', '空页码格式');
      return out;
    });

    // —— 加密 / 解密 ——
    let encryptedBytes = null;
    await step('encrypt', async () => {
      encryptedBytes = await ops.encryptPdf(fixtureBytes, {
        userPassword: 'edit123', ownerPassword: 'owner456',
        permissions: { printing: true, copying: false, modifying: false }
      });
      let noPwd = 'opened';
      try {
        const pdf = await pdfops.openPdfDoc(encryptedBytes);
        await ops.closePdfDoc(pdf);
      } catch (err) { noPwd = err.message; }
      const pdf = await pdfops.openPdfDoc(encryptedBytes, 'edit123');
      const n = pdf.numPages;
      const txt = await pdfText(pdf, 1);
      await ops.closePdfDoc(pdf);
      // 直接用 pdf-lib 再验一次：加密产物必须「不输密码打不开」
      let pdfLibLoadsWithoutPassword = true;
      try { await PDFDocument.load(encryptedBytes); } catch (e) { pdfLibLoadsWithoutPassword = false; }
      return {
        bytes: encryptedBytes.length,
        openWithoutPassword: noPwd,
        openWithPassword: n,
        page1HasText: txt.includes('PAGE 1'),
        hasEncryptEntry: containsBytes(encryptedBytes, '/Encrypt'),
        pdfLibLoadsWithoutPassword
      };
    });

    await step('decrypt', async () => {
      const out = await ops.decryptPdf(encryptedBytes, { password: 'edit123' });
      const pdf = await pdfops.openPdfDoc(out);
      const n = pdf.numPages;
      const txt = await pdfText(pdf, 1);
      await ops.closePdfDoc(pdf);
      // 关键回归点：pdf-lib 曾在「带密码载入后直接 save」时把 /Encrypt 原样写回，
      // 产出的文件仍然打不开——这里用「字节里还有没有 /Encrypt + pdf-lib 不输密码能否载入」双重把关。
      let pdfLibLoadsWithoutPassword = true;
      let pdfLibInfo = '';
      try {
        const d = await PDFDocument.load(out);
        pdfLibInfo = 'ok(' + d.getPageCount() + 'p)';
      } catch (err) {
        pdfLibLoadsWithoutPassword = false;
        pdfLibInfo = String(err.message).slice(0, 60);
      }
      return {
        bytes: out.length,
        pages: n,
        page1HasText: txt.includes('PAGE 1'),
        hasEncryptEntry: containsBytes(out, '/Encrypt'),
        pdfLibLoadsWithoutPassword,
        pdfLibInfo
      };
    });

    await step('decryptWrongPassword', async () => {
      const msg = await throwsWith(() => ops.decryptPdf(encryptedBytes, { password: 'nope' }), '密码不对', '解密用错密码');
      return msg;
    });

    // —— 旋转（1、3 页转 90°） ——
    await step('rotate', async () => {
      const out = await ops.rotatePages(fixtureBytes, { pages: [1, 3], angle: 90 });
      const pdf = await pdfops.openPdfDoc(out);
      const p1 = await pdf.getPage(1);
      const p2 = await pdf.getPage(2);
      const p3 = await pdf.getPage(3);
      const v1 = p1.getViewport({ scale: 1 });
      const v2 = p2.getViewport({ scale: 1 });
      await ops.closePdfDoc(pdf);
      return { rotate1: p1.rotate, rotate2: p2.rotate, rotate3: p3.rotate, size1: Math.round(v1.width) + 'x' + Math.round(v1.height), size2: Math.round(v2.width) + 'x' + Math.round(v2.height) };
    });

    // —— 重排（数组与文本两种入参；每页文字不同，验页序） ——
    await step('reorder', async () => {
      const out = await ops.reorderPages(fixtureBytes, { order: [3, 1, 2, 4] });
      const pdf = await pdfops.openPdfDoc(out);
      const t1 = await pdfText(pdf, 1);
      const t2 = await pdfText(pdf, 2);
      const t3 = await pdfText(pdf, 3);
      await ops.closePdfDoc(pdf);
      return { pages: await pageCount(out), p1: t1.includes('PAGE 3'), p2: t2.includes('PAGE 1'), p3: t3.includes('PAGE 2') };
    });

    await step('reorderText', async () => {
      const out = await ops.reorderPages(fixtureBytes, { order: '2,1' });
      const pdf = await pdfops.openPdfDoc(out);
      const t1 = await pdfText(pdf, 1);
      const t2 = await pdfText(pdf, 2);
      await ops.closePdfDoc(pdf);
      return { pages: await pageCount(out), p1: t1.includes('PAGE 2'), p2: t2.includes('PAGE 1') };
    });

    // —— 水印 ——
    await step('watermark', async () => {
      const out = await ops.addTextWatermark(fixtureBytes, {
        text: 'CONFIDENTIAL-TEST', fontSize: 30, opacity: 0.3, rotation: 30, color: '#808080', position: 'center'
      });
      const pdf = await pdfops.openPdfDoc(out);
      const t1 = await pdfText(pdf, 1);
      const t3 = await pdfText(pdf, 3);
      await ops.closePdfDoc(pdf);
      return { pages: await pageCount(out), p1HasWatermark: t1.includes('CONFIDENTIAL-TEST'), p3HasWatermark: t3.includes('CONFIDENTIAL-TEST') };
    });

    await step('watermarkTile', async () => {
      const out = await ops.addTextWatermark(fixtureBytes, { text: 'TILE-MARK', fontSize: 14, opacity: 0.2, tile: true });
      const pdf = await pdfops.openPdfDoc(out);
      const page = await pdf.getPage(1);
      const tc = await page.getTextContent();
      const hits = tc.items.filter((i) => i.str.trim() === 'TILE-MARK').length;
      await ops.closePdfDoc(pdf);
      return { occurrencesOnPage1: hits };
    });

    await step('watermarkCjk', async () => {
      if (!fontBytes) return { skipped: '未找到中文字体（addons/ocr/fonts），已按降级路径跳过' };
      const out = await ops.addTextWatermark(fixtureBytes, { text: '内部资料', fontSize: 30, position: 'center', fontBytes });
      const pdf = await pdfops.openPdfDoc(out);
      const t1 = await pdfText(pdf, 1);
      await ops.closePdfDoc(pdf);
      return { bytes: out.length, pages: await pageCount(out), p1HasCjkWatermark: t1.includes('内部资料') };
    });

    // —— 页码（ASCII 保证可用内置字体读回；中文单独记录） ——
    await step('pageNumbers', async () => {
      const out = await ops.addPageNumbers(fixtureBytes, { format: 'Page {n} of {total}', startAt: 1, position: 'bottom-center', fontSize: 12 });
      const pdf = await pdfops.openPdfDoc(out);
      const t1 = await pdfText(pdf, 1);
      const t4 = await pdfText(pdf, 4);
      await ops.closePdfDoc(pdf);
      return { pages: await pageCount(out), p1: t1.includes('Page 1 of 4'), p4: t4.includes('Page 4 of 4') };
    });

    await step('pageNumbersSkipFirstCjk', async () => {
      if (!fontBytes) return { skipped: '未找到中文字体（addons/ocr/fonts），已按降级路径跳过' };
      const out = await ops.addPageNumbers(fixtureBytes, { format: '第 {n} 页 / 共 {total} 页', skipFirst: true, startAt: 5, fontBytes });
      const pdf = await pdfops.openPdfDoc(out);
      const t1 = await pdfText(pdf, 1);
      const t2 = await pdfText(pdf, 2);
      await ops.closePdfDoc(pdf);
      return { p1HasNumber: t1.includes('第 5 页'), p2HasNumber: t2.includes('第 6 页') };
    });

    // —— 压缩（体积下降 + 页数不变 + 能正常渲染） ——
    await step('compress', async () => {
      const res = await ops.compressPdfOp(fixtureBytes, { preset: 'strong', grayscale: false });
      assert(res && res.bytes, '压缩没有产出字节');
      const pdf = await pdfops.openPdfDoc(res.bytes);
      const n = pdf.numPages;
      const rendered = await pdfops.renderPdfPage(pdf, 1, { scale: 0.5 });
      let dark = 0;
      for (let i = 0; i < rendered.pixels.length; i += 4) if (rendered.pixels[i] < 200) dark += 1;
      await ops.closePdfDoc(pdf);
      return {
        originalBytes: res.originalBytes, bytes: res.bytes.length, ratio: +(res.bytes.length / res.originalBytes).toFixed(3),
        pages: n, preset: res.preset, attempts: res.attempts, renderedNonWhite: dark
      };
    });

    return JSON.stringify(result);
  })()
`;

/**
 * 运行「PDF 编辑整理」自检（在界面进程里执行）
 * @param {import('electron').BrowserWindow} win
 */
async function runPdfEditTest(win) {
  const consoleLines = [];
  const onConsole = (...args) => {
    const details = args[1] && typeof args[1] === 'object' ? args[1] : null;
    const message = details && typeof details.message === 'string' ? details.message : String(args[2] ?? '');
    if (message) consoleLines.push(message);
  };
  win.webContents.on('console-message', onConsole);
  try {
    await fs.promises.mkdir(TEST_DIR, { recursive: true });
    const cleanBefore = await cleanFixtures();
    const script = RENDERER_SCRIPT.replace('__TEST_DIR__', JSON.stringify(TEST_DIR));
    const out = await win.webContents.executeJavaScript(script);
    const json = JSON.parse(out);
    const cleanAfter = await cleanFixtures();

    // —— 汇总 ——
    // 约定：返回 { ok, steps, failures, checks }（与其它工具自检一致，汇总器按 ok === true 判定）。
    // failures 里既有「步骤抛错」，也有「步骤没报错但数字不达标」，保证失败时一定说得出原因。
    const steps = json.steps || {};
    const failures = [...(json.failures || [])];
    const REQUIRED = [
      'fixture', 'cjkFont', 'pagesLogic', 'validation', 'encrypt', 'decrypt',
      'decryptWrongPassword', 'rotate', 'reorder', 'reorderText', 'watermark',
      'watermarkTile', 'pageNumbers', 'compress'
    ];
    for (const k of REQUIRED) if (!(k in steps)) failures.push(`缺少步骤：${k}`);

    const checks = {
      encryptOutput: !!(steps.encrypt && steps.encrypt.bytes > 0),
      encryptBlockedWithoutPassword: !!(steps.encrypt && steps.encrypt.openWithoutPassword && steps.encrypt.openWithoutPassword !== 'opened'),
      encryptOpensWithPassword: !!(steps.encrypt && steps.encrypt.openWithPassword === 4 && steps.encrypt.page1HasText === true),
      encryptWritesEncryptEntry: !!(steps.encrypt && steps.encrypt.hasEncryptEntry === true && steps.encrypt.pdfLibLoadsWithoutPassword === false),
      decryptDropsEncryptEntry: !!(steps.decrypt && steps.decrypt.hasEncryptEntry === false && steps.decrypt.pdfLibLoadsWithoutPassword === true),
      decryptOpensWithoutPassword: !!(steps.decrypt && steps.decrypt.pages === 4 && steps.decrypt.page1HasText === true),
      decryptWrongPasswordGuard: typeof steps.decryptWrongPassword === 'string' && steps.decryptWrongPassword.includes('密码不对'),
      rotate: !!(steps.rotate && steps.rotate.rotate1 === 90 && steps.rotate.rotate2 === 0 && steps.rotate.rotate3 === 90),
      reorder: !!(steps.reorder && steps.reorder.p1 === true && steps.reorder.p2 === true && steps.reorder.p3 === true),
      reorderText: !!(steps.reorderText && steps.reorderText.p1 === true && steps.reorderText.p2 === true),
      watermarkReadable: !!(steps.watermark && steps.watermark.p1HasWatermark === true && steps.watermark.p3HasWatermark === true),
      watermarkTiled: !!(steps.watermarkTile && steps.watermarkTile.occurrencesOnPage1 > 1),
      pageNumbersReadable: !!(steps.pageNumbers && steps.pageNumbers.p1 === true && steps.pageNumbers.p4 === true),
      compressed: !!(steps.compress && steps.compress.bytes < steps.compress.originalBytes &&
        steps.compress.pages === 4 && steps.compress.renderedNonWhite > 0),
      validationMessagesChinese: !!(steps.validation && Object.values(steps.validation).every((m) => typeof m === 'string' && /[\u4e00-\u9fff]/.test(m)))
    };
    for (const [k, v] of Object.entries(checks)) if (!v) failures.push(`关键结果不达标：${k}`);

    // —— 假绿防线：缺资源时的「跳过」必须算失败，不能让 ok:true 混过去 ——
    // 有些步骤在缺资源时会返回 { skipped: … } 并跳过断言。v2.11.1 之前产物上字体路径解析
    // 错误，watermarkCjk / pageNumbersSkipFirstCjk 就是这样被静默跳过、整体仍报 ok:true，
    // 「产物上中文水印是坏的」这个真实缺陷因此一直没被发现。
    // 为什么算失败而不是像 --imghide-test 那样用 ok/verified 两字段区分：imghide 的裁判是
    // **刻意不随包分发**的第三方参照，缺它情有可原；而中文字体是加装包里的普通资产，
    // 与本测试硬性要求的 OCR 引擎同一来源——缺它的环境里，中文水印/页码功能本身就坏了，
    // 测试理应报失败而不是「跑过的都过」。
    // verified 作为描述性字段保留：= ok 且无跳过且字体就位（全绿时应与 ok 相等）。
    const skipped = Object.entries(steps)
      .filter(([, v]) => v && typeof v === 'object' && typeof v.skipped === 'string')
      .map(([k, v]) => ({ step: k, reason: v.skipped }));
    const cjkFontFound = !!(steps.cjkFont && steps.cjkFont.found === true);
    if (skipped.length) {
      failures.push(`verified 未达标：${skipped.length} 项被跳过（${skipped.map((s) => s.step).join(', ')}）——缺资源的降级路径不应算通过`);
    } else if (!cjkFontFound) {
      failures.push('verified 未达标：中文字体未就位（cjkFont.found=false）');
    }

    const ok = failures.length === 0;
    const verified = ok && skipped.length === 0 && cjkFontFound;
    writeResult(RESULT_FILE, { ok, verified, at: new Date().toISOString(), cleanBefore, cleanAfter, checks, skipped, failures, steps, consoleLines });
    return { ok, verified, skipped, steps, failures, checks };
  } catch (err) {
    const message = `自检异常：${err && err.message ? err.message : String(err)}`;
    writeResult(RESULT_FILE, {
      ok: false,
      at: new Date().toISOString(),
      error: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : '',
      consoleLines
    });
    // 不往外抛：统一用 ok=false + failures 表达失败，汇总器才拿得到原因
    return { ok: false, steps: {}, failures: [message, String((err && err.stack) || '')], checks: {} };
  } finally {
    win.webContents.removeListener('console-message', onConsole);
  }
}

// ============================================================
// 二、界面自动测试（像真人一样点按钮走完 7 个操作）
// ============================================================

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 造一份界面测试用 PDF（纯文字 + 色块，体积小、跑得快） */
async function makeUiFixture(filePath, { pages = 3, label = 'UI', red = true } = {}) {
  const { PDFDocument, rgb, StandardFonts } = require(path.join(__dirname, '..', 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.js'));
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([400, 300]);
    page.drawRectangle({ x: 30, y: 30, width: 160, height: 110, color: red ? rgb(0.85, 0.2, 0.15) : rgb(0.15, 0.3, 0.85) });
    page.drawText(`${label} PAGE ${i}`, { x: 40, y: 220, size: 22, font, color: rgb(0.1, 0.1, 0.1) });
  }
  await fs.promises.writeFile(filePath, await doc.save());
}

// —— 产物读回 ——
// 用 @cantoo/pdf-lib（只有这一支支持带密码载入），才能验证「不输密码打不开 / 输密码能打开且页数正确」。
const CANT_PDFLIB = path.join(__dirname, '..', 'node_modules', '@cantoo', 'pdf-lib', 'dist', 'pdf-lib.js');

/**
 * 读回一份 PDF
 * @param {string} file
 * @param {string} [password] 不给就按「不输密码」尝试（加密文件会失败，这正是我们要断言的）
 */
async function pdfOpenInfo(file, password) {
  try {
    const { PDFDocument } = require(CANT_PDFLIB);
    const bytes = await fs.promises.readFile(file);
    const doc = await PDFDocument.load(bytes, password ? { password } : undefined);
    return { ok: true, pages: doc.getPageCount(), bytes: bytes.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 界面自动走查（对外入口）
 * 约定：永不抛异常——任何失败都写进 failures 并让 pass=false，否则汇总器只看到「未通过」而定位不到原因。
 */
async function runPdfEditUiTest(win) {
  try {
    return await runPdfEditUiTestBody(win);
  } catch (err) {
    return {
      steps: {},
      checks: {},
      shots: [],
      failures: [`界面走查异常：${err && err.message ? err.message : String(err)}`, String((err && err.stack) || '')],
      pass: false
    };
  }
}

async function runPdfEditUiTestBody(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [], failures: [] };
  const fail = (msg) => {
    if (msg && !result.failures.includes(msg)) result.failures.push(msg);
  };
  const shotErrors = [];

  await fs.promises.mkdir(TEST_DIR, { recursive: true });
  const cleanBefore = await cleanFixtures();

  // 夹具：2 份 3 页 PDF
  const fixtureA = path.join(TEST_DIR, `${PREFIX}-界面样本1.pdf`);
  const fixtureB = path.join(TEST_DIR, `${PREFIX}-界面样本2.pdf`);
  await makeUiFixture(fixtureA, { label: 'A', red: true });
  await makeUiFixture(fixtureB, { label: 'B', red: false });

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-ped-${name}.png`);
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        win.show();
        win.focus();
        if (wc.setBackgroundThrottling) wc.setBackgroundThrottling(false);
        await wait(200);
        const image = await wc.capturePage();
        if (image && !image.isEmpty()) {
          await fs.promises.writeFile(file, image.toPNG());
          result.shots.push(file);
          return true;
        }
        lastErr = new Error('截图为空');
      } catch (err) {
        lastErr = err;
        await wait(400);
      }
    }
    shotErrors.push(`${name}: ${lastErr ? lastErr.message : '未知错误'}`);
    return false;
  };

  const status = () => evalJs('document.getElementById("statusText").textContent');
  /** 每类操作建好后参数区必须出现的控件（用于确认「切操作 → 参数区已重建」） */
  const OP_CONTROLS = {
    compress: ['pedPreset', 'pedMaxMB'],
    watermark: ['pedText', 'pedTile'],
    pagenumbers: ['pedNumFormat'],
    rotate: ['pedAngle', 'pedRotatePages'],
    reorder: ['pedOrder'],
    encrypt: ['pedUserPwd', 'pedOwnerPwd', 'pedPermPrint'],
    decrypt: ['pedDecryptPwd']
  };
  const click = async (id) => {
    try {
      await evalJs(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) throw new Error('缺少元素'); el.click(); return true; })()`);
    } catch (err) {
      fail(`点击 ${id} 失败：${err.message}`);
    }
  };
  const setField = async (id, value, prop) => {
    try {
      await evalJs(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) throw new Error('缺少元素'); el.${prop} = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input')); return true; })()`);
    } catch (err) {
      fail(`设置 ${id} 失败：${err.message}`);
    }
    await wait(120);
  };
  const setInput = (id, value) => setField(id, value, 'value');
  const setCheck = (id, checked) => setField(id, !!checked, 'checked');
  const paramIds = () => evalJs('[...document.querySelectorAll("#pedParams [id]")].map((e) => e.id)');
  const setOp = async (id) => {
    try {
      await evalJs(`(() => {
        const s = document.getElementById('pedOp');
        if (!s) throw new Error('缺少操作类型下拉框');
        s.value = ${JSON.stringify(id)};
        s.dispatchEvent(new Event('change'));
        return true;
      })()`);
    } catch (err) {
      fail(`切换到「${id}」失败：${err.message}`);
    }
    await wait(300);
    const have = await paramIds().catch(() => []);
    const need = OP_CONTROLS[id] || [];
    const missing = need.filter((x) => !Array.isArray(have) || !have.includes(x));
    if (missing.length) fail(`切到「${id}」后参数区缺少控件：${missing.join('、')}`);
  };
  const runLabel = () => evalJs('(() => { const b = document.getElementById("pedRunBtn"); return b ? b.textContent : ""; })()');
  const isBusyLabel = (l) => l === '取消' || l === '取消中…';
  const waitFor = async (fn, timeoutMs, intervalMs = 150) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) return null;
      await wait(intervalMs);
    }
  };
  /** 等工具空闲（运行按钮不再是「取消」）——否则下一步的点击会变成「取消」而不是「运行」 */
  const waitIdle = async (timeoutMs = 180000) => {
    const label = await waitFor(async () => {
      const l = await runLabel();
      return isBusyLabel(l) ? null : l;
    }, timeoutMs);
    if (label === null) {
      const l = await runLabel();
      fail(`等待上一轮结束超时（按钮仍显示「${l}」）`);
      return l;
    }
    return label;
  };
  /**
   * 点「开始处理」并等本轮真正结束，再读状态栏
   * 关键：不能只等「状态栏含成功」——上一轮的成功文案还在，会立刻误判（这是之前加密/解密没跑通的根因）。
   * 改为盯运行按钮：变「取消」= 已开始，变回操作名 = 已结束。
   */
  const runOp = async (name, timeoutMs = 180000) => {
    await waitIdle();
    await click('pedRunBtn');
    await waitFor(async () => isBusyLabel(await runLabel()), 3000, 100); // 快操作可能已跑完，等不到也算正常
    const ended = await waitFor(async () => !isBusyLabel(await runLabel()), timeoutMs);
    if (!ended) fail(`${name}: 运行超时未结束`);
    await wait(400);
    const text = String(await status());
    result.steps[name] = text;
    // 顺带记下工具底部显示的「输出：<路径>」——产物没出现在预期位置时，这是最直接的线索
    result.steps[`${name}Output`] = await evalJs('document.getElementById("pedResult").textContent').catch(() => '');
    if (!(text.includes('完成') && text.includes('成功') && !text.includes('失败'))) {
      fail(`${name}: 未成功（状态栏「${text}」）`);
    }
    return text;
  };
  const listCount = () => evalJs('document.querySelectorAll("#pedList .ped-item").length');
  /** 点「添加文件」并等列表项数达标（读盘 + 数页数耗时不定） */
  const addFiles = async (expected, name) => {
    await waitIdle();
    await click('pedAddBtn');
    // 注意：waitFor 以「真值」为完成信号，0 是假值，所以这里返回 true 而不是数量
    const ok = await waitFor(async () => ((await listCount()) >= expected ? true : null), 30000, 300);
    const actual = await listCount();
    if (!ok || actual !== expected) fail(`${name}: 列表应有 ${expected} 项，实际 ${actual}`);
    return actual;
  };

  // 0) 切到工具页（左侧「文档」分组默认可能收起，先展开再点）
  await evalJs(`(async () => {
    const group = document.querySelector('.tool-group[data-group-id="doc"]');
    if (group && group.classList.contains('is-collapsed')) {
      group.querySelector('.tool-group-head').click();
      await new Promise((r) => setTimeout(r, 300));
    }
    for (let i = 0; i < 30; i++) {
      const btn = document.querySelector('.tool-item[data-tool-id="pdf-edit"]');
      if (btn) { btn.click(); return true; }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('左侧工具列表里没有找到「PDF 编辑整理」');
  })()`);
  await wait(600);
  await shot('01-打开工具');
  result.steps.initialStatus = await status();
  result.checks.opsOptions = await evalJs('[...document.querySelectorAll("#pedOp option")].map((o) => o.value)');

  // 1) 压缩瘦身
  await setOp('compress');
  result.checks.addedCount = await addFiles(2, '添加夹具');
  await runOp('compressRun');
  await shot('02-压缩完成');

  // 2) 水印（默认文字是中文，改用英文避免依赖字体）
  await setOp('watermark');
  await setInput('pedText', 'UI-WATERMARK');
  await setInput('pedRotation', '0');
  await runOp('watermarkRun');
  // 第二组：全页平铺（验证参数切换）
  await setCheck('pedTile', true);
  await runOp('watermarkTileRun');
  await shot('03-水印完成');

  // 3) 页码（英文格式，避免中文字体依赖）
  await setOp('pagenumbers');
  await setInput('pedNumFormat', 'Page {n} of {total}');
  await runOp('pageNumbersRun');
  await shot('04-页码完成');

  // 4) 旋转
  await setOp('rotate');
  await setInput('pedRotatePages', '1-2');
  await runOp('rotateRun');
  await shot('05-旋转完成');

  // 5) 重排
  await setOp('reorder');
  await setInput('pedOrder', '3,1,2');
  await runOp('reorderRun');
  await shot('06-重排完成');

  // 6) 加密（把打开/所有者密码真正填进输入框再运行）
  await setOp('encrypt');
  await setInput('pedUserPwd', UI_PASSWORD);
  await setInput('pedOwnerPwd', 'ui-owner-456');
  await setCheck('pedPermPrint', true);
  await setCheck('pedPermCopy', false);
  await runOp('encryptRun');
  await shot('07-加密完成');

  const encryptOuts = (await fs.promises.readdir(TEST_DIR)).filter((f) => f.startsWith(PREFIX) && f.includes('_加密')).sort();
  result.checks.prefixFilesAfterEncrypt = (await fs.promises.readdir(TEST_DIR)).filter((f) => f.startsWith(PREFIX)).sort();
  result.checks.encryptOutputs = encryptOuts;
  result.checks.encryptedCannotOpenWithoutPassword = [];
  result.checks.encryptedOpenWithPassword = [];
  for (const f of encryptOuts) {
    const abs = path.join(TEST_DIR, f);
    const withoutPwd = await pdfOpenInfo(abs);                 // 不输密码：应失败
    result.checks.encryptedCannotOpenWithoutPassword.push(withoutPwd.ok === false);
    result.checks.encryptedOpenWithPassword.push(await pdfOpenInfo(abs, UI_PASSWORD)); // 输密码：应能打开
  }

  // 7) 解密：只留加密产物作为输入，其余清掉（避免未加密文件解密失败混进统计）
  for (const f of await fs.promises.readdir(TEST_DIR)) {
    if (f.startsWith(PREFIX) && !f.includes('_加密')) {
      await fs.promises.rm(path.join(TEST_DIR, f), { force: true });
    }
  }
  await waitIdle();
  await click('pedClearBtn');
  await wait(300);
  await setOp('decrypt');
  await setInput('pedDecryptPwd', UI_PASSWORD);
  result.checks.decryptInputCount = await addFiles(encryptOuts.length, '添加加密产物');
  await runOp('decryptRun');
  await shot('08-解密完成');

  const decryptOuts = (await fs.promises.readdir(TEST_DIR)).filter((f) => f.startsWith(PREFIX) && f.includes('_解密')).sort();
  result.checks.decryptOutputs = decryptOuts;
  result.checks.decryptOutputsOpenWithoutPassword = [];
  result.checks.decryptFileInfos = [];
  for (const f of decryptOuts) {
    const abs = path.join(TEST_DIR, f);
    const info = await pdfOpenInfo(abs);
    result.checks.decryptOutputsOpenWithoutPassword.push(info.ok === true);
    result.checks.decryptFileInfos.push(info);
  }

  // 收尾：切回图片混淆，避免影响其它测试
  await evalJs(`(() => {
    const back = document.querySelector('.tool-item[data-tool-id="obfuscate"]');
    if (back) back.click();
    return true;
  })()`);
  await wait(300);

  const cleanAfter = await cleanFixtures();
  result.cleaning = { before: cleanBefore, after: cleanAfter };
  if (shotErrors.length) result.shotErrors = shotErrors;

  // —— 汇总判定：除了看各步状态栏，还要逐项核对产物（失败必写原因） ——
  const c = result.checks;
  const conditions = {
    '操作类型齐全': Array.isArray(c.opsOptions) && c.opsOptions.join(',') === 'compress,watermark,pagenumbers,rotate,reorder,encrypt,decrypt',
    '夹具添加数': c.addedCount === 2,
    '加密产物数': Array.isArray(c.encryptOutputs) && c.encryptOutputs.length === 2,
    '加密后不输密码打不开': Array.isArray(c.encryptedCannotOpenWithoutPassword) &&
      c.encryptedCannotOpenWithoutPassword.length === 2 && c.encryptedCannotOpenWithoutPassword.every((v) => v === true),
    '输密码能打开且页数正确': Array.isArray(c.encryptedOpenWithPassword) &&
      c.encryptedOpenWithPassword.length === 2 && c.encryptedOpenWithPassword.every((i) => i.ok === true && i.pages === 3),
    '解密输入数': c.decryptInputCount === 2,
    '解密产物数': Array.isArray(c.decryptOutputs) && c.decryptOutputs.length === 2,
    '解密产物无密码可打开': Array.isArray(c.decryptOutputsOpenWithoutPassword) &&
      c.decryptOutputsOpenWithoutPassword.length === 2 && c.decryptOutputsOpenWithoutPassword.every((v) => v === true),
    '解密产物页数正确': Array.isArray(c.decryptFileInfos) &&
      c.decryptFileInfos.length === 2 && c.decryptFileInfos.every((i) => i.ok === true && i.pages === 3)
  };
  for (const [k, v] of Object.entries(conditions)) if (!v) fail(`结果不达标：${k}`);

  result.pass = result.failures.length === 0;
  return result;
}

async function runPdfEditUiTestAndWrite(win) {
  try {
    const result = await runPdfEditUiTest(win);
    writeResult(UI_RESULT_FILE, { ok: !!result.pass, at: new Date().toISOString(), result });
    return result;
  } catch (err) {
    writeResult(UI_RESULT_FILE, { ok: false, at: new Date().toISOString(), error: err.message, stack: err.stack });
    throw err;
  }
}

module.exports = {
  runPdfEditTest,
  runPdfEditUiTest,
  runPdfEditUiTestAndWrite,
  cleanFixtures,
  RESULT_FILE,
  UI_RESULT_FILE,
  TEST_DIR,
  PREFIX
};