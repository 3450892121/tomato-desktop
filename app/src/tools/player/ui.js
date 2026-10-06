// 工具：视频播放器 —— 界面与交互
// 分层：播放判断/文案在 core/plan.js；本文件只做「界面 + 流程编排」；
//       格式探测、进度订阅与取消复用 shared/ffmpeg.js（probeMedia / onMediaProgress / cancelMediaJob / ffmpegStatus）。
// 播放本身走主进程注册的本地媒体协议 tomato-media://（支持 Range 分块读取，见 main.js），
// 所以界面进程不需要碰文件、也不会把整个视频读进内存。
import { probeMedia, ffmpegStatus, onMediaProgress, cancelMediaJob } from '../../shared/ffmpeg.js';
import {
  PLAYER_EXTS, planPlayback, nextMode, buildPrepareArgs, describeMode,
  mediaUrl, formatTime, describeProbe, normalizeExt
} from './core/plan.js';

const MARKUP = `
  <div class="pl-tool">
    <section class="card pl-top">
      <div class="pl-top-row">
        <button class="btn btn-primary" id="plOpenBtn" data-open="1" type="button">打开视频</button>
        <div class="pl-file">
          <div class="pl-file-name" id="plFileName">还没有打开视频</div>
          <div class="pl-file-meta" id="plFileMeta"></div>
        </div>
      </div>
      <div class="pl-note" id="plNote"></div>
    </section>

    <section class="pl-screen" id="plScreen">
      <div class="pl-stage" id="plStage">
        <video class="pl-video" id="plVideo" preload="metadata" playsinline></video>
        <div class="pl-empty" id="plEmpty">
          <div class="pl-empty-icon">🎬</div>
          <div class="pl-empty-title">把视频拖到这里</div>
          <div class="pl-empty-hint">也可以点上面的「打开视频」；Windows 自带播放器打不开的格式，这里多半能放</div>
        </div>
        <div class="pl-overlay" id="plOverlay" hidden>
          <div class="pl-overlay-text" id="plOverlayText">正在准备可播放版本…</div>
          <div class="pl-overlay-track"><div class="pl-overlay-fill" id="plOverlayFill"></div></div>
          <button class="btn btn-ghost" id="plCancelBtn" data-cancel="1" type="button">取消</button>
        </div>
      </div>
      <div class="pl-bar" id="plBar">
        <button class="pl-btn pl-play" id="plPlayBtn" data-play="1" type="button" title="播放 / 暂停（空格）" disabled>▶</button>
        <span class="pl-time" id="plTime">00:00 / 00:00</span>
        <input class="pl-seek" id="plSeek" data-seek="1" type="range" min="0" max="1000" step="1" value="0"
               aria-label="播放进度" disabled />
        <button class="pl-btn" id="plMuteBtn" data-mute="1" type="button" title="静音（M）" disabled>🔊</button>
        <input class="pl-vol" id="plVol" data-vol="1" type="range" min="0" max="100" step="1" value="100"
               aria-label="音量" disabled />
        <button class="pl-btn pl-full" id="plFullBtn" data-full="1" type="button" title="全屏（F）" disabled>全屏</button>
      </div>
    </section>
  </div>
`;

let state = null;

function on(el, type, handler, options) {
  el.addEventListener(type, handler, options);
  state.listeners.push([el, type, handler, options]);
}

// —— 文案与状态提示 ——

/** 提示行：kind = ''（普通）| 'ok' | 'warn' | 'error' */
function setNote(text, kind = '') {
  const el = state.els.note;
  el.className = `pl-note${kind ? ` is-${kind}` : ''}`;
  el.textContent = text || '';
}

function renderFileInfo() {
  const { els } = state;
  const f = state.file;
  if (!f) {
    els.fileName.textContent = '还没有打开视频';
    els.fileName.title = '';
    els.fileMeta.textContent = '支持 MP4 / MKV / AVI / FLV / WebM / MOV / WMV 等常见格式，也能直接播本软件转出来的视频';
    return;
  }
  els.fileName.textContent = f.name;
  els.fileName.title = f.path;
  els.fileMeta.textContent = describeProbe(f.probe, f.ext);
}

/** 控制条的可用状态：没有文件时整排禁用 */
function updateControls() {
  const { els } = state;
  const has = !!state.file;
  const busy = state.preparing;
  els.openBtn.disabled = busy;
  els.openBtn.textContent = busy ? '处理中…' : '打开视频';
  els.playBtn.disabled = !has || busy;
  els.seek.disabled = !has || busy;
  els.muteBtn.disabled = !has || busy;
  els.vol.disabled = !has || busy;
  els.fullBtn.disabled = !has || busy;
}

// —— 准备副本（换封装 / 重编码）的覆盖层 ——

function showOverlay(text) {
  const { els } = state;
  state.overlayBase = text;
  els.overlayText.textContent = text;
  els.overlayFill.style.width = '0%';
  els.overlay.hidden = false;
}
function setOverlayProgress(percent, speed) {
  const { els } = state;
  const p = Math.max(0, Math.min(100, Math.round(percent || 0)));
  els.overlayFill.style.width = `${p}%`;
  // 基础文案单独存着，避免反复用正则从「带百分比的文案」里往回抠
  els.overlayText.textContent = `${state.overlayBase || '正在准备可播放版本…'} ${p}%${speed ? `（${speed}）` : ''}`;
}
function hideOverlay() {
  state.els.overlay.hidden = true;
}

/** 转码进度（复用 ffmpeg:progress 通道；只认自己这一单 jobId） */
function onProgress(payload) {
  if (!state || !payload || !payload.jobId || payload.jobId !== state.jobId) return;
  setOverlayProgress(payload.percent, payload.speed);
  // 长任务同时挂到框架的全屏进度上（切走工具页也看得见）；短任务不打扰
  if (state.ctx.isActive() && state.mode === 'transcode') {
    state.ctx.showProgress(`正在准备可播放版本（${state.file ? state.file.name : ''}）`, Math.min(99, payload.percent || 0));
  }
}

// —— 清理播放缓存 ——

async function cleanCache() {
  try {
    await state.ctx.playerCleanCache();
  } catch {
    /* 清理失败不影响播放；可能是正在播放的副本被系统占用，留给下次进入时清理 */
  }
  state.preparedPath = '';
}

// —— 打开与播放 ——

/** 把播放器复位到「没有加载任何文件」的状态（换文件、出错时用） */
function resetPlayback() {
  const v = state.els.video;
  state.srcUrl = '';
  try {
    v.pause();
    v.removeAttribute('src');
    v.load(); // 释放上一个文件的句柄（Windows 上不释放会影响缓存清理）
  } catch {
    /* 忽略：复位失败不影响后续加载 */
  }
  state.mode = '';
  state.errorHandled = false;
  state.els.seek.value = '0';
  state.els.seek.style.setProperty('--pl-fill', '0%');
  state.els.time.textContent = '00:00 / 00:00';
  state.els.empty.hidden = false;
}

function setSource(url) {
  const v = state.els.video;
  state.srcUrl = url;
  state.errorHandled = false;
  v.src = url;
  v.load();
  state.els.empty.hidden = true;
  const p = v.play();
  if (p && typeof p.catch === 'function') {
    // 自动播放被系统策略拦下时不打扰用户：控制条就在下面，点一下即可
    p.catch(() => {});
  }
}

/** 开始以指定档位播放（失败自动升档见 onVideoError） */
async function startPlayback(mode) {
  const file = state.file;
  if (!file) return;
  state.mode = mode;

  if (mode === 'direct') {
    setSource(mediaUrl(file.path));
    setNote(describeMode('direct', file.probe || {}), 'ok');
    updateControls();
    return;
  }

  const preparedPath = await prepare(mode);
  if (!state || !preparedPath) return; // 已取消或失败（prepare 内已提示）
  setSource(mediaUrl(preparedPath));
  setNote(describeMode(mode, file.probe || {}), 'ok');
  updateControls();
}

/**
 * 让 ffmpeg 在软件目录的播放缓存里准备一份可播放副本（主进程负责落盘与进度）。
 * 返回副本路径；取消或失败返回 ''（失败已写进提示行）。
 */
async function prepare(mode) {
  const file = state.file;
  const ctx = state.ctx;
  const jobId = `pl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  state.preparing = true;
  state.jobId = jobId;
  state.cancelled = false;
  showOverlay(mode === 'transcode' ? '正在重编码为可播放版本…' : '正在准备可播放版本（无损换封装）…');
  updateControls();

  let res;
  try {
    res = await ctx.playerPrepare({
      inputPath: file.path,
      mode,
      args: buildPrepareArgs(mode, file.probe || {}),
      durationMs: file.probe ? Math.round(file.probe.durationSec * 1000) : 0,
      jobId
    });
  } catch (err) {
    res = { ok: false, message: err.message };
  } finally {
    // 页面可能在等待期间被 LRU 回收（unmount 已把 state 置空）：这时别再碰界面
    if (state) {
      state.preparing = false;
      state.jobId = null;
      hideOverlay();
      if (state.ctx.isActive()) state.ctx.hideProgress();
      updateControls();
    }
  }

  if (!state) return '';
  if (state.cancelled) return '';
  if (!res || !res.ok) {
    setNote((res && res.message) || '准备可播放版本失败', 'error');
    ctx.setStatus(`播放失败：${(res && res.message) || '准备可播放版本失败'}`);
    return '';
  }
  state.preparedPath = res.path;
  if (!res.cached) {
    // 副本体积写进元信息行，用户对「多占了多少磁盘」心里有数
    const sizeText = `${(res.size / 1024 / 1024).toFixed(1)} MB`;
    ctx.setStatus(`已准备可播放副本（${sizeText}，${(res.ms / 1000).toFixed(1)} 秒）`);
  }
  return res.path;
}

/** 内核播不了时的升级重试：direct → remux → remux-audio → transcode → 放弃 */
async function onVideoError() {
  if (!state || !state.srcUrl || state.errorHandled || state.preparing) return;
  const from = state.mode || 'direct';
  const v = state.els.video;
  const code = v.error ? v.error.code : 0;
  state.errorHandled = true;

  const next = nextMode(from);
  if (!next) {
    state.ctx.setStatus('这个视频播不了：可能文件损坏，或用了内核不支持的编码');
    setNote(`磁盘上的这个文件没法播放${code ? `（内核错误码 ${code}）` : ''}：可能是文件损坏或编码过于特殊`, 'error');
    return;
  }

  let ffmpeg = state.ffmpeg;
  if (!ffmpeg) {
    ffmpeg = await ffmpegStatus().catch(() => ({ found: false }));
    if (state) state.ffmpeg = ffmpeg;
  }
  if (!ffmpeg.found) {
    setNote('这个格式需要 ffmpeg 加装包才能播放：把加装包解压到软件目录的 addons/ffmpeg 后重开本工具（原生 MP4 / WebM 不受影响）', 'error');
    return;
  }

  const label = { remux: '无损换封装', 'remux-audio': '音轨转 AAC', transcode: '重编码' }[next] || next;
  setNote(`这个文件用「${label}」方式重新准备一下…`, 'warn');
  await startPlayback(next);
}

/** 打开一个文件：探测 → 定播放计划 → 直接播或先准备副本 */
async function loadVideo(file) {
  resetPlayback();
  state.file = file;
  renderFileInfo();
  updateControls();
  setNote(`正在识别格式：${file.name}…`);
  state.ctx.setStatus(`已打开：${file.name}`);

  const probe = await probeMedia(file.path).catch(() => null);
  if (!state || !state.file || state.file.path !== file.path) return; // 期间又换了文件
  state.file.probe = probe && probe.ok ? probe : null;
  renderFileInfo();
  if (state.file.probe) {
    state.ctx.setInfo({ width: state.file.probe.width, height: state.file.probe.height });
  }

  const plan = planPlayback({ ext: file.ext, probe: state.file.probe });
  if (plan.needsFfmpeg) {
    const ffmpeg = await ffmpegStatus().catch(() => ({ found: false }));
    if (!state || !state.file || state.file.path !== file.path) return;
    state.ffmpeg = ffmpeg;
    if (!ffmpeg.found) {
      setNote('这个格式要借 ffmpeg 加装包转成可播放版本：把加装包解压到软件目录的 addons/ffmpeg 后重开本工具（原生 MP4 / WebM 不受影响）', 'error');
      state.ctx.setStatus('未检测到 ffmpeg：这种格式播不了，MP4 / WebM 仍可直接播放');
      return;
    }
    setNote(plan.reason, 'warn');
  }
  await startPlayback(plan.mode);
}

/** 从路径打开（对话框与拖拽共用） */
async function openPath(path) {
  if (!state || state.preparing) return;
  let info;
  try {
    info = await state.ctx.pathInfo(path);
  } catch (err) {
    setNote(`读取文件信息失败：${err.message}`, 'error');
    return;
  }
  if (!info || info.isDirectory) {
    setNote('请选择视频文件本身（不支持整个文件夹）', 'warn');
    return;
  }
  const ext = normalizeExt(info.ext);
  if (!PLAYER_EXTS.includes(ext)) {
    setNote(`这个文件看起来不是视频（${ext ? `.${ext}` : '没有扩展名'}），换一个试试`, 'warn');
    return;
  }
  // 换文件前把上一个副本删掉：缓存只服务当前播放的文件
  await cleanCache();
  if (!state) return;
  await loadVideo({ path, name: info.name, ext });
}

async function openDialog() {
  if (!state || state.preparing) return;
  const paths = await state.ctx.openPlayerVideos();
  if (!state || !paths || paths.length === 0) return;
  await openPath(paths[0]);
}

// —— 播放控制 ——

function durationOf() {
  const v = state.els.video;
  if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
  const probe = state.file && state.file.probe;
  return probe && probe.durationSec > 0 ? probe.durationSec : 0;
}

function syncPlayButton() {
  const v = state.els.video;
  state.els.playBtn.textContent = v.paused ? '▶' : '⏸';
  state.els.playBtn.title = v.paused ? '播放（空格）' : '暂停（空格）';
}

function syncTimeUI() {
  const v = state.els.video;
  const dur = durationOf();
  const cur = v.currentTime || 0;
  state.els.time.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
  if (!state.dragging) {
    const percent = dur > 0 ? Math.max(0, Math.min(100, (cur / dur) * 100)) : 0;
    state.els.seek.value = String(Math.round(percent * 10));
    state.els.seek.style.setProperty('--pl-fill', `${percent.toFixed(2)}%`);
  }
}

function syncVolumeUI() {
  const v = state.els.video;
  const level = v.muted ? 0 : v.volume;
  state.els.vol.value = String(Math.round(level * 100));
  state.els.vol.style.setProperty('--pl-fill', `${Math.round(level * 100)}%`);
  state.els.muteBtn.textContent = level === 0 ? '🔇' : '🔊';
  state.els.muteBtn.title = v.muted ? '取消静音（M）' : '静音（M）';
}

function togglePlay() {
  const v = state.els.video;
  if (!state.file || state.preparing) {
    if (!state.file) openDialog();
    return;
  }
  if (v.paused) v.play().catch(() => {});
  else v.pause();
}

function seekBy(deltaSec) {
  const v = state.els.video;
  const dur = durationOf();
  if (!state.file || dur <= 0) return;
  v.currentTime = Math.max(0, Math.min(dur - 0.05, (v.currentTime || 0) + deltaSec));
  syncTimeUI();
}

function volumeBy(delta) {
  const v = state.els.video;
  v.muted = false;
  v.volume = Math.max(0, Math.min(1, v.volume + delta));
  syncVolumeUI();
}

function toggleMute() {
  const v = state.els.video;
  v.muted = !v.muted;
  syncVolumeUI();
}

function updateFullButton() {
  const on = document.fullscreenElement === state.els.screen;
  state.els.fullBtn.textContent = on ? '退出全屏' : '全屏';
  state.els.fullBtn.title = on ? '退出全屏（Esc 或 F）' : '全屏（F）';
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await state.els.screen.requestFullscreen();
  } catch (err) {
    setNote(`全屏切换失败：${err.message}`, 'warn');
  }
}

/** 窗口内快捷键：只在「本工具正显示 + 焦点不在输入框」时生效（框架约定） */
function onKeyDown(event) {
  if (!state || !state.ctx.isActive()) return;
  const t = event.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  switch (event.key) {
    case ' ': case 'Spacebar':
      event.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft': seekBy(-5); break;
    case 'ArrowRight': seekBy(5); break;
    case 'ArrowUp': event.preventDefault(); volumeBy(0.05); break;
    case 'ArrowDown': event.preventDefault(); volumeBy(-0.05); break;
    case 'm': case 'M': toggleMute(); break;
    case 'f': case 'F': toggleFullscreen(); break;
    default: break;
  }
}

// —— 拖拽（整个工具页都是投放区） ——

function onDragOver(event) {
  if (!state || state.preparing) return;
  event.preventDefault();
  state.container.querySelector('.pl-tool').classList.add('is-drag');
}

function onDragLeave() {
  if (!state) return;
  state.container.querySelector('.pl-tool').classList.remove('is-drag');
}

async function onDrop(event) {
  if (!state) return;
  event.preventDefault();
  state.container.querySelector('.pl-tool').classList.remove('is-drag');
  if (state.preparing) return;
  const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
  if (files.length === 0) return;
  const path = state.ctx.getPathForFile(files[0]);
  if (!path) {
    setNote('没能取到文件路径，请用「打开视频」选择文件', 'warn');
    return;
  }
  await openPath(path);
}

// —— 生命周期 ——

export function mount(container, ctx) {
  state = {
    container,
    ctx,
    els: null,
    listeners: [],
    file: null,
    mode: '',
    srcUrl: '',
    preparedPath: '',   // 当前正在播的缓存副本（用于说明与清理）
    preparing: false,
    cancelled: false,
    jobId: null,
    dragging: false,
    errorHandled: false,
    ffmpeg: null,
    unsubProgress: null
  };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.pl-tool'),
    openBtn: container.querySelector('#plOpenBtn'),
    fileName: container.querySelector('#plFileName'),
    fileMeta: container.querySelector('#plFileMeta'),
    note: container.querySelector('#plNote'),
    screen: container.querySelector('#plScreen'),
    stage: container.querySelector('#plStage'),
    video: container.querySelector('#plVideo'),
    empty: container.querySelector('#plEmpty'),
    overlay: container.querySelector('#plOverlay'),
    overlayText: container.querySelector('#plOverlayText'),
    overlayFill: container.querySelector('#plOverlayFill'),
    cancelBtn: container.querySelector('#plCancelBtn'),
    bar: container.querySelector('#plBar'),
    playBtn: container.querySelector('#plPlayBtn'),
    time: container.querySelector('#plTime'),
    seek: container.querySelector('#plSeek'),
    muteBtn: container.querySelector('#plMuteBtn'),
    vol: container.querySelector('#plVol'),
    fullBtn: container.querySelector('#plFullBtn')
  };
  state.els = els;

  // 顶部与拖拽
  on(els.openBtn, 'click', openDialog);
  on(els.root, 'dragover', onDragOver);
  on(els.root, 'dragleave', onDragLeave);
  on(els.root, 'drop', onDrop);

  // 控制条
  on(els.playBtn, 'click', togglePlay);
  on(els.muteBtn, 'click', toggleMute);
  on(els.fullBtn, 'click', toggleFullscreen);
  on(els.cancelBtn, 'click', () => {
    if (!state || !state.jobId) return;
    state.cancelled = true;
    try { cancelMediaJob(state.jobId); } catch { /* 任务可能刚结束 */ }
    setNote('已取消：这个格式本工具暂时播不了', 'warn');
  });
  on(els.seek, 'input', () => {
    const dur = durationOf();
    if (dur <= 0) return;
    state.dragging = true;
    const percent = Number(els.seek.value) / 10;
    els.seek.style.setProperty('--pl-fill', `${percent}%`);
    state.els.video.currentTime = (percent / 100) * dur;
  });
  on(els.seek, 'change', () => {
    state.dragging = false;
    syncTimeUI();
  });
  on(els.vol, 'input', () => {
    const v = state.els.video;
    v.muted = false;
    v.volume = Math.max(0, Math.min(1, Number(els.vol.value) / 100));
    syncVolumeUI();
  });

  // 双击画面切全屏（播放器的通用习惯）
  on(els.stage, 'dblclick', toggleFullscreen);

  // video 事件
  on(els.video, 'loadedmetadata', () => {
    if (!state) return;
    if (els.video.videoWidth) {
      state.ctx.setInfo({ width: els.video.videoWidth, height: els.video.videoHeight });
    }
    syncTimeUI();
  });
  on(els.video, 'durationchange', syncTimeUI);
  on(els.video, 'timeupdate', syncTimeUI);
  on(els.video, 'progress', syncTimeUI);
  on(els.video, 'play', syncPlayButton);
  on(els.video, 'pause', syncPlayButton);
  on(els.video, 'volumechange', syncVolumeUI);
  on(els.video, 'ended', syncPlayButton);
  on(els.video, 'error', onVideoError);

  // 全局：快捷键 + 全屏状态（都先判 ctx.isActive()，切走工具时不抢按键）
  on(document, 'keydown', onKeyDown);
  on(document, 'fullscreenchange', () => { if (state) updateFullButton(); });

  state.unsubProgress = onMediaProgress(onProgress);

  renderFileInfo();
  updateControls();
  syncPlayButton();
  syncVolumeUI();
  updateFullButton();
  setNote('点「打开视频」或把视频拖进来；Windows 自带播放器打不开的格式，这里会自动转成可播放版本');
  ctx.setStatus('视频播放器：打开视频即可播放，无需另外装播放器');
  ctx.setInfo({});

  // 进入工具页时清一次缓存：上次异常退出（崩溃/断电）留下的副本不占磁盘
  cleanCache().then(() => { if (state) state.ffmpeg = null; });
  ffmpegStatus().then((s) => { if (state) state.ffmpeg = s; }).catch(() => {});
}

/** 每次切回本工具时调用（页面保活，界面与播放位置都还在；这里只做提示刷新） */
export function activate() {
  if (!state) return;
  updateFullButton();
  if (!state.file) {
    setNote('点「打开视频」或把视频拖进来；Windows 自带播放器打不开的格式，这里会自动转成可播放版本');
  }
}

/** 每次切走本工具时调用：别让声音跟着用户去别的工具页 */
export function deactivate() {
  if (!state) return;
  const v = state.els.video;
  if (!v.paused) {
    v.pause();
    setNote('已暂停（切走工具时自动暂停，切回来点播放继续）');
  }
}

export function unmount() {
  if (!state) return;
  const { els, ctx } = state;
  // 正在准备副本时被回收：把这一单 ffmpeg 也停掉，别让它变成没人认领的后台进程
  if (state.jobId) {
    try { cancelMediaJob(state.jobId); } catch { /* 任务可能刚结束 */ }
  }
  try {
    els.video.pause();
    els.video.removeAttribute('src');
    els.video.load(); // 释放文件句柄，副本才能删掉
  } catch {
    /* 忽略：清理失败不影响退出 */
  }
  if (state.unsubProgress) {
    try { state.unsubProgress(); } catch { /* 忽略 */ }
  }
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  // 播放副本不留给下一次（绿色软件不留垃圾）；正被系统占用的那份留给下次进入时清理
  ctx.playerCleanCache().catch(() => {});
  state = null;
}