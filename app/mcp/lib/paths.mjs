// MCP 侧的路径小工具（纯 Node，不依赖 Electron）
// 约定：所有产物都走 uniqueTargetPath —— 重名加序号，绝不覆盖用户已有文件。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import uniqueTargetPathModule from '../../src/shared/unique-target-path.cjs';

export const { uniqueTargetPath } = uniqueTargetPathModule;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** app 目录（本文件在 app/mcp/lib/） */
export function appRoot() {
  return path.resolve(HERE, '../..');
}

/** 确保目录存在 */
export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** 路径是否存在（文件或目录） */
export function exists(p) {
  return !!p && fs.existsSync(p);
}

/** 断言是文件 */
export function assertFile(p, label = '输入文件') {
  const abs = path.resolve(String(p || ''));
  if (!p) throw new Error(`缺少${label}路径`);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`${label}不存在：${abs}`);
  }
  if (!st.isFile()) throw new Error(`${label}不是文件：${abs}`);
  return abs;
}

/** 断言是目录（允许不存在，由调用方 ensureDir） */
export function assertDir(dir, label = '目录') {
  if (!dir) throw new Error(`缺少${label}路径`);
  return path.resolve(String(dir));
}

/** 扩展名归一：'png' / '.png' → '.png' */
export function normalizeExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (!e) return '';
  return e.startsWith('.') ? e : `.${e}`;
}

/**
 * 解析输出路径：
 * - 给了 output：以它为准，但重名时自动加序号（不覆盖）
 * - 否则：output_dir + base_name + ext
 * @returns {{dir:string, base:string, ext:string, path:string}}
 */
export function resolveOutputPath({ output, output_dir, base_name, ext, fallbackDir }) {
  const wantedExt = normalizeExt(ext) || '.bin';
  let dir;
  let base;
  let finalExt = wantedExt;

  if (output) {
    const abs = path.resolve(String(output));
    const outExt = path.extname(abs);
    finalExt = outExt || wantedExt;
    dir = path.dirname(abs);
    base = path.basename(abs, outExt);
  } else {
    dir = path.resolve(String(output_dir || fallbackDir || process.cwd()));
    base = String(base_name || 'output');
  }

  fs.mkdirSync(dir, { recursive: true });
  return { dir, base, ext: finalExt, path: uniqueTargetPath(dir, base, finalExt) };
}

/** 读 JSON；不存在或损坏返回 null */
export async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 写 JSON（原子写：先写临时文件再 rename） */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}
