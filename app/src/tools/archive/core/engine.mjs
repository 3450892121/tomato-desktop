// 「文件压缩与解压」工具的引擎层（Node 侧；由主进程 main.js 动态 import 使用）
// 职责：找 7-Zip、跑 7-Zip、用 Node 内置 zlib 处理 zstd/brotli、解析输出、翻译错误、清理临时文件。
// 设计要点（本机 7-Zip 26.03 实测得出）：
//   · 7-Zip 的密码是命令行参数；**不给 -p 时它会交互式索要密码导致挂起** → 一律带 `-p`（空串亦可），
//     同时把子进程 stdin 设为 'ignore' 作为第二道保险（读不到输入会立刻报错而不是卡住）。
//   · `-sccUTF-8` 必须加，否则中文条目名按 OEM 码页输出、界面显示乱码。
//   · 复合格式（tar.gz / tar.xz / tar.zst / tar.br…）要**两趟**：先解外层得到 .tar，再解这个 tar。
//   · 密码错误时 7-Zip 会留下半成品目录 → 失败时把本次新建的输出目录删掉，不留垃圾。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createReadStream, createWriteStream } from 'node:fs';

import {
  createArgs, extractArgs, listArgs, testArgs,
  parseListOutput, parseArchiveMeta, parseProgressPercent, parseCurrentEntry,
  findSuspiciousEntries, translateSevenZipError, sevenZipLevel, zstdLevel, brotliQuality,
  findInnerTar, parseExtractCounts
} from './params.mjs';
import { isTarFlavored, formatById } from './formats.mjs';

/** 正在跑的 7-Zip 子进程（jobId → child），供取消用 */
const jobs = new Map();

/** Node 内置 zlib 的能力（zstd/brotli 是否可用） */
export function nodeCodecCaps() {
  return {
    zstd: typeof zlib.zstdCompressSync === 'function' && typeof zlib.createZstdCompress === 'function',
    brotli: typeof zlib.brotliCompressSync === 'function' && typeof zlib.createBrotliCompress === 'function'
  };
}

/**
 * 找 7-Zip 可执行文件。查找顺序（对应「引擎可替换」的跨平台约定）：
 *   1) 随包加装包 addons/7zip/7z.exe
 *   2) 系统 PATH 里的 7z / 7za
 *   3) 常见安装目录（C:\Program Files\7-Zip\7z.exe）
 */
export function findSevenZip(portableDir) {
  const addon = path.join(portableDir, 'addons', '7zip', '7z.exe');
  if (fs.existsSync(addon)) return { found: true, path: addon, where: 'addon' };
  try {
    const r = spawnSync('where', ['7z'], { windowsHide: true, encoding: 'utf8' });
    if (r.status === 0) {
      const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) return { found: true, path: first, where: 'system' };
    }
  } catch { /* 找不到按未安装处理 */ }
  try {
    const r = spawnSync('where', ['7za'], { windowsHide: true, encoding: 'utf8' });
    if (r.status === 0) {
      const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) return { found: true, path: first, where: 'system' };
    }
  } catch { /* 同上 */ }
  const common = 'C:\\Program Files\\7-Zip\\7z.exe';
  if (fs.existsSync(common)) return { found: true, path: common, where: 'path' };
  return { found: false, path: null, where: null };
}

/** 引擎状态（版本号从 `7z` 无参输出里解析） */
export async function sevenZipStatus(portableDir) {
  const caps = nodeCodecCaps();
  const bin = findSevenZip(portableDir);
  if (!bin.found) return { found: false, where: null, version: null, path: null, node: caps };
  const version = await new Promise((resolve) => {
    const child = spawn(bin.path, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const m = /7-Zip\s+([\d.]+)/.exec(out);
      resolve(m ? m[1] : null);
    });
  });
  return { found: true, where: bin.where, version, path: bin.path, node: caps };
}

/** 取消一个正在跑的作业（杀整棵进程树）。标记 __canceled 让上层区分「取消」与「失败」 */
export function cancelJob(jobId) {
  const child = jobs.get(jobId);
  if (!child) return false;
  child.__canceled = true;
  killTree(child);
  jobs.delete(jobId);
  return true;
}

function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch { /* 退回普通 kill */ }
  }
  try { child.kill(); } catch { /* 已退出 */ }
}

/**
 * 跑一次 7-Zip。
 * @param {object} [options]
 * @param {boolean} [options.keepFullStdout] 列目录/安全闸门必须置 true：完整保留 stdout
 *   （头部被截掉会让「查可疑路径」漏检归档头部的条目，等于给 zip-slip 留后门，v2.8.1 修复）。
 *   进度解析等只看尾部的场景保持默认（只留尾部，防异常输出撑爆内存）。
 * @returns {Promise<{code:number, stdout:string, stderr:string, canceled:boolean, timedOut:boolean, stdoutIncomplete:boolean}>}
 */
function run7z(binPath, args, { cwd, jobId, onStdout, timeoutMs = 6 * 3600 * 1000, keepFullStdout = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(binPath, args, {
      cwd: cwd || undefined,
      windowsHide: true,
      // stdin 必须关掉：7-Zip 需要密码时会交互式提问，留着 stdin 会永久挂起
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (jobId) jobs.set(jobId, child);

    // 完整模式的输出上限：只是防野输出撑爆内存的保险丝。超过即置 stdoutIncomplete，
    // 上层（listArchive）会把「列不完整」当失败拒绝处理——宁可拒绝，不可漏检。
    const FULL_STDOUT_CAP = 64 * 1024 * 1024;

    let stdout = '';
    let stderr = '';
    let canceled = false;
    let timedOut = false;
    let stdoutIncomplete = false;
    // 必须用 StringDecoder 而不是逐块 d.toString()：7-Zip 带 -sccUTF-8 输出中文条目名，
    // 一个汉字的多字节序列被 64KB 管道块切断时，逐块解码会得到 U+FFFD 乱码——
    // 而这份 stdout 正是「查可疑路径」安全闸门的输入，乱码路径会绕过 zip-slip 判断。
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

    const finish = (code) => {
      clearTimeout(timer);
      if (jobId) jobs.delete(jobId);
      stdout += outDec.end(); // 冲掉末尾可能残留的不完整多字节序列
      stderr += errDec.end();
      resolve({ code, stdout, stderr, canceled, timedOut, stdoutIncomplete });
    };

    child.stdout.on('data', (d) => {
      const s = outDec.write(d);
      if (!s) return; // 整块都是半个字符：等下一块拼齐再说
      if (keepFullStdout) {
        if (stdout.length < FULL_STDOUT_CAP) {
          stdout += s;
          if (stdout.length >= FULL_STDOUT_CAP) stdoutIncomplete = true;
        } else {
          stdoutIncomplete = true; // 继续消费管道（避免子进程被写满阻塞），但不再堆积
        }
      } else {
        stdout += s;
        if (stdout.length > 400000) stdout = stdout.slice(-200000); // 只留尾部，异常时不撑爆内存
      }
      if (onStdout) onStdout(s, stdout);
    });
    child.stderr.on('data', (d) => {
      stderr += errDec.write(d);
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    child.on('error', (err) => { stderr += String((err && err.message) || err); finish(-1); });
    child.on('close', (code) => {
      // 被 taskkill 杀掉时退出码不可信，以 __canceled 标记为准（cancelJob 里置位）
      if (child.__canceled) canceled = true;
      finish(code);
    });
  });
}

// —— 列表（免解压预览） ——

/**
 * 列出压缩包内容（不解压）。
 * @returns {Promise<{ok:boolean, entries?:Array, summary?:object, meta?:object, suspicious?:Array, message?:string}>}
 */
export async function listArchive({ archivePath, password = '', binPath }) {
  if (!archivePath || !fs.existsSync(archivePath)) {
    return { ok: false, message: '找不到压缩包文件' };
  }
  const res = await run7z(binPath, listArgs({ archivePath, password }), {
    timeoutMs: 10 * 60 * 1000,
    keepFullStdout: true // 列目录的输出要喂给「查可疑路径」的闸门，必须完整（见 run7z 注释）
  });
  if (res.code !== 0) {
    return { ok: false, message: translateSevenZipError(res) };
  }
  if (res.stdoutIncomplete) {
    // 列表不完整 = 闸门不可信：拒绝列出（解压前的闸门也走这里，等于连解压一起拒绝）
    return { ok: false, message: '压缩包条目过多，无法完整列出校验（超出安全上限）；为防可疑路径漏检已拒绝处理' };
  }
  const entries = parseListOutput(res.stdout);
  const meta = parseArchiveMeta(res.stdout);
  const suspicious = findSuspiciousEntries(entries);
  const files = entries.filter((e) => !e.folder);
  const totalSize = files.reduce((s, e) => s + (e.size || 0), 0);
  const totalPacked = files.reduce((s, e) => s + (e.packedSize || 0), 0);
  return {
    ok: true,
    entries,
    meta,
    suspicious,
    summary: {
      total: entries.length,
      files: files.length,
      folders: entries.length - files.length,
      totalSize,
      totalPacked,
      encrypted: entries.some((e) => e.encrypted)
    }
  };
}

/** 单文件流式格式（zst / br）的「列表」：无法列出内部条目，给一条合成信息 */
export async function describeStreamArchive({ archivePath, engine }) {
  let size = 0;
  try { size = fs.statSync(archivePath).size; } catch { /* 读不到就 0 */ }
  const base = path.basename(archivePath);
  const inner = base.replace(/\.(zst|br)$/i, '');
  return {
    ok: true,
    stream: true,
    entries: [{
      path: inner || base,
      folder: false,
      size: 0,
      packedSize: size,
      modified: '',
      encrypted: false,
      crc: '',
      method: String(engine || '').toUpperCase(),
      note: '单文件流式格式：解压后得到该文件'
    }],
    meta: { type: engine, physicalSize: size },
    suspicious: [],
    summary: { total: 1, files: 1, folders: 0, totalSize: 0, totalPacked: size, encrypted: false, stream: true }
  };
}

// —— 压缩 ——

/**
 * 执行压缩计划（steps 来自 core/plan.mjs 的 buildCreatePlan）。
 * @param {object} o
 * @param {Array} o.steps
 * @param {string} o.archivePath
 * @param {string} o.binPath 7-Zip 路径（kind='7z' 的步骤需要）
 * @param {string} o.jobId
 * @param {(p:{percent:number,text:string})=>void} o.onProgress
 * @param {()=>boolean} o.isCancelled
 */
export async function createArchive({ steps = [], archivePath, binPath, jobId, onProgress, isCancelled }) {
  const t0 = Date.now();
  const total = steps.length || 1;
  const temps = [];
  let inputBytes = 0;
  if (!archivePath) return { ok: false, message: '缺少输出压缩包路径' };

  // 7-Zip 的失败可能是「中途失败」——留下半个压缩包会骗到用户，失败时必须把本次产物删干净
  const wipe = async () => {
    for (const p of collectProduced(archivePath)) {
      await fsp.rm(p, { force: true }).catch(() => {});
    }
  };

  try {
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (isCancelled && isCancelled()) return { ok: false, canceled: true };
      const share = (pct) => {
        if (!onProgress) return;
        const overall = ((i + Math.max(0, Math.min(1, pct / 100))) / total) * 100;
        onProgress({ percent: Math.min(99, overall), text: step.label || '压缩中' });
      };
      share(0);

      if (step.kind === 'node') {
        const src = step.src || path.join(step.cwd || '', (step.names && step.names[0]) || '');
        const r = await nodeCompress({
          src, target: step.target, engine: step.engine || engineOfNodeFormat(step.formatId),
          level: step.level, onProgress: share
        });
        inputBytes += r.inputBytes;
      } else if (step.action === 'compress') {
        // 复合格式的外层：gzip / bzip2 / xz —— 用 7-Zip 压上一步产出的 .tar
        const innerDir = path.dirname(step.src);
        temps.push(step.src);
        const args = ['a', `-t${step.engine}`, `-mx=${sevenZipLevel(step.level)}`, '-y', '-aoa', '-bsp1', '-bb1', step.target, step.name || path.basename(step.src)];
        const res = await run7z(binPath, args, {
          cwd: innerDir,
          jobId: `${jobId}`,
          onStdout: (chunk, all) => reportSevenZip(chunk, all, share, step.label)
        });
        const err = checkRun(res);
        if (err) {
          await wipe();
          return err;
        }
      } else {
        const names = step.names || [];
        const args = createArgs({
          format: formatById(step.formatId) || { type: step.formatId, password: null, volume: false },
          overrideType: step.overrideType,
          level: step.level,
          password: step.password,
          encrypt: step.encrypt,
          volumeBytes: step.volumeBytes,
          archivePath: step.target,
          names
        });
        const res = await run7z(binPath, args, {
          cwd: step.cwd,
          jobId: `${jobId}`,
          onStdout: (chunk, all) => reportSevenZip(chunk, all, share, step.label)
        });
        const err = checkRun(res);
        if (err) {
          await wipe();
          return err;
        }
      }
      share(100);
    }

    if (isCancelled && isCancelled()) {
      await wipe();
      return { ok: false, canceled: true };
    }

    // 汇总产物（分卷时会有 .001/.002…）
    const produced = collectProduced(archivePath);
    if (produced.length === 0) {
      return { ok: false, message: '压缩完成但没有找到产物文件' };
    }
    const size = produced.reduce((s, p) => s + (fs.existsSync(p) ? fs.statSync(p).size : 0), 0);
    return { ok: true, paths: produced, size, ms: Date.now() - t0, inputBytes };
  } catch (err) {
    await wipe();
    return { ok: false, message: (err && err.message) || String(err) };
  } finally {
    // 中间产物（.tar）一定要清掉，别留在用户目录里
    for (const t of temps) {
      await fsp.rm(t, { force: true }).catch(() => {});
    }
  }
}

function engineOfNodeFormat(formatId) {
  if (formatId === 'zst') return 'zst';
  if (formatId === 'br') return 'br';
  return 'zst';
}

/** 解析 7-Zip 的进度输出并转发 */
function reportSevenZip(chunk, wholeBuffer, share, label) {
  const pct = parseProgressPercent(wholeBuffer);
  const cur = parseCurrentEntry(chunk);
  if (pct == null && !cur) return;
  share(pct == null ? 0 : pct);
  void label;
}

/** 统一判定一次 7-Zip 运行是否成功 */
function checkRun(res) {
  if (res.canceled) return { ok: false, canceled: true };
  if (res.timedOut) return { ok: false, message: '压缩超时（超过 6 小时）' };
  if (res.code === 0) return null;
  return { ok: false, message: translateSevenZipError(res) };
}

/** 已知的复合后缀（去重加序号时不能只按 path.extname 拆，否则 a.tar.gz → a.tar(1).gz） */
const COMPOUND_SUFFIX = /(\.tar\.(?:gz|bz2|xz|zst|br))$/i;

/**
 * 绝不覆盖已有文件（项目硬约定）：重名自动加序号。
 * 也要检查分卷首卷（`a.7z` 不存在但 `a.7z.001` 存在时同样算占用）。
 */
export function uniqueArchivePath(target) {
  const taken = (p) => fs.existsSync(p) || fs.existsSync(`${p}.001`);
  if (!taken(target)) return target;
  const dir = path.dirname(target);
  const name = path.basename(target);
  const m = COMPOUND_SUFFIX.exec(name);
  const ext = m ? m[1] : path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10000; i += 1) {
    const cand = path.join(dir, `${base}(${i})${ext}`);
    if (!taken(cand)) return cand;
  }
  return path.join(dir, `${base}(${Date.now()})${ext}`);
}

/** 收集产物：主文件 + 分卷（.001/.002…） */
export function collectProduced(archivePath) {
  const out = [];
  if (fs.existsSync(archivePath)) out.push(archivePath);
  const dir = path.dirname(archivePath);
  const base = path.basename(archivePath);
  let i = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const p = path.join(dir, `${base}.${String(i).padStart(3, '0')}`);
    if (!fs.existsSync(p)) break;
    out.push(p);
    i += 1;
  }
  return out;
}

// —— 解压 ——

/**
 * 执行解压计划（steps 来自 core/plan.mjs 的 buildExtractPlan）。
 * 每个 step：{ source, outputDir, password, overwrite, flatten, label }
 */
export async function extractArchive({ steps = [], binPath, jobId, onProgress, isCancelled }) {
  const t0 = Date.now();
  const total = steps.length || 1;
  const results = [];
  const failures = []; // 逐包记录失败原因：一个包坏了不该拖垮整批，也不该把已成功的结果丢掉

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (isCancelled && isCancelled()) return { ok: false, canceled: true };
    const share = (pct) => {
      if (!onProgress) return;
      const overall = ((i + Math.max(0, Math.min(1, pct / 100))) / total) * 100;
      onProgress({ percent: Math.min(99, overall), text: step.label || '解压中' });
    };
    share(0);

    // 分卷包：7-Zip 只认第一卷，其余卷它自己会找（.002/.003…）
    const target = resolveFirstVolume(step.source);
    let r;
    if (/\.(zst|br)$/i.test(target)) {
      const isCompoundTarFlavor = /^tar\.(zst|br)$/i.test(path.basename(target)) ||
        /\.tar\.(zst|br)$/i.test(path.basename(target));
      // zst / br 走 Node 内置 zlib 流式解压：输出名 = 去掉 .zst/.br 后缀
      const codec = /\.br$/i.test(target) ? 'br' : 'zst';
      const outName = path.basename(target).replace(/\.(zst|br)$/i, '') || '解压结果';
      const hadBefore = fs.existsSync(step.outputDir);
      // 顶层名快照：失败清理时必须靠它豁免「用户原本就有的东西」。
      // 少了这一份，cleanupFailedOutput 会把整个目录当成「全是本次产物」删光（含用户既有文件）。
      const namesBefore = hadBefore ? new Set(fs.readdirSync(step.outputDir)) : new Set();
      const filesBefore = snapshotFiles(step.outputDir);
      await fsp.mkdir(step.outputDir, { recursive: true });
      // 这条 Node 流式分支必须自己实现覆盖策略：7-Zip 分支有 -aos/-aoa，而
      // createWriteStream 是无条件截断——不拦就会把用户目录里的同名文件悄悄覆盖掉，
      // 而且覆盖后 countFilesSince 记 0 新增，反而报「没有解出任何文件」。
      const replace = step.overwrite === 'replace';
      let outPath = path.join(step.outputDir, outName);
      if (!isCompoundTarFlavor && !replace && fs.existsSync(outPath)) {
        r = { ok: false, skippedExisting: true, message: `已跳过：${outName} 已存在（覆盖策略是「跳过已存在文件」）` };
      } else {
        // 复合格式这一步产出的只是中间 .tar：另起一个不重名的名字，绝不覆盖用户的同名 tar，
        // 用完（成功或失败）都会删掉。
        if (isCompoundTarFlavor) outPath = uniqueArchivePath(outPath);
        try {
          await nodeDecompress({ src: target, target: outPath, engine: codec, onProgress: (p) => share(p) });
        } catch (err) {
          await fsp.rm(outPath, { force: true }).catch(() => {});
          r = { ok: false, message: `解压失败：${(err && err.message) || err}（文件可能不是有效的 ${codec.toUpperCase()} 数据）` };
        }
      }
      if (r && !r.ok) {
        failures.push({ source: step.source, message: r.message });
        share(100);
        continue;
      }

      if (isCompoundTarFlavor && /\.tar$/i.test(outPath)) {
        // tar.zst / tar.br：先解出 .tar，再交给 7-Zip 解开 tar（含安全闸门与第二趟）
        if (step.guardTraversal !== false) {
          const g = await guardBeforeExtract({ archivePath: outPath, password: step.password || '', binPath });
          if (g) {
            await fsp.rm(outPath, { force: true }).catch(() => {});
            failures.push({ source: step.source, message: g.message });
            share(100);
            continue;
          }
        }
        const res2 = await run7z(binPath, extractArgs({
          archivePath: outPath, outputDir: step.outputDir, password: step.password || '',
          overwrite: step.overwrite || 'skip', flatten: step.flatten
        }), { jobId, onStdout: (c, all) => reportSevenZip(c, all, share, '解开 TAR') });
        if (res2.canceled) return { ok: false, canceled: true };
        if (res2.code !== 0) {
          await fsp.rm(outPath, { force: true }).catch(() => {});
          await cleanupFailedOutput(step.outputDir, hadBefore, namesBefore);
          failures.push({ source: step.source, message: translateSevenZipError(res2) });
          share(100);
          continue;
        }
        await fsp.rm(outPath, { force: true }).catch(() => {}); // 中间 tar 不留给用户
      }
      const added = countFilesSince(step.outputDir, filesBefore);
      if (added === 0) {
        // 同样不能把「什么都没解出来」报成成功（输出文件已存在时 Node 也会照写，
        // 所以这里的判据是「新增/变化的文件数」，不是目录总数）
        r = { ok: false, message: '没有解出任何文件（输出目录里可能已有同名文件，或数据为空）' };
      } else {
        r = { ok: true, dir: step.outputDir, files: added };
      }
    } else {
      r = await extractOne({ ...step, source: target, binPath, jobId, share, isCancelled });
    }
    // 一个包失败不该让整批中止、更不该把已经解成功的结果丢掉：
    // 记下来继续跑，最后如实汇总「成功几个、失败几个、失败原因」。
    if (r.canceled) return { ok: false, canceled: true };
    if (!r.ok) {
      failures.push({ source: step.source, message: r.message });
      share(100);
      continue;
    }
    results.push(r);
    share(100);
  }

  const files = results.reduce((s, r) => s + (r.files || 0), 0);
  const dirs = results.map((r) => r.dir);
  if (failures.length) {
    const doneNote = results.length
      ? `；另有 ${results.length} 个已解出（共 ${files} 个文件，产物已保留）`
      : '';
    return {
      ok: false,
      dirs,
      dir: results.length === 1 ? dirs[0] : '',
      files,
      failures,
      message: failures.length === 1
        ? `${failures[0].message}${doneNote}`
        : `${steps.length} 个压缩包里有 ${failures.length} 个失败（首个原因：${failures[0].message}）${doneNote}`,
      ms: Date.now() - t0
    };
  }
  return {
    ok: true,
    dirs,
    dir: results.length === 1 ? dirs[0] : '',
    files,
    ms: Date.now() - t0
  };
}

/** 分卷首卷：给 .002 也指向 .001（用户可能随手选了中间那卷） */
export function resolveFirstVolume(p) {
  const m = /^(.*)\.(\d{3})$/.exec(String(p || ''));
  if (!m) return p;
  const first = `${m[1]}.001`;
  return fs.existsSync(first) ? first : p;
}

async function extractOne({ source, outputDir, password, overwrite, flatten, binPath, jobId, share, isCancelled, label, guardTraversal = true }) {
  if (!source || !fs.existsSync(source)) return { ok: false, message: '找不到压缩包文件' };

  // 安全闸门（zip-slip）：先只「列目录」看有没有 `..` 或绝对路径条目，有就整体拒绝。
  // 顺带把「密码错误」提前到解压前发现，不会留下半成品目录。
  if (guardTraversal) {
    const guard = await guardBeforeExtract({ archivePath: source, password, binPath });
    if (guard) return guard;
  }

  const existedBefore = fs.existsSync(outputDir);
  const namesBefore = existedBefore ? new Set(fs.readdirSync(outputDir)) : new Set();
  // 解压前先把已有文件快照下来：判断「这次到底解出来几个」必须看**新增**，
  // 不能看目录里的总数（目录里本来就有文件时会误判成「解压成功」）。
  const filesBefore = snapshotFiles(outputDir);

  const run = async (args, cwd) => run7z(binPath, args, {
    cwd,
    jobId,
    onStdout: (chunk, all) => reportSevenZip(chunk, all, share, label)
  });

  try {
    await fsp.mkdir(outputDir, { recursive: true });
    let res = await run(extractArgs({ archivePath: source, outputDir, password, overwrite, flatten }), undefined);
    if (res.canceled) return { ok: false, canceled: true };
    if (res.timedOut) return { ok: false, message: '解压超时（超过 6 小时）' };
    if (res.code !== 0) {
      await cleanupFailedOutput(outputDir, existedBefore, namesBefore);
      return { ok: false, message: translateSevenZipError(res) };
    }

    // 复合格式（tar.gz / tar.bz2 / tar.xz / tar.zst / tar.br）：7-Zip 先解出 .tar，需要第二趟
    const base = path.basename(source);
    const needsSecond = isTarFlavored(base) && !/\.tar$/i.test(base);
    if (needsSecond) {
      const inner = findInnerTar(base, fs.readdirSync(outputDir));
      if (inner) {
        const innerPath = path.join(outputDir, inner);
        // 第二趟也要过一遍安全闸门：外层（.gz/.xz）只包着 tar，可疑路径藏在 tar 里面
        if (guardTraversal) {
          const g = await guardBeforeExtract({ archivePath: innerPath, password, binPath });
          if (g) {
            await cleanupFailedOutput(outputDir, existedBefore, namesBefore);
            return g;
          }
        }
        const res2 = await run(extractArgs({ archivePath: innerPath, outputDir, password, overwrite, flatten }), undefined);
        if (res2.canceled) return { ok: false, canceled: true };
        if (res2.code !== 0) {
          await cleanupFailedOutput(outputDir, existedBefore, namesBefore);
          return { ok: false, message: translateSevenZipError(res2) };
        }
        await fsp.rm(innerPath, { force: true }).catch(() => {}); // 中间 tar 不留给用户
      } else {
        // 没找到唯一的 .tar：说明外层解出来的不是标准 tar（或不止一个），如实报错而不是假装成功
        await cleanupFailedOutput(outputDir, existedBefore, namesBefore);
        return { ok: false, message: '解压失败：外层解开后没有找到预期的 .tar 内容' };
      }
    }

    const addedFiles = countFilesSince(outputDir, filesBefore);
    // 「跳过已存在」(-aos) 时 7-Zip 会**一个都不解**却仍然退出码 0 并打印 Everything is Ok。
    // 这种「什么都没做」不能算解压成功（否则密码错误也会被误报成成功）。
    // 判断标准 = **这次新增了几个文件**（不是目录里的总数）。
    // 注意：zip 的目录不加密，`7z l` 用错密码也能列出来（退出码 0），所以列目录**查不出**
    // 密码错；这时用 `7z t`（读一遍数据验 CRC）才能分辨「密码错」与「文件都已存在」。
    if (addedFiles === 0) {
      const verdict = await diagnoseNothingExtracted({ archivePath: source, password, binPath });
      return { ok: false, message: verdict };
    }
    return { ok: true, dir: outputDir, files: addedFiles };
  } catch (err) {
    return { ok: false, message: (err && err.message) || String(err) };
  }
}

/**
 * 「一个文件都没解出来」时给出准确原因（只在这一种情况下才跑，平时不额外花时间）。
 * 用 `7z t` 读一遍数据验 CRC：
 *   · 退出码非 0 → 密码错（或数据损坏）；
 *   · 退出码 0   → 包本身没问题，那就是目标目录里已有同名文件、被「跳过已存在」全跳过了。
 */
async function diagnoseNothingExtracted({ archivePath, password, binPath }) {
  const res = await run7z(binPath, testArgs({ archivePath, password }), { timeoutMs: 60 * 60 * 1000 });
  if (res.code !== 0) {
    const why = translateSevenZipError(res);
    return `没有解出任何文件：${why}`;
  }
  return '没有解出任何文件：目标目录里已存在同名文件，当前策略是「跳过已存在」；'
    + '要覆盖请把「已存在时」改成「覆盖已存在」';
}

/**
 * 解压前的安全/可用性闸门：列一次目录。
 * 返回 null 表示放行；返回 {ok:false, message} 表示拒绝。
 */
async function guardBeforeExtract({ archivePath, password, binPath }) {
  // zst / br 走 Node 流式解压，没有「条目路径」的概念，不需要闸门。
  // （tar.br / tar.zst 的第一趟是 Node 解压，第二趟会拿解出的 .tar 再过一次闸门，所以这里也跳过。）
  if (/\.(zst|br)$/i.test(archivePath)) return null;
  const listed = await listArchive({ archivePath, password, binPath });
  if (!listed.ok) return { ok: false, message: listed.message };
  if (listed.suspicious && listed.suspicious.length > 0) {
    const sample = listed.suspicious.slice(0, 3).map((e) => e.path).join('、');
    return {
      ok: false,
      message: `出于安全已拒绝解压：压缩包里有 ${listed.suspicious.length} 个可疑路径（如 ${sample}）`
    };
  }
  return null;
}

/** 解压失败时清理：目录本来不存在就整个删掉；本来就存在则只删本次新增的顶层项 */
export async function cleanupFailedOutput(outputDir, existedBefore, namesBefore) {
  try {
    if (!existedBefore) {
      await fsp.rm(outputDir, { recursive: true, force: true });
      return;
    }
    // 目录是用户原本就有的，却没有拿到「解压前顶层名」快照：宁可留半成品也绝不动手。
    // 少这一道闸就会退化成「把整个目录删光」（本函数只被失败路径调用，静默且不可恢复）。
    if (!(namesBefore instanceof Set)) return;
    for (const name of fs.readdirSync(outputDir)) {
      if (namesBefore.has(name)) continue;
      await fsp.rm(path.join(outputDir, name), { recursive: true, force: true }).catch(() => {});
    }
  } catch { /* 清理失败不影响结论 */ }
}

function countFiles(dir) {
  return snapshotFiles(dir).size;
}

/** 目录下所有文件的「相对路径 → 大小」快照（用于判断一次解压新增了什么） */
function snapshotFiles(dir) {
  const acc = new Map();
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* 读不到按 0 */ }
        acc.set(path.relative(dir, full), size);
      }
    }
  };
  walk(dir);
  return acc;
}

/** 相比快照，这次**新增**（或大小发生变化）的文件数 */
function countFilesSince(dir, before) {
  const now = snapshotFiles(dir);
  let n = 0;
  for (const [rel, size] of now) {
    if (!before.has(rel) || before.get(rel) !== size) n += 1;
  }
  return n;
}

// —— Node 内置 zlib（zstd / brotli）流式压缩解压 ——

/**
 * 计数用的 Transform（进度上报）。
 * ⚠️ 教训：**不能**直接给源流挂 `on('data')` 来数字节——那会把流切到 flowing 模式，
 * 在 `pipeline()` 接上消费者之前就已经吐掉数据（小文件直接丢光，压出来只剩 zstd 帧头 9 字节、
 * 解压得到空文件）。放进管道里当一环才是安全的。
 */
function counterTransform(total, onProgress) {
  let done = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      if (onProgress) onProgress(total ? Math.min(100, (done / total) * 100) : 0);
      cb(null, chunk);
    }
  });
}

/** zstd / brotli 流式压缩（大文件不进内存：全程管道） */
export async function nodeCompress({ src, target, engine, level, onProgress }) {
  const total = safeSize(src);
  const codec = engine === 'br'
    ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality(level) } })
    : zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: zstdLevel(level) } });
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await pipeline(createReadStream(src), counterTransform(total, onProgress), codec, createWriteStream(target));
  const size = safeSize(target);
  if (size === 0) throw new Error('压缩结果为空（写入失败）');
  return { ok: true, inputBytes: total, size };
}

/** zstd / brotli 流式解压 */
export async function nodeDecompress({ src, target, engine, onProgress }) {
  const total = safeSize(src);
  const codec = engine === 'br' ? zlib.createBrotliDecompress() : zlib.createZstdDecompress();
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await pipeline(createReadStream(src), counterTransform(total, onProgress), codec, createWriteStream(target));
  return { ok: true, size: safeSize(target) };
}

function safeSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/** 临时目录（复合格式的中间 .tar 放这里；调用方负责 finally 清理） */
export function makeTempDir(tag) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `tomato-archive-${tag}-`));
}

export { isTarFlavored, testArgs };
