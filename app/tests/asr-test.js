// 语音转文字自检（仅 `electron . --asr-test` 时运行）
// 覆盖：计划逻辑单测（SRT→文本、SRT 合法性、输出模式、文案函数）、
//       离线合成中文语音夹具（Windows SAPI，本机无中文语音则如实记录）→ 走真实 IPC 识别 →
//       校验返回文本关键词 / .txt 落盘内容 / .srt 合法性 / 视频（提取音轨）链路 / 无效文件报错不产文件。
// 结果写入 %TEMP%/tomato-asr-test.json，同时打印 ASR_TEST {...}。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawnSync } = require('child_process');
const { app } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-asrtest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-asr-test.json');

/** 测试语音内容与关键词（SAPI 合成——离线、无需外部素材） */
const SPEECH_TEXT = '今天下午三点开会，请大家准时参加。';
const SPEECH_KEYWORDS = ['开会', '准时', '参加'];

/** 加装包基准目录（开发树 = app/；打包产物 = exe 所在目录） */
function addonBase() {
  return app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
}

function findAsr() {
  const dir = path.join(addonBase(), 'addons', 'asr');
  const ok = ['llama-funasr-sensevoice.exe', path.join('models', 'sensevoice-small-q8.gguf'), path.join('models', 'fsmn-vad.gguf')]
    .every((f) => fsSync.existsSync(path.join(dir, f)));
  return ok ? dir : null;
}

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

/**
 * 用 Windows 自带 SAPI 离线合成中文语音（纯离线、无需外部素材）。
 * 说明：脚本写成 UTF-8 BOM 的 .ps1 再执行——规避命令行传中文参数的编码坑（实测 argv 会被按 ACP 转换）。
 */
function makeSpeechWav(targetPath, text) {
  const ps1 = path.join(TEST_DIR, 'as-make-speech.ps1');
  const q = (s) => String(s).replace(/'/g, "''");
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$zh = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
if ($zh) { $s.SelectVoice($zh.VoiceInfo.Name) } else { throw 'no-zh-voice' }
$s.SetOutputToWaveFile('${q(targetPath)}')
$s.Speak('${q(text)}')
$s.Dispose()
`;
  fsSync.writeFileSync(ps1, `\uFEFF${script}`, 'utf8');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0 || !fsSync.existsSync(targetPath) || fsSync.statSync(targetPath).size < 1000) {
    return { ok: false, error: String(r.stderr || (r.error && r.error.message) || '语音合成失败').trim().slice(0, 200) };
  }
  return { ok: true };
}

async function runAsrTest(win) {
  const evalJs = (code) => win.webContents.executeJavaScript(code);
  const result = { ok: false, checks: {}, notes: [] };
  const asrDir = findAsr();
  const ffmpeg = findFfmpeg();
  result.addon = { found: !!asrDir, dir: asrDir || '' };
  result.ffmpeg = { found: !!ffmpeg, path: ffmpeg || '' };

  await fs.mkdir(TEST_DIR, { recursive: true });
  // 清理上次产物（只删本测试自己的 as-* 文件）
  for (const f of await fs.readdir(TEST_DIR).catch(() => [])) {
    if (f.startsWith('as-')) await fs.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
  }

  // —— 1) 计划逻辑单测（渲染进程内直接调工具 core，纯逻辑，不碰加装包） ——
  try {
    const planCode = [
      '(async () => {',
      '  const out = {};',
      "  const m = await import('../tools/transcribe/core/plan.js');",
      '  const NL = String.fromCharCode(10);',
      "  const srt = ['1','00:00:00,000 --> 00:00:02,000','你好世界。','','2','00:00:02,000 --> 00:00:04,000','今天下午三点开会。',''].join(NL);",
      '  out.modeCount = m.OUTPUT_MODES.length;',
      "  out.unknownMode = m.modeOf('nope').value;",
      '  out.text = m.srtToText(srt);',
      '  out.textHasStamp = m.srtToText(srt).includes(\'-->\');',
      '  out.valid = m.isValidSrt(srt);',
      "  out.invalid = m.isValidSrt('这不是字幕');",
      "  out.txtOutputs = m.buildOutputs(srt, 'txt').map((o) => o.ext).join(',');",
      "  out.bothOutputs = m.buildOutputs(srt, 'both').map((o) => o.ext).join(',');",
      "  out.txtContent = m.buildOutputs(srt, 'txt')[0].text;",
      "  out.srtKeepsStamp = m.buildOutputs(srt, 'srt')[0].text.includes('-->');",
      '  out.chars = m.countChars(m.srtToText(srt));',
      '  out.duration = [m.formatDuration(65), m.formatDuration(3725), m.formatDuration(0)].join("|");',
      '  out.size = m.formatSize(2048);',
      "  out.meta = m.formatMeta({ durationSec: 65, isVideo: true, format: 'mov', size: 2048 });",
      '  out.exts = [m.INPUT_EXTS.includes(".mp3"), m.INPUT_EXTS.includes(".mp4"), m.AUDIO_EXTS.includes(".mp4"), m.VIDEO_EXTS.includes(".mp4")].join("|");',
      '  return JSON.stringify(out);',
      '})()'
    ].join('\n');
    const out = JSON.parse(await evalJs(planCode));
    const expectedText = '你好世界。\n今天下午三点开会。\n';
    const pOk = out.modeCount === 3 && out.unknownMode === 'txt'
      && out.text === expectedText.trim() && out.textHasStamp === false
      && out.valid === true && out.invalid === false
      && out.txtOutputs === '.txt' && out.bothOutputs === '.txt,.srt'
      && out.txtContent === expectedText && out.srtKeepsStamp === true
      && out.chars === 14
      && out.duration === '01:05|1:02:05|--:--'
      && out.size === '2.0 KB'
      && out.meta === '01:05 ｜ 视频（提取声音） ｜ 2.0 KB'
      && out.exts === 'true|true|false|true';
    result.checks.plan = { ...out, ok: pOk };
  } catch (err) {
    result.checks.plan = { ok: false, error: err.message };
  }

  // —— 2) 真实识别（需要 asr 加装包 + ffmpeg） ——
  if (!asrDir || !ffmpeg) {
    result.notes.push('缺少 asr 加装包或 ffmpeg，跳过真实识别测试');
  } else {
    // 2a) 夹具：SAPI 合成中文语音 wav + 带该语音音轨的视频 mp4
    const speechWav = path.join(TEST_DIR, 'as-speech.wav');
    const speechMp4 = path.join(TEST_DIR, 'as-speech.mp4');
    const mk = makeSpeechWav(speechWav, SPEECH_TEXT);
    result.checks.fixture = { ok: !!mk.ok, error: mk.error || '' };
    if (mk.ok) {
      const r = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=15',
        '-i', speechWav, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-pix_fmt', 'yuv420p', speechMp4],
        { windowsHide: true, encoding: 'utf8', timeout: 120000 });
      if (r.status !== 0) result.notes.push('视频夹具生成失败：' + String(r.stderr || '').slice(-200));
    }

    // 2b) 音频识别 + 落盘（走真实 IPC 与界面同一条路）
    const runOne = async (label, inputPath, baseName, mode) => {
      const code = [
        '(async () => {',
        "  const m = await import('../tools/transcribe/core/plan.js');",
        `  const r = await window.desktop.asrTranscribe({ inputPath: ${JSON.stringify(inputPath)}, jobId: ${JSON.stringify('as-' + label)} });`,
        '  if (!r || !r.ok) return JSON.stringify({ ok: false, message: r && r.message });',
        `  const outputs = m.buildOutputs(r.srtText, ${JSON.stringify(mode)});`,
        `  const saved = await window.desktop.asrSave({ targetDir: ${JSON.stringify(TEST_DIR)}, baseName: ${JSON.stringify(baseName)}, files: outputs });`,
        '  return JSON.stringify({ ok: true, srtText: r.srtText, outputs, saved });',
        '})()'
      ].join('\n');
      return JSON.parse(await evalJs(code));
    };

    const audio = await runOne('audio', speechWav, 'as-out-speech', 'both');
    const readText = (p) => {
      try { return fsSync.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
    };
    if (audio.ok && audio.saved && audio.saved.ok) {
      const files = audio.saved.paths.map((p) => path.basename(p));
      const txtPath = audio.saved.paths.find((p) => p.endsWith('.txt'));
      const srtPath = audio.saved.paths.find((p) => p.endsWith('.srt'));
      const txtContent = readText(txtPath) || '';
      const srtContent = readText(srtPath) || '';
      const hitKeywords = SPEECH_KEYWORDS.filter((k) => txtContent.includes(k));
      result.checks.transcribe = {
        files,
        text: txtContent.trim(),
        keywordsHit: hitKeywords,
        txtNoStamp: !txtContent.includes('-->'),
        srtHasStamp: srtContent.includes('-->'),
        txtMatchesReturn: txtContent === audio.outputs[0].text,
        ok: files.length === 2 && files.every((f) => f.startsWith('as-out-speech'))
          && hitKeywords.length === SPEECH_KEYWORDS.length
          && !txtContent.includes('-->') && srtContent.includes('-->')
          && txtContent === audio.outputs[0].text
      };
      if (hitKeywords.length !== SPEECH_KEYWORDS.length) result.notes.push(`识别关键词命中 ${hitKeywords.length}/${SPEECH_KEYWORDS.length}：${txtContent.trim()}`);
    } else {
      result.checks.transcribe = { ok: false, error: (audio && audio.message) || '识别失败' };
    }

    // 2c) 视频链路（提取音轨 → 识别，只校验识别成功 + 关键词，不落盘）
    if (fsSync.existsSync(speechMp4)) {
      const video = await runOne('video', speechMp4, 'as-out-video', 'txt');
      result.checks.video = {
        text: video.ok ? (video.outputs[0].text || '').trim() : '',
        ok: !!video.ok && SPEECH_KEYWORDS.every((k) => (video.outputs[0].text || '').includes(k)),
        error: video.ok ? '' : (video.message || '识别失败')
      };
    } else {
      result.checks.video = { ok: false, error: '视频夹具生成失败' };
    }

    // 2d) 无效文件：文本冒充 wav，应失败且给出可读错误、不产出任何文件
    const fake = path.join(TEST_DIR, 'as-fake.wav');
    fsSync.writeFileSync(fake, '这不是音频文件 not-audio');
    const fakeRes = await runOne('fake', fake, 'as-out-fake', 'txt');
    result.checks.invalidFile = {
      ok: !fakeRes.ok && !!fakeRes.message,
      message: fakeRes.message || '',
      noFile: !fsSync.existsSync(path.join(TEST_DIR, 'as-out-fake.txt'))
    };
    result.checks.invalidFile.ok = result.checks.invalidFile.ok && result.checks.invalidFile.noFile;
  }

  // —— 汇总 ——
  const keys = Object.keys(result.checks);
  result.ok = keys.length > 0 && keys.every((k) => result.checks[k].ok === true);
  writeResult({ ok: result.ok, at: new Date().toISOString(), result });
  return result;
}

module.exports = { runAsrTest, writeResult, makeSpeechWav, TEST_DIR, SPEECH_TEXT, SPEECH_KEYWORDS };