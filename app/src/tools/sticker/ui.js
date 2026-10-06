// 工具：动图与视频互转 —— 界面与交互
// 方向：视频 → 动图（GIF/WebP/APNG）、动图 → 视频（MP4/WebM）、动图 → 动图（改尺寸/帧率/压缩）。
// 分层：本文件只做界面与流程编排；类型判定、参数拼装与降档策略在 core/plan.js，
//       转码能力复用 shared/ffmpeg.js（convertMedia / probeMedia / cancelMediaJob / onMediaProgress）。
import {
  convertMedia, ffmpegStatus, probeMedia, cancelMediaJob, onMediaProgress
} from '../../shared/ffmpeg.js';
import {
  MEDIA_EXTS, OUTPUTS, outputOf, isAnimOutput, classifyExt,
  animArgs, videoArgs, sizeLadder, formatSize, formatMeta, baseNameOf
} from './core/plan.js';

const FPS_OPTIONS = [10, 12, 15, 20, 24];
const WIDTH_OPTIONS = [
  { value: 240, label: '240（聊天表情常用）' },
  { value: 320, label: '320' },
  { value: 480, label: '480（默认）' },
  { value: 720, label: '720（清晰）' },
  { value: 0, label: '保持原始宽度' }
];
const LIMIT_OPTIONS = [
  { value: 0, label: '不限制' },
  { value: 5, label: '≤ 5MB' },
  { value: 2, label: '≤ 2MB' },
  { value: 1, label: '≤ 1MB' }
];
const VIDEO_RES_OPTIONS = [
  { value: 0, label: '保持原始' },
  { value: 1080, label: '1080p' },
  { value: 720, label: '720p' }
];

const MARKUP = `
  <div class="st-tool">
    <section class="card st-controls">
      <div class="st-params">
        <div class="st-param">
          <label class="control-label" for="stOutput">输出格式:</label>
          <select class="select" id="stOutput"></select>
          <span class="control-hint" id="stOutputHint"></span>
        </div>
        <div class="st-param">
          <label class="control-label" for="stStart">起始时间:</label>
          <input class="input st-w-num" id="stStart" type="number" min="0" step="0.1" placeholder="0" />
          <span class="control-label">秒</span>
        </div>
        <div class="st-param">
          <label class="control-label" for="stDuration">时长:</label>
          <input class="input st-w-num" id="stDuration" type="number" min="0" step="0.1" placeholder="6" />
          <span class="control-label">秒</span>
          <span class="control-hint">留空 = 全程</span>
        </div>
      </div>

      <div class="st-block" id="stAnimBlock">
        <div class="st-params">
          <div class="st-param">
            <label class="control-label" for="stFps">帧率:</label>
            <select class="select st-w-sel" id="stFps"></select>
          </div>
          <div class="st-param">
            <label class="control-label" for="stWidth">宽度:</label>
            <select class="select st-w-sel" id="stWidth"></select>
          </div>
          <div class="st-param">
            <label class="control-label" for="stLoop">循环:</label>
            <select class="select st-w-sel" id="stLoop">
              <option value="0">无限循环</option>
              <option value="1">只播放一次</option>
            </select>
          </div>
          <div class="st-param">
            <label class="control-label" for="stLimit">目标大小:</label>
            <select class="select st-w-sel" id="stLimit"></select>
          </div>
        </div>
        <div class="st-params st-presets">
          <span class="control-label">一键预设:</span>
          <button class="btn btn-ghost" type="button" id="stPresetStd">聊天表情·标准（240 宽 / 12 帧 / ≤5MB）</button>
          <button class="btn btn-ghost" type="button" id="stPresetMin">聊天表情·压缩（240 宽 / 10 帧 / ≤2MB）</button>
        </div>
      </div>

      <div class="st-block" id="stVideoBlock" hidden>
        <div class="st-params">
          <div class="st-param">
            <label class="control-label" for="stVRes">分辨率:</label>
            <select class="select st-w-sel" id="stVRes"></select>
          </div>
          <div class="st-param">
            <label class="control-label" for="stVFps">帧率:</label>
            <select class="select st-w-sel" id="stVFps">
              <option value="0">保持原始</option>
              <option value="30">30 帧</option>
            </select>
          </div>
        </div>
      </div>

      <div class="st-note" id="stFfmpegNote">正在检测 ffmpeg…</div>
    </section>

    <main class="card st-files" id="stFiles">
      <div class="st-drop" id="stDrop">
        <button class="btn btn-primary btn-lg" data-add="1" id="stAddBtn">添加动图 / 视频</button>
        <div class="st-drop-hint">支持 GIF / WebP / APNG 动图与常见视频；也可把文件或文件夹直接拖进窗口</div>
      </div>
      <div class="st-list-wrap" id="stListWrap" hidden>
        <div class="st-list-head">
          <span id="stListTitle">文件</span>
          <span class="st-spacer"></span>
          <span id="stListCount"></span>
          <button class="btn btn-ghost" data-add="1" id="stAddMore" type="button">＋ 继续添加</button>
        </div>
        <ul class="st-list" id="stList"></ul>
      </div>
    </main>

    <footer class="st-actions">
      <button class="btn btn-primary st-run" data-run="1" id="stRunBtn">开始转换</button>
      <button class="btn btn-plain" data-clear="1" id="stClearBtn">清空</button>
      <div class="st-result" id="stResult"></div>
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
    note.className = 'st-note';
    note.textContent = '正在检测 ffmpeg…';
    return;
  }
  if (state.ffmpeg.found) {
    const where = state.ffmpeg.where === 'addon' ? '加装包' : '系统安装';
    note.className = 'st-note is-ok';
    note.textContent = `✓ 已检测到 ffmpeg ${state.ffmpeg.version || ''}（${where}）`.replace(/\s+/g, ' ').trim();
  } else {
    note.className = 'st-note is-warn';
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

// —— 参数区 ——

function renderOutputHint() {
  const out = outputOf(state.els.outputSel.value);
  const hints = {
    gif: 'GIF 兼容性最好，但最多 256 色',
    webp: 'WebP 动图体积小，新版微信/浏览器可用',
    apng: 'APNG 使用 .png 后缀（部分软件按 PNG 处理）',
    mp4: '动图转视频会自动铺白底（H.264 不支持透明）',
    webm: 'WebM 体积小，适合网页'
  };
  state.els.outputHint.textContent = hints[out.value] || '';
}

function renderBlocks() {
  const anim = isAnimOutput(state.els.outputSel.value);
  state.els.animBlock.hidden = !anim;
  state.els.videoBlock.hidden = anim;
  renderOutputHint();
  updateRunButton();
}

function readParams() {
  const { els } = state;
  const rawStart = els.startInput.value.trim();
  const rawDuration = els.durationInput.value.trim();
  const start = rawStart === '' ? 0 : Math.max(0, Number(rawStart) || 0);
  const duration = rawDuration === '' ? 0 : Math.max(0, Number(rawDuration) || 0);
  return {
    output: els.outputSel.value,
    start,
    duration,
    fps: parseInt(els.fpsSel.value, 10) || 15,
    width: parseInt(els.widthSel.value, 10) || 0,
    loop: parseInt(els.loopSel.value, 10) || 0,
    limit: parseInt(els.limitSel.value, 10) || 0,
    videoHeight: parseInt(els.vresSel.value, 10) || 0,
    videoFps: parseInt(els.vfpsSel.value, 10) || 0
  };
}

function applyPreset(kind) {
  const { els } = state;
  els.widthSel.value = '240';
  els.limitSel.value = kind === 'compact' ? '2' : '5';
  els.fpsSel.value = kind === 'compact' ? '10' : '12';
  state.ctx.setStatus(kind === 'compact'
    ? '已套用「聊天表情·压缩」：240 宽 / 10 帧 / ≤2MB'
    : '已套用「聊天表情·标准」：240 宽 / 12 帧 / ≤5MB');
}

function updateRunButton() {
  const { els } = state;
  els.runBtn.textContent = state.busy ? '取消' : '开始转换';
  const ffmpegOk = !!(state.ffmpeg && state.ffmpeg.found);
  // 运行中按钮变「取消」且始终可点；未检测到 ffmpeg 时禁用运行
  els.runBtn.disabled = !state.busy && !ffmpegOk;
}

// —— 文件列表 ——

function renderList() {
  const { els } = state;
  const files = state.files;
  els.listWrap.hidden = files.length === 0;
  els.drop.hidden = files.length > 0;
  els.listCount.textContent = files.length ? `共 ${files.length} 项` : '';
  els.list.innerHTML = '';

  files.forEach((f, index) => {
    const li = document.createElement('li');
    li.className = 'st-item';

    const tag = document.createElement('span');
    tag.className = 'st-tag ' + (f.type === 'anim' ? 'is-anim' : 'is-video');
    tag.textContent = f.type === 'anim' ? '动图' : '视频';
    li.appendChild(tag);

    const main = document.createElement('div');
    main.className = 'st-item-main';

    const name = document.createElement('div');
    name.className = 'st-item-name';
    name.textContent = f.name;
    name.title = f.path;
    main.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'st-item-meta';
    meta.textContent = f.meta || '';
    main.appendChild(meta);

    if (f.result) {
      const result = document.createElement('div');
      result.className = 'st-item-result' + (f.result.ok ? ' is-ok' : ' is-fail');
      result.textContent = f.result.text;
      result.title = f.result.text;
      main.appendChild(result);
    }

    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'st-item-actions';
    const del = document.createElement('button');
    del.className = 'st-icon-btn';
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
  if (!MEDIA_EXTS.includes(ext)) return '不是动图或视频';
  const probe = await probeMedia(filePath);
  if (!probe || !probe.ok) return (probe && probe.message) || '无法识别该文件';
  const type = classifyExt(ext, probe);
  if (!type) return '静态 PNG 不是动图（APNG 用 .png 后缀，可正常识别）';
  const item = {
    path: filePath,
    name: info.name,
    baseName: info.baseName,
    dir: info.dir,
    ext,
    type,
    width: probe.width,
    height: probe.height,
    durationSec: probe.durationSec,
    hasAudio: probe.hasAudio,
    result: null
  };
  item.meta = formatMeta(item);
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
        const list = await state.ctx.listFiles(p, MEDIA_EXTS);
        if (list.length === 0) { failures.push(`${info.name}：文件夹里没有动图或视频`); continue; }
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
    state.ctx.setStatus(`已添加 ${added} 项${failures.length ? `，${failures.length} 项跳过` : ''}`);
  } else {
    state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的文件');
  }
  if (failures.length > 1) console.warn('[sticker] 部分文件未添加：\n' + failures.join('\n'));
}

async function openDialog() {
  const paths = await state.ctx.openMedia();
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

// —— 转码：动图输出（含目标大小降档重试） ——

function startArgs(p) {
  const args = [];
  if (p.start > 0) args.push('-ss', String(p.start));
  if (p.duration > 0) args.push('-t', String(p.duration));
  return args;
}

/** 本次实际转码时长（进度百分比用）：截取时长与源时长取小 */
function effDurationMs(item, p) {
  const total = item.durationSec || 0;
  let dur = p.duration > 0 ? p.duration : Math.max(0, total - p.start);
  if (total > 0) dur = Math.min(dur, Math.max(0, total - p.start));
  return Math.round(dur * 1000);
}

async function convertAnim(item, p, ctx, exec) {
  const out = outputOf(p.output);
  const base = {
    fps: p.fps,
    width: p.width,
    colors: 256,
    loop: p.loop,
    srcW: item.width,
    srcH: item.height
  };
  // 设了目标大小才启用降档；否则只跑基准一档
  const rungs = p.limit > 0 ? sizeLadder(base, p.output === 'gif') : [{ ...base, label: '' }];
  const limitBytes = p.limit * 1024 * 1024;
  const inputArgs = startArgs(p);
  const durationMs = effDurationMs(item, p);
  const outputDir = ctx.settings.getSettings().outputDir || undefined;

  for (let i = 0; i < rungs.length; i++) {
    if (exec.isCancelled()) return { cancelled: true };
    const rung = rungs[i];
    const jobId = `st-${Date.now()}-${i + 1}-${Math.random().toString(36).slice(2, 6)}`;
    exec.setJobId(jobId);
    let res;
    try {
      res = await convertMedia({
        inputPath: item.path,
        outputDir,
        baseName: `${item.baseName}_动图`,
        ext: out.ext,
        inputArgs,
        args: animArgs(p.output, rung),
        durationMs,
        jobId
      });
    } catch (err) {
      res = { ok: false, message: err.message };
    }
    exec.setJobId(null);
    if (exec.isCancelled()) return { cancelled: true };
    if (!res || !res.ok) return { ok: false, message: (res && res.message) || '转换失败' };

    // 未设上限，或已达到上限 → 收工
    if (p.limit <= 0 || res.size <= limitBytes) {
      // 只有真正降过档（i > 0）才提示实际档位
      const note = p.limit > 0 && i > 0 ? `已压到 ${rung.label}` : '';
      return { ok: true, path: res.path, size: res.size, note };
    }
    // 仍超限：删掉本轮产物，降档重试；最后一档则保留并如实说明
    if (i < rungs.length - 1) {
      try { await ctx.removeFile(res.path); } catch { /* 删不掉也继续下一档 */ }
    } else {
      return { ok: true, path: res.path, size: res.size, note: `已尽量压缩，实得 ${formatSize(res.size)}` };
    }
  }
  return { ok: false, message: '压缩失败' };
}

async function convertVideo(item, p, ctx, exec) {
  const out = outputOf(p.output);
  const jobId = `st-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  exec.setJobId(jobId);
  let res;
  try {
    res = await convertMedia({
      inputPath: item.path,
      outputDir: ctx.settings.getSettings().outputDir || undefined,
      baseName: `${item.baseName}_视频`,
      ext: out.ext,
      inputArgs: startArgs(p),
      args: videoArgs({
        srcW: item.width,
        srcH: item.height,
        targetHeight: p.videoHeight,
        fps: p.videoFps,
        target: out.value
      }),
      durationMs: effDurationMs(item, p),
      jobId
    });
  } catch (err) {
    res = { ok: false, message: err.message };
  }
  exec.setJobId(null);
  if (exec.isCancelled()) return { cancelled: true };
  if (!res || !res.ok) return { ok: false, message: (res && res.message) || '转换失败' };
  return { ok: true, path: res.path, size: res.size, note: '' };
}

// —— 运行 ——

/**
 * 把这一批文件入队执行（任务归属队列，不归属工具页）：队列按 cpu 通道串行跑（ffmpeg 吃满 CPU）。
 * 仍 await 全部结束，只是为了保留原有的「跑完汇总 + 按钮变回开始」界面行为。
 */
async function run() {
  const { els } = state;
  const files = state.files;
  const total = files.length;
  const p = readParams();
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
        const exec = {
          isCancelled,
          setJobId: (id) => {
            if (jobId) jobReports.delete(jobId);
            jobId = id;
            if (id) jobReports.set(id, { report, index, total, name: f.name });
          }
        };
        let res;
        try {
          res = isAnimOutput(p.output)
            ? await convertAnim(f, p, ctx, exec)
            : await convertVideo(f, p, ctx, exec);
        } catch (err) {
          res = { ok: false, message: err.message };
        } finally {
          exec.setJobId(null);
        }

        if (res.cancelled || isCancelled()) {
          f.result = { ok: false, text: '已取消' };
          if (state) renderList();
          return { canceled: true };
        }
        if (res.ok) {
          const note = res.note ? `｜${res.note}` : '';
          f.result = { ok: true, text: `→ ${baseNameOf(res.path)}（${formatSize(res.size)}）${note}`, path: res.path };
          if (state) renderList();
          return { ok: true, outputPaths: [res.path], outputDir };
        }
        const message = res.message || '转换失败';
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
    toolId: 'sticker',
    toolName: '动图与视频互转',
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
    st.ctx.setStatus('请先添加动图或视频');
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
    console.error('[sticker] 处理失败', err);
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
  state.ctx.setStatus('已清空文件列表');
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
    root: container.querySelector('.st-tool'),
    outputSel: container.querySelector('#stOutput'),
    outputHint: container.querySelector('#stOutputHint'),
    startInput: container.querySelector('#stStart'),
    durationInput: container.querySelector('#stDuration'),
    animBlock: container.querySelector('#stAnimBlock'),
    videoBlock: container.querySelector('#stVideoBlock'),
    fpsSel: container.querySelector('#stFps'),
    widthSel: container.querySelector('#stWidth'),
    loopSel: container.querySelector('#stLoop'),
    limitSel: container.querySelector('#stLimit'),
    presetStd: container.querySelector('#stPresetStd'),
    presetMin: container.querySelector('#stPresetMin'),
    vresSel: container.querySelector('#stVRes'),
    vfpsSel: container.querySelector('#stVFps'),
    ffmpegNote: container.querySelector('#stFfmpegNote'),
    drop: container.querySelector('#stDrop'),
    addBtn: container.querySelector('#stAddBtn'),
    listWrap: container.querySelector('#stListWrap'),
    list: container.querySelector('#stList'),
    listCount: container.querySelector('#stListCount'),
    addMore: container.querySelector('#stAddMore'),
    runBtn: container.querySelector('#stRunBtn'),
    clearBtn: container.querySelector('#stClearBtn'),
    result: container.querySelector('#stResult')
  };
  state.els = els;

  fillOptions(els.outputSel, OUTPUTS.map((o) => ({ value: o.value, label: o.label })));
  fillOptions(els.fpsSel, FPS_OPTIONS.map((v) => ({ value: v, label: `${v} 帧${v === 15 ? '（默认）' : ''}` })));
  fillOptions(els.widthSel, WIDTH_OPTIONS);
  fillOptions(els.limitSel, LIMIT_OPTIONS);
  fillOptions(els.vresSel, VIDEO_RES_OPTIONS);
  els.outputSel.value = 'gif';
  els.fpsSel.value = '15';
  els.widthSel.value = '480';
  els.loopSel.value = '0';
  els.limitSel.value = '0';
  els.vresSel.value = '0';
  els.vfpsSel.value = '0';

  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', onRunClick);
  on(els.clearBtn, 'click', clearAll);
  on(els.outputSel, 'change', renderBlocks);
  on(els.presetStd, 'click', () => applyPreset('standard'));
  on(els.presetMin, 'click', () => applyPreset('compact'));
  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);

  state.unsubProgress = onMediaProgress(onProgress);

  renderBlocks();
  renderFfmpegNote();
  renderList();
  updateRunButton();
  ctx.setStatus('动图与视频互转：添加文件 → 选输出格式（动图或视频）→ 点「开始转换」');
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