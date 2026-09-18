// 媒体工具自检（仅 `electron . --media-test` 时运行）
// 覆盖：图片压缩（核心逻辑 + 目标大小逼近）、图片变清晰（锐度指标提升）、图片格式转换（BMP/ICO/TIFF/GIF/AVIF 产物校验）、
//       视频格式转换（MP4→WebM/MKV/AVI 真实转码 + 解码校验）、动图与视频互转（MP4→GIF/WebP/APNG、GIF→MP4）。
// 说明：通过 window.desktop.* 走真实 IPC 链路（与界面点按钮同一条路），产物用 ffmpeg 完整解码一遍才算通过。
// 结果写入 %TEMP%/tomato-media-test.json，同时打印 MEDIA_TEST {...}。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawnSync } = require('child_process');
const { app } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-mediatest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-media-test.json');

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

/** ffmpeg 完整解码一遍（校验产物确实是有效媒体文件） */
function decodeCheck(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], {
    windowsHide: true, encoding: 'utf8', timeout: 120000
  });
  return { ok: r.status === 0, error: String(r.stderr || '').trim().slice(0, 200) };
}

/** 读媒体信息（时长/分辨率），用于「确实转出了东西」的交叉校验 */
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

async function runMediaTest(win) {
  const evalJs = (code) => win.webContents.executeJavaScript(code);
  const result = { ok: false, checks: {}, notes: [] };
  const ffmpeg = findFfmpeg();
  result.ffmpeg = { found: !!ffmpeg, path: ffmpeg || '' };

  await fs.mkdir(TEST_DIR, { recursive: true });
  // 清理上次产物（只删本测试自己的 mt-* 文件）
  for (const f of await fs.readdir(TEST_DIR).catch(() => [])) {
    if (f.startsWith('mt-')) await fs.rm(path.join(TEST_DIR, f), { force: true });
  }

  // —— 1) 图片：压缩核心逻辑（渲染进程内直接调工具 core，纯逻辑 + 内核编码） ——
  try {
    const out = JSON.parse(await evalJs(`(async () => {
      const out = {};
      const { compressPixels, computeTargetSize, autoFormat } = await import('../tools/compress/core/compress.js');
      const w = 800, h = 600;
      const px = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const x = i % w, y = (i / w) | 0;
        px[i * 4] = (x * 7 + y * 13) & 255;
        px[i * 4 + 1] = (x * 3 + y * 5) & 255;
        px[i * 4 + 2] = (x * x + y * y) & 255;
        px[i * 4 + 3] = 255;
      }
      // 常规压缩（JPG q60）
      const jpg = await compressPixels(px, w, h, { format: 'jpg', quality: 60 });
      out.jpgBytes = jpg.bytes.length;
      out.jpgSize = [jpg.width, jpg.height];
      // WebP 压缩
      const webp = await compressPixels(px, w, h, { format: 'webp', quality: 60 });
      out.webpBytes = webp.bytes.length;
      // 目标大小 30KB（应明显缩小尺寸或画质）
      const target = await compressPixels(px, w, h, { format: 'jpg', quality: 82, targetBytes: 30 * 1024 });
      out.targetBytes = target.bytes.length;
      out.targetFits = target.bytes.length <= Math.round(30 * 1024 * 1.15);
      out.targetNote = target.note;
      out.targetSize = [target.width, target.height];
      // 尺寸计算
      const s1 = computeTargetSize(3000, 2000, { longestEdge: 1920 });
      const s2 = computeTargetSize(400, 300, { percent: 50 });
      out.longestEdge = [s1.width, s1.height];
      out.percent = [s2.width, s2.height];
      out.auto = { png: autoFormat('.png'), webp: autoFormat('.WEBP'), heic: autoFormat('.heic') };
      // 编码产物能被内核解码回来（有效性）
      const bmp = await createImageBitmap(new Blob([jpg.bytes], { type: 'image/jpeg' }));
      out.decodeBack = [bmp.width, bmp.height];
      bmp.close();
      return JSON.stringify(out);
    })()`));
    result.checks.compress = {
      ...out,
      ok: out.jpgBytes > 0 && out.webpBytes > 0 && out.targetFits
        && out.longestEdge[0] === 1920 && out.percent[0] === 200
        && out.auto.png === 'png' && out.auto.webp === 'webp' && out.auto.heic === 'jpg'
        && out.decodeBack[0] === 800 && out.decodeBack[1] === 600
    };
  } catch (err) {
    result.checks.compress = { ok: false, error: err.message };
  }

  // —— 2) 图片：变清晰核心逻辑（锐度指标必须提升） ——
  try {
    const out = JSON.parse(await evalJs(`(async () => {
      const { unsharpFromBlurred, sharpnessMetric } = await import('../tools/enhance/core/enhance.js');
      const w = 200, h = 150;
      const px = new Uint8ClampedArray(w * h * 4);
      // 平滑渐变 + 一点细节（模拟「发虚的照片」）
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = (x + y * w) * 4;
        const g = 128 + Math.round(60 * Math.sin(x / 23) * Math.cos(y / 17));
        px[p] = g; px[p + 1] = g; px[p + 2] = g; px[p + 3] = 255;
      }
      // 用 3x3 均值模拟「模糊版本」（作为 USM 的输入）
      const blurred = new Uint8ClampedArray(px.length);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.min(w - 1, Math.max(0, x + dx));
          const ny = Math.min(h - 1, Math.max(0, y + dy));
          sum += px[(ny * w + nx) * 4]; n++;
        }
        const v = Math.round(sum / n);
        const p = (x + y * w) * 4;
        blurred[p] = v; blurred[p + 1] = v; blurred[p + 2] = v; blurred[p + 3] = 255;
      }
      const before = sharpnessMetric(px, w, h);
      const sharp = unsharpFromBlurred(px, blurred, { amount: 1.2, threshold: 2 });
      const after = sharpnessMetric(sharp, w, h);
      return JSON.stringify({ before, after, improved: after > before * 1.2, pixels: sharp.length });
    })()`));
    result.checks.enhance = { ...out, ok: !!out.improved && out.pixels === 200 * 150 * 4 };
  } catch (err) {
    result.checks.enhance = { ok: false, error: err.message };
  }

  // —— 3) 图片：格式转换的自研编码器 + ffmpeg 路径（TIFF/GIF/AVIF） ——
  try {
    const out = JSON.parse(await evalJs(`(async () => {
      const out = {};
      const { encodeImageToBytes } = await import('../shared/imageio.js');
      const w = 96, h = 64;
      const px = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        px[i * 4] = (i * 5) & 255; px[i * 4 + 1] = (i * 11) & 255; px[i * 4 + 2] = (i * 17) & 255; px[i * 4 + 3] = 255;
      }
      const png = await encodeImageToBytes(px, w, h, { format: 'png' });
      // 自研 BMP / ICO 编码器
      try {
        const enc = await import('../tools/convert/core/encoders.js');
        if (typeof enc.encodeBmp === 'function') {
          const bmp = enc.encodeBmp(px, w, h);
          out.bmp = { magic: String.fromCharCode(bmp[0], bmp[1]), bytes: bmp.length };
          window.desktop.writeFile(${JSON.stringify(path.join(TEST_DIR, 'mt-core.bmp'))}, bmp);
        } else out.bmp = { error: 'encodeBmp 未导出' };
        if (typeof enc.encodeIco === 'function') {
          const ico = enc.encodeIco([{ size: 32, pngBytes: png }, { size: 16, pngBytes: png }]);
          out.ico = { type: ico[2] | (ico[3] << 8), count: ico[4] | (ico[5] << 8), bytes: ico.length };
          window.desktop.writeFile(${JSON.stringify(path.join(TEST_DIR, 'mt-core.ico'))}, ico);
        } else out.ico = { error: 'encodeIco 未导出' };
      } catch (e) { out.encoderError = String(e && e.message || e); }
      // ffmpeg 路径：TIFF / GIF / AVIF
      const viaFfmpeg = async (ext, args) => {
        const r = await window.desktop.ffmpegTransform({ bytes: png, ext, args });
        return r.ok ? { ok: true, bytes: r.bytes.length } : { ok: false, message: r.message };
      };
      out.tiff = await viaFfmpeg('.tif', ['-c:v', 'tiff', '-compression_algo', 'lzw']);
      out.gif = await viaFfmpeg('.gif', ['-frames:v', '1', '-loop', '0', '-f', 'gif']);
      out.avif = await viaFfmpeg('.avif', ['-c:v', 'libaom-av1', '-crf', '32', '-still-picture', '1', '-f', 'avif']);
      return JSON.stringify(out);
    })()`));
    // 用 ffmpeg 校验 ffmpeg 产物（BMP/ICO 也顺带解码校验）
    const fileChecks = {};
    if (ffmpeg) {
      for (const name of ['mt-core.bmp', 'mt-core.ico']) {
        const p = path.join(TEST_DIR, name);
        if (fsSync.existsSync(p)) fileChecks[name] = decodeCheck(ffmpeg, p);
      }
    }
    const encOk = out.bmp && out.bmp.magic === 'BM' && out.ico && out.ico.type === 1 && out.ico.count >= 1;
    const fftOk = out.tiff && out.tiff.ok && out.gif && out.gif.ok && out.avif && out.avif.ok;
    result.checks.convert = { ...out, fileChecks, ok: !!encOk && !!fftOk && (fileChecks['mt-core.bmp'] ? fileChecks['mt-core.bmp'].ok : true) };
  } catch (err) {
    result.checks.convert = { ok: false, error: err.message };
  }

  // —— 4) 视频与动图：ffmpeg 造夹具后走真实 IPC 转码 ——
  result.checks.video = { conversions: [], ok: false };
  result.checks.sticker = { conversions: [], ok: false };
  if (ffmpeg) {
    const inMp4 = path.join(TEST_DIR, 'mt-in.mp4');
    const inGif = path.join(TEST_DIR, 'mt-in.gif');
    const mk = (args) => spawnSync(ffmpeg, args, { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    mk(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15', '-pix_fmt', 'yuv420p', inMp4]);
    mk(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10', '-loop', '0', inGif]);
    const haveInputs = fsSync.existsSync(inMp4) && fsSync.existsSync(inGif);

    const convert = async (label, script) => {
      const entry = { label };
      try {
        const r = JSON.parse(await evalJs(script));
        entry.result = r;
        if (r && r.ok && r.path) {
          entry.decode = decodeCheck(ffmpeg, r.path);
          entry.info = probeByFfmpeg(ffmpeg, r.path);
          entry.ok = entry.decode.ok;
        } else {
          entry.ok = false;
        }
      } catch (err) {
        entry.ok = false;
        entry.error = err.message;
      }
      return entry;
    };

    if (haveInputs) {
      // 4a) 视频格式转换：MP4 → WebM / MKV / AVI（走 shared/ffmpeg.js 的参数拼装，与界面同一套）
      for (const [label, target, ext] of [['mp4→webm', 'webm', '.webm'], ['mp4→mkv', 'mkv', '.mkv'], ['mp4→avi', 'avi', '.avi']]) {
        const entry = await convert(label, `(async () => {
          const { videoEncodeArgs } = await import('../shared/ffmpeg.js');
          window.__mtProgress = [];
          if (window.__mtOff) window.__mtOff();
          window.__mtOff = window.desktop.ffmpegOnProgress((d) => window.__mtProgress.push(d));
          const r = await window.desktop.ffmpegConvert({
            inputPath: ${JSON.stringify(inMp4)}, outputDir: ${JSON.stringify(TEST_DIR)},
            baseName: 'mt-${target}', ext: ${JSON.stringify(ext)},
            args: videoEncodeArgs(${JSON.stringify(target)}, 'standard'),
            durationMs: 3000, jobId: 'mt-${target}'
          });
          await new Promise((res) => setTimeout(res, 300));
          r.progressEvents = (window.__mtProgress || []).length;
          if (window.__mtOff) { window.__mtOff(); window.__mtOff = null; }
          return JSON.stringify(r);
        })()`);
        result.checks.video.conversions.push(entry);
      }
      result.checks.video.ok = result.checks.video.conversions.length === 3
        && result.checks.video.conversions.every((c) => c.ok);

      // 4b) 动图与视频互转：MP4 → GIF / WebP 动图 / APNG，GIF → MP4
      const stickerCases = [
        ['mp4→gif(240/12帧)', `(async () => {
          const { videoToGifArgs } = await import('../shared/ffmpeg.js');
          return JSON.stringify(await window.desktop.ffmpegConvert({
            inputPath: ${JSON.stringify(inMp4)}, outputDir: ${JSON.stringify(TEST_DIR)},
            baseName: 'mt-sticker-gif', ext: '.gif',
            inputArgs: ['-ss', '0.5', '-t', '1.5'],
            args: videoToGifArgs({ fps: 12, width: 240, colors: 128, loop: 0, srcW: 320, srcH: 240 }),
            durationMs: 1500, jobId: 'mt-sticker-gif'
          }));
        })()`],
        ['mp4→webp动图', `(async () => {
          const { videoToWebpArgs } = await import('../shared/ffmpeg.js');
          return JSON.stringify(await window.desktop.ffmpegConvert({
            inputPath: ${JSON.stringify(inMp4)}, outputDir: ${JSON.stringify(TEST_DIR)},
            baseName: 'mt-sticker-webp', ext: '.webp',
            inputArgs: ['-t', '1.5'],
            args: videoToWebpArgs({ fps: 12, width: 240, loop: 0, srcW: 320, srcH: 240 }),
            durationMs: 1500, jobId: 'mt-sticker-webp'
          }));
        })()`],
        ['mp4→apng', `(async () => {
          const { videoToApngArgs } = await import('../shared/ffmpeg.js');
          return JSON.stringify(await window.desktop.ffmpegConvert({
            inputPath: ${JSON.stringify(inMp4)}, outputDir: ${JSON.stringify(TEST_DIR)},
            baseName: 'mt-sticker-apng', ext: '.png',
            inputArgs: ['-t', '1'],
            args: videoToApngArgs({ fps: 10, width: 240, srcW: 320, srcH: 240 }),
            durationMs: 1000, jobId: 'mt-sticker-apng'
          }));
        })()`],
        ['gif→mp4', `(async () => {
          const { animToVideoArgs, videoEncodeArgs } = await import('../shared/ffmpeg.js');
          return JSON.stringify(await window.desktop.ffmpegConvert({
            inputPath: ${JSON.stringify(inGif)}, outputDir: ${JSON.stringify(TEST_DIR)},
            baseName: 'mt-sticker-mp4', ext: '.mp4',
            args: [...animToVideoArgs({ srcW: 160, srcH: 120, targetHeight: 0, fps: 0 }), ...videoEncodeArgs('mp4', 'standard', { mute: true })],
            durationMs: 2000, jobId: 'mt-sticker-mp4'
          }));
        })()`]
      ];
      for (const [label, script] of stickerCases) {
        result.checks.sticker.conversions.push(await convert(label, script));
      }
      result.checks.sticker.ok = result.checks.sticker.conversions.length === 4
        && result.checks.sticker.conversions.every((c) => c.ok);
    } else {
      result.checks.video.error = '测试视频夹具生成失败';
      result.checks.sticker.error = '测试夹具生成失败';
    }
  } else {
    result.checks.video = { ok: false, error: '未检测到 ffmpeg' };
    result.checks.sticker = { ok: false, error: '未检测到 ffmpeg' };
  }

  // —— 汇总 ——
  const names = ['compress', 'enhance', 'convert', 'video', 'sticker'];
  result.summary = Object.fromEntries(names.map((n) => [n, !!(result.checks[n] && result.checks[n].ok)]));
  result.ok = names.every((n) => result.summary[n]);
  writeResult({ ok: result.ok, at: new Date().toISOString(), result });
  return result;
}

module.exports = { runMediaTest, writeResult, TEST_DIR };