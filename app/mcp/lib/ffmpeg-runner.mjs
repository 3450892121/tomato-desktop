// MCP 侧的 ffmpeg 封装（Node 进程，不依赖 Electron）
//
// 与 GUI 主进程的 ffmpeg 通道保持同一套语义：
//   · 产物绝不覆盖：先 uniqueTargetPath 占名，失败时删掉半成品；
//   · 进度从 -progress pipe:1 的 out_time_us 解析；
//   · 超时/取消/退出码都按失败处理，不把半成品当成功。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { portableRoot, uniqueTargetPath } from './paths.mjs';

function candidates() {
  const out = [path.join(portableRoot(), 'addons', 'ffmpeg', 'ffmpeg.exe')];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) out.push(path.join(dir, 'ffmpeg.exe'));
  }
  return out;
}

/** 找 ffmpeg；找不到返回 '' */
export function findFfmpeg() {
  for (const p of candidates()) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

/** ffmpeg 版本（找不到返回 null） */
export function ffmpegVersion() {
  const bin = findFfmpeg();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(bin, ['-hide_banner', '-version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const m = /ffmpeg version (\S+)/.exec(out);
      resolve(m ? m[1] : null);
    });
  });
}

/** ffmpeg / ffprobe 都不随包（静态包只有 ffmpeg），所以从 `ffmpeg -i` 的 stderr 解析 */
export function parseMediaInfo(stderr) {
  const info = {
    durationSec: 0, width: 0, height: 0, fps: 0, hasAudio: false, hasVideo: false,
    videoCodec: '', audioCodec: '', format: '', sampleRate: 0, channelLayout: ''
  };
  const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (dur) info.durationSec = (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]);
  const fmt = /Input #0, ([^,]+),/.exec(stderr);
  if (fmt) info.format = fmt[1].trim();
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const v = /Stream #\d+:\d+.*?: Video: (\S+).*?, (\d{2,5})x(\d{2,5})/.exec(line);
    if (v && !info.width) {
      info.videoCodec = v[1];
      info.width = Number(v[2]);
      info.height = Number(v[3]);
      info.hasVideo = true;
    }
    const f = /(\d+(?:\.\d+)?) fps/.exec(line);
    if (f && !info.fps) info.fps = parseFloat(f[1]);
    if (/Stream #\d+:\d+.*?: Audio:/.test(line)) info.hasAudio = true;
    const a = /Stream #\d+:\d+.*?: Audio: ([^,]+), (\d+) Hz, ([^,]+)/.exec(line);
    if (a && !info.sampleRate) {
      info.audioCodec = a[1].trim().split(' ')[0];
      info.sampleRate = Number(a[2]);
      info.channelLayout = a[3].trim();
    }
  }
  return info;
}

/** 探测媒体信息；失败返回 {ok:false,message} */
export async function probeMedia(filePath) {
  const bin = findFfmpeg();
  if (!bin) return { ok: false, message: '未检测到 ffmpeg 加装包' };
  const res = await new Promise((resolve) => {
    const child = spawn(bin, ['-hide_banner', '-i', filePath], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: -1, stderr: String((err && err.message) || err) }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
  const info = parseMediaInfo(res.stderr);
  if (info.durationSec > 0 || info.width > 0 || info.hasAudio) return { ok: true, ...info };
  return { ok: false, message: '无法识别该文件（可能不是媒体文件或格式不受支持）' };
}

/** 跑一次 ffmpeg；onStdout 用于解析进度 */
export function runFfmpeg(args, { onStdout, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const bin = findFfmpeg();
    if (!bin) {
      resolve({ code: -1, stdout: '', stderr: '未检测到 ffmpeg', notFound: true });
      return;
    }
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
    const finish = (payload) => {
      if (timer) clearTimeout(timer);
      resolve(payload);
    };
    child.stdout.on('data', (d) => {
      const s = outDec.write(d);
      stdout += s;
      if (s && onStdout) onStdout(s);
    });
    child.stderr.on('data', (d) => {
      stderr += errDec.write(d);
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    child.on('error', (err) => finish({ code: -1, stdout: stdout + outDec.end(), stderr: String((err && err.message) || err), timedOut }));
    child.on('close', (code) => finish({ code, stdout: stdout + outDec.end(), stderr: stderr + errDec.end(), timedOut }));
  });
}

function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch { /* fallthrough */ }
  }
  try { child.kill(); } catch { /* 已退出 */ }
}

function timeoutFor(durationMs, factor = 10, minMs = 20 * 60 * 1000) {
  return Math.min(6 * 3600 * 1000, Math.max(minMs, (Number(durationMs) || 0) * factor));
}

function progressParser(onProgress) {
  if (typeof onProgress !== 'function') return undefined;
  return (chunk) => {
    for (const line of String(chunk || '').split(/\r?\n/)) {
      const t = /^out_time_us=(\d+)/.exec(line);
      if (t) onProgress({ timeMs: Number(t[1]) / 1000 });
      const s = /^speed=(.+)$/.exec(line);
      if (s) onProgress({ speed: s[1].trim() });
    }
  };
}

/**
 * 文件 → 文件 转码
 * @returns {Promise<{ok:true,path:string,size:number,ms:number}|{ok:false,message:string}>}
 */
export async function convertFile({
  inputPath, outputDir, baseName, ext = '.mp4', inputArgs = [], args = [],
  durationMs = 0, timeoutMs, onProgress
}) {
  if (!fs.existsSync(inputPath)) return { ok: false, message: '找不到输入文件' };
  const dir = outputDir || path.dirname(inputPath);
  await fsp.mkdir(dir, { recursive: true });
  const base = baseName || path.basename(inputPath, path.extname(inputPath));
  const target = uniqueTargetPath(dir, base, ext);
  const t0 = Date.now();
  const res = await runFfmpeg([
    '-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats',
    ...inputArgs, '-i', inputPath, ...args, target
  ], { timeoutMs: timeoutMs || timeoutFor(durationMs), onStdout: progressParser(onProgress) });

  if (res.code !== 0 || !fs.existsSync(target) || fs.statSync(target).size === 0) {
    try { fs.rmSync(target, { force: true }); } catch { /* 清理失败不影响结论 */ }
    const detail = res.notFound ? '未检测到 ffmpeg' : res.timedOut ? '处理超时' : `ffmpeg 退出码 ${res.code}`;
    const tail = String(res.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ｜ ').slice(0, 300);
    return { ok: false, message: `转换失败：${detail}${tail ? `｜${tail}` : ''}` };
  }
  return { ok: true, path: target, size: fs.statSync(target).size, ms: Date.now() - t0 };
}

/** 两遍编码（目标体积模式） */
export async function convertTwoPass({
  inputPath, outputDir, baseName, ext = '.mp4', inputArgs = [], pass1Args = [], pass2Args = [],
  durationMs = 0, timeoutMs, onProgress
}) {
  if (!fs.existsSync(inputPath)) return { ok: false, message: '找不到输入文件' };
  const dir = outputDir || path.dirname(inputPath);
  await fsp.mkdir(dir, { recursive: true });
  const base = baseName || path.basename(inputPath, path.extname(inputPath));
  const target = uniqueTargetPath(dir, base, ext);
  const workDir = path.join(os.tmpdir(), `tomato-mcp-2pass-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.mkdir(workDir, { recursive: true });
  const passLog = path.join(workDir, 'pass');
  const limit = timeoutMs || timeoutFor(durationMs);
  const common = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats'];
  const t0 = Date.now();
  try {
    const nullOut = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const r1 = await runFfmpeg([
      ...common, ...inputArgs, '-i', inputPath, ...pass1Args,
      '-pass', '1', '-passlogfile', passLog, '-f', 'null', nullOut
    ], { timeoutMs: limit, onStdout: progressParser(onProgress) });
    if (r1.code !== 0 || r1.timedOut) {
      return { ok: false, message: `第一遍分析失败：${r1.timedOut ? '处理超时' : `ffmpeg 退出码 ${r1.code}`}` };
    }
    const r2 = await runFfmpeg([
      ...common, ...inputArgs, '-i', inputPath, ...pass2Args,
      '-pass', '2', '-passlogfile', passLog, target
    ], { timeoutMs: limit, onStdout: progressParser(onProgress) });
    if (r2.code !== 0 || r2.timedOut || !fs.existsSync(target) || fs.statSync(target).size === 0) {
      try { fs.rmSync(target, { force: true }); } catch { /* 忽略 */ }
      const tail = String(r2.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ｜ ').slice(0, 300);
      return { ok: false, message: `第二遍编码失败：${r2.timedOut ? '处理超时' : `ffmpeg 退出码 ${r2.code}`}${tail ? `｜${tail}` : ''}` };
    }
    return { ok: true, path: target, size: fs.statSync(target).size, ms: Date.now() - t0 };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 多输入转码（音频拼接） */
export async function convertMulti({
  inputPaths = [], outputDir, baseName = '拼接结果', ext = '.mp3', args = [],
  durationMs = 0, timeoutMs, onProgress
}) {
  const inputs = (Array.isArray(inputPaths) ? inputPaths : []).filter(Boolean);
  if (inputs.length < 2) return { ok: false, message: '拼接至少需要 2 个文件' };
  for (const p of inputs) if (!fs.existsSync(p)) return { ok: false, message: `找不到输入文件：${p}` };
  const dir = outputDir || path.dirname(inputs[0]);
  await fsp.mkdir(dir, { recursive: true });
  const target = uniqueTargetPath(dir, baseName, ext);
  const inputArgs = [];
  for (const p of inputs) inputArgs.push('-i', p);
  const t0 = Date.now();
  const res = await runFfmpeg([
    '-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats',
    ...inputArgs, ...args, target
  ], { timeoutMs: timeoutMs || timeoutFor(durationMs), onStdout: progressParser(onProgress) });

  if (res.code !== 0 || !fs.existsSync(target) || fs.statSync(target).size === 0) {
    try { fs.rmSync(target, { force: true }); } catch { /* 忽略 */ }
    const tail = String(res.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ｜ ').slice(0, 300);
    return { ok: false, message: `拼接失败：ffmpeg 退出码 ${res.code}${tail ? `｜${tail}` : ''}` };
  }
  return { ok: true, path: target, size: fs.statSync(target).size, ms: Date.now() - t0 };
}

/** 按路径把媒体转成字节（波形/小产物用；大文件不要走这条） */
export async function transformFileToBytes({ inputPath, ext = '.bin', args = [], timeoutMs = 3 * 60 * 1000 }) {
  if (!fs.existsSync(inputPath)) return { ok: false, message: '找不到输入文件' };
  const workDir = path.join(os.tmpdir(), `tomato-mcp-ffmpeg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.mkdir(workDir, { recursive: true });
  const outPath = path.join(workDir, `out${ext.startsWith('.') ? ext : `.${ext}`}`);
  try {
    const res = await runFfmpeg([
      '-hide_banner', '-nostdin', '-y', '-i', inputPath, ...args, outPath
    ], { timeoutMs });
    if (res.code !== 0 || !fs.existsSync(outPath)) {
      const tail = String(res.stderr || '').trim().split(/\r?\n/).slice(-2).join(' ｜ ').slice(0, 240);
      return { ok: false, message: `转换失败：${tail || 'ffmpeg 未生成输出文件'}` };
    }
    return { ok: true, bytes: await fsp.readFile(outPath) };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
