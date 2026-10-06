// 任务队列 + 任务中心 · 界面自动测试（仅 `electron . --queue-ui-test` 时运行）
//
// 作用：验证「任务归属队列，不归属工具页」这条硬契约 ——
//   1) 顶栏「任务」按钮存在；没有任务时徽标不显示；
//   2) 用「视频压缩」真跑一批（真实 ffmpeg 转码）；
//   3) **核心断言**：把工具页切走（并让它被 LRU 回收 → unmount），任务仍然跑完、产物存在、队列状态为 done；
//      （保活额度只按「动过」的页算，所以中途要在每个切过去的工具页里点一下，凑够 6 页才能真的触发回收）
//   4) 任务中心面板能打开、能看到任务与最近完成记录、能取消排队中的任务、能清空已完成；
//   5) 截图 shot-queue-*.png 落在 %TEMP%\tomato-uitest。
// 结果写 %TEMP%/tomato-queue-ui-test.json，pass:true 为通过。
//
// 夹具说明：测试模式下「视频压缩」的添加对话框会返回 %TEMP%\tomato-uitest 里以「测试压缩视频」开头的文件，
// 所以夹具用「测试压缩视频队列」前缀（既被对话框选中，又能和别的界面测试的夹具区分）。
// 遵守「开跑清一次、收尾清一次、清所有扩展名」。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawnSync } = require('child_process');
const { app } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-queue-ui-test.json');
/** 本测试自己的夹具前缀（必须以「测试压缩视频」开头，对话框桩才取得到） */
const FIXTURE_PREFIX = '测试压缩视频队列';
/** 对话框桩/清理用的更宽前缀：清掉历次测试留下的「测试压缩视频*」残留，保证张数可预期 */
const DIALOG_PREFIX = '测试压缩视频';

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
  try {
    fsSync.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[queue-ui-test] 结果文件写入失败：', err.message);
  }
  return RESULT_FILE;
}

/** ffmpeg 完整解码一遍，确认产物是有效媒体文件而不只是「有字节」 */
function decodeCheck(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], {
    windowsHide: true, encoding: 'utf8', timeout: 120000
  });
  return { ok: r.status === 0, error: String(r.stderr || '').trim().slice(0, 200) };
}

/** 清理「测试压缩视频」开头的全部文件（所有扩展名） */
async function cleanFixtures() {
  const before = (await fs.readdir(TEST_DIR).catch(() => [])).filter((f) => f.startsWith(DIALOG_PREFIX));
  for (const f of before) {
    await fs.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
  }
  return before;
}

/** 造夹具：较长的高码率短片 + 音轨（转码要几秒，才有「运行中切走工具页」的窗口） */
function makeFixtures(ffmpeg, names) {
  const made = [];
  for (const name of names) {
    const target = path.join(TEST_DIR, name);
    const r = spawnSync(ffmpeg, [
      '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=30:size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '8000k', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', target
    ], { windowsHide: true, encoding: 'utf8', timeout: 180000 });
    made.push({ name, ok: r.status === 0 && fsSync.existsSync(target), error: r.status === 0 ? '' : String(r.stderr || '').slice(-200) });
  }
  return made;
}

/** 轮询直到条件成立或超时 */
async function pollUntil(fn, timeoutMs, intervalMs = 800) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await wait(intervalMs);
  }
}

/**
 * 跑任务队列/任务中心界面测试
 * @param {import('electron').BrowserWindow} win
 */
async function runQueueUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [], failures: [] };
  const fail = (msg) => { result.failures.push(msg); console.error(`[queue-ui-test] ${msg}`); };

  await fs.mkdir(TEST_DIR, { recursive: true });

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-queue-${name}.png`);
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
      } catch { /* 重试 */ }
      await wait(400);
    }
    fail(`截图失败：${name}`);
    return false;
  };

  const ffmpeg = findFfmpeg();
  result.ffmpeg = { found: !!ffmpeg, path: ffmpeg || '' };
  if (!ffmpeg) {
    result.pass = false;
    fail('未检测到 ffmpeg，无法跑队列界面测试');
    return result;
  }

  // 开跑先清一次，保证目录里只有本轮的 3 个夹具
  result.steps.cleanedAtStart = await cleanFixtures();
  const fixtures = [FIXTURE_PREFIX + '源A.mp4', FIXTURE_PREFIX + '源B.mp4', FIXTURE_PREFIX + '源C.mp4'];
  result.steps.fixtures = makeFixtures(ffmpeg, fixtures);
  if (result.steps.fixtures.some((f) => !f.ok)) {
    result.pass = false;
    fail('夹具生成失败');
    return result;
  }

  // —— 1) 入口按钮与徽标（无任务时徽标不显示） ——
  await evalJs('document.getElementById("btnTasks").click()'); // 先故意点一下再关，验证面板能开关
  await wait(200);
  const opened = await evalJs('(() => { const p = document.getElementById("taskCenter"); return !!p && !p.hidden; })()');
  result.checks.panelOpensEmpty = opened;
  result.checks.emptyState = await evalJs('!!document.querySelector("#taskCenter .tc-empty")');
  await shot('01-空态');
  await evalJs('document.getElementById("tcClose").click()');
  await wait(200);

  const initial = await evalJs(`(() => {
    const btn = document.getElementById('btnTasks');
    const badge = document.getElementById('taskBadge');
    return { hasBtn: !!btn, badgeHidden: badge ? badge.hidden : null, badgeText: badge ? badge.textContent : '' };
  })()`);
  result.checks.entry = initial;
  if (!initial.hasBtn) fail('顶栏缺少任务按钮 #btnTasks');
  if (initial.badgeHidden !== true) fail('没有任务时徽标不应显示');

  // —— 2) 切到「视频压缩」并添加夹 3 个夹具 ——
  await evalJs(`(() => {
    const nav = (id) => [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === id);
    nav('video-compress').click();
    return true;
  })()`);
  await wait(800);
  result.checks.toolOpen = await evalJs('!!document.querySelector("#vcompAddBtn")');

  await evalJs('document.getElementById("vcompAddBtn").click()');
  await wait(2500);
  result.steps.afterAdd = await evalJs(`JSON.stringify({
    status: document.getElementById('statusText').textContent,
    count: document.querySelectorAll('#vcompList .vcomp-item').length
  })`);
  if (JSON.parse(result.steps.afterAdd).count !== 3) {
    fail(`添加后列表张数应为 3，实际 ${JSON.parse(result.steps.afterAdd).count}`);
  }

  // 保持默认「标准画质 + 原分辨率」：转码要跑几秒，才能覆盖「运行中切走工具页」的核心断言

  // —— 3) 开始压缩：任务应在队列里跑起来、徽标显示未完成数量 ——
  await evalJs('document.getElementById("vcompRunBtn").click()');
  await wait(600);
  const running = await evalJs(`(() => {
    const badge = document.getElementById('taskBadge');
    return { badgeHidden: badge ? badge.hidden : null, badgeText: badge ? badge.textContent : '', busyBtnText: document.getElementById('vcompRunBtn').textContent };
  })()`);
  result.checks.badgeWhileRunning = running;
  if (running.badgeHidden !== false) fail('任务在跑时徽标应显示');
  if (!(parseInt(running.badgeText, 10) >= 1)) fail(`徽标数量应 >=1，实际 ${running.badgeText}`);

  // 任务中心里应能看到任务
  await evalJs('document.getElementById("btnTasks").click()');
  await wait(400);
  result.checks.panelRows = await evalJs(`(() => {
    const panel = document.getElementById('taskCenter');
    const rows = [...panel.querySelectorAll('.tc-task')];
    return {
      open: !!panel && !panel.hidden,
      total: rows.length,
      statuses: rows.map((r) => r.dataset.status),
      summary: document.getElementById('tcSummary').textContent
    };
  })()`);
  await shot('02-任务中心运行中');

  // —— 4) 取消一个排队中的任务 ——
  result.checks.cancelQueued = JSON.parse(await evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const queued = document.querySelector('#taskCenter .tc-task[data-status="queued"]');
    if (!queued) return JSON.stringify({ ok: false, reason: '没有排队中的任务可取消' });
    const id = queued.dataset.taskId;
    const btn = queued.querySelector('[data-act="cancel"]');
    if (!btn) return JSON.stringify({ ok: false, reason: '排队中的任务没有取消按钮' });
    btn.click();
    await wait(600);
    const after = document.querySelector('#taskCenter .tc-task[data-task-id="' + id + '"]');
    return JSON.stringify({
      ok: !!after && after.dataset.status === 'canceled',
      status: after ? after.dataset.status : 'missing',
      canceledRows: document.querySelectorAll('#taskCenter .tc-task[data-status="canceled"]').length
    });
  })()`));
  if (!result.checks.cancelQueued.ok) fail(`取消排队任务失败：${result.checks.cancelQueued.reason || result.checks.cancelQueued.status}`);
  await shot('03-已取消一个任务');

  // 关闭面板：任务应继续跑（面板开关不影响任务）
  await evalJs('document.getElementById("tcClose").click()');
  await wait(300);

  // —— 5) 核心断言：切走工具页（并让 LRU 把它回收 → unmount），任务照跑完 ——
  //     注意：保活额度只按「动过」的页算（只是切过去看一眼不算），所以切过去后要在页里点一下，
  //     才能把这 5 个工具也变成「动过」的页、凑够 6 页触发 video-compress 的回收。
  result.checks.switchedAway = JSON.parse(await evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const nav = (id) => [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === id);
    const badgeBefore = (document.getElementById('taskBadge') || {}).textContent || '';
    // 进度遮罩全局只有一个，切走还在跑的工具时必须关掉（否则它会僵在新工具页面上，
    // 而该页随后被 LRU 回收 → 工具里的 hideProgress 被 ctx 的 active() 拦住，就永久卡住了）
    const barVisible = () => { const b = document.getElementById('progressBar'); return !!b && !b.hidden; };
    const progressVisibleBefore = barVisible();
    let progressAfterFirstSwitch = null;
    for (const id of ['compress', 'img-convert', 'video-convert', 'sticker', 'enhance']) {
      nav(id).click();
      await wait(700);
      if (progressAfterFirstSwitch === null) progressAfterFirstSwitch = barVisible();
      document.querySelector('.tool-page.is-active').click(); // 在页里点一下 = 用户「动过」这页
      await wait(200);
    }
    const badge = document.getElementById('taskBadge');
    return JSON.stringify({
      badgeBefore,
      progressVisibleBefore,
      progressAfterFirstSwitch,
      progressAfterAllSwitches: barVisible(),
      evicted: !document.querySelector('.tool-page[data-tool-id="video-compress"]'),
      activeTool: (document.querySelector('.tool-page.is-active') || { dataset: {} }).dataset.toolId || '',
      badgeDuring: badge ? badge.textContent : '',
      badgeHiddenDuring: badge ? badge.hidden : null
    });
  })()`));
  if (result.checks.switchedAway.progressVisibleBefore !== true) {
    fail('进度条断言未覆盖：切走前进度条没显示（夹具太快或该工具没开进度）');
  }
  if (result.checks.switchedAway.progressAfterFirstSwitch !== false) {
    fail('切走仍在跑的工具后，全局进度条没有关闭（会僵在新工具页面上，回收后永久卡住）');
  }
  if (result.checks.switchedAway.progressAfterAllSwitches !== false) {
    fail('连切 5 个工具后进度条仍显示着');
  }
  if (result.checks.switchedAway.evicted !== true) {
    // 没被回收不算失败（说明保活页数没超），但要记下来；下面仍会验证任务跑完
    result.checks.evictionNote = '切走 5 个工具后 video-compress 页面未被回收（保活未超限时的正常情况）';
  }
  // 核心断言的前提：开始切工具时任务确实还在跑（否则这条断言等于没覆盖）
  if (!(parseInt(result.checks.switchedAway.badgeBefore, 10) >= 1)) {
    fail('核心断言未覆盖：切换工具前任务已跑完（测试夹具太快，需要加长）');
  }

  // 轮询：等徽标消失（未完成任务归零）
  const idle = await pollUntil(async () => {
    const hidden = await evalJs('(document.getElementById("taskBadge") || {}).hidden');
    return hidden === true ? true : null;
  }, 240000, 1000);
  result.checks.finishedAfterSwitch = !!idle;
  if (!idle) fail('切走工具后任务未在预期时间内跑完');

  // —— 6) 产物存在且为有效媒体（任务确实跑完了，而不是被丢弃） ——
  const all = (await fs.readdir(TEST_DIR)).filter((f) => f.startsWith(FIXTURE_PREFIX));
  const products = all.filter((f) => !fixtures.includes(f));
  result.steps.products = products;
  if (products.length < 1) fail('切走工具后没有产出任何文件（任务可能被取消了）');
  result.checks.productDecodes = products.map((f) => ({ file: f, ...decodeCheck(ffmpeg, path.join(TEST_DIR, f)) }));
  if (result.checks.productDecodes.some((d) => !d.ok)) fail('有产物无法被 ffmpeg 完整解码');

  // —— 7) 任务中心里能看到「已完成」与「已取消」的记录 ——
  await evalJs('document.getElementById("btnTasks").click()');
  await wait(400);
  result.checks.panelAfterDone = await evalJs(`(() => {
    const panel = document.getElementById('taskCenter');
    const rows = [...panel.querySelectorAll('.tc-task')];
    const done = rows.filter((r) => r.dataset.status === 'done');
    return {
      open: !!panel && !panel.hidden,
      total: rows.length,
      doneCount: done.length,
      canceledCount: rows.filter((r) => r.dataset.status === 'canceled').length,
      doneResultText: done.length ? done[0].querySelector('.tc-task-result').textContent : '',
      summary: document.getElementById('tcSummary').textContent,
      hasRecentSection: [...panel.querySelectorAll('.tc-section-title')].some((e) => e.textContent.includes('最近完成'))
    };
  })()`);
  if (result.checks.panelAfterDone.doneCount < 1) fail('任务中心里看不到已完成任务');
  if (!result.checks.panelAfterDone.doneResultText.trim()) fail('已完成任务没有显示产物结果');
  await shot('04-任务中心已完成');

  // —— 8) 清空已完成 ——
  await evalJs('document.getElementById("tcClearFinished").click()');
  await wait(400);
  result.checks.clearedFinished = await evalJs(`(() => {
    const panel = document.getElementById('taskCenter');
    return {
      rows: panel.querySelectorAll('.tc-task').length,
      empty: !!panel.querySelector('.tc-empty') || !!panel.querySelector('.tc-empty-line')
    };
  })()`);
  if (result.checks.clearedFinished.rows !== 0) fail('清空已完成后任务列表应清空');
  await shot('05-清空已完成');
  await evalJs('document.getElementById("tcClose").click()');
  await wait(200);

  // 收尾清一次：删掉本轮夹具与产物（所有扩展名）
  result.steps.cleanedAtEnd = await cleanFixtures();

  result.pass = result.failures.length === 0;
  return result;
}

module.exports = { runQueueUiTest, writeResult, RESULT_FILE };