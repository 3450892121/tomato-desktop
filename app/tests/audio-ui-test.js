// 音频工具界面自动测试（仅 `electron . --audio-ui-test` 时运行）
// 做法：像真人一样「切到音频格式转换 → 点添加（测试模式下对话框直接返回夹具）→ 选输出格式 → 点开始转换 → 等完成」，
//      每步截图，并对比运行前后测试目录的新增文件、用 ffmpeg 校验产物能否正常解码。
// 覆盖：21 选项分组下拉、无损格式禁用音质、含视频文件（自动提取声音）、两轮不同格式转码（M4A / OGG）。
// 结果写入 %TEMP%/tomato-audio-ui-test.json，截图落在 %TEMP%/tomato-uitest。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawnSync } = require('child_process');
const { app } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-audio-ui-test.json');

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

/** 用 ffmpeg 完整解码一遍（校验产物是有效音频文件，而不只是「有字节」） */
function decodeCheck(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], {
    windowsHide: true, encoding: 'utf8', timeout: 120000
  });
  return { ok: r.status === 0, error: String(r.stderr || '').trim().slice(0, 200) };
}

/** 造音频夹具（ffmpeg 的 lavfi 正弦波 + 带音轨视频，无需外部素材） */
function makeFixtures(ffmpeg) {
  const made = [];
  const dir = TEST_DIR;
  const run = (args, name) => {
    const r = spawnSync(ffmpeg, args, { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    made.push({ name, ok: r.status === 0, error: r.status === 0 ? '' : String(r.stderr || '').slice(-200) });
  };
  const wav = path.join(dir, '测试音频A.wav');
  run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3', '-ac', '2', '-ar', '44100', wav], '测试音频A.wav');
  run(['-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '192k', path.join(dir, '测试音频B.mp3')], '测试音频B.mp3');
  run(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-pix_fmt', 'yuv420p',
    path.join(dir, '测试音频C.mp4')], '测试音频C.mp4');
  return made;
}

async function runAudioUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [] };
  const ffmpeg = findFfmpeg();
  result.ffmpeg = { found: !!ffmpeg, path: ffmpeg || '' };

  await fs.mkdir(TEST_DIR, { recursive: true });

  // —— 清理上次夹具与产物（本测试只认「测试音频*」，清理范围也仅限它，避免影响其它界面测试的夹具） ——
  //    诊断口径：清理前/后各记一次匹配文件，防止「产物混进列表」类问题再次悄悄发生（参考 v1.5.0 教训）
  const cleanBefore = (await fs.readdir(TEST_DIR)).filter((f) => /^测试音频/.test(f));
  for (const f of await fs.readdir(TEST_DIR)) {
    if (/^测试音频/.test(f)) {
      await fs.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
    }
  }
  const cleanAfter = (await fs.readdir(TEST_DIR)).filter((f) => /^测试音频/.test(f));
  result.steps.清理 = { before: cleanBefore, after: cleanAfter };

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
  const setSelect = (sel, value) => evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.value = ${JSON.stringify('')} + ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change'));
    return el.value === ${JSON.stringify(value)};
  })()`);

  /** 等一次运行结束：进度条先出现、再收起（或状态文案变化）才算完成。
   *  注意：连续两轮运行的完成文案相同（如都为「转换完成：成功 3 个」），
   *        不能只靠「状态变化」判定，否则第二轮会误判超时。 */
  async function waitForFinish(statusBefore, timeoutMs) {
    const t0 = Date.now();
    const readProgress = async () => JSON.parse(await evalJs(`JSON.stringify({
      status: document.getElementById('statusText').textContent,
      progressHidden: document.getElementById('progressBar').hidden
    })`));
    // 1) 先等进度条出现（最多 5 秒；极快的任务可能错过，则退化为状态变化判定）
    let appeared = false;
    while (Date.now() - t0 < 5000) {
      const o = await readProgress();
      if (!o.progressHidden) { appeared = true; break; }
      await wait(120);
    }
    // 2) 再等进度条收起（或状态文案变化）
    let last = '';
    while (Date.now() - t0 < timeoutMs) {
      const o = await readProgress();
      last = o.status;
      if (o.progressHidden && (appeared || o.status !== statusBefore)) {
        return { ok: true, status: o.status, ms: Date.now() - t0, appeared };
      }
      await wait(250);
    }
    return { ok: false, status: last, timeout: true };
  }

  // —— 夹具 ——
  if (ffmpeg) {
    result.steps.fixtures = makeFixtures(ffmpeg);
  } else {
    result.steps.fixtures = [{ ok: false, error: '未检测到 ffmpeg，未生成夹具' }];
  }

  await shot('30-音频测试起点');

  // —— 1) 切到音频格式转换，检查界面元素（分组下拉 21 项 / 无损禁用音质） ——
  result.steps.switch = await clickTool('音频格式转换');
  await wait(500);
  result.checks.界面 = JSON.parse(await evalJs(`(() => {
    const sel = document.querySelector('#acTarget');
    const q = document.querySelector('#acQuality');
    const note = document.querySelector('#acLosslessNote');
    if (!sel || !q || !note) return JSON.stringify({ ok: false, reason: '界面元素缺失' });
    const setT = (v) => { sel.value = v; sel.dispatchEvent(new Event('change')); };
    setT('wav');
    const lossless = { disabled: q.disabled, noteHidden: note.hidden };
    setT('mp3');
    const normal = { disabled: q.disabled, noteHidden: note.hidden };
    const groups = [...sel.querySelectorAll('optgroup')].map((g) => g.label);
    const optionCount = sel.querySelectorAll('option').length;
    return JSON.stringify({
      ok: lossless.disabled === true && lossless.noteHidden === false
        && normal.disabled === false && normal.noteHidden === true
        && groups.length === 2 && optionCount === 21,
      lossless, normal, groups, optionCount
    });
  })()`));

  // —— 2) 添加夹具（3 个：wav / mp3 / 带音轨视频），列表应显示「视频（提取声音）」 ——
  const before1 = new Set(await fs.readdir(TEST_DIR));
  result.steps.added = await clickSel('[data-add]');
  await wait(2200);
  result.checks.添加列表 = JSON.parse(await evalJs(`(() => {
    const items = [...document.querySelectorAll('#acList .ac-item')];
    const metas = items.map((li) => (li.querySelector('.ac-item-meta') || {}).textContent || '');
    return JSON.stringify({
      ok: items.length === 3 && metas.some((m) => m.includes('视频（提取声音）')) && metas.some((m) => m.includes('44.1 kHz')),
      count: items.length, metas
    });
  })()`));
  await shot('31-音频已添加');

  // —— 3) 第一轮：输出 M4A，点运行，校验产物解码 ——
  result.steps.setM4a = await setSelect('#acTarget', 'm4a');
  const statusBefore1 = await getStatus();
  result.steps.ran1 = await clickSel('[data-run]');
  const finish1 = await waitForFinish(statusBefore1, 180000);
  await shot('32-音频M4A完成');
  const after1 = await fs.readdir(TEST_DIR);
  const new1 = after1.filter((f) => !before1.has(f) && /^测试音频/.test(f));
  result.checks.第一轮 = {
    finish: finish1,
    newFiles: new1,
    checks: new1.map((f) => {
      const full = path.join(TEST_DIR, f);
      const check = { file: f, bytes: 0 };
      try { check.bytes = fsSync.statSync(full).size; } catch { /* 忽略 */ }
      if (ffmpeg && check.bytes > 0) check.decode = decodeCheck(ffmpeg, full);
      return check;
    }),
    ok: !!finish1.ok && new1.length === 3 && new1.every((f) => /\.m4a$/i.test(f))
      && new1.every((f) => {
        const full = path.join(TEST_DIR, f);
        return fsSync.statSync(full).size > 0 && (!ffmpeg || decodeCheck(ffmpeg, full).ok);
      })
  };

  // —— 4) 第二轮：换成 OGG 再运行一次（同一列表，验证换格式重跑） ——
  const before2 = new Set(await fs.readdir(TEST_DIR));
  result.steps.setOgg = await setSelect('#acTarget', 'ogg');
  const statusBefore2 = await getStatus();
  result.steps.ran2 = await clickSel('[data-run]');
  const finish2 = await waitForFinish(statusBefore2, 180000);
  await shot('33-音频OGG完成');
  const after2 = await fs.readdir(TEST_DIR);
  const new2 = after2.filter((f) => !before2.has(f) && /^测试音频/.test(f));
  result.checks.第二轮 = {
    finish: finish2,
    newFiles: new2,
    ok: !!finish2.ok && new2.length === 3 && new2.every((f) => /\.ogg$/i.test(f))
      && new2.every((f) => {
        const full = path.join(TEST_DIR, f);
        return fsSync.statSync(full).size > 0 && (!ffmpeg || decodeCheck(ffmpeg, full).ok);
      })
  };

  // —— 5) 清空按钮 ——
  result.steps.cleared = await clickSel('[data-clear]');
  await wait(400);
  result.checks.清空 = JSON.parse(await evalJs(`(() => {
    const items = document.querySelectorAll('#acList .ac-item').length;
    const dropHidden = document.getElementById('acDrop').hidden;
    return JSON.stringify({ ok: items === 0 && dropHidden === false, items, dropHidden });
  })()`));
  await shot('34-音频已清空');

  // —— 汇总 ——
  const keys = Object.keys(result.checks);
  result.pass = keys.length >= 5 && keys.every((k) => result.checks[k].ok === true)
    && result.steps.switch === true && result.steps.added === true
    && result.steps.ran1 === true && result.steps.ran2 === true;
  writeResult({ ok: !!result.pass, at: new Date().toISOString(), result });
  return result;
}

module.exports = { runAudioUiTest, writeResult, TEST_DIR };