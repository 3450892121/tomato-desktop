// 工具：加水印 —— 界面与交互
// 分层：本文件只做界面与流程编排；位置计算 / 绘制 / 编码在 core/draw.js；
//       图片解码与缩略图复用 shared/imageio.js。
import { decodeImageFromBytes, makeThumbnail } from '../../shared/imageio.js';
import {
  WATERMARK_DEFAULTS,
  WATERMARK_POSITIONS,
  contrastStrokeColor,
  renderWatermark
} from './core/draw.js';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.ico', '.avif'];

/** 预览用的最长边：够看清细节，又不至于每次改参数都等太久 */
const PREVIEW_MAX_EDGE = 460;

const MARKUP = `
  <div class="wm-tool">
    <section class="card wm-controls">
      <div class="control-row">
        <span class="control-label">水印类型</span>
        <div class="wm-seg" id="wmTypeSeg">
          <button class="btn wm-seg-btn is-active" data-type="text" type="button">文字水印</button>
          <button class="btn wm-seg-btn" data-type="image" type="button">图片水印</button>
        </div>
        <span class="control-hint" id="wmTypeHint"></span>
      </div>

      <div class="control-row" id="wmTextRow">
        <span class="control-label">水印文字</span>
        <input class="input" id="wmText" type="text" value="仅供本人使用" placeholder="例如：仅供本人使用 ／ 请勿外传" />
        <label class="wm-check"><input type="checkbox" id="wmStroke" checked /> 描边（浅色背景也看得清）</label>
      </div>

      <div class="control-row" id="wmStampRow" hidden>
        <span class="control-label">印章图片</span>
        <button class="btn btn-ghost" id="wmStampBtn" type="button">选择印章图片…</button>
        <img class="wm-stamp-thumb" id="wmStampThumb" alt="" hidden />
        <span class="control-hint" id="wmStampName">未选择</span>
      </div>

      <div class="control-row">
        <span class="control-label">位置</span>
        <div class="wm-pos-grid" id="wmPosGrid"></div>
      </div>

      <div class="control-row">
        <span class="control-label">大小</span>
        <input class="input wm-w-num" id="wmSize" type="number" min="1" max="40" step="1" value="6" />
        <span class="control-hint" id="wmSizeUnit">占图宽 %</span>
        <span class="control-label wm-gap">透明度</span>
        <input class="input wm-w-num" id="wmOpacity" type="number" min="0" max="100" step="5" value="80" />
        <span class="control-hint">%</span>
        <span class="control-label wm-gap">旋转</span>
        <input class="input wm-w-num" id="wmRotation" type="number" min="-180" max="180" step="5" value="0" />
        <span class="control-hint">度</span>
        <span class="wm-inline" id="wmColorWrap">
          <span class="control-label wm-gap">颜色</span>
          <input class="input wm-color" id="wmColor" type="color" value="#ffffff" />
        </span>
      </div>
    </section>

    <div class="wm-body">
      <main class="card wm-files">
        <div class="wm-drop" id="wmDrop">
          <button class="btn btn-primary btn-lg" id="wmAddBtn" data-add="1" type="button">添加图片</button>
          <div class="wm-drop-hint">也可以把图片或整个文件夹拖进窗口；支持多选</div>
        </div>
        <div class="wm-list-wrap" id="wmListWrap" hidden>
          <div class="wm-list-head">
            <span>图片</span>
            <span class="wm-spacer"></span>
            <span class="control-hint" id="wmCount"></span>
            <button class="btn btn-ghost" id="wmAddMore" data-add="1" type="button">＋ 继续添加</button>
          </div>
          <ul class="wm-list" id="wmList"></ul>
        </div>
      </main>

      <aside class="card wm-preview">
        <div class="wm-preview-head">
          <span>实时预览</span>
          <span class="control-hint" id="wmPreviewName"></span>
        </div>
        <div class="wm-preview-panes">
          <figure class="wm-pane">
            <div class="wm-pane-wrap"><canvas id="wmOrigCanvas"></canvas></div>
            <figcaption>原图</figcaption>
          </figure>
          <figure class="wm-pane">
            <div class="wm-pane-wrap"><canvas id="wmNewCanvas"></canvas></div>
            <figcaption>加水印后</figcaption>
          </figure>
        </div>
        <div class="wm-preview-hint" id="wmPreviewHint"></div>
      </aside>
    </div>

    <footer class="wm-actions">
      <button class="btn btn-primary" id="wmRunBtn" data-run="1" type="button">开始加水印</button>
      <button class="btn btn-plain" id="wmCancelBtn" data-cancel="1" type="button" hidden>取消</button>
      <button class="btn btn-plain" id="wmClearBtn" data-clear="1" type="button">清空</button>
      <div class="wm-result" id="wmResult"></div>
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

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// —— 参数区 ——

/** 大小档位：文字按字号、图片按印章宽度，都换算成「占图宽百分比」 */
function sizeRange() {
  return state.type === 'image' ? { min: 1, max: 100 } : { min: 1, max: 40 };
}

function readParams() {
  const { els } = state;
  const range = sizeRange();
  const color = els.color.value || WATERMARK_DEFAULTS.color;
  return {
    type: state.type,
    text: els.text.value,
    position: state.position,
    sizePercent: clampNum(els.size.value, range.min, range.max, WATERMARK_DEFAULTS.sizePercent),
    opacity: clampNum(els.opacity.value, 0, 100, WATERMARK_DEFAULTS.opacity),
    rotation: clampNum(els.rotation.value, -180, 180, 0),
    color,
    stroke: els.stroke.checked,
    strokeColor: contrastStrokeColor(color),
    stamp: state.stamp
  };
}

function refreshParamState() {
  const { els } = state;
  const isText = state.type === 'text';
  els.textRow.hidden = !isText;
  els.stampRow.hidden = isText;
  els.colorWrap.hidden = !isText;
  els.stroke.disabled = !isText;
  els.typeHint.textContent = isText
    ? '文字水印：适合写「仅供本人使用」这类说明'
    : '图片水印：适合盖印章 / LOGO（建议用带透明背景的 PNG）';

  const range = sizeRange();
  els.size.min = String(range.min);
  els.size.max = String(range.max);
  els.size.value = String(clampNum(els.size.value, range.min, range.max, WATERMARK_DEFAULTS.sizePercent));
  els.sizeUnit.textContent = isText ? '字号占图宽 %' : '印章宽占图宽 %';

  for (const btn of els.typeSeg.querySelectorAll('.wm-seg-btn')) {
    btn.classList.toggle('is-active', btn.dataset.type === state.type);
  }
  for (const btn of els.posGrid.querySelectorAll('.wm-pos-btn')) {
    btn.classList.toggle('is-active', btn.dataset.pos === state.position);
  }
}

// —— 图片读取与预览 ——

/** 读一张图 → 可直接用于绘制的位图 + 缩略图（复用 shared/imageio.js 的解码与缩略图） */
async function loadSource(path, { withThumb = false } = {}) {
  const bytes = await state.ctx.readFile(path);
  const img = await decodeImageFromBytes(bytes);
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas.getContext('2d').putImageData(new ImageData(img.pixels, img.width, img.height), 0, 0);
  const source = { bitmap: canvas, width: img.width, height: img.height, size: bytes.byteLength };
  if (withThumb) {
    const thumb = await makeThumbnail(img.pixels, img.width, img.height, 42);
    source.thumbUrl = thumb.toDataURL('image/png');
  }
  return source;
}

/** 等比缩小成预览用的位图（水印尺寸都按图宽百分比算，等比缩小后观感一致） */
function downscale(bitmap, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

/** 把位图画进预览画布（画布尺寸随位图，显示尺寸由 CSS 控制） */
function drawToPreviewCanvas(canvas, bitmap) {
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
}

function clearPreviewCanvas(canvas) {
  canvas.width = 1;
  canvas.height = 1;
}

/** 选中某张图后载入预览底图（同路径复用，避免每次改参数都重新解码） */
async function selectForPreview(file) {
  state.selectedPath = file ? file.path : '';
  state.preview = null;
  renderList();
  if (!file) {
    clearPreviewCanvas(state.els.origCanvas);
    clearPreviewCanvas(state.els.newCanvas);
    state.els.previewName.textContent = '';
    state.els.previewHint.textContent = '添加图片后，点列表里的一张就能看到效果';
    return;
  }
  state.els.previewName.textContent = file.name;
  state.els.previewHint.textContent = '正在准备预览…';
  try {
    const source = await loadSource(file.path);
    if (state.selectedPath !== file.path) return; // 期间又选了别的图，丢弃这次结果
    state.preview = { path: file.path, bitmap: downscale(source.bitmap, PREVIEW_MAX_EDGE) };
    drawToPreviewCanvas(state.els.origCanvas, state.preview.bitmap);
    await refreshPreview();
  } catch (err) {
    state.els.previewHint.textContent = `预览失败：${err.message}`;
  }
}

/** 参数一改就重画「加水印后」那半边（带序号防止过期结果覆盖新结果） */
async function refreshPreview() {
  if (!state.preview) return;
  const token = ++state.previewToken;
  try {
    const { blob } = await renderWatermark({
      bitmap: state.preview.bitmap,
      config: { ...readParams(), format: 'png' }
    });
    if (token !== state.previewToken) return;
    const bitmap = await createImageBitmap(blob);
    if (token !== state.previewToken) {
      bitmap.close();
      return;
    }
    drawToPreviewCanvas(state.els.newCanvas, bitmap);
    bitmap.close();
    state.els.previewHint.textContent = `预览按最长边 ${PREVIEW_MAX_EDGE} 像素缩小绘制，实际输出保持原图尺寸`;
  } catch (err) {
    if (token !== state.previewToken) return;
    clearPreviewCanvas(state.els.newCanvas);
    state.els.previewHint.textContent = err.message;
  }
}

/** 输入过程中连续触发时只保留最后一次，避免白白重画 */
function schedulePreview() {
  if (state.previewTimer) clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(() => {
    state.previewTimer = null;
    refreshPreview();
  }, 120);
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
    li.className = 'wm-item' + (f.path === state.selectedPath ? ' is-selected' : '');
    li.dataset.index = String(index);

    const img = document.createElement('img');
    img.className = 'wm-item-thumb';
    img.src = f.thumbUrl;
    img.alt = '';
    li.appendChild(img);

    const main = document.createElement('div');
    main.className = 'wm-item-main';
    const name = document.createElement('div');
    name.className = 'wm-item-name';
    name.textContent = f.name;
    name.title = f.path;
    const meta = document.createElement('div');
    meta.className = 'wm-item-meta';
    meta.textContent = `${f.width} × ${f.height} ｜ 原始 ${fmtBytes(f.size)}`;
    main.appendChild(name);
    main.appendChild(meta);

    if (f.result) {
      const result = document.createElement('div');
      result.className = f.error ? 'wm-item-result is-error' : 'wm-item-result';
      result.textContent = f.result;
      main.appendChild(result);
    }
    li.appendChild(main);

    const del = document.createElement('button');
    del.className = 'wm-icon-btn';
    del.textContent = '×';
    del.title = '移除';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      removeFile(index);
    });
    li.appendChild(del);

    li.addEventListener('click', () => {
      if (state.selectedPath !== f.path) selectForPreview(f);
    });
    els.list.appendChild(li);
  });
}

function removeFile(index) {
  const removed = state.files[index];
  state.files.splice(index, 1);
  if (removed && removed.path === state.selectedPath) {
    const next = state.files[Math.min(index, state.files.length - 1)] || null;
    state.selectedPath = '';
    state.preview = null;
    if (next) selectForPreview(next);
    else {
      renderList();
      clearPreviewCanvas(state.els.origCanvas);
      clearPreviewCanvas(state.els.newCanvas);
      state.els.previewName.textContent = '';
      state.els.previewHint.textContent = '添加图片后，点列表里的一张就能看到效果';
    }
    return;
  }
  renderList();
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
    const source = await loadSource(p, { withThumb: true });
    state.files.push({
      path: p, name: info.name, baseName: info.baseName, dir: info.dir, ext,
      width: source.width, height: source.height, size: source.size,
      thumbUrl: source.thumbUrl, result: '', error: false
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
    state.ctx.setStatus(`已添加 ${added} 张${failures.length ? `，${failures.length} 项失败` : ''}，点列表里的图可看预览`);
    if (!state.selectedPath) await selectForPreview(state.files[0]);
  } else {
    state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的图片');
  }
}

async function openDialog() {
  const paths = await state.ctx.openWatermark();
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

/** 选印章图片（图片水印用） */
async function pickStamp() {
  const paths = await state.ctx.openWatermarkStamp();
  if (!paths || paths.length === 0) return;
  try {
    const info = await state.ctx.pathInfo(paths[0]);
    const source = await loadSource(paths[0], { withThumb: true });
    state.stamp = {
      path: paths[0], name: info.name,
      bitmap: source.bitmap, width: source.width, height: source.height
    };
    state.els.stampThumb.src = source.thumbUrl;
    state.els.stampThumb.hidden = false;
    state.els.stampName.textContent = `${info.name}（${source.width} × ${source.height}）`;
    state.ctx.setStatus(`印章已选择：${info.name}`);
    refreshParamState();
    await refreshPreview();
  } catch (err) {
    state.ctx.setStatus(`印章图片读取失败：${err.message}`);
  }
}

// —— 运行 ——

async function run() {
  if (state.busy) return;
  const files = state.files;
  if (files.length === 0) {
    state.ctx.setStatus('请先添加图片');
    return;
  }
  const params = readParams();
  if (params.type === 'text' && !String(params.text).trim()) {
    state.ctx.setStatus('请先填写水印文字');
    return;
  }
  if (params.type === 'image' && !state.stamp) {
    state.ctx.setStatus('请先选择印章图片');
    return;
  }

  state.busy = true;
  state.cancelRequested = false;
  state.taskIds = [];
  state.els.runBtn.disabled = true;
  state.els.runBtn.textContent = '加水印中…';
  state.els.cancelBtn.hidden = false;
  state.els.cancelBtn.disabled = false;
  state.els.clearBtn.disabled = true;

  const ctx = state.ctx;
  const outputDir = ctx.settings.getSettings().outputDir || undefined;
  const t0 = performance.now();

  for (const f of files) { f.result = ''; f.error = false; }
  renderList();

  // 任务归属队列：图片类走 io 通道（并发 2）；切走工具页（或被回收）任务照跑
  const jobs = files.map((f, index) => ({
    label: f.name,
    inputPaths: [f.path],
    outputDir,
    run: async ({ report, isCancelled }) => {
      if (isCancelled()) return { canceled: true };
      const step = `加水印 ${index + 1}/${files.length}：${f.name}`;
      report({ percent: 0, text: step });
      if (state && state.ctx.isActive()) state.ctx.showProgress(step, (index / files.length) * 100);
      try {
        const source = await loadSource(f.path);
        const { blob, width, height } = await renderWatermark({ bitmap: source.bitmap, config: params });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (isCancelled()) return { canceled: true };
        const path = await ctx.saveImageNextTo({
          sourcePath: f.path, targetDir: outputDir, baseName: `${f.baseName}_水印`, ext: '.png', bytes
        });
        f.result = `已保存 ｜ ${width}×${height} ｜ ${fmtBytes(bytes.byteLength)}`;
        f.error = false;
        if (state && state.ctx.isActive()) state.ctx.setInfo({ width, height, ms: Math.round(performance.now() - t0) });
        report({ percent: 100, text: f.result });
        if (state) renderList();
        return { ok: true, outputPaths: [path], outputDir };
      } catch (err) {
        f.result = `失败：${err.message}`;
        f.error = true;
        report({ percent: 100, text: f.result });
        if (state) renderList();
        return { ok: false, error: err.message };
      }
    }
  }));

  const ids = jobs.map((job) => ctx.tasks.enqueue({ toolId: 'watermark', toolName: '加水印', lane: 'io', ...job }));
  state.taskIds = ids;
  const settled = await Promise.all(ids.map((id) => ctx.tasks.waitFor(id)));

  if (!state) return; // 工具页已被回收：任务照跑完了，这里只跳过界面收尾
  state.taskIds = [];
  ctx.hideProgress();
  state.busy = false;
  state.cancelRequested = false;
  state.els.runBtn.disabled = false;
  state.els.runBtn.textContent = '开始加水印';
  state.els.cancelBtn.hidden = true;
  state.els.clearBtn.disabled = false;

  const done = settled.filter((t) => t && t.status === 'done').length;
  const failed = settled.filter((t) => t && t.status === 'failed').length;
  const canceledCount = settled.filter((t) => t && t.status === 'canceled').length;
  const failedTask = settled.find((t) => t && t.status === 'failed');
  const lastError = (failedTask && failedTask.error) || '';
  const doneTask = [...settled].reverse().find((t) => t && t.status === 'done' && t.output.paths.length);
  const lastPath = doneTask ? doneTask.output.paths[0] : '';

  if (canceledCount > 0) {
    state.ctx.setStatus(`已取消：成功 ${done} 张${failed ? `，失败 ${failed} 张` : ''}`);
  } else {
    state.ctx.setStatus(`加水印完成：成功 ${done} 张${failed ? `，失败 ${failed} 张（${lastError}）` : ''}`);
  }
  state.els.result.textContent = lastPath
    ? (outputDir ? `输出到：${outputDir}` : `输出：${lastPath}`)
    : '';
}

// —— 生命周期 ——

export function mount(container, ctx) {
  state = {
    ctx,
    els: null,
    listeners: [],
    files: [],
    busy: false,
    cancelRequested: false,
    taskIds: [],
    type: WATERMARK_DEFAULTS.type,
    position: WATERMARK_DEFAULTS.position,
    stamp: null,
    selectedPath: '',
    preview: null,
    previewToken: 0,
    previewTimer: null,
    container
  };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.wm-tool'),
    typeSeg: container.querySelector('#wmTypeSeg'),
    typeHint: container.querySelector('#wmTypeHint'),
    textRow: container.querySelector('#wmTextRow'),
    text: container.querySelector('#wmText'),
    stroke: container.querySelector('#wmStroke'),
    stampRow: container.querySelector('#wmStampRow'),
    stampBtn: container.querySelector('#wmStampBtn'),
    stampThumb: container.querySelector('#wmStampThumb'),
    stampName: container.querySelector('#wmStampName'),
    posGrid: container.querySelector('#wmPosGrid'),
    size: container.querySelector('#wmSize'),
    sizeUnit: container.querySelector('#wmSizeUnit'),
    opacity: container.querySelector('#wmOpacity'),
    rotation: container.querySelector('#wmRotation'),
    colorWrap: container.querySelector('#wmColorWrap'),
    color: container.querySelector('#wmColor'),
    drop: container.querySelector('#wmDrop'),
    addBtn: container.querySelector('#wmAddBtn'),
    addMore: container.querySelector('#wmAddMore'),
    listWrap: container.querySelector('#wmListWrap'),
    list: container.querySelector('#wmList'),
    count: container.querySelector('#wmCount'),
    origCanvas: container.querySelector('#wmOrigCanvas'),
    newCanvas: container.querySelector('#wmNewCanvas'),
    previewName: container.querySelector('#wmPreviewName'),
    previewHint: container.querySelector('#wmPreviewHint'),
    runBtn: container.querySelector('#wmRunBtn'),
    cancelBtn: container.querySelector('#wmCancelBtn'),
    clearBtn: container.querySelector('#wmClearBtn'),
    result: container.querySelector('#wmResult')
  };
  state.els = els;

  // 位置按钮：九宫格 3×3 + 「平铺」占右侧一整列
  for (const pos of WATERMARK_POSITIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = pos.value === 'tile' ? 'btn wm-pos-btn wm-pos-tile' : 'btn wm-pos-btn';
    btn.dataset.pos = pos.value;
    btn.textContent = pos.label;
    on(btn, 'click', () => {
      state.position = pos.value;
      refreshParamState();
      schedulePreview();
    });
    els.posGrid.appendChild(btn);
  }

  for (const btn of els.typeSeg.querySelectorAll('.wm-seg-btn')) {
    on(btn, 'click', () => {
      state.type = btn.dataset.type;
      refreshParamState();
      schedulePreview();
    });
  }

  on(els.stampBtn, 'click', pickStamp);
  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', run);
  on(els.cancelBtn, 'click', () => {
    // 取消本工具入队的任务（队列会在当前这张处理完后停下后续任务）
    state.cancelRequested = true;
    for (const id of state.taskIds) state.ctx.tasks.cancel(id);
    state.els.cancelBtn.disabled = true;
    state.ctx.setStatus('正在取消…（当前这张处理完就停）');
  });
  on(els.clearBtn, 'click', () => {
    state.files = [];
    state.selectedPath = '';
    state.preview = null;
    state.previewToken += 1;
    renderList();
    clearPreviewCanvas(els.origCanvas);
    clearPreviewCanvas(els.newCanvas);
    els.previewName.textContent = '';
    els.previewHint.textContent = '添加图片后，点列表里的一张就能看到效果';
    els.result.textContent = '';
    state.ctx.setStatus('已清空图片列表');
  });

  // 参数改动 → 立即刷新预览（大小只在失焦/回车时回写，免得打字打到一半被改掉）
  on(els.text, 'input', schedulePreview);
  on(els.stroke, 'change', schedulePreview);
  on(els.color, 'input', schedulePreview);
  on(els.opacity, 'input', schedulePreview);
  on(els.rotation, 'input', schedulePreview);
  on(els.size, 'input', schedulePreview);
  on(els.size, 'change', () => {
    refreshParamState();
    schedulePreview();
  });

  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);

  refreshParamState();
  renderList();
  clearPreviewCanvas(els.origCanvas);
  clearPreviewCanvas(els.newCanvas);
  els.previewHint.textContent = '添加图片后，点列表里的一张就能看到效果';
  state.ctx.setStatus('加水印：填好水印内容与位置，添加图片后点「开始加水印」（原图不动，结果存成新文件）');
}

export function unmount() {
  if (!state) return;
  if (state.previewTimer) clearTimeout(state.previewTimer);
  state.previewToken += 1; // 让在途的预览结果失效
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  state = null;
}
