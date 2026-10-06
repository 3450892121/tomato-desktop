// 央视频公开点播解析/下载（移植自 leetools/video-downloader scripts/yangshipin.js，
// MIT 许可，见同目录 UPSTREAM-LICENSE.txt；本项目仅做 ESM 化，逻辑未改）。
// 使用公开播放器协议自算 cKey（Node 内置加密库），不下载、不执行远程 JS，不读账号。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const APP_VERSION = '1.3.5';
const PLATFORM = '4330701';
const PAGE_HOSTS = new Set(['w.yangshipin.cn', 'm.yangshipin.cn', 'www.yangshipin.cn', 'yangshipin.cn']);

export function isYangshipinUrl(value) {
  try { return PAGE_HOSTS.has(new URL(value).hostname.toLowerCase()); } catch { return false; }
}

export function normalizeUrl(value) {
  const input = new URL(value);
  if (!isYangshipinUrl(value) || !/^https?:$/.test(input.protocol) || input.username || input.password || input.port) {
    throw new Error('请使用央视频官方分享链接');
  }
  if (input.pathname !== '/video' || (input.searchParams.has('type') && input.searchParams.get('type') !== '0')) {
    throw new Error('目前支持央视频点播视频，请复制视频分享页链接');
  }
  const cid = input.searchParams.get('cid') || '';
  const vid = input.searchParams.get('vid') || '';
  if ((!cid && !vid) || (cid && !/^[a-zA-Z0-9]{8,32}$/.test(cid)) || (vid && !/^[a-zA-Z0-9]{8,32}$/.test(vid))) {
    throw new Error('央视频链接中缺少有效的视频编号');
  }
  const page = new URL('https://w.yangshipin.cn/video');
  if (cid) page.searchParams.set('cid', cid);
  if (vid) page.searchParams.set('vid', vid);
  page.searchParams.set('type', '0');
  return page;
}

// 公开网页播放器协议，用 Node crypto 独立实现（客户端公开常量，非账号凭据）。
export function makeCKey(vid, timestamp, guid, pageUrl) {
  const payload = `|${vid}|${timestamp}|mg3c3b04ba|${APP_VERSION}|${guid}|${PLATFORM}|${pageUrl.slice(0, 24)}|${USER_AGENT.toLowerCase().slice(0, 24)}||Mozilla|Netscape|Win32|`;
  let hash = 0;
  for (let i = 0; i < payload.length; i++) hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from('4E2918885FD98109869D14E0231A0BF4', 'hex'), Buffer.from('16B17E519DDD0CE5B79D7A63A4DD801C', 'hex'));
  return '--01' + Buffer.concat([cipher.update(`|${hash}${payload}`, 'utf8'), cipher.final()]).toString('hex').toUpperCase();
}

export function isMediaUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password
      && (u.hostname.endsWith('.ysp.cctv.cn') || u.hostname.endsWith('.yangshipin.cn'));
  } catch { return false; }
}

function isMetadataUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password
      && (PAGE_HOSTS.has(u.hostname) || u.hostname === 'playvv.yangshipin.cn');
  } catch { return false; }
}

async function checkedFetch(url, options, allowed, fetchImpl) {
  for (let hop = 0; hop <= 4; hop++) {
    if (!allowed(url)) throw new Error('央视频返回了非官方地址，已停止下载');
    const response = await fetchImpl(url, { ...options, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = response.headers.get('location');
      if (!next) throw new Error('央视频返回了无效跳转');
      url = new URL(next, url).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`央视频请求失败（HTTP ${response.status}）`);
      error.retryable = [403, 408, 429].includes(response.status) || response.status >= 500;
      throw error;
    }
    return response;
  }
  throw new Error('央视频跳转次数过多');
}

async function readText(url, referer, fetchImpl) {
  const response = await checkedFetch(url, {
    signal: AbortSignal.timeout(20000), headers: { 'User-Agent': USER_AGENT, Referer: referer },
  }, isMetadataUrl, fetchImpl);
  const chunks = [];
  let bytes = 0;
  if (!response.body) throw new Error('央视频未返回页面数据');
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) throw new Error('央视频返回的页面数据过大');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parsePage(html, requestedVid = '') {
  const match = html.match(/window\.__STATE_video__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i);
  if (!match) throw new Error('央视频页面没有返回视频信息，可能已下架或页面结构发生变化');
  let item;
  try { item = JSON.parse(match[1]).payloads.sharevideo; } catch { throw new Error('央视频页面数据无法解析'); }
  if (!item || !/^[a-zA-Z0-9]{8,32}$/.test(item.vid || '')) throw new Error('央视频页面没有返回有效的视频编号');
  if (requestedVid && item.vid !== requestedVid) {
    const selected = item.shareLongVideoRec?.watchingfocus?.videoList?.find(v => v.vid === requestedVid);
    if (!selected) throw new Error('央视频返回的视频与链接不一致');
    item = { ...item, ...selected };
  }
  if (item.ShowVideo === false) throw new Error('这个央视频视频目前不可公开播放');
  return { id: item.vid, title: String(item.title || '央视频视频'), date: String(item.checkup_time || '') };
}

export function parsePlayback(text, meta, pageUrl, guid) {
  let data;
  try { data = JSON.parse(text.trim().replace(/^\(/, '').replace(/\);?$/, '')); }
  catch { throw new Error('央视频播放信息无法解析，站点接口可能已更新'); }
  const video = data.vl?.vi?.[0];
  if (!video) throw new Error('央视频没有提供公开播放地址，可能存在登录、地区限制或视频已下架');
  if (video.vid !== meta.id) throw new Error('央视频返回的视频与链接不一致');
  const duration = Number(video.td);
  const selected = data.fl?.fi?.find(f => Number(f.sl) === 1);
  if (Number(video.drm) > 0 || Number(selected?.lmt) > 0
      || (Number(data.preview) > 0 && Number(data.preview) < duration)) {
    throw new Error('这个视频只提供试看或受保护的播放内容，无法下载完整公开版本');
  }
  if (data.dltype !== 1 || Number(video.cl?.fc) > 0 || !video.fvkey) {
    throw new Error('央视频返回了暂不支持的播放格式，请反馈这条链接');
  }
  if (!/^[a-zA-Z0-9._-]+\.mp4$/.test(video.fn || '') || !video.fn.startsWith(meta.id + '.')) {
    throw new Error('央视频返回的视频文件名无效');
  }
  const base = video.ul?.ui?.[0]?.url;
  if (!isMediaUrl(base)) throw new Error('央视频返回了非官方视频地址');
  const url = new URL(video.fn, base);
  url.search = new URLSearchParams({ sdtfrom: 'v7007', guid, vkey: video.fvkey });
  const size = Number(video.fs);
  if (!Number.isSafeInteger(size) || size <= 0 || !/^[a-f0-9]{32}$/i.test(video.fmd5 || '') || !(duration > 0)) {
    throw new Error('央视频未返回完整的文件校验信息');
  }
  return { ...meta, url: url.href, referer: pageUrl, userAgent: USER_AGENT, duration,
    width: Number(video.vw), height: Number(video.vh), size, md5: video.fmd5.toLowerCase() };
}

export async function resolve(value, { fetchImpl = fetch } = {}) {
  const page = normalizeUrl(value);
  const meta = parsePage(await readText(page.href, page.origin + '/', fetchImpl), page.searchParams.get('vid') || '');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const guid = crypto.randomBytes(16).toString('hex');
  const query = new URLSearchParams({
    charge: '0', defaultfmt: 'auto', otype: 'json', guid, flowid: crypto.randomBytes(16).toString('hex'),
    platform: PLATFORM, sdtfrom: 'v7007', defnpayver: '0', appVer: APP_VERSION,
    host: page.host, ehost: page.origin + page.pathname, refer: page.host, sphttps: '1', sphls: '1',
    _rnd: timestamp, spwm: '4', vid: meta.id, defn: 'fhd', defsrc: '2', encryptVer: '8.1',
    cKey: makeCKey(meta.id, timestamp, guid, page.href),
  });
  return parsePlayback(await readText('https://playvv.yangshipin.cn/playvinfo?' + query, page.href, fetchImpl), meta, page.href, guid);
}

export async function verifyFile(file, info) {
  try {
    if (fs.statSync(file).size !== info.size) return false;
    const hash = crypto.createHash('md5');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === info.md5;
  } catch { return false; }
}

export async function download(info, partFile, onProgress, { fetchImpl = fetch, idleMs = 30000, signal } = {}) {
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', relayAbort, { once: true });
  }
  let timer;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), idleMs); };
  touch();
  try {
    const response = await checkedFetch(info.url, {
      signal: controller.signal, headers: { 'User-Agent': USER_AGENT, Referer: info.referer },
    }, isMediaUrl, fetchImpl);
    if (!/^(video\/|application\/octet-stream)/i.test(response.headers.get('content-type') || '') || !response.body) {
      await response.body?.cancel();
      throw new Error('央视频返回的内容不是视频文件');
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) !== info.size) {
      await response.body.cancel();
      throw new Error('央视频文件大小与播放信息不一致');
    }
    const hash = crypto.createHash('md5');
    let received = 0;
    const meter = new Transform({ transform(chunk, encoding, callback) {
      touch();
      received += chunk.length;
      if (received > info.size) return callback(new Error('央视频文件超过预期大小'));
      hash.update(chunk);
      if (onProgress) onProgress(received, info.size);
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(partFile, { flags: 'wx' }), { signal: controller.signal });
    if (received !== info.size || hash.digest('hex') !== info.md5) {
      const error = new Error('央视频文件完整性校验失败，请重试');
      error.retryable = true;
      throw error;
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relayAbort);
  }
}
