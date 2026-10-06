// 长图拼接工具自检（供 `electron . --stitch-test` / `--stitch-ui-test` 调用）
// 覆盖：core/plan.js 纯逻辑断言（尺寸归一 / 布局 / 超限）+ 真实绘制链路（竖拼 / 统一宽度 / 横拼 / JPG），
//       产物落盘后用内核解码回读，校验输出尺寸与 computeLayout 完全一致、并逐点采样证明拼接顺序正确。
// 说明：通过 window.desktop.* 走真实 IPC 链路；结果写入 %TEMP%/tomato-stitch-test.json 与
//       %TEMP%/tomato-stitch-ui-test.json，截图落在 %TEMP%/tomato-uitest。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const TEST_RESULT_FILE = path.join(os.tmpdir(), 'tomato-stitch-test.json');
const UI_RESULT_FILE = path.join(os.tmpdir(), 'tomato-stitch-ui-test.json');

/** 本工具的夹具与产物前缀：清理只认它，绝不碰其它工具的夹具 */
const PREFIX = '测试拼接';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeResult(payload, file = UI_RESULT_FILE) {
  fsSync.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

/** 清理本工具的夹具与产物（开跑清一次、收尾清一次，覆盖所有扩展名） */
async function cleanFixtures() {
  const entries = await fs.readdir(TEST_DIR, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith(PREFIX)) await fs.rm(path.join(TEST_DIR, e.name), { recursive: true, force: true });
  }
}

/** 三张不同尺寸的纯色小图（顺序＝A 红 200×100 / B 蓝 100×200 / C 绿 300×150，便于按颜色验证顺序） */
const FIXTURES = [
  { name: '测试拼接A.png', width: 200, height: 100, rgb: [255, 0, 0] },
  { name: '测试拼接B.png', width: 100, height: 200, rgb: [0, 0, 255] },
  { name: '测试拼接C.png', width: 300, height: 150, rgb: [0, 255, 0] }
];

const MAKE_FIXTURES = `(async () => {
  const { encodeImageToBytes } = await import('../shared/imageio.js');
  const seed = ${JSON.stringify(path.join(TEST_DIR, 'seed.png'))};
  const mk = async (baseName, w, h, rgb) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      px[i * 4] = rgb[0]; px[i * 4 + 1] = rgb[1]; px[i * 4 + 2] = rgb[2]; px[i * 4 + 3] = 255;
    }
    const bytes = await encodeImageToBytes(px, w, h, { format: 'png' });
    return window.desktop.saveImageNextTo({ sourcePath: seed, baseName, ext: '.png', bytes });
  };
  return JSON.stringify({
    a: await mk('测试拼接A', 200, 100, [255, 0, 0]),
    b: await mk('测试拼接B', 100, 200, [0, 0, 255]),
    c: await mk('测试拼接C', 300, 150, [0, 255, 0])
  });
})()`;

/** 纯逻辑断言（在界面进程里 import core/plan.js 跑纯函数，主进程只做数值比对） */
const LOGIC_SCRIPT = `(async () => {
  const plan = await import('../tools/stitch/core/plan.js');
  const items = [{ width: 200, height: 100 }, { width: 100, height: 200 }, { width: 300, height: 150 }];
  const sizes = [{ w: 200, h: 100 }, { w: 100, h: 200 }, { w: 300, h: 150 }];
  return JSON.stringify({
    none: plan.normalizeSizes({ items, direction: 'vertical', mode: 'none' }),
    unify150: plan.normalizeSizes({ items, direction: 'vertical', mode: 'unify', targetSize: 150 }),
    unifyAuto: plan.normalizeSizes({ items, direction: 'vertical', mode: 'unify' }),
    unifyH150: plan.normalizeSizes({ items, direction: 'horizontal', mode: 'unify', targetSize: 150 }),
    unifyBig: plan.normalizeSizes({ items: [{ width: 100, height: 50 }], direction: 'vertical', mode: 'unify', targetSize: 500 }),
    empty: plan.normalizeSizes({ items: [], direction: 'vertical', mode: 'unify', targetSize: 100 }),
    vCenter: plan.computeLayout({ sizes, direction: 'vertical', gap: 10, align: 'center', margin: 0 }),
    vStart: plan.computeLayout({ sizes, direction: 'vertical', gap: 10, align: 'start', margin: 0 }),
    vEnd: plan.computeLayout({ sizes, direction: 'vertical', gap: 10, align: 'end', margin: 0 }),
    hCenter: plan.computeLayout({ sizes, direction: 'horizontal', gap: 10, align: 'center', margin: 20 }),
    overEdge: plan.computeLayout({ sizes: [{ w: 20000, h: 20000 }], direction: 'vertical', gap: 0, align: 'center', margin: 0 }),
    overArea: plan.computeLayout({ sizes: [{ w: 16000, h: 12000 }], direction: 'vertical', gap: 0, align: 'center', margin: 0 }),
    emptyLayout: plan.computeLayout({ sizes: [], direction: 'vertical', gap: 0, align: 'center', margin: 5 }),
    dirs: plan.STITCH_DIRECTIONS,
    aligns: plan.ALIGN_PRESETS,
    fmt: [plan.formatSize(0), plan.formatSize(512), plan.formatSize(2048), plan.formatSize(1048576), plan.formatSize(3670016)],
    base: [plan.baseNameOf('C:\\\\dir\\\\子目录\\\\图片.png'), plan.baseNameOf('/x/y/no-ext'), plan.baseNameOf('')],
    est: plan.estimateOutputBytes({ canvasW: 150, canvasH: 370 }),
    limits: [plan.MAX_CANVAS_EDGE, plan.MAX_CANVAS_AREA]
  });
})()`;

/**
 * 在界面进程里真实拼一次：调 ui.js 的 composeStitch → 落盘 → 解码回读 → 采样像素。
 * samples 形如 [[标签, x, y, [r,g,b], 容差], ...]
 */
function runScript({ label, params, samples }) {
  const files = FIXTURES.map((f) => ({ path: path.join(TEST_DIR, f.name), width: f.width, height: f.height }));
  return `(async () => {
    const ui = await import('../tools/stitch/ui.js');
    const io = await import('../shared/imageio.js');
    const files = ${JSON.stringify(files)};
    const params = ${JSON.stringify(params)};
    const progress = [];
    const r = await ui.composeStitch({
      meta: files.map((f) => ({ width: f.width, height: f.height })),
      loadImage: async (i) => io.decodeImageFromBytes(new Uint8Array(await window.desktop.readFile(files[i].path))),
      direction: params.direction, mode: params.mode, targetSize: params.targetSize,
      gap: params.gap, align: params.align, margin: params.margin,
      format: params.format, quality: params.quality,
      onProgress: (done, total) => progress.push(done + '/' + total)
    });
    const ext = params.format === 'jpg' ? '.jpg' : '.png';
    const saved = await window.desktop.saveImageNextTo({
      sourcePath: files[0].path, baseName: '测试拼接-${label}', ext, bytes: r.bytes
    });
    const back = await io.decodeImageFromBytes(new Uint8Array(await window.desktop.readFile(saved)));
    const at = (x, y) => {
      const p = (y * back.width + x) * 4;
      return [back.pixels[p], back.pixels[p + 1], back.pixels[p + 2]];
    };
    const samples = {};
    for (const s of ${JSON.stringify(samples.map((s) => [s[0], s[1], s[2], s[3], s[4]]))}) {
      const got = at(s[1], s[2]);
      const diff = Math.max(Math.abs(got[0] - s[3][0]), Math.abs(got[1] - s[3][1]), Math.abs(got[2] - s[3][2]));
      samples[s[0]] = { at: [s[1], s[2]], got, want: s[3], diff, ok: diff <= s[4] };
    }
    return JSON.stringify({
      bytes: r.bytes.length, width: r.width, height: r.height, cancelled: r.cancelled,
      sizes: r.sizes, layout: r.layout, progress,
      saved, savedExists: (await window.desktop.pathInfo(saved)).size > 0,
      backSize: [back.width, back.height],
      samples
    });
  })()`;
}

/** 三次真实拼接的参数与采样点（坐标与期望颜色一一对应，顺序错位就会采样失败） */
const RUNS = [
  {
    label: '竖拼',
    params: { direction: 'vertical', mode: 'none', targetSize: 0, gap: 10, align: 'center', margin: 0, format: 'png', quality: 92 },
    expect: { width: 300, height: 470, sizes: [[200, 100], [100, 200], [300, 150]] },
    samples: [
      ['第1张-红', 150, 50, [255, 0, 0], 8],
      ['间距-白', 150, 105, [255, 255, 255], 8],
      ['第2张-蓝', 150, 200, [0, 0, 255], 8],
      ['第3张-绿', 150, 400, [0, 255, 0], 8]
    ]
  },
  {
    label: '统一宽度150',
    params: { direction: 'vertical', mode: 'unify', targetSize: 150, gap: 10, align: 'center', margin: 0, format: 'png', quality: 92 },
    expect: { width: 150, height: 370, sizes: [[150, 75], [100, 200], [150, 75]] },
    samples: [
      ['第1张-红', 75, 30, [255, 0, 0], 8],
      ['第2张-蓝', 75, 180, [0, 0, 255], 8],
      ['第3张-绿', 75, 340, [0, 255, 0], 8]
    ]
  },
  {
    label: '横拼',
    params: { direction: 'horizontal', mode: 'none', targetSize: 0, gap: 10, align: 'center', margin: 0, format: 'png', quality: 92 },
    expect: { width: 620, height: 200, sizes: [[200, 100], [100, 200], [300, 150]] },
    samples: [
      ['第1张-红', 100, 100, [255, 0, 0], 8],
      ['第2张-蓝', 260, 100, [0, 0, 255], 8],
      ['第3张-绿', 470, 100, [0, 255, 0], 8]
    ]
  },
  {
    label: 'JPG',
    params: { direction: 'vertical', mode: 'none', targetSize: 0, gap: 10, align: 'center', margin: 0, format: 'jpg', quality: 92 },
    expect: { width: 300, height: 470, sizes: [[200, 100], [100, 200], [300, 150]] },
    samples: [
      ['第1张-红', 150, 50, [255, 0, 0], 40],
      ['第2张-蓝', 150, 200, [0, 0, 255], 40],
      ['第3张-绿', 150, 400, [0, 255, 0], 40]
    ]
  }
];

async function runStitchTest(win) {
  const evalJs = (code) => win.webContents.executeJavaScript(code);
  const result = { ok: false, checks: {}, notes: [] };

  await fs.mkdir(TEST_DIR, { recursive: true });
  await cleanFixtures(); // 开跑前先清一次

  // —— 1) 夹具 ——
  try {
    const fixtures = JSON.parse(await evalJs(MAKE_FIXTURES));
    result.checks.fixtures = {
      ...fixtures,
      ok: [fixtures.a, fixtures.b, fixtures.c].every((p) => !!p && fsSync.existsSync(p))
    };
  } catch (err) {
    result.checks.fixtures = { ok: false, error: err.message };
  }

  // —— 2) 纯逻辑（core/plan.js） ——
  try {
    const l = JSON.parse(await evalJs(LOGIC_SCRIPT));
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const sizeOk = eq(l.none, [{ w: 200, h: 100 }, { w: 100, h: 200 }, { w: 300, h: 150 }])
      && eq(l.unify150, [{ w: 150, h: 75 }, { w: 100, h: 200 }, { w: 150, h: 75 }])
      && eq(l.unifyAuto, [{ w: 200, h: 100 }, { w: 100, h: 200 }, { w: 300, h: 150 }])
      && eq(l.unifyH150, [{ w: 200, h: 100 }, { w: 75, h: 150 }, { w: 300, h: 150 }])
      && eq(l.unifyBig, [{ w: 100, h: 50 }]) // 只缩不放：目标比原图大时保持原样
      && eq(l.empty, []);
    const layoutOk = l.vCenter.canvasW === 300 && l.vCenter.canvasH === 470
      && eq(l.vCenter.offsets, [{ x: 50, y: 0, w: 200, h: 100 }, { x: 100, y: 110, w: 100, h: 200 }, { x: 0, y: 320, w: 300, h: 150 }])
      && eq(l.vStart.offsets.map((o) => o.x), [0, 0, 0])
      && eq(l.vEnd.offsets.map((o) => o.x), [100, 200, 0])
      && l.hCenter.canvasW === 660 && l.hCenter.canvasH === 240
      && eq(l.hCenter.offsets, [{ x: 20, y: 70, w: 200, h: 100 }, { x: 230, y: 20, w: 100, h: 200 }, { x: 340, y: 45, w: 300, h: 150 }]);
    const limitOk = l.overEdge.limitExceeded === true && /16384/.test(l.overEdge.reason)
      && l.overArea.limitExceeded === true && /1\.6 亿/.test(l.overArea.reason)
      && l.vCenter.limitExceeded === false && l.vCenter.reason === ''
      && l.emptyLayout.canvasW === 10 && l.emptyLayout.canvasH === 10 && l.emptyLayout.offsets.length === 0;
    const utilOk = eq(l.fmt, ['0 B', '512 B', '2 KB', '1.00 MB', '3.50 MB'])
      && eq(l.base, ['图片', 'no-ext', ''])
      && l.est === 55500
      && l.limits[0] === 16384 && l.limits[1] === 160000000
      && l.dirs.length === 2 && l.dirs[0].value === 'vertical' && l.dirs[1].value === 'horizontal'
      && l.aligns.length === 3 && l.aligns[0].value === 'center';
    result.checks.logic = { ...l, sizeOk, layoutOk, limitOk, utilOk, ok: sizeOk && layoutOk && limitOk && utilOk };
  } catch (err) {
    result.checks.logic = { ok: false, error: err.message };
  }

  // —— 3) 真实绘制链路（竖拼 / 统一宽度 / 横拼 / JPG） ——
  for (const run of RUNS) {
    const key = run.label;
    try {
      const r = JSON.parse(await evalJs(runScript(run)));
      const sized = r.width === run.expect.width && r.height === run.expect.height
        && r.layout.canvasW === run.expect.width && r.layout.canvasH === run.expect.height
        && r.backSize[0] === run.expect.width && r.backSize[1] === run.expect.height;
      const sizesOk = JSON.stringify(r.sizes.map((s) => [s.w, s.h])) === JSON.stringify(run.expect.sizes);
      const samplesOk = Object.values(r.samples).every((s) => s.ok);
      const progressOk = r.progress.length === FIXTURES.length && r.progress[r.progress.length - 1] === `${FIXTURES.length}/${FIXTURES.length}`;
      result.checks[key] = {
        ...r, sized, sizesOk, samplesOk, progressOk,
        ok: sized && sizesOk && samplesOk && progressOk && r.bytes > 0 && r.savedExists && !r.cancelled
      };
    } catch (err) {
      result.checks[key] = { ok: false, error: err.message };
    }
  }

  // —— 汇总 ——
  const names = ['fixtures', 'logic', ...RUNS.map((r) => r.label)];
  result.summary = Object.fromEntries(names.map((n) => [n, !!(result.checks[n] && result.checks[n].ok)]));
  result.ok = names.every((n) => result.summary[n]);
  writeResult({ ok: result.ok, at: new Date().toISOString(), result }, TEST_RESULT_FILE);

  await cleanFixtures(); // 收尾再清一次
  return result;
}

// ---------------------------------------------------------------- 界面自动测试

async function runStitchUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { pass: false, failures: [], steps: {}, shots: [] };

  await fs.mkdir(TEST_DIR, { recursive: true });
  await cleanFixtures();

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-st-${name}.png`);
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
      const o = JSON.parse(await evalJs(`JSON.stringify({
        status: document.getElementById('statusText').textContent,
        progressHidden: document.getElementById('progressBar').hidden
      })`));
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
    const btn = document.querySelector('.tool-item[data-tool-id="stitch"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await wait(700);
  await shot('01-打开工具');

  if (!result.steps.switched) {
    result.failures.push('左侧没有找到长图拼接工具');
    writeResult({ pass: false, at: new Date().toISOString(), result });
    return result;
  }
  result.steps.toolRendered = await evalJs(`!!document.querySelector('.st-tool')`);

  // —— 添加夹具（测试模式下对话框直接返回「测试拼接*」） ——
  result.steps.added = await evalJs(`(() => {
    const el = document.querySelector('.st-tool [data-add]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  let listed = 0;
  for (let i = 0; i < 30; i += 1) {
    listed = await evalJs(`document.querySelectorAll('.st-tool .st-item').length`);
    if (listed >= FIXTURES.length) break;
    await wait(400);
  }
  result.steps.listedCount = listed;
  result.steps.names = await evalJs(`[...document.querySelectorAll('.st-tool .st-item-name')].map((e) => e.textContent)`);
  if (listed !== FIXTURES.length) result.failures.push(`添加后列表应有 ${FIXTURES.length} 张，实际 ${listed} 张`);
  await shot('02-已添加图片');

  // —— 顺序调整：第 1 张下移 → 顺序变化 → 再上移回原位 ——
  const beforeMove = result.steps.names;
  await evalJs(`document.querySelectorAll('.st-tool .st-item')[0].querySelectorAll('.st-icon-btn')[1].click()`);
  await wait(300);
  const afterMove = await evalJs(`[...document.querySelectorAll('.st-tool .st-item-name')].map((e) => e.textContent)`);
  await evalJs(`document.querySelectorAll('.st-tool .st-item')[1].querySelectorAll('.st-icon-btn')[0].click()`);
  await wait(300);
  const restored = await evalJs(`[...document.querySelectorAll('.st-tool .st-item-name')].map((e) => e.textContent)`);
  result.steps.moveOrder = { beforeMove, afterMove, restored };
  const moveOk = afterMove[0] === beforeMove[1] && afterMove[1] === beforeMove[0]
    && JSON.stringify(restored) === JSON.stringify(beforeMove);
  if (!moveOk) result.failures.push('列表上下移动没有按预期改变拼接顺序');

  // —— 调参数：竖拼 + 统一宽度 150 + 间距 10（期望输出 150 × 370） ——
  result.steps.params = await evalJs(`(() => {
    const set = (sel, value) => {
      const el = document.querySelector('.st-tool ' + sel);
      if (!el) return false;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    return set('#stDirection', 'vertical') && set('#stMode', 'unify') && set('#stTarget', '150')
      && set('#stGap', '10') && set('#stMargin', '0') && set('#stAlign', 'center') && set('#stFormat', 'png');
  })()`);
  await wait(600);
  result.steps.preview = JSON.parse(await evalJs(`JSON.stringify({
    hint: document.getElementById('stPreviewHint').textContent,
    boxes: document.querySelectorAll('.st-tool .st-preview-box').length,
    limit: document.getElementById('stLimitHint').textContent
  })`));
  await shot('03-参数与排布预览');
  if (result.steps.preview.boxes !== FIXTURES.length) result.failures.push('排布预览的方块数不对');
  if (!(/150/.test(result.steps.preview.hint) && /370/.test(result.steps.preview.hint))) {
    result.failures.push(`预览提示的输出尺寸不对：${result.steps.preview.hint}`);
  }

  // —— 运行 ——
  const statusBefore = await getStatus();
  result.steps.ran = await evalJs(`(() => {
    const el = document.querySelector('.st-tool [data-run]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  result.steps.finish = await waitForFinish(statusBefore, 120000);
  await shot('04-拼接完成');
  const resultText = await evalJs(`document.getElementById('stResult').textContent`);
  result.steps.resultText = resultText;
  result.steps.status = await getStatus();

  const m = /输出：(.+?)（(\d+)\s*[×x]\s*(\d+)/.exec(resultText);
  if (!m) {
    result.failures.push(`没有拿到输出文件信息：${resultText}`);
  } else {
    const outPath = m[1];
    result.steps.output = { path: outPath, width: Number(m[2]), height: Number(m[3]) };
    result.steps.sized = result.steps.output.width === 150 && result.steps.output.height === 370;
    if (!result.steps.sized) result.failures.push(`输出尺寸应为 150 × 370，实际 ${m[2]} × ${m[3]}`);
    // 解码回读：尺寸一致 + 从上到下依次是红 / 蓝 / 绿（证明界面这条路也拼对了顺序）
    result.steps.pixels = JSON.parse(await evalJs(`(async () => {
      const io = await import('../shared/imageio.js');
      const back = await io.decodeImageFromBytes(new Uint8Array(await window.desktop.readFile(${JSON.stringify(outPath)})));
      const at = (x, y) => { const p = (y * back.width + x) * 4; return [back.pixels[p], back.pixels[p + 1], back.pixels[p + 2]]; };
      return JSON.stringify({ size: [back.width, back.height], red: at(75, 30), blue: at(75, 180), green: at(75, 340) });
    })()`));
    const near = (got, want, tol) => Math.max(...got.map((v, i) => Math.abs(v - want[i]))) <= tol;
    const px = result.steps.pixels;
    const orderOk = px.size[0] === 150 && px.size[1] === 370
      && near(px.red, [255, 0, 0], 8) && near(px.blue, [0, 0, 255], 8) && near(px.green, [0, 255, 0], 8);
    result.steps.orderOk = orderOk;
    if (!orderOk) result.failures.push(`产物像素采样不符（顺序或尺寸错）：${JSON.stringify(px)}`);
    if (fsSync.existsSync(outPath) === false) result.failures.push('输出文件不存在');
  }

  // —— 清空 ——
  result.steps.cleared = await evalJs(`(() => {
    const el = document.querySelector('.st-tool [data-clear]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  await wait(400);
  result.steps.listAfterClear = await evalJs(`document.querySelectorAll('.st-tool .st-item').length`);
  await shot('99-测试结束');

  result.pass = result.failures.length === 0
    && result.steps.toolRendered && result.steps.listedCount === FIXTURES.length
    && moveOk && result.steps.finish.ok && !!result.steps.orderOk
    && result.steps.listAfterClear === 0;

  writeResult({ pass: result.pass, at: new Date().toISOString(), result });
  await cleanFixtures();
  return result;
}

module.exports = { runStitchTest, runStitchUiTest, writeResult, TEST_DIR, PREFIX };
