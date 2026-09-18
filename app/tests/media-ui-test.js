// 媒体工具界面自动测试（仅 `electron . --media-ui-test` 时运行）
// 覆盖 5 个新工具：图片压缩 / 图片变清晰 / 图片格式转换 / 视频格式转换 / 动图与视频互转。
// 做法：像真人一样「切工具 → 点添加（测试模式下对话框直接返回夹具）→ 点运行 → 等完成」，
//      每步截图，并对比运行前后测试目录的新增文件、用 ffmpeg 校验媒体产物能否正常解码。
// 结果写入 %TEMP%/tomato-media-ui-test.json，截图落在 %TEMP%/tomato-uitest。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawnSync } = require('child_process');
const { app } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-media-ui-test.json');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 与主进程一致的 ffmpeg 探测（加装包优先，其次系统 PATH） */
function findFfmpeg() {
  const base = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
  const addon = path.join(base, 'addons', 'ffmpeg', 'ffmpeg.exe');
  if (fsSync.existsSync(addon)) return addon;
  try {
    const r = spawnSync('where', ['ffmpeg'], { windowsHide: true, encoding: 'utf8' });
    if (r.status === 0) {
      const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fsSync.existsSync(first)) return first;
    }
  } catch { /* 未安装 */ }
  return null;
}

function writeResult(payload) {
  fsSync.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

/** 用 ffmpeg 完整解码一遍（校验产物是有效媒体文件，而不只是「有字节」） */
function decodeCheck(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], {
    windowsHide: true, encoding: 'utf8', timeout: 120000
  });
  return { ok: r.status === 0, error: String(r.stderr || '').trim().slice(0, 200) };
}

/** 造测试媒体夹具（ffmpeg 的 lavfi 测试图，无需外部素材） */
function makeFixtures(ffmpeg) {
  const made = [];
  const run = (args, name) => {
    const r = spawnSync(ffmpeg, args, { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    made.push({ name, ok: r.status === 0, error: r.status === 0 ? '' : String(r.stderr || '').slice(-200) });
  };
  run(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15', '-pix_fmt', 'yuv420p',
    path.join(TEST_DIR, '测试视频A.mp4')], '测试视频A.mp4');
  run(['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=240x180:rate=12', '-pix_fmt', 'yuv420p',
    path.join(TEST_DIR, '测试视频B.mp4')], '测试视频B.mp4');
  run(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10', '-loop', '0',
    path.join(TEST_DIR, '测试动图A.gif')], '测试动图A.gif');
  return made;
}

async function runMediaUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [], tools: {} };
  const ffmpeg = findFfmpeg();
  result.ffmpeg = { found: !!ffmpeg, path: ffmpeg };

  await fs.mkdir(TEST_DIR, { recursive: true });

  // —— 清理上次夹具（图片夹具也一起清：本测试只认「测试原图C」，历次副本会让列表膨胀） ——
  for (const f of await fs.readdir(TEST_DIR)) {
    if (/^测试视频|^测试动图|^测试原图/.test(f)) {
      await fs.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
    }
  }

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-${name}.png`);
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

  // —— 夹具：视频与动图（ffmpeg）、一张用于压缩/增强/转换的图片（渲染进程生成） ——
  if (ffmpeg) {
    result.steps.fixtures = makeFixtures(ffmpeg);
  } else {
    result.steps.fixtures = [{ ok: false, error: '未检测到 ffmpeg，视频类夹具未生成' }];
  }
  await evalJs(`(async () => {
    const { encodeImageToBytes } = await import('../shared/imageio.js');
    const w = 640, h = 420;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (x + y * w) * 4;
      px[p] = Math.round((x / (w - 1)) * 255);
      px[p + 1] = Math.round((y / (h - 1)) * 255);
      px[p + 2] = ((x >> 3) + (y >> 3)) % 2 ? 190 : 70;
      px[p + 3] = 255;
    }
    const bytes = await encodeImageToBytes(px, w, h, { format: 'png' });
    return window.desktop.saveImageNextTo({
      sourcePath: ${JSON.stringify(path.join(TEST_DIR, 'seed.png'))},
      baseName: '测试原图C', ext: '.png', bytes
    });
  })()`);

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
      if (o.status !== statusBefore && o.progressHidden) {
        return { ok: true, status: o.status, ms: Date.now() - t0 };
      }
      await wait(500);
    }
    return { ok: false, status: last, timeout: true };
  }

  /** 跑一个工具：切过去 → 添加 → 运行 → 校验新增产物 */
  async function runTool(name, { expectMedia = false, timeoutMs = 180000, setup = '' } = {}) {
    const entry = { tool: name };
    const before = new Set(await fs.readdir(TEST_DIR));

    entry.switched = await clickTool(name);
    await wait(400);
    if (!entry.switched) {
      entry.error = '左侧没有找到该工具';
      result.tools[name] = entry;
      return entry;
    }

    entry.added = await clickSel('[data-add]');
    await wait(1800); // 等列表加载（含解码/探测）
    if (setup) {
      entry.setup = await evalJs(setup);
      await wait(300);
    }
    entry.addStatus = await getStatus();

    entry.ran = await clickSel('[data-run]');
    const finish = await waitForFinish(entry.addStatus, timeoutMs);
    entry.finish = finish;
    await shot(`10-${name}`);

    const after = await fs.readdir(TEST_DIR);
    entry.newFiles = after.filter((f) => !before.has(f));

    // 产物校验：媒体类要求 ffmpeg 能完整解码
    entry.checks = entry.newFiles.map((f) => {
      const full = path.join(TEST_DIR, f);
      let bytes = 0;
      try { bytes = fsSync.statSync(full).size; } catch { /* 忽略 */ }
      const isMedia = /\.(mp4|webm|mkv|mov|avi|gif|webp)$/i.test(f);
      const check = { file: f, bytes, isMedia };
      if (isMedia && ffmpeg && bytes > 0) check.decode = decodeCheck(ffmpeg, full);
      return check;
    });

    entry.ok = !!entry.switched && entry.ran && finish.ok && entry.newFiles.length > 0;
    if (expectMedia) {
      const mediaOk = entry.checks.some((c) => c.isMedia && c.decode && c.decode.ok);
      entry.ok = entry.ok && mediaOk;
    }
    result.tools[name] = entry;
    return entry;
  }

  await shot('01-媒体测试起点');

  // —— 图片类三个工具（无需 ffmpeg） ——
  // 压缩工具先切成 WebP：默认「保持原格式」在 PNG 上几乎压不动，切 WebP 才能体现压缩效果
  await runTool('图片压缩', {
    timeoutMs: 120000,
    setup: `(() => { const s = document.querySelector('#cmpFormat'); if (!s) return false; s.value = 'webp'; s.dispatchEvent(new Event('change')); return true; })()`
  });
  await runTool('图片变清晰', { timeoutMs: 180000 });
  await runTool('图片格式转换', { timeoutMs: 180000 });

  // —— 视频类两个工具（需要 ffmpeg 加装包） ——
  if (ffmpeg) {
    await runTool('视频格式转换', { expectMedia: true, timeoutMs: 300000 });
    await runTool('动图与视频互转', { expectMedia: true, timeoutMs: 300000 });
  } else {
    for (const name of ['视频格式转换', '动图与视频互转']) {
      await clickTool(name);
      await wait(400);
      const hint = await evalJs(`document.body.innerText.includes('ffmpeg')`);
      result.tools[name] = { tool: name, skipped: true, reason: '未检测到 ffmpeg', showsHint: hint };
    }
  }

  // —— 侧栏分组自检：大类带图标、点一下收起、再点一下展开 ——
  result.checks.分组折叠 = JSON.parse(await evalJs(`(async () => {
    const head = document.querySelector('.tool-group-head[data-group-id="image"]');
    if (!head) return JSON.stringify({ ok: false, reason: '左侧没有找到「图片」分组标题' });
    const wrap = head.closest('.tool-group');
    const items = wrap.querySelector('.tool-group-items');
    const before = { collapsed: wrap.classList.contains('is-collapsed'), tools: wrap.querySelectorAll('.tool-item').length, display: getComputedStyle(items).display };
    head.click(); await new Promise((r) => setTimeout(r, 150));
    const collapsed = { collapsed: wrap.classList.contains('is-collapsed'), display: getComputedStyle(items).display };
    head.click(); await new Promise((r) => setTimeout(r, 150));
    const expanded = { collapsed: wrap.classList.contains('is-collapsed'), display: getComputedStyle(items).display };
    const icons = [...document.querySelectorAll('.tool-group-head')].map((h) => (h.querySelector('.tool-group-icon') || {}).textContent || '');
    return JSON.stringify({
      ok: !before.collapsed && before.display !== 'none' && before.tools >= 4
        && collapsed.collapsed && collapsed.display === 'none'
        && !expanded.collapsed && expanded.display !== 'none'
        && icons.length >= 3 && icons.every((t) => t.trim().length > 0),
      before, collapsed, expanded, icons
    });
  })()`));

  // —— AI 放大预设自检：预设存在、选中后出现「加装包状态 + 硬件要求（Vulkan）」提示 ——
  result.checks.AI预设 = JSON.parse(await evalJs(`(async () => {
    const btn = [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.textContent.includes('图片变清晰'));
    if (!btn) return JSON.stringify({ ok: false, reason: '没有找到图片变清晰工具' });
    btn.click(); await new Promise((r) => setTimeout(r, 700));
    const sel = document.querySelector('#enhPreset');
    if (!sel) return JSON.stringify({ ok: false, reason: '没有找到预设下拉框' });
    const opts = [...sel.options].map((o) => o.textContent);
    const aiOpt = [...sel.options].find((o) => /AI 放大/.test(o.textContent));
    if (!aiOpt) return JSON.stringify({ ok: false, reason: '没有 AI 放大预设', opts });
    sel.value = aiOpt.value;
    sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 900));
    const note = document.querySelector('#enhAiNote');
    const text = note ? note.textContent : '';
    // 装了加装包会提示 Vulkan 要求；没装会提示未检测到——两种都算提示到位
    const shown = !!note && !note.hidden && /Vulkan|未检测到/.test(text);
    return JSON.stringify({ ok: shown, preset: aiOpt.textContent, note: text.slice(0, 200) });
  })()`));

  // —— 汇总 ——
  result.checks.工具清单 = await evalJs(`[...document.querySelectorAll('#toolNav .tool-item')].map((b) => b.textContent.trim())`);
  const entries = Object.values(result.tools);
  result.pass = entries.length >= 3 && entries.every((e) => e.ok || e.skipped)
    && !!result.checks.分组折叠 && result.checks.分组折叠.ok
    && !!result.checks.AI预设 && result.checks.AI预设.ok;
  await shot('99-媒体测试结束');

  // —— 收尾清理：删掉本测试的夹具与产物，避免污染图片混淆/PDF 等其它测试的夹具目录 ——
  // （产物清单与大小已记进 result.tools[*].newFiles，证据不受影响）
  try {
    for (const f of await fs.readdir(TEST_DIR)) {
      if (/^测试视频|^测试动图|^测试原图C/.test(f)) {
        await fs.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
      }
    }
  } catch { /* 清理失败不影响结论 */ }

  return result;
}

module.exports = { runMediaUiTest, writeResult, TEST_DIR };