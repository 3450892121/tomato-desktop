// 工具：图片格式转换 —— 界面与交互
// 分层：本文件只做界面与流程编排；各格式的编码实现与转换规则在 core/（encoders.js / convert.js），
//       图片解码复用 shared/imageio.js，TIFF/GIF/AVIF 经 shared/ffmpeg.js 调主进程 ffmpeg，
//       HEIC/HEIF/HIF（手机拍照格式）经 shared/heic.js 调主进程 libheif 引擎解码。
import { decodeImageFromBytes, encodeImageToBytes } from '../../shared/imageio.js';
import { ffmpegStatus, transformImageBytes, transformFileToBytes } from '../../shared/ffmpeg.js';
import { decodeHeicFromBytes } from '../../shared/heic.js';
import {
  TARGETS, INPUT_EXTS, HEIF_EXTS, FFMPEG_DECODE_EXTS, DECODE_FAIL_MESSAGE,
  targetInfo, needsFfmpeg, hasQuality, defaultQuality,
  fitLongEdge, flattenOnColor, resizePixels, encodeWebp, encodeIcon, encodeBmp, ffmpegArgs, ffmpegDecodeArgs, outputBaseName
} from './core/convert.js';

const MARKUP = `
  <div class="conv-tool">
    <section class="card conv-controls">
      <div class="control-row">
        <label class="control-label" for="convFormat">输出格式:</label>
        <select id="convFormat" class="select"></select>
        <span class="control-hint" id="convFormatHint"></span>
      </div>
      <div class="conv-params">
        <div class="conv-param" id="convQualityWrap">
          <span class="control-label">画质</span>
          <input class="input conv-w-num" id="convQuality" type="number" min="1" max="100" step="1" value="90" />
        </div>
        <div class="conv-param">
          <span class="control-label">最长边</span>
          <input class="input conv-w-num" id="convMaxEdge" type="number" min="1" step="1" placeholder="留空 = 不变" />
          <span class="control-hint">只缩小不放大</span>
        </div>
        <div class="conv-param" id="convBgWrap" hidden>
          <span class="control-label">透明底色</span>
          <select class="select" id="convBg">
            <option value="white">白</option>
            <option value="black">黑</option>
          </select>
          <span class="control-hint">JPG 不支持透明，透明像素会填成该底色</span>
        </div>
      </div>
      <div class="conv-note" id="convFfmpegNote">正在检测 ffmpeg…</div>
    </section>

    <main class="card conv-files" id="convFiles">
      <div class="conv-drop" id="convDrop">
        <button class="btn btn-primary btn-lg" id="convAddBtn" data-add="1">添加图片</button>
        <div class="conv-hint">也可以把图片或整个文件夹拖进窗口；支持多选（含 HEIC / ICO / AVIF / SVG / TIFF / PSD / PCX / TGA 等老格式，手机拍照格式可直接转）</div>
      </div>
      <div class="conv-list-wrap" id="convListWrap" hidden>
        <div class="conv-list-head">
          <span id="convListTitle">图片</span>
          <span class="conv-spacer"></span>
          <span id="convListCount"></span>
          <button class="btn btn-ghost" id="convAddMore" type="button">＋ 继续添加</button>
        </div>
        <ul class="conv-list" id="convList"></ul>
      </div>
    </main>

    <footer class="conv-actions">
      <button class="btn btn-primary btn-run" id="convRunBtn" data-run="1">开始转换</button>
      <button class="btn btn-plain" id="convClearBtn" data-clear="1">清空</button>
      <div class="conv-result" id="convResult"></div>
    </footer>
  </div>
`;

let state = null;

/** 统一收集监听器，unmount 时逐一摘掉 */
function on(el, type, handler) {
  el.addEventListener(type, handler);
  state.listeners.push([el, type, handler]);
}

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

// —— 参数区 ——

function updateParams() {
  const { els } = state;
  const format = els.format.value;
  const info = targetInfo(format);
  els.formatHint.textContent = info.label;

  const showQuality = hasQuality(format);
  els.qualityWrap.hidden = !showQuality;
  if (showQuality) els.quality.value = String(defaultQuality(format));
  els.bgWrap.hidden = format !== 'jpg';
}

function readParams() {
  const format = state.els.format.value;
  const raw = parseInt(state.els.quality.value, 10);
  const quality = hasQuality(format)
    ? Math.max(1, Math.min(100, Number.isFinite(raw) ? raw : defaultQuality(format)))
    : defaultQuality(format);
  const edge = parseInt(state.els.maxEdge.value, 10);
  return {
    format,
    quality,
    maxEdge: Number.isFinite(edge) && edge > 0 ? edge : 0,
    bg: state.els.bg.value === 'black' ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }
  };
}

function updateRunButton() {
  state.els.runBtn.textContent = state.busy ? '处理中…' : '开始转换';
  state.els.runBtn.disabled = state.busy;
}

// —— ffmpeg 加装包状态 ——

function renderFfmpegNote() {
  const note = state.els.ffmpegNote;
  if (!note) return;
  const ff = state.ff;
  if (ff && ff.found) {
    const where = ff.where === 'addon' ? '加装包' : '系统安装';
    note.className = 'conv-note is-ok';
    note.textContent = `✓ 已检测到 ffmpeg${ff.version ? `（${ff.version}）` : ''}，来源：${where} —— TIFF / GIF / AVIF 输出与老格式图片输入（TIFF/PSD/PCX/TGA/DDS/JPEG2000）可用`;
  } else {
    note.className = 'conv-note is-warn';
    note.textContent = '未检测到 ffmpeg：TIFF / GIF / AVIF 输出与老格式图片输入（TIFF/PSD/PCX/TGA/DDS/JPEG2000）不可用（其余格式不受影响）；需要时把加装包解压到软件目录的 addons/ffmpeg 后重开本工具。';
  }
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
    li.className = 'conv-item';

    const main = document.createElement('div');
    main.className = 'conv-item-main';
    const name = document.createElement('div');
    name.className = 'conv-item-name';
    name.textContent = f.name;
    name.title = f.path;
    const meta = document.createElement('div');
    meta.className = 'conv-item-meta';
    meta.textContent = f.result ? f.result.text : `${(f.ext || '').replace('.', '').toUpperCase()} · 待转换`;
    if (f.result && !f.result.ok) meta.classList.add('is-error');
    main.appendChild(name);
    main.appendChild(meta);
    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'conv-item-actions';
    const del = document.createElement('button');
    del.className = 'conv-icon-btn';
    del.type = 'button';
    del.textContent = '×';
    del.title = '移除';
    on(del, 'click', () => {
      state.files.splice(index, 1);
      renderList();
    });
    actions.appendChild(del);
    li.appendChild(actions);

    els.list.appendChild(li);
  });
  updateRunButton();
}

// —— 添加文件（含文件夹拖入，展开一层） ——

async function addOne(path) {
  const info = await state.ctx.pathInfo(path);
  const ext = (info.ext || '').toLowerCase();
  const bare = ext.replace('.', '');
  if (!INPUT_EXTS.includes(bare)) throw new Error('不是支持的图片格式');
  if (state.files.some((f) => f.path === path)) return false;

  state.files.push({ path, name: info.name, baseName: info.baseName, dir: info.dir, ext, result: null });
  return true;
}

async function addFromPaths(paths) {
  const failures = [];
  let added = 0;

  for (const p of paths) {
    try {
      const info = await state.ctx.pathInfo(p);
      if (info.isDirectory) {
        // 文件夹只展开一层（简单为上，避免误扫整个盘）
        const list = await state.ctx.listFiles(p, INPUT_EXTS);
        if (list.length === 0) { failures.push(`${info.name}：文件夹里没有支持的图片`); continue; }
        for (const sub of list) {
          try {
            if (await addOne(sub)) added += 1;
          } catch (err) {
            failures.push(`${sub.split(/[\\/]/).pop()}：${err.message}`);
          }
        }
      } else if (await addOne(p)) {
        added += 1;
      }
    } catch (err) {
      failures.push(`${p.split(/[\\/]/).pop()}：${err.message}`);
    }
  }

  renderList();
  if (added > 0) state.ctx.setStatus(`已添加 ${added} 张${failures.length ? `，${failures.length} 张失败` : ''}`);
  else state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的图片');
}

async function openDialog() {
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

// —— 批量转换 ——

/** 老图片格式（TIFF/PCX/TGA/PSD/DDS/JPEG2000）经随包 ffmpeg 解码：出首帧 PNG 再进 canvas */
async function decodeViaFfmpeg(filePath, bare) {
  if (!(state.ff && state.ff.found)) {
    throw new Error(`解码 .${bare} 需要 ffmpeg 加装包（把 addons/ffmpeg 放进软件目录后重开本工具）`);
  }
  // transformFileToBytes：主进程按路径把文件直接交给 ffmpeg（PSD/TIFF 可能很大，别整份读进界面进程）
  const res = await transformFileToBytes(filePath, '.png', ffmpegDecodeArgs());
  if (!res || !res.ok) throw new Error((res && res.message) || 'ffmpeg 解码失败');
  try {
    return await decodeImageFromBytes(res.bytes);
  } catch {
    throw new Error(`解码失败：.${bare} 内容不受支持或文件已损坏`);
  }
}

/** 把一张图编码成目标格式（失败时抛出带原因的 Error） */
async function encodeTo(params, pixels, width, height) {
  const { format, quality } = params;
  if (format === 'png') return encodeImageToBytes(pixels, width, height, { format: 'png' });
  if (format === 'jpg') {
    const flat = flattenOnColor(pixels, params.bg);
    return encodeImageToBytes(flat, width, height, { format: 'jpg', quality });
  }
  if (format === 'webp') return encodeWebp(pixels, width, height, quality);
  if (format === 'bmp') return encodeBmp(pixels, width, height);
  if (format === 'ico') return encodeIcon(pixels, width, height);

  // TIFF / GIF / AVIF：先出 PNG 字节，再交给包内 ffmpeg
  const pngBytes = await encodeImageToBytes(pixels, width, height, { format: 'png' });
  const res = await transformImageBytes(pngBytes, targetInfo(format).ext, ffmpegArgs(format, quality));
  if (!res || !res.ok) throw new Error((res && res.message) || 'ffmpeg 转换失败');
  return res.bytes;
}

async function run() {
  if (state.busy) return;
  if (state.files.length === 0) {
    state.ctx.setStatus('请先添加图片');
    return;
  }
  const params = readParams();
  const info = targetInfo(params.format);
  if (needsFfmpeg(params.format) && !(state.ff && state.ff.found)) {
    state.ctx.setStatus(`${info.label} 需要 ffmpeg 加装包（把 addons/ffmpeg 放进软件目录后重开本工具）；也可先换成 PNG / JPG / WebP / BMP / ICO`);
    return;
  }

  const ctx = state.ctx;
  const outputDir = ctx.settings.getSettings().outputDir || undefined;
  const files = state.files;
  const total = files.length;
  state.busy = true;
  updateRunButton();
  const t0 = Date.now();

  for (const f of files) f.result = null;
  renderList();

  // 任务归属队列：图片类走 io 通道（并发 2）；每张图算一个任务，切走工具页任务照跑
  const jobs = files.map((f, index) => ({
    label: f.name,
    inputPaths: [f.path],
    outputDir,
    run: async ({ report, isCancelled }) => {
      if (isCancelled()) return { canceled: true };
      const step = `转换 ${index + 1}/${total}：${f.name}`;
      report({ percent: (index / total) * 100, text: step });
      if (state && state.ctx.isActive()) state.ctx.showProgress(step, (index / total) * 100);
      try {
        const bytes = await ctx.readFile(f.path);
        const bare = (f.ext || '').replace('.', '').toLowerCase();
        let img;
        if (HEIF_EXTS.includes(bare)) {
          // 手机拍照格式：走主进程 libheif 引擎（引擎报错自带可读原因，直接透传）
          img = await decodeHeicFromBytes(bytes);
        } else if (FFMPEG_DECODE_EXTS.includes(bare)) {
          // 老图片格式：内核解不了，走随包 ffmpeg 出首帧 PNG 再解（v2.13.0）
          img = await decodeViaFfmpeg(f.path, bare);
        } else {
          try {
            img = await decodeImageFromBytes(bytes);
          } catch {
            throw new Error(DECODE_FAIL_MESSAGE);
          }
        }

        let pixels = img.pixels;
        let width = img.width;
        let height = img.height;
        const fit = fitLongEdge(width, height, params.maxEdge);
        if (fit.scaled) {
          const scaleStep = `${f.name}：缩放到 ${fit.width} × ${fit.height}…`;
          report({ percent: ((index + 0.4) / total) * 100, text: scaleStep });
          if (state && state.ctx.isActive()) state.ctx.showProgress(scaleStep, ((index + 0.4) / total) * 100);
          pixels = resizePixels(pixels, width, height, fit.width, fit.height);
          width = fit.width;
          height = fit.height;
        }

        const encStep = `${f.name}：正在编码 ${params.format.toUpperCase()}…`;
        report({ percent: ((index + 0.6) / total) * 100, text: encStep });
        if (state && state.ctx.isActive()) state.ctx.showProgress(encStep, ((index + 0.6) / total) * 100);
        const outBytes = await encodeTo(params, pixels, width, height);
        const outPath = await ctx.saveNextTo({
          sourcePath: f.path,
          targetDir: outputDir,
          baseName: outputBaseName(f.baseName, params.format),
          ext: info.ext,
          bytes: outBytes
        });

        const inSize = bytes.byteLength;
        const outSize = outBytes.byteLength;
        const sizeNote = fit.scaled ? `（${img.width}×${img.height} → ${width}×${height}）` : '';
        f.result = {
          ok: true,
          text: `${(f.ext || '').replace('.', '').toUpperCase()} → ${params.format.toUpperCase()} · ${formatBytes(inSize)} → ${formatBytes(outSize)}${sizeDeltaText(inSize, outSize)}${sizeNote}`,
          outPath
        };
        if (state && state.ctx.isActive()) state.ctx.setInfo({ width, height, ms: Date.now() - t0 });
        report({ percent: ((index + 1) / total) * 100, text: f.result.text });
        if (state) renderList();
        return { ok: true, outputPaths: [outPath], outputDir };
      } catch (err) {
        f.result = { ok: false, text: `失败：${err.message}` };
        if (state) renderList();
        return { ok: false, error: err.message };
      }
    }
  }));

  const ids = jobs.map((job) => ctx.tasks.enqueue({ toolId: 'img-convert', toolName: '图片格式转换', lane: 'io', ...job }));
  const settled = await Promise.all(ids.map((id) => ctx.tasks.waitFor(id)));

  if (!state) return; // 工具页已被回收：任务照跑完了，这里只跳过界面收尾
  ctx.hideProgress();
  state.busy = false;
  updateRunButton();

  const done = settled.filter((t) => t && t.status === 'done').length;
  const failed = settled.filter((t) => t && t.status === 'failed').length;
  const failedTask = settled.find((t) => t && t.status === 'failed');
  const lastError = (failedTask && failedTask.error) || '';
  const doneTask = [...settled].reverse().find((t) => t && t.status === 'done' && t.output.paths.length);
  const lastPath = doneTask ? doneTask.output.paths[0] : '';

  state.ctx.setStatus(`转换完成：成功 ${done} 个${failed ? `，失败 ${failed} 个（${lastError}）` : ''}`);
  state.els.result.textContent = lastPath ? `输出：${lastPath}` : '';
}

// —— 生命周期 ——

export function mount(container, ctx) {
  state = {
    ctx,
    container,
    listeners: [],
    els: null,
    files: [],
    ff: null,
    busy: false
  };
  container.innerHTML = MARKUP;

  const els = {
    format: container.querySelector('#convFormat'),
    formatHint: container.querySelector('#convFormatHint'),
    qualityWrap: container.querySelector('#convQualityWrap'),
    quality: container.querySelector('#convQuality'),
    maxEdge: container.querySelector('#convMaxEdge'),
    bgWrap: container.querySelector('#convBgWrap'),
    bg: container.querySelector('#convBg'),
    ffmpegNote: container.querySelector('#convFfmpegNote'),
    drop: container.querySelector('#convDrop'),
    addBtn: container.querySelector('#convAddBtn'),
    addMore: container.querySelector('#convAddMore'),
    listWrap: container.querySelector('#convListWrap'),
    list: container.querySelector('#convList'),
    listCount: container.querySelector('#convListCount'),
    runBtn: container.querySelector('#convRunBtn'),
    clearBtn: container.querySelector('#convClearBtn'),
    result: container.querySelector('#convResult'),
    root: container.querySelector('.conv-tool')
  };
  state.els = els;

  els.format.innerHTML = '';
  for (const t of TARGETS) {
    const opt = document.createElement('option');
    opt.value = t.value;
    opt.textContent = t.label;
    els.format.appendChild(opt);
  }

  on(els.format, 'change', updateParams);
  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', run);
  on(els.clearBtn, 'click', () => {
    state.files = [];
    renderList();
    state.els.result.textContent = '';
    state.ctx.setStatus('已清空图片列表');
  });
  on(els.root, 'dragover', (event) => event.preventDefault());
  on(els.root, 'drop', onDrop);

  updateParams();
  renderList();
  updateRunButton();
  ctx.setStatus('图片格式转换：添加图片 → 选输出格式 → 点「开始转换」；产物与原文件同目录（重名自动加序号）');

  ffmpegStatus()
    .then((s) => {
      if (!state) return;
      state.ff = s;
      renderFfmpegNote();
    })
    .catch(() => {
      if (!state) return;
      state.ff = { found: false };
      renderFfmpegNote();
    });
}

export function unmount() {
  if (!state) return;
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  state = null;
}