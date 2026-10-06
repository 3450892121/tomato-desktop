// 三条下载通道 + 网页兜底 + 音画校验/整理。
// 移植自 leetools/video-downloader/server.js 引擎段（MIT，见 ../UPSTREAM-LICENSE.txt），改动：
//   - 所有外部依赖（ffmpeg / yt-dlp / 插件目录 / 代理 / 解析器路径）由 ctx 注入，不再假设目录结构
//   - 每个阶段之间检查 job.cancelRequested，可被用户取消（上游没有取消）
//   - 进度/阶段变化通过 ctx.emit() 推送（代替上游的 HTTP 轮询）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { describeDownloadError } from './errors.mjs';
import * as yangshipin from './yangshipin.mjs';
import * as bilibili from './bilibili.mjs';
import browserDiscovery from './browser-resolver.cjs';
import douyinResolver from './douyin-resolver.cjs';
import { runChildJson, killProcessTree } from './childutil.mjs';
import {
  safeFileName, formatSpeed, formatEta, parseYtdlpLine, isYouTubeUrl, isXiaohongshuUrl, extractDouyinVideoId,
  cookiePairsFromSetCookie, parseDouyinRouterData, findDouyinItem,
} from './pure.mjs';

const DOUYIN_MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36';
const DOUYIN_DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

function assertNotCancelled(job) {
  if (job.cancelRequested) { const error = new Error('已取消'); error.cancelled = true; throw error; }
}

// ── 音画校验 / 整理 ──
export function inspectMedia(ctx, file) {
  return new Promise((resolve) => {
    if (!ctx.ffmpegPath || !file || !fs.existsSync(file)) return resolve({ video: false, audio: false, container: '' });
    const child = spawn(ctx.ffmpegPath, ['-hide_banner', '-protocol_whitelist', 'file',
      '-format_whitelist', 'mov,matroska,webm,mpegts,avi,flv,ogg', '-i', file,
      '-map', '0:v:0', '-map', '0:a:0', '-t', '0', '-f', 'null', '-'], { windowsHide: true });
    let text = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 15000);
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ video: false, audio: false, container: '' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ok = code === 0;
      resolve({ video: ok, audio: ok, container: text.match(/Input #0, (.+?), from /)?.[1] || '' });
    });
  });
}

export async function finishVideoJob(ctx, job) {
  if (job.dir && job.file && fs.existsSync(job.file)) {
    const relative = path.relative(fs.realpathSync(job.dir), fs.realpathSync(job.file));
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('最终文件不在指定保存目录内');
  }
  let streams = await inspectMedia(ctx, job.file);
  if (!streams.video || !streams.audio) {
    throw new Error(!fs.existsSync(job.file)
      ? '下载结束但没有找到最终视频'
      : (ctx.ffmpegPath ? '最终文件缺少画面或声音' : '最终文件缺少画面或声音（未检测到 ffmpeg 加装包，无法合并音视频）'));
  }
  // HLS 成品可能实为 TS 却挂着 .mp4 后缀：无损换封装为真 MP4（成功才替换，失败保留原文件）。
  if (streams.container === 'mpegts' && path.extname(job.file).toLowerCase() === '.mp4') {
    job.phase = '整理 MP4 格式';
    ctx.emit();
    const temp = job.file + '.' + crypto.randomBytes(6).toString('hex') + '.remux.mp4';
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(ctx.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-n', '-i', job.file,
          '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', temp],
        { windowsHide: true, stdio: 'ignore', timeout: 180000 });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('整理 MP4 失败，原下载文件已保留'))));
      });
      streams = await inspectMedia(ctx, temp);
      if (!streams.video || !streams.audio || !streams.container.includes('mp4')) throw new Error('整理后的 MP4 校验失败，原下载文件已保留');
      fs.renameSync(temp, job.file);
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
  job.status = 'done'; job.pct = 100; job.merging = false; job.phase = '完成';
}

// ── 抖音：游客通道 + 匿名会话兜底 ──
// 抖音游客页只认「带 ttwid 的游客」：不带这个 Cookie 去请求，页面里永远只有空壳、没有 play_addr，
// 于是只能退到临时浏览器兜底（慢约 30 秒，机器上开着代理时基本必败）——v2.12.1 实测，
// 此前抖音下载全灭就是缺了它。ttwid 优先向字节官方接口换一个（分享页自己发不发全看它心情）。
async function fetchText(url, { timeoutMs = 30000, cookie = '' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': DOUYIN_MOBILE_UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (!response.ok) throw new Error(`页面请求失败（HTTP ${response.status}）`);
    return {
      url: response.url,
      text: await response.text(),
      cookies: cookiePairsFromSetCookie(response.headers.getSetCookie()),
    };
  } finally { clearTimeout(timer); }
}

export async function resolveXiaohongshuUrl(value) {
  if (!isXiaohongshuUrl(value)) return value;
  let host = '';
  try { host = new URL(value).hostname.toLowerCase(); } catch { return value; }
  if (host !== 'xhslink.com' && !host.endsWith('.xhslink.com')) return value;
  const resolved = await fetchText(value, { timeoutMs: 20000 });
  return isXiaohongshuUrl(resolved.url) ? resolved.url : value;
}

const DOUYIN_PAGE_PROBLEMS = {
  missing: '抖音游客页面没有返回视频数据',
  'bad-json': '抖音游客页面数据解析失败',
};

// 字节官方的游客标识发放接口：不要账号、不读用户浏览器资料，只换一个匿名 ttwid。
// 分享页自己发不发 ttwid 看它心情（实测同一天两条链接，一条发一条不发），所以主动去换一个最稳。
const TTWID_REGISTER_URL = 'https://ttwid.bytedance.com/ttwid/union/register/';

async function registerDouyinTtwid() {
  try {
    const response = await fetch(TTWID_REGISTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': DOUYIN_DESKTOP_UA },
      body: JSON.stringify({
        region: 'cn', aid: 1768, needFid: false, service: 'www.douyin.com',
        migrate_info: { ticket: '', source: 'node' }, cbUrlProtocol: 'https', union: true,
      }),
    });
    if (!response.ok) return '';
    return cookiePairsFromSetCookie(response.headers.getSetCookie()).find((pair) => /^ttwid=/i.test(pair)) || '';
  } catch { return ''; } // 换不到就走下面「用页面自己发的 Cookie」那条退路，最终由页面级错误说话
}

// 取不到条目时只回原因、不抛错：好让「带 Cookie 再来一趟」还有机会。
function douyinItemFromPage(html, id) {
  const parsed = parseDouyinRouterData(html);
  if (!parsed.ok) return { item: null, problem: DOUYIN_PAGE_PROBLEMS[parsed.reason] };
  const item = findDouyinItem(parsed.data, id);
  if (!item?.video?.play_addr?.uri) return { item: null, problem: '抖音游客页面暂未提供这个视频的播放地址' };
  return { item, problem: '' };
}

export async function getDouyinVideoInfo(originalUrl, { fetchPage = fetchText, getTtwid = registerDouyinTtwid } = {}) {
  let id = extractDouyinVideoId(originalUrl);
  if (!id) {
    const resolved = await fetchPage(originalUrl);
    id = extractDouyinVideoId(resolved.url)
      || resolved.text.match(/"(?:aweme_id|itemId)"\s*:\s*"(\d{15,25})"/i)?.[1]
      || '';
  }
  if (!id) throw new Error('没有从抖音链接中识别出视频编号');
  try {
    const shareUrl = `https://www.iesdouyin.com/share/video/${id}/`;
    const ttwid = await getTtwid();
    let share = await fetchPage(shareUrl, ttwid ? { cookie: ttwid } : {});
    let { item, problem } = douyinItemFromPage(share.text, id);
    if (!item && !ttwid && share.cookies.length) {
      share = await fetchPage(shareUrl, { cookie: share.cookies.join('; ') });
      ({ item, problem } = douyinItemFromPage(share.text, id));
    }
    if (!item) throw new Error(problem);
    const videoId = item.video.play_addr.uri;
    return {
      id,
      title: safeFileName(item.desc),
      url: `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(videoId)}&ratio=1080p&line=0`,
      userAgent: DOUYIN_MOBILE_UA,
      referer: 'https://www.iesdouyin.com/',
    };
  } catch (error) {
    error.douyinVideoId = id;
    throw error;
  }
}

async function getDouyinAnonymousVideoInfo(ctx, job, id) {
  // 抖音是国内站，不给临时浏览器传代理（B站同理，见 runYtdlpJob 里对 isBili 的处理）：
  // 探测到的 Clash 端口一旦内核没在跑，整场会空转三十秒后报「没有取得播放地址」。
  const data = await runChildJson(job, {
    script: ctx.resolverDouyin, args: [String(id)], timeoutMs: 45000, tag: '匿名临时会话',
  });
  if (String(data.id) !== String(id) || !douyinResolver.isAllowedMediaUrl(data.url)) throw new Error('返回的视频信息不匹配');
  return {
    id: String(id),
    title: safeFileName(data.title),
    url: data.url,
    userAgent: String(data.userAgent || DOUYIN_MOBILE_UA),
    referer: String(data.referer || 'https://www.douyin.com/'),
  };
}

async function saveDouyinVideo(job, videoUrl, partFile, requestHeaders = {}) {
  if (!douyinResolver.isAllowedMediaUrl(videoUrl)) throw new Error('抖音播放地址未通过安全检查');
  const controller = new AbortController();
  job._aborter = () => controller.abort();
  let idleTimer;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), 30000);
  };
  resetIdleTimer();
  try {
    const response = await fetch(videoUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': requestHeaders.userAgent || DOUYIN_MOBILE_UA,
        Referer: requestHeaders.referer || 'https://www.iesdouyin.com/',
      },
    });
    if (!response.ok) throw new Error(`视频请求失败（HTTP ${response.status}）`);
    if (!/^video\//i.test(response.headers.get('content-type') || '')) throw new Error('抖音返回的内容不是视频');
    if (!response.body) throw new Error('抖音没有返回视频数据');

    const total = Number(response.headers.get('content-length')) || 0;
    const output = fs.createWriteStream(partFile, { flags: 'wx' });
    let received = 0;
    let sampleBytes = 0;
    let sampleTime = Date.now();
    try {
      for await (const chunk of response.body) {
        resetIdleTimer();
        received += chunk.length;
        if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
        const now = Date.now();
        if (now - sampleTime >= 500) {
          const speed = (received - sampleBytes) * 1000 / (now - sampleTime);
          job.speed = formatSpeed(speed);
          job.pct = total ? Math.min(99.5, received * 100 / total) : 0;
          job.eta = total && speed > 0 ? formatEta((total - received) / speed) : '';
          sampleBytes = received;
          sampleTime = now;
        }
      }
      output.end();
      await new Promise((resolve, reject) => { output.on('error', reject); output.on('close', resolve); });
    } catch (error) {
      output.destroy();
      throw error;
    }
    if (!received || (total && received !== total)) throw new Error('视频文件接收不完整');
  } finally {
    clearTimeout(idleTimer);
    job._aborter = null;
  }
}

export async function runDouyinJob(ctx, job) {
  const tempDir = path.join(job.dir, ctx.tempDirName);
  let partFile = '';
  try {
    job.phase = '获取抖音游客视频信息';
    ctx.emit();
    let info;
    try {
      info = await getDouyinVideoInfo(job.url);
    } catch (visitorError) {
      assertNotCancelled(job);
      const id = visitorError.douyinVideoId || extractDouyinVideoId(job.url);
      if (!id) throw visitorError;
      job.phase = '建立隔离匿名临时会话';
      ctx.emit();
      try {
        info = await getDouyinAnonymousVideoInfo(ctx, job, id);
        job.note = '游客页受限，已自动使用隔离匿名临时会话';
      } catch (anonymousError) {
        assertNotCancelled(job);
        throw new Error(`${visitorError.message}；${anonymousError.message}`);
      }
    }
    job.name = `${info.title} [${info.id}].mp4`;
    job.file = path.join(job.dir, job.name);
    if (fs.existsSync(job.file)) {
      const streams = await inspectMedia(ctx, job.file);
      if (streams.video && streams.audio) {
        job.status = 'done'; job.phase = '完成'; job.pct = 100; job.note = '此前已下载过';
        return;
      }
      job.file = path.join(job.dir, `${info.title} [${info.id}-${job.id.slice(0, 4)}].mp4`);
      job.name = path.basename(job.file);
    }
    fs.mkdirSync(tempDir, { recursive: true });
    partFile = path.join(tempDir, `${info.id}-${job.id}.mp4.part`);
    for (let attempt = 1; attempt <= 2; attempt++) {
      assertNotCancelled(job);
      job.attempt = attempt;
      job.phase = attempt === 1 ? '下载抖音视频（游客模式）' : '抖音下载自动重试';
      ctx.emit();
      try {
        await saveDouyinVideo(job, info.url, partFile, info);
        break;
      } catch (error) {
        try { fs.unlinkSync(partFile); } catch {}
        assertNotCancelled(job);
        if (attempt === 2) throw error;
        job.pct = 0; job.speed = ''; job.eta = '';
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    fs.renameSync(partFile, job.file);
    partFile = '';
    job.phase = '校验音视频';
    ctx.emit();
    const streams = await inspectMedia(ctx, job.file);
    if (!streams.video || !streams.audio) throw new Error('下载文件缺少画面或声音');
    job.status = 'done'; job.phase = '完成'; job.pct = 100; job.speed = ''; job.eta = '';
  } catch (error) {
    if (partFile) { try { fs.unlinkSync(partFile); } catch {} }
    if (job.cancelRequested) { job.status = 'cancelled'; job.phase = '已取消'; job.err = ''; return; }
    job.status = 'error';
    job.err = error.name === 'AbortError' ? '抖音请求超时，请重试' : (error.message || '抖音下载失败');
  }
}

// ── 央视频 ──
export async function runYangshipinJob(ctx, job) {
  const tempDir = path.join(job.dir, ctx.tempDirName);
  let partFile = '';
  const abortController = new AbortController();
  job._aborter = () => abortController.abort();
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      assertNotCancelled(job);
      job.attempt = attempt;
      job.phase = attempt === 1 ? '获取央视频公开播放信息' : '重新获取央视频播放地址';
      ctx.emit();
      try {
        const info = await yangshipin.resolve(job.url);
        const title = safeFileName(info.title);
        const preferred = path.join(job.dir, `${title} [${info.id}].mp4`);
        job.name = path.basename(preferred);
        job.note = `央视频 · ${info.height}p`;
        if (await yangshipin.verifyFile(preferred, info)) {
          const streams = await inspectMedia(ctx, preferred);
          if (streams.video && streams.audio) {
            job.file = preferred;
            job.note += ' · 此前已下载过';
            job.status = 'done'; job.phase = '完成'; job.pct = 100;
            return;
          }
        }
        fs.mkdirSync(tempDir, { recursive: true });
        partFile = path.join(tempDir, `yangshipin-${info.id}-${job.id}-${attempt}.mp4.part`);
        job.phase = `下载央视频 ${info.height}p 视频`;
        ctx.emit();
        let sampleBytes = 0, sampleTime = Date.now();
        await yangshipin.download(info, partFile, (received, total) => {
          const now = Date.now();
          job.pct = Math.min(99.5, received * 100 / total);
          if (now - sampleTime >= 500) {
            const speed = (received - sampleBytes) * 1000 / (now - sampleTime);
            job.speed = formatSpeed(speed); job.eta = formatEta((total - received) / speed);
            sampleBytes = received; sampleTime = now;
          }
        }, { signal: abortController.signal });
        assertNotCancelled(job);
        job.phase = '校验音视频';
        ctx.emit();
        const streams = await inspectMedia(ctx, partFile);
        if (!streams.video || !streams.audio) throw new Error('下载文件缺少画面或声音');
        // 校验通过后才落目标名：硬链接原子发布，绝不覆盖已存在文件。
        let destination = preferred;
        try { fs.linkSync(partFile, destination); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          destination = path.join(job.dir, `${title} [${info.id}-${job.id}].mp4`);
          fs.linkSync(partFile, destination);
        }
        fs.unlinkSync(partFile); partFile = '';
        job.file = destination; job.name = path.basename(destination);
        job.status = 'done'; job.phase = '完成'; job.pct = 100; job.speed = ''; job.eta = '';
        return;
      } catch (error) {
        if (partFile) { try { fs.unlinkSync(partFile); } catch {} partFile = ''; }
        assertNotCancelled(job);
        const transient = error.retryable || /AbortError|TimeoutError|TypeError/.test(error.name);
        if (attempt === 2 || !transient) throw error;
        job.pct = 0; job.speed = ''; job.eta = '';
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
  } catch (error) {
    if (job.cancelRequested) { job.status = 'cancelled'; job.phase = '已取消'; job.err = ''; job.speed = ''; job.eta = ''; return; }
    job.status = 'error'; job.phase = '失败'; job.speed = ''; job.eta = '';
    job.err = /AbortError|TimeoutError/.test(error.name) ? '央视频连接超时，请重试'
      : error.name === 'TypeError' ? '连接央视频失败，请检查网络后重试' : error.message;
  } finally {
    job._aborter = null;
  }
}

// ── 网页兜底识别（临时浏览器；同时最多 1 个解析、最多 3 个等待） ──
export async function discoverPageVideo(ctx, job) {
  const queue = ctx.browserQueue;
  if (queue.pending >= 3) throw new Error('正在识别其他网页，请稍后点击重试');
  queue.pending++;
  const previous = queue.tail;
  let release;
  queue.tail = new Promise((resolve) => { release = resolve; });
  job.phase = '等待识别网页视频';
  ctx.emit();
  await previous;
  try {
    assertNotCancelled(job);
    job.phase = '识别网页视频（临时浏览器）';
    ctx.emit();
    const data = await runChildJson(job, {
      script: ctx.resolverBrowser, args: [job.url, ctx.proxy() || ''], timeoutMs: 55000, tag: '网页识别',
    });
    if (!browserDiscovery.publicUrl(data.url) || !browserDiscovery.publicUrl(data.referer)
        || typeof data.userAgent !== 'string' || /[\r\n]/.test(data.userAgent)) throw new Error('网页返回了无效的播放信息');
    return {
      mediaUrl: data.url, referer: data.referer, userAgent: data.userAgent.slice(0, 300),
      title: safeFileName(data.title), fromBrowser: true,
    };
  } finally {
    queue.pending--;
    release();
  }
}

// ── 通用通道（yt-dlp；B站/YouTube/小红书/直链都走这里） ──
// 注意：yt-dlp 的重试/兜底是「点火就走」的回调链，所以这里用一个 Promise 把「任务到达终态」
// 这件事包起来——manager 靠它决定何时收尾（落历史、清临时目录）。少了这层，下载还没结束
// 就会被当成完成，历史记录和清理都会跑在错误的时间点上。
export function runYtdlpJob(ctx, job, options = {}) {
  let settle;
  const finished = new Promise((resolve) => { settle = resolve; });
  if (job.cancelRequested) { job.status = 'cancelled'; job.phase = '已取消'; job.err = ''; settle(); return finished; }
  const { url, dir } = job;
  const engine = ctx.engine();
  if (!engine) {
    job.status = 'error'; job.phase = '失败';
    job.err = '未检测到下载引擎：请确认 addons/ytdlp/yt-dlp.exe 在位，或点「更新引擎」重新下载。';
    settle();
    return finished;
  }
  const downloadUrl = options.mediaUrl || url;
  const isXhs = isXiaohongshuUrl(url);
  const isBili = !options.fromBrowser && bilibili.isBilibiliUrl(url);
  const tempDir = path.join(dir, ctx.tempDirName, job.id);
  const args = ['--no-config', '--encoding', 'utf-8', '--newline', '--progress', '--no-playlist', '--no-overwrites', '--abort-on-unavailable-fragments',
    '-P', dir, '-P', `temp:${tempDir}`, '-o', '%(title).80s [%(id)s].%(ext)s',
    '--print', 'after_move:__FINAL_FILE__%(filepath)s',
    '--socket-timeout', '20', '--retries', '10', '--fragment-retries', '10', '--concurrent-fragments', '8'];
  if (engine.source === 'bundled-unverified') job.note = engine.warning || '';
  const jsRuntime = ctx.jsRuntime();
  if (jsRuntime) args.push('--js-runtimes', `node:${jsRuntime}`);
  if (ctx.ffmpegPath) {
    args.push('-f', 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b', '--merge-output-format', 'mp4', '--ffmpeg-location', ctx.ffmpegPath);
  } else {
    args.push('-f', 'b');
  }
  if (!isBili && ctx.proxy()) args.push('--proxy', ctx.proxy());
  if (options.fromBrowser) {
    args.push('--referer', options.referer, '--user-agent', options.userAgent);
    const videoId = crypto.createHash('sha256').update(url).digest('hex').slice(0, 10);
    args.push('-o', `${String(options.title).replace(/%/g, '%%')} [${videoId}].%(ext)s`);
    job.note = '已自动识别网页播放资源';
  }

  const startAttempt = (attempt, cookieIndex = -1) => {
    if (job.cancelRequested) {
      job.status = 'cancelled'; job.phase = '已取消'; job.err = '';
      settle();
      return;
    }
    const cookieBrowser = isXhs && cookieIndex >= 0 ? ctx.xhsCookieBrowsers[cookieIndex] : '';
    job.attempt = attempt;
    job.status = 'running';
    job.phase = cookieBrowser ? `读取 ${cookieBrowser} 登录状态后下载小红书`
      : (attempt > 1 ? '自动重试' : options.fromBrowser ? '下载网页视频' : '准备下载');
    if (isBili) job.phase = attempt > 1 && ctx.proxy() ? '切换直连并检测B站备用地址' : '检测B站可用下载地址';
    job.err = '';
    job.pct = 0; job.speed = ''; job.eta = '';
    ctx.emit();
    const runArgs = args.slice();
    if (isBili) runArgs.push(...bilibili.attemptArgs(ctx.pluginsDir, ctx.proxy(), attempt));
    if (cookieBrowser) runArgs.push('--cookies-from-browser', cookieBrowser);
    runArgs.push('--', downloadUrl);
    const child = spawn(engine.path, runArgs, {
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      windowsHide: true,
    });
    job._killDownload = () => killProcessTree(child);
    let buf = '';
    let errTail = '';
    const eat = (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const patch = parseYtdlpLine(buf.slice(0, i));
        Object.assign(job, patch);
        buf = buf.slice(i + 1);
      }
      if (buf.length > 65536) buf = buf.slice(-65536);
      ctx.emit();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', eat);
    child.stderr.on('data', (d) => { const s = d.toString('utf8'); errTail = (errTail + s).slice(-2400); eat(d); });
    child.on('error', (e) => { job.status = 'error'; job.err = 'yt-dlp 启动失败: ' + e.message; });
    child.on('close', async (code) => {
      job._killDownload = null;
      if (job.cancelRequested) { job.status = 'cancelled'; job.phase = '已取消'; job.err = ''; ctx.emit(); settle(); return; }
      if (job.status === 'error') { ctx.emit(); settle(); return; }
      if (buf) { Object.assign(job, parseYtdlpLine(buf)); buf = ''; }
      if (code === 0) {
        job.phase = '校验音视频';
        ctx.emit();
        try { await finishVideoJob(ctx, job); }
        catch (error) { job.status = 'error'; job.phase = '失败'; job.err = error.message; }
        ctx.emit();
        settle();
        return;
      }
      const known = errTail.match(/ERROR:\s*([^\n]+)/);
      const message = known ? known[1].slice(0, 240) : ('退出码 ' + code);
      const youtubeIpChallenge = isYouTubeUrl(url)
        && /Sign in to confirm you(?:'|’)?re not a bot|confirm your age|not a bot/i.test(errTail);
      const xhsNeedsLogin = isXhs
        && /No video formats found|login|log in|cookie|captcha|forbidden|HTTP Error 403|initial state/i.test(errTail);
      const xhsCookieReadFailed = isXhs
        && /Could not copy .*cookie database|Failed to decrypt|cookie.*(?:locked|permission denied)|CookieLoadError/i.test(errTail);
      if (!options.fromBrowser && browserDiscovery.eligible(url, errTail)) {
        job.pct = 0; job.speed = ''; job.eta = ''; job.merging = false;
        discoverPageVideo(ctx, job)
          .then((info) => runYtdlpJob(ctx, job, info))
          .then(() => settle())
          .catch((error) => {
            if (job.cancelRequested) { job.status = 'cancelled'; job.phase = '已取消'; job.err = ''; }
            else { job.status = 'error'; job.phase = '失败'; job.err = error.message; }
            ctx.emit();
            settle();
          });
        return;
      }
      if (isXhs && (xhsNeedsLogin || cookieBrowser) && cookieIndex + 1 < ctx.xhsCookieBrowsers.length) {
        job.phase = '尝试本机浏览器登录状态'; job.err = ''; job.pct = 0; job.merging = false;
        setTimeout(() => startAttempt(attempt + 1, cookieIndex + 1), 300);
        return;
      }
      if (isBili && attempt < 2 && bilibili.isConnectionFailure(errTail)) {
        job.phase = ctx.proxy() ? '准备切换直连重试' : '重新获取B站下载地址';
        job.err = ''; job.pct = 0; job.merging = false;
        setTimeout(() => startAttempt(attempt + 1, cookieIndex), 600);
        return;
      }
      if (attempt < 2 && (/No such file|timed out|timeout|handshake|TLS|SSL|EOF|ConnectionReset|10054|reset by peer|远程主机|temporar|HTTP Error (?:4(?:12|29)|5)/i.test(errTail) || youtubeIpChallenge)) {
        job.phase = '自动重试'; job.err = '第一次下载异常，正在自动重试'; job.pct = 0; job.merging = false;
        setTimeout(() => startAttempt(attempt + 1, cookieIndex), youtubeIpChallenge ? 1800 : 600);
        return;
      }
      job.status = 'error';
      job.phase = '失败';
      if (youtubeIpChallenge) {
        job.err = 'YouTube 当前代理节点触发了临时风控（不是本工具要求 Cookie）。请在 Clash 切换节点后重新下载。';
      } else if (isXhs && xhsCookieReadFailed) {
        job.err = '已识别小红书链接，但 Windows 暂时无法读取浏览器登录状态。请完全退出 Chrome/Edge 后重新下载；不会删除或上传 Cookie。';
      } else if (isXhs && xhsNeedsLogin) {
        job.err = ctx.xhsCookieBrowsers.length
          ? '小红书没有返回可下载的视频。请确认这是视频笔记，并从小红书“分享→复制链接”取得最新地址后重试。'
          : '小红书页面需要登录状态，但这台电脑未找到可读取的 Chrome、Edge 或 Firefox 浏览器资料。';
      } else {
        job.err = (isBili && bilibili.describeFailure(errTail)) || describeDownloadError(message);
        if (isYouTubeUrl(url) && !ctx.proxy()) job.err += '（YouTube 需先启动 Clash，再点重试）';
      }
      ctx.emit();
      settle();
    });
  };
  startAttempt(1);
  return finished;
}

export { assertNotCancelled };
