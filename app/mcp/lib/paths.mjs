// MCP 侧的路径与安全策略（纯 Node，不依赖 Electron）
//
// 三条硬约束：
//   1) 所有产物都走 uniqueTargetPath —— 重名加序号，绝不覆盖用户已有文件；
//   2) 所有读写路径必须在「允许根」内（默认：用户目录 / 系统临时目录 / 软件目录 / 当前工作目录）；
//      需要处理别的盘或目录时，用 TOMATO_MCP_ALLOWED_ROOTS 显式放行（分号分隔）；
//   3) MCP 不是沙箱：它只能挡「明显的越界路径」，不能挡用户主动把文件放到别处。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import uniqueTargetPathModule from '../../src/shared/unique-target-path.cjs';

export const { uniqueTargetPath } = uniqueTargetPathModule;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** app 目录（本文件在 app/mcp/lib/） */
export function appRoot() {
  return path.resolve(HERE, '../..');
}

/**
 * 绿色版根目录（addons / userdata 所在层）
 * - 开发态：app 目录（addons 在 app/addons）
 * - 打包态：<软件目录>（appRoot = <软件目录>/resources/app；addons 在 <软件目录>/addons）
 */
export function portableRoot() {
  const root = appRoot();
  const parent = path.dirname(root);
  if (path.basename(parent).toLowerCase() === 'resources') return path.dirname(parent);
  return root;
}

/** 用户数据目录（设置 / 审计日志 / 视频下载授权）；可用 TOMATO_USERDATA_DIR 覆盖 */
export function userdataDir() {
  const override = process.env.TOMATO_USERDATA_DIR;
  if (override) return path.resolve(override);
  return path.join(portableRoot(), 'userdata');
}

/**
 * 允许的路径根：
 * - 默认：用户目录（含桌面/文档/下载）、系统临时目录、软件目录、当前工作目录；
 * - TOMATO_MCP_ALLOWED_ROOTS 可覆盖（Windows 用分号分隔，其它平台用 path.delimiter）。
 */
export function allowedRoots() {
  const env = String(process.env.TOMATO_MCP_ALLOWED_ROOTS || '').trim();
  if (env) {
    return env.split(path.delimiter).map((s) => s.trim()).filter(Boolean).map((s) => path.resolve(s));
  }
  const roots = [os.homedir(), os.tmpdir(), portableRoot()];
  // 去重（大小写不敏感；Windows 路径常见大小写差异）
  const seen = new Set();
  const out = [];
  for (const r of roots) {
    if (!r) continue;
    const key = path.resolve(r).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path.resolve(r));
  }
  return out;
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 断言路径在允许根内；返回绝对路径 */
export function assertAllowed(p, label = '路径') {
  if (!p) throw new Error(`缺少${label}路径`);
  const abs = path.resolve(String(p));
  const roots = allowedRoots();
  if (!roots.some((root) => inside(root, abs))) {
    throw new Error(
      `${label}不在允许范围：${abs}\n允许根：${roots.join('；')}\n`
      + '（需要处理其它目录时，给 MCP server 设 TOMATO_MCP_ALLOWED_ROOTS，例如 D:\\素材;E:\\输出）'
    );
  }
  return abs;
}

/** 确保目录存在（先过路径白名单） */
export async function ensureDir(dir) {
  const abs = assertAllowed(dir, '目录');
  await fsp.mkdir(abs, { recursive: true });
  return abs;
}

/** 路径是否存在（文件或目录） */
export function exists(p) {
  return !!p && fs.existsSync(p);
}

/** 断言是文件（先过路径白名单） */
export function assertFile(p, label = '输入文件') {
  if (!p) throw new Error(`缺少${label}路径`);
  const abs = assertAllowed(p, label);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`${label}不存在：${abs}`);
  }
  if (!st.isFile()) throw new Error(`${label}不是文件：${abs}`);
  return abs;
}

/** 断言是目录（允许不存在，由调用方 ensureDir；先过路径白名单） */
export function assertDir(dir, label = '目录') {
  if (!dir) throw new Error(`缺少${label}路径`);
  return assertAllowed(dir, label);
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
 * 输出目录必须先过路径白名单。
 * @returns {{dir:string, base:string, ext:string, path:string}}
 */
export function resolveOutputPath({ output, output_dir, base_name, ext, fallbackDir }) {
  const wantedExt = normalizeExt(ext) || '.bin';
  let dir;
  let base;
  let finalExt = wantedExt;

  if (output) {
    const abs = assertAllowed(output, '输出文件');
    const outExt = path.extname(abs);
    finalExt = outExt || wantedExt;
    dir = path.dirname(abs);
    base = path.basename(abs, outExt);
  } else {
    dir = assertAllowed(output_dir || fallbackDir || process.cwd(), '输出目录');
    base = String(base_name || 'output');
  }

  fs.mkdirSync(dir, { recursive: true });
  return { dir, base, ext: finalExt, path: uniqueTargetPath(dir, base, finalExt) };
}

/** 读 JSON；不存在或损坏返回 null */
export async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(assertAllowed(file, 'JSON 文件'), 'utf8'));
  } catch {
    return null;
  }
}

/** 写 JSON（原子写：先写临时文件再 rename；先过路径白名单） */
export async function writeJson(file, value) {
  const abs = assertAllowed(file, 'JSON 文件');
  await ensureDir(path.dirname(abs));
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, abs);
}
