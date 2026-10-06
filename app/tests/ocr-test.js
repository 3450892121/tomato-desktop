// 文字识别（OCR）自动测试（仅 `electron . --ocr-test` / `--ocr-ui-test` 时运行）
//
// runOcrTest(win)：在界面进程里跑（需要 canvas 与 pdfjs）——
//   1) 在 %TEMP%\tomato-uitest 现画中文「扫描件」夹具（灰底 + 噪声 + 轻微倾斜）与多页扫描式 PDF；
//   2) 真实调用 OCR（主进程引擎）识别，做字符级召回校验；
//   3) **核心断言**：产出的「可搜索 PDF」能被 pdfjs 打开、页数一致、getTextContent() 读得到识别出的中文；
//   4) 校验 .txt 内容、.docx 结构（主进程用 JSZip 解回）、预处理对召回率的影响、
//      扫描件压缩（体积下降 / 页数不变 / 可渲染）、无效文件的中文报错；
//   5) 纯逻辑断言：linesToText / computePdfTextPlacement / preprocess / linesToDocx。
//
// runOcrUiTest(win)：像真人一样「展开文档分组 → 切到文字识别 → 添加夹具 → 选输出 → 开始识别 → 清空」，
//   每步截图并校验产物存在且 PDF 可搜索。
//
// 结果分别写 %TEMP%\tomato-ocr-test.json 与 %TEMP%\tomato-ocr-ui-test.json。
'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-ocr-test.json');
const UI_RESULT_FILE = path.join(os.tmpdir(), 'tomato-ocr-ui-test.json');
/** 夹具与产物前缀：清理/断言都只认它，避免与其它界面测试互相污染 */
const FIXTURE_PREFIX = /^测试识别/;
const SHOT_PREFIX = /^shot-ocr-/;

/** 图片夹具：文件名 → 预期文本 + 干扰参数（模拟扫描件） */
const IMAGE_FIXTURES = [
  { file: '测试识别A.png', bg: '#ffffff', noise: 0, rotate: 0, lines: ['番茄图片混淆工具箱', '离线文字识别测试'] },
  { file: '测试识别B.png', bg: '#e6e6e6', noise: 0.06, rotate: 3, lines: ['扫描件文字识别效果验证', '第二行测试内容'] }
];
/** 多页扫描式 PDF 夹具（每页一张中文位图） */
const SCAN_PDF_FILE = '测试识别扫描件.pdf';
const SCAN_PDF_PAGES = [
  ['扫描版第一页文字', '离线识别验证'],
  ['第二页扫描内容', '可搜索文字层']
];
/**
 * 每页的「核心词」（与 SCAN_PDF_PAGES 对应）：短、独特，用来断言「搜得到」。
 * 用核心词而不是整行原文，是为了不被合成夹具上的个别字抖动误判——「可搜索」的关键证据
 * 是 getTextContent() 里能搜到这页的关键词，而不是每个字都分毫不差。
 */
const SCAN_PAGE_CORE_WORDS = [
  ['扫描版', '文字', '离线'],
  ['第二页', '扫描内容', '可搜索']
];
/** 页面文字长度的最低要求（去空白/标点后）：用来拦「空白 / 只有乱码」这种坏产物 */
const PAGE_TEXT_MIN_CHARS = 6;

/** 单图识别召回下限（对齐项目 OCR 引擎闸门 ocr-poc.js：合成/扫描件中文召回 ≥ 80% 即达标） */
const RECALL_MIN = 0.8;
/**
 * 预处理对照的绝对下限：合成/扫描件上个别字符偏差属正常，项目闸门也承认不可能次次满分，
 * 所以取 0.85（略高于闸门的 0.8）——预处理真把图搞坏（如掉到 0.5）会被它拦下。
 */
const PREPROCESS_RECALL_MIN = 0.85;
/** 未处理版达到该值即视为「已接近满分」：满分之上没有提升空间，不再作「不得低于处理前」的相对比较 */
const SATURATED_RECALL = 0.95;
/** 可搜索 PDF 的页内文字召回下限（文字层直接来自同一次识别，不应低于引擎水平） */
const SEARCHABLE_RECALL_MIN = 0.85;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeResult(file, payload) {
  try {
    fsSync.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[ocr-test] 结果写入失败：', err.message);
  }
}

/** 清理本测试的夹具与产物（只删「测试识别」前缀，所有扩展名） */
async function cleanFixtures() {
  const before = (await fs.readdir(TEST_DIR).catch(() => [])).filter((f) => FIXTURE_PREFIX.test(f) || SHOT_PREFIX.test(f));
  for (const f of before) {
    await fs.rm(path.join(TEST_DIR, f), { recursive: true, force: true }).catch(() => {});
  }
  const after = (await fs.readdir(TEST_DIR).catch(() => [])).filter((f) => FIXTURE_PREFIX.test(f) || SHOT_PREFIX.test(f));
  return { removed: before, left: after };
}

/** 在界面进程用 canvas 现画夹具（真机字体渲染 + 灰底/噪声/倾斜），返回 base64 */
const fixtureScript = (defs) => `
  (async () => {
    const defs = ${JSON.stringify(defs)};
    const b64 = (buf) => {
      const bytes = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      return btoa(s);
    };
    const out = [];
    for (const d of defs) {
      const W = 1000, H = 320;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      g.fillStyle = d.bg;
      g.fillRect(0, 0, W, H);
      g.save();
      if (d.rotate) {
        g.translate(W / 2, H / 2);
        g.rotate((d.rotate * Math.PI) / 180);
        g.translate(-W / 2, -H / 2);
      }
      g.fillStyle = '#111111';
      g.font = '48px "Microsoft YaHei", "SimHei", sans-serif';
      d.lines.forEach((line, i) => g.fillText(line, 40, 110 + i * 90));
      g.restore();
      if (d.noise > 0) {
        const img = g.getImageData(0, 0, W, H);
        const px = img.data;
        const count = Math.floor(W * H * d.noise);
        for (let n = 0; n < count; n++) {
          const p = Math.floor(Math.random() * W * H) * 4;
          const v = Math.random() < 0.5 ? 0 : 255;
          px[p] = px[p + 1] = px[p + 2] = v;
        }
        g.putImageData(img, 0, 0);
      }
      const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
      out.push({ file: d.file, lines: d.lines, width: W, height: H, base64: b64(await blob.arrayBuffer()) });
    }
    return out;
  })()
`;

/**
 * 造「多页扫描式 PDF」：每页一张带扫描噪声的中文位图（照真实扫描件的样子：位图很大、页面小一半），
 * 页面尺寸取位图的一半（500×700pt 放 1000×1400 的图）——这样「瘦身」按 1× 渲染重压时能真正变小，
 * 与真实扫描件（大位图塞进 A4 页）的压缩行为一致。
 */
const scanPdfScript = (pages) => `
  (async () => {
    const pages = ${JSON.stringify(pages)};
    const { PDFDocument } = await import('../../node_modules/@cantoo/pdf-lib/dist/pdf-lib.esm.js');
    const doc = await PDFDocument.create();
    const sizes = [];
    for (const lines of pages) {
      const W = 1000, H = 1400;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      g.fillStyle = '#f2f2f2';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#141414';
      g.font = '44px "Microsoft YaHei", "SimHei", sans-serif';
      lines.forEach((line, i) => g.fillText(line, 70, 240 + i * 110));
      // 扫描噪声：位图 PNG 会因此明显变大，压缩前后才有可比性（真实扫描件同理）
      const img = g.getImageData(0, 0, W, H);
      const px = img.data;
      const count = Math.floor(W * H * 0.03);
      for (let n = 0; n < count; n++) {
        const q = Math.floor(Math.random() * W * H) * 4;
        const v = Math.random() < 0.5 ? 0 : 255;
        px[q] = px[q + 1] = px[q + 2] = v;
      }
      g.putImageData(img, 0, 0);

      const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
      const embedded = await doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
      const pw = embedded.width / 2;
      const ph = embedded.height / 2;
      const page = doc.addPage([pw, ph]);
      page.drawImage(embedded, { x: 0, y: 0, width: pw, height: ph });
      sizes.push({ width: pw, height: ph });
    }
    const bytes = await doc.save();
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return { base64: btoa(s), sizes };
  })()
`;

/**
 * 主验证脚本（在界面进程执行）：所有断言都在这里跑完，只回传精简结果
 * cfg: { dir, images: [{file, lines}], scanPdf: {file, lines:[[]]}, recallMin }
 */
const coreScript = (cfg) => `
  (async () => {
    const cfg = ${JSON.stringify(cfg)};
    const D = window.desktop;
    const dir = cfg.dir;
    const p = (name) => dir + '\\\\' + name;
    const checks = {};
    const failures = [];
    const check = (name, pass, detail) => { checks[name] = { ok: !!pass, detail }; if (!pass) failures.push(name + '：' + JSON.stringify(detail)); };

    const convert = await import('../tools/ocr/core/convert.js');
    const preprocess = await import('../tools/ocr/core/preprocess.js');
    const docx = await import('../tools/ocr/core/docx.js');
    const searchable = await import('../tools/ocr/core/searchable.js');
    const pdfops = await import('../shared/pdfops.js');
    await import('../../node_modules/jszip/dist/jszip.min.js');
    const JSZip = globalThis.JSZip;

    // 归一化 + 字符级召回（多重集交集，避免换行差异影响判定）
    const norm = (s) => String(s || '').replace(/[\\s\\p{P}\\p{S}]/gu, '');
    function recall(expected, actual) {
      const exp = [...norm(expected)];
      if (!exp.length) return 1;
      const pool = new Map();
      for (const ch of norm(actual)) pool.set(ch, (pool.get(ch) || 0) + 1);
      let hit = 0;
      for (const ch of exp) { const n = pool.get(ch) || 0; if (n > 0) { hit++; pool.set(ch, n - 1); } }
      return hit / exp.length;
    }
    const write = (name, bytes) => D.writeFile(p(name), bytes);
    async function textOfPdf(bytes) {
      const doc = await pdfops.openPdfDoc(bytes);
      const pages = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const pg = await doc.getPage(i);
        const tc = await pg.getTextContent();
        pages.push(tc.items.map((it) => it.str).join(''));
      }
      const n = doc.numPages;
      try { await doc.destroy(); } catch (e) { try { await doc.loadingTask.destroy(); } catch (e2) {} }
      return { pages, numPages: n };
    }
    const ocr = async (bytes, jobId) => D.ocrRecognize({ bytes, jobId });

    // —— 0) 引擎与字体状态 ——
    const status = await D.ocrStatus();
    const font = await D.ocrFont();
    checks.加装包 = { ok: !!(status && status.found && status.font && status.font.exists && font && font.ok && font.bytes && font.bytes.length > 0),
      detail: { found: !!(status && status.found), fontExists: !!(status && status.font && status.font.exists), fontBytes: font && font.ok ? font.bytes.length : 0 } };
    if (!checks.加装包.ok) failures.push('加装包/字体缺失，后续断言不可信');
    const fontBytes = checks.加装包.ok ? font.bytes : null;

    // —— 1) 纯逻辑：linesToText ——
    const sample = [
      [{ text: 'World', box: { x: 200, y: 40, width: 60, height: 20 } }, { text: 'Hello', box: { x: 20, y: 42, width: 50, height: 20 } }],
      [{ text: '中文一行', box: { x: 30, y: 100, width: 120, height: 24 } }]
    ];
    const txt = convert.linesToText(sample);
    check('逻辑_linesToText', txt === 'Hello World\\n中文一行', txt);

    // —— 2) 纯逻辑：computePdfTextPlacement（固定输入 → 固定输出） ——
    const pl1 = convert.computePdfTextPlacement({ box: { x: 100, y: 50, width: 200, height: 36 }, renderScale: 2, pageHeightPts: 792, renderedHeightPx: 1584 });
    check('逻辑_坐标换算', pl1.x === 50 && pl1.y === 749 && pl1.size === 18, pl1);
    const pl2 = convert.computePdfTextPlacement({ box: { x: 100, y: 50, width: 200, height: 36 }, renderScale: 2, pageHeightPts: 792, renderedHeightPx: 1600 });
    check('逻辑_坐标比例校正', Math.abs(pl2.x - 49.5) < 1e-9 && Math.abs(pl2.y - 749.43) < 1e-9, pl2);

    // —— 3) 纯逻辑：preprocess ——
    const plan = preprocess.planPreprocess({ deskew: true, sharpen: true, method: 'adaptive' });
    check('逻辑_预处理计划', plan.steps.length === 4 && plan.method === 'adaptive' && plan.median === false, plan.steps);
    const mkImg = (w, h, fn) => {
      const px = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = fn(x, y); const i = (y * w + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
      }
      return { pixels: px, width: w, height: h };
    };
    const gray1 = mkImg(40, 40, (x, y) => (x >= 10 && x < 30 && y >= 15 && y < 25 ? 0 : 200));
    const out1 = preprocess.applyPreprocess(gray1, { method: 'otsu', median: false });
    check('逻辑_黑白化', out1.pixels[(0 * 40 + 0) * 4] === 255 && out1.pixels[(20 * 40 + 20) * 4] === 0, out1.angleDeg);
    const gray2 = mkImg(60, 60, (x, y) => (x === 5 && y === 5 ? 0 : (x >= 20 && x < 40 && y >= 25 && y < 35 ? 30 : 210)));
    const out2 = preprocess.applyPreprocess(gray2, { method: 'adaptive', median: true });
    check('逻辑_去灰底去脏点', out2.pixels[(0 * 60 + 0) * 4] === 255 && out2.pixels[(30 * 60 + 30) * 4] === 0 && out2.pixels[(5 * 60 + 5) * 4] === 255,
      { bg: out2.pixels[0], ink: out2.pixels[(30 * 60 + 30) * 4], speck: out2.pixels[(5 * 60 + 5) * 4] });
    const strip = mkImg(200, 200, (x, y) => (y >= 95 && y < 105 ? 0 : 250));
    const stripGray = preprocess.toGray(strip.pixels, 200, 200, false);
    const tilted = preprocess.rotateGray(stripGray, 200, 200, 4);
    const angTilt = preprocess.estimateDeskewAngle({ pixels: tilted, width: 200, height: 200 }, { maxAngle: 6 });
    const angFlat = preprocess.estimateDeskewAngle({ pixels: stripGray, width: 200, height: 200 }, { maxAngle: 6 });
    check('逻辑_纠偏角度', Math.abs(angTilt + 4) <= 0.75 && Math.abs(angFlat) <= 0.5, { angTilt, angFlat });
    const ub = preprocess.unrotateBox({ x: 90, y: 90, width: 20, height: 20 }, { angleDeg: 90, width: 200, height: 200 });
    check('逻辑_框回映射', Math.abs(ub.x - 90) < 1e-6 && Math.abs(ub.y - 90) < 1e-6, ub);

    // —— 4) 纯逻辑：docx 结构（并落盘给主进程复核） ——
    const docxBytes = await docx.linesToDocx(['第一段文字', 'Second line', ''], { title: '测试标题' });
    await write('测试识别A.docx', docxBytes);
    let docxXml = '';
    let docxOk = false;
    try {
      const zip = await JSZip.loadAsync(docxBytes);
      docxOk = !!zip.file('word/document.xml') && !!zip.file('[Content_Types].xml') && !!zip.file('_rels/.rels');
      if (docxOk) docxXml = await zip.file('word/document.xml').async('string');
    } catch (err) { failures.push('docx 解包失败：' + err.message); }
    check('逻辑_Word结构', docxOk && docxXml.includes('第一段文字') && docxXml.includes('Second line'), { bytes: docxBytes.length, hasText: docxXml.includes('第一段文字') });

    // —— 5) 图片识别（原图） + 预处理对比 ——
    const imgA = cfg.images[0];
    const imgB = cfg.images[1];
    const bytesA = await D.readFile(p(imgA.file));
    const bytesB = await D.readFile(p(imgB.file));
    const rA = await ocr(bytesA, 'test-A');
    const recallA = recall(imgA.lines.join(''), rA.text || '');
    check('识别_图片A', !!(rA.ok && recallA >= cfg.recallMin), { recall: Number(recallA.toFixed(3)), ms: rA.ms, text: (rA.text || '').slice(0, 40) });

    const rB = await ocr(bytesB, 'test-B');
    const recallB = recall(imgB.lines.join(''), (rB && rB.text) || '');
    const decodedB = await (await import('../shared/imageio.js')).decodeImageFromBytes(bytesB);
    const workB = { pixels: new Uint8ClampedArray(decodedB.pixels), width: decodedB.width, height: decodedB.height };
    const preB = preprocess.applyPreprocess(workB, { binarize: true, deskew: true, method: 'adaptive' });
    const pngB = await (await import('../shared/imageio.js')).encodeImageToBytes(workB.pixels, workB.width, workB.height, { format: 'png' });
    const rB2 = await ocr(pngB, 'test-B-pre');
    const recallB2 = recall(imgB.lines.join(''), (rB2 && rB2.text) || '');
    // 预处理是否「不掉召回」：
    //   · 绝对下限 0.85 —— 合成/扫描件上个别字符偏差属正常（项目闸门也只要求 ≥80%），
    //     但预处理真把图搞坏（例如掉到 0.5）必须失败；
    //   · 再要求「不低于未处理版 − 0.05」，但**未处理版已接近满分（≥0.95）时跳过这一比较**：
    //     满分之上没有提升空间，抖动是正常的；预处理的价值在于提升低质量真实扫描件
    //     （那种图上未处理版通常远低于 1.0，这个相对条件就真正生效了）。
    const beforeB = Number(recallB.toFixed(3));
    const afterB = Number(recallB2.toFixed(3));
    const saturated = recallB >= cfg.saturatedRecall;
    check('识别_预处理不掉召回',
      !!(rB2 && rB2.ok && recallB2 >= cfg.preprocessRecallMin && (saturated || recallB2 >= recallB - 0.05)),
      { before: beforeB, after: afterB, drop: Number((recallB - recallB2).toFixed(3)), min: cfg.preprocessRecallMin,
        saturated, angle: preB.angleDeg, text: (rB2.text || '').slice(0, 40) });

    // —— 6) 核心：图片 → 可搜索 PDF（pdfjs 读回隐形文字） ——
    const linesA = rA.ok ? rA.lines : [];
    const built = await searchable.imagesToPdf([{ bytes: bytesA }]);
    const sres = await searchable.linesToSearchablePdf({ pdfBytes: built.bytes, pageLines: [linesA], fontBytes, renderScale: 1, pageAngles: [0] });
    await write('测试识别A-可搜索.pdf', sres.bytes);
    const readA = await textOfPdf(sres.bytes);
    const hitA = readA.pages.join('').includes('番茄') && readA.pages.join('').includes('识别');
    check('可搜索PDF_图片', sres.embeddedChars > 0 && readA.numPages === 1 && hitA,
      { embedded: sres.embeddedChars, missing: sres.missingChars, numPages: readA.numPages, got: readA.pages[0].slice(0, 40), bytes: sres.bytes.length });

    // —— 7) 纯文本 .txt ——
    const txtBytes = new TextEncoder().encode('\\uFEFF' + convert.pagesToText([linesA]));
    await write('测试识别A.txt', txtBytes);
    const txtOut = convert.pagesToText([linesA]);
    check('纯文本', txtOut.replace(/\s/g, '').length > 0 && txtOut.includes('番茄'), { text: txtOut.slice(0, 40) });

    // —— 8) 多页扫描式 PDF：逐页识别 → 可搜索 PDF ——
    const scanBytes = await D.readFile(p(cfg.scanPdf.file));
    const scanDoc = await pdfops.openPdfDoc(scanBytes);
    const scanPageCount = scanDoc.numPages;
    const scanLines = [];
    const scanTexts = [];
    const scanAngles = [];
    for (let i = 1; i <= scanPageCount; i++) {
      const rendered = await pdfops.renderPdfPage(scanDoc, i, { scale: 2 });
      // 走工具的默认增强链路（去灰底 + 纠偏）再识别，和真实使用一致
      const work = { pixels: new Uint8ClampedArray(rendered.pixels), width: rendered.width, height: rendered.height };
      const pre = preprocess.applyPreprocess(work, { binarize: true, deskew: true, method: 'adaptive' });
      const png = await (await import('../shared/imageio.js')).encodeImageToBytes(work.pixels, work.width, work.height, { format: 'png' });
      const r = await ocr(png, 'scan-' + i);
      scanLines.push(r.ok ? r.lines : []);
      scanTexts.push(r.ok ? r.text : '');
      scanAngles.push(pre.angleDeg || 0);
      if (!r.ok) failures.push('扫描件第 ' + i + ' 页识别失败：' + r.message);
    }
    try { await scanDoc.destroy(); } catch (e) { try { await scanDoc.loadingTask.destroy(); } catch (e2) {} }
    const scanSearchable = await searchable.linesToSearchablePdf({ pdfBytes: scanBytes, pageLines: scanLines, fontBytes, renderScale: 2, pageAngles: scanAngles });
    await write('测试识别扫描件-可搜索.pdf', scanSearchable.bytes);
    const readScan = await textOfPdf(scanSearchable.bytes);
    const scanRecall = recall(cfg.scanPdf.lines.flat().join(''), scanTexts.join(''));
    // 「可搜索」的三条证据：
    //   ① 页数一致，且召回 ≥ 0.85（对齐项目闸门口径；合成扫描页上个别字抖动属正常，
    //      但整页空白/乱码会同时被召回与下面的②③拦下）；
    //   ② 每页都能搜到「核心词」（至少命中一半以上，且至少 2 个）——这是可搜索能力的真正证据，
    //      比逐字比对稳：个别字缺失不影响关键词命中；
    //   ③ 每页文字长度 ≥ 6 个字符——拦「getTextContent() 读出来是空」的坏产物。
    const coreWords = cfg.scanCoreWords || [];
    const coreHits = readScan.pages.map((t, i) => (coreWords[i] || []).filter((w) => norm(t).includes(norm(w))));
    const coreOk = coreHits.every((hits, i) => hits.length >= Math.min(2, (coreWords[i] || []).length));
    const textLens = readScan.pages.map((t) => norm(t).length);
    const notEmpty = textLens.length === scanPageCount && textLens.every((n) => n >= cfg.pageTextMinChars);
    check('可搜索PDF_多页', readScan.numPages === scanPageCount && scanRecall >= cfg.searchableRecallMin && coreOk && notEmpty,
      { numPages: readScan.numPages, pagesExpected: scanPageCount,
        recall: Number(scanRecall.toFixed(3)), recallMin: cfg.searchableRecallMin,
        coreWords, coreHits, textLens, pageTextMinChars: cfg.pageTextMinChars,
        page1: (readScan.pages[0] || '').slice(0, 40), page2: (readScan.pages[1] || '').slice(0, 40) });

    // —— 9) 扫描件瘦身：体积下降 / 页数不变 / 仍可渲染 ——
    const comp = await pdfops.compressPdf(scanBytes, { preset: 'strong', grayscale: true, shouldCancel: () => false });
    await write('测试识别扫描件-压缩.pdf', comp.bytes);
    const readComp = await textOfPdf(comp.bytes);
    const compDoc = await pdfops.openPdfDoc(comp.bytes);
    let compRender = { ok: false };
    try {
      const pg = await pdfops.renderPdfPage(compDoc, 1, { scale: 1 });
      compRender = { ok: pg.width > 0 && pg.height > 0, width: pg.width, height: pg.height };
    } catch (err) { compRender = { ok: false, error: err.message }; }
    try { await compDoc.destroy(); } catch (e) { try { await compDoc.loadingTask.destroy(); } catch (e2) {} }
    check('瘦身', comp.bytes.length < scanBytes.length && readComp.numPages === scanPageCount && compRender.ok,
      { before: scanBytes.length, after: comp.bytes.length, pages: readComp.numPages, render: compRender });

    // —— 10) 无效文件的中文报错 ——
    const bad = await ocr(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'bad');
    const badMsg = convert.friendlyOcrMessage(bad && bad.message);
    const badOk = bad && bad.ok === false && badMsg.length > 0 && !/^unsupported/i.test(badMsg);
    let badPdf = '';
    try { await pdfops.openPdfDoc(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])); } catch (err) { badPdf = err.message; }
    check('无效文件报错', badOk && /PDF|损坏|失败/.test(badPdf), { ocr: badMsg, pdf: badPdf });

    return { checks, failures };
  })()
`;

// —— 自检（--ocr-test） ————————————————————————————————————————

async function runOcrTest(win) {
  const wc = win.webContents;
  const result = { steps: {}, checks: {}, failures: [], fixtures: [] };
  await fs.mkdir(TEST_DIR, { recursive: true });
  result.steps.清理前 = await cleanFixtures();

  // 1) 夹具：中文图片（灰底/噪声/倾斜）+ 多页扫描式 PDF
  try {
    const made = await wc.executeJavaScript(fixtureScript(IMAGE_FIXTURES));
    for (const f of made) {
      await fs.writeFile(path.join(TEST_DIR, f.file), Buffer.from(f.base64, 'base64'));
      result.fixtures.push({ file: f.file, lines: f.lines, bytes: Buffer.from(f.base64, 'base64').length });
    }
    const scan = await wc.executeJavaScript(scanPdfScript(SCAN_PDF_PAGES));
    await fs.writeFile(path.join(TEST_DIR, SCAN_PDF_FILE), Buffer.from(scan.base64, 'base64'));
    result.fixtures.push({ file: SCAN_PDF_FILE, lines: SCAN_PDF_PAGES, sizes: scan.sizes, bytes: Buffer.from(scan.base64, 'base64').length });
    result.steps.夹具 = 'OK';
  } catch (err) {
    result.steps.夹具 = err.message;
    result.failures.push(`夹具生成失败：${err.message}`);
    result.ok = false;
    writeResult(RESULT_FILE, { ok: false, at: new Date().toISOString(), result });
    return result;
  }

  // 2) 界面进程里跑全部断言
  try {
    const out = await wc.executeJavaScript(coreScript({
      dir: TEST_DIR,
      images: IMAGE_FIXTURES,
      scanPdf: { file: SCAN_PDF_FILE, lines: SCAN_PDF_PAGES },
      scanCoreWords: SCAN_PAGE_CORE_WORDS,
      pageTextMinChars: PAGE_TEXT_MIN_CHARS,
      recallMin: RECALL_MIN,
      preprocessRecallMin: PREPROCESS_RECALL_MIN,
      saturatedRecall: SATURATED_RECALL,
      searchableRecallMin: SEARCHABLE_RECALL_MIN
    }));
    Object.assign(result.checks, out.checks || {});
    result.failures.push(...(out.failures || []));
  } catch (err) {
    result.failures.push(`核心断言执行异常：${err.message}`);
    result.steps.核心 = err.message;
  }

  // 3) 主进程复核：.txt 内容 / .docx 结构 / 产物确实落盘
  try {
    const JSZip = require(path.join(__dirname, '..', 'node_modules', 'jszip', 'dist', 'jszip.min.js'));
    const txt = fsSync.readFileSync(path.join(TEST_DIR, '测试识别A.txt'), 'utf8').replace(/^\uFEFF/, '');
    const docxBuf = fsSync.readFileSync(path.join(TEST_DIR, '测试识别A.docx'));
    const zip = await JSZip.loadAsync(docxBuf);
    const xml = await zip.file('word/document.xml').async('string');
    const files = ['测试识别A-可搜索.pdf', '测试识别扫描件-可搜索.pdf', '测试识别扫描件-压缩.pdf'];
    const sizes = {};
    for (const f of files) sizes[f] = fsSync.statSync(path.join(TEST_DIR, f)).size;
    result.checks.主进程复核 = {
      ok: txt.replace(/\s/g, '').length > 0 && xml.includes('第一段文字') && files.every((f) => sizes[f] > 0),
      detail: { txt: txt.slice(0, 40), docxBytes: docxBuf.length, sizes }
    };
    if (!result.checks.主进程复核.ok) result.failures.push('主进程复核未通过（txt/docx/产物）');
  } catch (err) {
    result.checks.主进程复核 = { ok: false, detail: err.message };
    result.failures.push(`主进程复核异常：${err.message}`);
  }

  // 4) 收尾清理（只清「测试识别」前缀）
  result.steps.清理后 = await cleanFixtures();
  result.ok = result.failures.length === 0 && Object.values(result.checks).every((c) => c.ok === true);
  writeResult(RESULT_FILE, { ok: result.ok, at: new Date().toISOString(), result });
  return result;
}

// —— 界面自动测试（--ocr-ui-test） ————————————————————————————————

async function runOcrUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, failures: [], shots: [] };
  await fs.mkdir(TEST_DIR, { recursive: true });
  result.steps.清理前 = await cleanFixtures();

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-ocr-${name}.png`);
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

  const getStatus = () => evalJs('document.getElementById("statusText").textContent');
  const clickSel = (sel) => evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  const setSelect = (sel, value) => evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.value = ${JSON.stringify('')} + ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change'));
    return el.value === ${JSON.stringify(value)};
  })()`);

  async function waitForFinish(statusBefore, timeoutMs) {
    const t0 = Date.now();
    const read = async () => JSON.parse(await evalJs(`JSON.stringify({
      status: document.getElementById('statusText').textContent,
      progressHidden: document.getElementById('progressBar').hidden
    })`));
    let appeared = false;
    while (Date.now() - t0 < 5000) {
      const o = await read();
      if (!o.progressHidden) { appeared = true; break; }
      await wait(120);
    }
    let last = '';
    while (Date.now() - t0 < timeoutMs) {
      const o = await read();
      last = o.status;
      if (o.progressHidden && (appeared || o.status !== statusBefore)) return { ok: true, status: o.status, ms: Date.now() - t0, appeared };
      await wait(300);
    }
    return { ok: false, status: last, timeout: true };
  }

  // 1) 夹具
  try {
    const made = await wc.executeJavaScript(fixtureScript(IMAGE_FIXTURES));
    for (const f of made) await fs.writeFile(path.join(TEST_DIR, f.file), Buffer.from(f.base64, 'base64'));
    const scan = await wc.executeJavaScript(scanPdfScript(SCAN_PDF_PAGES));
    await fs.writeFile(path.join(TEST_DIR, SCAN_PDF_FILE), Buffer.from(scan.base64, 'base64'));
    result.steps.夹具 = 'OK';
  } catch (err) {
    result.failures.push(`夹具生成失败：${err.message}`);
    result.ok = false;
    writeResult(UI_RESULT_FILE, { ok: false, at: new Date().toISOString(), result });
    return result;
  }

  await shot('01-起点');

  // 2)~6) 界面流程：任何一步抛错都记录下来，最后统一写结果文件（便于定位）
  let finish = { ok: false, status: '', timeout: true };
  try {
  // 2) 展开「文档」分组 → 切到「文字识别」
  result.steps.展开分组 = await evalJs(`(() => {
    const g = document.querySelector('.tool-group[data-group-id="doc"]');
    if (!g) return false;
    if (g.classList.contains('is-collapsed')) g.querySelector('.tool-group-head').click();
    return true;
  })()`);
  await wait(400);
  result.steps.切换工具 = await clickSel('.tool-item[data-tool-id="ocr"]');
  await wait(1500); // 等引擎与字体状态检测回来
  result.checks.界面 = JSON.parse(await evalJs(`(() => {
    const sel = document.querySelector('#ocrMode');
    const note = document.querySelector('#ocrNote');
    const run = document.querySelector('#ocrRunBtn');
    if (!sel || !note || !run) return JSON.stringify({ ok: false, reason: '界面元素缺失' });
    const options = [...sel.options];
    return JSON.stringify({
      ok: options.length === 4 && !run.disabled && sel.value === 'pdf',
      optionCount: options.length,
      mode: sel.value,
      note: note.textContent || '',
      runDisabled: run.disabled
    });
  })()`));
  await shot('02-已切到文字识别');

  // 3) 添加夹具（测试模式下 openOcr 直接返回「测试识别*」）
  const before = new Set(await fs.readdir(TEST_DIR));
  result.steps.添加 = await clickSel('[data-add]');
  await wait(1800);
  result.checks.添加列表 = JSON.parse(await evalJs(`(() => {
    const items = [...document.querySelectorAll('#ocrList .ocr-item')];
    return JSON.stringify({ ok: items.length >= 2, count: items.length, names: items.map((li) => (li.querySelector('.ocr-item-name') || {}).textContent || '') });
  })()`));
  await shot('03-已添加夹具');

  // 4) 选输出「纯文本 + 可搜索 PDF」→ 开始识别
  result.steps.设置输出 = await setSelect('#ocrMode', 'both');
  await wait(300);
  result.steps.预览 = await evalJs(`(() => {
    const li = document.querySelector('#ocrList .ocr-item');
    if (!li) return false;
    li.click();
    return true;
  })()`);
  await wait(1200);
  await shot('04-预览');

  const statusBefore = await getStatus();
  result.steps.运行 = await clickSel('[data-run]');
  finish = await waitForFinish(statusBefore, 600000);
  await shot('05-识别完成');

  const after = await fs.readdir(TEST_DIR);
  const newFiles = after.filter((f) => !before.has(f) && FIXTURE_PREFIX.test(f));
  result.checks.运行结果 = JSON.parse(await evalJs(`(() => {
    const items = [...document.querySelectorAll('#ocrList .ocr-item')];
    const results = items.map((li) => (li.querySelector('.ocr-item-result') || {}).textContent || '');
    const okCount = results.filter((t) => t.indexOf('→') === 0).length;
    return JSON.stringify({ ok: okCount >= 2, okCount, results: results.slice(0, 4) });
  })()`));
  result.checks.运行结果.detail = { finish, newFiles };

  // 5) 产物：txt 存在 + pdf 可搜索（界面进程用 pdfjs 读回）
  let pdfCheck = { ok: false };
  try {
    const target = path.join(TEST_DIR, '测试识别A.pdf');
    if (fsSync.existsSync(target)) {
      const b64 = fsSync.readFileSync(target).toString('base64');
      pdfCheck = JSON.parse(await wc.executeJavaScript(`(async () => {
        const pdfops = await import('../shared/pdfops.js');
        const bin = atob(${JSON.stringify('')} + ${JSON.stringify(b64)});
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const doc = await pdfops.openPdfDoc(bytes);
        const pg = await doc.getPage(1);
        const tc = await pg.getTextContent();
        const text = tc.items.map((it) => it.str).join('');
        const n = doc.numPages;
        try { await doc.destroy(); } catch (e) { try { await doc.loadingTask.destroy(); } catch (e2) {} }
        return JSON.stringify({ ok: n === 1 && text.includes('番茄'), numPages: n, text: text.slice(0, 40) });
      })()`));
    }
  } catch (err) {
    pdfCheck = { ok: false, error: err.message };
  }
  const txtOk = fsSync.existsSync(path.join(TEST_DIR, '测试识别A.txt'))
    && fsSync.readFileSync(path.join(TEST_DIR, '测试识别A.txt'), 'utf8').replace(/^\uFEFF/, '').replace(/\s/g, '').length > 0;
  result.checks.产物 = {
    ok: !!finish.ok && newFiles.some((f) => /\.txt$/.test(f)) && !!pdfCheck.ok && txtOk,
    detail: { pdf: pdfCheck, txtOk, newFiles }
  };
  if (!result.checks.产物.ok) result.failures.push('产物校验未通过（可搜索 PDF / txt）');

  // 6) 清空
  result.steps.清空 = await clickSel('[data-clear]');
  await wait(500);
  result.checks.清空 = JSON.parse(await evalJs(`(() => {
    const items = document.querySelectorAll('#ocrList .ocr-item').length;
    const dropHidden = document.getElementById('ocrDrop').hidden;
    return JSON.stringify({ ok: items === 0 && dropHidden === false, items, dropHidden });
  })()`));
  await shot('06-已清空');
  } catch (err) {
    // 界面流程异常：记录下来（渲染进程的报错在 Electron 里读不到堆栈，只留 message）
    result.failures.push(`界面流程异常：${err.message}`);
    result.steps.异常 = err.message;
    try { await shot('99-异常'); } catch { /* 截图失败不影响结论 */ }
  }

  result.steps.清理后 = await cleanFixtures();
  const keys = Object.keys(result.checks);
  result.pass = result.failures.length === 0 && keys.length >= 5 && keys.every((k) => result.checks[k].ok === true)
    && result.steps.切换工具 === true && result.steps.添加 === true && result.steps.运行 === true;
  if (!result.pass && result.failures.length === 0) result.failures.push('部分断言未通过');
  writeResult(UI_RESULT_FILE, { ok: !!result.pass, at: new Date().toISOString(), result });
  return result;
}

module.exports = {
  runOcrTest, runOcrUiTest, writeResult,
  TEST_DIR, RESULT_FILE, UI_RESULT_FILE, FIXTURE_PREFIX, IMAGE_FIXTURES, SCAN_PDF_FILE, SCAN_PDF_PAGES
};