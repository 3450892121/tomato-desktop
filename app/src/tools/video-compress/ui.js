// 工具：视频压缩 —— 界面与交互
// 分层：本文件只做界面与流程编排；参数拼装与文案在 core/plan.js，
//       编码能力复用 shared/ffmpeg.js（convertMedia / convertMediaTwoPass / probeMedia / cancelMediaJob / onMediaProgress）。
import {
  SIZE_TARGETS, COMPRESS_AUDIO_KBPS, RESOLUTION_PRESETS, QUALITY_PRESETS,
  convertMedia, convertMediaTwoPass, ffmpegStatus, probeMedia, cancelMediaJob, onMediaProgress
} from '../../shared/ffmpeg.js';
import { VIDEO_EXTS, buildPlan, verifyTarget, retryBitrate, formatSize, formatMeta, baseNameOf } from './core/plan.js';

const MARKUP = `
  <div class="vcomp-tool">
    <section class="card vcomp-controls">
      <div class="vcomp-row">
        <label class="control-label" for="vcompMode">压缩方式:</label>
        <select class="select" id="vcompMode">
          <option value="quality">画质档（尽量保清晰）</option>
          <option value="size">目标体积（压到指定大小以内）</option>
        </select>
      </div>
      <div class="vcomp-params" id="vcompQualityParams">
        <div class="vcomp-param">
          <label class="control-label" for="vcompQuality">画质:</label>
          <select class="select" id="vcompQuality"></select>
        </div>
        <div class="vcomp-param">
          <label class="control-label" for="vcompRes">分辨率:</label>
          <select class="select" id="vcompRes"></select>
        </div>
        <label class="vcomp-check">
          <input type="checkbox" id="vcompMute" />
          <span>去掉声音</span>
        </label>
      </div>
      <div class="vcomp-params" id="vcompSizeParams" hidden>
        <div class="vcomp-param">
          <label class="control-label" for="vcompTargetMB">目标大小:</label>
          <select class="select" id="vcompTargetMB"></select>
        </div>
        <div class="vcomp-param">
          <label class="control-label" for="vcompAudio">音频:</label>
          <select class="select" id="vcompAudio"></select>
        </div>
      </div>
      <div class="vcomp-note" id="vcompFfmpegNote">正在检测 ffmpeg…</div>
    </section>

    <main class="card vcomp-files" id="vcompFiles">
      <div class="vcomp-drop" id="vcompDrop">
        <button class="btn btn-primary btn-lg" data-add="1" id="vcompAddBtn">添加视频</button>
        <div class="vcomp-drop-hint">也可以把视频或文件夹直接拖进窗口；支持多选</div>
      </div>
      <div class="vcomp-list-wrap" id="vcompListWrap" hidden>
        <div class="vcomp-list-head">
          <span id="vcompListTitle">视频</span>
          <span class="vcomp-spacer"></span>
          <span id="vcompListCount"></span>
          <button class="btn btn-ghost" data-add="1" id="vcompAddMore" type="button">＋ 继续添加</button>
        </div>
        <ul class="vcomp-list" id="vcompList"></ul>
      </div>
    </main>

    <footer class="vcomp-actions">
      <button class="btn btn-primary vcomp-run" data-run="1" id="vcompRunBtn">开始压缩</button>
      <button class="btn btn-plain" data-clear="1" id="vcompClearBtn">清空</button>
      <div class="vcomp-result" id="vcompResult"></div>
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
    note.className = 'vcomp-note';
    note.textContent = '正在检测 ffmpeg…';
    return;
  }
  if (state.ffmpeg.found) {
    const where = state.ffmpeg.where === 'addon' ? '加装包' : '系统安装';
    note.className = 'vcomp-note is-ok';
    note.textContent = `✓ 已检测到 ffmpeg ${state.ffmpeg.version || ''}（${where}）`.replace(/\s+/g, ' ').trim();
  } else {
    note.className = 'vcomp-note is-warn';
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
    li.className = 'vcomp-item';

    const main = document.createElement('div');
    main.className = 'vcomp-item-main';

    const name = document.createElement('div');
    name.className = 'vcomp-item-name';
    name.textContent = f.name;
    name.title = f.path;
    main.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'vcomp-item-meta';
    meta.textContent = f.meta || '';
    main.appendChild(meta);

    if (f.result) {
      const result = document.createElement('div');
      result.className = 'vcomp-item-result' + (f.result.ok ? ' is-ok' : ' is-fail');
      result.textContent = f.result.text;
      result.title = f.result.text;
      main.appendChild(result);
    }

    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'vcomp-item-actions';
    const del = document.createElement('button');
    del.className = 'vcomp-icon-btn';
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
  if (failures.length > 1) console.warn('[video-compress] 部分文件未添加：\n' + failures.join('\n'));
}

async function openDialog() {
  // 用本工具专用对话框：测试模式下只取「测试压缩视频*」夹具，不会把别的测试留下的产物也选进来
  const paths = await state.ctx.openVideosCompress();
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
  const mode = els.modeSel.value;
  if (mode === 'size') {
    return {
      mode: 'size',
      targetMB: parseInt(els.targetMBSel.value, 10) || 10,
      audioKbps: parseInt(els.audioSel.value, 10) || 0
    };
  }
  return {
    mode: 'quality',
    quality: els.qualitySel.value,
    height: parseInt(els.resSel.value, 10) || 0,
    mute: els.muteBox.checked
  };
}

function updateModeView() {
  const { els } = state;
  const qualityMode = els.modeSel.value !== 'size';
  els.qualityParams.hidden = !qualityMode;
  els.sizeParams.hidden = qualityMode;
}

function updateRunButton() {
  const { els } = state;
  els.runBtn.textContent = state.busy ? '取消' : '开始压缩';
  const ffmpegOk = !!(state.ffmpeg && state.ffmpeg.found);
  // 运行中按钮变「取消」且始终可点；未检测到 ffmpeg 时禁用运行
  els.runBtn.disabled = !state.busy && !ffmpegOk;
}

// —— 进度 ——

/**
 * 正在跑的 ffmpeg 任务 → 对应的进度上报入口与位置信息。
 * 任务跑在队列里（工具页被切走/回收也照跑），进度必须能找到对应任务才能上报；
 * 这份映射是模块级的，工具页被回收重挂后不丢。
 */
const jobReports = new Map();

function onProgress(payload) {
  if (!payload || !payload.jobId) return;
  const entry = jobReports.get(payload.jobId);
  if (!entry) return;
  const percent = typeof payload.percent === 'number' ? payload.percent : 0;
  const speed = payload.speed ? `（${payload.speed}）` : '';
  const retry = entry.retry > 0 ? `· 第 ${entry.retry + 1} 轮` : '';
  const text = `${entry.name}（${entry.index + 1}/${entry.total}）：${Math.round(percent)}%${speed}${retry}`;
  // 上报给队列：任务中心与顶栏徽标据此刷新
  entry.report({ percent: Math.min(100, ((entry.index + percent / 100) / entry.total) * 100), text });
  // 保留原有界面反馈：只有当前页才动全屏进度遮罩
  if (state && state.ctx.isActive()) {
    state.ctx.showProgress(text, Math.min(99, ((entry.index + percent / 100) / entry.total) * 100));
  }
}

// —— 压缩单个视频 ——

/**
 * 跑一次转码；画质档单遍、目标体积两遍（会校验达标，不达标自动降码率重跑一次）。
 * exec：{ setJobId(jobId, retryIndex) } —— jobId 交给调用方登记进度映射，
 *       这样队列任务在后台跑时进度也能正确落到对应任务上。
 * @returns {Promise<{ok:boolean,text:string,path?:string,size?:number,retried?:boolean,
 *                     expected?:number,actual?:number}>}
 */
async function compressOne(f, params, ctx, exec) {
  const stamp = Date.now();
  const firstJobId = `vcomp-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  const plan = buildPlan(f, params);
  const outputDir = ctx.settings.getSettings().outputDir || undefined;

  if (plan.mode === 'single') {
    exec.setJobId(firstJobId, 0);
    const res = await convertMedia({
      inputPath: f.path,
      outputDir,
      baseName: f.baseName,
      ext: plan.ext,
      args: plan.args,
      durationMs: plan.durationMs,
      jobId: firstJobId
    });
    return res && res.ok
      ? { ok: true, text: `→ ${baseNameOf(res.path)}（${formatSize(res.size)}）`, path: res.path, size: res.size }
      : { ok: false, text: `✗ ${(res && res.message) || '压缩失败'}` };
  }

  // —— 目标体积模式：两遍编码；先按计划码率跑，压完校验，超出 5% 且没重试过则降码率重跑一次 ——
  const targetMB = params.targetMB;
  const expected = plan.videoKbps;
  let videoKbps = plan.videoKbps;
  let runIndex = 0;
  let lastRes = null;

  for (;;) {
    const jobId = `${firstJobId}-${runIndex}`;
    exec.setJobId(jobId, runIndex);
    const retried = runIndex > 0;
    const built = buildPlan(f, { ...params, videoKbps });
    const res = await convertMediaTwoPass({
      inputPath: f.path,
      outputDir,
      baseName: f.baseName,
      ext: built.ext,
      pass1Args: built.pass1Args,
      pass2Args: built.pass2Args,
      durationMs: built.durationMs,
      jobId
    });
    lastRes = res;

    if (!(res && res.ok)) {
      break;
    }
    // 达标则收工；超出 5% 且还没重试过 → 降码率再跑一次（最多一次）
    const vt = verifyTarget({ sizeBytes: res.size, targetMB });
    if (vt.ok) {
      return {
        ok: true,
        path: res.path,
        size: res.size,
        expected,
        actual: videoKbps,
        retried,
        text: `→ ${baseNameOf(res.path)}（实际 ${formatSize(res.size)} ／ 目标 ${targetMB} MB${retried ? '，已自动降码率重跑' : ''}）`
      };
    }
    if (runIndex >= 1) {
      // 已经重试过一次仍不达标：如实告知，不强求
      return {
        ok: true,
        path: res.path,
        size: res.size,
        expected,
        actual: videoKbps,
        retried,
        text: `→ ${baseNameOf(res.path)}（实际 ${formatSize(res.size)} ／ 目标 ${targetMB} MB，超出 ${formatSize(vt.overBy)}）`
      };
    }
    // 不达标：先把这次没达标的产物删掉，再降码率重跑（否则主进程不覆盖同名文件，会留下两份输出）
    try { await ctx.removeFile(res.path); } catch { /* 删不掉就留着，重试会另存一份 */ }
    videoKbps = retryBitrate({ videoKbps });
    runIndex += 1;
  }

  return {
    ok: false,
    text: `✗ ${(lastRes && lastRes.message) || '压缩失败'}`,
    expected,
    actual: videoKbps
  };
}

// —— 运行 ——

/**
 * 把这一批视频入队执行（任务归属队列，不归属工具页）：
 * 队列按 cpu 通道串行跑（ffmpeg 吃满 CPU），某个任务跑的时候切走工具页也不会被打断。
 * 这里仍 await 全部结束，只是为了保留原有的「跑完汇总 + 按钮变回开始」界面行为。
 */
async function run() {
  const { els } = state;
  const files = state.files;
  const total = files.length;
  const params = readParams();
  const ctx = state.ctx;
  const outputDir = ctx.settings.getSettings().outputDir || undefined;

  state.total = total;
  els.result.textContent = '';
  for (const f of files) f.result = null;
  renderList();

  // 目标体积模式：先展示「预计码率」（便于理解为什么会在这个体积附近）
  if (params.mode === 'size' && total > 0) {
    const plan = buildPlan(files[0], params);
    ctx.setStatus(`目标 ${params.targetMB}MB：预计视频码率约 ${plan.videoKbps} kbps，压完实测校验`);
  }

  const jobs = files.map((f, index) => {
    // jobId 与 onCancel 共享同一个绑定：取消时才能杀掉这条任务对应的 ffmpeg 进程
    let jobId = null;
    return {
      label: f.name,
      inputPaths: [f.path],
      outputDir,
      run: async ({ report, isCancelled }) => {
        const setJobId = (id, retry = 0) => {
          if (jobId) jobReports.delete(jobId);
          jobId = id;
          if (id) jobReports.set(id, { report, index, total, name: f.name, retry });
        };
        let out;
        try {
          out = await compressOne(f, params, ctx, { setJobId });
        } catch (err) {
          out = { ok: false, text: `✗ ${err.message}` };
        } finally {
          setJobId(null);
        }
        if (isCancelled()) {
          f.result = { ok: false, text: '已取消' };
          if (state) renderList();
          return { canceled: true };
        }
        if (state) {
          f.result = out.ok
            ? { ok: true, text: out.text, path: out.path }
            : { ok: false, text: out.text || '压缩失败' };
          renderList();
        }
        return out.ok
          ? { ok: true, outputPaths: out.path ? [out.path] : [], outputDir }
          : { ok: false, error: out.text || '压缩失败' };
      },
      onCancel: () => {
        if (!jobId) return;
        try { cancelMediaJob(jobId); } catch { /* 任务可能刚结束，忽略 */ }
      }
    };
  });

  const ids = jobs.map((job) => ctx.tasks.enqueue({
    toolId: 'video-compress',
    toolName: '视频压缩',
    lane: 'cpu',
    ...job
  }));
  state.taskIds = ids; // 供「取消」按钮逐个取消本工具入队的任务
  const settled = await Promise.all(ids.map((id) => ctx.tasks.waitFor(id)));

  if (!state) return; // 工具页已被回收：任务照跑完了，这里只跳过界面收尾
  state.total = 0;
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
    ctx.setStatus(`压缩完成：成功 ${done} 个${failed ? `，失败 ${failed} 个（${lastError}）` : ''}`);
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
    console.error('[video-compress] 处理失败', err);
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
    total: 0,
    ffmpeg: null,
    unsubProgress: null
  };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.vcomp-tool'),
    modeSel: container.querySelector('#vcompMode'),
    qualityParams: container.querySelector('#vcompQualityParams'),
    sizeParams: container.querySelector('#vcompSizeParams'),
    qualitySel: container.querySelector('#vcompQuality'),
    resSel: container.querySelector('#vcompRes'),
    muteBox: container.querySelector('#vcompMute'),
    targetMBSel: container.querySelector('#vcompTargetMB'),
    audioSel: container.querySelector('#vcompAudio'),
    ffmpegNote: container.querySelector('#vcompFfmpegNote'),
    drop: container.querySelector('#vcompDrop'),
    addBtn: container.querySelector('#vcompAddBtn'),
    listWrap: container.querySelector('#vcompListWrap'),
    list: container.querySelector('#vcompList'),
    listCount: container.querySelector('#vcompListCount'),
    addMore: container.querySelector('#vcompAddMore'),
    runBtn: container.querySelector('#vcompRunBtn'),
    clearBtn: container.querySelector('#vcompClearBtn'),
    result: container.querySelector('#vcompResult')
  };
  state.els = els;

  fillOptions(els.qualitySel, Object.keys(QUALITY_PRESETS).map((k) => ({ value: k, label: QUALITY_PRESETS[k].label })));
  fillOptions(els.resSel, RESOLUTION_PRESETS.map((r) => ({ value: r.value, label: r.label })));
  fillOptions(els.targetMBSel, SIZE_TARGETS.map((t) => ({ value: t.value, label: t.label })));
  fillOptions(els.audioSel, COMPRESS_AUDIO_KBPS.map((a) => ({ value: a.value, label: a.label })));
  els.qualitySel.value = 'standard';
  els.resSel.value = '0';
  els.targetMBSel.value = '10';
  els.audioSel.value = '96';
  updateModeView();

  on(els.modeSel, 'change', updateModeView);
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
  ctx.setStatus('视频压缩：添加视频 → 选「画质档 / 目标体积」→ 点「开始压缩」（可批量、可取消）');
  ctx.setInfo({});

  refreshFfmpeg();
}

export function unmount() {
  if (!state) return;
  // 进度订阅必须取消，避免切换工具后仍更新已销毁的界面
  if (state.unsubProgress) {
    try { state.unsubProgress(); } catch { /* 忽略 */ }
  }
  // 硬契约：任务归属队列，不归属工具页 —— 切走（含 LRU 回收）**不取消**在跑的任务，任务照跑完。
  // 这里只退订 UI：事件监听解绑，队列里的任务与产物不受影响。
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  state = null;
}