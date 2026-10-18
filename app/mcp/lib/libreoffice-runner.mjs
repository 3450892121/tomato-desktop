// MCP 侧的 LibreOffice 封装（Node 进程）
// 与 GUI 的 libreoffice:convert 同一套思路：临时目录转换、短路径联接、超时杀进程树。
// 说明：LibreOffice 在长/中文路径下导入 PDF 会失败，所以这里也建一个 junction 到短路径。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { appRoot } from './paths.mjs';

function findLibreOffice() {
  const addon = path.join(appRoot(), 'addons', 'libreoffice');
  const candidates = [
    path.join(addon, 'program', 'soffice.com'),
    path.join(addon, 'program', 'soffice.exe'),
    'C:\\Program Files\\LibreOffice\\program\\soffice.com',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com'
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return '';
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

/** 建/复用短路径 junction；失败就退回原路径 */
function shortPathFor(sofficePath) {
  const exeName = path.basename(sofficePath);
  const addonRoot = path.dirname(path.dirname(sofficePath));
  const candidates = [os.tmpdir(), process.env.PUBLIC || ''];
  const root = candidates.find((r) => r && /^[\x20-\x7E]+$/.test(r)) || candidates[0];
  const linkDir = path.join(root, 'tomato-lo', 'libreoffice');
  try {
    const linkSoffice = path.join(linkDir, 'program', exeName);
    let valid = false;
    try {
      const st = fs.lstatSync(linkDir);
      if (st.isSymbolicLink() || st.isDirectory()) {
        const target = fs.readlinkSync(linkDir);
        valid = path.resolve(target) === path.resolve(addonRoot) && fs.existsSync(linkSoffice);
      }
    } catch { /* 链接不存在 */ }
    if (!valid) {
      try {
        const st = fs.lstatSync(linkDir);
        if (st.isSymbolicLink()) fs.rmdirSync(linkDir);
        else if (st.isDirectory()) fs.rmSync(linkDir, { recursive: true, force: true });
        else fs.unlinkSync(linkDir);
      } catch { /* 忽略 */ }
      fs.mkdirSync(path.dirname(linkDir), { recursive: true });
      fs.symlinkSync(addonRoot, linkDir, 'junction');
    }
    if (fs.existsSync(linkSoffice)) return linkSoffice;
  } catch { /* 建链接失败 */ }
  return sofficePath;
}

export function libreofficeStatus() {
  const p = findLibreOffice();
  return { found: !!p, path: p || null };
}

/**
 * 转换单个文件
 * @param {{inputPath:string, target:'pdf'|'docx'|'xlsx'|'pptx', mode?:'layout'|'text'}} opts
 * @returns {Promise<{ok:true,bytes:Buffer,ms:number,flatten?:object}|{ok:false,message:string}>}
 */
export async function convertWithLibreOffice({ inputPath, target, mode = 'layout' }) {
  const soffice = findLibreOffice();
  if (!soffice) return { ok: false, message: '未检测到 LibreOffice（把 addons/libreoffice 放回软件目录）' };
  if (!fs.existsSync(inputPath)) return { ok: false, message: '找不到输入文件' };
  const t = ['pdf', 'docx', 'xlsx', 'pptx'].includes(target) ? target : 'pdf';

  const workDir = path.join(os.tmpdir(), `tomato-mcp-lo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.mkdir(workDir, { recursive: true });
  const profileDir = path.join(appRoot(), 'userdata', 'libreoffice-profile');
  await fsp.mkdir(profileDir, { recursive: true });

  const runSoffice = shortPathFor(soffice);
  const sizeMb = await fsp.stat(inputPath).then((s) => s.size / (1024 * 1024)).catch(() => 0);
  const timeoutMs = Math.min(30 * 60 * 1000, Math.max(5 * 60 * 1000, Math.round(sizeMb * 60 * 1000)));

  const args = ['--headless', '--norestore', '--invisible', `-env:UserInstallation=${pathToFileURL(profileDir).href}`];
  if (t === 'docx' && /\.pdf$/i.test(inputPath)) args.push('--infilter=writer_pdf_import');
  args.push('--convert-to', t, '--outdir', workDir, inputPath);

  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    const child = spawn(runSoffice, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err.message || err), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });

  try {
    let outPath = null;
    try {
      const entries = await fsp.readdir(workDir);
      const wanted = entries.find((n) => n.toLowerCase().endsWith(`.${t}`));
      if (wanted) outPath = path.join(workDir, wanted);
    } catch { /* 无输出 */ }

    if (res.timedOut || res.code !== 0 || !outPath) {
      const minutes = Math.max(1, Math.round(timeoutMs / 60000));
      const detail = res.timedOut
        ? `超时（超过 ${minutes} 分钟）`
        : res.code === 0
          ? '未生成输出文件（源文件可能已加密或格式不受支持）'
          : `LibreOffice 退出码 ${res.code}`;
      const extra = String(res.stderr || '').trim().slice(0, 300);
      return { ok: false, message: `转换失败：${detail}${extra ? `｜${extra}` : ''}` };
    }

    let bytes = await fsp.readFile(outPath);
    let flatten = null;
    if (t === 'docx' && mode === 'text') {
      try {
        const mod = await import('../../src/tools/pdf-convert/core/flatten-docx.cjs');
        const flattenDocx = (mod.default || mod).flattenDocx;
        const r = await flattenDocx(bytes);
        bytes = Buffer.from(r.bytes);
        flatten = r.stats;
      } catch (err) {
        flatten = { applied: false, error: String((err && err.message) || err) };
      }
    }
    return { ok: true, bytes, ms: Date.now() - t0, flatten };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
