// 工具：长图拼接 —— 界面与交互
// 分层：本文件做界面与流程编排；尺寸归一 / 布局计算在 core/plan.js（纯逻辑，可 node 单测）；
//       绘制与编码的 composeStitch 也放在本文件（只用 OffscreenCanvas，不碰 DOM，便于自动化测试直接调用）。
// 图片解码与缩略图复用 shared/imageio.js。
import { decodeImageFromBytes, makeThumbnailFromBytes } from '../../shared/imageio.js';
import {
  ALIGN_PRESETS,
  STITCH_DIRECTIONS,
  baseNameOf,
  computeLayout,
  estimateOutputBytes,
  formatSize,
  normalizeSizes
} from './core/plan.js';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.ico', '.avif'];

const FORMATS = [
  { value: 'png', label: 'PNG（无损，推荐）' },
  { value: 'jpg', label: 'JPG（省体积）' }
];

/** 统一尺寸下拉（「统一宽度 / 统一高度」的文案随拼接方向变化，见 syncDirectionLabels） */
const SIZE_MODES = [
  { value: 'none', label: '保持原样' },
  { value: 'unify', label: '统一宽度' }
];

/** 间距 / 外边距上限（像素），防止误输入把画布撑爆 */
const MAX_SPACING = 500;
/** 预览区在还没入文档、量不到尺寸时的兜底可用尺寸（px） */
const PREVIEW_FALLBACK = { w: 320, h: 150 };
/** 拼接底色（间距与外边距露出来的部分） */
const BG_COLOR = '#ffffff';

const MARKUP = `
  <div class="st-tool">
    <section class="card st-controls">
      <div class="control-row">
        <span class="control-label">拼接方向</span>
        <select class="select st-w-mode" id="stDirection"></select>
        <span class="control-label">统一尺寸</span>
        <select class="select st-w-mode" id="stMode"></select>
        <input class="input st-w-num" id="stTarget" type="number" min="1" max="20000" value="0" disabled />
        <span class="control-hint" id="stTargetUnit">像素</span>
        <span class="control-hint" id="stTargetHint"></span>
      </div>
      <div class="control-row">
        <span class="control-label">间距</span>
        <input class="input st-w-num" id="stGap" type="number" min="0" max="500" value="0" />
        <span class="control-hint">像素（图片之间的空隙）</span>
        <span class="control-label st-gap">对齐</span>
        <select class="select st-w-mode" id="stAlign"></select>
        <span class="control-label st-gap">外边距</span>
        <input class="input st-w-num" id="stMargin" type="number" min="0" max="500" value="0" />
        <span class="control-hint">像素（四周留白）</span>
      </div>
      <div class="control-row">
        <span class="control-label">输出格式</span>
        <select class="select st-w-mode" id="stFormat"></select>
        <span class="control-label st-gap">画质</span>
        <input class="input st-w-num" id="stQuality" type="number" min="1" max="100" value="92" />
        <span class="control-hint" id="stFormatHint"></span>
      </div>
    </section>

    <main class="card st-files">
      <div class="st-drop" id="stDrop">
        <button class="btn btn-primary btn-lg" id="stAddBtn" data-add="1">添加图片</button>
        <div class="st-drop-hint">也可以把图片或整个文件夹拖进窗口；支持多选</div>
        <div class="st-drop-hint">拼接顺序 = 下面列表的顺序（从第 1 张开始依次排下去）</div>
      </div>
      <div class="st-list-wrap" id="stListWrap" hidden>
        <div class="st-list-head">
          <span>拼接顺序（从上到下 / 从左到右）</span>
          <span class="st-spacer"></span>
          <span class="control-hint" id="stCount"></span>
          <button class="btn btn-ghost" id="stAddMore" data-add="1" type="button">＋ 继续添加</button>
        </div>
        <ul class="st-list" id="stList"></ul>
      </div>

      <div class="st-preview-wrap">
        <div class="st-preview-head">
          <span>排布预览</span>
          <span class="control-hint" id="stPreviewHint"></span>
        </div>
        <div class="st-preview" id="stPreview"></div>
        <div class="control-hint st-limit" id="stLimitHint"></div>
      </div>
    </main>

    <footer class="st-actions">
      <button class="btn btn-primary" id="stRunBtn" data-run="1">开始拼接</button>
      <button class="btn btn-plain" id="stCancelBtn" data-cancel="1" disabled>取消</button>
      <button class="btn btn-plain" id="stClearBtn" data-clear="1">清空</button>
      <div class="st-result" id="stResult"></div>
    </footer>
  </div>
`;

let state = null;

function on(el, type, handler) {
  el.addEventListener(type, handler);
  state.listeners.push([el, type, handler]);
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
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

// —— 绘制与编码（不碰 DOM，自动化测试可直接调用） ——

/**
 * 把多张图拼成一张长图。
 * @param {{meta?: Array<{width?: number, height?: number}>, loadImage?: (index: number) => Promise<{pixels: Uint8ClampedArray, width: number, height: number}>,
 *          direction?: string, mode?: string, targetSize?: number, gap?: number, align?: string, margin?: number,
 *          format?: 'png'|'jpg', quality?: number, onProgress?: (done: number, total: number) => void, shouldCancel?: () => boolean}} options
 *          meta 按拼接顺序给出原图尺寸（用来算布局，不必先解码全部图片）；loadImage 在需要时逐张解码，避免一次性占满内存。
 * @returns {Promise<{bytes?: Uint8Array, width: number, height: number, sizes: Array<{w: number, h: number}>, layout: object, drawn: number, cancelled: boolean}>}
 */
export async function composeStitch({
  meta = [],
  loadImage,
  direction = 'vertical',
  mode = 'none',
  targetSize = 0,
  gap = 0,
  align = 'center',
  margin = 0,
  format = 'png',
  quality = 92,
  onProgress,
  shouldCancel
} = {}) {
  const sizes = normalizeSizes({ items: meta, direction, mode, targetSize });
  const layout = computeLayout({ sizes, direction, gap, align, margin });
  if (layout.limitExceeded) throw new Error(layout.reason);

  const { canvasW, canvasH, offsets } = layout;
  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const dctx = canvas.getContext('2d');
  dctx.fillStyle = BG_COLOR; // 间距 / 外边距 / 透明区域统一铺白底（JPG 不支持透明）
  dctx.fillRect(0, 0, canvasW, canvasH);
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = 'high'; // 缩放图用高质量重采样，长图才不糊

  const total = Math.min(sizes.length, offsets.length);
  let drawn = 0;
  for (let i = 0; i < total; i += 1) {
    if (shouldCancel && shouldCancel()) {
      return { width: canvasW, height: canvasH, sizes, layout, drawn, cancelled: true };
    }
    if (onProgress) onProgress(i + 1, total);
    await nextFrame(); // 让进度条真的画出来，而不是整个循环跑完才刷新

    const img = await loadImage(i);
    const src = new OffscreenCanvas(img.width, img.height);
    src.getContext('2d').putImageData(new ImageData(img.pixels, img.width, img.height), 0, 0);
    const o = offsets[i];
    dctx.drawImage(src, o.x, o.y, o.w, o.h);
    drawn += 1;
  }

  const type = format === 'jpg' ? 'image/jpeg' : 'image/png';
  // 用 convertToBlob 直接编码，省掉一份整张画布的 getImageData 拷贝（大长图内存吃紧）
  const blob = await canvas.convertToBlob({
    type,
    quality: format === 'jpg' ? clampInt(quality, 1, 100, 92) / 100 : undefined
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, width: canvasW, height: canvasH, sizes, layout, drawn, cancelled: false };
}

// —— 参数区 ——

function readParams() {
  const { els } = state;
  return {
    direction: els.direction.value === 'horizontal' ? 'horizontal' : 'vertical',
    mode: els.mode.value === 'unify' ? 'unify' : 'none',
    targetSize: clampInt(els.target.value, 1, 20000, 0),
    gap: clampInt(els.gap.value, 0, MAX_SPACING, 0),
    margin: clampInt(els.margin.value, 0, MAX_SPACING, 0),
    align: ALIGN_PRESETS.some((a) => a.value === els.align.value) ? els.align.value : 'center',
    format: els.format.value === 'jpg' ? 'jpg' : 'png',
    quality: clampInt(els.quality.value, 1, 100, 92)
  };
}

/** 「统一宽度 / 统一高度」的文案跟着拼接方向变，用户才不会看错 */
function syncDirectionLabels() {
  const vertical = state.els.direction.value !== 'horizontal';
  const opt = state.els.mode.querySelector('option[value="unify"]');
  if (opt) opt.textContent = vertical ? '统一宽度' : '统一高度';
  state.els.targetUnit.textContent = '像素';
  state.els.targetHint.textContent = vertical
    ? '把所有图缩到同一宽度再拼（只缩不放，避免放大变糊）'
    : '把所有图缩到同一高度再拼（只缩不放，避免放大变糊）';
}

/** 当前列表里「最大宽度 / 最大高度」——作为统一尺寸的默认值 */
function maxNaturalSize(direction) {
  const files = state.files;
  if (files.length === 0) return 0;
  const vertical = direction !== 'horizontal';
  return Math.max(...files.map((f) => (vertical ? f.width : f.height)));
}

/**
 * 文件/方向变化时，把「当前最大值」预填进统一尺寸输入框。
 * 只在用户没自己改过（输入框为空或还是上次自动填的值）时才覆盖，不抢用户的输入。
 */
function syncAutoTarget() {
  const { els } = state;
  const auto = maxNaturalSize(els.direction.value);
  const current = els.target.value.trim();
  if (current === '' || current === '0' || current === String(state.autoTarget)) {
    els.target.value = auto > 0 ? String(auto) : '';
    state.autoTarget = auto;
  }
}

function refreshParamState() {
  const { els } = state;
  const params = readParams();
  const unify = params.mode === 'unify';
  els.target.disabled = !unify;
  els.targetUnit.textContent = '像素';
  els.quality.disabled = params.format === 'png';
  els.formatHint.textContent = params.format === 'png'
    ? 'PNG 无损、文字更清晰；截图类长图很合适'
    : 'JPG 体积更小，但不支持透明、文字边缘略糊；画质越低体积越小';
  syncDirectionLabels();
}

// —— 列表 ——

function renderList() {
  const { els } = state;
  const files = state.files;
  els.listWrap.hidden = files.length === 0;
  els.drop.hidden = files.length > 0;
  els.count.textContent = files.length ? `共 ${files.length} 张 → 合成 1 张长图` : '';
  els.list.innerHTML = '';

  files.forEach((f, index) => {
    const li = document.createElement('li');
    li.className = 'st-item';

    const order = document.createElement('span');
    order.className = 'st-item-order';
    order.textContent = `${index + 1}`;
    li.appendChild(order);

    const img = document.createElement('img');
    img.className = 'st-item-thumb';
    img.src = f.thumbUrl;
    img.alt = '';
    li.appendChild(img);

    const main = document.createElement('div');
    main.className = 'st-item-main';
    const name = document.createElement('div');
    name.className = 'st-item-name';
    name.textContent = f.name;
    name.title = f.path;
    const meta = document.createElement('div');
    meta.className = 'st-item-meta';
    meta.textContent = `${f.width} × ${f.height}`;
    main.appendChild(name);
    main.appendChild(meta);
    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'st-item-actions';
    // 列表每次重绘都会换掉这些按钮，所以直接绑在元素上、不登记到 state.listeners（避免旧元素被引用住不放）
    const mkBtn = (text, title, disabled, handler) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'st-icon-btn';
      b.textContent = text;
      b.title = title;
      b.disabled = disabled;
      b.addEventListener('click', handler);
      return b;
    };
    actions.appendChild(mkBtn('↑', '上移（更靠前）', index === 0 || state.busy, () => moveFile(index, -1)));
    actions.appendChild(mkBtn('↓', '下移（更靠后）', index === files.length - 1 || state.busy, () => moveFile(index, 1)));
    actions.appendChild(mkBtn('×', '移除', state.busy, () => {
      files.splice(index, 1);
      renderList();
      refreshDerived();
    }));
    li.appendChild(actions);

    els.list.appendChild(li);
  });
}

function moveFile(index, delta) {
  const files = state.files;
  const to = index + delta;
  if (to < 0 || to >= files.length) return;
  const [one] = files.splice(index, 1);
  files.splice(to, 0, one);
  renderList();
  refreshDerived();
  state.ctx.setStatus(`已把「${one.name}」移到第 ${to + 1} 位`);
}

// —— 预览（示意排布 + 预计输出尺寸 / 超限提示） ——

function renderPreview() {
  const { els } = state;
  els.preview.innerHTML = '';

  if (state.files.length === 0) {
    els.previewHint.textContent = '添加图片后，这里显示拼接后的排布与预计输出尺寸';
    els.limitHint.textContent = '';
    els.limitHint.classList.remove('is-danger');
    state.limitExceeded = false;
    els.runBtn.disabled = state.busy;
    return;
  }

  const p = readParams();
  const sizes = normalizeSizes({ items: state.files, direction: p.direction, mode: p.mode, targetSize: p.targetSize });
  const layout = computeLayout({ sizes, direction: p.direction, gap: p.gap, align: p.align, margin: p.margin });

  const availW = els.preview.clientWidth || PREVIEW_FALLBACK.w;
  const availH = els.preview.clientHeight || PREVIEW_FALLBACK.h;
  const scale = Math.min(availW / layout.canvasW, availH / layout.canvasH, 1) || 1;

  const inner = document.createElement('div');
  inner.className = 'st-preview-canvas';
  inner.style.width = `${Math.max(1, Math.round(layout.canvasW * scale))}px`;
  inner.style.height = `${Math.max(1, Math.round(layout.canvasH * scale))}px`;

  state.files.forEach((f, i) => {
    const o = layout.offsets[i];
    if (!o) return;
    const box = document.createElement('div');
    box.className = 'st-preview-box';
    box.style.left = `${o.x * scale}px`;
    box.style.top = `${o.y * scale}px`;
    box.style.width = `${Math.max(1, o.w * scale)}px`;
    box.style.height = `${Math.max(1, o.h * scale)}px`;
    box.style.backgroundImage = `url(${f.thumbUrl})`;
    box.title = `第 ${i + 1} 张：${f.name}（成品里 ${o.w} × ${o.h}）`;
    inner.appendChild(box);
  });
  els.preview.appendChild(inner);

  els.previewHint.textContent = `预计输出 ${layout.canvasW} × ${layout.canvasH} 像素`
    + ` ｜ 约 ${formatSize(estimateOutputBytes(layout))}（粗略估算）`
    + ` ｜ ${state.files.length} 张合成 1 张`;

  state.limitExceeded = layout.limitExceeded;
  els.limitHint.textContent = layout.limitExceeded ? layout.reason : '';
  els.limitHint.classList.toggle('is-danger', layout.limitExceeded);
  els.runBtn.disabled = layout.limitExceeded || state.busy;
}

/** 列表 / 参数一变就走这里：刷新预览与按钮状态 */
function refreshDerived() {
  renderPreview();
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
    // 添加阶段只要尺寸与缩略图，不摊开整图像素（真正拼接时会重新解码）
    const { thumb, width, height } = await makeThumbnailFromBytes(bytes, 42);
    state.files.push({
      path: p,
      name: info.name,
      baseName: info.baseName,
      dir: info.dir,
      ext,
      width,
      height,
      size: bytes.byteLength,
      thumbUrl: thumb.toDataURL('image/png')
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
  syncAutoTarget();
  refreshDerived();
  if (added > 0) {
    state.ctx.setStatus(`已添加 ${added} 张（拼接顺序＝列表顺序，可用 ↑↓ 调整）${failures.length ? `，${failures.length} 项失败` : ''}`);
  } else {
    state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的图片');
  }
}

async function openDialog() {
  if (state.busy) return;
  const paths = await state.ctx.openStitch();
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

// —— 运行 ——

function setBusy(busy) {
  const { els } = state;
  state.busy = busy;
  els.runBtn.textContent = busy ? '拼接中…' : '开始拼接';
  els.cancelBtn.disabled = !busy;
  els.clearBtn.disabled = busy;
  els.addBtn.disabled = busy;
  els.addMore.disabled = busy;
  els.runBtn.disabled = busy || state.limitExceeded;
  renderList(); // 忙碌时禁掉列表里的移动 / 删除按钮
}

async function run() {
  if (state.busy) return;
  const files = state.files;
  if (files.length === 0) {
    state.ctx.setStatus('请先添加图片');
    return;
  }

  const params = readParams();
  // 先按已知尺寸预检一次：超限就直接拦住，不进入绘制（避免画到一半崩掉）
  const preSizes = normalizeSizes({ items: files, direction: params.direction, mode: params.mode, targetSize: params.targetSize });
  const preLayout = computeLayout({ sizes: preSizes, direction: params.direction, gap: params.gap, align: params.align, margin: params.margin });
  if (preLayout.limitExceeded) {
    state.ctx.setStatus(preLayout.reason);
    return;
  }

  state.cancelRequested = false;
  state.taskIds = [];
  setBusy(true);
  const t0 = performance.now();
  const ctx = state.ctx;
  const fileCount = files.length;
  let composed = null; // 拼接结果（宽高等），供界面收尾显示

  // 任务归属队列：整批图合成 1 张长图是一次操作，所以算一个任务；切走工具页任务照跑
  const taskId = ctx.tasks.enqueue({
    toolId: 'stitch',
    toolName: '长图拼接',
    label: `长图拼接（${fileCount} 张）`,
    lane: 'io',
    inputPaths: files.map((f) => f.path),
    run: async ({ report, isCancelled }) => {
      try {
        const r = await composeStitch({
          meta: files.map((f) => ({ width: f.width, height: f.height })),
          loadImage: async (i) => {
            const bytes = await ctx.readFile(files[i].path);
            return decodeImageFromBytes(bytes);
          },
          direction: params.direction,
          mode: params.mode,
          targetSize: params.targetSize,
          gap: params.gap,
          align: params.align,
          margin: params.margin,
          format: params.format,
          quality: params.quality,
          onProgress: (done, total) => {
            const text = `拼接中 ${done}/${total} 张：${files[done - 1].name}`;
            report({ percent: (done / total) * 100, text });
            if (state && state.ctx.isActive()) state.ctx.showProgress(text, (done / total) * 100);
          },
          shouldCancel: isCancelled
        });

        if (r.cancelled) return { canceled: true };

        const outputDir = ctx.settings.getSettings().outputDir || undefined;
        const ext = params.format === 'jpg' ? '.jpg' : '.png';
        // 输出名沿用第一张图：多次拼接同一批图时更好认，且与源图放在一起不突兀
        const baseName = `${baseNameOf(files[0].path)}_拼接`;
        const saved = await ctx.saveImageNextTo({
          sourcePath: files[0].path, targetDir: outputDir, baseName, ext, bytes: r.bytes
        });
        composed = r;
        report({ percent: 100, text: `拼接完成 ${r.width} × ${r.height}` });
        return { ok: true, outputPaths: [saved], outputDir };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
  });
  state.taskIds = [taskId];
  const task = await ctx.tasks.waitFor(taskId);

  if (!state) return; // 工具页已被回收：任务照跑完了，这里只跳过界面收尾
  state.taskIds = [];
  ctx.hideProgress();
  setBusy(false);

  if (task && task.status === 'done' && composed) {
    const sizeText = formatSize(composed.bytes.length);
    const ms = Math.round(performance.now() - t0);
    state.ctx.setInfo({ width: composed.width, height: composed.height, ms });
    state.els.result.textContent = `输出：${task.output.paths[0]}（${composed.width} × ${composed.height}，${sizeText}）`;
    state.ctx.setStatus(`拼接完成：${fileCount} 张合成 1 张长图，${composed.width} × ${composed.height}，约 ${sizeText}，耗时 ${ms} ms`);
  } else if (task && task.status === 'canceled') {
    state.ctx.setStatus('已取消拼接（没有保存文件）');
    state.els.result.textContent = '已取消，没有保存文件';
  } else {
    const message = (task && task.error) || '未知错误';
    state.ctx.setStatus(`拼接失败：${message}`);
    state.els.result.textContent = `失败：${message}`;
  }
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
    limitExceeded: false,
    autoTarget: 0,
    container
  };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.st-tool'),
    direction: container.querySelector('#stDirection'),
    mode: container.querySelector('#stMode'),
    target: container.querySelector('#stTarget'),
    targetUnit: container.querySelector('#stTargetUnit'),
    targetHint: container.querySelector('#stTargetHint'),
    gap: container.querySelector('#stGap'),
    align: container.querySelector('#stAlign'),
    margin: container.querySelector('#stMargin'),
    format: container.querySelector('#stFormat'),
    quality: container.querySelector('#stQuality'),
    formatHint: container.querySelector('#stFormatHint'),
    drop: container.querySelector('#stDrop'),
    addBtn: container.querySelector('#stAddBtn'),
    addMore: container.querySelector('#stAddMore'),
    listWrap: container.querySelector('#stListWrap'),
    list: container.querySelector('#stList'),
    count: container.querySelector('#stCount'),
    preview: container.querySelector('#stPreview'),
    previewHint: container.querySelector('#stPreviewHint'),
    limitHint: container.querySelector('#stLimitHint'),
    runBtn: container.querySelector('#stRunBtn'),
    cancelBtn: container.querySelector('#stCancelBtn'),
    clearBtn: container.querySelector('#stClearBtn'),
    result: container.querySelector('#stResult')
  };
  state.els = els;

  fillSelect(els.direction, STITCH_DIRECTIONS);
  fillSelect(els.mode, SIZE_MODES);
  fillSelect(els.align, ALIGN_PRESETS);
  fillSelect(els.format, FORMATS);

  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', run);
  on(els.cancelBtn, 'click', () => {
    if (!state.busy) return;
    state.cancelRequested = true;
    for (const id of state.taskIds) state.ctx.tasks.cancel(id);
    state.ctx.setStatus('正在取消拼接…');
  });
  on(els.clearBtn, 'click', () => {
    state.files = [];
    state.autoTarget = 0;
    els.target.value = '';
    els.result.textContent = '';
    renderList();
    refreshDerived();
    state.ctx.setStatus('已清空图片列表');
  });
  on(els.direction, 'change', () => {
    syncDirectionLabels();
    syncAutoTarget();
    refreshDerived();
  });
  on(els.mode, 'change', () => {
    syncAutoTarget();
    refreshParamState();
    refreshDerived();
  });
  for (const el of [els.target, els.gap, els.margin, els.align, els.format, els.quality]) {
    on(el, 'input', () => {
      refreshParamState();
      refreshDerived();
    });
    on(el, 'change', () => {
      refreshParamState();
      refreshDerived();
    });
  }
  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);

  refreshParamState();
  renderList();
  refreshDerived();
  // 挂载这一刻页面还没进文档（量不到预览区尺寸），下一帧再画一次预览
  requestAnimationFrame(() => {
    if (state) refreshDerived();
  });
  state.ctx.setStatus('长图拼接：添加图片后点「开始拼接」，列表里的多张图会合成 1 张长图');
}

export function unmount() {
  if (!state) return;
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  state = null;
}