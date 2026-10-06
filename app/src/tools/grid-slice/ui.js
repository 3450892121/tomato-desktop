// 工具：九宫格切图 —— 界面与交互
// 分层：本文件做界面、预览与批量流程编排；切分计算 / 编号 / 估算在 core/plan.js（纯逻辑，可 node 单测）；
//       图片解码、缩略图与编码复用 shared/imageio.js。
// sliceImage 额外导出：与界面用的是同一条裁切/编码链路，自动化测试直接复用它，避免测到「另一套实现」。
import { decodeImageFromBytes, makeThumbnailFromBytes } from '../../shared/imageio.js';
import {
  GRID_PRESETS,
  MAX_LINES,
  baseNameOf,
  computeCells,
  estimateTotalBytes,
  formatSize,
  namingForCells
} from './core/plan.js';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.ico', '.avif'];

const ORDERS = [
  { value: 'row', label: '按行（左上→右下，默认）' },
  { value: 'column', label: '按列（先上后下、逐列）' }
];

const FORMATS = [
  { value: 'png', label: 'PNG（无损，推荐）' },
  { value: 'jpg', label: 'JPG（体积小）' }
];

/** 预览画布的最大显示尺寸（够看清切法，又不用为大图等太久） */
const PREVIEW_MAX_W = 520;
const PREVIEW_MAX_H = 380;

const MARKUP = `
  <div class="gs-tool">
    <section class="card gs-controls">
      <div class="control-row">
        <span class="control-label">切分方式</span>
        <select class="select gs-w-mode" id="gsPreset"></select>
        <span class="gs-inline" id="gsCustomWrap" hidden>
          <input class="input gs-w-num" id="gsRows" type="number" min="1" max="20" value="3" />
          <span class="control-hint">行</span>
          <span class="control-label">×</span>
          <input class="input gs-w-num" id="gsCols" type="number" min="1" max="20" value="3" />
          <span class="control-hint">列（最多 20 × 20）</span>
        </span>
        <span class="control-hint" id="gsPresetHint"></span>
      </div>

      <div class="control-row">
        <span class="control-label">切缝宽度</span>
        <input class="input gs-w-num" id="gsGap" type="number" min="0" max="200" value="0" />
        <span class="control-hint">像素（0 = 不留缝）</span>
        <span class="control-label gs-gap">外圈留白</span>
        <input class="input gs-w-num" id="gsMargin" type="number" min="0" max="200" value="0" />
        <span class="control-hint">像素</span>
        <span class="control-label gs-gap">切缝颜色</span>
        <input class="input gs-color" id="gsSeamColor" type="color" value="#ffffff" />
        <span class="control-hint">切缝宽度大于 0 时，会描在每块朝内的边上</span>
      </div>

      <div class="control-row">
        <span class="control-label">编号方式</span>
        <select class="select gs-w-mode" id="gsOrder"></select>
        <span class="control-label gs-gap">输出格式</span>
        <select class="select gs-w-mode" id="gsFormat"></select>
        <span class="control-label gs-gap">画质</span>
        <input class="input gs-w-num" id="gsQuality" type="number" min="1" max="100" value="92" />
        <span class="control-hint" id="gsQualityHint">仅 JPG 有效；越低体积越小</span>
      </div>
    </section>

    <div class="gs-body">
      <main class="card gs-files">
        <div class="gs-drop" id="gsDrop">
          <button class="btn btn-primary btn-lg" id="gsAddBtn" data-add="1" type="button">添加图片</button>
          <div class="gs-drop-hint">也可以把图片或整个文件夹拖进窗口；支持多选</div>
        </div>
        <div class="gs-list-wrap" id="gsListWrap" hidden>
          <div class="gs-list-head">
            <span>图片</span>
            <span class="gs-spacer"></span>
            <span class="control-hint" id="gsCount"></span>
            <button class="btn btn-ghost" id="gsAddMore" data-add="1" type="button">＋ 继续添加</button>
          </div>
          <ul class="gs-list" id="gsList"></ul>
        </div>
      </main>

      <aside class="card gs-preview">
        <div class="gs-preview-head">
          <span>切分预览</span>
          <span class="gs-spacer"></span>
          <span class="control-hint" id="gsPreviewName">未选择图片</span>
        </div>
        <div class="gs-stage">
          <canvas class="gs-canvas" id="gsCanvas" hidden></canvas>
          <span class="gs-empty" id="gsEmpty">点列表里的一张图片，这里会画出切分网格（预览不会改动文件）</span>
        </div>
        <div class="gs-preview-info" id="gsPreviewInfo"></div>
        <div class="gs-warn" id="gsWarn" hidden></div>
      </aside>
    </div>

    <footer class="gs-actions">
      <button class="btn btn-primary" id="gsRunBtn" data-run="1" type="button">开始切图</button>
      <button class="btn btn-plain" id="gsCancelBtn" data-cancel="1" type="button" hidden>取消</button>
      <button class="btn btn-plain" id="gsClearBtn" data-clear="1" type="button">清空</button>
      <div class="gs-result" id="gsResult"></div>
    </footer>
  </div>
`;

let state = null;

function on(el, type, handler) {
  el.addEventListener(type, handler);
  state.listeners.push([el, type, handler]);
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

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 读主题变量（预览网格线 / 编号底色跟随浅色/深色，不写死色值） */
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return String(v || '').trim() || fallback;
}

// —— 参数区 ——

function readParams() {
  const { els } = state;
  const preset = GRID_PRESETS.find((p) => p.value === els.preset.value) || GRID_PRESETS[0];
  const custom = preset.value === 'custom';
  const rows = custom ? clampNum(els.rows.value, 1, MAX_LINES, 3) : preset.rows;
  const cols = custom ? clampNum(els.cols.value, 1, MAX_LINES, 3) : preset.cols;
  return {
    preset: preset.value,
    rows,
    cols,
    gap: clampNum(els.gap.value, 0, 200, 0),
    margin: clampNum(els.margin.value, 0, 200, 0),
    order: els.order.value === 'column' ? 'column' : 'row',
    format: els.format.value === 'jpg' ? 'jpg' : 'png',
    quality: clampNum(els.quality.value, 1, 100, 92),
    seamColor: els.seamColor.value || '#ffffff'
  };
}

function refreshParamState() {
  const { els } = state;
  const custom = els.preset.value === 'custom';
  els.customWrap.hidden = !custom;
  els.rows.disabled = !custom;
  els.cols.disabled = !custom;

  const preset = GRID_PRESETS.find((p) => p.value === els.preset.value) || GRID_PRESETS[0];
  els.presetHint.textContent = custom ? '自定义：行 × 列，最多 20 × 20' : `共 ${preset.rows * preset.cols} 块`;

  const fmt = els.format.value;
  els.quality.disabled = fmt !== 'jpg';
  els.qualityHint.textContent = fmt === 'jpg' ? '仅 JPG 有效；越低体积越小' : 'PNG 无损，无需画质';
  refreshPreview();
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
    li.className = `gs-item${f.path === state.selectedPath ? ' is-selected' : ''}`;
    li.dataset.path = f.path;

    const img = document.createElement('img');
    img.className = 'gs-item-thumb';
    img.src = f.thumbUrl;
    img.alt = '';
    li.appendChild(img);

    const main = document.createElement('div');
    main.className = 'gs-item-main';
    const name = document.createElement('div');
    name.className = 'gs-item-name';
    name.textContent = f.name;
    name.title = f.path;
    const meta = document.createElement('div');
    meta.className = 'gs-item-meta';
    meta.textContent = `${f.width} × ${f.height} ｜ 原始 ${formatSize(f.size)}`;
    main.appendChild(name);
    main.appendChild(meta);

    if (f.result) {
      const result = document.createElement('div');
      result.className = f.error ? 'gs-item-result is-error' : 'gs-item-result';
      result.textContent = f.result;
      main.appendChild(result);
    }
    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'gs-item-actions';
    const del = document.createElement('button');
    del.className = 'gs-icon-btn';
    del.type = 'button';
    del.textContent = '×';
    del.title = '移除';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      state.files.splice(index, 1);
      if (state.selectedPath === f.path) {
        state.selectedPath = state.files[0] ? state.files[0].path : '';
        refreshPreview();
      }
      renderList();
      refreshRunState();
    });
    actions.appendChild(del);
    li.appendChild(actions);

    li.addEventListener('click', () => selectForPreview(f));
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
    // 添加阶段只要尺寸与缩略图，不摊开整图像素（真正切图时会重新解码）
    const { thumb, width, height } = await makeThumbnailFromBytes(bytes, 42);
    state.files.push({
      path: p, name: info.name, baseName: info.baseName || baseNameOf(p), dir: info.dir, ext,
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
            failures.push(`${baseNameOf(one)}：${err.message}`);
          }
        }
      } else {
        await pushOne(p);
      }
    } catch (err) {
      failures.push(`${baseNameOf(p)}：${err.message}`);
    }
  }

  if (!state.selectedPath && state.files.length > 0) state.selectedPath = state.files[0].path;
  renderList();
  refreshRunState();
  if (added > 0) {
    state.ctx.setStatus(`已添加 ${added} 张${failures.length ? `，${failures.length} 项失败` : ''}，点列表里的图可看切分预览`);
    await refreshPreview();
  } else {
    state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的图片');
  }
}

async function openDialog() {
  const paths = await state.ctx.openGridSlice();
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

// —— 预览 ——

function selectForPreview(file) {
  state.selectedPath = file.path;
  renderList();
  refreshPreview();
}

async function refreshPreview() {
  if (!state) return;
  const { els } = state;
  const file = state.files.find((f) => f.path === state.selectedPath);
  if (!file) {
    state.preview = null;
    els.canvas.hidden = true;
    els.empty.hidden = false;
    els.previewName.textContent = '未选择图片';
    els.previewInfo.textContent = '';
    els.warn.hidden = true;
    refreshRunState();
    return;
  }

  const params = readParams();
  const token = (state.previewToken += 1);
  try {
    const bytes = await state.ctx.readFile(file.path);
    const img = await decodeImageFromBytes(bytes);
    if (!state || token !== state.previewToken) return; // 期间又换了选择：这次结果作废
    const plan = computeCells({ width: img.width, height: img.height, rows: params.rows, cols: params.cols, gap: params.gap, margin: params.margin });
    state.preview = { plan, params, width: img.width, height: img.height };
    drawPreview(img, plan, params);
    els.previewName.textContent = `${file.name}（${img.width} × ${img.height}）`;
    updatePreviewInfo(plan, params);
  } catch (err) {
    if (!state || token !== state.previewToken) return;
    state.preview = null;
    els.canvas.hidden = true;
    els.empty.hidden = false;
    els.previewName.textContent = file.name;
    els.previewInfo.textContent = `预览失败：${err.message}`;
    els.warn.hidden = true;
  }
  refreshRunState();
}

function drawPreview(img, plan, params) {
  const { els } = state;
  const scale = Math.min(1, PREVIEW_MAX_W / img.width, PREVIEW_MAX_H / img.height);
  const cw = Math.max(1, Math.round(img.width * scale));
  const ch = Math.max(1, Math.round(img.height * scale));

  const canvas = els.canvas;
  canvas.width = cw;
  canvas.height = ch;
  const c = canvas.getContext('2d');
  const px = (v) => v * scale;

  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext('2d').putImageData(new ImageData(img.pixels, img.width, img.height), 0, 0);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, 0, 0, cw, ch);
  canvas.hidden = false;
  els.empty.hidden = true;

  if (plan.cells.length === 0) return;

  // 被扣掉、不参与切图的像素带：用切缝颜色铺一层，明确「这些地方会丢」
  if (params.gap > 0) {
    c.fillStyle = params.seamColor;
    c.globalAlpha = 0.85;
    for (let col = 1; col < params.cols; col += 1) {
      const x0 = params.margin + (col - 1) * (plan.outW + params.gap) + plan.outW;
      const x1 = params.margin + col * (plan.outW + params.gap);
      c.fillRect(px(x0), px(params.margin), Math.max(1, px(x1 - x0)), px(img.height - params.margin * 2));
    }
    for (let row = 1; row < params.rows; row += 1) {
      const y0 = params.margin + (row - 1) * (plan.outH + params.gap) + plan.outH;
      const y1 = params.margin + row * (plan.outH + params.gap);
      c.fillRect(px(params.margin), px(y0), px(img.width - params.margin * 2), Math.max(1, px(y1 - y0)));
    }
    c.globalAlpha = 1;
  }

  // 网格线 + 编号（编号与输出文件名一致，方便对号入座）
  const lineColor = cssVar('--color-primary', '#ff5a4e');
  const chipColor = cssVar('--color-primary', '#ff5a4e');
  const chipText = cssVar('--color-text-inverse', '#ffffff');
  c.strokeStyle = lineColor;
  c.lineWidth = 1;
  const showLabel = px(plan.outW) >= 30 && px(plan.outH) >= 22;
  c.font = `${cssVar('--font-size-sm', '13px')}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const cell of plan.cells) {
    c.strokeRect(px(cell.sx) + 0.5, px(cell.sy) + 0.5, Math.max(1, px(cell.sw) - 1), Math.max(1, px(cell.sh) - 1));
    if (!showLabel) continue;
    const number = params.order === 'column' ? cell.col * params.rows + cell.row + 1 : cell.index;
    const cx = px(cell.sx + cell.sw / 2);
    const cy = px(cell.sy + cell.sh / 2);
    c.fillStyle = chipColor;
    c.fillRect(cx - 11, cy - 8, 22, 16);
    c.fillStyle = chipText;
    c.fillText(String(number), cx, cy + 0.5);
  }
}

function updatePreviewInfo(plan, params) {
  const { els } = state;
  if (plan.cells.length === 0) {
    els.previewInfo.textContent = `按 ${params.rows} × ${params.cols} 切分：无法执行`;
    els.warn.textContent = plan.warnings.join('；');
    els.warn.hidden = plan.warnings.length === 0;
    return;
  }
  const est = estimateTotalBytes({ outW: plan.outW, outH: plan.outH, count: plan.cells.length, format: params.format });
  const orderText = params.order === 'column' ? '按列' : '按行';
  els.previewInfo.textContent = `共 ${plan.cells.length} 块 ｜ 每块 ${plan.outW} × ${plan.outH} ｜ ${orderText}编号 ｜ 输出 ${plan.cells.length} 个文件（约 ${formatSize(est.total)}）`;
  els.warn.textContent = plan.warnings.join('；');
  els.warn.hidden = plan.warnings.length === 0;
}

function refreshRunState() {
  const { els } = state;
  if (!els) return;
  const blocked = !state.files.length || !!(state.preview && state.preview.plan.cells.length === 0);
  els.runBtn.disabled = state.busy || blocked;
  els.runBtn.title = blocked && state.preview && state.preview.plan.cells.length === 0 ? state.preview.plan.warnings[0] || '' : '';
}

// —— 运行 ——

/**
 * 按切分方案裁出每一块（与界面用的是同一条链路；导出供自动化测试直接复用）。
 * @param {Uint8ClampedArray} pixels
 * @param {number} width
 * @param {number} height
 * @param {{rows:number, cols:number, gap?:number, margin?:number, format?:'png'|'jpg', quality?:number, seamColor?:string}} options
 * @returns {Promise<{plan: object, parts: Array<{index:number,row:number,col:number,width:number,height:number,bytes:Uint8Array}>}>}
 */
export async function sliceImage(pixels, width, height, options = {}) {
  const {
    rows, cols,
    gap = 0,
    margin = 0,
    format = 'png',
    quality = 92,
    seamColor = ''
  } = options;

  const plan = computeCells({ width, height, rows, cols, gap, margin });
  if (plan.cells.length === 0) throw new Error(plan.warnings[0] || '图片太小，无法切分');

  const src = new OffscreenCanvas(width, height);
  src.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);

  // 切缝颜色：只在「块朝内的边」描色，宽度取切缝的一半（两块相邻时合起来正好是整条缝宽）；
  // 上限再卡一刀，切缝特别大时也保证块里还剩内容可画（不会把画布画成负尺寸）
  const half = Math.max(0, Math.floor((Math.min(plan.outW, plan.outH) - 1) / 2));
  const band = gap > 0 && seamColor ? Math.min(Math.max(1, Math.round(gap / 2)), half) : 0;
  const parts = [];

  for (const cell of plan.cells) {
    const left = cell.col > 0 ? band : 0;
    const right = cell.col < cols - 1 ? band : 0;
    const top = cell.row > 0 ? band : 0;
    const bottom = cell.row < rows - 1 ? band : 0;

    const canvas = new OffscreenCanvas(plan.outW, plan.outH);
    const c = canvas.getContext('2d');
    if (format === 'jpg') {
      // JPG 不支持透明：先铺白底，透明像素才不会变成黑块
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, plan.outW, plan.outH);
    }
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(src, cell.sx, cell.sy, cell.sw, cell.sh, left, top, plan.outW - left - right, plan.outH - top - bottom);

    if (band > 0) {
      c.fillStyle = seamColor;
      if (left) c.fillRect(0, 0, left, plan.outH);
      if (right) c.fillRect(plan.outW - right, 0, right, plan.outH);
      if (top) c.fillRect(0, 0, plan.outW, top);
      if (bottom) c.fillRect(0, plan.outH - bottom, plan.outW, bottom);
    }

    const blob = await canvas.convertToBlob({
      type: format === 'jpg' ? 'image/jpeg' : 'image/png',
      quality: format === 'jpg' ? Math.max(0, Math.min(100, quality)) / 100 : undefined
    });
    parts.push({
      index: cell.index, row: cell.row, col: cell.col,
      width: plan.outW, height: plan.outH,
      bytes: new Uint8Array(await blob.arrayBuffer())
    });
  }
  return { plan, parts };
}

async function run() {
  if (state.busy) return;
  const files = state.files;
  if (files.length === 0) {
    state.ctx.setStatus('请先添加图片');
    return;
  }
  const params = readParams();

  state.busy = true;
  state.cancelRequested = false;
  state.taskIds = [];
  state.els.runBtn.disabled = true;
  state.els.runBtn.textContent = '切图中…';
  state.els.cancelBtn.hidden = false;
  state.els.cancelBtn.disabled = false;
  state.els.clearBtn.disabled = true;

  const ctx = state.ctx;
  const outputDir = ctx.settings.getSettings().outputDir || undefined;
  const ext = params.format === 'jpg' ? '.jpg' : '.png';
  const t0 = performance.now();

  for (const f of files) { f.result = ''; f.error = false; f.fileCount = 0; }
  renderList();

  // 任务归属队列：图片类走 io 通道（并发 2）；每张图（→ N 个切片文件）算一个任务
  const jobs = files.map((f, index) => ({
    label: f.name,
    inputPaths: [f.path],
    outputDir,
    run: async ({ report, isCancelled }) => {
      if (isCancelled()) return { canceled: true };
      const step = `切图 ${index + 1}/${files.length}：${f.name}`;
      report({ percent: 0, text: step });
      if (state && state.ctx.isActive()) state.ctx.showProgress(step, (index / files.length) * 100);
      try {
        const bytes = await ctx.readFile(f.path);
        const img = await decodeImageFromBytes(bytes);
        const precheck = computeCells({ width: img.width, height: img.height, rows: params.rows, cols: params.cols, gap: params.gap, margin: params.margin });
        if (precheck.warnings.length > 0) throw new Error(precheck.warnings[0]);
        const names = namingForCells({ baseName: f.baseName, rows: params.rows, cols: params.cols, order: params.order });
        const { plan, parts } = await sliceImage(img.pixels, img.width, img.height, params);

        const outPaths = [];
        for (const part of parts) {
          if (isCancelled()) return { canceled: true };
          const saved = await ctx.saveImageNextTo({
            sourcePath: f.path, targetDir: outputDir, baseName: names[part.index - 1], ext, bytes: part.bytes
          });
          outPaths.push(saved);
        }
        f.result = `已切出 ${outPaths.length} 块 ｜ 每块 ${plan.outW} × ${plan.outH}`;
        f.error = false;
        f.fileCount = outPaths.length;
        if (state && state.ctx.isActive()) state.ctx.setInfo({ width: plan.outW, height: plan.outH, ms: Math.round(performance.now() - t0) });
        report({ percent: 100, text: f.result });
        if (state) renderList();
        return { ok: true, outputPaths: outPaths, outputDir };
      } catch (err) {
        f.result = `失败：${err.message}`;
        f.error = true;
        report({ percent: 100, text: f.result });
        if (state) renderList();
        return { ok: false, error: err.message };
      }
    }
  }));

  const ids = jobs.map((job) => ctx.tasks.enqueue({ toolId: 'grid-slice', toolName: '九宫格切图', lane: 'io', ...job }));
  state.taskIds = ids;
  const settled = await Promise.all(ids.map((id) => ctx.tasks.waitFor(id)));

  if (!state) return; // 工具页已被回收：任务照跑完了，这里只跳过界面收尾
  state.taskIds = [];
  ctx.hideProgress();
  state.busy = false;
  state.cancelRequested = false;
  state.els.runBtn.textContent = '开始切图';
  state.els.cancelBtn.hidden = true;
  state.els.clearBtn.disabled = false;
  refreshRunState();

  const doneCount = settled.filter((t) => t && t.status === 'done').length;
  const failedCount = settled.filter((t) => t && t.status === 'failed').length;
  const canceledCount = settled.filter((t) => t && t.status === 'canceled').length;
  const failedTask = settled.find((t) => t && t.status === 'failed');
  const lastError = (failedTask && failedTask.error) || '';
  const filesOut = settled.reduce((n, t) => n + (t && t.status === 'done' ? t.output.paths.length : 0), 0);
  const lastDone = [...settled].reverse().find((t) => t && t.status === 'done' && t.output.paths.length);
  const lastPath = lastDone ? lastDone.output.paths[0] : '';

  const head = canceledCount > 0 ? '已取消' : '切图完成';
  state.ctx.setStatus(`${head}：成功 ${doneCount} 张${failedCount ? `，失败 ${failedCount} 张（${lastError}）` : ''}，共输出 ${filesOut} 个文件`);
  state.els.result.textContent = lastPath
    ? (outputDir ? `输出到：${outputDir}（每张图 ${params.rows * params.cols} 个文件）` : `输出：${lastPath} 等 ${filesOut} 个文件`)
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
    selectedPath: '',
    preview: null,
    previewToken: 0,
    container
  };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.gs-tool'),
    preset: container.querySelector('#gsPreset'),
    presetHint: container.querySelector('#gsPresetHint'),
    customWrap: container.querySelector('#gsCustomWrap'),
    rows: container.querySelector('#gsRows'),
    cols: container.querySelector('#gsCols'),
    gap: container.querySelector('#gsGap'),
    margin: container.querySelector('#gsMargin'),
    seamColor: container.querySelector('#gsSeamColor'),
    order: container.querySelector('#gsOrder'),
    format: container.querySelector('#gsFormat'),
    quality: container.querySelector('#gsQuality'),
    qualityHint: container.querySelector('#gsQualityHint'),
    drop: container.querySelector('#gsDrop'),
    addBtn: container.querySelector('#gsAddBtn'),
    addMore: container.querySelector('#gsAddMore'),
    listWrap: container.querySelector('#gsListWrap'),
    list: container.querySelector('#gsList'),
    count: container.querySelector('#gsCount'),
    canvas: container.querySelector('#gsCanvas'),
    empty: container.querySelector('#gsEmpty'),
    previewName: container.querySelector('#gsPreviewName'),
    previewInfo: container.querySelector('#gsPreviewInfo'),
    warn: container.querySelector('#gsWarn'),
    runBtn: container.querySelector('#gsRunBtn'),
    cancelBtn: container.querySelector('#gsCancelBtn'),
    clearBtn: container.querySelector('#gsClearBtn'),
    result: container.querySelector('#gsResult')
  };
  state.els = els;

  fillSelect(els.preset, GRID_PRESETS);
  els.preset.value = '3x3';
  fillSelect(els.order, ORDERS);
  fillSelect(els.format, FORMATS);

  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', run);
  on(els.cancelBtn, 'click', () => {
    if (state.busy) {
      state.cancelRequested = true;
      for (const id of state.taskIds) state.ctx.tasks.cancel(id);
      state.els.cancelBtn.disabled = true;
      state.ctx.setStatus('正在取消…（当前这张切完就停）');
    }
  });
  on(els.clearBtn, 'click', () => {
    state.files = [];
    state.selectedPath = '';
    state.preview = null;
    els.result.textContent = '';
    renderList();
    refreshPreview();
    state.ctx.setStatus('已清空图片列表');
  });
  on(els.preset, 'change', refreshParamState);
  on(els.rows, 'change', refreshParamState);
  on(els.cols, 'change', refreshParamState);
  on(els.gap, 'change', refreshParamState);
  on(els.margin, 'change', refreshParamState);
  on(els.seamColor, 'change', refreshPreview);
  on(els.order, 'change', refreshPreview);
  on(els.format, 'change', refreshParamState);
  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);

  refreshParamState();
  renderList();
  refreshRunState();
  state.ctx.setStatus('九宫格切图：添加图片 → 调切分方式 → 看预览 → 开始切图（原图不动，切好的小块存到原图旁边）');
}

export function unmount() {
  if (!state) return;
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  state = null;
}