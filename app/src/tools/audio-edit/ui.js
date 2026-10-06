// 工具：音频剪辑 —— 界面与交互
// 分层：本文件只做界面与流程编排；波形计算与参数拼装在 core/waveform.js，
//       编码与转码复用 shared/ffmpeg.js（单文件 convertMedia / 拼接 convertMediaMulti /
//       probeMedia / transformFileToBytes / cancelMediaJob / onMediaProgress）。
import {
  AUDIO_TARGETS, AUDIO_QUALITY_PRESETS, AUDIO_GAIN_PRESETS, AUDIO_FADE_PRESETS,
  convertMedia, convertMediaMulti, ffmpegStatus, probeMedia, transformFileToBytes, cancelMediaJob, onMediaProgress
} from '../../shared/ffmpeg.js';
import {
  AUDIO_EXTS, VIDEO_INPUT_EXTS, WAVE_BUCKETS, WAVE_SAMPLE_ARGS, WAVE_SLOW_MS,
  parseWav, buildPeaks, msToPx, pxToMs, normalizeSelection, buildEditPlan,
  formatTimeMs, parseTimeToMs, formatSize, formatDuration, formatMeta, formatChannels, baseNameOf
} from './core/waveform.js';

const MARKUP = `
  <div class="aedit-tool">
    <section class="card aedit-controls">
      <div class="aedit-params">
        <div class="aedit-param">
          <label class="control-label" for="aeditTarget">输出格式:</label>
          <select class="select" id="aeditTarget"></select>
        </div>
        <div class="aedit-param">
          <label class="control-label" for="aeditQuality">音质:</label>
          <select class="select" id="aeditQuality"></select>
          <span class="aedit-note-inline" id="aeditLosslessNote" hidden>无损格式无需选择音质</span>
        </div>
        <div class="aedit-param">
          <label class="control-label" for="aeditGain">音量:</label>
          <select class="select" id="aeditGain"></select>
        </div>
        <div class="aedit-param">
          <label class="control-label" for="aeditFadeIn">淡入:</label>
          <select class="select" id="aeditFadeIn"></select>
        </div>
        <div class="aedit-param">
          <label class="control-label" for="aeditFadeOut">淡出:</label>
          <select class="select" id="aeditFadeOut"></select>
        </div>
        <label class="aedit-param aedit-check" title="把列表里的文件按顺序合并成一个">
          <input type="checkbox" id="aeditConcat"> 拼接列表
        </label>
      </div>
      <div class="aedit-note" id="aeditModeNote"></div>
      <div class="aedit-note" id="aeditFfmpegNote">正在检测 ffmpeg…</div>
    </section>

    <main class="card aedit-files" id="aeditFiles">
      <div class="aedit-drop" id="aeditDrop">
        <button class="btn btn-primary btn-lg" data-add="1" id="aeditAddBtn">添加音频</button>
        <div class="aedit-drop-hint">也可以把音频或视频直接拖进窗口；支持多选（视频会自动提取声音）</div>
      </div>
      <div class="aedit-list-wrap" id="aeditListWrap" hidden>
        <div class="aedit-list-head">
          <span id="aeditListTitle">音频</span>
          <span class="aedit-spacer"></span>
          <span id="aeditListCount"></span>
          <button class="btn btn-ghost" data-add="1" id="aeditAddMore" type="button">＋ 继续添加</button>
        </div>
        <ul class="aedit-list" id="aeditList"></ul>
      </div>

      <section class="aedit-wave" id="aeditWave" hidden>
        <div class="aedit-wave-head">
          <span class="aedit-wave-name" id="aeditWaveName"></span>
          <span class="aedit-spacer"></span>
          <span class="aedit-wave-tip">在波形上按住拖动可改选区，两端手柄可单独拖</span>
        </div>
        <canvas class="aedit-canvas" id="aeditCanvas" height="96"></canvas>
        <div class="aedit-times">
          <label class="aedit-time">
            <span class="control-label">开始</span>
            <input class="input" id="aeditStart" type="text" inputmode="numeric" value="00:00.000">
          </label>
          <label class="aedit-time">
            <span class="control-label">结束</span>
            <input class="input" id="aeditEnd" type="text" inputmode="numeric" value="00:00.000">
          </label>
          <span class="aedit-clip" id="aeditClip"></span>
          <span class="aedit-spacer"></span>
          <button class="btn btn-ghost" id="aeditResetSel" type="button">全选</button>
        </div>
        <div class="aedit-wave-note" id="aeditWaveNote"></div>
      </section>
    </main>

    <footer class="aedit-actions">
      <button class="btn btn-primary aedit-run" data-run="1" id="aeditRunBtn">开始剪辑</button>
      <button class="btn btn-plain" data-clear="1" id="aeditClearBtn">清空</button>
      <div class="aedit-result" id="aeditResult"></div>
    </footer>
  </div>
`;

let state = null;

function on(el, type, handler) {
  el.addEventListener(type, handler);
  state.listeners.push([el, type, handler]);
}

function themeColor(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

// —— 下拉填充 ——

/** 输出格式下拉：按「常用 / 更多」两组显示（optgroup） */
function fillTargets(select) {
  select.innerHTML = '';
  const groups = [
    { id: 'common', label: '常用格式' },
    { id: 'more', label: '更多格式' }
  ];
  for (const g of groups) {
    const items = AUDIO_TARGETS.filter((t) => t.group === g.id);
    if (items.length === 0) continue;
    const og = document.createElement('optgroup');
    og.label = g.label;
    for (const t of items) {
      const opt = document.createElement('option');
      opt.value = t.value;
      opt.textContent = t.label;
      og.appendChild(opt);
    }
    select.appendChild(og);
  }
}

function fillQuality(select) {
  select.innerHTML = '';
  for (const key of Object.keys(AUDIO_QUALITY_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = AUDIO_QUALITY_PRESETS[key].label;
    select.appendChild(opt);
  }
}

function fillPresets(select, presets) {
  select.innerHTML = '';
  for (const p of presets) {
    const opt = document.createElement('option');
    opt.value = String(p.value);
    opt.textContent = p.label;
    select.appendChild(opt);
  }
}

// —— ffmpeg 加装包状态 ——

function renderFfmpegNote() {
  const note = state.els.ffmpegNote;
  if (!state.ffmpeg) {
    note.className = 'aedit-note';
    note.textContent = '正在检测 ffmpeg…';
    return;
  }
  if (state.ffmpeg.found) {
    const where = state.ffmpeg.where === 'addon' ? '加装包' : '系统安装';
    note.className = 'aedit-note is-ok';
    note.textContent = `✓ 已检测到 ffmpeg ${state.ffmpeg.version || ''}（${where}）`.replace(/\s+/g, ' ').trim();
  } else {
    note.className = 'aedit-note is-warn';
    note.textContent = '未检测到 ffmpeg：把加装包解压到软件目录的 addons/ffmpeg 后重开本工具即可。';
  }
}

async function refreshFfmpeg() {
  try {
    state.ffmpeg = await ffmpegStatus();
  } catch {
    state.ffmpeg = { found: false };
  }
  if (!state) return;
  renderFfmpegNote();
  updateRunButton();
}

// —— 参数与按钮 ——

function readParams() {
  const gainRaw = state.els.gainSel.value;
  return {
    target: state.els.targetSel.value,
    quality: state.els.qualitySel.value,
    gainDb: gainRaw === 'normalize' ? 'normalize' : Number(gainRaw) || 0,
    fadeInMs: Number(state.els.fadeInSel.value) || 0,
    fadeOutMs: Number(state.els.fadeOutSel.value) || 0,
    concat: state.els.concat.checked
  };
}

/** 无损格式（WAV/FLAC…）不需要音质档：禁用下拉并提示 */
function updateQualityState() {
  const target = AUDIO_TARGETS.find((t) => t.value === state.els.targetSel.value);
  const lossless = !!(target && target.lossless);
  state.els.qualitySel.disabled = lossless;
  state.els.losslessNote.hidden = !lossless;
}

/** 模式说明：默认提示「无滤镜可极速完成」；勾选拼接时说明拼接规则与不生效的参数 */
function updateModeNote() {
  const note = state.els.modeNote;
  if (state.els.concat.checked) {
    const enough = state.files.length >= 2;
    note.className = 'aedit-note' + (enough ? '' : ' is-warn');
    note.textContent = '拼接：按列表顺序合并成一个文件；截取/淡入淡出/音量仅对单个文件生效，拼接时不启用。'
      + (enough ? `当前将合并 ${state.files.length} 个文件。` : '请至少添加 2 个文件。');
  } else {
    note.className = 'aedit-note';
    note.textContent = '只截取、未加音量/淡入淡出、且输出格式与原文件相同时，直接复制音频流，几乎瞬间完成（不重编码）。';
  }
  updateRunButton();
}

function updateRunButton() {
  const { els } = state;
  els.runBtn.textContent = state.busy ? '取消' : (els.concat.checked ? '开始拼接' : '开始剪辑');
  const ffmpegOk = !!(state.ffmpeg && state.ffmpeg.found);
  // 运行中按钮变「取消」且始终可点；未检测到 ffmpeg 时禁用运行
  els.runBtn.disabled = !state.busy && !ffmpegOk;
}

// —— 文件列表 ——

function currentItem() {
  const i = state.selectedIndex;
  return i >= 0 && i < state.files.length ? state.files[i] : null;
}

function renderList() {
  const { els } = state;
  const files = state.files;
  els.listWrap.hidden = files.length === 0;
  els.drop.hidden = files.length > 0;
  els.listCount.textContent = files.length ? `共 ${files.length} 个` : '';
  els.list.innerHTML = '';

  files.forEach((f, index) => {
    const li = document.createElement('li');
    li.className = 'aedit-item' + (index === state.selectedIndex ? ' is-selected' : '');
    li.dataset.index = String(index);

    const main = document.createElement('div');
    main.className = 'aedit-item-main';

    const name = document.createElement('div');
    name.className = 'aedit-item-name';
    name.textContent = f.name;
    name.title = f.path;
    main.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'aedit-item-meta';
    const parts = [formatMeta(f)];
    if (f.sizeBytes) parts.push(formatSize(f.sizeBytes));
    meta.textContent = parts.filter(Boolean).join(' ｜ ');
    main.appendChild(meta);

    if (f.result) {
      const result = document.createElement('div');
      result.className = 'aedit-item-result' + (f.result.ok ? ' is-ok' : ' is-fail');
      result.textContent = f.result.text;
      result.title = f.result.text;
      // 产物完整路径挂到 DOM 上（界面自测据此校验产物，不靠猜目录里多了哪个文件）
      if (f.result.path) result.dataset.outPath = f.result.path;
      main.appendChild(result);
    }

    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'aedit-item-actions';
    const del = document.createElement('button');
    del.className = 'aedit-icon-btn';
    del.textContent = '×';
    del.title = '移除';
    del.disabled = state.busy;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.busy) return;
      removeAt(index);
    });
    actions.appendChild(del);
    li.appendChild(actions);

    li.addEventListener('click', () => {
      if (state.busy) return;
      selectItem(index);
    });

    els.list.appendChild(li);
  });
  updateModeNote();
}

function removeAt(index) {
  const wasSelected = state.selectedIndex === index;
  state.files.splice(index, 1);
  if (state.files.length === 0) {
    state.selectedIndex = -1;
    state.els.wave.hidden = true;
    state.waveToken += 1; // 作废进行中的波形加载
  } else if (wasSelected) {
    state.selectedIndex = Math.min(index, state.files.length - 1);
    state.waveToken += 1; // 选中的那个被删了：作废旧加载，避免画到新选中项上
  } else if (state.selectedIndex > index) {
    state.selectedIndex -= 1;
  }
  renderList();
  if (state.selectedIndex >= 0) showSelected();
}

// —— 添加文件 ——

/** 探测并加入列表；返回失败原因（成功返回空串） */
async function addOne(filePath, extInfo) {
  if (state.files.some((f) => f.path === filePath)) return '已在列表中';
  const info = extInfo || await state.ctx.pathInfo(filePath);
  const ext = (info.ext || '').toLowerCase();
  const isAudio = AUDIO_EXTS.includes(ext);
  const isVideo = VIDEO_INPUT_EXTS.includes(ext);
  if (!isAudio && !isVideo) return '不是支持的音频/视频格式';
  const probe = await probeMedia(filePath);
  if (!probe || !probe.ok) return (probe && probe.message) || '无法识别该文件';
  if (isVideo && !probe.hasAudio) return '这个视频没有声音，无法提取';
  const item = {
    path: filePath,
    name: info.name,
    baseName: info.baseName,
    dir: info.dir,
    ext,
    isVideo,
    durationSec: probe.durationSec,
    format: probe.format,
    sampleRate: probe.sampleRate,
    channelText: formatChannels(probe.channelLayout),
    // 剪辑相关状态（波形懒加载）
    peaks: null,
    waveDurationMs: 0,
    sizeBytes: Number(info.size) || 0, // 来自 ctx.pathInfo 的字节数，列表里直接显示
    sel: null,
    result: null
  };
  state.files.push(item);
  return '';
}

async function addFromPaths(paths) {
  const failures = [];
  let added = 0;

  for (const p of paths) {
    try {
      const info = await state.ctx.pathInfo(p);
      if (info.isDirectory) {
        const list = await state.ctx.listFiles(p, [...AUDIO_EXTS, ...VIDEO_INPUT_EXTS]);
        if (list.length === 0) { failures.push(`${info.name}：文件夹里没有支持的音频/视频`); continue; }
        for (const sub of list) {
          const reason = await addOne(sub, null);
          if (reason) failures.push(`${baseNameOf(sub)}：${reason}`);
          else added += 1;
        }
        continue;
      }
      const reason = await addOne(p, info);
      if (reason) failures.push(`${info.name}：${reason}`);
      else added += 1;
    } catch (err) {
      failures.push(`${baseNameOf(p)}：${err.message}`);
    }
  }

  const firstNew = state.files.length - added;
  if (added > 0 && state.selectedIndex < 0) state.selectedIndex = Math.max(0, firstNew);
  renderList();
  if (state.selectedIndex >= 0) showSelected();

  if (added > 0) {
    state.ctx.setStatus(`已添加 ${added} 个文件${failures.length ? `，${failures.length} 项跳过` : ''}`);
  } else {
    state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的音频');
  }
  if (failures.length > 1) console.warn('[audio-edit] 部分文件未添加：\n' + failures.join('\n'));
}

async function openDialog() {
  // 用本工具专用对话框：测试模式下只取「测试剪辑音频*」夹具，不会把别的测试留下的产物也选进来
  const paths = await state.ctx.openAudiosEdit();
  if (paths && paths.length > 0) await addFromPaths(paths);
}

async function onDrop(event) {
  event.preventDefault();
  if (state.busy) return;
  const files = Array.from(event.dataTransfer ? event.dataTransfer.files : []);
  const paths = [];
  for (const file of files) {
    const p = state.ctx.getPathForFile(file);
    if (p) paths.push(p);
  }
  if (paths.length > 0) await addFromPaths(paths);
}

// —— 波形与选区 ——

function setWaveNote(text, kind) {
  const el = state.els.waveNote;
  el.textContent = text || '';
  el.className = 'aedit-wave-note' + (kind ? ` is-${kind}` : '');
}

function selectItem(index) {
  if (index === state.selectedIndex) { showSelected(); return; }
  state.selectedIndex = index;
  state.waveToken += 1; // 作废上一个文件的波形加载
  renderList();
  showSelected();
}

/** 显示当前选中项：标题、时间框、波形（必要时先加载波形） */
function showSelected() {
  const item = currentItem();
  const { els } = state;
  if (!item) { els.wave.hidden = true; return; }
  els.wave.hidden = false;
  els.waveName.textContent = item.name;
  els.canvas.dataset.ready = item.peaks ? '1' : '0';
  syncTimeInputs();
  drawWave();
  if (!item.peaks) ensureWaveform(item);
}

/** 读取降采样 WAV → 峰值（懒加载；切换/移除/卸载都会用 token 作废） */
async function ensureWaveform(item) {
  const token = ++state.waveToken;
  const slow = (item.durationSec || 0) * 1000 > WAVE_SLOW_MS;
  setWaveNote(slow ? '正在生成波形…（该文件超过 30 分钟，可能较慢，请耐心等待）' : '正在生成波形…');
  try {
    // 按路径交给 ffmpeg 降采样：源文件可能是 GB 级视频，读进内存会把主进程与 IPC 一起撑爆，
    // 这里只回传几 MB 的 8kHz 单声道 WAV。
    const res = await transformFileToBytes(item.path, '.wav', WAVE_SAMPLE_ARGS);
    if (!state || token !== state.waveToken) return;
    // 体积优先用 pathInfo 给的（列表添加时就有）；读不到时补一次元信息（不读文件本体）
    if (!item.sizeBytes) {
      const info = await state.ctx.pathInfo(item.path).catch(() => null);
      if (!state || token !== state.waveToken) return;
      item.sizeBytes = Number(info && info.size) || 0;
    }
    if (!res || !res.ok) {
      setWaveNote(`无法生成波形（${(res && res.message) || '该格式不支持预览'}），仍可按下方时间框截取。`, 'warn');
      renderList();
      return;
    }
    const parsed = parseWav(res.bytes);
    if (!parsed.samples.length) {
      setWaveNote('无法生成波形（未能解析音频数据），仍可按下方时间框截取。', 'warn');
      renderList();
      return;
    }
    item.peaks = buildPeaks(parsed.samples, WAVE_BUCKETS);
    item.waveDurationMs = parsed.durationMs || Math.round((item.durationSec || 0) * 1000);
    item.sel = item.sel && item.sel.endMs > item.sel.startMs
      ? normalizeSelection({ ...item.sel, durationMs: item.waveDurationMs })
      : { startMs: 0, endMs: item.waveDurationMs };
    state.els.canvas.dataset.ready = '1';
    setWaveNote(slow ? '提示：该文件超过 30 分钟，波形加载较慢；可用下方时间框精确截取。' : '', slow ? 'warn' : '');
    renderList();
    syncTimeInputs();
    drawWave();
  } catch (err) {
    if (!state || token !== state.waveToken) return;
    setWaveNote(`无法生成波形：${err.message}（仍可按下方时间框截取）`, 'warn');
  }
}

function drawWave() {
  const { els } = state;
  const canvas = els.canvas;
  const item = currentItem();
  const w = canvas.clientWidth || 0;
  const h = canvas.clientHeight || 0;
  if (w <= 0 || h <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  const g = canvas.getContext('2d');
  if (!g) return;

  const bg = themeColor('--color-surface-soft', '#fafbfc');
  const border = themeColor('--color-border-strong', '#d8dbe2');
  const wave = themeColor('--color-text-secondary', '#6b7280');
  const primary = themeColor('--color-primary', '#ff5a4e');

  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);

  const peaks = item && item.peaks;
  const dur = item ? item.waveDurationMs : 0;
  const mid = h / 2;

  if (peaks && peaks.length && dur > 0) {
    const n = peaks.length;
    const barW = Math.max(1, w / n);
    g.fillStyle = wave;
    for (let i = 0; i < n; i += 1) {
      const amp = Math.max(0.5, peaks[i] * (h / 2 - 4));
      g.fillRect((i / n) * w, mid - amp, Math.max(1, barW - 0.5), amp * 2);
    }
    canvas.dataset.peaks = String(n);
    canvas.dataset.durationMs = String(Math.round(dur));
  }

  g.strokeStyle = border;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, mid + 0.5);
  g.lineTo(w, mid + 0.5);
  g.stroke();

  const sel = item ? item.sel : null;
  if (sel && dur > 0) {
    const sx = msToPx(sel.startMs, dur, w);
    const ex = msToPx(sel.endMs, dur, w);
    g.globalAlpha = 0.18;
    g.fillStyle = primary;
    g.fillRect(sx, 0, Math.max(0, ex - sx), h);
    g.globalAlpha = 1;
    g.fillStyle = primary;
    g.fillRect(Math.max(0, sx - 1), 0, 2, h);
    g.fillRect(Math.min(w - 2, ex - 1), 0, 2, h);
    g.fillRect(Math.max(0, sx - 3), mid - 8, 6, 16);
    g.fillRect(Math.min(w - 6, ex - 3), mid - 8, 6, 16);
  }
}

function syncTimeInputs() {
  const item = currentItem();
  if (!item) return;
  const dur = item.waveDurationMs || Math.round((item.durationSec || 0) * 1000);
  const sel = item.sel || { startMs: 0, endMs: dur };
  state.els.start.value = formatTimeMs(sel.startMs);
  state.els.end.value = formatTimeMs(sel.endMs);
  state.els.clip.textContent = `保留 ${formatDuration((sel.endMs - sel.startMs) / 1000)}`;
}

function commitTime(which) {
  const item = currentItem();
  if (!item) return;
  const dur = item.waveDurationMs || Math.round((item.durationSec || 0) * 1000);
  const input = which === 'start' ? state.els.start : state.els.end;
  const cur = item.sel || { startMs: 0, endMs: dur };
  const ms = parseTimeToMs(input.value);
  if (!Number.isFinite(ms)) {
    input.value = formatTimeMs(which === 'start' ? cur.startMs : cur.endMs);
    state.ctx.setStatus('时间格式看不懂，请用「分:秒.毫秒」，例如 01:23.500');
    return;
  }
  const next = which === 'start' ? { startMs: ms, endMs: cur.endMs } : { startMs: cur.startMs, endMs: ms };
  item.sel = normalizeSelection({ ...next, durationMs: dur });
  syncTimeInputs();
  drawWave();
}

function resetSelection() {
  const item = currentItem();
  if (!item) return;
  const dur = item.waveDurationMs || Math.round((item.durationSec || 0) * 1000);
  item.sel = normalizeSelection({ startMs: 0, endMs: dur, durationMs: dur });
  syncTimeInputs();
  drawWave();
}

const HANDLE_HIT = 8;

function beginDrag(e) {
  const item = currentItem();
  if (!item || !item.peaks || state.busy) return;
  const rect = state.els.canvas.getBoundingClientRect();
  const w = rect.width;
  const dur = item.waveDurationMs || 0;
  if (w <= 0 || dur <= 0) return;
  const x = e.clientX - rect.left;
  const sel = item.sel || { startMs: 0, endMs: dur };
  const sx = msToPx(sel.startMs, dur, w);
  const ex = msToPx(sel.endMs, dur, w);
  let mode = 'new';
  if (Math.abs(x - sx) <= HANDLE_HIT) mode = 'start';
  else if (Math.abs(x - ex) <= HANDLE_HIT) mode = 'end';
  const anchorMs = pxToMs(x, dur, w);
  state.drag = { mode, anchorMs, item };
  if (mode === 'new') item.sel = { startMs: anchorMs, endMs: anchorMs };
  if (e.preventDefault) e.preventDefault();

  const move = (ev) => dragMove(ev);
  const up = () => endDrag();
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  state.dragCleanup = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  drawWave();
}

function dragMove(e) {
  const d = state && state.drag;
  if (!d) return;
  const item = d.item;
  const rect = state.els.canvas.getBoundingClientRect();
  const w = rect.width;
  const dur = item.waveDurationMs || 0;
  const ms = pxToMs(e.clientX - rect.left, dur, w);
  if (d.mode === 'start') item.sel.startMs = Math.min(ms, item.sel.endMs);
  else if (d.mode === 'end') item.sel.endMs = Math.max(ms, item.sel.startMs);
  else {
    item.sel.startMs = Math.min(d.anchorMs, ms);
    item.sel.endMs = Math.max(d.anchorMs, ms);
  }
  syncTimeInputs();
  drawWave();
}

function endDrag() {
  if (!state) return;
  const d = state.drag;
  if (d && d.item) {
    const dur = d.item.waveDurationMs || 0;
    d.item.sel = normalizeSelection({ ...d.item.sel, durationMs: dur });
  }
  state.drag = null;
  if (state.dragCleanup) {
    state.dragCleanup();
    state.dragCleanup = null;
  }
  syncTimeInputs();
  drawWave();
}

// —— 进度 ——

/**
 * 正在跑的 ffmpeg 任务 → 对应任务的进度上报入口（含「拼接」这种整体任务）。
 * 任务跑在队列里（工具页切走/回收也照跑），进度靠这份模块级映射找到对应任务。
 */
const jobReports = new Map();

function onProgress(payload) {
  if (!payload || !payload.jobId) return;
  const entry = jobReports.get(payload.jobId);
  if (!entry) return;
  const raw = typeof payload.percent === 'number' ? payload.percent : 0;
  const percent = Math.round(raw);
  const speed = payload.speed ? `（${payload.speed}）` : '';
  const overall = entry.concat
    ? raw
    : Math.min(100, ((entry.index + raw / 100) / entry.total) * 100);
  const text = entry.concat
    ? `拼接 ${entry.total} 个文件：${percent}%${speed}`
    : `${entry.name}（${entry.index + 1}/${entry.total}）：${percent}%${speed}`;
  entry.report({ percent: overall, text });
  if (state && state.ctx.isActive()) state.ctx.showProgress(text, Math.min(99, overall));
}

// —— 运行 ——

/**
 * 入队执行（任务归属队列，不归属工具页）：队列按 cpu 通道串行跑（ffmpeg 吃满 CPU）。
 * 「拼接」是整体一次操作算一个任务；普通剪辑每张音频算一个任务。
 * 仍 await 全部结束，只是为了保留原有的「跑完汇总 + 按钮变回开始」界面行为。
 */
async function run() {
  const { els } = state;
  const files = state.files;
  const params = readParams();
  const ctx = state.ctx;
  const outputDir = ctx.settings.getSettings().outputDir || undefined;
  let copied = 0; // 走了「极速截取（不重编码）」的文件数

  // —— 拼接：一次把整个列表按顺序合并（截取/滤镜不生效） ——
  if (params.concat) {
    els.result.textContent = '';
    for (const f of files) f.result = null;
    renderList();

    let jobId = null; // 与 onCancel 共享绑定
    let concatResult = null;
    let concatSize = 0;
    const taskId = ctx.tasks.enqueue({
      toolId: 'audio-edit',
      toolName: '音频剪辑',
      label: `拼接 ${files.length} 个文件`,
      lane: 'cpu',
      inputPaths: files.map((f) => f.path),
      outputDir,
      run: async ({ report }) => {
        try {
          const jid = `aedit-concat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          jobId = jid;
          jobReports.set(jid, { report, index: 0, total: 1, name: '', concat: true });
          const durMs = files.reduce((acc, f) => acc + Math.max(1, Math.round((f.waveDurationMs || (f.durationSec || 0) * 1000) || 0)), 0);
          const plan = buildEditPlan(files[0], {
            ...params, concatCount: files.length, segmentDurationsMs: files.map((f) => f.waveDurationMs || (f.durationSec || 0) * 1000), totalDurationMs: durMs
          });
          const res = await convertMediaMulti({
            inputPaths: files.map((f) => f.path),
            outputDir,
            baseName: `${files[0].baseName}-拼接`,
            ext: plan.ext,
            args: plan.args,
            durationMs: plan.durationMs,
            jobId: jid
          });
          if (res && res.ok) {
            concatResult = res.path;
            concatSize = res.size;
            return { ok: true, outputPaths: [res.path], outputDir };
          }
          return { ok: false, error: (res && res.message) || '拼接失败' };
        } catch (err) {
          return { ok: false, error: err.message };
        } finally {
          if (jobId) jobReports.delete(jobId);
          jobId = null;
        }
      },
      onCancel: () => {
        if (!jobId) return;
        try { cancelMediaJob(jobId); } catch { /* 任务可能刚结束，忽略 */ }
      }
    });
    state.taskIds = [taskId];
    const task = await ctx.tasks.waitFor(taskId);

    if (!state) return; // 工具页已被回收：任务照跑完了，这里只跳过界面收尾
    state.taskIds = [];
    ctx.hideProgress();
    if (task && task.status === 'done' && concatResult) {
      ctx.setStatus(`拼接完成：${baseNameOf(concatResult)}（${formatSize(concatSize)}）`);
      els.result.textContent = `输出：${concatResult}`;
      for (const f of files) f.result = { ok: true, text: '已并入拼接输出', path: concatResult };
      renderList();
    } else if (task && task.status === 'canceled') {
      ctx.setStatus('已取消拼接');
    } else {
      const message = (task && task.error) || '拼接失败';
      ctx.setStatus(`拼接失败：${message}`);
      els.result.textContent = `失败原因：${message}`;
    }
    return;
  }

  const total = files.length;
  els.result.textContent = '';
  for (const f of files) f.result = null;
  renderList();

  const jobs = files.map((f, index) => {
    let jobId = null; // 与 onCancel 共享绑定
    return {
      label: f.name,
      inputPaths: [f.path],
      outputDir,
      run: async ({ report, isCancelled }) => {
        const setJobId = (id) => {
          if (jobId) jobReports.delete(jobId);
          jobId = id;
          if (id) jobReports.set(id, { report, index, total, name: f.name, concat: false });
        };
        let res;
        try {
          const jid = `aedit-${Date.now()}-${index + 1}-${Math.random().toString(36).slice(2, 6)}`;
          const durMs = f.waveDurationMs || Math.round((f.durationSec || 0) * 1000);
          const sel = normalizeSelection({ startMs: f.sel ? f.sel.startMs : 0, endMs: f.sel ? f.sel.endMs : durMs, durationMs: durMs });
          const plan = buildEditPlan(
            { ...f, durationMs: durMs },
            { ...params, startMs: sel.startMs, endMs: sel.endMs, concatCount: 0 }
          );
          if (plan.copy) copied += 1;
          setJobId(jid);
          res = await convertMedia({
            inputPath: f.path,
            outputDir,
            baseName: f.baseName,
            ext: plan.ext,
            inputArgs: plan.inputArgs,
            args: plan.args,
            durationMs: plan.durationMs,
            jobId: jid
          });
        } catch (err) {
          res = { ok: false, message: err.message };
        } finally {
          setJobId(null);
        }

        if (isCancelled()) {
          f.result = { ok: false, text: '已取消' };
          if (state) renderList();
          return { canceled: true };
        }
        if (res && res.ok) {
          f.result = { ok: true, text: `→ ${baseNameOf(res.path)}（${formatSize(res.size)}）`, path: res.path };
          if (state) renderList();
          return { ok: true, outputPaths: [res.path], outputDir };
        }
        const message = (res && res.message) || '剪辑失败';
        f.result = { ok: false, text: `✗ ${message}` };
        if (state) renderList();
        return { ok: false, error: message };
      },
      onCancel: () => {
        if (!jobId) return;
        try { cancelMediaJob(jobId); } catch { /* 任务可能刚结束，忽略 */ }
      }
    };
  });

  const ids = jobs.map((job) => ctx.tasks.enqueue({
    toolId: 'audio-edit',
    toolName: '音频剪辑',
    lane: 'cpu',
    ...job
  }));
  state.taskIds = ids;
  const settled = await Promise.all(ids.map((id) => ctx.tasks.waitFor(id)));

  if (!state) return; // 工具页已被回收：任务照跑完了，这里只跳过界面收尾
  state.taskIds = [];
  ctx.hideProgress();
  const done = settled.filter((t) => t && t.status === 'done').length;
  const failed = settled.filter((t) => t && t.status === 'failed').length;
  const canceledCount = settled.filter((t) => t && t.status === 'canceled').length;
  const failedTask = settled.find((t) => t && t.status === 'failed');
  const lastError = (failedTask && failedTask.error) || '';
  const doneTask = [...settled].reverse().find((t) => t && t.status === 'done' && t.output.paths.length);
  const lastPath = doneTask ? doneTask.output.paths[0] : '';

  const copyNote = copied > 0 ? `，其中 ${copied} 个为极速截取` : '';
  if (canceledCount > 0) {
    ctx.setStatus(`已取消：成功 ${done} 个，失败 ${failed} 个`);
  } else {
    ctx.setStatus(`剪辑完成：成功 ${done} 个${copyNote}${failed ? `，失败 ${failed} 个（${lastError}）` : ''}`);
  }
  if (lastPath) els.result.textContent = `输出：${lastPath}`;
  else if (failed) els.result.textContent = `失败原因：${lastError}`;
}

async function onRunClick() {
  // await 期间本页可能被 LRU 回收（unmount 把 state 置空）：全程用局部 st，界面收尾前再核对
  const st = state;
  if (st.busy) {
    // 运行中：点击＝取消（取消本工具入队的任务；队列会让 ffmpeg 进程树结束）
    st.cancelRequested = true;
    for (const id of st.taskIds) st.ctx.tasks.cancel(id);
    st.ctx.setStatus('正在取消…');
    return;
  }
  if (!st.ffmpeg || !st.ffmpeg.found) {
    st.ctx.setStatus('未检测到 ffmpeg：把加装包解压到软件目录的 addons/ffmpeg 后重开本工具');
    return;
  }
  if (st.files.length === 0) {
    st.ctx.setStatus('请先添加音频或视频');
    return;
  }
  if (st.els.concat.checked && st.files.length < 2) {
    st.ctx.setStatus('拼接至少需要 2 个文件：请再添加一个');
    return;
  }

  st.busy = true;
  st.cancelRequested = false;
  st.taskIds = [];
  updateRunButton();
  try {
    await run();
  } catch (err) {
    st.ctx.hideProgress();
    st.ctx.setStatus(`处理失败：${err.message}`);
    console.error('[audio-edit] 处理失败', err);
  } finally {
    if (state === st) {
      st.busy = false;
      st.cancelRequested = false;
      st.taskIds = [];
      updateRunButton();
    }
  }
}

function clearAll() {
  if (state.busy) return;
  state.files = [];
  state.selectedIndex = -1;
  state.waveToken += 1;
  state.els.wave.hidden = true;
  state.els.result.textContent = '';
  renderList();
  state.ctx.setStatus('已清空列表');
}

// —— 生命周期 ——

export function mount(container, ctx) {
  state = {
    container,
    ctx,
    els: null,
    listeners: [],
    files: [],
    selectedIndex: -1,
    busy: false,
    cancelRequested: false,
    taskIds: [],
    ffmpeg: null,
    unsubProgress: null,
    waveToken: 0,
    drag: null,
    dragCleanup: null
  };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.aedit-tool'),
    targetSel: container.querySelector('#aeditTarget'),
    qualitySel: container.querySelector('#aeditQuality'),
    losslessNote: container.querySelector('#aeditLosslessNote'),
    gainSel: container.querySelector('#aeditGain'),
    fadeInSel: container.querySelector('#aeditFadeIn'),
    fadeOutSel: container.querySelector('#aeditFadeOut'),
    concat: container.querySelector('#aeditConcat'),
    modeNote: container.querySelector('#aeditModeNote'),
    ffmpegNote: container.querySelector('#aeditFfmpegNote'),
    drop: container.querySelector('#aeditDrop'),
    addBtn: container.querySelector('#aeditAddBtn'),
    listWrap: container.querySelector('#aeditListWrap'),
    list: container.querySelector('#aeditList'),
    listCount: container.querySelector('#aeditListCount'),
    addMore: container.querySelector('#aeditAddMore'),
    wave: container.querySelector('#aeditWave'),
    waveName: container.querySelector('#aeditWaveName'),
    canvas: container.querySelector('#aeditCanvas'),
    start: container.querySelector('#aeditStart'),
    end: container.querySelector('#aeditEnd'),
    clip: container.querySelector('#aeditClip'),
    resetSel: container.querySelector('#aeditResetSel'),
    waveNote: container.querySelector('#aeditWaveNote'),
    runBtn: container.querySelector('#aeditRunBtn'),
    clearBtn: container.querySelector('#aeditClearBtn'),
    result: container.querySelector('#aeditResult')
  };
  state.els = els;

  fillTargets(els.targetSel);
  fillQuality(els.qualitySel);
  fillPresets(els.gainSel, AUDIO_GAIN_PRESETS);
  fillPresets(els.fadeInSel, AUDIO_FADE_PRESETS);
  fillPresets(els.fadeOutSel, AUDIO_FADE_PRESETS);
  els.targetSel.value = 'mp3';
  els.qualitySel.value = 'standard';
  els.gainSel.value = '0';
  els.fadeInSel.value = '0';
  els.fadeOutSel.value = '0';
  updateQualityState();

  on(els.targetSel, 'change', updateQualityState);
  on(els.concat, 'change', updateModeNote);
  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', onRunClick);
  on(els.clearBtn, 'click', clearAll);
  on(els.resetSel, 'click', resetSelection);
  on(els.start, 'change', () => commitTime('start'));
  on(els.end, 'change', () => commitTime('end'));
  on(els.canvas, 'mousedown', beginDrag);
  on(window, 'resize', () => { if (state && !els.wave.hidden) drawWave(); });
  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);

  state.unsubProgress = onMediaProgress(onProgress);

  renderFfmpegNote();
  updateModeNote();
  renderList();
  updateRunButton();
  ctx.setStatus('音频剪辑：添加音频（或视频）→ 在波形上拖动选片段 → 点「开始剪辑」');
  ctx.setInfo({});

  refreshFfmpeg();
}

export function unmount() {
  if (!state) return;
  // 进度订阅必须取消，避免切换工具后仍更新已销毁的界面
  if (state.unsubProgress) {
    try { state.unsubProgress(); } catch { /* 忽略 */ }
  }
  // 硬契约：任务归属队列，不归属工具页 —— 切走（含 LRU 回收）**不取消**在跑的任务。
  // 波形拖动的 window 监听（进行中才存在）
  if (state.dragCleanup) {
    try { state.dragCleanup(); } catch { /* 忽略 */ }
  }
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  state = null;
}
