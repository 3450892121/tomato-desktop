// 工具：图片压缩 —— 界面与交互
// 分层：本文件只做界面与流程编排；缩放/编码/目标大小逼近在 core/compress.js；
//       图片解码与缩略图复用 shared/imageio.js。
import { decodeImageFromBytes, makeThumbnailFromBytes } from '../../shared/imageio.js';
import { autoFormat, compressPixels } from './core/compress.js';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.ico', '.avif'];

const FORMATS = [
  { value: 'auto', label: '自动（保持原格式）' },
  { value: 'jpg', label: 'JPG（最通用）' },
  { value: 'webp', label: 'WebP（体积最小）' },
  { value: 'png', label: 'PNG（无损）' }
];
const SIZE_MODES = [
  { value: 'none', label: '不缩放' },
  { value: 'longest', label: '最长边' },
  { value: 'percent', label: '按百分比' }
];
const GOALS = [
  { value: 'quality', label: '画质优先' },
  { value: 'size', label: '指定大小' }
];

const MARKUP = `
  <div class="cmp-tool">
    <section class="card cmp-controls">
      <div class="control-row">
        <span class="control-label">输出格式</span>
        <select class="select" id="cmpFormat"></select>
        <span class="control-hint" id="cmpFormatHint"></span>
      </div>
      <div class="control-row">
        <span class="control-label">画质</span>
        <input class="input cmp-w-num" id="cmpQuality" type="number" min="1" max="100" value="82" />
        <span class="control-hint">仅 JPG / WebP 有效；越低体积越小</span>
      </div>
      <div class="control-row">
        <span class="control-label">尺寸</span>
        <select class="select cmp-w-mode" id="cmpSizeMode"></select>
        <input class="input cmp-w-num" id="cmpSizeValue" type="number" min="1" value="1920" />
        <span class="control-hint" id="cmpSizeUnit">像素</span>
      </div>
      <div class="control-row">
        <span class="control-label">压缩目标</span>
        <select class="select cmp-w-mode" id="cmpGoal"></select>
        <input class="input cmp-w-num" id="cmpTargetKb" type="number" min="10" value="500" disabled />
        <span class="control-hint">KB（指定大小时自动调画质，必要时缩小尺寸）</span>
      </div>
    </section>

    <main class="card cmp-files">
      <div class="cmp-drop" id="cmpDrop">
        <button class="btn btn-primary btn-lg" id="cmpAddBtn" data-add="1">添加图片</button>
        <div class="cmp-drop-hint">也可以把图片或整个文件夹拖进窗口；支持多选</div>
      </div>
      <div class="cmp-list-wrap" id="cmpListWrap" hidden>
        <div class="cmp-list-head">
          <span>图片</span>
          <span class="cmp-spacer"></span>
          <span id="cmpCount" class="control-hint"></span>
          <button class="btn btn-ghost" id="cmpAddMore" data-add="1" type="button">＋ 继续添加</button>
        </div>
        <ul class="cmp-list" id="cmpList"></ul>
      </div>
    </main>

    <footer class="cmp-actions">
      <button class="btn btn-primary" id="cmpRunBtn" data-run="1">开始压缩</button>
      <button class="btn btn-plain" id="cmpClearBtn" data-clear="1">清空</button>
      <div class="cmp-result" id="cmpResult"></div>
    </footer>
  </div>
`;

let state = null;

function on(el, type, handler) {
  el.addEventListener(type, handler);
  state.listeners.push([el, type, handler]);
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function fillSelect(sel, options) {
  sel.innerHTML = '';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
}

// —— 参数区 ——

function readParams() {
  const { els } = state;
  const sizeMode = els.sizeMode.value;
  const sizeValue = parseInt(els.sizeValue.value, 10) || 0;
  return {
    format: els.format.value,
    quality: Math.max(1, Math.min(100, parseInt(els.quality.value, 10) || 82)),
    longestEdge: sizeMode === 'longest' ? sizeValue : 0,
    percent: sizeMode === 'percent' ? sizeValue : 0,
    targetBytes: els.goal.value === 'size' ? Math.max(10, parseInt(els.targetKb.value, 10) || 500) * 1024 : 0
  };
}

function refreshParamState() {
  const { els } = state;
  const sizeMode = els.sizeMode.value;
  els.sizeValue.disabled = sizeMode === 'none';
  els.sizeUnit.textContent = sizeMode === 'percent' ? '%' : '像素';
  if (sizeMode === 'longest' && parseInt(els.sizeValue.value, 10) > 10000) els.sizeValue.value = '1920';
  if (sizeMode === 'percent' && parseInt(els.sizeValue.value, 10) > 100) els.sizeValue.value = '80';

  els.targetKb.disabled = els.goal.value !== 'size';

  const fmt = els.format.value;
  els.quality.disabled = fmt === 'png';
  els.formatHint.textContent = fmt === 'auto'
    ? 'PNG 照片建议选 WebP/JPG 才能明显变小'
    : fmt === 'png' ? 'PNG 无损，体积通常压不动' : '';
}

// —— 文件列表 ——

function renderList() {
  const { els } = state;
  const files = state.files;
  els.listWrap.hidden = files.length === 0;
  els.drop.hidden = files.length > 0;
  els.count.textContent = files.length ? `共 ${files.length} 张` : '';
  els.list.innerHTML = '';

  files.forEach((f, index) => {
    const li = document.createElement('li');
    li.className = 'cmp-item';

    const img = document.createElement('img');
    img.className = 'cmp-item-thumb';
    img.src = f.thumbUrl;
    img.alt = '';
    li.appendChild(img);

    const main = document.createElement('div');
    main.className = 'cmp-item-main';
    const name = document.createElement('div');
    name.className = 'cmp-item-name';
    name.textContent = f.name;
    name.title = f.path;
    const meta = document.createElement('div');
    meta.className = 'cmp-item-meta';
    meta.textContent = `${f.width} × ${f.height} ｜ 原始 ${fmtBytes(f.size)}`;
    main.appendChild(name);
    main.appendChild(meta);

    if (f.result) {
      const result = document.createElement('div');
      result.className = f.error ? 'cmp-item-result is-error' : 'cmp-item-result';
      result.textContent = f.result;
      main.appendChild(result);
    }
    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'cmp-item-actions';
    const del = document.createElement('button');
    del.className = 'cmp-icon-btn';
    del.textContent = '×';
    del.title = '移除';
    del.addEventListener('click', () => {
      files.splice(index, 1);
      renderList();
    });
    actions.appendChild(del);
    li.appendChild(actions);

    els.list.appendChild(li);
  });
}

// —— 添加文件 ——

async function addFromPaths(paths) {
  const failures = [];
  let added = 0;

  const pushOne = async (p) => {
    const info = await state.ctx.pathInfo(p);
    const ext = (info.ext || '').toLowerCase();
    if (!IMAGE_EXTS.includes(ext)) {
      failures.push(`${info.name}：不是支持的图片格式`);
      return;
    }
    const bytes = await state.ctx.readFile(p);
    // 添加阶段只要尺寸与缩略图，不摊开整图像素（真正压缩时下面会重新解码）
    const { thumb, width, height } = await makeThumbnailFromBytes(bytes, 42);
    state.files.push({
      path: p, name: info.name, baseName: info.baseName, dir: info.dir, ext,
      width, height, size: bytes.byteLength,
      thumbUrl: thumb.toDataURL('image/png'),
      result: '', error: false
    });
    added += 1;
  };

  for (const p of paths) {
    try {
      const info = await state.ctx.pathInfo(p);
      if (info.isDirectory) {
        const list = await state.ctx.listFiles(p, IMAGE_EXTS);
        if (list.length === 0) failures.push(`${info.name}：文件夹里没有支持的图片`);
        for (const one of list) {
          try {
            await pushOne(one);
          } catch (err) {
            failures.push(`${one.split(/[\\/]/).pop()}：${err.message}`);
          }
        }
      } else {
        await pushOne(p);
      }
    } catch (err) {
      failures.push(`${String(p).split(/[\\/]/).pop()}：${err.message}`);
    }
  }

  renderList();
  if (added > 0) {
    state.ctx.setStatus(`已添加 ${added} 张${failures.length ? `，${failures.length} 项失败` : ''}`);
  } else {
    state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的图片');
  }
}

async function openDialog() {
  const paths = await state.ctx.openImageAny();
  if (paths && paths.length > 0) await addFromPaths(paths);
}

async function onDrop(event) {
  event.preventDefault();
  const files = Array.from(event.dataTransfer ? event.dataTransfer.files : []);
  const paths = [];
  for (const file of files) {
    const p = state.ctx.getPathForFile(file);
    if (p) paths.push(p);
  }
  if (paths.length > 0) await addFromPaths(paths);
}

// —— 运行 ——

/** 压缩单张（读字节 → 解码 → 压缩 → 落盘），返回结果与体积统计 */
async function compressOne(f, params, ctx, outputDir) {
  const bytes = await ctx.readFile(f.path);
  const img = await decodeImageFromBytes(bytes);
  const format = params.format === 'auto' ? autoFormat(f.ext) : params.format;
  const out = await compressPixels(img.pixels, img.width, img.height, { ...params, format });
  const ext = format === 'jpg' ? '.jpg' : `.${format}`;
  const path = await ctx.saveNextTo({
    sourcePath: f.path, targetDir: outputDir, baseName: f.baseName, ext, bytes: out.bytes
  });
  const ratio = bytes.byteLength > 0 ? (1 - out.bytes.length / bytes.byteLength) * 100 : 0;
  return {
    ok: true,
    path,
    inBytes: bytes.byteLength,
    outBytes: out.bytes.length,
    width: out.width,
    height: out.height,
    text: `${fmtBytes(bytes.byteLength)} → ${fmtBytes(out.bytes.length)}（${ratio >= 0 ? '-' : '+'}${Math.abs(ratio).toFixed(0)}%）`
      + ` ｜ ${out.width}×${out.height}`
      + (out.note ? ` ｜ ${out.note}` : '')
  };
}

/**
 * 把这一批图片入队执行（任务归属队列，不归属工具页）：图片类走 io 通道（并发 2）。
 * 仍 await 全部结束，只是为了保留原有的「跑完汇总 + 按钮恢复」界面行为。
 */
async function run() {
  if (state.busy) return;
  const files = state.files;
  if (files.length === 0) {
    state.ctx.setStatus('请先添加图片');
    return;
  }

  state.busy = true;
  state.els.runBtn.disabled = true;
  state.els.runBtn.textContent = '压缩中…';

  const params = readParams();
  const ctx = state.ctx;
  const outputDir = ctx.settings.getSettings().outputDir || undefined;
  const t0 = performance.now();
  let savedBytes = 0;
  let originalBytes = 0;

  for (const f of files) { f.result = ''; f.error = false; }
  renderList();

  const jobs = files.map((f, index) => ({
    label: f.name,
    inputPaths: [f.path],
    outputDir,
    run: async ({ report, isCancelled }) => {
      if (isCancelled()) return { canceled: true };
      const step = `压缩 ${index + 1}/${files.length}：${f.name}`;
      report({ percent: 0, text: step });
      if (state && state.ctx.isActive()) state.ctx.showProgress(step, (index / files.length) * 100);

      let out;
      try {
        out = await compressOne(f, params, ctx, outputDir);
      } catch (err) {
        out = { ok: false, error: err.message };
      }
      if (isCancelled()) return { canceled: true };

      if (out.ok) {
        f.result = out.text;
        f.error = false;
        savedBytes += out.outBytes;
        originalBytes += out.inBytes;
        if (state && state.ctx.isActive()) state.ctx.setInfo({ width: out.width, height: out.height, ms: Math.round(performance.now() - t0) });
      } else {
        f.result = `失败：${out.error}`;
        f.error = true;
      }
      report({ percent: 100, text: out.ok ? out.text : `失败：${out.error}` });
      if (state) renderList();
      return out.ok
        ? { ok: true, outputPaths: out.path ? [out.path] : [], outputDir }
        : { ok: false, error: out.error };
    }
  }));

  const settled = await ctx.tasks.runBatch({ toolId: 'compress', toolName: '图片压缩', lane: 'io', jobs });

  if (!state) return; // 工具页已被回收：任务照跑完了，这里只跳过界面收尾
  ctx.hideProgress();
  state.busy = false;
  state.els.runBtn.disabled = false;
  state.els.runBtn.textContent = '开始压缩';

  const done = settled.filter((t) => t.status === 'done').length;
  const failed = settled.filter((t) => t.status === 'failed').length;
  const failedTask = settled.find((t) => t.status === 'failed');
  const lastError = (failedTask && failedTask.error) || '';
  const doneTask = [...settled].reverse().find((t) => t.status === 'done' && t.output.paths.length);
  const lastPath = doneTask ? doneTask.output.paths[0] : '';

  const saved = originalBytes > 0 ? `，总体积减少 ${(((originalBytes - savedBytes) / originalBytes) * 100).toFixed(0)}%（${fmtBytes(originalBytes)} → ${fmtBytes(savedBytes)}）` : '';
  ctx.setStatus(`压缩完成：成功 ${done} 张${failed ? `，失败 ${failed} 张（${lastError}）` : ''}${saved}`);
  if (lastPath) state.els.result.textContent = outputDir ? `输出到：${outputDir}` : `输出：${lastPath}`;
}

// —— 生命周期 ——

export function mount(container, ctx) {
  state = { ctx, els: null, listeners: [], files: [], busy: false, container };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.cmp-tool'),
    format: container.querySelector('#cmpFormat'),
    formatHint: container.querySelector('#cmpFormatHint'),
    quality: container.querySelector('#cmpQuality'),
    sizeMode: container.querySelector('#cmpSizeMode'),
    sizeValue: container.querySelector('#cmpSizeValue'),
    sizeUnit: container.querySelector('#cmpSizeUnit'),
    goal: container.querySelector('#cmpGoal'),
    targetKb: container.querySelector('#cmpTargetKb'),
    drop: container.querySelector('#cmpDrop'),
    addBtn: container.querySelector('#cmpAddBtn'),
    addMore: container.querySelector('#cmpAddMore'),
    listWrap: container.querySelector('#cmpListWrap'),
    list: container.querySelector('#cmpList'),
    count: container.querySelector('#cmpCount'),
    runBtn: container.querySelector('#cmpRunBtn'),
    clearBtn: container.querySelector('#cmpClearBtn'),
    result: container.querySelector('#cmpResult')
  };
  state.els = els;

  fillSelect(els.format, FORMATS);
  fillSelect(els.sizeMode, SIZE_MODES);
  fillSelect(els.goal, GOALS);

  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', run);
  on(els.clearBtn, 'click', () => {
    state.files = [];
    renderList();
    state.ctx.setStatus('已清空图片列表');
  });
  on(els.format, 'change', refreshParamState);
  on(els.sizeMode, 'change', refreshParamState);
  on(els.goal, 'change', refreshParamState);
  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);

  refreshParamState();
  renderList();
  state.ctx.setStatus('图片压缩：添加图片后点「开始压缩」，结果存在原图旁边（原图不动）');
}

export function unmount() {
  if (!state) return;
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  state = null;
}