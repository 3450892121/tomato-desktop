// 视频播放器界面自动测试（仅 `electron . --player-ui-test` 时运行）
// 做法：像真人一样「切工具 → 点打开（测试模式下对话框直接返回夹具）→ 用控制条操作」，
//      每一步截图，并对「真的播起来了（readyState / 画面尺寸 / 进度推进）」做断言。
// 覆盖三类格式各播一次：MP4（直接播）、MKV（无损换封装）、AVI（重编码）；
// 另外覆盖：播放/暂停、进度拖动、音量与静音、全屏、快捷键、切走暂停、缓存清理、LRU 回收后重建。
// 结果写入 %TEMP%/tomato-player-ui-test.json，截图落在 %TEMP%/tomato-uitest，pass:true 为通过。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawnSync } = require('child_process');
const { app } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-player-ui-test.json');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeResult(payload) {
  fsSync.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return RESULT_FILE;
}

/** 与主进程一致的 ffmpeg 定位 */
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

function makeFixture(ffmpeg, name, args) {
  const file = path.join(TEST_DIR, name);
  const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-f', 'lavfi', '-i', 'testsrc=duration=8:size=480x360:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', ...args, file], {
    windowsHide: true, encoding: 'utf8', timeout: 180000
  });
  return { file, ok: r.status === 0 && fsSync.existsSync(file), error: r.status === 0 ? '' : String(r.stderr || '').slice(-200) };
}

async function runPlayerUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [], failures: [] };
  const ffmpeg = findFfmpeg();
  result.ffmpeg = { found: !!ffmpeg, path: ffmpeg };
  const cacheDir = path.join(app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..'), 'userdata', 'player-cache');

  if (wc.setBackgroundThrottling) wc.setBackgroundThrottling(false);
  win.show();
  await fs.mkdir(TEST_DIR, { recursive: true });

  // 开跑清一次：只留本轮要用的夹具（对话框桩按「测试播放」前缀取文件，多一个就会选错）
  const clearFixtures = async () => {
    for (const f of await fs.readdir(TEST_DIR).catch(() => [])) {
      if (f.startsWith('测试播放')) await fs.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
    }
  };
  await clearFixtures();

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-${name}.png`);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        win.show();
        win.focus();
        await wait(180);
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

  const clickTool = (name) => evalJs(`(() => {
    const btn = [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.textContent.includes(${JSON.stringify(name)}));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  const click = (sel) => evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  const getStatus = () => evalJs('document.getElementById("statusText").textContent');
  const note = () => evalJs('(document.getElementById("plNote") || {}).textContent || ""');

  /** 播放器内部状态快照（元素都在当前工具页里，切走就没有——所以每次都要确认在播放器页） */
  const playerState = () => evalJs(`(() => {
    const v = document.getElementById('plVideo');
    if (!v) return JSON.stringify({ present: false });
    return JSON.stringify({
      present: true,
      src: v.getAttribute('src') || '',
      readyState: v.readyState,
      videoWidth: v.videoWidth,
      currentTime: v.currentTime,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      paused: v.paused,
      volume: v.volume,
      muted: v.muted,
      note: (document.getElementById('plNote') || {}).textContent || '',
      fileName: (document.getElementById('plFileName') || {}).textContent || '',
      time: (document.getElementById('plTime') || {}).textContent || '',
      emptyHidden: !!(document.getElementById('plEmpty') || {}).hidden,
      playDisabled: (document.getElementById('plPlayBtn') || {}).disabled,
      seekDisabled: (document.getElementById('plSeek') || {}).disabled
    });
  })()`);

  /** 等「真的播起来了」：readyState>=2 且画面尺寸>0 且进度在走 */
  async function waitPlaying(timeoutMs = 30000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      const s = JSON.parse(await playerState());
      last = s;
      if (s.present && s.readyState >= 2 && s.videoWidth > 0 && !s.paused) {
        const t1 = s.currentTime;
        await wait(500);
        const s2 = JSON.parse(await playerState());
        if (s2.currentTime > t1 + 0.05) return { ok: true, state: s2 };
      }
      await wait(300);
    }
    return { ok: false, state: last };
  }

  await shot('30-播放器测试起点');

  // —— 0) 切到视频播放器，检查初始态 ——
  result.steps.switch = await clickTool('视频播放器');
  await wait(500);
  result.checks.initial = JSON.parse(await evalJs(`(() => {
    const has = (id) => !!document.getElementById(id);
    const v = document.getElementById('plVideo');
    return JSON.stringify({
      pageActive: (document.querySelector('.tool-page.is-active') || { dataset: {} }).dataset.toolId || '',
      hasVideo: has('plVideo'), hasSeek: has('plSeek'), hasVol: has('plVol'), hasFull: has('plFullBtn'),
      emptyShown: !document.getElementById('plEmpty').hidden,
      controlsDisabled: document.getElementById('plPlayBtn').disabled && document.getElementById('plSeek').disabled,
      src: v.getAttribute('src') || '',
      status: document.getElementById('statusText').textContent
    });
  })()`));
  result.checks.initial.ok = result.checks.initial.pageActive === 'player'
    && result.checks.initial.hasVideo && result.checks.initial.emptyShown
    && result.checks.initial.controlsDisabled && result.checks.initial.src === ''
    && result.checks.initial.status.includes('视频播放器');
  if (!result.checks.initial.ok) result.failures.push('播放器初始状态不符合预期（空态/控制条禁用/顶栏文案）');
  await shot('31-播放器初始');

  if (!ffmpeg) {
    result.failures.push('未检测到 ffmpeg：界面流程需要夹具（视频类功能依赖加装包）');
    result.pass = false;
    writeResult({ ok: false, at: new Date().toISOString(), result });
    return result;
  }

  // —— 1) MP4：直接播 + 控制条全流程 ——
  await clearFixtures();
  const mp4 = makeFixture(ffmpeg, '测试播放-MP4.mp4', ['-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  result.steps.mp4Fixture = { file: path.basename(mp4.file), ok: mp4.ok, error: mp4.error };
  if (!mp4.ok) result.failures.push('MP4 夹具生成失败');

  await click('[data-open]');
  const mp4Play = await waitPlaying();
  result.checks.mp4 = mp4Play;
  await shot('32-播放器-MP4');
  const s1 = mp4Play.state || {};
  result.checks.mp4.ok = mp4Play.ok && String(s1.src).startsWith('tomato-media://')
    && s1.note.includes('直接播放') && s1.fileName.includes('测试播放-MP4') && s1.emptyHidden === true
    && !s1.playDisabled && s1.time !== '00:00 / 00:00';
  if (!result.checks.mp4.ok) result.failures.push('MP4 直接播放未通过（或提示文案不对）');

  // 1a) 暂停 / 播放
  await click('[data-play]');
  await wait(250);
  const pausedState = JSON.parse(await playerState());
  await click('[data-play]');
  await wait(600);
  const resumedState = JSON.parse(await playerState());
  result.checks.playPause = {
    paused: pausedState.paused,
    resumed: resumedState.paused === false,
    icon: await evalJs('document.getElementById("plPlayBtn").textContent'),
    ok: pausedState.paused === true && resumedState.paused === false
  };
  if (!result.checks.playPause.ok) result.failures.push('播放/暂停按钮未生效');
  await shot('33-播放器-控制条');

  // 1b) 进度拖动（把滑块拖到 40% 位置）
  result.checks.seek = JSON.parse(await evalJs(`(async () => {
    const seek = document.getElementById('plSeek');
    const before = document.getElementById('plVideo').currentTime;
    seek.value = '400';
    seek.dispatchEvent(new Event('input', { bubbles: true }));
    seek.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const v = document.getElementById('plVideo');
    const expect = v.duration * 0.4;
    return JSON.stringify({ before, after: v.currentTime, expect, duration: v.duration, fill: seek.style.getPropertyValue('--pl-fill'), ok: Math.abs(v.currentTime - expect) < 0.6 });
  })()`));
  if (!result.checks.seek.ok) result.failures.push('进度条拖动未生效');

  // 1c) 音量与静音
  result.checks.volume = JSON.parse(await evalJs(`(async () => {
    const vol = document.getElementById('plVol');
    vol.value = '30';
    vol.dispatchEvent(new Event('input', { bubbles: true }));
    const v = document.getElementById('plVideo');
    const afterSet = { volume: v.volume, muted: v.muted };
    document.getElementById('plMuteBtn').click();
    const afterMute = { volume: v.volume, muted: v.muted, icon: document.getElementById('plMuteBtn').textContent };
    document.getElementById('plMuteBtn').click();
    const afterUnmute = { muted: v.muted, icon: document.getElementById('plMuteBtn').textContent };
    return JSON.stringify({ afterSet, afterMute, afterUnmute, ok: Math.abs(afterSet.volume - 0.3) < 0.02 && afterMute.muted === true && afterMute.icon === '🔇' && afterUnmute.muted === false });
  })()`));
  if (!result.checks.volume.ok) result.failures.push('音量/静音未生效');

  // 1d) 全屏（进入 → 截图 → 退出）
  await click('[data-full]');
  await wait(700);
  result.checks.fullscreenIn = JSON.parse(await evalJs(`JSON.stringify({
    element: document.fullscreenElement ? document.fullscreenElement.id : '',
    btn: document.getElementById('plFullBtn').textContent
  })`));
  await shot('34-播放器-全屏');
  await click('[data-full]');
  await wait(700);
  result.checks.fullscreenOut = JSON.parse(await evalJs(`JSON.stringify({
    element: document.fullscreenElement ? document.fullscreenElement.id : '',
    btn: document.getElementById('plFullBtn').textContent
  })`));
  result.checks.fullscreen = {
    inElement: result.checks.fullscreenIn.element,
    outElement: result.checks.fullscreenOut.element,
    ok: result.checks.fullscreenIn.element === 'plScreen' && result.checks.fullscreenOut.element === ''
      && result.checks.fullscreenIn.btn === '退出全屏' && result.checks.fullscreenOut.btn === '全屏'
  };
  if (!result.checks.fullscreen.ok) result.failures.push('全屏进入/退出未生效');

  // 1e) 快捷键：空格暂停、→ 前进、M 静音
  result.checks.keys = JSON.parse(await evalJs(`(async () => {
    const v = document.getElementById('plVideo');
    const send = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    send(' '); await new Promise((r) => setTimeout(r, 200));
    const afterSpace = v.paused;
    send(' '); await new Promise((r) => setTimeout(r, 200));
    const beforeSeek = v.currentTime;
    send('ArrowRight'); await new Promise((r) => setTimeout(r, 200));
    const afterSeek = v.currentTime;
    send('m'); await new Promise((r) => setTimeout(r, 200));
    const afterMute = v.muted;
    send('m'); await new Promise((r) => setTimeout(r, 200));
    return JSON.stringify({ afterSpace, beforeSeek, afterSeek, afterMute, ok: afterSpace === true && afterSeek > beforeSeek && afterMute === true });
  })()`));
  if (!result.checks.keys.ok) result.failures.push('快捷键（空格 / → / M）未生效');

  // —— 2) 切走工具：应自动暂停；切回来页面状态还在（保活） ——
  await clickTool('图片压缩');
  await wait(600);
  const away = await evalJs(`!(document.querySelector('.tool-page[data-tool-id="player"]'))`);
  await clickTool('视频播放器');
  await wait(600);
  const backState = JSON.parse(await playerState());
  result.checks.keepAlive = {
    detachedWhileAway: away,
    fileName: backState.fileName,
    src: backState.src,
    pausedAfterBack: backState.paused,
    ok: away === true && backState.fileName.includes('测试播放-MP4') && String(backState.src).startsWith('tomato-media://')
  };
  if (!result.checks.keepAlive.ok) result.failures.push('切走再切回没有保留播放状态');
  await shot('35-播放器-切回后状态还在');

  // —— 3) MKV：无损换封装 ——
  await clearFixtures();
  const mkv = makeFixture(ffmpeg, '测试播放-MKV.mkv', ['-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  result.steps.mkvFixture = { file: path.basename(mkv.file), ok: mkv.ok, error: mkv.error };
  await click('[data-open]');
  const mkvPlay = await waitPlaying();
  await shot('36-播放器-MKV换封装');
  const mkvNote = await note();
  const mkvStatus = await getStatus();
  const cacheAfterMkv = await fs.readdir(cacheDir).catch(() => []);
  result.checks.remux = {
    playing: mkvPlay.ok,
    note: mkvNote,
    status: mkvStatus,
    cacheFiles: cacheAfterMkv,
    src: (mkvPlay.state || {}).src,
    ok: mkvPlay.ok && mkvNote.includes('无损换封装') && String((mkvPlay.state || {}).src).includes('player-cache')
      && cacheAfterMkv.length === 1 && mkvStatus.includes('副本')
  };
  if (!result.checks.remux.ok) result.failures.push('MKV 无损换封装播放未通过（提示文案 / 缓存副本 / 播放状态）');

  // —— 4) AVI：重编码（准备期间应有进度覆盖层） ——
  await clearFixtures();
  const avi = makeFixture(ffmpeg, '测试播放-AVI.avi', ['-vf', 'scale=640:480', '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'libmp3lame', '-shortest']);
  result.steps.aviFixture = { file: path.basename(avi.file), ok: avi.ok, error: avi.error };
  await click('[data-open]');
  // 准备副本期间采样覆盖层（重编码要一会儿，覆盖层与进度必须出现）
  let overlaySeen = false;
  let overlayText = '';
  for (let i = 0; i < 60; i += 1) {
    const o = JSON.parse(await evalJs(`JSON.stringify({
      shown: !document.getElementById('plOverlay').hidden,
      text: document.getElementById('plOverlayText').textContent,
      width: document.getElementById('plOverlayFill').style.width
    })`));
    if (o.shown) { overlaySeen = true; overlayText = o.text; }
    if (o.shown && /%\s*$|%\)/.test(o.width)) break;
    await wait(150);
    const s = JSON.parse(await playerState());
    if (!o.shown && s.readyState >= 2 && s.videoWidth > 0) break;
  }
  const aviPlay = await waitPlaying(60000);
  await shot('37-播放器-AVI重编码');
  const aviNote = await note();
  const cacheAfterAvi = await fs.readdir(cacheDir).catch(() => []);
  result.checks.transcode = {
    overlaySeen,
    overlayText,
    playing: aviPlay.ok,
    note: aviNote,
    cacheFiles: cacheAfterAvi,
    src: (aviPlay.state || {}).src,
    ok: aviPlay.ok && aviNote.includes('已重编码') && overlaySeen
      && cacheAfterAvi.length === 1 && String((aviPlay.state || {}).src).includes('player-cache')
  };
  if (!result.checks.transcode.ok) result.failures.push('AVI 重编码播放未通过（进度覆盖层 / 提示文案 / 播放状态）');

  // —— 5) 缓存清理：切走 5 个工具触发 LRU 回收 → 播放器页被释放，副本随之删掉 ——
  for (const name of ['图片压缩', '图片变清晰', '图片格式转换', '视频格式转换', '视频压缩']) {
    await clickTool(name);
    await wait(500);
    await evalJs('(() => { const p = document.querySelector(".tool-page.is-active"); if (p) p.click(); return true; })()');
    await wait(150);
  }
  const cacheAfterEvict = await fs.readdir(cacheDir).catch(() => []);
  result.checks.eviction = {
    cacheFilesBefore: cacheAfterAvi.length,
    cacheFilesAfter: cacheAfterEvict,
    ok: cacheAfterEvict.length === 0
  };
  if (!result.checks.eviction.ok) result.failures.push('工具页被回收后播放缓存没有清掉');

  await clickTool('视频播放器');
  await wait(700);
  const revived = JSON.parse(await playerState());
  result.checks.revived = {
    status: await getStatus(),
    fileName: revived.fileName,
    emptyShown: !revived.emptyHidden,
    controlsDisabled: revived.playDisabled === true,
    ok: revived.emptyHidden === false && revived.playDisabled === true && !revived.src
  };
  if (!result.checks.revived.ok) result.failures.push('被回收后重新进入播放器，界面没有回到干净的初始态');
  await shot('38-播放器-回收后重建');

  // —— 6) 非视频文件：拖进来要给出可读提示，不能崩 ——
  result.checks.badDrop = JSON.parse(await evalJs(`(async () => {
    const txt = new DataTransfer();
    txt.items.add(new File(['不是视频'], '说明.txt', { type: 'text/plain' }));
    const root = document.querySelector('.pl-tool');
    root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: txt }));
    await new Promise((r) => setTimeout(r, 400));
    return JSON.stringify({
      note: document.getElementById('plNote').textContent,
      stillAlive: !!document.getElementById('plVideo')
    });
  })()`));
  result.checks.badDrop.ok = result.checks.badDrop.stillAlive === true
    && /不是视频|没能取到文件路径/.test(result.checks.badDrop.note);
  if (!result.checks.badDrop.ok) result.failures.push('拖入非视频文件没有给出可读提示');
  await shot('39-播放器-拖入非视频');

  // —— 收尾：清夹具与缓存 ——
  await clearFixtures();
  await evalJs('window.desktop.playerCleanCache()');
  const remain = await fs.readdir(cacheDir).catch(() => []);
  result.checks.cacheCleanedAtEnd = { remain: remain.length, ok: remain.length === 0 };

  const checks = result.checks;
  result.pass = result.failures.length === 0
    && !!checks.initial.ok && !!checks.mp4.ok && !!checks.playPause.ok && !!checks.seek.ok
    && !!checks.volume.ok && !!checks.fullscreen.ok && !!checks.keys.ok && !!checks.keepAlive.ok
    && !!checks.remux.ok && !!checks.transcode.ok && !!checks.eviction.ok && !!checks.revived.ok
    && !!checks.badDrop.ok && !!checks.cacheCleanedAtEnd.ok;
  if (!result.pass && result.failures.length === 0) result.failures.push('汇总判定未通过（有检查项为 false）');
  await shot('99-播放器测试结束');
  writeResult({ ok: !!result.pass, at: new Date().toISOString(), result });
  return result;
}

module.exports = { runPlayerUiTest, writeResult, RESULT_FILE, TEST_DIR };