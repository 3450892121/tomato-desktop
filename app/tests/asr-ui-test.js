// 语音转文字界面自动测试（仅 `electron . --asr-ui-test` 时运行）
// 做法：像真人一样「切到语音转文字 → 点添加（测试模式下对话框直接返回夹具）→ 选输出内容 → 点开始识别 → 等完成」，
//      每步截图，并对比运行前后测试目录的新增文件、校验 .txt 关键词与 .srt 时间戳。
// 覆盖：3 选项输出下拉、含视频文件（自动提取声音）、两轮识别（文本+字幕 / 纯文本→重名自动加序号，不覆盖）、清空。
// 结果写入 %TEMP%/tomato-asr-ui-test.json，截图落在 %TEMP%/tomato-uitest。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawnSync } = require('child_process');
const { app } = require('electron');

const { makeSpeechWav, SPEECH_TEXT, SPEECH_KEYWORDS } = require('./asr-test.js');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-asr-ui-test.json');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 本测试的夹具与产物前缀（清理范围也仅限它，避免与其它界面测试的夹具相互污染） */
const FIXTURE_PREFIX = /^测试语音/;

const addonBase = () => (app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..'));

/** 与主进程一致的 ffmpeg 探测（加装包优先，其次系统 PATH） */
function findFfmpeg() {
  const addon = path.join(addonBase(), 'addons', 'ffmpeg', 'ffmpeg.exe');
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

const readText = (p) => {
  try { return fsSync.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
};

/** 造夹具：中文语音 wav（SAPI 离线合成）+ 带该语音音轨的视频 mp4（ffmpeg） */
function makeFixtures(ffmpeg) {
  const made = [];
  const wav = path.join(TEST_DIR, '测试语音A.wav');
  const mp4 = path.join(TEST_DIR, '测试语音B.mp4');
  const speech = makeSpeechWav(wav, SPEECH_TEXT);
  made.push({ name: '测试语音A.wav', ok: !!speech.ok, error: speech.error || '' });
  if (ffmpeg && speech.ok) {
    const r = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=15',
      '-i', wav, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-pix_fmt', 'yuv420p', mp4],
      { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    made.push({ name: '测试语音B.mp4', ok: r.status === 0, error: r.status === 0 ? '' : String(r.stderr || '').slice(-200) });
  } else {
    made.push({ name: '测试语音B.mp4', ok: false, error: ffmpeg ? '语音夹具生成失败' : '未检测到 ffmpeg' });
  }
  return made;
}

async function runAsrUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [] };
  const ffmpeg = findFfmpeg();
  result.ffmpeg = { found: !!ffmpeg, path: ffmpeg || '' };

  await fs.mkdir(TEST_DIR, { recursive: true });

  // —— 清理上次夹具与产物（本测试只认「测试语音*」；清理前/后各记一次匹配文件，防「产物混进列表」类问题） ——
  const cleanBefore = (await fs.readdir(TEST_DIR)).filter((f) => FIXTURE_PREFIX.test(f));
  for (const f of await fs.readdir(TEST_DIR)) {
    if (FIXTURE_PREFIX.test(f)) {
      await fs.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
    }
  }
  const cleanAfter = (await fs.readdir(TEST_DIR)).filter((f) => FIXTURE_PREFIX.test(f));
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

  /** 等一次运行结束：进度条先出现、再收起（或状态文案变化）才算完成 */
  async function waitForFinish(statusBefore, timeoutMs) {
    const t0 = Date.now();
    const readProgress = async () => JSON.parse(await evalJs(`JSON.stringify({
      status: document.getElementById('statusText').textContent,
      progressHidden: document.getElementById('progressBar').hidden
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
      await wait(250);
    }
    return { ok: false, status: last, timeout: true };
  }

  // —— 夹具 ——
  result.steps.fixtures = makeFixtures(ffmpeg);

  await shot('40-语音测试起点');

  // —— 1) 切到语音转文字，检查界面元素（3 选项输出下拉 + 引擎就绪提示） ——
  result.steps.switch = await clickTool('语音转文字');
  await wait(900); // 等加装包状态检测回来
  result.checks.界面 = JSON.parse(await evalJs(`(() => {
    const sel = document.querySelector('#trMode');
    const note = document.querySelector('#trNote');
    if (!sel || !note) return JSON.stringify({ ok: false, reason: '界面元素缺失' });
    const optionCount = sel.querySelectorAll('option').length;
    const noteText = note.textContent || '';
    return JSON.stringify({
      ok: optionCount === 3 && noteText.includes('已就绪'),
      optionCount, noteText, noteClass: note.className
    });
  })()`));

  // —— 2) 添加夹具（语音 wav + 带语音的视频），列表应显示「视频（提取声音）」 ——
  const before1 = new Set(await fs.readdir(TEST_DIR));
  result.steps.added = await clickSel('[data-add]');
  await wait(2600);
  result.checks.添加列表 = JSON.parse(await evalJs(`(() => {
    const items = [...document.querySelectorAll('#trList .tr-item')];
    const metas = items.map((li) => (li.querySelector('.tr-item-meta') || {}).textContent || '');
    return JSON.stringify({
      ok: items.length === 2 && metas.some((m) => m.includes('视频（提取声音）')),
      count: items.length, metas
    });
  })()`));
  await shot('41-语音已添加');

  // —— 3) 第一轮：输出「文本 + 字幕」，点运行，校验 4 个产物（2 txt + 2 srt） ——
  result.steps.setBoth = await setSelect('#trMode', 'both');
  const statusBefore1 = await getStatus();
  result.steps.ran1 = await clickSel('[data-run]');
  const finish1 = await waitForFinish(statusBefore1, 300000);
  await shot('42-语音识别完成');
  const after1 = await fs.readdir(TEST_DIR);
  const new1 = after1.filter((f) => !before1.has(f) && FIXTURE_PREFIX.test(f));
  const txtA1 = path.join(TEST_DIR, '测试语音A.txt');
  const srtA1 = path.join(TEST_DIR, '测试语音A.srt');
  const txtA1Content = readText(txtA1) || '';
  const srtA1Content = readText(srtA1) || '';
  result.checks.第一轮 = {
    finish: finish1,
    newFiles: new1,
    txtSample: txtA1Content.trim().slice(0, 60),
    ok: !!finish1.ok
      && new1.length === 4
      && new1.filter((f) => /\.txt$/i.test(f)).length === 2
      && new1.filter((f) => /\.srt$/i.test(f)).length === 2
      && SPEECH_KEYWORDS.every((k) => txtA1Content.includes(k))
      && !txtA1Content.includes('-->')
      && srtA1Content.includes('-->')
      && new1.every((f) => { try { return fsSync.statSync(path.join(TEST_DIR, f)).size > 0; } catch { return false; } })
  };

  // —— 4) 第二轮：换成「纯文本」再跑一次（重名自动加序号，绝不覆盖第一轮产物） ——
  const before2 = new Set(await fs.readdir(TEST_DIR));
  result.steps.setTxt = await setSelect('#trMode', 'txt');
  const statusBefore2 = await getStatus();
  result.steps.ran2 = await clickSel('[data-run]');
  const finish2 = await waitForFinish(statusBefore2, 300000);
  await shot('43-语音二轮完成');
  const after2 = await fs.readdir(TEST_DIR);
  const new2 = after2.filter((f) => !before2.has(f) && FIXTURE_PREFIX.test(f));
  result.checks.第二轮 = {
    finish: finish2,
    newFiles: new2,
    ok: !!finish2.ok && new2.length === 2
      && new2.every((f) => /\.txt$/i.test(f) && /\(1\)/.test(f))
      && new2.every((f) => { try { return fsSync.statSync(path.join(TEST_DIR, f)).size > 0; } catch { return false; } })
  };

  // —— 5) 清空按钮 ——
  result.steps.cleared = await clickSel('[data-clear]');
  await wait(400);
  result.checks.清空 = JSON.parse(await evalJs(`(() => {
    const items = document.querySelectorAll('#trList .tr-item').length;
    const dropHidden = document.getElementById('trDrop').hidden;
    return JSON.stringify({ ok: items === 0 && dropHidden === false, items, dropHidden });
  })()`));
  await shot('44-语音已清空');

  // —— 汇总 ——
  const keys = Object.keys(result.checks);
  result.pass = keys.length >= 5 && keys.every((k) => result.checks[k].ok === true)
    && result.steps.switch === true && result.steps.added === true
    && result.steps.ran1 === true && result.steps.ran2 === true;
  writeResult({ ok: !!result.pass, at: new Date().toISOString(), result });
  return result;
}

module.exports = { runAsrUiTest, writeResult, TEST_DIR };