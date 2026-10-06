// 工具：文字识别（OCR）—— 界面与流程
//
// 分层：本文件只做界面与流程编排；
//   core/convert.js     识别结果 → 文本 / 框 / PDF 坐标换算（纯逻辑）
//   core/preprocess.js  扫描件增强（去灰底 / 纠偏 / 锐化，纯像素算法）
//   core/docx.js        最小 OOXML 打包成 .docx
//   core/searchable.js  叠隐形文字层做成「可搜索 PDF」
//   shared/pdfops.js    pdfjs 渲染与「扫描件瘦身」（跨工具复用能力，不 import 其它工具）
//
// 引擎：OCR 跑在主进程（ctx.ocrStatus / ocrRecognize / ocrFont），加装包放软件目录 addons/ocr。
//       模型缺失 → 禁用运行并给出放置路径；中文字体缺失 → 只保留「纯文本」输出。
import {
  PDF_COMPRESS_PRESETS, presetOf, openPdfDoc, renderPdfPage, compressPdf
} from '../../shared/pdfops.js';
import { decodeImageFromBytes, encodeImageToBytes } from '../../shared/imageio.js';
import { linesToText, pagesToText, linesToPlainRows, linesToFragments, friendlyOcrMessage } from './core/convert.js';
import { planPreprocess, applyPreprocess, unrotateBox } from './core/preprocess.js';
import { linesToDocx, pagesToDocxRows } from './core/docx.js';
import { imagesToPdf, linesToSearchablePdf } from './core/searchable.js';

/** 输出类型（「Word」与「可搜索 PDF」都需要中文字体加装包） */
const OUTPUT_MODES = [
  { value: 'pdf', label: '可搜索 PDF（能搜索、能复制，原貌不变）' },
  { value: 'txt', label: '纯文本 (.txt)' },
  { value: 'docx', label: 'Word 文档 (.docx)' },
  { value: 'both', label: '纯文本 + 可搜索 PDF' }
];

/** 支持的图片扩展名（与主进程 openOcr 的对话框一致） */
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif', '.avif', '.ico', '.svg'];
/** 图片输入时的识别渲染倍率（原生像素，1px = 1pt 装订成 PDF） */
const IMAGE_SCALE = 1;
/** PDF 页面的识别渲染倍率：2× ≈ 144DPI（实测识别率与耗时的平衡点） */
const PDF_SCALE = 2;

const MARKUP = `
  <div class="ocr-tool">
    <section class="card ocr-controls">
      <div class="ocr-params">
        <div class="ocr-param">
          <label class="control-label" for="ocrMode">输出内容:</label>
          <select class="select ocr-mode" id="ocrMode"></select>
        </div>
        <div class="ocr-param">
          <span class="control-label">识别语言:</span>
          <span class="field-hint">自动识别（中文 / 英文 / 日文 / 繁体，单模型，无需选择）</span>
        </div>
      </div>
      <div class="ocr-params">
        <span class="control-label">扫描件增强:</span>
        <label class="field-check"><input type="checkbox" id="ocrBinarize" checked /> 去灰底</label>
        <label class="field-check"><input type="checkbox" id="ocrDeskew" checked /> 自动纠偏</label>
        <label class="field-check"><input type="checkbox" id="ocrSharpen" /> 锐化</label>
        <span class="ocr-steps" id="ocrSteps"></span>
      </div>
      <div class="ocr-params">
        <label class="field-check"><input type="checkbox" id="ocrCompress" /> 扫描件瘦身</label>
        <select class="select ocr-preset" id="ocrPreset"></select>
        <label class="field-check"><input type="checkbox" id="ocrGray" /> 转黑白</label>
        <span class="field-hint" id="ocrCompressHint">仅对 PDF 生效：先压小再识别，输出的可搜索 PDF 也小</span>
      </div>
      <div class="ocr-note" id="ocrNote">正在检测文字识别引擎…</div>
    </section>

    <main class="card ocr-files" id="ocrFiles">
      <div class="ocr-drop" id="ocrDrop">
        <button class="btn btn-primary btn-lg" data-add="1" id="ocrAddBtn">添加图片或 PDF</button>
        <div class="ocr-drop-hint">也可以把图片 / 扫描版 PDF 直接拖进窗口；支持多选，PDF 会逐页识别</div>
      </div>
      <div class="ocr-list-wrap" id="ocrListWrap" hidden>
        <div class="ocr-list-head">
          <span id="ocrListTitle">待识别文件</span>
          <span class="ocr-spacer"></span>
          <span id="ocrListCount"></span>
          <button class="btn btn-ghost" data-add="1" id="ocrAddMore" type="button">＋ 继续添加</button>
        </div>
        <div class="ocr-body">
          <ul class="ocr-list" id="ocrList"></ul>
          <div class="ocr-preview" id="ocrPreview" hidden>
            <div class="ocr-preview-head">
              <span id="ocrPreviewTitle" class="ocr-preview-title"></span>
              <span class="ocr-spacer"></span>
              <button class="btn btn-ghost ocr-mini" id="ocrPrevPage" type="button">上一页</button>
              <span class="ocr-page-label" id="ocrPageLabel"></span>
              <button class="btn btn-ghost ocr-mini" id="ocrNextPage" type="button">下一页</button>
              <button class="btn btn-ghost ocr-mini" id="ocrCopyText" type="button">复制文字</button>
            </div>
            <div class="ocr-preview-body">
              <div class="ocr-canvas-wrap" id="ocrCanvasWrap"></div>
              <textarea class="ocr-text" id="ocrText" readonly spellcheck="false" placeholder="识别后这里显示这一页的文字（可选中复制）"></textarea>
            </div>
          </div>
        </div>
      </div>
    </main>

    <footer class="ocr-actions">
      <button class="btn btn-primary ocr-run" data-run="1" id="ocrRunBtn">开始识别</button>
      <button class="btn btn-plain" data-clear="1" id="ocrClearBtn">清空</button>
      <div class="ocr-result" id="ocrResult"></div>
    </footer>
  </div>
`;

let state = null;

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const baseNameOf = (p) => String(p || '').split(/[\\/]/).pop();

function on(el, type, handler) {
  el.addEventListener(type, handler);
  state.listeners.push([el, type, handler]);
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

/** 释放 pdfjs 文档（pdfjs 6 要经 loadingTask 销毁，两种形态都兜住） */
async function closeDoc(doc) {
  if (!doc) return;
  try {
    if (typeof doc.destroy === 'function') await doc.destroy();
    else if (doc.loadingTask && typeof doc.loadingTask.destroy === 'function') await doc.loadingTask.destroy();
  } catch { /* 关不掉不影响功能 */ }
}

/** 带 BOM 的 UTF-8 文本字节：Windows 记事本打开中文不乱码 */
function utf8Bytes(text) {
  return new TextEncoder().encode(`\uFEFF${text}`);
}

// —— 加装包状态 ————————————————————————————————————————————————

/** 引擎是否可运行（模型齐全） */
const engineReady = () => !!(state && state.status && state.status.found);

function renderNote() {
  const { els } = state;
  if (!state.status) {
    els.note.className = 'ocr-note';
    els.note.textContent = '正在检测文字识别引擎…';
    return;
  }
  if (!state.status.found) {
    const dir = state.status.dir || '软件目录\\addons\\ocr';
    const missing = Object.values(state.status.models || {})
      .filter((m) => !m.exists)
      .map((m) => m.file)
      .join(' / ');
    els.note.className = 'ocr-note is-warn';
    els.note.textContent = `未检测到文字识别加装包：请把 ${missing || 'det.onnx / rec.onnx / dict.txt'} 放到「${dir}」，然后重开本工具。`;
    return;
  }
  if (!state.fontBytes) {
    els.note.className = 'ocr-note is-warn';
    els.note.textContent = '中文字体缺失（addons/ocr/fonts/NotoSansSC-VF.ttf）：暂时只能导出「纯文本」，可搜索 PDF 与 Word 不可用。';
    return;
  }
  els.note.className = 'ocr-note is-ok';
  els.note.textContent = '✓ 文字识别引擎已就绪（PP-OCRv5 · 纯离线运行，不联网）';
}

/** 模型/字体状态 + 输出类型可用性联动 */
function applyAvailability() {
  const { els } = state;
  // 状态还没探测回来时不要动用户的选项：否则「字体未知 → 先禁掉 PDF/Word」会把默认输出
  // 从「可搜索 PDF」顶成「纯文本」，等字体读回来又不会自动切回去。
  const known = state.statusKnown;
  for (const opt of Array.from(els.modeSel.options)) {
    // 纯文本不需要字体；可搜索 PDF 与 Word 需要中文字体（缺字体时按约定禁用并说明原因）
    opt.disabled = known && opt.value !== 'txt' && !state.fontBytes;
  }
  if (known && els.modeSel.selectedOptions[0] && els.modeSel.selectedOptions[0].disabled) {
    els.modeSel.value = 'txt';
  }
  els.compress.disabled = els.modeSel.value === 'txt' || els.modeSel.value === 'docx';
  els.preset.disabled = els.compress.disabled || !els.compress.checked;
  els.gray.disabled = els.preset.disabled;
  updateRunButton();
}

async function refreshStatus() {
  const st = state;
  const ctx = st.ctx;
  let status = null;
  try {
    status = typeof ctx.ocrStatus === 'function' ? await ctx.ocrStatus() : null;
  } catch {
    status = null;
  }
  if (state !== st) return;

  if (!status) {
    st.status = { found: false, dir: '', models: {} };
    st.fontBytes = null;
    st.statusKnown = true;
    if (st.els) {
      st.els.note.className = 'ocr-note is-warn';
      st.els.note.textContent = '当前版本还没有接入文字识别引擎（缺少 OCR 能力）：请把加装包放到软件目录的 addons/ocr（需要 det.onnx / rec.onnx / dict.txt 与 fonts/NotoSansSC-VF.ttf）后重开本工具。';
    }
    if (st.els) applyAvailability();
    return;
  }

  st.status = status;
  if (status.found) {
    // 字体只在需要时才真正读进来（17MB，不必每次进工具都读）
    if (typeof ctx.ocrFont === 'function') {
      try {
        const font = await ctx.ocrFont();
        if (state !== st) return;
        st.fontBytes = font && font.ok && font.bytes && font.bytes.length ? font.bytes : null;
      } catch {
        st.fontBytes = null;
      }
    } else {
      st.fontBytes = null;
    }
  } else {
    st.fontBytes = null;
  }
  if (!st.els) return;
  st.statusKnown = true;
  renderNote();
  applyAvailability();
}

/** 确保字体已加载（开始识别前调用）；返回字节或 null */
async function ensureFont() {
  const st = state;
  if (st.fontBytes) return st.fontBytes;
  if (typeof st.ctx.ocrFont !== 'function') return null;
  try {
    const font = await st.ctx.ocrFont();
    st.fontBytes = font && font.ok && font.bytes && font.bytes.length ? font.bytes : null;
  } catch {
    st.fontBytes = null;
  }
  if (state === st) { renderNote(); applyAvailability(); }
  return st.fontBytes;
}

// —— 参数 ————————————————————————————————————————————————

function fillModes(select) {
  select.innerHTML = '';
  for (const m of OUTPUT_MODES) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    select.appendChild(opt);
  }
}

function fillPresets(select) {
  select.innerHTML = '';
  for (const p of PDF_COMPRESS_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.value;
    opt.textContent = p.label;
    select.appendChild(opt);
  }
  select.value = 'standard';
}

function renderSteps() {
  const { els } = state;
  const steps = planPreprocess(readPreprocessFlags()).steps;
  els.steps.textContent = steps.length ? `将执行：${steps.join(' → ')}` : '不做增强（原图直接识别）';
}

function readPreprocessFlags() {
  const { els } = state;
  return {
    grayscale: true,
    binarize: els.binarize.checked,
    method: 'adaptive',
    deskew: els.deskew.checked,
    sharpen: els.sharpen.checked
  };
}

function readParams() {
  const { els } = state;
  return {
    mode: els.modeSel.value,
    preprocess: readPreprocessFlags(),
    compress: !els.compress.disabled && els.compress.checked,
    preset: presetOf(els.preset.value).value,
    grayscale: els.gray.checked
  };
}

// —— 文件列表 ————————————————————————————————————————————————

function renderList() {
  const { els } = state;
  const files = state.files;
  els.listWrap.hidden = files.length === 0;
  els.drop.hidden = files.length > 0;
  els.listCount.textContent = files.length ? `共 ${files.length} 个` : '';
  els.list.innerHTML = '';

  files.forEach((f, index) => {
    const li = document.createElement('li');
    li.className = `ocr-item${state.preview.index === index ? ' is-active' : ''}`;
    li.title = '点击可预览并查看识别文字';

    const main = document.createElement('div');
    main.className = 'ocr-item-main';

    const name = document.createElement('div');
    name.className = 'ocr-item-name';
    name.textContent = f.name;
    name.title = f.path;
    main.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'ocr-item-meta';
    meta.textContent = f.meta;
    main.appendChild(meta);

    if (f.result) {
      const res = document.createElement('div');
      res.className = `ocr-item-result ${f.result.ok ? 'is-ok' : 'is-fail'}`;
      res.textContent = f.result.text;
      res.title = f.result.text;
      main.appendChild(res);
    }
    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'ocr-item-actions';
    const del = document.createElement('button');
    del.className = 'ocr-icon-btn';
    del.textContent = '×';
    del.title = '移除';
    del.disabled = state.busy;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.busy) return;
      files.splice(index, 1);
      if (state.preview.index === index) closePreview();
      else if (state.preview.index > index) state.preview.index -= 1;
      renderList();
    });
    actions.appendChild(del);
    li.appendChild(actions);

    li.addEventListener('click', () => { if (!state.busy) selectItem(index); });
    els.list.appendChild(li);
  });
  updateRunButton();
}

/** 探测并加入列表；返回失败原因（成功返回空串） */
async function addOne(filePath, extInfo) {
  const ctx = state.ctx;
  if (state.files.some((f) => f.path === filePath)) return '已在列表中';
  const info = extInfo || await ctx.pathInfo(filePath);
  const ext = (info.ext || '').toLowerCase();
  const isPdf = ext === '.pdf';
  if (!isPdf && !IMAGE_EXTS.includes(ext)) return '不是支持的图片或 PDF';

  let pages = 1;
  let size = Number.isFinite(info.size) ? info.size : 0;
  if (isPdf) {
    const bytes = await ctx.readFile(filePath);   // 加密/损坏的 PDF 在这一步就能拿到中文错误
    size = size || bytes.length;
    const doc = await openPdfDoc(bytes);
    try {
      pages = doc.numPages;
      if (!pages) throw new Error('这份 PDF 没有页面');
    } finally {
      await closeDoc(doc);
    }
  }

  const item = {
    path: filePath,
    name: info.name,
    baseName: info.baseName,
    type: isPdf ? 'pdf' : 'image',
    ext,
    pages,
    size,
    meta: `${isPdf ? `PDF · 共 ${pages} 页` : `图片 · ${ext.slice(1).toUpperCase()}`} · ${fmtBytes(size)}`,
    result: null,
    pageLines: null,
    pageAngles: null,
    pageTexts: null
  };
  state.files.push(item);
  return '';
}

async function addFromPaths(paths) {
  const st = state;
  const failures = [];
  let added = 0;
  for (const p of paths) {
    if (st.disposed) break;
    try {
      const info = await st.ctx.pathInfo(p);
      if (info.isDirectory) { failures.push(`${info.name}：请选择图片或 PDF 文件（暂不支持文件夹）`); continue; }
      const reason = await addOne(p, info);
      if (reason) failures.push(`${info.name}：${reason}`);
      else added += 1;
    } catch (err) {
      failures.push(`${baseNameOf(p)}：${err.message}`);
    }
  }
  if (st.disposed || state !== st) return;
  renderList();
  if (added > 0) st.ctx.setStatus(`已添加 ${added} 个文件${failures.length ? `，${failures.length} 个跳过` : ''}`);
  else st.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的图片或 PDF');
  if (failures.length > 1) console.warn('[ocr] 部分文件未添加：\n' + failures.join('\n'));
}

async function openDialog() {
  const paths = await state.ctx.openOcr();
  if (paths && paths.length > 0) await addFromPaths(paths);
}

async function onDrop(event) {
  event.preventDefault();
  if (state.busy) return;
  const list = Array.from(event.dataTransfer ? event.dataTransfer.files : []);
  const paths = [];
  for (const file of list) {
    const p = state.ctx.getPathForFile(file);
    if (p) paths.push(p);
  }
  if (paths.length > 0) await addFromPaths(paths);
}

// —— 预览（缩略图 + 识别框 + 文字） ————————————————————————————————

function closePreview() {
  state.preview.index = -1;
  state.preview.page = 1;
  if (state.els) {
    state.els.preview.hidden = true;
    state.els.canvasWrap.innerHTML = '';
    state.els.text.value = '';
    state.els.pageLabel.textContent = '';
  }
  renderList();
}

function selectItem(index) {
  if (state.preview.index === index) { closePreview(); return; }
  state.preview.index = index;
  state.preview.page = 1;
  renderList();
  renderPreview();
}

function currentItem() {
  return state.files[state.preview.index] || null;
}

async function renderPreview() {
  const st = state;
  const f = currentItem();
  if (!f || !st.els) return;
  const { els } = st;
  const page = Math.min(Math.max(1, st.preview.page), f.pages || 1);
  st.preview.page = page;

  els.preview.hidden = false;
  els.previewTitle.textContent = `预览：${f.name}`;
  els.pageLabel.textContent = f.pages > 1 ? `第 ${page} / ${f.pages} 页` : '';
  els.prevPage.disabled = f.pages <= 1 || page <= 1;
  els.nextPage.disabled = f.pages <= 1 || page >= f.pages;
  els.text.value = (f.pageTexts && f.pageTexts[page - 1]) || '';
  els.canvasWrap.innerHTML = '<div class="ocr-thumb-msg">正在渲染…</div>';

  let rendered = null;
  try {
    if (f.type === 'pdf') {
      const bytes = await st.ctx.readFile(f.path);
      const pdf = await openPdfDoc(bytes);
      try {
        rendered = await renderPdfPage(pdf, page, { scale: PDF_SCALE });
      } finally {
        await closeDoc(pdf);
      }
    } else {
      rendered = await decodeImageFromBytes(await st.ctx.readFile(f.path));
    }
  } catch (err) {
    // 错误消息含完整文件路径（文件名用户可控），必须走 textContent，不能拼进 innerHTML
    if (state === st) {
      const msg = document.createElement('div');
      msg.className = 'ocr-thumb-msg';
      msg.textContent = `预览失败：${err.message}`;
      els.canvasWrap.replaceChildren(msg);
    }
    return;
  }
  if (state !== st || !st.els) return;

  const cv = document.createElement('canvas');
  cv.width = rendered.width;
  cv.height = rendered.height;
  const c2d = cv.getContext('2d');
  c2d.putImageData(new ImageData(rendered.pixels, rendered.width, rendered.height), 0, 0);

  // 识别框：开了纠偏时，框在「旋转后的图」上，先折算回原图坐标再画，才能和预览对齐
  const lines = f.pageLines && f.pageLines[page - 1];
  const angle = (f.pageAngles && f.pageAngles[page - 1]) || 0;
  if (lines) {
    c2d.lineWidth = Math.max(2, Math.round(Math.min(rendered.width, rendered.height) / 400));
    c2d.strokeStyle = 'rgba(255, 90, 78, 0.95)';
    for (const frag of linesToFragments(lines)) {
      const box = angle
        ? unrotateBox(frag.box, { angleDeg: angle, width: rendered.width, height: rendered.height })
        : frag.box;
      c2d.strokeRect(box.x, box.y, box.width, box.height);
    }
  }
  els.canvasWrap.innerHTML = '';
  els.canvasWrap.appendChild(cv);
}

// —— 运行 ————————————————————————————————————————————————

function updateRunButton() {
  const { els } = state;
  if (state.busy) {
    els.runBtn.textContent = state.cancelRequested ? '取消中…' : '取消';
    els.runBtn.disabled = state.cancelRequested;
  } else {
    els.runBtn.textContent = '开始识别';
    els.runBtn.disabled = !engineReady();
  }
}

/**
 * 处理单个文件：读盘 →（可选）瘦身 → 逐页渲染/识别 → 组装输出
 * @returns {Promise<{cancelled?: boolean, outputs?: Array<{ext:string,bytes:Uint8Array}>, detail?: string,
 *                    missingChars?: number, rotatedPages?: number[]}>}
 */
async function runOne(st, f, params, fontBytes, exec) {
  const ctx = st.ctx;
  const sourceBytes = await ctx.readFile(f.path);
  const isPdf = f.type === 'pdf';
  const notes = [];

  // 1) 扫描件瘦身（只对 PDF）：先压小再识别，输出的可搜索 PDF 也小
  let working = sourceBytes;
  if (isPdf && params.compress) {
    const c = await compressPdf(sourceBytes, {
      preset: params.preset,
      grayscale: params.grayscale,
      onProgress: (done, total) => exec.report(`瘦身（第 ${done}/${total} 页）`, Math.max(0, done - 1), total),
      shouldCancel: () => exec.isCancelled()
    });
    if (!c || c.cancelled) return { cancelled: true };
    working = c.bytes;
    notes.push(`瘦身 ${fmtBytes(c.originalBytes)} → ${fmtBytes(c.bytes.length)}`);
  }

  // 2) 逐页渲染 + 识别
  const pageCount = isPdf ? Math.max(1, f.pages || 1) : 1;
  const pageLines = [];
  const pageAngles = [];
  const pageTexts = [];
  const prePlan = planPreprocess(params.preprocess);
  let imagePng = null;
  let imageDecoded = null;
  let imageSize = null;

  if (!isPdf) {
    // 图片：解码一次，既用来装订 PDF、也用来识别（别重复解码大图）
    imageDecoded = await decodeImageFromBytes(sourceBytes);
    imagePng = await encodeImageToBytes(imageDecoded.pixels, imageDecoded.width, imageDecoded.height, { format: 'png' });
    imageSize = { width: imageDecoded.width, height: imageDecoded.height };
  }

  let pdf = null;
  if (isPdf) pdf = await openPdfDoc(working);
  try {
    for (let p = 1; p <= pageCount; p += 1) {
      if (exec.isCancelled()) return { cancelled: true };
      exec.report(`准备（第 ${p}/${pageCount} 页）`, p - 1, pageCount);
      await nextFrame();
      const rendered = isPdf
        ? await renderPdfPage(pdf, p, { scale: PDF_SCALE })
        : imageDecoded;
      const width = rendered.width;
      const height = rendered.height;

      // 预处理会就地改写像素，所以复制一份；原件留给预览与 PDF 原貌
      const work = { pixels: new Uint8ClampedArray(rendered.pixels), width, height };
      const pre = applyPreprocess(work, prePlan);
      const png = await encodeImageToBytes(work.pixels, width, height, { format: 'png' });

      const r = await ctx.ocrRecognize({ bytes: png, jobId: exec.jobId() });
      if (!r || !r.ok) {
        if (r && r.cancelled) return { cancelled: true };
        throw new Error(friendlyOcrMessage(r && r.message));
      }
      pageLines[p - 1] = r.lines || [];
      pageAngles[p - 1] = pre.angleDeg || 0;
      pageTexts[p - 1] = linesToText(r.lines);
      exec.report(`识别（第 ${p}/${pageCount} 页）`, p, pageCount);
    }
  } finally {
    await closeDoc(pdf);
  }

  if (exec.isCancelled()) return { cancelled: true };
  f.pageLines = pageLines;
  f.pageAngles = pageAngles;
  f.pageTexts = pageTexts;

  // 3) 组装输出
  const outputs = [];
  const mode = params.mode;
  if (mode === 'txt' || mode === 'both') {
    const text = pagesToText(pageLines);
    outputs.push({ ext: '.txt', bytes: utf8Bytes(text) });
    notes.push(`${text.replace(/\s/g, '').length} 字`);
  }
  if (mode === 'docx') {
    const rows = pagesToDocxRows(pageLines.map((l) => linesToPlainRows(l)));
    outputs.push({ ext: '.docx', bytes: await linesToDocx(rows, { title: f.baseName }) });
  }
  let missingChars = 0;
  let rotatedPages = [];
  if (mode === 'pdf' || mode === 'both') {
    let sres;
    if (isPdf) {
      sres = await linesToSearchablePdf({
        pdfBytes: working, pageLines, fontBytes, renderScale: PDF_SCALE, pageAngles
      });
    } else {
      // 图片输入：先把原图装订成 PDF（1px = 1pt），再叠文字层
      const built = await imagesToPdf([{ bytes: imagePng }]);
      sres = await linesToSearchablePdf({
        pdfBytes: built.bytes, pageLines, fontBytes, renderScale: IMAGE_SCALE, pageAngles
      });
    }
    outputs.push({ ext: '.pdf', bytes: sres.bytes });
    missingChars = sres.missingChars || 0;
    rotatedPages = sres.rotatedPages || [];
    notes.push(`${fmtBytes(working.length)} → ${fmtBytes(sres.bytes.length)}`);
    if (isPdf && !params.compress) notes.push(`${pageCount} 页`);
    if (imageSize) notes.push(`${imageSize.width}×${imageSize.height}`);
  }

  return { outputs, detail: notes.join('；'), missingChars, rotatedPages };
}

async function run() {
  const st = state;
  const ctx = st.ctx;
  const paint = () => { if (state === st) renderList(); };
  const files = st.files;
  if (files.length === 0) { ctx.setStatus('请先添加图片或扫描版 PDF'); return; }

  const params = readParams();
  const needFont = params.mode === 'pdf' || params.mode === 'both';
  let fontBytes = null;
  if (params.mode !== 'txt') {
    fontBytes = await ensureFont();
    if (state !== st) return;
  }
  if (needFont && !fontBytes) {
    ctx.setStatus('中文字体缺失：请把 addons/ocr/fonts/NotoSansSC-VF.ttf 放回软件目录，或先改用「纯文本」输出');
    return;
  }

  st.busy = true;
  st.cancelRequested = false;
  st.taskIds = [];
  if (state === st) updateRunButton();
  for (const f of files) { f.result = null; f.pageLines = null; f.pageAngles = null; f.pageTexts = null; }
  paint();

  const units = files.map((f) => Math.max(1, f.pages || 1));
  const unitsTotal = units.reduce((a, b) => a + b, 0);
  const baseOf = (i) => units.slice(0, i).reduce((a, b) => a + b, 0);
  let missingTotal = 0;
  const rotatedAll = [];
  let lastPaths = [];
  const outputDir = ctx.settings.getSettings().outputDir || undefined;

  // 任务归属队列：识别吃满 CPU，走 cpu 通道串行；每个文件算一个任务。
  // 切走工具页（含 LRU 回收）不再取消任务 —— 只退订 UI，队列照跑完。
  const jobs = files.map((f, i) => {
    let jobId = null; // 与 onCancel 共享绑定：取消时才能叫停这一次识别
    return {
      label: f.name,
      inputPaths: [f.path],
      outputDir,
      run: async ({ report, isCancelled }) => {
        const base = baseOf(i);
        const exec = {
          isCancelled,
          setJobId: (id) => { jobId = id; },
          jobId: () => jobId,
          report: (phase, pageIndex, pageTotal) => {
            const frac = pageTotal ? pageIndex / pageTotal : 1;
            const overall = Math.min(99, ((base + frac) / Math.max(1, unitsTotal)) * 100);
            const text = `${f.name}（${i + 1}/${files.length}）：${phase}`;
            report({ percent: overall, text });
            if (state === st && !st.disposed) st.ctx.showProgress(text, overall);
          }
        };
        try {
          exec.setJobId(`ocr-${Date.now()}-${i + 1}-${Math.random().toString(36).slice(2, 6)}`);
          exec.report('准备中', 0, units[i]);
          await nextFrame();
          const res = await runOne(st, f, params, fontBytes, exec);
          if (res.cancelled || isCancelled()) return { canceled: true };
          const paths = [];
          for (const out of res.outputs) {
            // 逐个保存：重名自动加序号，绝不覆盖已有文件
            const target = await ctx.saveNextTo({
              sourcePath: f.path, targetDir: outputDir, baseName: f.baseName, ext: out.ext, bytes: out.bytes
            });
            paths.push(target);
          }
          lastPaths = paths;
          missingTotal += res.missingChars || 0;
          if (res.rotatedPages && res.rotatedPages.length) rotatedAll.push(`${f.name} 第 ${res.rotatedPages.join('、')} 页`);
          f.result = { ok: true, text: `→ ${paths.map(baseNameOf).join(' + ')}${res.detail ? `｜${res.detail}` : ''}`, paths };
          paint();
          return { ok: true, outputPaths: paths, outputDir };
        } catch (err) {
          if (err && err.name === 'CancelledError') return { canceled: true };
          f.result = { ok: false, text: `✗ ${err.message}` };
          paint();
          return { ok: false, error: err.message };
        } finally {
          jobId = null;
        }
      },
      onCancel: () => {
        // 引擎推理不可中断，取消会在「下一张/下一页开始前」生效
        if (!jobId || typeof st.ctx.ocrCancel !== 'function') return;
        try { st.ctx.ocrCancel(jobId); } catch { /* 任务可能刚结束 */ }
      }
    };
  });

  const ids = jobs.map((job) => ctx.tasks.enqueue({ toolId: 'ocr', toolName: '文字识别', lane: 'cpu', ...job }));
  st.taskIds = ids;
  const settled = await Promise.all(ids.map((id) => ctx.tasks.waitFor(id)));

  const ok = settled.filter((t) => t && t.status === 'done').length;
  const failed = settled.filter((t) => t && t.status === 'failed').length;
  const cancelled = settled.filter((t) => t && t.status === 'canceled').length;
  const failedTask = settled.find((t) => t && t.status === 'failed');
  const lastError = (failedTask && failedTask.error) || '';

  if (state === st) {
    st.taskIds = [];
    st.busy = false;
    st.cancelRequested = false;
    updateRunButton();
    renderPreview();
  }
  ctx.hideProgress();

  const parts = [`识别完成：成功 ${ok} 个`];
  if (failed) parts.push(`失败 ${failed} 个（${lastError}）`);
  if (cancelled) parts.push(`已取消 ${cancelled} 个`);
  if (missingTotal) parts.push(`${missingTotal} 个字符字体不含未嵌入`);
  if (rotatedAll.length) parts.push(`旋转页未叠加文字层：${rotatedAll.join('，')}`);
  ctx.setStatus(parts.join('，'));
  if (state === st && st.els) {
    st.els.result.textContent = lastPaths.length ? `输出：${lastPaths.join('、')}` : (failed ? `失败原因：${lastError}` : '');
  }
}

async function onRunClick() {
  const st = state;
  if (st.busy) {
    // 取消本工具入队的任务；引擎推理不可中断，取消会在「下一张/下一页开始前」生效
    st.cancelRequested = true;
    for (const id of st.taskIds) st.ctx.tasks.cancel(id);
    updateRunButton();
    st.ctx.setStatus('正在取消…');
    return;
  }
  if (!engineReady()) {
    st.ctx.setStatus('未检测到文字识别加装包：把 addons/ocr（det.onnx / rec.onnx / dict.txt）放回软件目录后重开本工具');
    return;
  }
  try {
    await run();
  } catch (err) {
    st.ctx.hideProgress();
    st.ctx.setStatus(`处理失败：${err.message}`);
    console.error('[ocr] 处理失败', err);
  } finally {
    if (state === st) {
      st.busy = false;
      st.cancelRequested = false;
      updateRunButton();
    }
  }
}

function clearAll() {
  if (state.busy) { state.ctx.setStatus('正在处理中，请先点「取消」再清空'); return; }
  closePreview();
  state.files = [];
  state.preview.index = -1;
  renderList();
  state.els.result.textContent = '';
  state.ctx.setStatus('已清空文件列表');
}

// —— 生命周期 ————————————————————————————————————————————————

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
    status: null,
    statusKnown: false,
    fontBytes: null,
    preview: { index: -1, page: 1 },
    disposed: false
  };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.ocr-tool'),
    modeSel: container.querySelector('#ocrMode'),
    steps: container.querySelector('#ocrSteps'),
    binarize: container.querySelector('#ocrBinarize'),
    deskew: container.querySelector('#ocrDeskew'),
    sharpen: container.querySelector('#ocrSharpen'),
    compress: container.querySelector('#ocrCompress'),
    preset: container.querySelector('#ocrPreset'),
    gray: container.querySelector('#ocrGray'),
    compressHint: container.querySelector('#ocrCompressHint'),
    note: container.querySelector('#ocrNote'),
    drop: container.querySelector('#ocrDrop'),
    addBtn: container.querySelector('#ocrAddBtn'),
    listWrap: container.querySelector('#ocrListWrap'),
    list: container.querySelector('#ocrList'),
    listCount: container.querySelector('#ocrListCount'),
    addMore: container.querySelector('#ocrAddMore'),
    preview: container.querySelector('#ocrPreview'),
    previewTitle: container.querySelector('#ocrPreviewTitle'),
    pageLabel: container.querySelector('#ocrPageLabel'),
    prevPage: container.querySelector('#ocrPrevPage'),
    nextPage: container.querySelector('#ocrNextPage'),
    copyText: container.querySelector('#ocrCopyText'),
    canvasWrap: container.querySelector('#ocrCanvasWrap'),
    text: container.querySelector('#ocrText'),
    runBtn: container.querySelector('#ocrRunBtn'),
    clearBtn: container.querySelector('#ocrClearBtn'),
    result: container.querySelector('#ocrResult')
  };
  state.els = els;

  fillModes(els.modeSel);
  els.modeSel.value = 'pdf';
  fillPresets(els.preset);

  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', onRunClick);
  on(els.clearBtn, 'click', clearAll);
  on(els.modeSel, 'change', () => { applyAvailability(); ctx.setStatus(`输出内容：${els.modeSel.selectedOptions[0] ? els.modeSel.selectedOptions[0].textContent : ''}`); });
  for (const box of [els.binarize, els.deskew, els.sharpen]) on(box, 'change', renderSteps);
  on(els.compress, 'change', applyAvailability);
  on(els.preset, 'change', applyAvailability);
  on(els.gray, 'change', applyAvailability);
  on(els.prevPage, 'click', () => { state.preview.page -= 1; renderPreview(); });
  on(els.nextPage, 'click', () => { state.preview.page += 1; renderPreview(); });
  on(els.copyText, 'click', () => {
    const el = els.text;
    if (!el.value) { ctx.setStatus('这一页还没有识别文字'); return; }
    el.focus();
    el.select();
    try {
      document.execCommand('copy');
      ctx.setStatus('已复制这一页的文字');
    } catch {
      ctx.setStatus('复制失败：请手动选中文字后按 Ctrl+C');
    }
  });
  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);

  renderSteps();
  renderList();
  applyAvailability();
  els.result.textContent = `输出位置：${ctx.settings.getSettings().outputDir || '与源文件同目录'}`;
  ctx.setStatus('文字识别：添加图片或扫描版 PDF → 选输出内容 → 点「开始识别」');
  ctx.setInfo({});

  refreshStatus();
}

export function unmount() {
  if (!state) return;
  // disposed 只用于「不要再往这一页画界面」；硬契约：切走（含 LRU 回收）**不取消**队列里的任务
  state.disposed = true;
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  state.listeners = [];
  state.els = null;
  state = null;
}