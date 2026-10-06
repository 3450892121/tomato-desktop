// 工具：语音转文字 —— 界面与交互
// 分层：本文件只做界面与流程编排；SRT→文本推导与文案在 core/plan.js，
//       识别与保存复用 shared/asr.js（transcribeFile / saveTranscribeOutputs / cancelTranscribe / onTranscribeProgress）。
import {
  transcribeFile, saveTranscribeOutputs, asrStatus, cancelTranscribe, onTranscribeProgress
} from '../../shared/asr.js';
import { probeMedia } from '../../shared/ffmpeg.js';
import {
  INPUT_EXTS, OUTPUT_MODES, buildOutputs, countChars,
  formatMeta, baseNameOf
} from './core/plan.js';

const MARKUP = `
  <div class="tr-tool">
    <section class="card tr-controls">
      <div class="tr-params">
        <div class="tr-param">
          <label class="control-label" for="trMode">输出内容:</label>
          <select class="select" id="trMode"></select>
        </div>
      </div>
      <div class="tr-note" id="trNote">正在检测语音识别引擎…</div>
    </section>

    <main class="card tr-files" id="trFiles">
      <div class="tr-drop" id="trDrop">
        <button class="btn btn-primary btn-lg" data-add="1" id="trAddBtn">添加音频或视频</button>
        <div class="tr-drop-hint">也可以把音频/视频直接拖进窗口；支持多选，视频会自动提取声音</div>
      </div>
      <div class="tr-list-wrap" id="trListWrap" hidden>
        <div class="tr-list-head">
          <span id="trListTitle">待识别文件</span>
          <span class="tr-spacer"></span>
          <span id="trListCount"></span>
          <button class="btn btn-ghost" data-add="1" id="trAddMore" type="button">＋ 继续添加</button>
        </div>
        <ul class="tr-list" id="trList"></ul>
      </div>
    </main>

    <footer class="tr-actions">
      <button class="btn btn-primary tr-run" data-run="1" id="trRunBtn">开始识别</button>
      <button class="btn btn-plain" data-clear="1" id="trClearBtn">清空</button>
      <div class="tr-result" id="trResult"></div>
    </footer>
  </div>
`;

let state = null;

function on(el, type, handler) {
  el.addEventListener(type, handler);
  state.listeners.push([el, type, handler]);
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** 输出内容下拉（纯文本 / 字幕 / 文本+字幕） */
function fillModes(select) {
  select.innerHTML = '';
  for (const m of OUTPUT_MODES) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    select.appendChild(opt);
  }
}

// —— 加装包状态 ——

function renderNote() {
  const note = state.els.note;
  if (!state.asr) {
    note.className = 'tr-note';
    note.textContent = '正在检测语音识别引擎…';
    return;
  }
  if (!state.asr.found) {
    note.className = 'tr-note is-warn';
    note.textContent = '未检测到语音识别加装包：把 addons/asr 放回软件目录后重开本工具即可。';
    return;
  }
  if (!state.asr.ffmpeg) {
    note.className = 'tr-note is-warn';
    note.textContent = '未检测到 ffmpeg：识别前需要它处理音频，把加装包解压到软件目录的 addons/ffmpeg 后重开本工具。';
    return;
  }
  note.className = 'tr-note is-ok';
  note.textContent = '✓ 语音识别引擎已就绪（FunASR · SenseVoice，纯离线运行，不联网）';
}

async function refreshAsrStatus() {
  try {
    state.asr = await asrStatus();
  } catch {
    state.asr = { found: false, ffmpeg: false };
  }
  if (!state) return;
  renderNote();
  updateRunButton();
}

// —— 文件列表 ——

function renderList() {
  const { els } = state;
  const files = state.files;
  els.listWrap.hidden = files.length === 0;
  els.drop.hidden = files.length > 0;
  els.listCount.textContent = files.length ? `共 ${files.length} 个` : '';
  els.list.innerHTML = '';

  files.forEach((f, index) => {
    const li = document.createElement('li');
    li.className = 'tr-item';

    const main = document.createElement('div');
    main.className = 'tr-item-main';

    const name = document.createElement('div');
    name.className = 'tr-item-name';
    name.textContent = f.name;
    name.title = f.path;
    main.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'tr-item-meta';
    meta.textContent = f.meta || '';
    main.appendChild(meta);

    if (f.result) {
      const result = document.createElement('div');
      result.className = 'tr-item-result' + (f.result.ok ? ' is-ok' : ' is-fail');
      result.textContent = f.result.text;
      result.title = f.result.text;
      main.appendChild(result);
    }

    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'tr-item-actions';
    const del = document.createElement('button');
    del.className = 'tr-icon-btn';
    del.textContent = '×';
    del.title = '移除';
    del.disabled = state.busy;
    del.addEventListener('click', () => {
      if (state.busy) return;
      files.splice(index, 1);
      renderList();
    });
    actions.appendChild(del);
    li.appendChild(actions);

    els.list.appendChild(li);
  });
  updateRunButton();
}

// —— 添加文件 ——

/** 探测并加入列表；返回失败原因（成功返回空串） */
async function addOne(filePath, extInfo) {
  if (state.files.some((f) => f.path === filePath)) return '已在列表中';
  const info = extInfo || await state.ctx.pathInfo(filePath);
  const ext = (info.ext || '').toLowerCase();
  if (!INPUT_EXTS.includes(ext)) return '不是支持的音频/视频格式';
  const probe = await probeMedia(filePath);
  if (!probe || !probe.ok) return (probe && probe.message) || '无法识别该文件';
  if (!probe.hasAudio) return '这个文件没有声音，无法识别';
  const item = {
    path: filePath,
    name: info.name,
    baseName: info.baseName,
    dir: info.dir,
    ext,
    isVideo: !AUDIO_ONLY.includes(ext),
    durationSec: probe.durationSec,
    format: probe.format,
    size: Number.isFinite(info.size) ? info.size : 0,
    result: null
  };
  item.meta = formatMeta(item);
  state.files.push(item);
  return '';
}

/** 纯音频扩展名（其余按视频处理：需要提取音轨） */
const AUDIO_ONLY = [
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wma', '.amr',
  '.aiff', '.aif', '.ape', '.dsf', '.mpc', '.tak', '.wv', '.tta', '.ac3', '.eac3',
  '.mp2', '.spx', '.caf', '.au', '.w64', '.ra', '.rm', '.oma'
];

async function addFromPaths(paths) {
  const failures = [];
  let added = 0;

  for (const p of paths) {
    try {
      const info = await state.ctx.pathInfo(p);
      if (info.isDirectory) {
        const list = await state.ctx.listFiles(p, INPUT_EXTS);
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

  renderList();
  if (added > 0) {
    state.ctx.setStatus(`已添加 ${added} 个文件${failures.length ? `，${failures.length} 项跳过` : ''}`);
  } else {
    state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的音频或视频');
  }
  if (failures.length > 1) console.warn('[transcribe] 部分文件未添加：\n' + failures.join('\n'));
}

async function openDialog() {
  const paths = await state.ctx.openSpeech();
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

// —— 参数与按钮 ——

function readParams() {
  return { mode: state.els.modeSel.value };
}

function updateRunButton() {
  const { els } = state;
  els.runBtn.textContent = state.busy ? '取消' : '开始识别';
  const ready = !!(state.asr && state.asr.found && state.asr.ffmpeg);
  // 运行中按钮变「取消」且始终可点；引擎没就绪时禁用运行
  els.runBtn.disabled = !state.busy && !ready;
}

// —— 进度 ——

function onProgress(payload) {
  if (!state || !payload) return;
  if (!state.currentJobId || payload.jobId !== state.currentJobId) return;
  const total = state.total || 1;
  const index = state.currentIndex || 0;
  const who = state.files[index];
  const percent = Math.round(payload.percent || 0);
  const overall = Math.min(99, ((index + (payload.percent || 0) / 100) / total) * 100);
  state.ctx.showProgress(
    `${who ? `${who.name}（${index + 1}/${total}）：` : ''}${payload.phase || '识别中'} ${percent}%`,
    overall
  );
}

// —— 运行 ——

async function run() {
  const { els } = state;
  const files = state.files;
  const total = files.length;
  const params = readParams();
  const outputDir = state.ctx.settings.getSettings().outputDir || '';
  const stamp = Date.now();
  let done = 0;
  let failed = 0;
  let lastPath = '';
  let lastError = '';

  state.total = total;
  els.result.textContent = '';
  for (const f of files) f.result = null;
  renderList();

  for (let i = 0; i < total; i++) {
    if (state.cancelRequested) break;
    const f = files[i];
    state.currentIndex = i;
    const jobId = `tr-${stamp}-${i + 1}`;
    state.currentJobId = jobId;
    state.ctx.showProgress(`${f.name}（${i + 1}/${total}）：准备中`, (i / total) * 100);
    await nextFrame();

    let res;
    try {
      res = await transcribeFile({ inputPath: f.path, jobId });
    } catch (err) {
      res = { ok: false, message: err.message };
    }
    state.currentJobId = null;

    if (state.cancelRequested) {
      f.result = { ok: false, text: '已取消' };
      renderList();
      break;
    }

    if (res && res.ok) {
      const outputs = buildOutputs(res.srtText, params.mode);
      const txt = outputs.find((o) => o.ext === '.txt');
      let saved = null;
      try {
        saved = await saveTranscribeOutputs({
          targetDir: outputDir || f.dir,
          baseName: f.baseName,
          files: outputs
        });
      } catch (err) {
        saved = { ok: false, message: err.message };
      }
      if (saved && saved.ok) {
        done += 1;
        lastPath = saved.paths[0];
        const chars = txt ? countChars(txt.text) : countChars(res.srtText);
        f.result = { ok: true, text: `→ ${saved.paths.map(baseNameOf).join(' + ')}（${chars} 字）`, path: saved.paths[0] };
      } else {
        failed += 1;
        lastError = (saved && saved.message) || '保存失败';
        f.result = { ok: false, text: `✗ ${lastError}` };
      }
    } else {
      failed += 1;
      lastError = (res && res.message) || '识别失败';
      f.result = { ok: false, text: `✗ ${lastError}` };
    }
    renderList();
  }

  state.currentJobId = null;
  state.total = 0;
  state.ctx.hideProgress();
  if (state.cancelRequested) {
    state.ctx.setStatus(`已取消：成功 ${done} 个，失败 ${failed} 个`);
  } else {
    state.ctx.setStatus(`识别完成：成功 ${done} 个${failed ? `，失败 ${failed} 个（${lastError}）` : ''}`);
  }
  if (lastPath) els.result.textContent = `输出：${lastPath}`;
  else if (failed) els.result.textContent = `失败原因：${lastError}`;
}

async function onRunClick() {
  // await 期间本页可能被 LRU 回收（unmount 把 state 置空）：全程用局部 st，界面收尾前再核对
  const st = state;
  if (st.busy) {
    // 运行中：点击＝取消（结束识别进程并停止队列）
    st.cancelRequested = true;
    const jobId = st.currentJobId;
    if (jobId) {
      try { await cancelTranscribe(jobId); } catch { /* 任务可能刚结束，忽略 */ }
    }
    st.ctx.setStatus('正在取消…');
    return;
  }
  if (!st.asr || !st.asr.found) {
    st.ctx.setStatus('未检测到语音识别加装包：把 addons/asr 放回软件目录后重开本工具');
    return;
  }
  if (!st.asr.ffmpeg) {
    st.ctx.setStatus('未检测到 ffmpeg：把加装包解压到软件目录的 addons/ffmpeg 后重开本工具');
    return;
  }
  if (st.files.length === 0) {
    st.ctx.setStatus('请先添加音频或视频');
    return;
  }

  st.busy = true;
  st.cancelRequested = false;
  updateRunButton();
  try {
    await run();
  } catch (err) {
    st.ctx.hideProgress();
    st.ctx.setStatus(`处理失败：${err.message}`);
    console.error('[transcribe] 处理失败', err);
  } finally {
    if (state === st) {
      st.busy = false;
      st.cancelRequested = false;
      st.currentJobId = null;
      updateRunButton();
    }
  }
}

function clearAll() {
  if (state.busy) return;
  state.files = [];
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
    busy: false,
    cancelRequested: false,
    currentJobId: null,
    currentIndex: 0,
    total: 0,
    asr: null,
    unsubProgress: null
  };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.tr-tool'),
    modeSel: container.querySelector('#trMode'),
    note: container.querySelector('#trNote'),
    drop: container.querySelector('#trDrop'),
    addBtn: container.querySelector('#trAddBtn'),
    listWrap: container.querySelector('#trListWrap'),
    list: container.querySelector('#trList'),
    listCount: container.querySelector('#trListCount'),
    addMore: container.querySelector('#trAddMore'),
    runBtn: container.querySelector('#trRunBtn'),
    clearBtn: container.querySelector('#trClearBtn'),
    result: container.querySelector('#trResult')
  };
  state.els = els;

  fillModes(els.modeSel);
  els.modeSel.value = 'txt';

  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', onRunClick);
  on(els.clearBtn, 'click', clearAll);
  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);

  state.unsubProgress = onTranscribeProgress(onProgress);

  renderNote();
  renderList();
  updateRunButton();
  ctx.setStatus('语音转文字：添加音频或视频 → 选输出内容 → 点「开始识别」');
  ctx.setInfo({});

  refreshAsrStatus();
}

export function unmount() {
  if (!state) return;
  // 进度订阅必须取消，避免切换工具后仍更新已销毁的界面
  if (state.unsubProgress) {
    try { state.unsubProgress(); } catch { /* 忽略 */ }
  }
  // 切走时不遗留后台识别进程
  if (state.busy && state.currentJobId) {
    try { cancelTranscribe(state.currentJobId); } catch { /* 忽略 */ }
  }
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  state = null;
}