// 视频下载管理器（主进程侧门面）：任务编排 + 历史落盘 + 引擎解析/自更新 + 代理探测 + 取消。
// 通道实现见 downloader.mjs；引擎更新见 engine-update.mjs；上游来源与差异见 ../UPSTREAM-LICENSE.txt 与 spec/modules/videodl.md。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { PINNED_ENGINE, checkLatestEngine, downloadEngine, installEngine, readInstalledEngine, sha256File } from './engine-update.mjs';
import {
  inspectMedia, finishVideoJob, runDouyinJob, runYangshipinJob, runYtdlpJob, resolveXiaohongshuUrl,
} from './downloader.mjs';
import { extractUrl, isDouyinUrl } from './pure.mjs';
import * as yangshipin from './yangshipin.mjs';

const TEMP_DIR_NAME = '.视频下载临时';
const MAX_CONCURRENT = 3;
const HISTORY_KEEP = 60;
const HISTORY_SHOW = 30;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PROXY_CANDIDATES = [
  { port: 7897, scheme: 'http' }, // Clash Verge 常用 mixed-port
  { port: 7890, scheme: 'http' },
  { port: 10809, scheme: 'http' },
  { port: 7891, scheme: 'socks5' },
  { port: 10808, scheme: 'socks5' },
  { port: 1080, scheme: 'socks5' },
];

export function createVideoDownloader({ addonsRoot, toolRoot, userdataDir, ffmpegPath = '', onChanged = () => {} }) {
  const engineDir = path.join(userdataDir, 'videodl-engine');
  const stateFile = path.join(engineDir, 'state.json');
  const historyFile = path.join(userdataDir, 'videodl-history.json');
  const jobs = new Map();
  const browserQueue = { pending: 0, tail: Promise.resolve() };
  let activeProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  let proxyDetected = false;
  let engineCache = null;
  let checkRunning = false;

  const log = (message) => { if (process.env.VIDEODL_DEBUG) console.error('[videodl]', message); };

  // ── 变更通知（节流；终态时立即推） ──
  function list() {
    const running = [...jobs.values()].filter((j) => j.status === 'running').sort((a, b) => (b.t || 0) - (a.t || 0));
    const terminal = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => (b.t || 0) - (a.t || 0));
    return [...running, ...terminal.slice(0, HISTORY_SHOW)].map(publicJob);
  }
  function publicJob(job) {
    const { _killResolver, _killDownload, _aborter, ...rest } = job;
    return rest;
  }
  function emit() { try { onChanged(list()); } catch (error) { log(`onChanged 失败: ${error.message}`); } }
  const emitThrottled = (() => {
    let timer = null;
    return () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; emit(); }, 400);
    };
  })();

  // ── 历史落盘 ──
  function loadHistory() {
    try {
      const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      for (const entry of Array.isArray(raw) ? raw : []) {
        if (entry && typeof entry.id === 'string' && entry.status !== 'running') jobs.set(entry.id, { ...entry, history: true });
      }
    } catch { /* 首次运行没有历史文件 */ }
  }
  function persistHistory() {
    // 只在任务到终态 / 清空记录时调用，频率很低——直接写，不做防抖：
    // 防抖会让「刚下完就重启」丢掉最后一条记录（自检里真踩到过：文件还没落盘就被读）。
    try {
      fs.mkdirSync(userdataDir, { recursive: true });
      const terminal = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => (a.t || 0) - (b.t || 0));
      const temp = historyFile + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(terminal.slice(-HISTORY_KEEP), null, 2));
      fs.renameSync(temp, historyFile);
    } catch (error) { log(`历史落盘失败: ${error.message}`); }
  }
  function pruneJobs() {
    const terminal = [...jobs.values()].filter((j) => j.status !== 'running');
    if (terminal.length <= HISTORY_KEEP) return;
    terminal.sort((a, b) => (a.t || 0) - (b.t || 0)).slice(0, terminal.length - 40).forEach((j) => jobs.delete(j.id));
  }

  // ── 引擎解析：自更新版优先，随包版兜底 ──
  function resolveEngine() {
    const bundled = path.join(addonsRoot, 'ytdlp', 'yt-dlp.exe');
    const manifest = path.join(engineDir, 'manifest.json');
    const stat = (p) => { try { const s = fs.statSync(p); return `${s.size}:${s.mtimeMs}`; } catch { return 'none'; } };
    const key = `${stat(bundled)}|${stat(manifest)}`;
    if (engineCache && engineCache.key === key) return engineCache.value;
    let value = null;
    const updated = readInstalledEngine(engineDir);
    if (updated) {
      value = { path: updated.path, version: updated.version, source: 'updated', sha256: updated.sha256 };
    } else if (fs.existsSync(bundled)) {
      try {
        const sha = sha256File(bundled);
        value = sha === PINNED_ENGINE.sha256
          ? { path: bundled, version: PINNED_ENGINE.version, source: 'bundled', sha256: sha }
          : { path: bundled, version: '未校验', source: 'bundled-unverified', sha256: sha, warning: '加装包与记录指纹不一致，可能被改动过' };
      } catch { value = null; }
    }
    engineCache = { key, value };
    return value;
  }

  /** YouTube 挑战求解用的 JS 运行时（可选加装 addons/ytdlp/node/node.exe；没有也能下载，只是 YouTube 受限） */
  function resolveJsRuntime() {
    const candidate = path.join(addonsRoot, 'ytdlp', 'node', 'node.exe');
    return fs.existsSync(candidate) ? candidate : '';
  }

  // ── 代理 ──
  function detectProxy() {
    if (activeProxy) return Promise.resolve(activeProxy);
    if (proxyDetected) return Promise.resolve('');
    return new Promise((resolve) => {
      let index = 0;
      const tryNext = () => {
        if (index >= PROXY_CANDIDATES.length) { proxyDetected = true; return resolve(''); }
        const candidate = PROXY_CANDIDATES[index++];
        let settled = false;
        const finish = (found) => {
          if (settled) return;
          settled = true;
          if (found) { activeProxy = `${candidate.scheme}://127.0.0.1:${candidate.port}`; resolve(activeProxy); }
          else tryNext();
        };
        const socket = net.connect({ host: '127.0.0.1', port: candidate.port, timeout: 500 });
        socket.on('connect', () => { socket.destroy(); finish(true); });
        socket.on('error', () => finish(false));
        socket.on('timeout', () => { socket.destroy(); finish(false); });
      };
      tryNext();
    });
  }

  // ── GitHub 访问（直连失败且探测到代理时用 curl.exe 走代理） ──
  function makeGithubFetch() {
    return async (url, options = {}) => {
      const headers = { 'User-Agent': 'tomato-toolbox-videodl', Accept: 'application/vnd.github+json' };
      try {
        const response = await fetch(url, { ...options, headers });
        return response;
      } catch (directError) {
        const proxy = await detectProxy();
        if (!proxy) throw directError;
        const args = ['-L', '--fail', '--retry', '2', '--connect-timeout', '20', '--max-time', '60', '-s', '--proxy', proxy,
          '-A', headers['User-Agent'], '-H', `Accept: ${headers.Accept}`, url];
        const child = spawn('curl.exe', args, { windowsHide: true });
        let out = '';
        child.stderr.on('data', () => {});
        child.stdout.on('data', (d) => { out += d; });
        const code = await new Promise((resolve) => { child.on('error', () => resolve(-1)); child.on('close', (c) => resolve(c)); });
        if (code !== 0) throw new Error('连接 GitHub 失败，请检查网络或代理');
        return { ok: true, status: 200, json: async () => JSON.parse(out), text: async () => out };
      }
    };
  }

  // ── 引擎状态 / 检查 / 更新 ──
  function readState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { return {}; } }
  function writeState(patch) {
    try {
      fs.mkdirSync(engineDir, { recursive: true });
      const next = { ...readState(), ...patch };
      const temp = stateFile + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(next, null, 2));
      fs.renameSync(temp, stateFile);
      return next;
    } catch (error) { log(`引擎状态落盘失败: ${error.message}`); return readState(); }
  }

  function engineStatus() {
    const engine = resolveEngine();
    const state = readState();
    return {
      engine: engine ? { version: engine.version, source: engine.source, warning: engine.warning || '' } : null,
      pinned: { version: PINNED_ENGINE.version },
      updated: state.updated || null,
      available: state.latest && engine && state.latest.version !== engine.version ? { version: state.latest.version } : null,
      lastCheckAt: Number(state.lastCheckAt) || 0,
      checking: checkRunning,
      lastError: state.lastError || '',
      ffmpeg: { found: Boolean(ffmpegPath) },
      jsRuntime: Boolean(resolveJsRuntime()),
      proxy: activeProxy,
    };
  }

  async function checkEngine({ force = false } = {}) {
    const state = readState();
    if (!force && state.lastCheckAt && Date.now() - state.lastCheckAt < WEEK_MS) {
      return { ok: true, cached: true, status: engineStatus() };
    }
    if (checkRunning) return { ok: true, checking: true, status: engineStatus() };
    checkRunning = true;
    emit();
    try {
      const latest = await checkLatestEngine({ fetchImpl: makeGithubFetch() });
      writeState({ lastCheckAt: Date.now(), latest, lastError: '' });
      return { ok: true, latest, status: engineStatus() };
    } catch (error) {
      const message = error.message || '检查更新失败';
      writeState({ lastCheckAt: Date.now(), lastError: message });
      return { ok: false, error: message, status: engineStatus() };
    } finally {
      checkRunning = false;
      emit();
    }
  }

  async function updateEngine({ onProgress } = {}) {
    let latest = readState().latest;
    try {
      latest = await checkLatestEngine({ fetchImpl: makeGithubFetch() });
      writeState({ lastCheckAt: Date.now(), latest, lastError: '' });
    } catch (error) {
      if (!latest) return { ok: false, error: error.message || '检查更新失败' };
    }
    const engine = resolveEngine();
    if (engine && latest.version === engine.version) return { ok: false, error: '已是最新版本' };
    const proxy = await detectProxy();
    const tempFile = path.join(engineDir, `download-${Date.now()}.exe`);
    try {
      await downloadEngine({ url: latest.url, sha256: latest.sha256, destFile: tempFile, proxy, onProgress });
      const installed = installEngine({ srcFile: tempFile, engineDir, version: latest.version, sha256: latest.sha256 });
      engineCache = null;
      writeState({ updated: { version: installed.version, installedAt: installed.installedAt }, lastError: '' });
      emit();
      return { ok: true, version: installed.version };
    } catch (error) {
      const message = error.message || '更新引擎失败';
      writeState({ lastError: message });
      return { ok: false, error: message };
    } finally {
      try { fs.unlinkSync(tempFile); } catch {}
    }
  }

  async function ensureAutoCheck(autoCheckEnabled) {
    if (!autoCheckEnabled) return;
    const state = readState();
    if (state.lastCheckAt && Date.now() - state.lastCheckAt < WEEK_MS) return;
    await checkEngine({ force: false });
  }

  // ── 任务生命周期 ──
  const ctx = {
    ffmpegPath,
    pluginsDir: path.join(toolRoot, 'plugins'),
    resolverDouyin: path.join(toolRoot, 'core', 'douyin-resolver.cjs'),
    resolverBrowser: path.join(toolRoot, 'core', 'browser-resolver.cjs'),
    proxy: () => activeProxy,
    engine: resolveEngine,
    jsRuntime: resolveJsRuntime,
    emit: emitThrottled,
    browserQueue,
    tempDirName: TEMP_DIR_NAME,
    xhsCookieBrowsers: (() => {
      const local = process.env.LOCALAPPDATA || '';
      const roaming = process.env.APPDATA || '';
      const candidates = [
        ['chrome', path.join(local, 'Google', 'Chrome', 'User Data')],
        ['edge', path.join(local, 'Microsoft', 'Edge', 'User Data')],
        ['brave', path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
        ['vivaldi', path.join(local, 'Vivaldi', 'User Data')],
        ['chromium', path.join(local, 'Chromium', 'User Data')],
        ['opera', path.join(roaming, 'Opera Software', 'Opera Stable')],
        ['firefox', path.join(roaming, 'Mozilla', 'Firefox', 'Profiles')],
      ];
      return candidates.filter(([, profile]) => profile && fs.existsSync(profile)).map(([browser]) => browser);
    })(),
  };

  function cleanupJobTemp(job) {
    const perJob = path.join(job.dir, TEMP_DIR_NAME, job.id);
    try { fs.rmSync(perJob, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    try { fs.rmdirSync(path.join(job.dir, TEMP_DIR_NAME)); } catch { /* 还有别的任务在用，留着 */ }
  }

  function finalize(job) {
    if (job.status === 'running') { job.status = 'error'; job.phase = '失败'; job.err = job.err || '任务意外结束'; }
    job._killResolver = null; job._killDownload = null; job._aborter = null;
    job.endedAt = Date.now();
    job.history = true;
    cleanupJobTemp(job);
    persistHistory();
    pruneJobs();
    emit();
  }

  function runDetached(job, runner) {
    Promise.resolve()
      .then(runner)
      .catch((error) => {
        if (job.status === 'running') {
          if (job.cancelRequested) { job.status = 'cancelled'; job.phase = '已取消'; job.err = ''; }
          else { job.status = 'error'; job.phase = '失败'; job.err = error.message || '下载失败'; }
        }
      })
      .finally(() => finalize(job));
  }

  async function start(rawUrl, dir) {
    let url = extractUrl(rawUrl);
    if (!url) throw new Error('没有识别到链接，请粘贴视频网页地址或 MP4/M3U8/MPD 直链');
    const running = [...jobs.values()].filter((j) => j.status === 'running').length;
    if (running >= MAX_CONCURRENT) throw new Error('最多同时下载三个视频，请等一个任务结束后重试');
    dir = String(dir || '').trim();
    if (!dir || !path.isAbsolute(dir)) throw new Error('请先选择保存位置');
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test-' + crypto.randomBytes(6).toString('hex'));
    try { fs.writeFileSync(probe, '', { flag: 'wx' }); }
    catch { throw new Error('保存目录无法写入，请更换保存位置'); }
    finally { try { fs.unlinkSync(probe); } catch {} }

    if (url !== rawUrl) log(`从文本中提取到链接: ${url}`);
    const id = crypto.randomBytes(5).toString('hex');
    const job = {
      id, url, name: url, pct: 0, speed: '', eta: '', status: 'running', err: '', file: '', dir,
      merging: false, phase: '准备下载', attempt: 1, t: Date.now(), note: '', endedAt: 0,
      cancelRequested: false, _killResolver: null, _killDownload: null, _aborter: null,
    };
    jobs.set(id, job);

    if (yangshipin.isYangshipinUrl(url)) {
      runDetached(job, () => runYangshipinJob(ctx, job));
      emit();
      return publicJob(job);
    }
    if (isDouyinUrl(url)) {
      runDetached(job, () => runDouyinJob(ctx, job));
      emit();
      return publicJob(job);
    }
    try { url = await resolveXiaohongshuUrl(url); } catch { /* 短链解析失败就按原链接试 */ }
    job.url = url;
    runDetached(job, () => runYtdlpJob(ctx, job, {}));
    emit();
    return publicJob(job);
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job || job.status !== 'running') return false;
    job.cancelRequested = true;
    try { job._killResolver?.(); } catch {}
    try { job._killDownload?.(); } catch {}
    try { job._aborter?.(); } catch {}
    emitThrottled();
    return true;
  }

  function retry(id) {
    const job = jobs.get(id);
    if (!job || job.status === 'running') return null;
    return start(job.url, job.dir);
  }

  function clearHistory() {
    for (const [id, job] of [...jobs.entries()]) {
      if (job.status !== 'running') jobs.delete(id);
    }
    persistHistory();
    emit();
    return true;
  }

  function stopAll() {
    let count = 0;
    for (const job of jobs.values()) {
      if (job.status === 'running') { cancel(job.id); count++; }
    }
    return count;
  }

  loadHistory();
  emit();

  return { start, cancel, retry, list, clearHistory, engineStatus, checkEngine, updateEngine, ensureAutoCheck, detectProxy, stopAll, inspectMedia: (file) => inspectMedia(ctx, file), finishVideoJob: (job) => finishVideoJob(ctx, job) };
}
