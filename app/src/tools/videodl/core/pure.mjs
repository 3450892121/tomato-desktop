// 视频下载的纯逻辑小件（无 Electron / 无网络调用，便于 Node 直接单测：tests/videodl.test.mjs）。
// 行为对齐上游 leetools/video-downloader server.js（MIT，见 ../UPSTREAM-LICENSE.txt）：
// URL 提取、文件名净化、速度/剩余时间格式、yt-dlp 输出行解析、抖音游客页数据解析。
import path from 'node:path';

/** 从随意粘贴的文本里抠出第一个 http(s) 链接（去掉中文标点尾巴） */
export function extractUrl(value) {
  const m = String(value || '').match(/https?:\/\/[^\s<>"'，。！？；、）)\]】}>》」』]+/i);
  return m ? m[0].replace(/[，。！？；、,)\]}>]+$/g, '') : '';
}

/** 文件名净化：去掉 Windows 非法字符、压空格、去尾点，截断 80 字符 */
export function safeFileName(value) {
  const cleaned = String(value || '抖音视频')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  return (cleaned || '抖音视频').slice(0, 80);
}

export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)}MiB/s`;
  return `${Math.round(bytesPerSecond / 1024)}KiB/s`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const rounded = Math.ceil(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${String(minutes).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
}

export function isDouyinUrl(value) {
  try { return /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i.test(new URL(value).hostname); } catch { return false; }
}

export function isYouTubeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
  } catch { return false; }
}

export function isXiaohongshuUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'xhslink.com' || host.endsWith('.xhslink.com')
      || host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com');
  } catch { return false; }
}

export function extractDouyinVideoId(value) {
  const text = String(value || '');
  const pathId = text.match(/\/(?:video|note)\/(\d{15,25})(?:[/?#]|$)/i)?.[1];
  if (pathId) return pathId;
  try {
    const parsed = new URL(text);
    for (const key of ['modal_id', 'aweme_id', 'item_id', 'item_ids']) {
      const candidate = String(parsed.searchParams.get(key) || '').match(/^\d{15,25}$/)?.[0];
      if (candidate) return candidate;
    }
  } catch {}
  return '';
}

/** 把响应头里的 Set-Cookie 列表转成可以原样带回去的 "name=value" 数组（去掉 Path/Expires 等属性） */
export function cookiePairsFromSetCookie(setCookieHeaders) {
  return (Array.isArray(setCookieHeaders) ? setCookieHeaders : [])
    .map((line) => String(line || '').split(';')[0].trim())
    .filter((pair) => pair.includes('='));
}

/**
 * 取抖音分享页的 SSR 数据块 window._ROUTER_DATA。
 * 返回 { ok:true, data } 或 { ok:false, reason:'missing'|'bad-json' }——两种失败要报不同的话，所以不直接抛。
 */
export function parseDouyinRouterData(html) {
  const json = String(html || '').match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/)?.[1];
  if (!json) return { ok: false, reason: 'missing' };
  try { return { ok: true, data: JSON.parse(json) }; } catch { return { ok: false, reason: 'bad-json' } }
}

/** 在任意嵌套结构里找 aweme_id 对得上、且带 video 的那条数据（抖音的字段位置随页面版本变，只能递归找） */
export function findDouyinItem(value, id) {
  if (!value || typeof value !== 'object') return null;
  if (String(value.aweme_id || '') === String(id) && value.video) return value;
  for (const child of Object.values(value)) {
    const found = findDouyinItem(child, id);
    if (found) return found;
  }
  return null;
}

/**
 * 解析 yt-dlp 的一行输出 → 任务字段补丁（空对象 = 这行没有可用信息）。
 * 对齐上游 server.js 的 onLine 正则集合。
 */
export function parseYtdlpLine(line) {
  const patch = {};
  let m;
  if ((m = String(line).match(/^__FINAL_FILE__(.+)$/))) {
    patch.file = m[1].trim();
    patch.name = path.basename(patch.file);
  }
  if ((m = String(line).match(/\[download\]\s+Destination:\s+(.+)$/))) {
    patch.file = m[1].trim();
    patch.name = path.basename(patch.file);
    patch.merging = false;
    patch.pct = 0;
    patch.speed = '';
    patch.eta = '';
    patch.phase = /\.f\d+\.(m4a|aac|opus|webm)$/i.test(patch.file) ? '下载音频轨' : '下载视频轨';
  }
  if ((m = String(line).match(/\[Merger\].*?"(.+?)"/))) {
    patch.file = m[1];
    patch.name = path.basename(m[1]);
    patch.merging = true;
    patch.phase = '合并音视频';
  }
  if ((m = String(line).match(/\[download\]\s+([\d.]+)%(?:.*?at\s+([^\s]+))?(?:.*?ETA\s+([^\s]+))?/))) {
    patch.pct = Math.min(100, parseFloat(m[1]) || 0);
    if (m[2]) patch.speed = m[2];
    if (m[3]) patch.eta = m[3];
  }
  if (/has already been downloaded/.test(String(line))) {
    patch.pct = 100;
    patch.note = '此前已下载过';
  }
  return patch;
}
