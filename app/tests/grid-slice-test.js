// 九宫格切图 自检 + 界面自动测试（供 `electron . --grid-slice-test` / `--grid-slice-ui-test` 调用）
// 覆盖：
//   runGridSliceTest   —— 夹具（300×300 四角纯色）真实切图 ①3×3 无缝隙 ②3×3 带 10px 缝 ③2×2；
//                         校验产出文件数 = rows×cols、每块尺寸 = computeCells 的 outW/outH、
//                         并用像素采样证明每块内容来自原图对应位置（含四角方位校验）；
//                         外加 computeCells / namingForCells / warnings / 估算 的纯逻辑断言。
//   runGridSliceUiTest —— 像真人一样「展开图片分组 → 切工具 → 点添加 → 选列表项看预览 → 点开始切图 → 清空」，
//                         逐步截图并校验产物文件数与每块尺寸。
// 结果：%TEMP%/tomato-grid-slice-test.json、%TEMP%/tomato-grid-slice-ui-test.json；截图落在 %TEMP%/tomato-uitest。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-grid-slice-test.json');
const UI_RESULT_FILE = path.join(os.tmpdir(), 'tomato-grid-slice-ui-test.json');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 本测试的夹具与产物前缀（清理范围仅限它，避免与其它界面测试互相污染） */
const FIXTURE_PREFIX = /^测试切图/;

/** 夹具四角颜色：用来验证切出来的每一块落在原图正确的位置上 */
const QUADRANTS = { tl: [220, 30, 30], tr: [30, 180, 60], bl: [40, 80, 220], br: [230, 200, 40] };

function writeResult(payload) {
  fsSync.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

function writeUiResult(payload) {
  fsSync.writeFileSync(UI_RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

/** 清掉本测试的全部夹具与产物（开跑一次、收尾一次；所有扩展名） */
async function cleanFixtures() {
  const before = (await fs.readdir(TEST_DIR).catch(() => [])).filter((f) => FIXTURE_PREFIX.test(f));
  for (const f of before) {
    await fs.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
  }
  const after = (await fs.readdir(TEST_DIR).catch(() => [])).filter((f) => FIXTURE_PREFIX.test(f));
  // 返回 ok 供汇总断言（`checks` 里每一项都要有 ok:true 才算过）
  return { ok: after.length === 0, before, after };
}

/** 渲染进程里造两张 300×300、四角能区分方位的 PNG 夹具（名字以「测试切图」开头） */
function fixtureScript() {
  return `(async () => {
    const { encodeImageToBytes } = await import('../shared/imageio.js');
    const Q = ${JSON.stringify(QUADRANTS)};
    const w = 300, h = 300;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = (y * w + x) * 4;
        const c = y < 150 ? (x < 150 ? Q.tl : Q.tr) : (x < 150 ? Q.bl : Q.br);
        px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255;
      }
    }
    const bytes = await encodeImageToBytes(px, w, h, { format: 'png' });
    const out = [];
    for (const name of ['测试切图A', '测试切图B']) {
      out.push(await window.desktop.saveImageNextTo({
        sourcePath: ${JSON.stringify(path.join(TEST_DIR, 'seed-grid-slice.png'))},
        baseName: name, ext: '.png', bytes
      }));
    }
    return JSON.stringify(out);
  })()`;
}

/**
 * 「真实切图 + 像素校验」脚本（在渲染进程里跑，用的就是界面的 sliceImage 链路）
 * 校验：块数、每块尺寸、每块内容是否来自原图对应位置、四角方位、切缝颜色。
 */
function sliceScript(tag, options, fixtures) {
  return `(async () => {
    const { computeCells, namingForCells } = await import('../tools/grid-slice/core/plan.js');
    const { sliceImage } = await import('../tools/grid-slice/ui.js');
    const { decodeImageFromBytes } = await import('../shared/imageio.js');
    const options = ${JSON.stringify(options)};
    const tag = ${JSON.stringify(tag)};
    const fixtures = ${JSON.stringify(fixtures)};
    const Q = ${JSON.stringify(QUADRANTS)};
    const out = { images: [], partCount: 0, dims: [], corner: {}, seam: {}, position: [], errors: [], savedNames: [] };

    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    const hexToRgb = (hex) => {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
      if (!m) return null;
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const seamRgb = hexToRgb(options.seamColor);
    const band = options.gap > 0 && options.seamColor ? Math.max(1, Math.round(options.gap / 2)) : 0;

    const readBlock = async (bytes) => {
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const cv = document.createElement('canvas');
      cv.width = bmp.width; cv.height = bmp.height;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(bmp, 0, 0);
      const data = cx.getImageData(0, 0, bmp.width, bmp.height).data;
      bmp.close();
      return {
        width: cv.width, height: cv.height,
        at: (u, v) => { const i = (v * cv.width + u) * 4; return [data[i], data[i + 1], data[i + 2]]; }
      };
    };

    for (const fx of fixtures) {
      try {
        const bytes = await window.desktop.readFile(fx);
        const img = await decodeImageFromBytes(bytes);
        const base = fx.replace(/^.*[\\\\/]/, '').replace(/\\.[^.]+$/, '');
        const names = namingForCells({ baseName: base + '_' + tag, rows: options.rows, cols: options.cols, order: options.order });
        const { plan, parts } = await sliceImage(img.pixels, img.width, img.height, options);

        const entry = {
          file: base, planCells: plan.cells.length, warnings: plan.warnings,
          outW: plan.outW, outH: plan.outH, parts: parts.length, expect: options.rows * options.cols
        };

        for (const part of parts) {
          const saved = await window.desktop.saveImageNextTo({
            sourcePath: fx, targetDir: ${JSON.stringify(TEST_DIR)}, baseName: names[part.index - 1], ext: '.png', bytes: part.bytes
          });
          out.savedNames.push(saved.replace(/^.*[\\\\/]/, ''));
        }

        for (const part of parts) {
          const block = await readBlock(part.bytes);
          out.partCount += 1;
          out.dims.push([block.width, block.height]);
          const cell = plan.cells[part.index - 1];
          if (block.width !== plan.outW || block.height !== plan.outH) out.errors.push('块 ' + part.index + ' 尺寸不符');

          // 1) 位置校验：无缝时输出块与原图逐像素一一对应（drawImage 同尺寸不缩放）
          if (band === 0) {
            const pts = [[1, 1], [Math.floor(plan.outW / 2), Math.floor(plan.outH / 2)], [plan.outW - 2, plan.outH - 2]];
            for (const [u, v] of pts) {
              const got = block.at(u, v);
              const idx = (cell.sy + v) * img.width + (cell.sx + u);
              const want = [img.pixels[idx * 4], img.pixels[idx * 4 + 1], img.pixels[idx * 4 + 2]];
              const ok = near(got[0], want[0], 3) && near(got[1], want[1], 3) && near(got[2], want[2], 3);
              out.position.push({ block: part.index, u, v, got, want, ok });
            }
          }

          // 2) 四角方位校验：第 1 块应是原图左上角色，第 3 块右上、第 7 块左下、第 9 块右下
          if (options.rows === 3 && options.cols === 3 && [1, 3, 7, 9].includes(part.index)) {
            const u = part.index === 1 || part.index === 7 ? Math.floor(block.width * 0.25) : Math.floor(block.width * 0.75);
            const v = part.index === 1 || part.index === 3 ? Math.floor(block.height * 0.25) : Math.floor(block.height * 0.75);
            const want = part.index === 1 ? Q.tl : part.index === 3 ? Q.tr : part.index === 7 ? Q.bl : Q.br;
            const got = block.at(u, v);
            out.corner['block' + part.index] = {
              got, want,
              ok: near(got[0], want[0], 6) && near(got[1], want[1], 6) && near(got[2], want[2], 6)
            };
          }

          // 3) 切缝颜色校验：第 2 块右缘、第 4 块下缘应是所设缝色
          if (band > 0 && seamRgb && (part.index === 2 || part.index === 4)) {
            const pt = part.index === 2 ? [block.width - 1, Math.floor(block.height / 2)] : [Math.floor(block.width / 2), block.height - 1];
            const got = block.at(pt[0], pt[1]);
            out.seam['block' + part.index] = {
              got, want: seamRgb,
              ok: near(got[0], seamRgb[0], 4) && near(got[1], seamRgb[1], 4) && near(got[2], seamRgb[2], 4)
            };
          }
        }
        out.images.push(entry);
      } catch (err) {
        out.errors.push(String((err && err.message) || err));
      }
    }
    out.ok = out.errors.length === 0
      && out.images.length === fixtures.length
      && out.images.every((im) => im.parts === im.expect && im.warnings.length === 0);
    return JSON.stringify(out);
  })()`;
}

/** 纯逻辑断言（在渲染进程里 import core/plan.js；与 Node 单测同一套期望值） */
function logicScript() {
  return `(async () => {
    const m = await import('../tools/grid-slice/core/plan.js');
    const c1 = m.computeCells({ width: 300, height: 300, rows: 3, cols: 3, gap: 0, margin: 0 });
    const c2 = m.computeCells({ width: 300, height: 300, rows: 3, cols: 3, gap: 10, margin: 20 });
    const c3 = m.computeCells({ width: 300, height: 300, rows: 2, cols: 2 });
    const small = m.computeCells({ width: 20, height: 20, rows: 3, cols: 3, gap: 0 });
    const zero = m.computeCells({ width: 20, height: 20, rows: 3, cols: 3, gap: 10 });
    const rowNames = m.namingForCells({ baseName: '照片', rows: 3, cols: 3, order: 'row' });
    const colNames = m.namingForCells({ baseName: '照片', rows: 3, cols: 3, order: 'column' });
    const est = m.estimateTotalBytes({ outW: 100, outH: 100, count: 9, format: 'png' });
    const checks = {
      presets: m.GRID_PRESETS.length === 5 && m.GRID_PRESETS[0].value === '3x3' && m.GRID_PRESETS[4].value === 'custom',
      cells3x3: c1.cells.length === 9 && c1.outW === 100 && c1.outH === 100
        && c1.cells[0].sx === 0 && c1.cells[0].sy === 0 && c1.cells[8].sx === 200 && c1.cells[8].sy === 200
        && c1.cells[8].index === 9,
      cells3x3gap10margin20: c2.cells.length === 9 && c2.outW === 80 && c2.outH === 80
        && c2.cells[1].sx === 110 && c2.cells[8].sx === 200 && c2.cells[8].sy === 200,
      cells2x2: c3.cells.length === 4 && c3.outW === 150 && c3.outH === 150,
      namesRow: JSON.stringify(rowNames) === JSON.stringify(['照片_01','照片_02','照片_03','照片_04','照片_05','照片_06','照片_07','照片_08','照片_09']),
      namesColumn: JSON.stringify(colNames) === JSON.stringify(['照片_01','照片_04','照片_07','照片_02','照片_05','照片_08','照片_03','照片_06','照片_09']),
      warnSmall: small.cells.length === 9 && small.warnings.length >= 1,
      warnZero: zero.cells.length === 0 && zero.warnings.length >= 1,
      estimate: est.perFile > 0 && est.total === est.perFile * 9,
      helpers: m.formatSize(1536) === '2 KB' && m.baseNameOf('/tmp/a/照片.png') === '照片'
    };
    return JSON.stringify({
      checks,
      ok: Object.values(checks).every(Boolean),
      detail: { c1: c1.cells, small: small.warnings, zero: zero.warnings, rowNames, colNames, est }
    });
  })()`;
}

// —— 自检 ——

async function runGridSliceTest(win) {
  const evalJs = (code) => win.webContents.executeJavaScript(code);
  const result = { checks: {}, cases: {}, notes: [] };

  await fs.mkdir(TEST_DIR, { recursive: true });
  result.checks.清理 = await cleanFixtures();

  // —— 夹具 ——
  try {
    const fixtures = JSON.parse(await evalJs(fixtureScript()));
    result.fixtures = fixtures;
    result.checks.夹具 = {
      ok: fixtures.length === 2 && fixtures.every((p) => fsSync.existsSync(p) && /^测试切图[AB]\.png$/.test(path.basename(p))),
      files: fixtures.map((p) => path.basename(p))
    };
  } catch (err) {
    result.checks.夹具 = { ok: false, error: err.message };
    result.ok = false;
    writeResult({ ok: false, at: new Date().toISOString(), result });
    return result;
  }
  const fixtures = result.fixtures;

  // —— 纯逻辑 ——
  try {
    const logic = JSON.parse(await evalJs(logicScript()));
    result.checks.逻辑 = logic;
  } catch (err) {
    result.checks.逻辑 = { ok: false, error: err.message };
  }

  // —— 真实切图 3 种方案 ——
  const cases = [
    { tag: '无缝隙', options: { rows: 3, cols: 3, gap: 0, margin: 0, order: 'row', format: 'png', quality: 92, seamColor: '' }, expectTotal: 18 },
    { tag: '带缝', options: { rows: 3, cols: 3, gap: 10, margin: 0, order: 'row', format: 'png', quality: 92, seamColor: '#ffffff' }, expectTotal: 18 },
    { tag: '四宫格', options: { rows: 2, cols: 2, gap: 0, margin: 0, order: 'column', format: 'png', quality: 92, seamColor: '' }, expectTotal: 8 }
  ];
  for (const c of cases) {
    try {
      const out = JSON.parse(await evalJs(sliceScript(c.tag, c.options, fixtures)));
      const onDisk = (await fs.readdir(TEST_DIR)).filter((f) => new RegExp(`^测试切图[AB]_${c.tag}_\\d+\\.png$`).test(f));
      const positionsOk = out.position.length > 0 && out.position.every((p) => p.ok);
      const needCorner = c.options.rows === 3 && c.options.cols === 3;
      const cornerOk = !needCorner || (Object.values(out.corner).length === 4 && Object.values(out.corner).every((x) => x.ok));
      const needSeam = c.options.gap > 0 && !!c.options.seamColor;
      const seamOk = !needSeam || (Object.values(out.seam).length >= 2 && Object.values(out.seam).every((x) => x.ok));
      const dimsOk = out.dims.length > 0 && out.dims.every((d) => d[0] === out.images[0].outW && d[1] === out.images[0].outH);
      const needPosition = c.options.gap === 0;
      out.ok = out.ok && onDisk.length === c.expectTotal && dimsOk
        && (!needPosition || positionsOk)
        && cornerOk
        && seamOk;
      out.onDisk = onDisk.length;
      out.expectTotal = c.expectTotal;
      result.cases[c.tag] = out;
    } catch (err) {
      result.cases[c.tag] = { ok: false, error: err.message };
    }
  }

  // —— 收尾清理（只删自己前缀的文件） ——
  result.checks.收尾清理 = await cleanFixtures();

  const keys = Object.keys(result.cases);
  result.summary = {
    夹具: !!(result.checks.夹具 && result.checks.夹具.ok),
    逻辑: !!(result.checks.逻辑 && result.checks.逻辑.ok),
    切图: keys.length === 3 && keys.every((k) => result.cases[k].ok),
    清理: result.checks.收尾清理.after.length === 0
  };
  result.ok = Object.values(result.summary).every(Boolean);
  writeResult({ ok: result.ok, at: new Date().toISOString(), result });
  return result;
}

// —— 界面自动测试 ——

async function runGridSliceUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [] };

  await fs.mkdir(TEST_DIR, { recursive: true });
  result.steps.清理 = await cleanFixtures();
  result.checks.清理 = { ...result.steps.清理, ok: result.steps.清理.after.length === 0 };

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-gs-${name}.png`);
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

  /** 等一次运行结束：进度条先出现、再收起（或状态文案变化） */
  async function waitForFinish(statusBefore, timeoutMs) {
    const t0 = Date.now();
    const readProgress = async () => JSON.parse(await evalJs(`JSON.stringify({
      status: document.getElementById("statusText").textContent,
      progressHidden: document.getElementById("progressBar").hidden
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
      await wait(200);
    }
    return { ok: false, status: last, timeout: true };
  }

  // —— 夹具（两张 300×300 四角纯色） ——
  try {
    const fixtures = JSON.parse(await evalJs(fixtureScript()));
    result.steps.fixtures = fixtures.map((p) => path.basename(p));
    result.checks.夹具 = { ok: fixtures.length === 2, files: result.steps.fixtures };
  } catch (err) {
    result.checks.夹具 = { ok: false, error: err.message };
  }

  await shot('01-起点');

  // —— 切工具（分组默认收起：先点开「图片」分组标题） ——
  result.steps.switch = JSON.parse(await evalJs(`(async () => {
    const item = document.querySelector('.tool-item[data-tool-id="grid-slice"]');
    if (!item) return JSON.stringify({ ok: false, reason: '左侧没有「九宫格切图」（registry.js 是否已注册？）' });
    const group = item.closest('.tool-group');
    const head = group ? group.querySelector('.tool-group-head') : null;
    let expanded = false;
    if (group && group.classList.contains('is-collapsed') && head) {
      head.click();
      expanded = true;
      await new Promise((r) => setTimeout(r, 500));
    }
    item.click();
    await new Promise((r) => setTimeout(r, 700));
    return JSON.stringify({ ok: document.querySelector('.gs-tool') !== null, expanded, group: group ? group.dataset.groupId : '' });
  })()`));
  await wait(500);
  await shot('02-切到九宫格切图');

  // —— 界面元素检查 ——
  result.checks.界面 = JSON.parse(await evalJs(`(() => {
    const preset = document.querySelector('#gsPreset');
    const order = document.querySelector('#gsOrder');
    const format = document.querySelector('#gsFormat');
    if (!preset || !order || !format) return JSON.stringify({ ok: false, reason: '参数控件缺失' });
    return JSON.stringify({
      ok: preset.options.length === 5 && preset.value === '3x3' && order.options.length === 2 && format.options.length === 2
        && !!document.querySelector('[data-add]') && !!document.querySelector('[data-run]'),
      presets: [...preset.options].map((o) => o.textContent),
      presetValue: preset.value
    });
  })()`));

  // —— 添加夹具 ——
  const before = new Set(await fs.readdir(TEST_DIR));
  result.steps.added = await clickSel('[data-add]');
  await wait(1800);
  result.checks.添加列表 = JSON.parse(await evalJs(`(() => {
    const items = [...document.querySelectorAll('#gsList .gs-item')];
    return JSON.stringify({
      ok: items.length === 2,
      count: items.length,
      names: items.map((li) => (li.querySelector('.gs-item-name') || {}).textContent || '')
    });
  })()`));

  // —— 选中一项看预览（网格线 + 块数/尺寸说明） ——
  result.steps.preview = JSON.parse(await evalJs(`(async () => {
    const item = document.querySelector('#gsList .gs-item');
    if (!item) return JSON.stringify({ ok: false, reason: '列表为空' });
    item.click();
    await new Promise((r) => setTimeout(r, 900));
    const canvas = document.querySelector('#gsCanvas');
    const info = document.querySelector('#gsPreviewInfo');
    const text = info ? info.textContent : '';
    return JSON.stringify({
      ok: !!canvas && !canvas.hidden && canvas.width > 0 && text.includes('9 块') && text.includes('100 × 100'),
      info: text, canvas: canvas ? [canvas.width, canvas.height] : null,
      selected: document.querySelectorAll('#gsList .gs-item.is-selected').length
    });
  })()`));
  await shot('03-已添加并预览');

  // —— 跑一轮（默认 3×3，两张图 → 18 个文件） ——
  const statusBefore = await getStatus();
  result.steps.ran = await clickSel('[data-run]');
  const finish = await waitForFinish(statusBefore, 180000);
  result.steps.finish = finish;
  await shot('04-切图完成');

  const after = await fs.readdir(TEST_DIR);
  const newFiles = after.filter((f) => !before.has(f) && /^测试切图[AB]_\d+\.png$/.test(f));
  const dims = JSON.parse(await evalJs(`(async () => {
    const files = ${JSON.stringify(newFiles)};
    const bad = [];
    for (const f of files) {
      const bytes = await window.desktop.readFile(${JSON.stringify(TEST_DIR)} + '\\\\' + f);
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      if (bmp.width !== 100 || bmp.height !== 100) bad.push([f, bmp.width, bmp.height]);
      bmp.close();
    }
    return JSON.stringify({ bad, count: files.length });
  })()`));

  result.checks.切图 = {
    finish,
    newFiles: newFiles.length,
    status: finish.status,
    wrongDims: dims.bad,
    ok: !!finish.ok && newFiles.length === 18 && dims.bad.length === 0
      && /成功 2 张/.test(finish.status) && /共输出 18 个文件/.test(finish.status)
      && newFiles.every((f) => fsSync.statSync(path.join(TEST_DIR, f)).size > 0)
  };

  // —— 清空 ——
  result.steps.cleared = await clickSel('[data-clear]');
  await wait(400);
  result.checks.清空 = JSON.parse(await evalJs(`(() => {
    const items = document.querySelectorAll('#gsList .gs-item').length;
    const dropHidden = document.getElementById('gsDrop').hidden;
    const canvasHidden = document.getElementById('gsCanvas').hidden;
    return JSON.stringify({ ok: items === 0 && dropHidden === false && canvasHidden === true, items, dropHidden, canvasHidden });
  })()`));
  await shot('05-已清空');

  // —— 收尾清理 ——
  result.checks.收尾清理 = await cleanFixtures();

  const keys = Object.keys(result.checks);
  result.pass = keys.length >= 6 && keys.every((k) => result.checks[k].ok === true)
    && result.steps.switch.ok === true && result.steps.added === true
    && result.steps.ran === true && result.steps.preview.ok === true;
  writeUiResult({ ok: !!result.pass, at: new Date().toISOString(), result });
  return result;
}

module.exports = { runGridSliceTest, runGridSliceUiTest, writeResult, writeUiResult, TEST_DIR, FIXTURE_PREFIX };