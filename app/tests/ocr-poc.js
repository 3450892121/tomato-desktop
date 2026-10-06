// OCR 引擎可用性闸门（P0）：`electron . --ocr-poc`
//
// 目的：在正式开发「文字识别」工具前，用最小代价验证 OCR 引擎能在本软件里
//       **纯离线**跑通中文扫描件，且精度与速度达标。跑不通就不投工具开发。
//
// 方案：引擎 = ppu-paddle-ocr（PP-OCRv5 mobile，ONNX）+ onnxruntime-node（N-API，ABI 稳定）。
//       模型放 app/addons/ocr/（随包加装包），按**本地文件路径**加载，全程不联网。
//       运行位置选**主进程**而非渲染进程：主进程没有 CSP 限制，无需为 WASM 放宽
//       script-src / worker-src，也无需 blob URL 搬运模型，链路最短、风险最低。
//
// 夹具：在界面进程用 canvas 现画中文（真机字体渲染），再叠加灰底/噪声/倾斜，
//       模拟扫描件。OCR 在主进程跑，识别结果与预期文本做字符级召回比对。
//
// 判据（全中才算过）：3 张夹具中至少 2 张中文召回 ≥ 80%；单张 ≤ 8 秒；全程 0 次网络请求。
// 结果写入 %TEMP%/tomato-ocr-poc.json（stdout 在部分环境抓不到，落盘既是调试依据也是验收证据）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

/** 结果文件（固定路径，便于验收脚本读取） */
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-ocr-poc.json');
/**
 * 加装包基准目录（开发树 = app/；打包产物 = exe 所在目录）
 * 与其余 18 个带加装包的自检同一惯用法（见 asr-test.js / media-test.js / uninstall-test.js）。
 * 原先这里硬写 path.join(__dirname, '..')：开发树上 tests/.. = app/ 恰好对，打包产物上
 * __dirname 是 resources/app/tests，于是解析成 resources/app/addons/ocr（不存在）→
 * 本闸门在产物上必然报「OCR 加装包缺失」而 ok:false，等于产物上从来没有真正验过 OCR。
 */
const ADDON_BASE = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
/** OCR 加装包目录（不进 git，随包分发） */
const ADDON_DIR = path.join(ADDON_BASE, 'addons', 'ocr');
/** 加装包内的模型文件名 */
const MODEL_FILES = {
  detection: 'det.onnx',
  recognition: 'rec.onnx',
  charactersDictionary: 'dict.txt'
};
/** 判据阈值 */
const THRESHOLDS = {
  recall: 0.8,      // 单张中文召回率下限
  minPassing: 2,    // 至少几张达标
  perImageMs: 8000  // 单张耗时上限（毫秒）
};

/** 夹具定义：预期文本 + 干扰参数（灰底/噪声/倾斜） */
const FIXTURES = [
  { name: '干净白底', bg: '#ffffff', noise: 0, rotate: 0, lines: ['番茄图片混淆工具箱', '离线文字识别测试'] },
  { name: '灰底噪声', bg: '#e6e6e6', noise: 0.06, rotate: 0, lines: ['扫描件文字识别效果验证', '第二行测试内容'] },
  { name: '轻微倾斜', bg: '#f0f0f0', noise: 0.03, rotate: 3, lines: ['倾斜扫描件纠偏测试', '第三行内容'] }
];

function writeResult(payload) {
  try {
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[ocr-poc] 结果文件写入失败：', err.message);
  }
  return RESULT_FILE;
}

/** 注入界面进程：用 canvas 现画中文夹具并加干扰，返回 base64（去掉 data URL 前缀） */
const FIXTURE_SCRIPT = `
  (async () => {
    const defs = ${JSON.stringify(FIXTURES)};
    const out = [];
    for (const d of defs) {
      const W = 1000, H = 320;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = d.bg;
      ctx.fillRect(0, 0, W, H);

      // 倾斜：绕画布中心旋转，模拟扫描时没放正
      ctx.save();
      if (d.rotate) {
        ctx.translate(W / 2, H / 2);
        ctx.rotate((d.rotate * Math.PI) / 180);
        ctx.translate(-W / 2, -H / 2);
      }
      ctx.fillStyle = '#111111';
      ctx.font = '48px "Microsoft YaHei", "SimHei", sans-serif';
      d.lines.forEach((line, i) => ctx.fillText(line, 40, 110 + i * 90));
      ctx.restore();

      // 噪声：随机灰点，模拟扫描颗粒
      if (d.noise > 0) {
        const img = ctx.getImageData(0, 0, W, H);
        const px = img.data;
        const count = Math.floor(W * H * d.noise);
        for (let n = 0; n < count; n++) {
          const p = (Math.floor(Math.random() * W * H)) * 4;
          const v = Math.random() < 0.5 ? 0 : 255;
          px[p] = px[p + 1] = px[p + 2] = v;
        }
        ctx.putImageData(img, 0, 0);
      }

      out.push({ name: d.name, lines: d.lines, base64: cv.toDataURL('image/png').split(',')[1] });
    }
    return out;
  })()
`;

/** 归一化：去掉空白与常见标点，只留字母/数字/汉字，避免标点差异影响召回统计 */
const normalize = (s) => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');

/**
 * 字符级召回率：预期字符有多少比例被识别出来（按字符多重集交集计算）。
 * 用多重集而非顺序比对，避免因换行/分栏顺序差异误判。
 */
function charRecall(expected, actual) {
  const exp = [...normalize(expected)];
  if (exp.length === 0) return 1;
  const pool = new Map();
  for (const ch of normalize(actual)) pool.set(ch, (pool.get(ch) || 0) + 1);
  let hit = 0;
  for (const ch of exp) {
    const n = pool.get(ch) || 0;
    if (n > 0) { hit++; pool.set(ch, n - 1); }
  }
  return hit / exp.length;
}

/** 检查加装包文件是否齐全 */
function checkAddon() {
  const missing = [];
  for (const [key, file] of Object.entries(MODEL_FILES)) {
    const p = path.join(ADDON_DIR, file);
    if (!fs.existsSync(p)) missing.push(`${file}（${key}）`);
  }
  return missing;
}

/**
 * POC 主流程
 * @param {import('electron').BrowserWindow} win 界面窗口（用于生成夹具）
 */
async function runOcrPoc(win) {
  const result = {
    addonDir: ADDON_DIR,
    thresholds: THRESHOLDS,
    steps: {},
    fixtures: [],
    failures: []
  };
  const step = async (name, fn) => {
    try {
      result.steps[name] = await fn();
      return result.steps[name];
    } catch (err) {
      result.steps[name] = { error: err.message };
      result.failures.push(`${name}: ${err.message}`);
      return null;
    }
  };

  // 1) 加装包文件是否齐全
  const missing = checkAddon();
  if (missing.length) {
    result.failures.push(`OCR 加装包缺失：${missing.join('、')}（应放在 app/addons/ocr/）`);
    result.ok = false;
    writeResult({ ok: false, at: new Date().toISOString(), result });
    return result;
  }
  result.steps.addonFiles = Object.fromEntries(
    Object.entries(MODEL_FILES).map(([k, f]) => [k, fs.statSync(path.join(ADDON_DIR, f)).size])
  );

  // 2) 生成夹具（界面进程画中文）
  const fixtures = await step('makeFixtures', () => win.webContents.executeJavaScript(FIXTURE_SCRIPT));
  if (!fixtures || !fixtures.length) {
    result.ok = false;
    writeResult({ ok: false, at: new Date().toISOString(), result });
    return result;
  }
  // 落盘时只留文本信息：base64 夹具体积大且无验收价值（会让结果文件难以阅读）
  result.steps.makeFixtures = fixtures.map((f) => ({ name: f.name, lines: f.lines, bytes: Math.floor(f.base64.length * 0.75) }));

  // 3) 加载引擎（本地路径，不联网）
  //    统计网络调用：把 globalThis.fetch 换成计数桩，跑完恢复；有网络请求即判失败。
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { fetchCalls++; return originalFetch(...args); };

  let service = null;
  try {
    const { PaddleOcrService } = await import('ppu-paddle-ocr');
    const t0 = Date.now();
    service = new PaddleOcrService({
      model: {
        detection: path.join(ADDON_DIR, MODEL_FILES.detection),
        recognition: path.join(ADDON_DIR, MODEL_FILES.recognition),
        charactersDictionary: path.join(ADDON_DIR, MODEL_FILES.charactersDictionary)
      }
    });
    await service.initialize();
    result.steps.init = { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    result.steps.init = { ok: false, error: err.message };
    result.failures.push(`引擎加载失败：${err.message}`);
    globalThis.fetch = originalFetch;
    result.ok = false;
    writeResult({ ok: false, at: new Date().toISOString(), result });
    return result;
  }

  // 4) 逐张识别
  let passing = 0;
  for (const fx of fixtures) {
    const item = { name: fx.name, expected: fx.lines.join(' '), recall: 0, ok: false };
    try {
      const buf = Buffer.from(fx.base64, 'base64');
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const t = Date.now();
      const r = await service.recognize(ab);
      item.ms = Date.now() - t;
      item.text = r.text;
      item.confidence = r.confidence;
      item.lines = r.lines ? r.lines.length : 0;
      item.recall = Number(charRecall(item.expected, item.text).toFixed(4));
      item.ok = item.recall >= THRESHOLDS.recall && item.ms <= THRESHOLDS.perImageMs;
      if (item.ok) passing++;
      else result.failures.push(`${fx.name}：召回 ${(item.recall * 100).toFixed(1)}% / 耗时 ${item.ms}ms 未达标`);
    } catch (err) {
      item.error = err.message;
      result.failures.push(`${fx.name}：识别异常 ${err.message}`);
    }
    result.fixtures.push(item);
  }

  try { await service.destroy(); } catch { /* 释放失败不影响判据 */ }
  globalThis.fetch = originalFetch;

  // 5) 判据汇总
  result.steps.network = { fetchCalls };
  if (fetchCalls > 0) result.failures.push(`检测到 ${fetchCalls} 次网络请求，违反纯离线要求`);
  result.passing = passing;
  result.ok = passing >= THRESHOLDS.minPassing && fetchCalls === 0 && result.failures.length === 0;

  writeResult({ ok: result.ok, at: new Date().toISOString(), result });
  return result;
}

module.exports = { runOcrPoc, writeResult, RESULT_FILE, ADDON_DIR };
