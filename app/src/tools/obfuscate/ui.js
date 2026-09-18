// 工具：图片混淆 —— 界面与交互（骨架）
// 当前阶段：界面框架 + 模式/密钥三态联动已就绪；选图、处理、保存等按 spec 逐步实现。
import { MODES, getMode, DEFAULT_DOUBLE_KEY } from './core/modes.js';

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
      <img id="previewImage" class="preview-image" alt="图片预览" hidden />
      <button class="btn btn-obfuscate btn-lg" id="btnAddFirst">添加图片（可选多张）</button>
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

const ACTION_LABELS = {
  obfuscate: '混淆',
  deobfuscate: '解混淆',
  clear: '清除',
  revert: '还原',
  save: '保存',
  'batch-obfuscate': '全部混淆',
  'batch-deobfuscate': '全部解混淆',
  'batch-clear': '全部清除',
  'batch-revert': '全部还原',
  'batch-save': '全部保存'
};

/** 工具的运行时状态（每次挂载重置） */
let state = null;

function makeState() {
  return {
    images: [],        // 本次会话已载入的图片
    currentIndex: -1,
    context: null,
    els: null,
    listeners: []
  };
}

function on(el, type, handler) {
  el.addEventListener(type, handler);
  state.listeners.push([el, type, handler]);
}

/** 按模式切换密钥输入：字符串 / 0~1 小数 / 隐藏 */
function applyModeToKeyInput() {
  const { els, context } = state;
  const mode = getMode(els.mode.value);
  if (mode.keyType === 'none') {
    els.keyRow.hidden = true;
    els.keyInput.value = '';
    els.keyHint.textContent = '';
    return;
  }
  els.keyRow.hidden = false;
  if (mode.keyType === 'double') {
    els.keyInput.value = DEFAULT_DOUBLE_KEY;
    els.keyInput.inputMode = 'decimal';
    els.keyHint.textContent = '输入 0 到 1 之间的小数';
  } else {
    els.keyInput.value = '';
    els.keyInput.inputMode = 'text';
    els.keyHint.textContent = '输入字符串密钥';
  }
  void context;
}

function onAction(action) {
  const label = ACTION_LABELS[action] || action;
  state.context.setStatus(`「${label}」尚未实现（当前为骨架版本）`);
}

export function mount(container, ctx) {
  state = makeState();
  state.context = ctx;
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.obfuscate-tool'),
    mode: container.querySelector('#modeSelect'),
    keyRow: container.querySelector('#keyRow'),
    keyInput: container.querySelector('#keyInput'),
    keyHint: container.querySelector('#keyHint'),
    preview: container.querySelector('#previewImage'),
    btnAddFirst: container.querySelector('#btnAddFirst'),
    btnAddMore: container.querySelector('#btnAddMore'),
    thumbStrip: container.querySelector('#thumbStrip'),
    thumbList: container.querySelector('#thumbList'),
    actionButtons: [...container.querySelectorAll('[data-action]')]
  };
  state.els = els;

  // 填充模式下拉框（与手机版文案一致）
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
  on(els.btnAddFirst, 'click', () => ctx.setStatus('选图功能尚未实现（当前为骨架版本）'));
  on(els.btnAddMore, 'click', () => ctx.setStatus('选图功能尚未实现（当前为骨架版本）'));

  els.preview.hidden = true;
  els.thumbStrip.hidden = true;

  ctx.setStatus('建议先添加图片（当前为骨架版本）');
  ctx.setInfo({});
}

export function unmount() {
  if (!state) return;
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  for (const img of state.images) {
    if (img.url && img.url.startsWith('blob:')) URL.revokeObjectURL(img.url);
  }
  state = null;
}