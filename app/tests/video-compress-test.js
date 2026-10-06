// 视频压缩工具自检（仅 `electron . --av-test` 时运行）
// 覆盖：core/plan.js 纯函数单测（码率反推数学、达标判定边界、降档下限、文案函数）、
//       真实转码「画质档压缩」与「目标体积压缩（两遍编码 + 不达标自动降码率重跑）」，
//       产物用 ffmpeg 完整解码并回读时长/分辨率/体积。
// 说明：通过 window.desktop.* 走真实 IPC 链路（与界面点按钮同一条路）。
// 结果写入 %TEMP%/tomato-video-compress-test.json，同时打印 VIDEO_COMPRESS_TEST {...}。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawnSync } = require('child_process');
const { app } = require('electron');

// 与其它界面测试共用夹具目录；本测试只碰「测试压缩视频」开头的文件
const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-video-compress-test.json');
const UI_RESULT_FILE = path.join(os.tmpdir(), 'tomato-video-compress-ui-test.json');
const FIXTURE_PREFIX = '测试压缩视频';

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

function writeUiResult(payload) {
  fsSync.writeFileSync(UI_RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

/** ffmpeg 完整解码一遍（校验产物确实是有效媒体文件，而不只是「有字节」） */
function decodeCheck(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], {
    windowsHide: true, encoding: 'utf8', timeout: 120000
  });
  return { ok: r.status === 0, error: String(r.stderr || '').trim().slice(0, 200) };
}

/** 读媒体信息（时长/分辨率），用于「确实转出了正确的东西」的交叉校验（静态包无 ffprobe，用 ffmpeg -i） */
function probeByFfmpeg(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  const err = String(r.stderr || '');
  const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  const size = /Video: .*?, (\d{2,5})x(\d{2,5})/.exec(err);
  return {
    durationSec: dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : 0,
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0
  };
}

function fileSize(file) {
  try { return fsSync.statSync(file).size; } catch { return 0; }
}

/**
 * 清理本测试的夹具/产物（开跑清一次、收尾清一次，且清所有扩展名）。
 * 只删「测试压缩视频」开头的文件，绝不误删其它界面测试的夹具。
 */
async function cleanFixtures() {
  const before = (await fs.readdir(TEST_DIR).catch(() => [])).filter((f) => f.startsWith(FIXTURE_PREFIX));
  for (const f of before) {
    await fs.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
  }
  return before;
}

/** 造自检夹具：720p 高码率 + 音轨（体积足够大，压缩才有意义） */
function makeCoreFixtures(ffmpeg) {
  const made = [];
  const run = (args, name) => {
    const r = spawnSync(ffmpeg, args, { windowsHide: true, encoding: 'utf8', timeout: 180000 });
    made.push({ name, ok: r.status === 0, error: r.status === 0 ? '' : String(r.stderr || '').slice(-200) });
  };
  run(['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '4000k', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest',
    path.join(TEST_DIR, `${FIXTURE_PREFIX}源A.mp4`)], `${FIXTURE_PREFIX}源A.mp4`);
  return made;
}

/** 造界面测试夹具：稍长一点、体积够大，目标体积模式才有压缩空间 */
function makeUiFixture(ffmpeg) {
  const r = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=10:size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '6000k', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest',
    path.join(TEST_DIR, `${FIXTURE_PREFIX}界面A.mp4`)], { windowsHide: true, encoding: 'utf8', timeout: 180000 });
  return { name: `${FIXTURE_PREFIX}界面A.mp4`, ok: r.status === 0, error: r.status === 0 ? '' : String(r.stderr || '').slice(-200) };
}

// —— 1) 纯逻辑 + 2) 真实转码 ——

async function runVideoCompressTest(win) {
  const evalJs = (code) => win.webContents.executeJavaScript(code);
  const result = { ok: false, checks: {}, steps: {}, notes: [] };
  const ffmpeg = findFfmpeg();
  result.ffmpeg = { found: !!ffmpeg, path: ffmpeg || '' };

  await fs.mkdir(TEST_DIR, { recursive: true });
  result.steps.清理开跑前 = await cleanFixtures();

  // —— 1) core/plan.js 纯函数单测（渲染进程内动态 import，纯逻辑，不碰 ffmpeg） ——
  try {
    const out = JSON.parse(await evalJs(`(async () => {
      const out = {};
      const { VIDEO_EXTS, buildPlan, verifyTarget, retryBitrate, formatSize, formatDuration, formatMeta, baseNameOf } =
        await import('../tools/video-compress/core/plan.js');
      const { planTargetBitrate } = await import('../shared/ffmpeg.js');

      out.extCount = VIDEO_EXTS.length;
      out.extHasMp4 = VIDEO_EXTS.includes('.mp4');
      out.extHasMkv = VIDEO_EXTS.includes('.mkv');

      const item = { width: 1280, height: 720, durationSec: 6, hasAudio: true };
      const q = buildPlan(item, { mode: 'quality', quality: 'small', height: 720, mute: false });
      out.quality = { mode: q.mode, ext: q.ext, durationMs: q.durationMs, args: q.args.join(' ') };
      const qMute = buildPlan(item, { mode: 'quality', quality: 'high', height: 0, mute: true });
      out.qualityMute = qMute.args.join(' ');

      const s = buildPlan(item, { mode: 'size', targetMB: 1.5, audioKbps: 96 });
      out.size = { mode: s.mode, ext: s.ext, videoKbps: s.videoKbps, durationMs: s.durationMs,
        pass1: s.pass1Args.join(' '), pass2: s.pass2Args.join(' ') };
      const sMute = buildPlan(item, { mode: 'size', targetMB: 1.5, audioKbps: 96, mute: true });
      out.sizeMute = sMute.pass2Args.join(' ');
      const sOverride = buildPlan(item, { mode: 'size', targetMB: 1.5, audioKbps: 96, videoKbps: 850 });
      out.sizeOverride = { videoKbps: sOverride.videoKbps, pass1: sOverride.pass1Args.join(' ') };

      out.bitrate = [
        planTargetBitrate({ durationSec: 6, targetMB: 1.5, audioKbps: 96 }),
        planTargetBitrate({ durationSec: 0, targetMB: 10, audioKbps: 96 }),
        planTargetBitrate({ durationSec: 6, targetMB: 0.001, audioKbps: 128 })
      ];
      const targetBytes = 1.5 * 1024 * 1024;
      out.verify = [
        verifyTarget({ sizeBytes: Math.round(targetBytes * 1.04), targetMB: 1.5 }),
        verifyTarget({ sizeBytes: Math.round(targetBytes * 1.06), targetMB: 1.5 }),
        verifyTarget({ sizeBytes: Math.round(targetBytes * 1.04), targetMB: 1.5, tolerance: 0.02 })
      ];
      out.retry = [retryBitrate({ videoKbps: 1000 }), retryBitrate({ videoKbps: 55 }), retryBitrate({ videoKbps: 0 })];
      out.text = [
        formatSize(0), formatSize(1536), formatDuration(65), formatDuration(0),
        formatMeta({ durationSec: 65, width: 1280, height: 720, hasAudio: true, sizeBytes: 2 * 1024 * 1024 }),
        baseNameOf('C:\\\\a\\\\b\\\\${FIXTURE_PREFIX}源A.mp4')
      ];
      return JSON.stringify(out);
    })()`));

    const ok = out.extCount >= 10 && out.extHasMp4 && out.extHasMkv
      // 画质档：单遍、MP4、libx264/crf、缩放按分辨率档
      && out.quality.mode === 'single' && out.quality.ext === '.mp4' && out.quality.durationMs === 6000
      && out.quality.args.includes('libx264') && out.quality.args.includes('-crf 28')
      && out.quality.args.includes('scale=1280:720') && out.quality.args.includes('-c:a aac') && out.quality.args.includes('+faststart')
      // 画质档 + 去掉声音
      && out.qualityMute.includes('-an') && !out.qualityMute.includes('-c:a')
      // 目标体积：两遍、固定 mp4、码率与两遍参数
      && out.size.mode === 'twoPass' && out.size.ext === '.mp4' && out.size.durationMs === 6000
      && out.size.videoKbps === 1893
      && out.size.pass1.includes('-b:v 1893k') && out.size.pass1.includes('-an') && !out.size.pass1.includes('aac')
      && out.size.pass2.includes('-b:v 1893k') && out.size.pass2.includes('-c:a aac') && out.size.pass2.includes('-b:a 96k')
      && out.size.pass2.includes('+faststart')
      // 去掉声音 → 第二遍也 -an
      && out.sizeMute.includes('-an') && !out.sizeMute.includes('aac')
      // videoKbps 覆盖（降码率重跑用）
      && out.sizeOverride.videoKbps === 850 && out.sizeOverride.pass1.includes('-b:v 850k')
      // 码率反推数学
      && out.bitrate[0] === 1893 && out.bitrate[1] === 800 && out.bitrate[2] === 50
      // 达标判定边界（容差 5%）
      && out.verify[0].ok === true && out.verify[0].overBy > 0
      && out.verify[1].ok === false && out.verify[1].overBy > out.verify[0].overBy
      && out.verify[2].ok === false && out.verify[2].overBy > 0
      // 降档码率与下限
      && out.retry[0] === 850 && out.retry[1] === 50 && out.retry[2] === 50
      // 文案
      && out.text[0] === '0 KB' && out.text[1] === '1.5 KB'
      && out.text[2] === '01:05' && out.text[3] === '--:--'
      && out.text[4] === '01:05 ｜ 1280×720 ｜ 含声音 ｜ 2.00 MB'
      && out.text[5] === `${FIXTURE_PREFIX}源A.mp4`;
    result.checks.plan = { ...out, ok };
  } catch (err) {
    result.checks.plan = { ok: false, error: err.message };
  }

  // —— 2) 真实转码（走真实 IPC，与界面同一条路） ——
  result.checks.quality = { ok: false };
  result.checks.size = { ok: false };
  if (!ffmpeg) {
    result.checks.quality.error = '未检测到 ffmpeg';
    result.checks.size.error = '未检测到 ffmpeg';
    writeResult({ ok: false, at: new Date().toISOString(), result });
    return result;
  }

  result.steps.fixtures = makeCoreFixtures(ffmpeg);
  const srcA = path.join(TEST_DIR, `${FIXTURE_PREFIX}源A.mp4`);
  const srcSize = fileSize(srcA);
  result.steps.sourceSize = srcSize;
  if (srcSize <= 0) {
    result.checks.quality.error = '夹具生成失败';
    result.checks.size.error = '夹具生成失败';
    result.steps.清理收尾 = await cleanFixtures();
    writeResult({ ok: false, at: new Date().toISOString(), result });
    return result;
  }

  // 2a) 画质档压缩（单遍 CRF）
  try {
    const raw = JSON.parse(await evalJs(`(async () => {
      const { buildPlan } = await import('../tools/video-compress/core/plan.js');
      const item = { width: 1280, height: 720, durationSec: 6, hasAudio: true };
      const plan = buildPlan(item, { mode: 'quality', quality: 'small', height: 0, mute: false });
      const r = await window.desktop.ffmpegConvert({
        inputPath: ${JSON.stringify(srcA)},
        outputDir: ${JSON.stringify(TEST_DIR)},
        baseName: '${FIXTURE_PREFIX}画质',
        ext: plan.ext, args: plan.args, durationMs: plan.durationMs, jobId: 'vcomp-core-quality'
      });
      return JSON.stringify({ plan: { mode: plan.mode, args: plan.args.join(' ') }, result: r });
    })()`));
    const r = raw.result || {};
    const entry = { plan: raw.plan, result: { ok: r.ok, path: r.path, size: r.size, ms: r.ms } };
    if (r.ok && r.path) {
      entry.decode = decodeCheck(ffmpeg, r.path);
      entry.info = probeByFfmpeg(ffmpeg, r.path);
      entry.shrunk = r.size < srcSize;
      entry.ratio = srcSize > 0 ? Number((r.size / srcSize).toFixed(3)) : 0;
      entry.ok = entry.decode.ok && entry.shrunk && entry.info.durationSec > 4 && entry.info.durationSec < 8
        && entry.info.width === 1280 && entry.info.height === 720;
    } else {
      entry.ok = false;
      entry.error = r.message || '转码失败';
    }
    result.checks.quality = entry;
  } catch (err) {
    result.checks.quality = { ok: false, error: err.message };
  }

  // 2b) 目标体积压缩（两遍编码；不达标自动降码率重跑一次，与界面同逻辑）
  try {
    const raw = JSON.parse(await evalJs(`(async () => {
      const { buildPlan, verifyTarget, retryBitrate } = await import('../tools/video-compress/core/plan.js');
      const item = { width: 1280, height: 720, durationSec: 6, hasAudio: true };
      const params = { mode: 'size', targetMB: 1.5, audioKbps: 96 };
      const first = buildPlan(item, params);
      const r1 = await window.desktop.ffmpegConvertTwoPass({
        inputPath: ${JSON.stringify(srcA)},
        outputDir: ${JSON.stringify(TEST_DIR)},
        baseName: '${FIXTURE_PREFIX}体积',
        ext: first.ext, pass1Args: first.pass1Args, pass2Args: first.pass2Args,
        durationMs: first.durationMs, jobId: 'vcomp-core-size'
      });
      if (!r1.ok) return JSON.stringify({ ok: false, message: r1.message, videoKbps: first.videoKbps });
      const vt1 = verifyTarget({ sizeBytes: r1.size, targetMB: 1.5 });
      let kbps2 = null, r2 = null, vt2 = null;
      if (!vt1.ok) {
        kbps2 = retryBitrate({ videoKbps: first.videoKbps });
        const second = buildPlan(item, { ...params, videoKbps: kbps2 });
        r2 = await window.desktop.ffmpegConvertTwoPass({
          inputPath: ${JSON.stringify(srcA)},
          outputDir: ${JSON.stringify(TEST_DIR)},
          baseName: '${FIXTURE_PREFIX}体积重试',
          ext: second.ext, pass1Args: second.pass1Args, pass2Args: second.pass2Args,
          durationMs: second.durationMs, jobId: 'vcomp-core-size-retry'
        });
        vt2 = r2.ok ? verifyTarget({ sizeBytes: r2.size, targetMB: 1.5 }) : null;
      }
      return JSON.stringify({
        ok: true, videoKbps: first.videoKbps, pass1Args: first.pass1Args.join(' '),
        r1: { ok: r1.ok, path: r1.path, size: r1.size, ms: r1.ms }, vt1,
        kbps2, r2: r2 ? { ok: r2.ok, path: r2.path, size: r2.size, ms: r2.ms } : null, vt2
      });
    })()`));

    const entry = { ...raw, targetMB: 1.5, sourceSize: srcSize };
    const final = raw.vt1 && raw.vt1.ok ? raw.r1 : (raw.r2 || null);
    const finalVt = raw.vt1 && raw.vt1.ok ? raw.vt1 : raw.vt2;
    if (raw.ok && final && final.ok) {
      entry.finalPath = final.path;
      entry.finalSize = final.size;
      entry.decode = decodeCheck(ffmpeg, final.path);
      entry.info = probeByFfmpeg(ffmpeg, final.path);
      entry.shrunk = final.size < srcSize;
      entry.withinTolerance = !!(finalVt && finalVt.ok);
      // 判定：可解码 + 确实变小 + 落在目标附近（5% 容差内；重试后仍超出则放宽到 25% 并如实记录）
      entry.ok = entry.decode.ok && entry.shrunk && entry.info.durationSec > 4
        && (entry.withinTolerance || final.size <= 1.5 * 1024 * 1024 * 1.25);
    } else {
      entry.ok = false;
      entry.error = raw.message || '目标体积压缩失败';
    }
    result.checks.size = entry;
  } catch (err) {
    result.checks.size = { ok: false, error: err.message };
  }

  // —— 收尾清理：删掉本测试的夹具与产物（清所有扩展名），避免污染其它界面测试 ——
  result.steps.清理收尾 = await cleanFixtures();

  const names = ['plan', 'quality', 'size'];
  result.summary = Object.fromEntries(names.map((n) => [n, !!(result.checks[n] && result.checks[n].ok)]));
  result.ok = names.every((n) => result.summary[n]);
  writeResult({ ok: result.ok, at: new Date().toISOString(), result });
  return result;
}

// —— 界面自动测试 ——

async function runVideoCompressUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { pass: false, failures: [], steps: {}, shots: [] };
  const ffmpeg = findFfmpeg();
  result.ffmpeg = { found: !!ffmpeg, path: ffmpeg || '' };
  const fail = (msg) => result.failures.push(msg);

  await fs.mkdir(TEST_DIR, { recursive: true });
  result.steps.清理开跑前 = await cleanFixtures();

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-vcomp-${name}.png`);
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

  if (ffmpeg) {
    result.steps.fixture = makeUiFixture(ffmpeg);
    if (!result.steps.fixture.ok) fail(`夹具生成失败：${result.steps.fixture.error}`);
  } else {
    fail('未检测到 ffmpeg，无法跑视频压缩界面测试');
  }

  // 切到本工具页；左侧分组默认收起，按钮不可见时先展开「视频」分组
  const switched = await evalJs(`(async () => {
    const sel = '.tool-item[data-tool-id="video-compress"]';
    let btn = document.querySelector(sel);
    if (!btn) {
      const head = document.querySelector('.tool-group[data-group-id="video"] .tool-group-head');
      if (head) { head.click(); await new Promise((r) => setTimeout(r, 500)); }
      btn = document.querySelector(sel);
    }
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  result.steps.switched = switched;
  if (!switched) {
    fail('左侧没有找到「视频压缩」工具（registry.js 是否已注册？）');
    await shot('00-未找到工具');
    writeUiResult({ ok: false, at: new Date().toISOString(), result });
    return { pass: false, failures: result.failures, steps: result.steps };
  }
  await wait(600);
  await shot('01-工具页');

  const getStatus = () => evalJs('document.getElementById("statusText").textContent');
  const clickSel = (sel) => evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.click();
    return true;
  })()`);

  /**
   * 等一次运行结束。
   * 注意：**不能只比状态文案**——两轮压缩的结束文案都是「压缩完成：成功 N 个」，
   * 第二轮会因此永远等不到「文案变化」，实测会一直轮询到超时（踩过一次）。
   * 可靠的结束信号是运行按钮：运行中会变成「取消」，结束后变回「开始压缩」。
   * 所以这里分两段：先等它变成「取消」（确认真的跑起来了），再等它变回来（结束）。
   */
  async function waitForFinish(statusBefore, timeoutMs) {
    const probe = () => evalJs(`JSON.stringify({
      status: document.getElementById("statusText").textContent,
      btn: (document.getElementById("vcompRunBtn") || {}).textContent || "",
      progressHidden: document.getElementById("progressBar").hidden
    })`);
    const t0 = Date.now();
    let last = '';

    // 第 1 段：等运行真正开始（最多 3 秒；极短的任务可能已经跑完，那就直接进入第 2 段）
    const tStart = Date.now();
    while (Date.now() - tStart < 3000) {
      const o = JSON.parse(await probe());
      if (o.btn === '取消') break;
      await wait(100);
    }

    // 第 2 段：等运行结束（按钮不再是「取消」，且进度条已收起）
    while (Date.now() - t0 < timeoutMs) {
      const o = JSON.parse(await probe());
      last = o.status;
      if (o.btn && o.btn !== '取消' && o.progressHidden) {
        return { ok: true, status: o.status, ms: Date.now() - t0 };
      }
      await wait(500);
    }
    return { ok: false, status: last, timeout: true, statusBefore };
  }

  /** 读列表项结果 */
  const readItems = () => evalJs(`JSON.stringify([...document.querySelectorAll('.vcomp-item')].map((li) => ({
    name: (li.querySelector('.vcomp-item-name') || {}).textContent || '',
    meta: (li.querySelector('.vcomp-item-meta') || {}).textContent || '',
    result: (li.querySelector('.vcomp-item-result') || {}).textContent || '',
    ok: !!(li.querySelector('.vcomp-item-result') && li.querySelector('.vcomp-item-result').classList.contains('is-ok'))
  })))`);

  // —— 添加夹具 ——
  const added = await clickSel('[data-add]');
  result.steps.added = added;
  await wait(2500);
  result.steps.listAfterAdd = JSON.parse(await readItems());
  if (!added) fail('没有找到「添加视频」按钮');
  if (!result.steps.listAfterAdd.some((it) => it.name.startsWith(FIXTURE_PREFIX))) {
    fail('添加后列表里没有出现「测试压缩视频」夹具');
  }
  await shot('02-已添加');

  // —— 第 1 轮：画质档（默认 standard） ——
  const status1 = await getStatus();
  result.steps.ranQuality = await clickSel('[data-run]');
  result.steps.finishQuality = await waitForFinish(status1, 300000);
  await shot('03-画质档完成');
  result.steps.itemsQuality = JSON.parse(await readItems());
  const qualityItem = result.steps.itemsQuality.find((it) => it.name.startsWith(FIXTURE_PREFIX));
  if (!qualityItem || !qualityItem.ok) fail(`画质档压缩未产生成功结果：${JSON.stringify(qualityItem || null)}`);

  // —— 第 2 轮：目标体积（5MB） ——
  const setup = await evalJs(`(() => {
    const mode = document.querySelector('#vcompMode');
    if (!mode) return false;
    mode.value = 'size';
    mode.dispatchEvent(new Event('change'));
    const size = document.querySelector('#vcompTargetMB');
    if (size) { size.value = '5'; size.dispatchEvent(new Event('change')); }
    const audio = document.querySelector('#vcompAudio');
    if (audio) { audio.value = '96'; audio.dispatchEvent(new Event('change')); }
    const paramsHidden = document.querySelector('#vcompSizeParams').hidden;
    return !paramsHidden;
  })()`);
  result.steps.setupSize = setup;
  if (!setup) fail('切换到「目标体积」模式后参数区没有显示');
  await shot('04-目标体积参数');

  const status2 = await getStatus();
  result.steps.ranSize = await clickSel('[data-run]');
  result.steps.finishSize = await waitForFinish(status2, 180000);
  if (!result.steps.finishSize.ok) fail(`目标体积压缩没有在预期时间内结束：${JSON.stringify(result.steps.finishSize)}`);
  await shot('05-目标体积完成');
  result.steps.itemsSize = JSON.parse(await readItems());
  const sizeItem = result.steps.itemsSize.find((it) => it.name.startsWith(FIXTURE_PREFIX));
  if (!sizeItem || !sizeItem.ok) fail(`目标体积压缩未产生成功结果：${JSON.stringify(sizeItem || null)}`);
  if (!/MB|KB/.test((sizeItem && sizeItem.result) || '')) fail('目标体积模式的结果行没有显示实际体积');

  result.steps.statusFinal = await getStatus();
  result.steps.fixtureCleaned = await cleanFixtures();

  result.pass = result.failures.length === 0;
  writeUiResult({ ok: result.pass, at: new Date().toISOString(), result });
  return { pass: result.pass, failures: result.failures, steps: result.steps };
}

module.exports = { runVideoCompressTest, runVideoCompressUiTest, writeResult, writeUiResult, TEST_DIR };
