// 视频播放器自检（仅 `electron . --player-test` 时运行）
// 覆盖三层：
//   1) 纯逻辑：播放计划（direct / remux / remux-audio / transcode）、升档路径、ffmpeg 参数、时间与文案格式化；
//   2) 传输层：本地媒体协议 tomato-media://（200 / 206 / Range / Content-Type / 404）；
//   3) 端到端：用 ffmpeg 造 7 种常见容器/编码的夹具 → 走播放器自己的「探测 → 计划 → 准备副本」链路
//      → 在真实的 <video> 里播起来（readyState / 画面尺寸 / 进度推进都断言），并校验副本能被 ffmpeg 完整解码。
// 结果写 %TEMP%/tomato-player-test.json，ok:true 为通过。
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { spawnSync } = require('child_process');
const { app, net } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-player-test.json');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeResult(payload) {
  try {
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[player-test] 结果文件写入失败：', err.message);
  }
  return RESULT_FILE;
}

/** 与主进程一致的 ffmpeg 定位（加装包优先，其次系统 PATH） */
function findFfmpeg() {
  const base = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
  const addon = path.join(base, 'addons', 'ffmpeg', 'ffmpeg.exe');
  if (fs.existsSync(addon)) return addon;
  try {
    const r = spawnSync('where', ['ffmpeg'], { windowsHide: true, encoding: 'utf8' });
    if (r.status === 0) {
      const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) return first;
    }
  } catch { /* 未安装 */ }
  return null;
}

/** 用 ffmpeg 完整解码一遍（校验副本确实是有效媒体，而不只是「有字节」） */
function decodeCheck(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], {
    windowsHide: true, encoding: 'utf8', timeout: 180000
  });
  return { ok: r.status === 0, error: String(r.stderr || '').trim().slice(0, 200) };
}

/**
 * 造 7 种夹具：覆盖「直接播（MP4/WebM）」「换封装（MKV/FLV/TS）」「重编码（AVI 的 MPEG-4 / WMV / 老 FLV）」三类。
 * 名字统一以「测试播放」开头：界面自动测试的对话框桩按这个前缀取夹具。
 */
function makeFixtures(ffmpeg) {
  const src = ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'];
  const out = path.join(TEST_DIR, '测试播放');
  const cases = [
    { name: 'MP4（H.264+AAC，应直接播）', file: `${out}-MP4.mp4`, args: ['-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'] },
    { name: 'MKV（H.264+AAC，应换封装）', file: `${out}-MKV.mkv`, args: ['-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'] },
    { name: 'FLV（H.264+AAC，应换封装）', file: `${out}-FLV.flv`, args: ['-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'] },
    { name: 'TS（H.264+AAC，应换封装）', file: `${out}-TS.ts`, args: ['-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'] },
    { name: 'WebM（VP9+Opus，应直接播）', file: `${out}-WebM.webm`, args: ['-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0', '-c:a', 'libopus', '-shortest'] },
    { name: 'AVI（MPEG-4+MP3，应重编码）', file: `${out}-AVI.avi`, args: ['-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libmp3lame', '-shortest'] },
    { name: 'WMV（WMV2+WMA，应重编码）', file: `${out}-WMV.wmv`, args: ['-c:v', 'wmv2', '-q:v', '5', '-c:a', 'wmav2', '-shortest'] }
  ];
  const made = [];
  for (const c of cases) {
    const r = spawnSync(ffmpeg, ['-y', '-hide_banner', ...src, ...c.args, c.file], {
      windowsHide: true, encoding: 'utf8', timeout: 180000
    });
    made.push({
      label: c.name, file: c.file, ext: path.extname(c.file).slice(1),
      ok: r.status === 0 && fs.existsSync(c.file),
      error: r.status === 0 ? '' : String(r.stderr || '').slice(-200)
    });
  }
  return made;
}

/** 渲染进程内：把播放计划与「准备副本」跑一遍（与工具界面用的是同一套模块与通道） */
function pipelineScript(file, ext) {
  return `(async () => {
    const { planPlayback, buildPrepareArgs, mediaUrl } = await import('../tools/player/core/plan.js');
    const probe = await window.desktop.ffmpegProbe(${JSON.stringify(file)});
    const plan = planPlayback({ ext: ${JSON.stringify(ext)}, probe: probe && probe.ok ? probe : null });
    const out = {
      probe: {
        ok: !!(probe && probe.ok), videoCodec: probe && probe.videoCodec, audioCodec: probe && probe.audioCodec,
        width: probe && probe.width, height: probe && probe.height, durationSec: probe && probe.durationSec
      },
      plan
    };
    if (plan.mode === 'direct') { out.url = mediaUrl(${JSON.stringify(file)}); return JSON.stringify(out); }
    const res = await window.desktop.playerPrepare({
      inputPath: ${JSON.stringify(file)},
      mode: plan.mode,
      args: buildPrepareArgs(plan.mode, probe || {}),
      durationMs: Math.round(((probe && probe.durationSec) || 0) * 1000),
      jobId: 'pl-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
    });
    out.prepare = { ok: !!(res && res.ok), path: res && res.path, size: res && res.size, ms: res && res.ms, cached: !!(res && res.cached), message: res && res.message };
    if (res && res.ok) out.url = mediaUrl(res.path);
    return JSON.stringify(out);
  })()`;
}

/** 渲染进程内：用真实的 <video> 播这个 URL，回报「能不能播」与「进度有没有走」 */
function playScript(url, { timeoutMs = 20000, playMs = 1200 } = {}) {
  return `(async () => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.style.width = '320px';
    v.style.height = '240px';
    document.body.appendChild(v);
    const out = { errorCode: 0, stalled: false };
    v.addEventListener('error', () => { out.errorCode = v.error ? v.error.code : -1; });
    v.src = ${JSON.stringify(url)};
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      v.addEventListener('loadeddata', finish, { once: true });
      v.addEventListener('error', finish, { once: true });
      setTimeout(() => { out.stalled = true; finish(); }, ${timeoutMs});
    });
    out.readyState = v.readyState;
    out.videoWidth = v.videoWidth;
    if (!out.errorCode && out.readyState >= 1) {
      try { await v.play(); } catch (err) { out.playError = err.message; }
      await new Promise((r) => setTimeout(r, ${playMs}));
      out.currentTime = v.currentTime;
      out.paused = v.paused;
    }
    try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch (e) { /* 清理失败不影响结论 */ }
    out.ok = !out.errorCode && out.readyState >= 2 && out.videoWidth > 0;
    out.advanced = out.currentTime > 0.05;
    return JSON.stringify(out);
  })()`;
}

/** 纯逻辑断言（在渲染进程里跑，用的是界面同一份模块） */
function logicScript() {
  return `(async () => {
    const P = await import('../tools/player/core/plan.js');
    const cases = [];
    const check = (name, actual, expected) => cases.push({ name, actual, expected, ok: JSON.stringify(actual) === JSON.stringify(expected) });

    // 1) 扩展名 / 编码名归一化
    check('ext 归一化 .MP4', P.normalizeExt('.MP4'), 'mp4');
    check('ext 归一化 mp4', P.normalizeExt('mp4'), 'mp4');
    check('编码别名 avc1→h264', P.normalizeCodec('avc1'), 'h264');
    check('编码别名 h265→hevc', P.normalizeCodec('h265'), 'hevc');

    // 2) 播放计划矩阵（覆盖三类决策）
    const m = (ext, probe) => P.planPlayback({ ext, probe }).mode;
    check('MP4/h264+aac → direct', m('mp4', { videoCodec: 'h264', audioCodec: 'aac', hasAudio: true }), 'direct');
    check('WebM/vp9+opus → direct', m('webm', { videoCodec: 'vp9', audioCodec: 'opus', hasAudio: true }), 'direct');
    check('MKV/h264+aac → remux', m('mkv', { videoCodec: 'h264', audioCodec: 'aac', hasAudio: true }), 'remux');
    check('FLV/h264+aac → remux', m('flv', { videoCodec: 'h264', audioCodec: 'aac', hasAudio: true }), 'remux');
    check('MP4/h264+ac3 → remux-audio', m('mp4', { videoCodec: 'h264', audioCodec: 'ac3', hasAudio: true }), 'remux-audio');
    check('AVI/mpeg4+mp3 → transcode', m('avi', { videoCodec: 'mpeg4', audioCodec: 'mp3', hasAudio: true }), 'transcode');
    check('WMV/wmv2 → transcode', m('wmv', { videoCodec: 'wmv2', audioCodec: 'wmav2', hasAudio: true }), 'transcode');
    check('无音轨 MKV/h264 → remux', m('mkv', { videoCodec: 'h264', audioCodec: '', hasAudio: false }), 'remux');
    check('探测失败 + mp4 → direct（先试播）', m('mp4', null), 'direct');
    check('探测失败 + avi → transcode', m('avi', null), 'transcode');

    // 3) 升档路径：direct → remux → remux-audio → transcode → null（有限步，不会死循环）
    const ladder = [];
    let cur = 'direct';
    while (cur) { ladder.push(cur); cur = P.nextMode(cur); }
    check('升档路径', ladder, ['direct', 'remux', 'remux-audio', 'transcode']);

    // 4) 准备参数：只取首视频+首音轨（多音轨/字幕会让 MP4 封装失败）、faststart（便于边下边播）
    const remux = P.buildPrepareArgs('remux', { audioCodec: 'aac' });
    check('remux 直拷', remux.includes('-c:v') && remux.includes('copy'), true);
    check('remux 带 map', remux.includes('0:v:0?') && remux.includes('0:a:0?'), true);
    check('remux AAC 带 adtstoasc', remux.includes('aac_adtstoasc'), true);
    check('remux faststart', remux.includes('+faststart'), true);
    const remuxAudio = P.buildPrepareArgs('remux-audio', { audioCodec: 'ac3' });
    check('remux-audio 画面直拷+音轨转 AAC', [remuxAudio.includes('copy'), remuxAudio.includes('aac')], [true, true]);
    const tc = P.buildPrepareArgs('transcode', {});
    check('transcode 用 libx264', tc.includes('libx264') && tc.includes('yuv420p'), true);
    check('transcode 不直拷', tc.includes('copy'), false);

    // 5) 时间与文案
    check('时间 0', P.formatTime(0), '00:00');
    check('时间 83', P.formatTime(83), '01:23');
    check('时间 3723', P.formatTime(3723), '1:02:03');
    check('时间 非法值兜底', P.formatTime(NaN), '00:00');
    check('媒体 URL 编码', P.mediaUrl('C:\\\\a b\\\\中文.mp4'), 'tomato-media://local/' + encodeURIComponent('C:\\\\a b\\\\中文.mp4'));
    const desc = P.describeProbe({ width: 1920, height: 1080, durationSec: 83, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true }, 'mp4');
    check('元信息文案', desc, '1920×1080 ｜ 01:23 ｜ H.264 / AAC');
    check('无音轨提示', P.describeProbe({ width: 640, height: 480, durationSec: 3, videoCodec: 'h264', audioCodec: '', hasAudio: false }, 'mp4').includes('无音轨'), true);

    return JSON.stringify({ cases, ok: cases.every((c) => c.ok) });
  })()`;
}

async function runPlayerTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { checks: {}, fixtures: [], failures: [] };
  const ffmpeg = findFfmpeg();
  result.ffmpeg = { found: !!ffmpeg, path: ffmpeg };

  if (wc.setBackgroundThrottling) wc.setBackgroundThrottling(false);
  win.show();
  await fsPromises.mkdir(TEST_DIR, { recursive: true });

  // 开跑先清一次：历次测试的夹具不让本轮「数张数/取文件」出错
  const cleanup = async () => {
    for (const f of await fsPromises.readdir(TEST_DIR).catch(() => [])) {
      if (f.startsWith('测试播放')) await fsPromises.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
    }
  };
  await cleanup();

  // —— 1) 纯逻辑 ——
  const logic = JSON.parse(await evalJs(logicScript()));
  result.checks.logic = logic;
  if (!logic.ok) result.failures.push(`纯逻辑断言未通过：${logic.cases.filter((c) => !c.ok).map((c) => c.name).join('、')}`);

  if (!ffmpeg) {
    result.failures.push('未检测到 ffmpeg：端到端播放校验无法执行');
    result.ok = false;
    writeResult({ ok: false, at: new Date().toISOString(), result });
    return result;
  }

  // —— 2) 夹具 ——
  const fixtures = makeFixtures(ffmpeg);
  result.fixtures = fixtures.map((f) => ({ label: f.label, file: path.basename(f.file), ext: f.ext, ok: f.ok, error: f.error }));
  if (fixtures.some((f) => !f.ok)) {
    result.failures.push(`夹具生成失败：${fixtures.filter((f) => !f.ok).map((f) => f.label).join('、')}`);
  }

  // —— 3) 传输层：本地媒体协议（200 / 206 / Range / Content-Type / 404） ——
  const mp4 = fixtures.find((f) => f.ext === 'mp4');
  const protoUrl = (p) => `tomato-media://local/${encodeURIComponent(p)}`;
  const proto = {};
  try {
    const full = await net.fetch(protoUrl(mp4.file));
    proto.full = {
      status: full.status,
      type: full.headers.get('content-type'),
      acceptRanges: full.headers.get('accept-ranges'),
      bytes: (await full.arrayBuffer()).byteLength
    };
    const ranged = await net.fetch(protoUrl(mp4.file), { headers: { Range: 'bytes=0-99' } });
    proto.range = {
      status: ranged.status,
      contentRange: ranged.headers.get('content-range'),
      length: Number(ranged.headers.get('content-length')),
      bytes: (await ranged.arrayBuffer()).byteLength
    };
    const missing = await net.fetch(protoUrl(path.join(TEST_DIR, '不存在的文件.mp4')));
    proto.missing = { status: missing.status };
    const size = fs.statSync(mp4.file).size;
    proto.ok = proto.full.status === 200 && proto.full.type === 'video/mp4'
      && proto.full.bytes === size && proto.full.acceptRanges === 'bytes'
      && proto.range.status === 206 && proto.range.length === 100 && proto.range.bytes === 100
      && proto.range.contentRange === `bytes 0-99/${size}`
      && proto.missing.status === 404;
  } catch (err) {
    proto.error = err.message;
    proto.ok = false;
  }
  result.checks.protocol = proto;
  if (!proto.ok) result.failures.push('本地媒体协议（Range / Content-Type / 404）校验未通过');

  // —— 4) 端到端：每种格式走「探测 → 计划 → 准备副本 → 真实播放」 ——
  for (const f of fixtures) {
    const entry = { label: f.label, ext: f.ext, ok: false };
    if (!f.ok) { result.fixtures.find((x) => x.file === path.basename(f.file)).pipeline = entry; continue; }
    try {
      const plan = JSON.parse(await evalJs(pipelineScript(f.file, f.ext)));
      entry.probe = plan.probe;
      entry.mode = plan.plan.mode;
      entry.reason = plan.plan.reason;
      entry.prepare = plan.prepare || null;

      // 直接播的格式：必须真的能直接播（这是「计划」的正确性底线）
      if (!entry.prepare) {
        entry.cached = false;
      } else if (!plan.url) {
        entry.error = (plan.prepare && plan.prepare.message) || '准备副本失败';
      } else {
        // 副本要被 ffmpeg 认（能完整解码），再交给 <video>
        entry.decode = decodeCheck(ffmpeg, plan.prepare.path);
        // 再准备一次：应命中缓存（同一文件不重复转，秒开）
        const again = JSON.parse(await evalJs(pipelineScript(f.file, f.ext)));
        entry.cached = !!(again.prepare && again.prepare.cached);
      }

      if (plan.url) {
        entry.play = JSON.parse(await evalJs(playScript(plan.url)));
        entry.ok = entry.play.ok && entry.play.advanced && (!entry.decode || entry.decode.ok);
        if (entry.prepare) {
          entry.ok = entry.ok && entry.cached === true;
          if (!entry.cached) entry.error = '重复准备同一文件没有命中缓存';
        }
      } else {
        entry.ok = false;
      }
      if (!entry.ok && !entry.error) entry.error = '播放校验未通过';
    } catch (err) {
      entry.error = `${err.message}`;
    }
    result.fixtures.find((x) => x.file === path.basename(f.file)).pipeline = entry;
    if (!entry.ok) result.failures.push(`端到端播放未通过：${f.label}（${entry.error || '未知原因'}）`);
  }

  // —— 5) 无效文件：不能崩、不能静默，要给出可读错误 ——
  const badPath = path.join(TEST_DIR, '测试播放-坏文件.mp4');
  await fsPromises.writeFile(badPath, '这不是视频内容', 'utf8');
  try {
    const probeRes = JSON.parse(await evalJs(`(async () => {
      const probe = await window.desktop.ffmpegProbe(${JSON.stringify(badPath)});
      const res = await window.desktop.playerPrepare({ inputPath: ${JSON.stringify(badPath)}, mode: 'transcode', args: ['-map','0:v:0?','-c:v','libx264'], jobId: 'pl-bad-' + Date.now() });
      return JSON.stringify({ probeOk: !!(probe && probe.ok), prepareOk: !!(res && res.ok), message: (res && res.message) || '' });
    })()`));
    result.checks.badFile = {
      ...probeRes,
      ok: probeRes.probeOk === false && probeRes.prepareOk === false && probeRes.message.length > 0
    };
    if (!result.checks.badFile.ok) result.failures.push('无效文件的处理未通过（应为可读错误且不产出文件）');
  } catch (err) {
    result.checks.badFile = { ok: false, error: err.message };
    result.failures.push(`无效文件处理抛错：${err.message}`);
  }

  // —— 6) 播放缓存收尾：自检结束后不留副本（绿色软件不留垃圾） ——
  const cacheDir = await evalJs('window.desktop.playerCacheDir()');
  await evalJs('window.desktop.playerCleanCache()');
  const remain = await fsPromises.readdir(cacheDir).catch(() => []);
  result.checks.cacheCleaned = { dir: cacheDir, remain: remain.length, ok: remain.length === 0 };
  if (remain.length !== 0) result.failures.push(`播放缓存未清理干净（还剩 ${remain.length} 个文件）`);

  await cleanup();
  result.ok = result.failures.length === 0;
  writeResult({ ok: result.ok, at: new Date().toISOString(), result });
  await wait(100);
  return result;
}

module.exports = { runPlayerTest, writeResult, RESULT_FILE, TEST_DIR };