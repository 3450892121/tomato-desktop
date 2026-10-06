// 工具：软件卸载 —— 「提权启动」纯逻辑（主进程与自检共用；见 spec/modules/uninstall.md）
// 这里只做纯函数：拼 PowerShell 命令、把执行结果翻成结论。不带 Electron / 文件系统依赖，
// 因此可以被主进程动态 import，也能被 node 直接加载做单测。
import path from 'node:path';

/** 加装包内的 exe 文件名（保持官方原名，不做改名） */
export const EXE_NAME = 'HiBitUninstaller-Portable.exe';
/** 加装包内的版本号文件名（一行纯文本，界面用它显示版本） */
export const VERSION_FILE = '版本.txt';

/**
 * 提权用的 Windows PowerShell 绝对路径。
 * 为什么写死绝对路径：PATH 不完整时 execFileSync('powershell') 会 ENOENT，
 * 曾经在 pack.js 上踩过同款坑（快捷方式没同步成功）。
 */
export function powershellPath(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** PowerShell 单引号字面量：内部单引号翻倍。中文/空格/& 等字符都安全，不做任何命令拼接 */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 构造提权启动脚本：`Start-Process -Verb RunAs`（Windows 标准提权路径，Electron 自身没有提权 API）。
 * - 不传任何参数给对方：卸载什么、删哪些残留，全部由用户在目标界面里自己点；
 * - RunAs 会由系统弹 UAC 把关，本软件不缓存/不代填任何凭据。
 */
export function buildRunAsScript({ exePath, workingDir }) {
  const parts = [`-FilePath ${psQuote(exePath)}`];
  if (workingDir) parts.push(`-WorkingDirectory ${psQuote(workingDir)}`);
  parts.push('-Verb RunAs');
  return `Start-Process ${parts.join(' ')}`;
}

/**
 * 把 PowerShell 的执行结果翻成界面能用的三态结论：
 *  - `{ ok: true }`：已发起启动（UAC 里点了「是」）；
 *  - `{ ok: false, canceled: true }`：用户在 UAC 里点了「否」——不是错误，界面温和提示；
 *  - `{ ok: false, message }`：真失败（附可读原因）。
 */
export function interpretLaunchResult({ status, stdout = '', stderr = '' } = {}) {
  const text = `${stderr}${stdout}`.trim();
  if (status === 0) return { ok: true };
  if (/cancel(?:led|ed)|取消/i.test(text)) return { ok: false, canceled: true, message: '已取消管理员授权' };
  const last = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
  return { ok: false, message: last || `启动失败（退出码 ${status}）` };
}

/** 加装包状态（纯函数：主进程只负责把「文件在不在」「版本文件内容」喂进来） */
export function describeAddonStatus({ found, exePath = null, dir = null, version = '' } = {}) {
  return {
    ok: !!found,
    found: !!found,
    path: exePath,
    dir,
    version: String(version || '').trim()
  };
}