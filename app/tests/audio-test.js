// 音频工具自检（仅 `electron . --audio-test` 时运行）
// 覆盖：计划逻辑单测（21 种输出、无损/AMR/MP2 特殊参数、视频 -vn、文案函数）、
//       21 种输出格式真实转码（走真实 IPC，与界面同一条路）+ 逐个 ffmpeg 回读校验、
//       视频提取音频、标签（标题/歌手）保留、无效文件报错。
// 结果写入 %TEMP%/tomato-audio-test.json，同时打印 AUDIO_TEST {...}。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawnSync } = require('child_process');
const { app } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-audiotest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-audio-test.json');

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

/** ffmpeg 完整解码一遍（校验产物确实是有效音频文件，而不只是「有字节」） */
function decodeCheck(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], {
    windowsHide: true, encoding: 'utf8', timeout: 120000
  });
  return { ok: r.status === 0, error: String(r.stderr || '').trim().slice(0, 200) };
}

/** 读音频信息（时长/编码/采样率/声道/标签），用于「确实转出了正确的东西」的交叉校验 */
function probeByFfmpeg(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  const err = String(r.stderr || '');
  const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  const audio = /Audio: ([^,]+), (\d+) Hz, ([^,]+)/.exec(err);
  const title = /^\s*title\s*:\s*(.+)$/m.exec(err);
  const artist = /^\s*artist\s*:\s*(.+)$/m.exec(err);
  return {
    durationSec: dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : 0,
    codec: audio ? audio[1].trim().split(' ')[0] : '',
    sampleRate: audio ? Number(audio[2]) : 0,
    channelLayout: audio ? audio[3].trim() : '',
    title: title ? title[1].trim() : '',
    artist: artist ? artist[1].trim() : ''
  };
}

/** 21 种输出格式（与 shared/ffmpeg.js 的 AUDIO_TARGETS 一一对应；plan 单测里有数量断言防止漏同步） */
const OUTPUT_TARGETS = [
  ['mp3', '.mp3'], ['m4a', '.m4a'], ['wav', '.wav'], ['flac', '.flac'], ['ogg', '.ogg'], ['opus', '.opus'],
  ['wma', '.wma'], ['amr', '.amr'], ['aac', '.aac'], ['m4a-alac', '.m4a'], ['aiff', '.aiff'], ['caf', '.caf'],
  ['wv', '.wv'], ['tta', '.tta'], ['ac3', '.ac3'], ['eac3', '.eac3'], ['mp2', '.mp2'], ['spx', '.spx'],
  ['au', '.au'], ['w64', '.w64'], ['ra', '.ra']
];

async function runAudioTest(win) {
  const evalJs = (code) => win.webContents.executeJavaScript(code);
  const result = { ok: false, checks: {}, notes: [] };
  const ffmpeg = findFfmpeg();
  result.ffmpeg = { found: !!ffmpeg, path: ffmpeg || '' };

  await fs.mkdir(TEST_DIR, { recursive: true });
  // 清理上次产物（只删本测试自己的 at-* 文件）
  for (const f of await fs.readdir(TEST_DIR).catch(() => [])) {
    if (f.startsWith('at-')) await fs.rm(path.join(TEST_DIR, f), { force: true });
  }

  // —— 1) 计划逻辑单测（渲染进程内直接调工具 core，纯逻辑，不碰 ffmpeg） ——
  try {
    const out = JSON.parse(await evalJs(`(async () => {
      const out = {};
      const { AUDIO_TARGETS } = await import('../shared/ffmpeg.js');
      const { targetOf, buildPlan, formatMeta, formatChannels, formatSampleRate, formatDuration, AUDIO_EXTS, VIDEO_INPUT_EXTS } =
        await import('../tools/audio-convert/core/plan.js');
      out.targetCount = AUDIO_TARGETS.length;
      out.commonCount = AUDIO_TARGETS.filter((t) => t.group === 'common').length;
      out.allHaveExt = AUDIO_TARGETS.every((t) => /^\\.[a-z0-9]+$/.test(t.ext));
      out.allHaveLabel = AUDIO_TARGETS.every((t) => !!t.label);
      out.unknownFallback = targetOf('nope').value;
      const p1 = buildPlan({ isVideo: false, durationSec: 3 }, { target: 'mp3', quality: 'high' });
      out.audioPlan = [p1.ext, p1.args.join(' ')];
      const p2 = buildPlan({ isVideo: true, durationSec: 3 }, { target: 'm4a', quality: 'standard' });
      out.videoPlan = [p2.ext, p2.args.join(' ')];
      const p3 = buildPlan({ isVideo: false, durationSec: 3 }, { target: 'wav', quality: 'high' });
      out.wavPlan = p3.args.join(' ');
      const p4 = buildPlan({ isVideo: false, durationSec: 3 }, { target: 'amr', quality: 'high' });
      out.amrPlan = p4.args.join(' ');
      const p5 = buildPlan({ isVideo: false, durationSec: 3 }, { target: 'mp2', quality: 'high' });
      out.mp2Plan = p5.args.join(' ');
      out.allTargetsHaveCodec = AUDIO_TARGETS.every((t) => {
        const p = buildPlan({ isVideo: false, durationSec: 1 }, { target: t.value, quality: 'standard' });
        return p.args.includes('-c:a') && p.args.length >= 2 && p.args.includes('-map_metadata');
      });
      out.meta = formatMeta({ durationSec: 65, isVideo: false, format: 'mp3', sampleRate: 44100, channelText: '立体声' });
      out.videoMeta = formatMeta({ durationSec: 5, isVideo: true, format: 'mov', sampleRate: 48000, channelText: '单声道' });
      out.channels = [formatChannels('mono'), formatChannels('stereo'), formatChannels('5.1(side)', 6), formatChannels('1 channels', 1), formatChannels('2 channels')];
      out.sampleRate = [formatSampleRate(44100), formatSampleRate(8000)];
      out.duration = [formatDuration(65), formatDuration(3725), formatDuration(0)];
      out.exts = [AUDIO_EXTS.includes('.ape'), VIDEO_INPUT_EXTS.includes('.mp4'), AUDIO_EXTS.includes('.mp4')];
      return JSON.stringify(out);
    })()`));
    const pOk = out.targetCount === 21 && out.commonCount === 6 && out.allHaveExt && out.allHaveLabel
      && out.unknownFallback === 'mp3'
      && out.audioPlan[0] === '.mp3' && out.audioPlan[1].includes('libmp3lame') && out.audioPlan[1].includes('320k') && !out.audioPlan[1].includes('-vn')
      && out.videoPlan[1].includes('-vn') && out.videoPlan[1].includes('aac')
      && out.wavPlan.includes('pcm_s16le') && !out.wavPlan.includes('b:a')
      && out.amrPlan.includes('-ar 8000') && out.amrPlan.includes('-ac 1')
      && out.mp2Plan.includes('-ar 44100')
      && out.allTargetsHaveCodec
      && out.meta.includes('1:05') && out.meta.includes('44.1 kHz') && out.meta.includes('立体声')
      && out.videoMeta.includes('视频（提取声音）')
      && out.channels.join('|') === '单声道|立体声|6 声道|单声道|立体声'
      && out.sampleRate.join('|') === '44.1 kHz|8 kHz'
      && out.duration.join('|') === '01:05|1:02:05|--:--'
      && out.exts.join('|') === 'true|true|false';
    result.checks.plan = { ...out, ok: pOk };
  } catch (err) {
    result.checks.plan = { ok: false, error: err.message };
  }

  // —— 2) 21 种输出格式真实转码 + 回读校验（走真实 IPC，与界面同一条路） ——
  result.checks.formats = { conversions: [], ok: false, passed: 0, total: OUTPUT_TARGETS.length };
  if (ffmpeg) {
    // 夹具：3 秒 44.1kHz 立体声正弦波 wav / 带标签 mp3 / 带音轨视频（全部由 ffmpeg 生成，不依赖外部素材）
    const inWav = path.join(TEST_DIR, 'at-in.wav');
    const inMp3 = path.join(TEST_DIR, 'at-in.mp3');
    const inMp4 = path.join(TEST_DIR, 'at-in-video.mp4');
    const mk = (args) => spawnSync(ffmpeg, args, { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    mk(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3', '-ac', '2', '-ar', '44100', inWav]);
    mk(['-y', '-i', inWav, '-c:a', 'libmp3lame', '-b:a', '192k', '-metadata', 'title=音测试标题', '-metadata', 'artist=测试歌手', inMp3]);
    mk(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-pix_fmt', 'yuv420p', inMp4]);

    const haveInputs = fsSync.existsSync(inWav);
    if (!haveInputs) {
      result.notes.push('夹具生成失败：无法生成测试音频');
    }

    const convertOne = async (label, script) => {
      const entry = { label };
      try {
        const r = JSON.parse(await evalJs(script));
        entry.result = r;
        if (r && r.ok && r.path) {
          const dec = decodeCheck(ffmpeg, r.path);
          const info = probeByFfmpeg(ffmpeg, r.path);
          entry.decodeOk = dec.ok;
          entry.size = r.size;
          entry.info = info;
          // 时长应与源（3 秒）一致；两类豁免：
          //   ① AMR/AAC 等无索引头：ffmpeg 按码率估算，容差放宽到 1.0s
          //   ② RealAudio(.ra)：老式 RealMedia 容器不写时长索引（Duration: 00:00:00.00），只校验可解码
          entry.durationOk = label === 'ra' ? true : Math.abs((info.durationSec || 0) - 3) <= 1.0;
          entry.ok = dec.ok && entry.durationOk;
          if (!dec.ok) entry.decodeError = dec.error;
          if (!entry.durationOk) entry.durationError = `时长 ${info.durationSec}s（期望约 3s）`;
        } else {
          entry.ok = false;
          entry.error = (r && r.message) || '转换失败';
        }
      } catch (err) {
        entry.ok = false;
        entry.error = err.message;
      }
      return entry;
    };

    if (haveInputs) {
      for (const [target, ext] of OUTPUT_TARGETS) {
        const entry = await convertOne(`${target}`, `(async () => {
          const { buildPlan } = await import('../tools/audio-convert/core/plan.js');
          const plan = buildPlan({ isVideo: false, durationSec: 3 }, { target: ${JSON.stringify(target)}, quality: 'standard' });
          const r = await window.desktop.ffmpegConvert({
            inputPath: ${JSON.stringify(inWav)}, outputDir: ${JSON.stringify(TEST_DIR)},
            baseName: 'at-out-${target}', ext: ${JSON.stringify(ext)},
            args: plan.args, durationMs: 3000, jobId: 'at-${target}'
          });
          return JSON.stringify(r);
        })()`);
        entry.target = target;
        result.checks.formats.conversions.push(entry);
      }
      result.checks.formats.passed = result.checks.formats.conversions.filter((c) => c.ok).length;
      result.checks.formats.ok = result.checks.formats.passed === OUTPUT_TARGETS.length;

      // 2b) 视频提取音频：MP4 → MP3（isVideo:true → 参数含 -vn）
      if (fsSync.existsSync(inMp4)) {
        const entry = await convertOne('video→mp3', `(async () => {
          const { buildPlan } = await import('../tools/audio-convert/core/plan.js');
          const plan = buildPlan({ isVideo: true, durationSec: 3 }, { target: 'mp3', quality: 'standard' });
          const r = await window.desktop.ffmpegConvert({
            inputPath: ${JSON.stringify(inMp4)}, outputDir: ${JSON.stringify(TEST_DIR)},
            baseName: 'at-out-video-mp3', ext: '.mp3',
            args: plan.args, durationMs: 3000, jobId: 'at-video'
          });
          return JSON.stringify(r);
        })()`);
        result.checks.videoExtract = { ...entry, ok: entry.ok };
      } else {
        result.checks.videoExtract = { ok: false, error: '视频夹具生成失败' };
      }

      // 2c) 标签保留：带 title/artist 的 mp3 → mp3，读回标签
      const metaEntry = await convertOne('tags→mp3', `(async () => {
        const { buildPlan } = await import('../tools/audio-convert/core/plan.js');
        const plan = buildPlan({ isVideo: false, durationSec: 3 }, { target: 'mp3', quality: 'standard' });
        const r = await window.desktop.ffmpegConvert({
          inputPath: ${JSON.stringify(inMp3)}, outputDir: ${JSON.stringify(TEST_DIR)},
          baseName: 'at-out-tags', ext: '.mp3',
          args: plan.args, durationMs: 3000, jobId: 'at-tags'
        });
        return JSON.stringify(r);
      })()`);
      const info = metaEntry.result && metaEntry.result.ok ? probeByFfmpeg(ffmpeg, metaEntry.result.path) : {};
      result.checks.tags = {
        ...metaEntry,
        readBack: { title: info.title || '', artist: info.artist || '' },
        ok: !!metaEntry.ok && info.title === '音测试标题' && info.artist === '测试歌手'
      };
    }

    // 2d) 无效文件：纯文本冒充 mp3，应失败且给出可读错误（不崩、不产出空文件）
    const fake = path.join(TEST_DIR, 'at-fake.mp3');
    fsSync.writeFileSync(fake, '这不是音频文件 not-audio');
    const fakeEntry = await convertOne('fake-file', `(async () => {
      const r = await window.desktop.ffmpegConvert({
        inputPath: ${JSON.stringify(fake)}, outputDir: ${JSON.stringify(TEST_DIR)},
        baseName: 'at-out-fake', ext: '.mp3',
        args: ['-c:a', 'libmp3lame', '-b:a', '192k', '-map_metadata', '0'], durationMs: 1000, jobId: 'at-fake'
      });
      return JSON.stringify(r);
    })()`);
    result.checks.invalidFile = {
      ...fakeEntry,
      ok: !fakeEntry.result.ok && !!fakeEntry.result.message,
      message: fakeEntry.result.message || ''
    };
  } else {
    result.notes.push('未检测到 ffmpeg，跳过真实转码测试');
  }

  // —— 汇总 ——
  const keys = Object.keys(result.checks);
  result.ok = keys.length > 0 && keys.every((k) => result.checks[k].ok === true);
  writeResult({ ok: result.ok, at: new Date().toISOString(), result });
  return result;
}

module.exports = { runAudioTest, TEST_DIR };