// 下载引擎（yt-dlp）自更新：查官方 nightly 最新版 → 下载 → SHA-256 校验 → 装到用户数据目录。
// 设计约束（见 spec/modules/videodl.md）：
//   - 随包版本（addons/ytdlp）是兜底；更新版只写 userdata，不动软件本体
//   - 校验不过的包一律拒绝；更新失败自动退回随包版（manager 侧兜底）
//   - 国内网络：优先用 Windows 自带 curl.exe（支持 --proxy），没有才退回 Node fetch（不支持代理）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';

/** 随包引擎的固定版本与指纹（来源：上游 leetools dependencies.windows.json，2026-09-26 同步） */
export const PINNED_ENGINE = {
  version: '2026.08.04.234419',
  sha256: 'e78500d301b5de3a9280a418f6dd45604c4d85b718b0a2447c1b0aa9699e2689',
  channel: 'yt-dlp-nightly-builds',
};

const API_LATEST = 'https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest';

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/**
 * 查官方最新 nightly。返回 { version, url, sha256 }；digest 缺失或结构异常一律报错（不猜）。
 */
export async function checkLatestEngine({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl(API_LATEST, {
    headers: { 'User-Agent': 'tomato-toolbox-videodl', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`);
  const data = await response.json();
  const tag = String(data.tag_name || '');
  const asset = (data.assets || []).find((a) => a && a.name === 'yt-dlp.exe');
  if (!tag || !asset?.browser_download_url) throw new Error('官方发布信息不完整');
  const digest = String(asset.digest || '');
  const m = digest.match(/^sha256:([a-f0-9]{64})$/i);
  if (!m) throw new Error('官方发布缺少 sha256 校验值，拒绝自动更新');
  return { version: tag, url: asset.browser_download_url, sha256: m[1].toLowerCase() };
}

function hasCurl() {
  try {
    const r = spawnSync('where', ['curl.exe'], { windowsHide: true, encoding: 'utf8' });
    return r.status === 0;
  } catch { return false; }
}

/**
 * 下载并校验到 destFile。用 curl.exe（可走代理）或 Node fetch（直连）。
 * onProgress({received, total}) —— total 未知时记 0。
 */
export async function downloadEngine({ url, sha256, destFile, proxy = '', onProgress, signal, fetchImpl = fetch }) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const partial = destFile + '.part';
  try { fs.unlinkSync(partial); } catch {}
  if (hasCurl()) {
    const args = ['-L', '--fail', '--retry', '3', '--connect-timeout', '20', '-s', '-o', partial, url];
    if (proxy) args.push('--proxy', proxy);
    const child = spawn('curl.exe', args, { windowsHide: true, stdio: 'ignore' });
    const timer = setInterval(() => {
      try { onProgress?.({ received: fs.statSync(partial).size, total: 0 }); } catch {}
    }, 500);
    const code = await new Promise((resolve) => {
      child.on('error', () => resolve(-1));
      child.on('close', (c) => resolve(c));
      if (signal) signal.addEventListener('abort', () => { try { child.kill(); } catch {} }, { once: true });
    });
    clearInterval(timer);
    if (code !== 0) {
      try { fs.unlinkSync(partial); } catch {}
      if (signal?.aborted) throw new Error('已取消');
      throw new Error('下载引擎失败，请检查网络或代理后重试');
    }
  } else {
    const response = await fetchImpl(url, { signal: signal || AbortSignal.timeout(300000) });
    if (!response.ok || !response.body) throw new Error(`下载引擎失败（HTTP ${response.status}）`);
    const total = Number(response.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(partial, { flags: 'wx' });
    let received = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.length;
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
        onProgress?.({ received, total });
      }
      out.end();
      await new Promise((resolve, reject) => { out.on('error', reject); out.on('close', resolve); });
    } catch (error) {
      out.destroy();
      try { fs.unlinkSync(partial); } catch {}
      throw error;
    }
  }
  const actual = sha256File(partial);
  if (actual !== String(sha256).toLowerCase()) {
    try { fs.unlinkSync(partial); } catch {}
    throw new Error('下载的引擎校验不通过，已丢弃（不替换现有引擎）');
  }
  fs.renameSync(partial, destFile);
  return { sha256: actual };
}

/**
 * 安装到引擎目录：yt-dlp-<version>.exe + manifest.json（原子写）。
 * 旧版本文件尽力删除（Windows 上被占用时跳过，不影响使用）。
 */
export function installEngine({ srcFile, engineDir, version, sha256 }) {
  fs.mkdirSync(engineDir, { recursive: true });
  const fileName = `yt-dlp-${version}.exe`;
  const dest = path.join(engineDir, fileName);
  fs.copyFileSync(srcFile, dest);
  const manifest = { version, sha256, file: fileName, installedAt: Date.now(), source: 'yt-dlp-nightly-builds/latest' };
  const temp = path.join(engineDir, 'manifest.json.tmp');
  fs.writeFileSync(temp, JSON.stringify(manifest, null, 2));
  fs.renameSync(temp, path.join(engineDir, 'manifest.json'));
  for (const entry of fs.readdirSync(engineDir)) {
    if (/^yt-dlp-.*\.exe$/.test(entry) && entry !== fileName) {
      try { fs.unlinkSync(path.join(engineDir, entry)); } catch {}
    }
  }
  return { path: dest, ...manifest };
}

/** 读取已安装的更新版引擎（校验指纹；不信任 manifest，指纹不符视为没有） */
export function readInstalledEngine(engineDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(engineDir, 'manifest.json'), 'utf8'));
    const file = path.join(engineDir, String(manifest.file || ''));
    if (!fs.existsSync(file)) return null;
    if (sha256File(file) !== String(manifest.sha256 || '').toLowerCase()) return null;
    return { path: file, version: String(manifest.version || ''), sha256: manifest.sha256, installedAt: Number(manifest.installedAt) || 0 };
  } catch { return null; }
}
