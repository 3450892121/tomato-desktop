// 工具箱框架：左侧工具列表渲染、工具挂载/卸载、通用能力上下文（ctx）
import { TOOLS } from './registry.js';
import * as settings from '../shared/settings.js';

const els = {
  nav: document.getElementById('toolNav'),
  host: document.getElementById('toolHost'),
  status: document.getElementById('statusText'),
  info: document.getElementById('infoText'),
  btnSettings: document.getElementById('btnSettings'),
  btnHelp: document.getElementById('btnHelp'),
  progressBar: document.getElementById('progressBar'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText')
};

/** 当前活动的工具 */
let activeTool = null;
/** 已加载过的工具样式（同一份只加载一次） */
const loadedStyles = new Set();

// —— 框架通用能力（工具通过 ctx 调用，禁止工具直接操作这些 DOM） ——

function setStatus(text) {
  els.status.textContent = text;
}

function setInfo({ width, height, ms } = {}) {
  const w = width || '---';
  const h = height || '---';
  const t = typeof ms === 'number' ? ms : '---';
  els.info.textContent = `分辨率: ${w} x ${h} ｜ 耗时: ${t} ms`;
}

function showProgress(text, percent) {
  els.progressText.textContent = text || '处理中…';
  els.progressFill.style.width = `${typeof percent === 'number' ? Math.max(0, Math.min(100, percent)) : 0}%`;
  els.progressBar.hidden = false;
}

function hideProgress() {
  els.progressBar.hidden = true;
  els.progressFill.style.width = '0%';
}

/** 提供给工具的上下文（通用能力统一从这里取） */
const ctx = {
  setStatus,
  setInfo,
  showProgress,
  hideProgress,
  openImages: () => window.desktop.openImages(),
  openFolder: () => window.desktop.openFolder(),
  saveFile: (options) => window.desktop.saveFile(options),
  settings,
  versions: window.desktop.versions
};

// —— 工具列表与挂载 ——

function loadToolStyles(paths) {
  for (const href of paths || []) {
    if (loadedStyles.has(href)) continue;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
    loadedStyles.add(href);
  }
}

function renderNav() {
  els.nav.innerHTML = '';
  for (const tool of TOOLS) {
    const btn = document.createElement('button');
    btn.className = 'tool-item' + (activeTool && tool.id === activeTool.id ? ' is-active' : '');
    btn.dataset.toolId = tool.id;
    btn.innerHTML = `<span class="tool-item-icon">${tool.icon || '🔧'}</span><span>${tool.name}</span>`;
    btn.addEventListener('click', () => switchTool(tool.id));
    els.nav.appendChild(btn);
  }
}

/** 切换到指定工具：先卸载旧工具，再加载样式并挂载新工具 */
function switchTool(id) {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool || tool === activeTool) return;

  if (activeTool && typeof activeTool.unmount === 'function') {
    try {
      activeTool.unmount();
    } catch (err) {
      console.error('[shell] 卸载工具失败', err);
    }
  }

  els.host.innerHTML = '';
  loadToolStyles(tool.styles);
  activeTool = tool;
  renderNav();

  try {
    tool.mount(els.host, ctx);
    setStatus(`${tool.name} 已打开`);
    setInfo({});
  } catch (err) {
    console.error('[shell] 挂载工具失败', err);
    setStatus(`打开「${tool.name}」失败：${err.message}`);
  }
}

function init() {
  const sorted = [...TOOLS].sort((a, b) => (a.order || 0) - (b.order || 0));
  if (sorted.length > 0) {
    switchTool(sorted[0].id);
  } else {
    setStatus('还没有任何工具');
  }

  els.btnSettings.addEventListener('click', () => setStatus('通用设置尚未实现（骨架版本）'));
  els.btnHelp.addEventListener('click', () => setStatus('帮助内容尚未实现（骨架版本）'));
}

init();