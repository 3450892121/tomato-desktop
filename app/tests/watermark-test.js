// 加水印工具自检（供 `electron . --watermark-test` / `--watermark-ui-test` 调用）
// 覆盖：位置/字号等纯逻辑断言 + 文字水印（透明/旋转/描边）+ 图片水印 + 平铺的真实绘制，
//       产物落盘、解码回读、与原图逐像素比对（证明水印真的画上去了）。
// 说明：通过 window.desktop.* 走真实 IPC 链路；结果写入 %TEMP%/tomato-watermark-test.json 与
//       %TEMP%/tomato-watermark-ui-test.json，截图落在 %TEMP%/tomato-uitest。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const TEST_RESULT_FILE = path.join(os.tmpdir(), 'tomato-watermark-test.json');
const UI_RESULT_FILE = path.join(os.tmpdir(), 'tomato-watermark-ui-test.json');

/** 本工具的夹具与产物前缀：清理只认它，绝不碰其它工具的夹具 */
const PREFIX = '测试水印';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeResult(payload, file = UI_RESULT_FILE) {
  fsSync.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

/** 清理本工具的夹具与产物（开跑清一次、收尾清一次，覆盖所有扩展名）
 *  注意：印章夹具用的是独立前缀「测试印章」，不在 PREFIX 之下，必须一并清，
 *        否则会留下垃圾（也因此它不会被主对话框的 startWith '测试水印' 误选）。 */
async function cleanFixtures() {
  const entries = await fs.readdir(TEST_DIR, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith(PREFIX) || e.name.startsWith('测试印章')) {
      await fs.rm(path.join(TEST_DIR, e.name), { recursive: true, force: true });
    }
  }
}

/** 在界面进程里造夹具（canvas 生成，纯离线；名字统一以 测试水印 开头） */
const MAKE_FIXTURES = `(async () => {
  const { encodeImageToBytes } = await import('../shared/imageio.js');
  const seed = ${JSON.stringify(path.join(TEST_DIR, 'seed.png'))};
  const mk = async (baseName, w, h) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (x + y * w) * 4;
      if (baseName === '测试印章') {
        // 印章：红圈 + 十字，圆外透明（顺带验证透明印章能正确叠加）
        const dx = x - w / 2 + 0.5, dy = y - h / 2 + 0.5;
        const d = Math.hypot(dx, dy);
        const on = (d > 32 && d < 46) || Math.abs(dx) < 8 || Math.abs(dy) < 8;
        px[p] = on ? 220 : 0; px[p + 1] = on ? 30 : 0; px[p + 2] = on ? 30 : 0; px[p + 3] = on ? 255 : 0;
      } else {
        // 待加水印的底图：彩色渐变 + 棋盘格，方便像素比对
        px[p] = Math.round((x / (w - 1)) * 255);
        px[p + 1] = Math.round((y / (h - 1)) * 255);
        px[p + 2] = ((x >> 3) + (y >> 3)) % 2 ? 190 : 60;
        px[p + 3] = 255;
      }
    }
    const bytes = await encodeImageToBytes(px, w, h, { format: 'png' });
    return window.desktop.saveImageNextTo({ sourcePath: seed, baseName, ext: '.png', bytes });
  };
  return JSON.stringify({
    a: await mk('测试水印A', 640, 420),
    b: await mk('测试水印B', 320, 260),
    stamp: await mk('测试印章', 120, 120)
  });
})()`;

/** 在界面进程里跑一次渲染并逐像素比对（返回统计数字，主进程只做断言） */
function renderAndCompare(saveBase, configLiteral) {
  return `(async () => {
    const d = await import('../tools/watermark/core/draw.js');
    const io = await import('../shared/imageio.js');
    const srcPath = ${JSON.stringify(path.join(TEST_DIR, '测试水印A.png'))};
    const bytes = await window.desktop.readFile(srcPath);
    const img = await io.decodeImageFromBytes(bytes);
    const canvas = new OffscreenCanvas(img.width, img.height);
    canvas.getContext('2d').putImageData(new ImageData(img.pixels, img.width, img.height), 0, 0);

    const stampBytes = await window.desktop.readFile(${JSON.stringify(path.join(TEST_DIR, '测试印章.png'))});
    const stampImg = await io.decodeImageFromBytes(stampBytes);
    const stampCanvas = new OffscreenCanvas(stampImg.width, stampImg.height);
    stampCanvas.getContext('2d').putImageData(new ImageData(stampImg.pixels, stampImg.width, stampImg.height), 0, 0);

    const stamp = { bitmap: stampCanvas, width: stampImg.width, height: stampImg.height };
    const config = Object.assign({ stamp }, ${configLiteral});
    const { blob, width, height } = await d.renderWatermark({ bitmap: canvas, config });
    const out = new Uint8Array(await blob.arrayBuffer());
    const saved = await window.desktop.saveImageNextTo({
      sourcePath: srcPath, baseName: ${JSON.stringify(saveBase)}, ext: '.png', bytes: out
    });

    const back = await io.decodeImageFromBytes(new Uint8Array(await window.desktop.readFile(saved)));
    let changed = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const p = (x + y * img.width) * 4;
      const diff = Math.abs(img.pixels[p] - back.pixels[p])
        + Math.abs(img.pixels[p + 1] - back.pixels[p + 1])
        + Math.abs(img.pixels[p + 2] - back.pixels[p + 2]);
      if (diff > 24) {
        changed += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return JSON.stringify({
      blobBytes: out.length,
      width, height,
      origSize: [img.width, img.height],
      backSize: [back.width, back.height],
      saved,
      savedExists: (await window.desktop.pathInfo(saved)).size > 0,
      changed,
      changedRatio: changed / (img.width * img.height),
      box: maxX < 0 ? null : [minX, minY, maxX, maxY]
    });
  })()`;
}

/** 纯逻辑断言（在界面进程里 import core/draw.js 跑纯函数） */
const LOGIC_SCRIPT = `(async () => {
  const d = await import('../tools/watermark/core/draw.js');
  const W = 1000, H = 800, itemW = 200, itemH = 100, margin = 20;
  const positions = {};
  for (const p of ['top-left', 'top-center', 'top-right', 'middle-left', 'center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']) {
    positions[p] = d.anchorRect({ canvasW: W, canvasH: H, itemW, itemH, position: p, margin });
  }
  const tile = d.tilePositions({ canvasW: 1000, canvasH: 1000, itemW: 100, itemH: 50, gapX: 50, gapY: 50 });
  const fake = { font: '', measureText: (t) => ({ width: String(t).length * 10 }) };
  return JSON.stringify({
    positions,
    tileNull: d.anchorRect({ canvasW: W, canvasH: H, itemW, itemH, position: 'tile', margin }),
    tile: {
      count: tile.length,
      first: tile[0],
      second: tile[1],
      secondRowY: tile[7] ? tile[7].y : null,
      stepX: tile[1].x - tile[0].x,
      last: tile[tile.length - 1]
    },
    font: {
      w1000p6: d.computeFontSize({ canvasW: 1000, baseSizePercent: 6 }),
      w333p6: d.computeFontSize({ canvasW: 333, baseSizePercent: 6 }),
      w50p2: d.computeFontSize({ canvasW: 50, baseSizePercent: 2 })
    },
    measure: d.measureTextWidth(fake, 'abc', '700 20px sans'),
    restoredFont: fake.font,
    escape: d.escapeForMeasure('a\\r\\nb\\tc'),
    strokeDark: d.contrastStrokeColor('#111111'),
    strokeLight: d.contrastStrokeColor('#ffffff'),
    positionsCount: d.WATERMARK_POSITIONS.length,
    defaults: d.WATERMARK_DEFAULTS.position
  });
})()`;

async function runWatermarkTest(win) {
  const evalJs = (code) => win.webContents.executeJavaScript(code);
  const result = { ok: false, checks: {}, notes: [] };

  await fs.mkdir(TEST_DIR, { recursive: true });
  await cleanFixtures(); // 开跑前先清一次

  // —— 1) 夹具 ——
  try {
    const fixtures = JSON.parse(await evalJs(MAKE_FIXTURES));
    result.checks.fixtures = {
      ...fixtures,
      ok: !!fixtures.a && !!fixtures.b && !!fixtures.stamp
        && fsSync.existsSync(fixtures.a) && fsSync.existsSync(fixtures.stamp)
    };
  } catch (err) {
    result.checks.fixtures = { ok: false, error: err.message };
  }

  // —— 2) 纯逻辑 ——
  try {
    const logic = JSON.parse(await evalJs(LOGIC_SCRIPT));
    const expect = {
      'top-left': { x: 20, y: 20 },
      'top-center': { x: 400, y: 20 },
      'top-right': { x: 780, y: 20 },
      'middle-left': { x: 20, y: 350 },
      center: { x: 400, y: 350 },
      'middle-right': { x: 780, y: 350 },
      'bottom-left': { x: 20, y: 680 },
      'bottom-center': { x: 400, y: 680 },
      'bottom-right': { x: 780, y: 680 }
    };
    const posOk = Object.entries(expect).every(([k, v]) => logic.positions[k] && logic.positions[k].x === v.x && logic.positions[k].y === v.y);
    const tileOk = logic.tileNull === null
      && logic.tile.count === 70
      && logic.tile.first.x === 0 && logic.tile.first.y === 0
      && logic.tile.second.x === 150 && logic.tile.second.y === 0
      && logic.tile.secondRowY === 100
      && logic.tile.stepX === 150;
    const fontOk = logic.font.w1000p6 === 60 && logic.font.w333p6 === 20 && logic.font.w50p2 === 8;
    const measureOk = logic.measure === 30 && logic.restoredFont === '' && logic.escape === 'a\nb    c'
      && logic.strokeDark === '#ffffff' && logic.strokeLight === '#000000';
    result.checks.logic = {
      ...logic, posOk, tileOk, fontOk, measureOk,
      ok: posOk && tileOk && fontOk && measureOk
        && logic.positionsCount === 10 && logic.defaults === 'bottom-right'
    };
  } catch (err) {
    result.checks.logic = { ok: false, error: err.message };
  }

  // —— 3) 文字水印：右下角 + 透明度 + 旋转 + 描边 ——
  try {
    const run = JSON.parse(await evalJs(renderAndCompare('测试水印-文字', `{
      type: 'text', text: '测试水印 仅供本人使用', position: 'bottom-right',
      sizePercent: 6, opacity: 60, rotation: -20, color: '#ffffff', stroke: true, format: 'png'
    }`)));
    const sized = run.width === 640 && run.height === 420
      && run.backSize[0] === 640 && run.backSize[1] === 420;
    const painted = run.changed > 0 && run.changedRatio > 0.001 && run.changedRatio < 0.5;
    const located = !!run.box && run.box[2] > 640 * 0.55 && run.box[3] > 420 * 0.55;
    result.checks.text = { ...run, sized, painted, located, ok: sized && painted && located && run.savedExists };
  } catch (err) {
    result.checks.text = { ok: false, error: err.message };
  }

  // —— 4) 图片水印（印章居中） ——
  try {
    const run = JSON.parse(await evalJs(renderAndCompare('测试水印-印章', `{
      type: 'image', position: 'center', sizePercent: 25,
      opacity: 90, rotation: 15, format: 'png'
    }`)));
    const sized = run.width === 640 && run.height === 420 && run.backSize[0] === 640;
    const painted = run.changed > 0 && run.changedRatio > 0.0005;
    const centered = !!run.box && Math.abs((run.box[0] + run.box[2]) / 2 - 640 / 2) < 640 * 0.2
      && Math.abs((run.box[1] + run.box[3]) / 2 - 420 / 2) < 420 * 0.2;
    result.checks.image = { ...run, sized, painted, centered, ok: sized && painted && centered && run.savedExists };
  } catch (err) {
    result.checks.image = { ok: false, error: err.message };
  }

  // —— 5) 平铺 ——
  try {
    const run = JSON.parse(await evalJs(renderAndCompare('测试水印-平铺', `{
      type: 'text', text: '仅供本人使用', position: 'tile',
      sizePercent: 5, opacity: 45, rotation: -30, color: '#ff3b30', stroke: false, format: 'png'
    }`)));
    const sized = run.width === 640 && run.height === 420 && run.backSize[0] === 640;
    const tiled = run.changed > 0 && run.changedRatio > 0.02;
    result.checks.tile = { ...run, sized, tiled, ok: sized && tiled && run.savedExists };
  } catch (err) {
    result.checks.tile = { ok: false, error: err.message };
  }

  // —— 汇总 ——
  const names = ['fixtures', 'logic', 'text', 'image', 'tile'];
  result.summary = Object.fromEntries(names.map((n) => [n, !!(result.checks[n] && result.checks[n].ok)]));
  result.ok = names.every((n) => result.summary[n]);
  writeResult({ ok: result.ok, at: new Date().toISOString(), result }, TEST_RESULT_FILE);

  await cleanFixtures(); // 收尾再清一次
  return result;
}

// ---------------------------------------------------------------- 界面自动测试

async function runWatermarkUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { pass: false, failures: [], steps: {}, shots: [], tools: {} };

  await fs.mkdir(TEST_DIR, { recursive: true });
  await cleanFixtures();

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-wm-${name}.png`);
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
    result.failures.push(`截图失败：${name}`);
    return false;
  };

  const getStatus = () => evalJs('document.getElementById("statusText").textContent');

  /** 等一次运行结束：状态文案变化 + 进度条收起（或超时） */
  async function waitForFinish(statusBefore, timeoutMs) {
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < timeoutMs) {
      const raw = await evalJs(`JSON.stringify({
        status: document.getElementById('statusText').textContent,
        progressHidden: document.getElementById('progressBar').hidden
      })`);
      const o = JSON.parse(raw);
      last = o.status;
      if (o.status !== statusBefore && o.progressHidden) return { ok: true, status: o.status, ms: Date.now() - t0 };
      await wait(400);
    }
    return { ok: false, status: last, timeout: true };
  }

  // —— 夹具 ——
  try {
    result.steps.fixtures = JSON.parse(await evalJs(MAKE_FIXTURES));
  } catch (err) {
    result.failures.push(`夹具生成失败：${err.message}`);
    result.steps.fixtures = { error: err.message };
    writeResult({ pass: false, at: new Date().toISOString(), result });
    return result;
  }

  // —— 切工具：左侧图片分组默认收起，先点标题展开 ——
  result.steps.expandGroup = await evalJs(`(() => {
    const g = document.querySelector('.tool-group[data-group-id="image"]');
    if (!g) return false;
    if (g.classList.contains('is-collapsed')) g.querySelector('.tool-group-head').click();
    return true;
  })()`);
  await wait(500);
  result.steps.switched = await evalJs(`(() => {
    const btn = document.querySelector('.tool-item[data-tool-id="watermark"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await wait(700);
  await shot('01-打开工具');

  if (!result.steps.switched) {
    result.failures.push('左侧没有找到加水印工具');
    writeResult({ pass: false, at: new Date().toISOString(), result });
    return result;
  }

  // 工具页必须出现（说明 registry 已接入本工具）
  result.steps.toolRendered = await evalJs(`!!document.querySelector('.wm-tool')`);

  // —— 第一轮：文字水印 + 右下角 ——
  const before1 = new Set(await fs.readdir(TEST_DIR));
  result.steps.added = await evalJs(`(() => {
    const el = document.querySelector('.wm-tool [data-add]');
    if (!el) return false;
    el.click();
    return true;
  })()`);

  // 等列表加载（测试模式对话框直接返回 测试水印* 夹具）
  let listed = 0;
  for (let i = 0; i < 30; i += 1) {
    listed = await evalJs(`document.querySelectorAll('.wm-tool .wm-item').length`);
    if (listed > 0) break;
    await wait(400);
  }
  result.steps.listedCount = listed;
  if (listed === 0) result.failures.push('添加图片后列表仍为空');
  await shot('02-已添加图片');

  // 改参数：填文字、选右下角、透明度 70、旋转 -15
  result.steps.textSetup = await evalJs(`(() => {
    const set = (sel, value) => {
      const el = document.querySelector('.wm-tool ' + sel);
      if (!el) return false;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const posBtn = document.querySelector('.wm-tool .wm-pos-btn[data-pos="bottom-right"]');
    if (posBtn) posBtn.click();
    return set('#wmText', '测试水印 仅供本人使用') && set('#wmOpacity', '70') && set('#wmRotation', '-15');
  })()`);
  await wait(900); // 等预览重画
  result.steps.preview = JSON.parse(await evalJs(`JSON.stringify({
    hint: (document.getElementById('wmPreviewHint') || {}).textContent || '',
    origW: (document.getElementById('wmOrigCanvas') || {}).width || 0,
    newW: (document.getElementById('wmNewCanvas') || {}).width || 0
  })`));
  await shot('03-实时预览');
  if (!(result.steps.preview.newW > 1)) result.failures.push('实时预览没有画出加水印后的画面');

  const statusBefore1 = await getStatus();
  result.steps.ran1 = await evalJs(`(() => {
    const el = document.querySelector('.wm-tool [data-run]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  result.steps.finish1 = await waitForFinish(statusBefore1, 120000);
  await shot('04-文字水印完成');
  const after1 = await fs.readdir(TEST_DIR);
  result.tools.text = {
    newFiles: after1.filter((f) => !before1.has(f)),
    resultTexts: await evalJs(`[...document.querySelectorAll('.wm-tool .wm-item-result')].map((e) => e.textContent)`),
    status: await getStatus()
  };
  result.tools.text.ok = result.steps.finish1.ok
    && result.tools.text.newFiles.length > 0
    && result.tools.text.resultTexts.some((t) => t.includes('已保存'));
  if (!result.tools.text.ok) result.failures.push('文字水印运行未产出成功结果');

  // —— 第二轮：图片水印 + 平铺 ——
  const before2 = new Set(await fs.readdir(TEST_DIR));
  result.steps.stampPicked = await evalJs(`(async () => {
    const seg = document.querySelector('.wm-tool .wm-seg-btn[data-type="image"]');
    if (seg) seg.click();
    const btn = document.getElementById('wmStampBtn');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await wait(1600);
  result.steps.stampName = await evalJs(`document.getElementById('wmStampName').textContent`);
  result.steps.tilePicked = await evalJs(`(() => {
    const btn = document.querySelector('.wm-tool .wm-pos-btn[data-pos="tile"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await wait(900);
  await shot('05-图片水印平铺预览');

  const statusBefore2 = await getStatus();
  result.steps.ran2 = await evalJs(`(() => {
    const el = document.querySelector('.wm-tool [data-run]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  result.steps.finish2 = await waitForFinish(statusBefore2, 120000);
  await shot('06-图片水印完成');
  const after2 = await fs.readdir(TEST_DIR);
  result.tools.image = {
    newFiles: after2.filter((f) => !before2.has(f)),
    resultTexts: await evalJs(`[...document.querySelectorAll('.wm-tool .wm-item-result')].map((e) => e.textContent)`),
    status: await getStatus()
  };
  result.tools.image.ok = result.steps.finish2.ok
    && result.tools.image.newFiles.length > 0
    && result.tools.image.resultTexts.some((t) => t.includes('已保存'));
  if (!result.tools.image.ok) result.failures.push('图片水印运行未产出成功结果');

  // —— 清空 ——
  result.steps.cleared = await evalJs(`(() => {
    const el = document.querySelector('.wm-tool [data-clear]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  await wait(500);
  result.steps.listAfterClear = await evalJs(`document.querySelectorAll('.wm-tool .wm-item').length`);
  await shot('99-测试结束');

  result.pass = result.failures.length === 0
    && result.steps.toolRendered
    && result.steps.listedCount > 0
    && result.tools.text.ok && result.tools.image.ok
    && result.steps.listAfterClear === 0;

  writeResult({ pass: result.pass, at: new Date().toISOString(), result });
  await cleanFixtures();
  return result;
}

module.exports = { runWatermarkTest, runWatermarkUiTest, writeResult, TEST_DIR, PREFIX };