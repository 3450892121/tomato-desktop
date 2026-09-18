// 工具：图片变清晰 —— 界面与交互
// 分层：本文件只做界面与流程编排；逐像素算法在 core/enhance.js（纯函数，可单测），
//       模糊（内核 ctx.filter = blur(Npx)）与放大（高质量重采样）在这里用 OffscreenCanvas 实现。
import { PRESETS, presetById, applyEnhance, outputExtFor, CUSTOM_DEFAULT } from './core/enhance.js';
import { decodeImageFromBytes, encodeImageToBytes, drawPixelsToCanvas } from '../../shared/imageio.js';

const PREVIEW_MAX = 900;                 // 预览最长边：预览只处理缩小后的小图，调参才能即时响应
const MAX_OUT_PIXELS = 40_000_000;       // 放大后的像素上限（与 shared/imageio.js 的解码上限一致）
const DROP_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'ico', 'avif', 'svg'];
const HEIC_EXTS = ['heic', 'heif'];

/** 自定义预设的滑杆定义（顺序即界面顺序） */
const SLIDERS = [
  { key: 'sharpen', label: '锐化强度', min: 0, max: 200, step: 1, unit: '%' },
  { key: 'radius', label: '半径', min: 0.5, max: 5, step: 0.1, unit: '' },
  { key: 'threshold', label: '阈值', min: 0, max: 32, step: 1, unit: '' },
  { key: 'denoise', label: '降噪', min: 0, max: 100, step: 1, unit: '%' },
  { key: 'brightness', label: '亮度', min: -100, max: 100, step: 1, unit: '' },
  { key: 'contrast', label: '对比度', min: -100, max: 100, step: 1, unit: '' },
  { key: 'saturation', label: '饱和度', min: -100, max: 100, step: 1, unit: '' }
];

const MARKUP = `
  <div class="enh-tool">
    <section class="card enh-controls">
      <div class="control-row">
        <label class="control-label" for="enhPreset">预设:</label>
        <select id="enhPreset" class="select"></select>
        <span class="control-hint" id="enhPresetHint"></span>
      </div>
      <div class="enh-params" id="enhParams" hidden></div>
      <div class="enh-note">锐化只是让边缘更分明，无法恢复已丢失的细节；「强力锐化」会放大噪点，噪点多的照片请用「照片降噪 + 轻锐化」。</div>
    </section>

    <main class="enh-main">
      <section class="card enh-preview">
        <div class="enh-preview-head">
          <div class="enh-toggle">
            <button class="btn btn-ghost is-active" id="enhBtnOriginal" type="button">原图</button>
            <button class="btn btn-ghost" id="enhBtnResult" type="button">处理后</button>
          </div>
          <span class="enh-preview-name" id="enhPreviewName">未选择图片</span>
          <span class="enh-spacer"></span>
          <span class="enh-preview-size" id="enhPreviewSize"></span>
        </div>
        <div class="enh-stage">
          <canvas class="enh-canvas" id="enhCanvas" hidden></canvas>
          <span class="enh-empty" id="enhEmpty">点列表里的一张图片，即可在这里对比效果（预览不会改动文件）</span>
        </div>
      </section>

      <section class="card enh-files" id="enhFiles">
        <div class="enh-drop" id="enhDrop">
          <button class="btn btn-primary btn-lg" id="enhAddBtn" data-add="1">添加图片</button>
          <div class="enh-hint">也可以把图片或整个文件夹拖进窗口；支持多选</div>
        </div>
        <div class="enh-list-wrap" id="enhListWrap" hidden>
          <div class="enh-list-head">
            <span id="enhListTitle">图片</span>
            <span class="enh-spacer"></span>
            <span id="enhListCount"></span>
            <button class="btn btn-ghost" id="enhAddMore" type="button">＋ 继续添加</button>
          </div>
          <ul class="enh-list" id="enhList"></ul>
        </div>
      </section>
    </main>

    <footer class="enh-actions">
      <button class="btn btn-primary btn-run" id="enhRunBtn" data-run="1">开始变清晰</button>
      <button class="btn btn-plain" id="enhClearBtn" data-clear="1">清空</button>
      <div class="enh-result" id="enhResult"></div>
    </footer>
  </div>
`;

let state = null;

/** 统一收集监听器，unmount 时逐一摘掉 */
function on(el, type, handler) {
  el.addEventListener(type, handler);
  state.listeners.push([el, type, handler]);
}

/** 参数区的监听器单独记账：参数区会随预设切换重建，重建前先摘干净 */
function onParams(el, type, handler) {
  el.addEventListener(type, handler);
  state.paramListeners.push([el, type, handler]);
}

function clearParamListeners() {
  for (const [el, type, handler] of state.paramListeners) el.removeEventListener(type, handler);
  state.paramListeners = [];
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** 字节数 → 人类可读（如 1.2 MB） */
function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 体积变化百分比文本（输出比输入小 → 负数） */
function sizeDeltaText(before, after) {
  if (!before) return '';
  const pct = Math.round((1 - after / before) * 100);
  return `（${pct > 0 ? '-' : pct < 0 ? '+' : '±'}${Math.abs(pct)}%）`;
}

/** 等比缩放到最长边不超过 maxSize（只缩小） */
function fitScale(width, height, maxSize) {
  const max = Math.max(width, height);
  if (max <= maxSize) return { width, height, scaled: false };
  const k = maxSize / max;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), scaled: true };
}

/** 高质量重采样（放大 2× / 预览缩小都用它） */
function resizePixels(pixels, width, height, targetWidth, targetHeight) {
  const src = new OffscreenCanvas(width, height);
  src.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  const dst = new OffscreenCanvas(targetWidth, targetHeight);
  const dctx = dst.getContext('2d', { willReadFrequently: true });
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(src, 0, 0, targetWidth, targetHeight);
  return dctx.getImageData(0, 0, targetWidth, targetHeight).data;
}

/** 生成模糊图（内核 ctx.filter，GPU 加速；core 不直接依赖 DOM，所以由界面层注入） */
function blurPixels(pixels, width, height, radius) {
  const src = new OffscreenCanvas(width, height);
  src.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  const dst = new OffscreenCanvas(width, height);
  const dctx = dst.getContext('2d', { willReadFrequently: true });
  dctx.filter = `blur(${radius}px)`;
  dctx.drawImage(src, 0, 0);
  return dctx.getImageData(0, 0, width, height).data;
}

// —— 参数区 ——

function renderParams() {
  const { els } = state;
  const preset = presetById(state.preset);
  els.presetHint.textContent = preset.hint;
  clearParamListeners();

  if (state.preset !== 'custom') {
    els.params.hidden = true;
    els.params.innerHTML = '';
    return;
  }

  els.params.hidden = false;
  els.params.innerHTML = SLIDERS.map((s) => `
    <div class="enh-param">
      <span class="control-label">${s.label}</span>
      <input class="enh-range" type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${state.custom[s.key]}" />
      <span class="enh-val" data-val="${s.key}"></span>
    </div>`).join('');

  for (const s of SLIDERS) {
    const input = els.params.querySelector(`[data-key="${s.key}"]`);
    const valEl = els.params.querySelector(`[data-val="${s.key}"]`);
    const show = (v) => {
      const num = Number(v);
      valEl.textContent = s.unit === '%' ? `${num}%` : (num > 0 ? `+${num}` : `${num}`);
    };
    show(input.value);
    onParams(input, 'input', () => {
      state.custom[s.key] = Number(input.value);
      show(input.value);
      schedulePreview();
    });
  }
}

function readParams() {
  if (state.preset !== 'custom') return { ...presetById(state.preset) };
  return { ...state.custom };
}

function updateRunButton() {
  state.els.runBtn.textContent = state.busy ? '处理中…' : '开始变清晰';
  state.els.runBtn.disabled = state.busy;
}

// —— 预览（只处理当前选中项） ——

function schedulePreview() {
  if (state.previewTimer) clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(() => {
    state.previewTimer = null;
    if (!state) return;
    void refreshPreviewResult();
  }, 200);
}

function clearPreview() {
  state.preview = null;
  state.els.canvas.hidden = true;
  state.els.empty.hidden = false;
  state.els.previewName.textContent = '未选择图片';
  state.els.previewSize.textContent = '';
}

async function selectFile(index) {
  state.selected = index;
  renderList();
  await loadPreview();
}

async function loadPreview() {
  const f = state.files[state.selected];
  if (!f) {
    clearPreview();
    return;
  }
  const token = ++state.previewToken;
  state.els.previewName.textContent = f.name;
  state.els.previewSize.textContent = '正在生成预览…';
  try {
    const bytes = f.bytes || (f.bytes = await state.ctx.readFile(f.path));
    const img = await decodeImageFromBytes(bytes);
    const fit = fitScale(img.width, img.height, PREVIEW_MAX);
    const base = fit.scaled ? resizePixels(img.pixels, img.width, img.height, fit.width, fit.height) : img.pixels;
    // 处理期间可能已经切走工具（unmount 会把 state 置空）或换了选中项
    if (!state || token !== state.previewToken) return;
    state.preview = { width: fit.width, height: fit.height, original: base, result: base };
    state.els.previewSize.textContent = `${img.width} × ${img.height}`;
    await refreshPreviewResult();
  } catch (err) {
    if (!state || token !== state.previewToken) return;
    clearPreview();
    state.ctx.setStatus(`预览失败：${err.message}`);
  }
}

async function refreshPreviewResult() {
  if (!state) return;
  const p = state.preview;
  if (!p) return;
  const token = ++state.previewToken;
  try {
    const out = await applyEnhance(p.original, p.width, p.height, readParams(), blurPixels);
    if (!state || token !== state.previewToken || !state.preview) return;
    state.preview.result = out;
    drawPreview();
  } catch (err) {
    if (!state || token !== state.previewToken) return;
    state.ctx.setStatus(`预览失败：${err.message}`);
  }
}

function drawPreview() {
  const p = state.preview;
  if (!p) return;
  const pixels = state.previewMode === 'result' ? p.result : p.original;
  state.els.canvas.hidden = false;
  state.els.empty.hidden = true;
  drawPixelsToCanvas(state.els.canvas, pixels, p.width, p.height);
}

function setPreviewMode(mode) {
  state.previewMode = mode;
  const isResult = mode === 'result';
  state.els.btnOriginal.classList.toggle('is-active', !isResult);
  state.els.btnResult.classList.toggle('is-active', isResult);
  drawPreview();
}

// —— 文件列表 ——

function renderList() {
  const { els } = state;
  const files = state.files;
  els.listWrap.hidden = files.length === 0;
  els.drop.hidden = files.length > 0;
  els.listCount.textContent = files.length ? `共 ${files.length} 张` : '';
  els.list.innerHTML = '';

  files.forEach((f, index) => {
    const li = document.createElement('li');
    li.className = 'enh-item' + (index === state.selected ? ' is-selected' : '');

    const main = document.createElement('div');
    main.className = 'enh-item-main';
    const name = document.createElement('div');
    name.className = 'enh-item-name';
    name.textContent = f.name;
    name.title = f.path;
    const meta = document.createElement('div');
    meta.className = 'enh-item-meta';
    meta.textContent = f.result
      ? f.result.text
      : `${(f.ext || '').replace('.', '').toUpperCase()} · 待处理（点一下可预览）`;
    if (f.result && !f.result.ok) meta.classList.add('is-error');
    main.appendChild(name);
    main.appendChild(meta);
    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'enh-item-actions';
    const del = document.createElement('button');
    del.className = 'enh-icon-btn';
    del.type = 'button';
    del.textContent = '×';
    del.title = '移除';
    on(del, 'click', (event) => {
      event.stopPropagation();
      state.files.splice(index, 1);
      if (state.selected === index) state.selected = Math.min(index, state.files.length - 1);
      renderList();
      void loadPreview();
    });
    actions.appendChild(del);
    li.appendChild(actions);

    on(li, 'click', () => { void selectFile(index); });
    els.list.appendChild(li);
  });
}

// —— 添加文件（含文件夹拖入，展开一层） ——

function isHeic(ext) {
  return HEIC_EXTS.includes(String(ext || '').replace('.', '').toLowerCase());
}

async function addOne(path) {
  const info = await state.ctx.pathInfo(path);
  const ext = (info.ext || '').toLowerCase();
  const bare = ext.replace('.', '');
  if (isHeic(bare)) throw new Error('暂不支持 HEIC/HEIF 等格式（内核无法解码）');
  if (!DROP_EXTS.includes(bare)) throw new Error('不是支持的图片格式');
  if (state.files.some((f) => f.path === path)) return false;

  // 不在这里读文件内容：添加几十张原图时逐个整读太浪费，真正用时（预览 / 处理）再读
  state.files.push({
    path, name: info.name, baseName: info.baseName, dir: info.dir, ext, bytes: null, result: null
  });
  if (state.selected < 0) state.selected = state.files.length - 1;
  return true;
}

async function addFromPaths(paths) {
  const failures = [];
  let added = 0;
  let selectionChanged = false;

  for (const p of paths) {
    try {
      const info = await state.ctx.pathInfo(p);
      if (info.isDirectory) {
        // 文件夹只展开一层（简单为上，避免误扫整个盘）
        const list = await state.ctx.listFiles(p, DROP_EXTS);
        if (list.length === 0) { failures.push(`${info.name}：文件夹里没有支持的图片`); continue; }
        for (const sub of list) {
          try {
            if (await addOne(sub)) { added += 1; selectionChanged = true; }
          } catch (err) {
            failures.push(`${sub.split(/[\\/]/).pop()}：${err.message}`);
          }
        }
      } else if (await addOne(p)) {
        added += 1;
        selectionChanged = true;
      }
    } catch (err) {
      failures.push(`${p.split(/[\\/]/).pop()}：${err.message}`);
    }
  }

  renderList();
  if (selectionChanged && state.preview === null) await loadPreview();
  if (added > 0) state.ctx.setStatus(`已添加 ${added} 张${failures.length ? `，${failures.length} 张失败` : ''}`);
  else state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的图片');
}

async function openDialog() {
  // 用 openImageAny：比 openImages 多支持 GIF/ICO/AVIF/SVG，增强工具没有理由把它们挡在外面
  const paths = await state.ctx.openImageAny();
  if (paths && paths.length > 0) await addFromPaths(paths);
}

async function onDrop(event) {
  event.preventDefault();
  const dropped = Array.from(event.dataTransfer ? event.dataTransfer.files : []);
  const paths = [];
  for (const file of dropped) {
    const p = state.ctx.getPathForFile(file);
    if (p) paths.push(p);
  }
  if (paths.length > 0) await addFromPaths(paths);
}

// —— 批量处理 ——

async function run() {
  if (state.busy) return;
  if (state.files.length === 0) {
    state.ctx.setStatus('请先添加图片');
    return;
  }
  const params = readParams();
  const outputDir = state.ctx.settings.getSettings().outputDir || undefined;
  const session = state; // 中途切走工具时 state 会被置空，用它判断本趟任务是否还活着

  state.busy = true;
  updateRunButton();
  const t0 = Date.now();
  let done = 0;
  let failed = 0;
  let lastError = '';
  let lastPath = '';
  let scaleSkipped = 0;

  try {
    for (let i = 0; i < state.files.length; i += 1) {
      if (state !== session) return;
      const f = state.files[i];
      state.ctx.showProgress(`处理 ${i + 1}/${state.files.length}：${f.name}`, (i / state.files.length) * 100);
      await nextFrame();
      try {
        const bytes = await state.ctx.readFile(f.path);
        const img = await decodeImageFromBytes(bytes);
        let pixels = img.pixels;
        let width = img.width;
        let height = img.height;

        // 清晰放大 2×：只放大不缩小；放大后像素超过上限时跳过，避免内存不足
        if (params.scale > 1) {
          const nw = Math.round(width * params.scale);
          const nh = Math.round(height * params.scale);
          if (nw * nh <= MAX_OUT_PIXELS) {
            pixels = resizePixels(pixels, width, height, nw, nh);
            width = nw;
            height = nh;
          } else {
            scaleSkipped += 1;
          }
        }

        state.ctx.showProgress(`${f.name}：正在增强…`, ((i + 0.4) / state.files.length) * 100);
        await nextFrame();
        const out = await applyEnhance(pixels, width, height, params, blurPixels);

        const ext = outputExtFor(f.ext);
        const outBytes = await encodeImageToBytes(out, width, height, {
          format: ext === '.jpg' ? 'jpg' : 'png',
          quality: 95
        });
        const outPath = await state.ctx.saveNextTo({
          sourcePath: f.path,
          targetDir: outputDir,
          baseName: `${f.baseName}_清晰`,
          ext,
          bytes: outBytes
        });

        f.result = {
          ok: true,
          text: `${formatBytes(bytes.byteLength)} → ${formatBytes(outBytes.byteLength)}${sizeDeltaText(bytes.byteLength, outBytes.byteLength)}（已处理）`
            + (ext === '.png' && outBytes.byteLength > bytes.byteLength ? ' ｜ 说明：PNG 无损，体积变大属正常' : ''),
          outPath
        };
        f.bytes = null; // 释放缓存的原始字节（预览需要时会重新读）
        lastPath = outPath;
        done += 1;
        state.ctx.setInfo({ width, height, ms: Date.now() - t0 });
      } catch (err) {
        failed += 1;
        lastError = err.message;
        f.result = { ok: false, text: `失败：${err.message}` };
        console.error('[enhance] 处理失败', f.name, err);
      }
      renderList();
    }
  } finally {
    if (state === session) {
      state.ctx.hideProgress();
      state.busy = false;
      updateRunButton();
    }
  }

  if (state !== session) return;
  const skipNote = scaleSkipped > 0 ? `，${scaleSkipped} 张因放大后过大已按原尺寸处理` : '';
  state.ctx.setStatus(`处理完成：成功 ${done} 个${failed ? `，失败 ${failed} 个（${lastError}）` : ''}${skipNote}`);
  state.els.result.textContent = lastPath ? `输出：${lastPath}` : '';
  if (state.preview) await refreshPreviewResult();
}

// —— 生命周期 ——

export function mount(container, ctx) {
  state = {
    ctx,
    container,
    listeners: [],
    paramListeners: [],
    els: null,
    preset: PRESETS[0].id,
    custom: { ...CUSTOM_DEFAULT },
    files: [],
    selected: -1,
    preview: null,
    previewMode: 'original',
    previewToken: 0,
    previewTimer: null,
    busy: false
  };
  container.innerHTML = MARKUP;

  const els = {
    params: container.querySelector('#enhParams'),
    presetSel: container.querySelector('#enhPreset'),
    presetHint: container.querySelector('#enhPresetHint'),
    btnOriginal: container.querySelector('#enhBtnOriginal'),
    btnResult: container.querySelector('#enhBtnResult'),
    previewName: container.querySelector('#enhPreviewName'),
    previewSize: container.querySelector('#enhPreviewSize'),
    canvas: container.querySelector('#enhCanvas'),
    empty: container.querySelector('#enhEmpty'),
    drop: container.querySelector('#enhDrop'),
    addBtn: container.querySelector('#enhAddBtn'),
    addMore: container.querySelector('#enhAddMore'),
    listWrap: container.querySelector('#enhListWrap'),
    list: container.querySelector('#enhList'),
    listCount: container.querySelector('#enhListCount'),
    runBtn: container.querySelector('#enhRunBtn'),
    clearBtn: container.querySelector('#enhClearBtn'),
    result: container.querySelector('#enhResult'),
    root: container.querySelector('.enh-tool')
  };
  state.els = els;

  els.presetSel.innerHTML = '';
  for (const p of PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    els.presetSel.appendChild(opt);
  }
  els.presetSel.value = state.preset;

  on(els.presetSel, 'change', () => {
    state.preset = els.presetSel.value;
    renderParams();
    schedulePreview();
  });
  on(els.btnOriginal, 'click', () => setPreviewMode('original'));
  on(els.btnResult, 'click', () => setPreviewMode('result'));
  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', run);
  on(els.clearBtn, 'click', () => {
    state.files = [];
    state.selected = -1;
    renderList();
    clearPreview();
    state.els.result.textContent = '';
    state.ctx.setStatus('已清空图片列表');
  });
  on(els.root, 'dragover', (event) => event.preventDefault());
  on(els.root, 'drop', onDrop);

  renderParams();
  renderList();
  clearPreview();
  updateRunButton();
  ctx.setStatus('图片变清晰：添加图片后选预设，点「开始变清晰」（预览不会改动文件）');
}

export function unmount() {
  if (!state) return;
  if (state.previewTimer) clearTimeout(state.previewTimer);
  for (const [el, type, handler] of [...state.listeners, ...state.paramListeners]) {
    el.removeEventListener(type, handler);
  }
  state = null;
}