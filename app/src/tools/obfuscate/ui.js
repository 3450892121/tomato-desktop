// 工具：图片混淆 —— 界面与交互
// 已实现：选图/拖拽/粘贴、预览、缩略图、混淆/解混淆（单张与全部）、还原、清除、保存、复制到剪贴板。
import { MODES, getMode, DEFAULT_DOUBLE_KEY } from './core/modes.js';
import { processPixels, validateKey } from './core/engine.js';
import {
  decodeImageFromBytes,
  encodeImageToBytes,
  drawPixelsToCanvas,
  makeThumbnail
} from '../../shared/imageio.js';

const MARKUP = `
  <div class="obfuscate-tool">
    <section class="card controls">
      <div class="control-row">
        <label class="control-label" for="modeSelect">模式:</label>
        <select id="modeSelect" class="select"></select>
      </div>
      <div class="control-row" id="keyRow">
        <label class="control-label" for="keyInput">密钥:</label>
        <input id="keyInput" class="input" type="text" autocomplete="off" spellcheck="false" />
        <span class="control-hint" id="keyHint"></span>
      </div>
    </section>

    <main class="card preview" id="previewArea">
      <canvas id="previewCanvas" class="preview-canvas" hidden></canvas>
      <button class="btn btn-obfuscate btn-lg" id="btnAddFirst">添加图片（可选多张）</button>
      <div class="drop-hint" id="dropHint">也可直接把图片或文件夹拖进来；Ctrl+V 粘贴、Ctrl+C 复制结果</div>
    </main>

    <section class="thumbs" id="thumbStrip" hidden>
      <div class="thumb-list" id="thumbList"></div>
      <button class="thumb-add" id="btnAddMore" title="继续添加图片">＋</button>
    </section>

    <footer class="actions">
      <div class="action-row">
        <button class="btn btn-obfuscate" data-action="obfuscate">混淆</button>
        <button class="btn btn-deobfuscate" data-action="deobfuscate">解混淆</button>
        <button class="btn btn-plain" data-action="clear">清除</button>
        <button class="btn btn-plain" data-action="revert">还原</button>
        <button class="btn btn-save" data-action="save">保存</button>
      </div>
      <div class="action-row">
        <button class="btn btn-obfuscate" data-action="batch-obfuscate">全部</button>
        <button class="btn btn-deobfuscate" data-action="batch-deobfuscate">全部</button>
        <button class="btn btn-plain" data-action="batch-clear">全部</button>
        <button class="btn btn-plain" data-action="batch-revert">全部</button>
        <button class="btn btn-save" data-action="batch-save">全部</button>
      </div>
    </footer>
  </div>
`;

/** 工具的运行时状态（每次挂载重置） */
let state = null;

function makeState() {
  return { images: [], currentIndex: -1, ctx: null, els: null, listeners: [] };
}

function on(el, type, handler) {
  el.addEventListener(type, handler);
  state.listeners.push([el, type, handler]);
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

// —— 基础读写 ——

function currentEntry() {
  return state.images[state.currentIndex] || null;
}

function readKey() {
  const mode = getMode(state.els.mode.value);
  if (mode.keyType === 'none') return undefined;
  const raw = state.els.keyInput.value;
  return mode.keyType === 'double' ? raw.trim() : raw;
}

/** 按模式切换密钥输入：字符串 / 0~1 小数 / 隐藏 */
function applyModeToKeyInput() {
  const { els } = state;
  const mode = getMode(els.mode.value);
  if (mode.keyType === 'none') {
    els.keyRow.hidden = true;
    els.keyInput.value = '';
    els.keyHint.textContent = '';
    return;
  }
  els.keyRow.hidden = false;
  if (mode.keyType === 'double') {
    els.keyInput.value = state.ctx.settings.getSettings().defaultDoubleKey || DEFAULT_DOUBLE_KEY;
    els.keyInput.inputMode = 'decimal';
    els.keyHint.textContent = '输入 0 到 1 之间的小数';
  } else {
    els.keyInput.value = '';
    els.keyInput.inputMode = 'text';
    els.keyHint.textContent = '输入字符串密钥';
  }
}

// —— 界面刷新 ——

function drawPreview() {
  const { els } = state;
  const entry = currentEntry();
  if (!entry) {
    els.previewCanvas.hidden = true;
    els.btnAddFirst.hidden = false;
    els.dropHint.hidden = false;
    state.ctx.setInfo({});
    return;
  }
  els.previewCanvas.hidden = false;
  els.btnAddFirst.hidden = true;
  els.dropHint.hidden = true;
  drawPixelsToCanvas(els.previewCanvas, entry.current.pixels, entry.current.width, entry.current.height);
  state.ctx.setInfo({ width: entry.current.width, height: entry.current.height, ms: entry.lastMs });
}

async function refreshThumbs() {
  const { els } = state;
  els.thumbList.innerHTML = '';
  for (let i = 0; i < state.images.length; i++) {
    const entry = state.images[i];
    const thumb = await makeThumbnail(entry.current.pixels, entry.current.width, entry.current.height, 54);
    thumb.className = 'thumb' + (i === state.currentIndex ? ' is-active' : '');
    thumb.title = entry.name;
    on(thumb, 'click', () => {
      state.currentIndex = i;
      refreshUI();
    });
    els.thumbList.appendChild(thumb);
  }
  els.thumbStrip.hidden = state.images.length <= 1;
}

function refreshUI() {
  drawPreview();
  refreshThumbs();
}

// —— 图片导入 ——

async function addFromPaths(paths) {
  const failures = [];
  let added = 0;

  for (const p of paths) {
    try {
      const bytes = await state.ctx.readFile(p);
      const img = await decodeImageFromBytes(bytes);
      const info = await state.ctx.pathInfo(p);
      state.images.push({
        path: p,
        name: info.name,
        baseName: info.baseName,
        original: { pixels: img.pixels, width: img.width, height: img.height },
        current: { pixels: img.pixels.slice(), width: img.width, height: img.height },
        lastOp: null,
        lastMs: undefined
      });
      added += 1;
    } catch (err) {
      failures.push(`${p.split(/[\\/]/).pop()}：${err.message}`);
    }
  }

  if (added > 0) {
    if (state.currentIndex < 0) state.currentIndex = 0;
    refreshUI();
    state.ctx.setStatus(`已添加 ${added} 张图片${failures.length ? `，${failures.length} 张失败` : ''}`);
  } else {
    state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的图片');
  }
  if (failures.length > 1) {
    console.warn('[obfuscate] 部分图片添加失败：\n' + failures.join('\n'));
  }
}

async function openImagesDialog() {
  const paths = await state.ctx.openImages();
  if (paths && paths.length > 0) await addFromPaths(paths);
}

// —— 处理（混淆 / 解混淆） ——

async function runProcess(direction, targets, label) {
  const { els } = state;
  if (targets.length === 0) {
    state.ctx.setStatus('请先点击缩略图选择要操作的图片');
    return;
  }

  const mode = els.mode.value;
  const modeDef = getMode(mode);
  const key = readKey();
  const check = validateKey(mode, key);
  if (!check.ok) {
    state.ctx.setStatus(check.message);
    return;
  }

  let done = 0;
  let failed = 0;
  for (const entry of targets) {
    state.ctx.showProgress(`${label} ${done + 1}/${targets.length}…`, (done / targets.length) * 100);
    await nextFrame();
    const t0 = performance.now();
    try {
      const out = processPixels({
        mode,
        key,
        direction,
        width: entry.current.width,
        height: entry.current.height,
        pixels: entry.current.pixels,
        blockSize: state.ctx.settings.getSettings().blockSize
      });
      entry.current = { pixels: out.pixels, width: out.width, height: out.height };
      entry.lastOp = direction === 'encrypt' ? '混淆' : '解混淆';
      entry.lastMs = Math.round(performance.now() - t0);
    } catch (err) {
      failed += 1;
      console.error('[obfuscate] 处理失败', entry.name, err);
    }
    done += 1;
  }
  state.ctx.hideProgress();
  refreshUI();

  const okCount = targets.length - failed;
  state.ctx.setStatus(
    `${label}完成：成功 ${okCount} 张${failed ? `，失败 ${failed} 张` : ''}（模式「${modeDef.label}」）`
  );
}

// —— 还原 / 清除 ——

function revertEntries(entries) {
  for (const entry of entries) {
    entry.current = {
      pixels: entry.original.pixels.slice(),
      width: entry.original.width,
      height: entry.original.height
    };
    entry.lastOp = null;
    entry.lastMs = undefined;
  }
  refreshUI();
}

function clearAll() {
  if (state.images.length === 0) return;
  if (!window.confirm('确定要清空所有已选图片吗？')) return;
  state.images = [];
  state.currentIndex = -1;
  refreshUI();
  state.ctx.setStatus('已清空图片列表');
}

// —— 保存 / 复制 ——

async function saveEntries(entries, label) {
  if (entries.length === 0) {
    state.ctx.setStatus('没有有效的图片数据可保存');
    return;
  }
  const modeDef = getMode(state.els.mode.value);
  const config = state.ctx.settings.getSettings();
  const format = modeDef.saveFormat || 'png';
  const ext = format === 'jpg' ? '.jpg' : '.png';
  let done = 0;
  let failed = 0;
  let lastPath = '';

  for (const entry of entries) {
    state.ctx.showProgress(`${label} ${done + 1}/${entries.length}…`, (done / entries.length) * 100);
    await nextFrame();
    try {
      const bytes = await encodeImageToBytes(entry.current.pixels, entry.current.width, entry.current.height, {
        format,
        quality: config.jpegQuality || modeDef.jpegQuality || 95
      });
      const suffix = entry.lastOp ? `_${entry.lastOp}` : '_混淆';

      if (config.askSavePath) {
        // 用户在设置里要求「每次保存前询问位置」
        const chosen = await state.ctx.saveFile({
          defaultPath: `${entry.baseName}${suffix}${ext}`,
          filters: format === 'jpg' ? [{ name: 'JPEG 图片', extensions: ['jpg'] }] : [{ name: 'PNG 图片', extensions: ['png'] }]
        });
        if (!chosen) {
          state.ctx.hideProgress();
          state.ctx.setStatus('已取消保存');
          return;
        }
        lastPath = await state.ctx.writeFile(chosen, bytes);
      } else {
        lastPath = await state.ctx.saveImageNextTo({
          sourcePath: entry.path,
          targetDir: config.outputDir || undefined,
          baseName: `${entry.baseName}${suffix}`,
          ext,
          bytes
        });
      }
      done += 1;
    } catch (err) {
      failed += 1;
      console.error('[obfuscate] 保存失败', entry.name, err);
    }
  }

  state.ctx.hideProgress();
  if (done === entries.length && entries.length === 1) {
    state.ctx.setStatus(`图片已保存：${lastPath}`);
  } else {
    state.ctx.setStatus(`保存完成：成功 ${done} 张${failed ? `，失败 ${failed} 张` : ''}`);
  }
}

async function copyCurrentToClipboard() {
  const entry = currentEntry();
  if (!entry) {
    state.ctx.setStatus('请先添加图片');
    return;
  }
  try {
    const bytes = await encodeImageToBytes(entry.current.pixels, entry.current.width, entry.current.height, {
      format: 'png'
    });
    const ok = await state.ctx.writeClipboardImage(bytes);
    state.ctx.setStatus(ok ? '当前图片已复制到剪贴板' : '复制失败：图片无效');
  } catch (err) {
    state.ctx.setStatus(`复制失败：${err.message}`);
  }
}

async function pasteFromClipboard() {
  const bytes = await state.ctx.readClipboardImage();
  if (!bytes || bytes.length === 0) {
    state.ctx.setStatus('剪贴板里没有图片');
    return;
  }
  try {
    const img = await decodeImageFromBytes(bytes);
    state.images.push({
      path: '',
      name: '剪贴板图片',
      baseName: '剪贴板图片',
      original: { pixels: img.pixels, width: img.width, height: img.height },
      current: { pixels: img.pixels.slice(), width: img.width, height: img.height },
      lastOp: null,
      lastMs: undefined
    });
    state.currentIndex = state.images.length - 1;
    refreshUI();
    state.ctx.setStatus('已从剪贴板粘贴图片');
  } catch (err) {
    state.ctx.setStatus(`粘贴失败：${err.message}`);
  }
}

// —— 动作分发 ——

function onAction(action) {
  const entry = currentEntry();
  switch (action) {
    case 'obfuscate':
      runProcess('encrypt', entry ? [entry] : [], '混淆');
      break;
    case 'deobfuscate':
      runProcess('decrypt', entry ? [entry] : [], '解混淆');
      break;
    case 'clear':
      clearAll();
      break;
    case 'revert':
      if (entry) {
        revertEntries([entry]);
        state.ctx.setStatus('图片已还原到初始状态');
      }
      break;
    case 'save':
      saveEntries(entry ? [entry] : [], '保存');
      break;
    case 'batch-obfuscate':
      runProcess('encrypt', state.images, '全部混淆');
      break;
    case 'batch-deobfuscate':
      runProcess('decrypt', state.images, '全部解混淆');
      break;
    case 'batch-clear':
      clearAll();
      break;
    case 'batch-revert':
      if (state.images.length > 0) {
        revertEntries(state.images);
        state.ctx.setStatus('全部图片已还原到初始状态');
      }
      break;
    case 'batch-save':
      saveEntries(state.images, '全部保存');
      break;
    default:
      break;
  }
}

// —— 拖拽与快捷键 ——

async function onDrop(event) {
  event.preventDefault();
  const files = Array.from(event.dataTransfer ? event.dataTransfer.files : []);
  const paths = [];
  for (const file of files) {
    const p = state.ctx.getPathForFile(file);
    if (!p) continue;
    try {
      const list = await state.ctx.listImages(p); // 文件夹：取出其中的图片
      if (list.length > 0) {
        paths.push(...list);
        continue;
      }
    } catch {
      // 不是文件夹，按单个文件处理
    }
    paths.push(p);
  }
  if (paths.length > 0) await addFromPaths(paths);
}

function onKeyDown(event) {
  // 本工具的这些快捷键挂在窗口上：页面被切走（隐藏）时必须让位，
  // 否则别的工具里按 Ctrl+V / Ctrl+C 会误触发这里的粘贴/复制。
  if (typeof state.ctx.isActive === 'function' && !state.ctx.isActive()) return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'v') {
    event.preventDefault();
    pasteFromClipboard();
  } else if (key === 'c') {
    event.preventDefault();
    copyCurrentToClipboard();
  }
}

// —— 生命周期 ——

export function mount(container, ctx) {
  state = makeState();
  state.ctx = ctx;
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.obfuscate-tool'),
    mode: container.querySelector('#modeSelect'),
    keyRow: container.querySelector('#keyRow'),
    keyInput: container.querySelector('#keyInput'),
    keyHint: container.querySelector('#keyHint'),
    previewCanvas: container.querySelector('#previewCanvas'),
    dropHint: container.querySelector('#dropHint'),
    btnAddFirst: container.querySelector('#btnAddFirst'),
    btnAddMore: container.querySelector('#btnAddMore'),
    thumbStrip: container.querySelector('#thumbStrip'),
    thumbList: container.querySelector('#thumbList'),
    actionButtons: [...container.querySelectorAll('[data-action]')]
  };
  state.els = els;

  els.mode.innerHTML = '';
  for (const m of MODES) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    els.mode.appendChild(opt);
  }
  els.mode.value = MODES[0].id;
  applyModeToKeyInput();

  on(els.mode, 'change', applyModeToKeyInput);
  for (const btn of els.actionButtons) {
    on(btn, 'click', () => onAction(btn.dataset.action));
  }
  on(els.btnAddFirst, 'click', openImagesDialog);
  on(els.btnAddMore, 'click', openImagesDialog);
  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);
  on(window, 'keydown', onKeyDown);

  els.previewCanvas.hidden = true;
  els.thumbStrip.hidden = true;
  els.btnAddFirst.hidden = false;
  ctx.setStatus('点击「添加图片」选图，或把图片/文件夹拖进来');
  ctx.setInfo({});
}

export function unmount() {
  if (!state) return;
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  state = null;
}