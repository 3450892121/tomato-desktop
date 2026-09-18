// 渲染进程界面逻辑（骨架）
// 当前阶段只搭框架：模式下拉、密钥输入三态切换、状态提示。
// 具体功能（选图、混淆/解混淆、保存、批量、拖拽、剪贴板）按 spec 逐步实现。
import { MODES, getMode, DEFAULT_DOUBLE_KEY } from '../core/modes.js';

const els = {
  status: document.getElementById('statusText'),
  info: document.getElementById('infoText'),
  mode: document.getElementById('modeSelect'),
  keyRow: document.getElementById('keyRow'),
  keyInput: document.getElementById('keyInput'),
  keyHint: document.getElementById('keyHint'),
  btnHelp: document.getElementById('btnHelp'),
  preview: document.getElementById('previewImage'),
  btnAddFirst: document.getElementById('btnAddFirst'),
  btnAddMore: document.getElementById('btnAddMore'),
  thumbStrip: document.getElementById('thumbStrip'),
  thumbList: document.getElementById('thumbList'),
  progressBar: document.getElementById('progressBar'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText')
};

// 本次会话已载入的图片（骨架阶段为空，仅作结构占位）
const state = {
  images: [],
  currentIndex: -1
};

/** 顶部状态提示 */
export function setStatus(text) {
  els.status.textContent = text;
}

/** 参数信息（分辨率 / 耗时），占位用 */
export function setInfo({ width, height, ms } = {}) {
  const w = width || '---';
  const h = height || '---';
  const t = typeof ms === 'number' ? ms : '---';
  els.info.textContent = `分辨率: ${w} x ${h} ｜ 耗时: ${t} ms`;
}

/** 进度显示 */
export function showProgress(text) {
  els.progressText.textContent = text || '处理中…';
  els.progressBar.hidden = false;
}
export function hideProgress() {
  els.progressBar.hidden = true;
  els.progressFill.style.width = '0%';
}

/** 按模式切换密钥输入：字符串 / 0~1 小数 / 隐藏 */
function applyModeToKeyInput() {
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
}

/** 按钮动作（骨架阶段统一提示未实现） */
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

function onAction(action) {
  const label = ACTION_LABELS[action] || action;
  setStatus(`「${label}」尚未实现（当前为骨架版本）`);
}

function bindEvents() {
  els.mode.addEventListener('change', applyModeToKeyInput);

  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => onAction(btn.dataset.action));
  });

  els.btnAddFirst.addEventListener('click', () => setStatus('选图功能尚未实现（当前为骨架版本）'));
  els.btnAddMore.addEventListener('click', () => setStatus('选图功能尚未实现（当前为骨架版本）'));
  els.btnHelp.addEventListener('click', () => setStatus('帮助内容尚未实现（当前为骨架版本）'));
}

function init() {
  // 填充模式下拉框
  els.mode.innerHTML = '';
  for (const m of MODES) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    els.mode.appendChild(opt);
  }
  els.mode.value = MODES[0].id;

  bindEvents();
  applyModeToKeyInput();
  setStatus('骨架版本已启动：界面框架就绪，功能待实现');
  setInfo({});
  els.thumbStrip.hidden = true;
  els.preview.hidden = true;
  els.progressBar.hidden = true;
}

init();