// 界面自动测试（仅 `electron . --ui-test` 时运行）
// 作用：像真人一样点按钮，走完整流程（选图 → 混淆 → 保存 → 还原 → 批量 → 清空），
//      每一步截图留证，并对结果做像素级校验。
// 说明：测试模式下「添加图片」对话框直接返回测试目录里的图片，避免需要人手动选文件。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { app } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 渲染进程内：读取预览画布并做简易校验和 */
const CANVAS_CHECKSUM = `(() => {
  const c = document.getElementById('previewCanvas');
  if (!c || c.hidden) return { ok: false, reason: '预览画布不可见' };
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 7) { h ^= d[i]; h = Math.imul(h, 16777619) >>> 0; }
  return { ok: true, w: c.width, h: c.height, sum: h };
})()`;

async function runUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [] };

  await fs.mkdir(TEST_DIR, { recursive: true });

  // 清理上次运行留下的测试图片，保证重复运行结果干净
  // 注意：要清掉「所有」以 测试原图 开头的文件（不限扩展名）——媒体工具测试会留下 .webp 等，
  //       它们同样会被「添加图片」选中，导致张数校验失败（踩过一次）。
  const existing = await fs.readdir(TEST_DIR).catch(() => []);
  for (const f of existing) {
    if (f.startsWith('测试原图')) {
      await fs.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
    }
  }

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

  // 0) 初始界面
  await shot('01-初始');
  result.steps.initialStatus = await evalJs('document.getElementById("statusText").textContent');
  // 元素显隐自检：进度遮罩必须默认隐藏（曾因 CSS 覆盖 hidden 导致整屏发白）
  result.checks.initialVisibility = await evalJs(`(() => {
    const shown = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return 'missing';
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && !el.hidden;
    };
    return {
      progress: shown('#progressBar'),
      thumbs: shown('#thumbStrip'),
      addButton: shown('#btnAddFirst'),
      modeControl: shown('#modeSelect')
    };
  })()`);

  // 1) 生成两张测试原图并落盘（走真实保存通道）
  const seedDir = TEST_DIR;
  result.steps.seed = await evalJs(`(async () => {
    const { encodeImageToBytes } = await import('../shared/imageio.js');
    const mk = async (w, h, name, tint) => {
      const px = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = (x + y * w) * 4;
        px[p] = Math.round((x / (w - 1)) * 255);
        px[p + 1] = Math.round((y / (h - 1)) * 255);
        px[p + 2] = ((x >> 4) + (y >> 4)) % 2 ? 200 : 80;
        px[p + 3] = 255;
        if (tint) { px[p] = 255 - px[p]; }
      }
      const bytes = await encodeImageToBytes(px, w, h, { format: 'png' });
      return window.desktop.saveImageNextTo({
        sourcePath: ${JSON.stringify(path.join(seedDir, 'seed.png'))},
        baseName: name, ext: '.png', bytes
      });
    };
    return [await mk(120, 80, '测试原图A', false), await mk(100, 50, '测试原图B', true)];
  })()`);

  // 2) 点击「添加图片」（测试模式下直接载入测试目录的图片）
  await evalJs('document.getElementById("btnAddFirst").click()');
  await wait(900);
  await shot('02-已载入图片');
  result.steps.afterAdd = await evalJs(`JSON.stringify({
    status: document.getElementById('statusText').textContent,
    thumbs: document.querySelectorAll('#thumbList .thumb').length,
    stripVisible: !document.getElementById('thumbStrip').hidden,
    info: document.getElementById('infoText').textContent
  })`);
  result.checks.originalCanvas = await evalJs(CANVAS_CHECKSUM);
  // 载入图片后：「添加图片」大按钮与进度遮罩都应隐藏，缩略图条应出现
  result.checks.afterAddVisibility = await evalJs(`(() => {
    const shown = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return 'missing';
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && !el.hidden;
    };
    return { addButton: shown('#btnAddFirst'), progress: shown('#progressBar'), thumbs: shown('#thumbStrip') };
  })()`);

  // 2.5) 页面状态保持：切到别的工具再切回来，已选图片/当前图预览/顶栏提示都不应丢或被重置
  result.checks.stateKeep = JSON.parse(await evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const nav = (id) => [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === id);
    const canvas = document.getElementById('previewCanvas');
    const before = {
      thumbs: document.querySelectorAll('#thumbList .thumb').length,
      canvasW: canvas.width,
      canvasH: canvas.height,
      status: document.getElementById('statusText').textContent
    };
    nav('compress').click();
    await wait(700);
    const away = {
      activePage: (document.querySelector('.tool-page.is-active') || { dataset: {} }).dataset.toolId || '',
      obfuscateDetached: !document.querySelector('.tool-page[data-tool-id="obfuscate"]')
    };
    nav('obfuscate').click();
    await wait(700);
    const back = {
      thumbs: document.querySelectorAll('#thumbList .thumb').length,
      canvasW: canvas.width,
      canvasH: canvas.height,
      status: document.getElementById('statusText').textContent
    };
    // 状态不只是「看得见」还要「还能用」：点一次「还原」，工具内部状态应照常响应
    document.querySelector('[data-action="revert"]').click();
    await wait(400);
    const afterAction = document.getElementById('statusText').textContent;
    return JSON.stringify({
      ok: before.thumbs === 2 && back.thumbs === before.thumbs
        && back.canvasW === before.canvasW && back.canvasH === before.canvasH
        && back.status === before.status
        && away.activePage === 'compress'
        && afterAction.includes('还原'),
      before, away, back, afterAction
    });
  })()`));
  await shot('02b-切走再切回');

  // 3) 切换到「像素混淆 (C)」并设置字符串密钥
  await evalJs(`(() => {
    const sel = document.getElementById('modeSelect');
    sel.value = 'c';
    sel.dispatchEvent(new Event('change'));
    const key = document.getElementById('keyInput');
    key.value = '测试密钥abc';
    key.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await wait(200);

  // 4) 点击「混淆」（当前图）
  await evalJs(`document.querySelector('[data-action="obfuscate"]').click()`);
  await wait(700);
  await shot('03-混淆后');
  result.steps.afterObfuscate = await evalJs('document.getElementById("statusText").textContent');
  result.checks.obfuscatedCanvas = await evalJs(CANVAS_CHECKSUM);
  result.checks.obfuscatedDiffers = result.checks.originalCanvas.sum !== result.checks.obfuscatedCanvas.sum;

  // 5) 点击「保存」（当前图）
  await evalJs(`document.querySelector('[data-action="save"]').click()`);
  await wait(1200);
  await shot('04-保存后');
  result.steps.afterSave = await evalJs('document.getElementById("statusText").textContent');
  result.steps.filesAfterSave = (await fs.readdir(TEST_DIR)).filter((f) => f.startsWith('测试原图A')).sort();

  // 6) 点击「还原」→ 应回到原图
  await evalJs(`document.querySelector('[data-action="revert"]').click()`);
  await wait(400);
  await shot('05-还原后');
  result.checks.revertedCanvas = await evalJs(CANVAS_CHECKSUM);
  result.checks.revertEqualsOriginal = result.checks.revertedCanvas.sum === result.checks.originalCanvas.sum;

  // 7) 全部混淆 + 全部保存（批量）
  await evalJs(`document.querySelector('[data-action="batch-obfuscate"]').click()`);
  await wait(900);
  result.steps.afterBatchObfuscate = await evalJs('document.getElementById("statusText").textContent');
  await evalJs(`document.querySelector('[data-action="batch-save"]').click()`);
  await wait(1600);
  result.steps.afterBatchSave = await evalJs('document.getElementById("statusText").textContent');
  await shot('06-批量保存后');
  result.steps.allFiles = (await fs.readdir(TEST_DIR)).filter((f) => f.endsWith('.png') || f.endsWith('.jpg')).sort();

  // 8) 校验保存出来的文件能被解回原图（像素级）
  const savedA = result.steps.filesAfterSave.find((f) => f.includes('_混淆')) || '';
  result.checks.decodeSavedFile = await evalJs(`(async () => {
    const { decodeImageFromBytes } = await import('../shared/imageio.js');
    const { processPixels } = await import('../tools/obfuscate/core/engine.js');
    const bytes = await window.desktop.readFile(${JSON.stringify(path.join(TEST_DIR, savedA || ''))});
    const img = await decodeImageFromBytes(bytes);
    const back = processPixels({ mode: 'c', key: '测试密钥abc', direction: 'decrypt', width: img.width, height: img.height, pixels: img.pixels });
    let h = 2166136261;
    for (let i = 0; i < back.pixels.length; i += 7) { h ^= back.pixels[i]; h = Math.imul(h, 16777619) >>> 0; }
    return { file: ${JSON.stringify(savedA)}, w: back.width, h: back.height, sum: h };
  })()`);

  // 9) gilbert 模式：密钥行应隐藏；PE1：密钥行显示且提示小数
  result.checks.keyRowByMode = await evalJs(`(() => {
    const sel = document.getElementById('modeSelect');
    const row = document.getElementById('keyRow');
    const hint = document.getElementById('keyHint');
    const out = {};
    sel.value = 'gilbert'; sel.dispatchEvent(new Event('change'));
    out.gilbertHidden = row.hidden;
    sel.value = 'pe1'; sel.dispatchEvent(new Event('change'));
    out.pe1Hidden = row.hidden;
    out.pe1Hint = hint.textContent;
    out.pe1Value = document.getElementById('keyInput').value;
    return out;
  })()`);
  await shot('07-切到PE1模式');

  // 10) 设置面板：打开 → 改 JPG 画质 → 保存 → 校验落盘 → 恢复默认
  await evalJs('document.getElementById("btnSettings").click()');
  await wait(300);
  await shot('09-设置面板');
  result.checks.settingsModal = await evalJs(`(() => ({
    open: !!document.querySelector('.modal-backdrop'),
    title: document.querySelector('.modal-title') ? document.querySelector('.modal-title').textContent : '',
    missingFields: ['#setBlockSize','#setJpegQuality','#setDefaultKey','#setOutputDir','#setAskSavePath']
      .filter((s) => !document.querySelector(s))
  }))()`);

  // 输出目录：点「选择文件夹…」应弹出系统选择框并把路径填进输入框（测试模式下返回测试目录）
  result.steps.outputDirPick = await evalJs(`(async () => {
    document.querySelector('#setOutputDirPick').click();
    await new Promise((r) => setTimeout(r, 700));
    return document.querySelector('#setOutputDir').value + '｜' + document.getElementById('statusText').textContent;
  })()`);

  const settingsFile = path.join(
    app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..'),
    'userdata',
    'settings.json'
  );
  result.steps.settingsSave = await evalJs(`(async () => {
    document.querySelector('#setJpegQuality').value = '90';
    [...document.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === '保存').click();
    await new Promise((r) => setTimeout(r, 400));
    return document.getElementById('statusText').textContent;
  })()`);
  try {
    result.checks.settingsFileAfterSave = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  } catch (err) {
    result.checks.settingsFileAfterSave = { error: err.message };
  }

  // 恢复默认（保持开发环境干净）
  await evalJs('document.getElementById("btnSettings").click()');
  await wait(250);
  result.steps.settingsReset = await evalJs(`(async () => {
    [...document.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent.includes('恢复默认')).click();
    await new Promise((r) => setTimeout(r, 700));
    const status = document.getElementById('statusText').textContent;
    const closeBtn = [...document.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === '取消');
    if (closeBtn) closeBtn.click();
    // 关闭带一小段淡出动画（约 120ms）后移除，这里等足再数剩余弹窗
    await new Promise((r) => setTimeout(r, 500));
    return status + '｜剩余弹窗数=' + document.querySelectorAll('.modal-backdrop').length;
  })()`);
  try {
    result.checks.settingsFileAfterReset = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  } catch (err) {
    result.checks.settingsFileAfterReset = { error: err.message };
  }

  // 11) 帮助弹窗
  await evalJs('document.getElementById("btnHelp").click()');
  await wait(300);
  await shot('10-帮助');
  result.checks.helpModal = await evalJs(`(() => {
    const modals = document.querySelectorAll('.modal-backdrop');
    const backdrop = modals[modals.length - 1];   // 取最新打开的弹窗
    const title = backdrop ? backdrop.querySelector('.modal-title').textContent : '';
    const sections = backdrop ? backdrop.querySelectorAll('.help-section').length : 0;
    const closeBtn = backdrop ? [...backdrop.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === '知道了') : null;
    if (closeBtn) closeBtn.click();
    return { open: !!backdrop, title, sections, modalCount: modals.length };
  })()`);
  await wait(200);

  // 12) 批量与容错：20 张正常 + 1 张损坏文件
  // 先清掉此前产生的测试图片，保证目录里只有本轮样本
  for (const f of await fs.readdir(TEST_DIR)) {
    if (f.startsWith('测试原图')) await fs.rm(path.join(TEST_DIR, f), { force: true });
  }
  await evalJs(`(async () => {
    const { encodeImageToBytes } = await import('../shared/imageio.js');
    for (let i = 1; i <= 20; i++) {
      const w = 16 + (i % 5), h = 12 + (i % 4);
      const px = new Uint8ClampedArray(w * h * 4);
      for (let p = 0; p < w * h; p++) { px[p * 4] = (p * 13 + i) & 255; px[p * 4 + 1] = (p * 7) & 255; px[p * 4 + 2] = i * 5 & 255; px[p * 4 + 3] = 255; }
      const bytes = await encodeImageToBytes(px, w, h, { format: 'png' });
      await window.desktop.saveImageNextTo({ sourcePath: ${JSON.stringify(path.join(TEST_DIR, 'seed.png'))}, baseName: '测试原图批量' + String(i).padStart(2, '0'), ext: '.png', bytes });
    }
    // 1 张损坏文件（扩展名冒充 png）
    const bad = new TextEncoder().encode('这不是图片');
    await window.desktop.saveImageNextTo({ sourcePath: ${JSON.stringify(path.join(TEST_DIR, 'seed.png'))}, baseName: '测试原图批量21损坏', ext: '.png', bytes: bad });
    return true;
  })()`);

  await evalJs('(() => { window.confirm = () => true; return true; })()');
  await evalJs(`document.querySelector('[data-action="batch-clear"]').click()`);
  await wait(300);
  await evalJs('document.getElementById("btnAddFirst").click()');
  await wait(3000);
  result.steps.batchAdd = await evalJs(`JSON.stringify({
    status: document.getElementById('statusText').textContent,
    thumbs: document.querySelectorAll('#thumbList .thumb').length
  })`);

  await evalJs(`document.querySelector('[data-action="batch-obfuscate"]').click()`);
  await wait(2500);
  result.steps.batchObfuscate20 = await evalJs('document.getElementById("statusText").textContent');
  await shot('11-批量20张');
  await evalJs(`document.querySelector('[data-action="batch-save"]').click()`);
  await wait(3000);
  result.steps.batchSave20 = await evalJs('document.getElementById("statusText").textContent');
  result.steps.batchSavedFiles = (await fs.readdir(TEST_DIR)).filter((f) => f.includes('_混淆')).length;

  // 13) 清空（确认框自动确认）
  await evalJs('(() => { window.confirm = () => true; return true; })()');
  await evalJs(`document.querySelector('[data-action="batch-clear"]').click()`);
  await wait(400);
  await shot('08-清空后');
  result.steps.afterClear = await evalJs('document.getElementById("statusText").textContent');
  result.checks.clearedThumbs = await evalJs('document.querySelectorAll("#thumbList .thumb").length');

  // 14) LRU 回收：切过 5 个以上工具后，最久没用过的页面会被释放（当前页不释放）
  //     做法：给图片混淆重新载入图片 → 依次切 5 个别的工具（保活页数超上限）→ 切回来
  //     期望：图片列表已被释放（回到空状态 + 提示「已自动释放」），说明内存被回收了
  await evalJs('document.getElementById("btnAddFirst").click()');
  await wait(3000);
  result.checks.lruRelease = JSON.parse(await evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const nav = (id) => [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === id);
    const before = { thumbs: document.querySelectorAll('#thumbList .thumb').length };
    for (const id of ['compress', 'enhance', 'img-convert', 'video-convert', 'audio-convert']) {
      nav(id).click();
      await wait(600);
    }
    nav('obfuscate').click();
    await wait(800);
    const after = {
      thumbs: document.querySelectorAll('#thumbList .thumb').length,
      addButtonShown: !document.getElementById('btnAddFirst').hidden,
      stripHidden: document.getElementById('thumbStrip').hidden,
      status: document.getElementById('statusText').textContent
    };
    return JSON.stringify({
      ok: before.thumbs > 0 && after.thumbs === 0 && after.addButtonShown === true
        && after.stripHidden === true && after.status.includes('自动释放'),
      before, after
    });
  })()`));
  await shot('12-LRU回收后');

  // 汇总判定
  const c = result.checks;
  result.pass =
    result.steps.afterAdd.includes('已添加') &&
    c.initialVisibility.progress === false &&
    c.initialVisibility.thumbs === false &&
    c.initialVisibility.addButton === true &&
    c.afterAddVisibility.addButton === false &&
    c.afterAddVisibility.progress === false &&
    c.afterAddVisibility.thumbs === true &&
    c.stateKeep.ok === true &&
    c.obfuscatedDiffers === true &&
    c.revertEqualsOriginal === true &&
    result.steps.filesAfterSave.length >= 1 &&
    result.steps.afterBatchObfuscate.includes('成功 2 张') &&
    c.decodeSavedFile.sum === c.originalCanvas.sum &&
    c.keyRowByMode.gilbertHidden === true &&
    c.keyRowByMode.pe1Hidden === false &&
    c.settingsModal.open === true &&
    c.settingsModal.missingFields.length === 0 &&
    c.settingsFileAfterSave.jpegQuality === 90 &&
    c.settingsFileAfterSave.outputDir === TEST_DIR &&
    result.steps.outputDirPick.startsWith(TEST_DIR) &&
    c.settingsFileAfterReset.jpegQuality === 95 &&
    result.steps.settingsReset.includes('剩余弹窗数=0') &&
    c.helpModal.open === true &&
    c.helpModal.title === '使用帮助' &&
    c.helpModal.sections >= 3 &&
    c.helpModal.modalCount === 1 &&
    JSON.parse(result.steps.batchAdd).status.includes('已添加 20 张图片') &&
    JSON.parse(result.steps.batchAdd).status.includes('1 张失败') &&
    JSON.parse(result.steps.batchAdd).thumbs === 20 &&
    result.steps.batchObfuscate20.includes('成功 20 张') &&
    result.steps.batchSave20.includes('成功 20 张') &&
    result.steps.batchSavedFiles >= 20 &&
    c.clearedThumbs === 0 &&
    c.lruRelease.ok === true;

  return result;
}

module.exports = { runUiTest, TEST_DIR };