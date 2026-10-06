// 工具：视频格式转换 —— 界面与交互
// 分层：本文件只做界面与流程编排；参数拼装与文案在 core/plan.js，
//       编码能力复用 shared/ffmpeg.js（convertMedia / probeMedia / cancelMediaJob / onMediaProgress）。
import {
  VIDEO_TARGETS, RESOLUTION_PRESETS, QUALITY_PRESETS,
  convertMedia, ffmpegStatus, probeMedia, cancelMediaJob, onMediaProgress
} from '../../shared/ffmpeg.js';
import { VIDEO_EXTS, buildPlan, formatSize, formatMeta, baseNameOf } from './core/plan.js';

const MARKUP = `
  <div class="vc-tool">
    <section class="card vc-controls">
      <div class="vc-params">
        <div class="vc-param">
          <label class="control-label" for="vcTarget">输出格式:</label>
          <select class="select" id="vcTarget"></select>
        </div>
        <div class="vc-param">
          <label class="control-label" for="vcRes">分辨率:</label>
          <select class="select" id="vcRes"></select>
        </div>
        <div class="vc-param">
          <label class="control-label" for="vcQuality">质量:</label>
          <select class="select" id="vcQuality"></select>
        </div>
        <label class="vc-check">
          <input type="checkbox" id="vcMute" />
          <span>去掉声音</span>
        </label>
      </div>
      <div class="vc-note" id="vcFfmpegNote">正在检测 ffmpeg…</div>
    </section>

    <main class="card vc-files" id="vcFiles">
      <div class="vc-drop" id="vcDrop">
        <button class="btn btn-primary btn-lg" data-add="1" id="vcAddBtn">添加视频</button>
        <div class="vc-drop-hint">也可以把视频或文件夹直接拖进窗口；支持多选</div>
      </div>
      <div class="vc-list-wrap" id="vcListWrap" hidden>
        <div class="vc-list-head">
          <span id="vcListTitle">视频</span>
          <span class="vc-spacer"></span>
          <span id="vcListCount"></span>
          <button class="btn btn-ghost" data-add="1" id="vcAddMore" type="button">＋ 继续添加</button>
        </div>
        <ul class="vc-list" id="vcList"></ul>
      </div>
    </main>

    <footer class="vc-actions">
      <button class="btn btn-primary vc-run" data-run="1" id="vcRunBtn">开始转换</button>
      <button class="btn btn-plain" data-clear="1" id="vcClearBtn">清空</button>
      <div class="vc-result" id="vcResult"></div>
    </footer>
  </div>
`;

let state = null;

function on(el, type, handler) {
  el.addEventListener(type, handler);
  state.listeners.push([el, type, handler]);
}

function fillOptions(select, items) {
  select.innerHTML = '';
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = String(it.value);
    opt.textContent = it.label;
    select.appendChild(opt);
  }
}

// —— ffmpeg 加装包状态 ——

function renderFfmpegNote() {
  const note = state.els.ffmpegNote;
  if (!state.ffmpeg) {
    note.className = 'vc-note';
    note.textContent = '正在检测 ffmpeg…';
    return;
  }
  if (state.ffmpeg.found) {
    const where = state.ffmpeg.where === 'addon' ? '加装包' : '系统安装';
    note.className = 'vc-note is-ok';
    note.textContent = `✓ 已检测到 ffmpeg ${state.ffmpeg.version || ''}（${where}）`.replace(/\s+/g, ' ').trim();
  } else {
    note.className = 'vc-note is-warn';
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
    li.className = 'vc-item';

    const main = document.createElement('div');
    main.className = 'vc-item-main';

    const name = document.createElement('div');
    name.className = 'vc-item-name';
    name.textContent = f.name;
    name.title = f.path;
    main.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'vc-item-meta';
    meta.textContent = f.meta || '';
    main.appendChild(meta);

    if (f.result) {
      const result = document.createElement('div');
      result.className = 'vc-item-result' + (f.result.ok ? ' is-ok' : ' is-fail') + (f.result.busy ? ' is-busy' : '');
      result.textContent = f.result.text;
      result.title = f.result.text;
      main.appendChild(result);
    }

    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'vc-item-actions';
    const del = document.createElement('button');
    del.className = 'vc-icon-btn';
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

// —— 添加视频 ——

/** 探测并加入列表；返回失败原因（成功返回空串） */
async function addOne(filePath, extInfo) {
  if (state.files.some((f) => f.path === filePath)) return '已在列表中';
  const info = extInfo || await state.ctx.pathInfo(filePath);
  const ext = (info.ext || '').toLowerCase();
  if (!VIDEO_EXTS.includes(ext)) return '不是支持的视频格式';
  const probe = await probeMedia(filePath);
  if (!probe || !probe.ok) return (probe && probe.message) || '无法识别该文件';
  state.files.push({
    path: filePath,
    name: info.name,
    baseName: info.baseName,
    dir: info.dir,
    ext,
    width: probe.width,
    height: probe.height,
    durationSec: probe.durationSec,
    hasAudio: probe.hasAudio,
    videoCodec: probe.videoCodec,
    meta: formatMeta(probe),
    result: null
  });
  return '';
}

async function addFromPaths(paths) {
  const failures = [];
  let added = 0;

  for (const p of paths) {
    try {
      const info = await state.ctx.pathInfo(p);
      if (info.isDirectory) {
        const list = await state.ctx.listFiles(p, VIDEO_EXTS);
        if (list.length === 0) { failures.push(`${info.name}：文件夹里没有支持的视频`); continue; }
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
    state.ctx.setStatus(`已添加 ${added} 个视频${failures.length ? `，${failures.length} 项跳过` : ''}`);
  } else {
    state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的视频');
  }
  if (failures.length > 1) console.warn('[video-convert] 部分文件未添加：\n' + failures.join('\n'));
}

async function openDialog() {
  const paths = await state.ctx.openVideos();
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
  const { els } = state;
  return {
    target: els.targetSel.value,
    height: parseInt(els.resSel.value, 10) || 0,
    quality: els.qualitySel.value,
    mute: els.muteBox.checked
  };
}

function updateRunButton() {
  const { els } = state;
  els.runBtn.textContent = state.busy ? '取消' : '开始转换';
  const ffmpegOk = !!(state.ffmpeg && state.ffmpeg.found);
  // 运行中按钮变「取消」且始终可点；未检测到 ffmpeg 时禁用运行
  els.runBtn.disabled = !state.busy && !ffmpegOk;
}

// —— 进度 ——

/**
 * 正在跑的 ffmpeg 任务 → 对应任务的进度上报入口。
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
  const text = `${entry.name}（${entry.index + 1}/${entry.total}）：${percent}%${speed}`;
  const overall = Math.min(100, ((entry.index + raw / 100) / entry.total) * 100);
  entry.report({ percent: overall, text });
  if (state && state.ctx.isActive()) state.ctx.showProgress(text, Math.min(99, overall));
}

// —— 运行 ——

/**
 * 把这一批视频入队执行（任务归属队列，不归属工具页）：队列按 cpu 通道串行跑（ffmpeg 吃满 CPU）。
 * 仍 await 全部结束，只是为了保留原有的「跑完汇总 + 按钮变回开始」界面行为。
 */
async function run() {
  const { els } = state;
  const files = state.files;
  const total = files.length;
  const params = readParams();
  const ctx = state.ctx;
  const outputDir = ctx.settings.getSettings().outputDir || undefined;

  els.result.textContent = '';
  for (const f of files) f.result = null;
  renderList();

  const jobs = files.map((f, index) => {
    let jobId = null; // 与 onCancel 共享绑定：取消时才能杀掉这条任务对应的 ffmpeg 进程
    return {
      label: f.name,
      inputPaths: [f.path],
      outputDir,
      run: async ({ report, isCancelled }) => {
        const setJobId = (id) => {
          if (jobId) jobReports.delete(jobId);
          jobId = id;
          if (id) jobReports.set(id, { report, index, total, name: f.name });
        };
        let res;
        try {
          const plan = buildPlan(f, params);
          const jid = `vc-${Date.now()}-${index + 1}-${Math.random().toString(36).slice(2, 6)}`;
          setJobId(jid);
          res = await convertMedia({
            inputPath: f.path,
            outputDir,
            baseName: f.baseName,
            ext: plan.ext,
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
        const message = (res && res.message) || '转换失败';
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
    toolId: 'video-convert',
    toolName: '视频格式转换',
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

  if (canceledCount > 0) {
    ctx.setStatus(`已取消：成功 ${done} 个，失败 ${failed} 个`);
  } else {
    ctx.setStatus(`转换完成：成功 ${done} 个${failed ? `，失败 ${failed} 个（${lastError}）` : ''}`);
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
    st.ctx.setStatus('请先添加视频');
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
    console.error('[video-convert] 处理失败', err);
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
  state.els.result.textContent = '';
  renderList();
  state.ctx.setStatus('已清空视频列表');
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
    taskIds: [],
    ffmpeg: null,
    unsubProgress: null
  };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.vc-tool'),
    targetSel: container.querySelector('#vcTarget'),
    resSel: container.querySelector('#vcRes'),
    qualitySel: container.querySelector('#vcQuality'),
    muteBox: container.querySelector('#vcMute'),
    ffmpegNote: container.querySelector('#vcFfmpegNote'),
    drop: container.querySelector('#vcDrop'),
    addBtn: container.querySelector('#vcAddBtn'),
    listWrap: container.querySelector('#vcListWrap'),
    list: container.querySelector('#vcList'),
    listCount: container.querySelector('#vcListCount'),
    addMore: container.querySelector('#vcAddMore'),
    runBtn: container.querySelector('#vcRunBtn'),
    clearBtn: container.querySelector('#vcClearBtn'),
    result: container.querySelector('#vcResult')
  };
  state.els = els;

  fillOptions(els.targetSel, VIDEO_TARGETS.map((t) => ({ value: t.value, label: t.label })));
  fillOptions(els.resSel, RESOLUTION_PRESETS.map((r) => ({ value: r.value, label: r.label })));
  fillOptions(els.qualitySel, Object.keys(QUALITY_PRESETS).map((k) => ({ value: k, label: QUALITY_PRESETS[k].label })));
  els.targetSel.value = 'mp4';
  els.resSel.value = '0';
  els.qualitySel.value = 'standard';

  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', onRunClick);
  on(els.clearBtn, 'click', clearAll);
  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);

  state.unsubProgress = onMediaProgress(onProgress);

  renderFfmpegNote();
  renderList();
  updateRunButton();
  ctx.setStatus('视频格式转换：添加视频 → 选输出格式/分辨率/质量 → 点「开始转换」');
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
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  state = null;
}