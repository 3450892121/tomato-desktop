// 「文件藏图」的引擎层（Node 侧；由主进程 main.js 动态 import 使用，测试可直接 import）
// 职责：读表图/里图、拼载荷、按载体嵌入或提取、密码加解密、落盘与命名。
// 纯逻辑（格式/载荷/命名）在 ./format.mjs，密码在 ./crypto.mjs；本文件只管文件系统与 zlib。
// 规格：spec/modules/imghide.md
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  detectCoverKind, pngInfo, pngCompatError, parsePngChunks, concatIdatData,
  extractPayloadFromInflatedPng, writePngWithIdat, embedPayloadInGif, extractPayloadFromGif,
  buildPayload, parsePayload, safeEntryName, uniqueEntryName, concatBytes
} from './format.mjs';
import { encryptPayload, decryptPayload } from './crypto.mjs';

/** 半成品不留垃圾：产物先写同目录临时名，成功后再改名到位 */
const TMP_SUFFIX = '.part';

/** 输出不覆盖已有文件：重名自动加序号（与既有工具同一约定） */
export function uniqueTargetPath(dir, baseName, ext) {
  const tryPath = (name) => path.join(dir, `${name}${ext}`);
  let candidate = tryPath(baseName);
  for (let i = 2; i < 10000; i += 1) {
    if (!fsExists(candidate)) return candidate;
    candidate = tryPath(`${baseName}(${i})`);
  }
  return tryPath(`${baseName}(${Date.now()})`);
}

function fsExists(p) {
  // 这里用同步判断即可：调用点都在同一事件循环内做命名决策
  return fsSync.existsSync(p);
}

/** 目录也要防重名（解包默认落在 `<图片名>_解出`） */
export function uniqueTargetDir(parentDir, baseName) {
  let candidate = path.join(parentDir, baseName);
  for (let i = 2; i < 10000; i += 1) {
    if (!fsExists(candidate)) return candidate;
    candidate = path.join(parentDir, `${baseName}(${i})`);
  }
  return path.join(parentDir, `${baseName}(${Date.now()})`);
}

/**
 * 看一张表图/图夹图的基本情况（界面用来提示；不读像素）
 * @param {{filePath: string}} options
 */
export async function inspectImage({ filePath }) {
  const bytes = await fsp.readFile(filePath);
  const kind = detectCoverKind(bytes);
  const out = { path: filePath, name: path.basename(filePath), size: bytes.length, kind };
  if (kind === 'png') {
    const info = pngInfo(bytes);
    out.width = info.width;
    out.height = info.height;
    out.reencodeReason = pngCompatError(info);
  }
  return out;
}

function progressReporter(onProgress) {
  if (typeof onProgress !== 'function') return () => {};
  let last = -1;
  return (percent, text) => {
    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    if (pct === last) return;
    last = pct;
    onProgress({ percent: pct, text });
  };
}

/**
 * 打包：把「里图」（任意文件）藏进「表图」，产出可互通的图夹图
 * @param {{
 *   coverPath?: string,
 *   coverBytes?: Uint8Array,
 *   coverKind?: 'gif'|'png',
 *   items: {path: string, name?: string}[],
 *   password?: string,
 *   outputDir?: string,
 *   baseName?: string,
 *   onProgress?: (p: {percent: number, text: string}) => void
 * }} options
 */
export async function packImage(options) {
  const started = Date.now();
  const report = progressReporter(options.onProgress);
  const items = Array.isArray(options.items) ? options.items : [];
  if (items.length === 0) throw new Error('还没有要藏进去的文件');

  const coverBytes = options.coverBytes
    ? (options.coverBytes instanceof Uint8Array ? options.coverBytes : new Uint8Array(options.coverBytes))
    : await fsp.readFile(options.coverPath);
  const kind = options.coverKind || detectCoverKind(coverBytes);
  if (kind !== 'gif' && kind !== 'png') {
    throw new Error('表图只支持 PNG / GIF（其它格式请先选一次「自动转 PNG」）');
  }
  if (kind === 'png') {
    const reason = pngCompatError(pngInfo(coverBytes));
    if (reason) throw new Error(`这张 PNG 需要先转成 8 位 PNG（${reason}）`);
  }

  // 1) 读里图 + 拼载荷
  const entries = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const name = item.name || path.basename(item.path);
    report((i / items.length) * 45, `读取 ${name}`);
    const bytes = new Uint8Array(await fsp.readFile(item.path));
    entries.push({ name, bytes });
  }
  report(50, '拼装数据');
  let payload = buildPayload(entries);
  if (options.password) {
    report(55, '加密');
    payload = encryptPayload(payload, options.password);
  }

  // 2) 嵌入载体
  let outBytes;
  let ext;
  if (kind === 'gif') {
    report(65, '写入 GIF');
    outBytes = embedPayloadInGif(coverBytes, payload);
    ext = '.gif';
  } else {
    report(65, '写入 PNG');
    const inflated = zlib.inflateSync(concatIdatData(coverBytes, parsePngChunks(coverBytes)));
    const deflated = zlib.deflateSync(concatBytes([inflated, payload]));
    outBytes = writePngWithIdat(coverBytes, deflated);
    ext = '.png';
  }

  // 3) 落盘（默认放在表图旁边）
  const sourceDir = options.coverPath ? path.dirname(options.coverPath) : null;
  const dir = options.outputDir || sourceDir;
  if (!dir) throw new Error('缺少输出目录');
  await fsp.mkdir(dir, { recursive: true });
  const base = options.baseName
    || `${path.basename(options.coverPath || '图夹', path.extname(options.coverPath || ''))}_图夹`;
  const target = uniqueTargetPath(dir, base, ext);
  const tmp = `${target}${TMP_SUFFIX}`;
  report(85, '写文件');
  await fsp.writeFile(tmp, outBytes);
  await fsp.rename(tmp, target);
  report(100, '完成');

  return { ok: true, path: target, size: outBytes.length, ms: Date.now() - started, kind, files: entries.length };
}

/**
 * 解包：把图夹图里的文件取出来（默认落在图片旁边的 `<图片名>_解出/`）
 * @param {{
 *   imagePath: string,
 *   password?: string,
 *   outputDir?: string,
 *   onProgress?: (p: {percent: number, text: string}) => void
 * }} options
 */
export async function unpackImage(options) {
  const started = Date.now();
  const report = progressReporter(options.onProgress);
  report(10, '读取图片');
  const bytes = new Uint8Array(await fsp.readFile(options.imagePath));
  const kind = detectCoverKind(bytes);
  if (kind !== 'gif' && kind !== 'png') {
    throw new Error('这个文件不是 PNG / GIF 图夹（官方格式只支持这两种载体）');
  }

  report(30, '取出数据');
  let payload;
  if (kind === 'gif') {
    payload = extractPayloadFromGif(bytes);
  } else {
    const info = pngInfo(bytes);
    const inflated = zlib.inflateSync(concatIdatData(bytes, parsePngChunks(bytes)));
    payload = extractPayloadFromInflatedPng(inflated, info);
  }

  let encrypted = false;
  if (options.password) {
    report(50, '解密');
    payload = decryptPayload(payload, options.password);
    encrypted = true;
  }

  report(70, '解析文件表');
  let files;
  try {
    files = parsePayload(payload);
  } catch (err) {
    if (!options.password) {
      throw new Error('解包失败：这张图可能设了密码（请填密码后重试），或图片被压缩/损坏（数据已丢失）');
    }
    throw new Error(`解包失败：${err.message}`);
  }

  const dir = options.outputDir
    || uniqueTargetDir(path.dirname(options.imagePath), `${path.basename(options.imagePath, path.extname(options.imagePath))}_解出`);
  await fsp.mkdir(dir, { recursive: true });

  const used = new Set();
  const written = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const name = uniqueEntryName(used, safeEntryName(file.name));
    const target = path.join(dir, name);
    report(70 + (i / files.length) * 28, `写出 ${name}`);
    await fsp.writeFile(target, file.bytes);
    written.push({ name, path: target, size: file.bytes.length });
  }
  report(100, '完成');

  return { ok: true, dir, files: written, ms: Date.now() - started, encrypted };
}