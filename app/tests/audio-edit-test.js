// 音频剪辑工具自检（仅 `electron . --audio-edit-test` 时运行）
// 覆盖：core/waveform.js 纯函数单测（自造 WAV 解析、峰值分桶、坐标换算、选区合法化、
//       「有滤镜/无滤镜/拼接」三种 buildEditPlan 参数差异）+ 真实转码校验
//       （① 纯截取走 copy 极速路径 ② 截取+淡入淡出+音量重编码 ③ 换目标格式输出），
//       产物用 ffmpeg 回读校验时长/编码/采样率。
// 结果写入 %TEMP%/tomato-audio-edit-test.json，同时打印 AUDIO_EDIT_TEST {...}。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawnSync } = require('child_process');
const { app } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-audio-edit-test.json');
/** 本测试在共用夹具目录里的文件前缀：清理只认它，绝不误删别的工具的夹具 */
const OWN_PREFIX = '测试剪辑音频';

function writeResult(payload) {
  fsSync.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

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

/** 用 ffmpeg 完整解码一遍（校验产物确实是有效音频文件，而不只是「有字节」） */
function decodeCheck(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], {
    windowsHide: true, encoding: 'utf8', timeout: 120000
  });
  return { ok: r.status === 0, error: String(r.stderr || '').trim().slice(0, 200) };
}

/** 读音频信息（时长/编码/采样率/声道） */
function probeByFfmpeg(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  const err = String(r.stderr || '');
  const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  const audio = /Audio: ([^,]+), (\d+) Hz, ([^,]+)/.exec(err);
  return {
    durationSec: dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : 0,
    codec: audio ? audio[1].trim().split(' ')[0] : '',
    sampleRate: audio ? Number(audio[2]) : 0,
    channelLayout: audio ? audio[3].trim() : ''
  };
}

/** 只清理本测试自己的夹具/产物（开跑清一次、收尾清一次，清所有扩展名） */
async function cleanOwn() {
  const before = (await fs.readdir(TEST_DIR).catch(() => [])).filter((f) => f.startsWith(OWN_PREFIX));
  for (const f of before) await fs.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
  const after = (await fs.readdir(TEST_DIR).catch(() => [])).filter((f) => f.startsWith(OWN_PREFIX));
  return { before, after };
}

/** 造夹具：6 秒正弦波 wav + 由其转出的 mp3（copy 路径需要同容器）+ 2s/3s 拼接用短段 */
function makeFixtures(ffmpeg) {
  const made = [];
  const run = (args, name) => {
    const r = spawnSync(ffmpeg, args, { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    made.push({ name, ok: r.status === 0, error: r.status === 0 ? '' : String(r.stderr || '').slice(-200) });
  };
  const wav = path.join(TEST_DIR, `${OWN_PREFIX}-源.wav`);
  run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=6', '-ac', '2', '-ar', '44100', wav], `${OWN_PREFIX}-源.wav`);
  run(['-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '192k', path.join(TEST_DIR, `${OWN_PREFIX}-源.mp3`)], `${OWN_PREFIX}-源.mp3`);
  // 拼接夹具：不同频率/时长，拼完能从时长上验证「确实是顺序合并」
  run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2', '-ac', '2', '-ar', '44100',
    path.join(TEST_DIR, `${OWN_PREFIX}-段A2s.wav`)], `${OWN_PREFIX}-段A2s.wav`);
  run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:duration=3', '-ac', '2', '-ar', '44100',
    path.join(TEST_DIR, `${OWN_PREFIX}-段B3s.wav`)], `${OWN_PREFIX}-段B3s.wav`);
  return made;
}

async function runAudioEditTest(win) {
  const evalJs = (code) => win.webContents.executeJavaScript(code);
  const result = { ok: false, checks: {}, notes: [] };
  const ffmpeg = findFfmpeg();
  result.ffmpeg = { found: !!ffmpeg, path: ffmpeg || '' };

  await fs.mkdir(TEST_DIR, { recursive: true });
  result.steps = { cleanBefore: await cleanOwn() };

  // —— 1) core/waveform.js 纯函数单测（渲染进程内 import 真实模块，不碰 ffmpeg） ——
  try {
    const out = JSON.parse(await evalJs(`(async () => {
      const W = await import('../tools/audio-edit/core/waveform.js');
      const out = {};

      // 自造一个 8kHz 单声道 16-bit WAV：800 个采样点（=100ms）
      const makeWav = (sampleRate, int16) => {
        const n = int16.length;
        const buf = new ArrayBuffer(44 + n * 2);
        const dv = new DataView(buf);
        const wr = (o, s) => { for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i)); };
        wr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE');
        wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
        dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
        dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
        wr(36, 'data'); dv.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i += 1) dv.setInt16(44 + i * 2, int16[i], true);
        return new Uint8Array(buf);
      };
      const int16 = new Array(800).fill(0).map((_, i) => (i % 2 === 0 ? 16384 : -16384));
      const parsed = W.parseWav(makeWav(8000, int16));
      out.wav = {
        sampleRate: parsed.sampleRate, channels: parsed.channels,
        len: parsed.samples.length, durationMs: Math.round(parsed.durationMs),
        first: Number(parsed.samples[0].toFixed(4)), second: Number(parsed.samples[1].toFixed(4))
      };
      out.wavBad = (() => {
        const p = W.parseWav(new Uint8Array([1, 2, 3]));
        return { len: p.samples.length, sampleRate: p.sampleRate };
      })();

      // 峰值分桶：8 个采样 / 4 桶，每桶 2 个
      const peaks = W.buildPeaks(new Float32Array([0.1, 0.5, 0.9, 0.2, -0.7, -0.1, 0.3, 0.4]), 4);
      out.peaks = { len: peaks.length, values: [...peaks].map((v) => Number(v.toFixed(3))) };
      out.peaksEmpty = W.buildPeaks(new Float32Array(0), 4).length;
      out.peaksZero = W.buildPeaks(new Float32Array([0.2, 0.3]), 0).length;

      // 坐标换算
      out.coord = {
        mid: W.msToPx(1500, 6000, 300),
        roundtrip: W.pxToMs(W.msToPx(1500, 6000, 300), 6000, 300),
        under: W.msToPx(-100, 6000, 300),
        over: W.msToPx(99999, 6000, 300)
      };

      // 选区合法化
      out.sel = [
        W.normalizeSelection({ startMs: -100, endMs: 99999, durationMs: 6000 }),
        W.normalizeSelection({ startMs: 3000, endMs: 1000, durationMs: 6000 }),
        W.normalizeSelection({ startMs: 0, endMs: 0, durationMs: 6000 }),
        W.normalizeSelection({ startMs: 2000, endMs: 2000, durationMs: 6000 }),
        W.normalizeSelection({ startMs: 0, endMs: 0, durationMs: 0 })
      ];

      // 时间文案
      out.time = {
        f1: W.formatTimeMs(83500), f2: W.formatTimeMs(3723500),
        p1: W.parseTimeToMs('01:23.500'), p2: W.parseTimeToMs('90'),
        bad: Number.isNaN(W.parseTimeToMs('abc'))
      };

      // buildEditPlan：① 纯截取（同容器 → copy 极速路径）
      const itemMp3 = { ext: '.mp3', isVideo: false, durationMs: 6000 };
      const copyPlan = W.buildEditPlan(itemMp3, { target: 'mp3', quality: 'standard', startMs: 1000, endMs: 4000 });
      out.copyPlan = { mode: copyPlan.mode, ext: copyPlan.ext, inputArgs: copyPlan.inputArgs, args: copyPlan.args, durationMs: copyPlan.durationMs, copy: copyPlan.copy, hasFilter: copyPlan.hasFilter, inputCount: copyPlan.inputCount, needsMultipleInputs: copyPlan.needsMultipleInputs };
      // ② 截取 + 淡入淡出 + 音量（必须重编码）
      const fxPlan = W.buildEditPlan(itemMp3, {
        target: 'mp3', quality: 'standard', startMs: 1000, endMs: 5000,
        gainDb: 3, fadeInMs: 500, fadeOutMs: 500
      });
      out.fxPlan = { mode: fxPlan.mode, args: fxPlan.args, inputArgs: fxPlan.inputArgs, durationMs: fxPlan.durationMs, copy: fxPlan.copy, hasFilter: fxPlan.hasFilter, estimated: fxPlan.estimated };
      // ③ 音量标准化（loudnorm）
      const normPlan = W.buildEditPlan(itemMp3, { target: 'mp3', quality: 'standard', startMs: 0, endMs: 6000, gainDb: 'normalize' });
      out.normPlan = normPlan.args.join(' ');
      // ④ 换格式 + 视频输入（自动去视频流 -vn）
      const vidPlan = W.buildEditPlan({ ext: '.mp4', isVideo: true, durationMs: 6000 }, { target: 'm4a', quality: 'standard', startMs: 0, endMs: 6000 });
      out.vidPlan = { args: vidPlan.args, copy: vidPlan.copy };
      const wavPlan = W.buildEditPlan({ ext: '.wav', isVideo: false, durationMs: 6000 }, { target: 'flac', quality: 'high', startMs: 0, endMs: 6000 });
      out.wavPlan = { ext: wavPlan.ext, args: wavPlan.args, copy: wavPlan.copy };
      // ⑤ 拼接（多输入 IPC convertMediaMulti）：总时长取各段之和，截取/滤镜参数被忽略
      const ccPlan = W.buildEditPlan(itemMp3, {
        target: 'mp3', quality: 'standard', concatCount: 3,
        segmentDurationsMs: [2000, 3000, 1000],
        startMs: 500, endMs: 900, gainDb: 6, fadeInMs: 1000 // 拼接时应被忽略
      });
      out.concatPlan = {
        mode: ccPlan.mode, args: ccPlan.args, inputArgs: ccPlan.inputArgs, inputCount: ccPlan.inputCount,
        durationMs: ccPlan.durationMs, estimated: ccPlan.estimated,
        concat: ccPlan.concat, needsMultipleInputs: ccPlan.needsMultipleInputs, copy: ccPlan.copy, hasFilter: ccPlan.hasFilter
      };
      // 拼接：显式 totalDurationMs 优先
      const ccExplicit = W.buildEditPlan(itemMp3, { target: 'm4a', quality: 'standard', concatCount: 2, segmentDurationsMs: [2000, 3000], totalDurationMs: 4321 });
      out.concatExplicit = { durationMs: ccExplicit.durationMs, ext: ccExplicit.ext };
      // 拼接段数不足 2 → 退回单文件模式
      const ccOne = W.buildEditPlan(itemMp3, { target: 'mp3', quality: 'standard', concatCount: 1, startMs: 0, endMs: 6000 });
      out.concatOne = { mode: ccOne.mode, concat: ccOne.concat };

      out.exts = [W.AUDIO_EXTS.includes('.mp3'), W.AUDIO_EXTS.includes('.mp4'), W.VIDEO_INPUT_EXTS.includes('.mp4')];
      out.buckets = W.WAVE_BUCKETS;
      return JSON.stringify(out);
    })()`));

    const ok = out.wav.sampleRate === 8000 && out.wav.channels === 1 && out.wav.len === 800
      && out.wav.durationMs === 100 && out.wav.first === 0.5 && out.wav.second === -0.5
      && out.wavBad.len === 0 && out.wavBad.sampleRate === 0
      && out.peaks.len === 4 && out.peaks.values.join('|') === '0.5|0.9|0.7|0.4'
      && out.peaksEmpty === 4 && out.peaksZero === 0
      && out.coord.mid === 75 && out.coord.roundtrip === 1500 && out.coord.under === 0 && out.coord.over === 300
      && out.sel[0].startMs === 0 && out.sel[0].endMs === 6000
      && out.sel[1].startMs === 3000 && out.sel[1].endMs === 6000
      && out.sel[2].startMs === 0 && out.sel[2].endMs === 6000
      && out.sel[3].startMs === 2000 && out.sel[3].endMs === 6000
      && out.sel[4].startMs === 0 && out.sel[4].endMs === 0
      && out.time.f1 === '01:23.500' && out.time.f2 === '1:02:03.500'
      && out.time.p1 === 83500 && out.time.p2 === 90000 && out.time.bad === true
      && out.copyPlan.mode === 'single' && out.copyPlan.copy === true && out.copyPlan.args.join(' ') === '-c:a copy'
      && out.copyPlan.inputArgs.join(' ') === '-ss 1.000 -to 4.000' && out.copyPlan.durationMs === 3000
      && out.copyPlan.inputCount === 1 && out.copyPlan.needsMultipleInputs === false
      && out.fxPlan.mode === 'single' && out.fxPlan.copy === false && out.fxPlan.hasFilter === true
      && out.fxPlan.args.join(' ').includes('volume=3dB')
      && out.fxPlan.args.join(' ').includes('afade=t=in:st=0:d=0.500')
      && out.fxPlan.args.join(' ').includes('afade=t=out:st=3.500:d=0.500')
      && out.fxPlan.args.join(' ').includes('libmp3lame') && out.fxPlan.estimated > 0
      && out.normPlan.includes('loudnorm=I=-16')
      && out.vidPlan.args.join(' ').includes('-vn') && out.vidPlan.copy === false
      && out.wavPlan.ext === '.flac' && out.wavPlan.args.join(' ').includes('flac') && out.wavPlan.copy === false
      && out.concatPlan.mode === 'concat' && out.concatPlan.concat === true && out.concatPlan.needsMultipleInputs === true
      && out.concatPlan.inputCount === 3 && out.concatPlan.copy === false && out.concatPlan.hasFilter === false
      && out.concatPlan.inputArgs.join('') === ''       // 拼接忽略截取参数
      && out.concatPlan.durationMs === 6000             // 各段之和 2000+3000+1000
      && !out.concatPlan.args.join(' ').includes('volume') && !out.concatPlan.args.join(' ').includes('afade')  // 滤镜被忽略
      && out.concatPlan.args.join(' ').includes('[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]')
      && out.concatPlan.args.join(' ').includes('libmp3lame') && out.concatPlan.estimated > 0
      && out.concatExplicit.durationMs === 4321 && out.concatExplicit.ext === '.m4a'  // 显式总时长优先
      && out.concatOne.mode === 'single' && out.concatOne.concat === false            // 段数不足 2 退回单文件
      && out.exts.join('|') === 'true|false|true'
      && out.buckets === 1024;

    result.checks.logic = { ...out, ok };
    if (!ok) result.notes.push('core/waveform.js 纯函数单测未全部通过，见 checks.logic');
  } catch (err) {
    result.checks.logic = { ok: false, error: err.message };
  }

  // —— 2) 真实转码（走真实 IPC，与界面同一条路） ——
  result.checks.conversions = { cases: [], ok: false, passed: 0, total: 3 };
  if (ffmpeg) {
    result.steps.fixtures = makeFixtures(ffmpeg);
    const srcWav = path.join(TEST_DIR, `${OWN_PREFIX}-源.wav`);
    const srcMp3 = path.join(TEST_DIR, `${OWN_PREFIX}-源.mp3`);
    if (!fsSync.existsSync(srcWav) || !fsSync.existsSync(srcMp3)) {
      result.notes.push('夹具生成失败：无法生成测试音频');
    }

    const runCase = async (label, expect, script) => {
      const entry = { label, expect };
      try {
        const r = JSON.parse(await evalJs(script));
        entry.plan = r.plan;
        entry.result = r.r;
        if (r.r && r.r.ok && r.r.path) {
          const dec = decodeCheck(ffmpeg, r.r.path);
          const info = probeByFfmpeg(ffmpeg, r.r.path);
          entry.size = r.r.size;
          entry.ms = r.r.ms;
          entry.info = info;
          entry.decodeOk = dec.ok;
          entry.durationOk = Math.abs((info.durationSec || 0) - expect.durationSec) <= expect.tolerance;
          entry.codecOk = !expect.codec || info.codec.includes(expect.codec);
          entry.sampleRateOk = !expect.sampleRate || info.sampleRate === expect.sampleRate;
          entry.ok = dec.ok && entry.durationOk && entry.codecOk && entry.sampleRateOk;
          if (!dec.ok) entry.decodeError = dec.error;
          if (!entry.durationOk) entry.durationError = `时长 ${info.durationSec}s（期望约 ${expect.durationSec}s）`;
        } else {
          entry.ok = false;
          entry.error = (r.r && r.r.message) || '剪辑失败';
        }
      } catch (err) {
        entry.ok = false;
        entry.error = err.message;
      }
      return entry;
    };

    // ① 纯截取（copy 极速路径）：mp3 → mp3，取 1s~4s（期望 3 秒）
    result.checks.conversions.cases.push(await runCase('截取-copy', { durationSec: 3, tolerance: 0.5, codec: 'mp3' }, `(async () => {
      const { buildEditPlan } = await import('../tools/audio-edit/core/waveform.js');
      const plan = buildEditPlan({ ext: '.mp3', isVideo: false, durationMs: 6000 },
        { target: 'mp3', quality: 'standard', startMs: 1000, endMs: 4000 });
      const r = await window.desktop.ffmpegConvert({
        inputPath: ${JSON.stringify(srcMp3)}, outputDir: ${JSON.stringify(TEST_DIR)},
        baseName: '${OWN_PREFIX}-截取', ext: plan.ext, inputArgs: plan.inputArgs, args: plan.args,
        durationMs: plan.durationMs, jobId: 'aedit-copy'
      });
      return JSON.stringify({ plan: { copy: plan.copy, inputArgs: plan.inputArgs, args: plan.args, durationMs: plan.durationMs }, r });
    })()`));

    // ② 截取 + 淡入淡出 + 音量（重编码）：mp3 → mp3，取 1s~5s（期望 4 秒）
    result.checks.conversions.cases.push(await runCase('截取+滤镜', { durationSec: 4, tolerance: 0.5, codec: 'mp3' }, `(async () => {
      const { buildEditPlan } = await import('../tools/audio-edit/core/waveform.js');
      const plan = buildEditPlan({ ext: '.mp3', isVideo: false, durationMs: 6000 },
        { target: 'mp3', quality: 'standard', startMs: 1000, endMs: 5000, gainDb: 3, fadeInMs: 500, fadeOutMs: 500 });
      const r = await window.desktop.ffmpegConvert({
        inputPath: ${JSON.stringify(srcMp3)}, outputDir: ${JSON.stringify(TEST_DIR)},
        baseName: '${OWN_PREFIX}-滤镜', ext: plan.ext, inputArgs: plan.inputArgs, args: plan.args,
        durationMs: plan.durationMs, jobId: 'aedit-fx'
      });
      return JSON.stringify({ plan: { copy: plan.copy, inputArgs: plan.inputArgs, args: plan.args, durationMs: plan.durationMs }, r });
    })()`));

    // ③ 换目标格式输出：wav → m4a 全片（期望 6 秒、AAC、44.1kHz）
    result.checks.conversions.cases.push(await runCase('换格式', { durationSec: 6, tolerance: 0.5, codec: 'aac', sampleRate: 44100 }, `(async () => {
      const { buildEditPlan } = await import('../tools/audio-edit/core/waveform.js');
      const plan = buildEditPlan({ ext: '.wav', isVideo: false, durationMs: 6000 },
        { target: 'm4a', quality: 'standard', startMs: 0, endMs: 6000 });
      const r = await window.desktop.ffmpegConvert({
        inputPath: ${JSON.stringify(srcWav)}, outputDir: ${JSON.stringify(TEST_DIR)},
        baseName: '${OWN_PREFIX}-换格式', ext: plan.ext, inputArgs: plan.inputArgs, args: plan.args,
        durationMs: plan.durationMs, jobId: 'aedit-format'
      });
      return JSON.stringify({ plan: { copy: plan.copy, inputArgs: plan.inputArgs, args: plan.args, durationMs: plan.durationMs }, r });
    })()`));

    // ④ 真实拼接（多输入 IPC ffmpegConvertMulti）：2s + 3s = 期望 ~5 秒
    result.checks.conversions.cases.push(await runCase('拼接', { durationSec: 5, tolerance: 0.3, codec: 'mp3' }, `(async () => {
      const { buildEditPlan } = await import('../tools/audio-edit/core/waveform.js');
      const inputs = [${JSON.stringify(path.join(TEST_DIR, `${OWN_PREFIX}-段A2s.wav`))}, ${JSON.stringify(path.join(TEST_DIR, `${OWN_PREFIX}-段B3s.wav`))}];
      const plan = buildEditPlan({ ext: '.wav', isVideo: false, durationMs: 2000 },
        { target: 'mp3', quality: 'standard', concatCount: 2, segmentDurationsMs: [2000, 3000] });
      const r = await window.desktop.ffmpegConvertMulti({
        inputPaths: inputs, outputDir: ${JSON.stringify(TEST_DIR)},
        baseName: '${OWN_PREFIX}-拼接', ext: plan.ext, args: plan.args,
        durationMs: plan.durationMs, jobId: 'aedit-concat-real'
      });
      return JSON.stringify({ plan: { mode: plan.mode, args: plan.args, durationMs: plan.durationMs }, r });
    })()`));

    result.checks.conversions.passed = result.checks.conversions.cases.filter((c) => c.ok).length;
    result.checks.conversions.total = 4;
    result.checks.conversions.ok = result.checks.conversions.passed === result.checks.conversions.total;
  } else {
    result.notes.push('未检测到 ffmpeg，跳过真实转码测试');
  }

  // —— 汇总 ——
  const keys = Object.keys(result.checks);
  result.ok = keys.length > 0 && keys.every((k) => result.checks[k].ok === true);
  // 收尾清理：通过时清干净（失败则保留中间产物便于排查）
  result.steps.cleanAfter = result.ok ? await cleanOwn() : { skipped: '测试未全绿，保留产物便于排查' };
  writeResult({ ok: result.ok, at: new Date().toISOString(), result });
  return result;
}

// ============================================================
// 界面自动测试（仅 `electron . --audio-edit-ui-test` 时运行）
// 做法：切到「音频剪辑」→ 点添加（测试模式下对话框直接返回夹具）→ 等波形画出 →
//       用时间框与鼠标拖动各改一次选区 → 选音量/淡入 → 点开始剪辑 → 校验产物可解码。
// ============================================================

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 造界面测试夹具（3 秒即可，波形与转码都快） */
function makeUiFixtures(ffmpeg) {
  const made = [];
  const run = (args, name) => {
    const r = spawnSync(ffmpeg, args, { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    made.push({ name, ok: r.status === 0, error: r.status === 0 ? '' : String(r.stderr || '').slice(-200) });
  };
  const wav = path.join(TEST_DIR, `${OWN_PREFIX}-界面A.wav`);
  run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4', '-ac', '2', '-ar', '44100', wav], `${OWN_PREFIX}-界面A.wav`);
  run(['-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '192k', path.join(TEST_DIR, `${OWN_PREFIX}-界面B.mp3`)], `${OWN_PREFIX}-界面B.mp3`);
  return made;
}

async function runAudioEditUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [] };
  const ffmpeg = findFfmpeg();
  result.ffmpeg = { found: !!ffmpeg, path: ffmpeg || '' };

  await fs.mkdir(TEST_DIR, { recursive: true });
  result.steps.cleanBefore = await cleanOwn();

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-aedit-${name}.png`);
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
  const setSelect = (sel, value) => evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.value = ${JSON.stringify('')} + ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change'));
    return el.value === ${JSON.stringify(value)};
  })()`);

  /** 切到本工具页：分组默认收起时先点开所在分组，再点工具项 */
  const openTool = () => evalJs(`(() => {
    const wrap = document.querySelector('.tool-group[data-group-id="audio"]');
    if (!wrap) return { ok: false, reason: '找不到音频分组' };
    if (wrap.classList.contains('is-collapsed')) {
      const head = wrap.querySelector('.tool-group-head');
      if (head) head.click();
    }
    const btn = document.querySelector('.tool-item[data-tool-id="audio-edit"]');
    if (!btn) return { ok: false, reason: '找不到工具项（registry 可能未注册）' };
    btn.click();
    return { ok: true };
  })()`);

  /** 等一次运行结束（进度条先出现、再收起；或状态文案变化） */
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
  if (ffmpeg) {
    result.steps.fixtures = makeUiFixtures(ffmpeg);
  } else {
    result.steps.fixtures = [{ ok: false, error: '未检测到 ffmpeg，未生成夹具' }];
  }

  await shot('40-起点');

  // —— 1) 切到「音频剪辑」 ——
  result.steps.switch = await openTool();
  await wait(600);
  result.checks.界面 = JSON.parse(await evalJs(`(() => {
    const need = ['#aeditTarget', '#aeditQuality', '#aeditGain', '#aeditFadeIn', '#aeditFadeOut', '#aeditCanvas', '#aeditStart', '#aeditEnd'];
    const missing = need.filter((s) => !document.querySelector(s));
    const run = document.querySelector('[data-run]');
    const add = document.querySelector('[data-add]');
    const optCount = document.querySelectorAll('#aeditTarget option').length;
    return JSON.stringify({ ok: missing.length === 0 && !!run && !!add && optCount === 21, missing, optCount });
  })()`));

  // —— 2) 添加夹具，等波形画出来 ——
  const before = new Set(await fs.readdir(TEST_DIR));
  result.steps.added = await clickSel('[data-add]');
  await wait(2500);

  let waveReady = null;
  for (let i = 0; i < 60; i += 1) {
    waveReady = JSON.parse(await evalJs(`(() => {
      const c = document.querySelector('#aeditCanvas');
      const items = document.querySelectorAll('#aeditList .aedit-item').length;
      const selected = document.querySelectorAll('#aeditList .aedit-item.is-selected').length;
      const wave = document.querySelector('#aeditWave');
      return JSON.stringify({
        items, selected, waveHidden: wave ? wave.hidden : true,
        ready: c ? c.dataset.ready : '', peaks: c ? Number(c.dataset.peaks || 0) : 0,
        durationMs: c ? Number(c.dataset.durationMs || 0) : 0
      });
    })()`));
    if (waveReady.ready === '1' && waveReady.peaks > 0) break;
    await wait(500);
  }
  // 波形 canvas 非空：既看 data 标记，也看真实像素（与背景不同的像素数）
  const pixels = JSON.parse(await evalJs(`(() => {
    const c = document.querySelector('#aeditCanvas');
    if (!c || !c.width || !c.height) return JSON.stringify({ diff: 0, w: 0, h: 0 });
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const bg = [d[0], d[1], d[2], d[3]];
    let diff = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) + Math.abs(d[i + 3] - bg[3]) > 12) diff += 1;
    }
    return JSON.stringify({ diff, w: c.width, h: c.height });
  })()`));
  result.checks.添加与波形 = {
    list: waveReady,
    pixels,
    ok: waveReady.items >= 2 && waveReady.selected >= 1 && waveReady.waveHidden === false
      && waveReady.ready === '1' && waveReady.peaks > 0 && waveReady.durationMs > 0
      && pixels.diff > 100
  };
  await shot('41-已添加并显示波形');

  // —— 3) 用时间框改选区（验证输入解析与回填） ——
  result.checks.时间框选区 = JSON.parse(await evalJs(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('change')); };
    set('#aeditStart', '00:00.500');
    set('#aeditEnd', '00:02.500');
    const s = document.querySelector('#aeditStart').value;
    const e = document.querySelector('#aeditEnd').value;
    const clip = document.querySelector('#aeditClip').textContent;
    return JSON.stringify({ ok: s === '00:00.500' && e === '00:02.500' && clip.includes('保留'), s, e, clip });
  })()`));

  // —— 4) 鼠标拖动改选区（验证波形拖动与手柄） ——
  result.checks.拖动选区 = JSON.parse(await evalJs(`(() => {
    const c = document.querySelector('#aeditCanvas');
    const r = c.getBoundingClientRect();
    const at = (x) => ({ bubbles: true, clientX: r.left + x, clientY: r.top + r.height / 2 });
    c.dispatchEvent(new MouseEvent('mousedown', at(r.width * 0.1)));
    window.dispatchEvent(new MouseEvent('mousemove', at(r.width * 0.55)));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const s = document.querySelector('#aeditStart').value;
    const e = document.querySelector('#aeditEnd').value;
    return JSON.stringify({ ok: s !== '00:00.500' || e !== '00:02.500', s, e });
  })()`));
  await shot('42-已拖动选区');

  // —— 5) 选音量/淡入，运行 ——
  result.steps.setGain = await setSelect('#aeditGain', '3');
  result.steps.setFadeIn = await setSelect('#aeditFadeIn', '500');
  const statusBefore = await getStatus();
  result.steps.ran = await clickSel('[data-run]');
  const finish = await waitForFinish(statusBefore, 180000);
  await shot('43-剪辑完成');
  const after = await fs.readdir(TEST_DIR);
  // 产物路径以界面为准（列表结果项上挂了 data-out-path），不靠猜目录里多了哪个文件
  const outPaths = JSON.parse(await evalJs(`JSON.stringify(
    [...document.querySelectorAll('#aeditList .aedit-item-result[data-out-path]')].map((d) => d.dataset.outPath)
  )`));
  const uniqOut = [...new Set(outPaths.filter(Boolean))];
  const newFiles = after.filter((f) => !before.has(f) && !f.endsWith('.png')); // 仅作诊断信息
  const results = JSON.parse(await evalJs(`(() => {
    const ok = document.querySelectorAll('#aeditList .aedit-item-result.is-ok').length;
    const fail = document.querySelectorAll('#aeditList .aedit-item-result.is-fail').length;
    const texts = [...document.querySelectorAll('#aeditList .aedit-item-result')].map((d) => d.textContent);
    return JSON.stringify({ ok, fail, texts });
  })()`));
  result.checks.运行 = {
    finish,
    newFiles,
    outPaths: uniqOut,
    listResults: results,
    files: uniqOut.map((p) => {
      const entry = { file: path.basename(p), path: p, bytes: 0 };
      try { entry.bytes = fsSync.statSync(p).size; } catch { /* 忽略 */ }
      if (ffmpeg && entry.bytes > 0) entry.decode = decodeCheck(ffmpeg, p);
      return entry;
    }),
    ok: !!finish.ok && results.ok >= 2 && results.fail === 0 && uniqOut.length >= 2
      && uniqOut.every((p) => fsSync.existsSync(p) && fsSync.statSync(p).size > 0
        && (!ffmpeg || decodeCheck(ffmpeg, p).ok))
  };

  // —— 6) 拼接模式：按列表顺序合并（截取/滤镜不启用），产物时长 ≈ 各段之和 ——
  result.steps.setConcat = await evalJs(`(() => {
    const el = document.querySelector('#aeditConcat');
    if (!el) return false;
    el.checked = true;
    el.dispatchEvent(new Event('change'));
    return el.checked === true;
  })()`);
  await wait(200);
  result.checks.拼接模式 = JSON.parse(await evalJs(`(() => {
    const note = document.querySelector('#aeditModeNote').textContent;
    const run = document.querySelector('#aeditRunBtn');
    return JSON.stringify({
      ok: note.includes('拼接') && note.includes('不启用') && run.disabled === false && run.textContent.includes('拼接'),
      note, runText: run.textContent, runDisabled: run.disabled
    });
  })()`));

  const statusBefore2 = await getStatus();
  result.steps.ranConcat = await clickSel('[data-run]');
  const finishConcat = await waitForFinish(statusBefore2, 180000);
  await shot('44-拼接完成');
  // 产物路径以界面为准（不靠猜目录里多了哪个文件）：
  //   ① 首选底部结果区「输出：<完整路径>」；② 兜底读列表结果项上的 data-out-path
  const concatResultText = String(await evalJs(
    `document.querySelector('#aeditResult') ? document.querySelector('#aeditResult').textContent : ''`
  ));
  const concatOutPaths = JSON.parse(await evalJs(`JSON.stringify(
    [...document.querySelectorAll('#aeditList .aedit-item-result[data-out-path]')].map((d) => d.dataset.outPath)
  )`));
  const concatOut = [...new Set(concatOutPaths.filter(Boolean))];
  let concatFilePath = '';
  const m = /输出：(.+)$/.exec(concatResultText.trim());
  if (m) concatFilePath = m[1].trim();
  if (!concatFilePath && concatOut.length) concatFilePath = concatOut[0];
  // 期望时长 = 列表里各源文件实测时长之和（不依赖固定夹具名）
  const srcPaths = JSON.parse(await evalJs(
    `JSON.stringify([...document.querySelectorAll('#aeditList .aedit-item-name')].map((d) => d.title))`
  ));
  const sumSec = ffmpeg ? srcPaths.reduce((s, p) => s + (probeByFfmpeg(ffmpeg, p).durationSec || 0), 0) : 0;
  const concatInfo = concatFilePath && ffmpeg ? probeByFfmpeg(ffmpeg, concatFilePath) : { durationSec: 0 };
  const concatSize = concatFilePath && fsSync.existsSync(concatFilePath) ? fsSync.statSync(concatFilePath).size : 0;
  const concatResults = JSON.parse(await evalJs(`(() => {
    const ok = document.querySelectorAll('#aeditList .aedit-item-result.is-ok').length;
    const fail = document.querySelectorAll('#aeditList .aedit-item-result.is-fail').length;
    return JSON.stringify({ ok, fail });
  })()`));
  result.checks.拼接 = {
    finish: finishConcat,
    resultText: concatResultText,
    outPaths: concatOut,
    srcCount: srcPaths.length,
    sumSec: Number(sumSec.toFixed(2)),
    output: { file: path.basename(concatFilePath), path: concatFilePath, size: concatSize, info: concatInfo },
    listResults: concatResults,
    ok: !!finishConcat.ok && !!concatFilePath && srcPaths.length >= 2
      && Math.abs((concatInfo.durationSec || 0) - sumSec) <= 0.5
      && concatSize > 0
      && (!ffmpeg || decodeCheck(ffmpeg, concatFilePath).ok)
      && concatResults.ok >= srcPaths.length && concatResults.fail === 0
  };

  // —— 7) 清空 ——
  result.steps.cleared = await clickSel('[data-clear]');
  await wait(400);
  result.checks.清空 = JSON.parse(await evalJs(`(() => {
    const items = document.querySelectorAll('#aeditList .aedit-item').length;
    const wave = document.querySelector('#aeditWave');
    const drop = document.querySelector('#aeditDrop');
    return JSON.stringify({ ok: items === 0 && wave.hidden === true && drop.hidden === false, items, waveHidden: wave.hidden, dropHidden: drop.hidden });
  })()`));
  await shot('45-已清空');

  // —— 汇总 ——
  const keys = Object.keys(result.checks);
  result.pass = keys.length >= 6 && keys.every((k) => result.checks[k].ok === true)
    && result.steps.switch && result.steps.switch.ok === true
    && result.steps.added === true && result.steps.ran === true
    && result.steps.setConcat === true && result.steps.ranConcat === true;
  result.steps.cleanAfter = result.pass ? await cleanOwn() : { skipped: '测试未全绿，保留产物便于排查' };
  writeResult({ ok: !!result.pass, at: new Date().toISOString(), result });
  return result;
}

module.exports = { runAudioEditTest, runAudioEditUiTest, writeResult, TEST_DIR };
