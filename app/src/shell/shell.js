// 工具箱框架：左侧工具列表渲染、工具挂载/卸载、通用能力上下文（ctx）、设置与帮助弹窗
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
  // 文件对话框
  openImages: () => window.desktop.openImages(),
  openFolder: () => window.desktop.openFolder(),
  saveFile: (options) => window.desktop.saveFile(options),
  // 文件读写（界面进程在沙箱中，统一经主进程）
  readFile: (filePath) => window.desktop.readFile(filePath),
  writeFile: (filePath, bytes) => window.desktop.writeFile(filePath, bytes),
  pathInfo: (filePath) => window.desktop.pathInfo(filePath),
  listImages: (dirPath) => window.desktop.listImages(dirPath),
  saveImageNextTo: (options) => window.desktop.saveImageNextTo(options),
  getPathForFile: (file) => window.desktop.getPathForFile(file),
  // 剪贴板
  readClipboardImage: () => window.desktop.readClipboardImage(),
  writeClipboardImage: (bytes) => window.desktop.writeClipboardImage(bytes),
  // 通用设置与版本信息
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

// —— 弹窗（设置 / 帮助共用） ——

function showModal({ title, bodyHTML, actions = [] }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-card">
      <div class="modal-title">${title}</div>
      <div class="modal-body">${bodyHTML}</div>
      <div class="modal-actions"></div>
    </div>`;
  const actionsEl = backdrop.querySelector('.modal-actions');

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(event) {
    if (event.key === 'Escape') close();
  }

  for (const action of actions) {
    const btn = document.createElement('button');
    btn.className = `btn ${action.className || 'btn-plain'}`;
    btn.textContent = action.label;
    btn.addEventListener('click', async () => {
      // 注意：回调可能是 async（如保存设置），必须 await 才能正确拿到「是否保持打开」
      const keepOpen = action.onClick ? await action.onClick(backdrop) : false;
      if (!keepOpen) close();
    });
    actionsEl.appendChild(btn);
  }

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onEsc);
  document.body.appendChild(backdrop);
  return { backdrop, close };
}

function openSettings() {
  const s = settings.getSettings();
  showModal({
    title: '设置',
    bodyHTML: `
      <div class="field">
        <label class="field-label">方块数（方块混淆 B 模式）</label>
        <input class="input" id="setBlockSize" type="number" min="2" max="256" step="1" value="${s.blockSize}" />
        <div class="field-hint">默认 32（与手机版一致）。改大更碎、改小更快。</div>
      </div>
      <div class="field">
        <label class="field-label">JPG 画质（空间曲线混淆保存用）</label>
        <input class="input" id="setJpegQuality" type="number" min="1" max="100" step="1" value="${s.jpegQuality}" />
        <div class="field-hint">默认 95（与手机版一致）。越低体积越小、画质越差。</div>
      </div>
      <div class="field">
        <label class="field-label">默认密钥（PE1 / PE2）</label>
        <input class="input" id="setDefaultKey" type="text" value="${s.defaultDoubleKey}" />
        <div class="field-hint">默认 0.666（与手机版一致），必须是 0 到 1 之间的小数。</div>
      </div>
      <div class="field">
        <label class="field-label">输出目录</label>
        <input class="input" id="setOutputDir" type="text" value="${s.outputDir}" placeholder="留空 = 保存在原图旁边" />
        <div class="field-hint">留空时与手机版一致：保存到原图所在目录。</div>
      </div>
      <label class="field-check">
        <input type="checkbox" id="setAskSavePath" ${s.askSavePath ? 'checked' : ''} />
        <span>每次保存前询问保存位置</span>
      </label>
    `,
    actions: [
      {
        label: '恢复默认（手机版行为）',
        className: 'btn-ghost',
        onClick: async (backdrop) => {
          const d = await settings.resetSettings();
          // 只刷新当前弹窗里的值，不重开弹窗（避免闪烁与误操作）
          backdrop.querySelector('#setBlockSize').value = d.blockSize;
          backdrop.querySelector('#setJpegQuality').value = d.jpegQuality;
          backdrop.querySelector('#setDefaultKey').value = d.defaultDoubleKey;
          backdrop.querySelector('#setOutputDir').value = d.outputDir;
          backdrop.querySelector('#setAskSavePath').checked = d.askSavePath;
          setStatus('已恢复默认设置');
          return true; // 保持弹窗打开
        }
      },
      {
        label: '取消',
        className: 'btn-plain'
      },
      {
        label: '保存',
        className: 'btn-save',
        onClick: async (backdrop) => {
          const blockSize = parseInt(backdrop.querySelector('#setBlockSize').value, 10);
          const jpegQuality = parseInt(backdrop.querySelector('#setJpegQuality').value, 10);
          const defaultDoubleKey = backdrop.querySelector('#setDefaultKey').value.trim();
          const outputDir = backdrop.querySelector('#setOutputDir').value.trim();
          const askSavePath = backdrop.querySelector('#setAskSavePath').checked;

          if (!Number.isFinite(blockSize) || blockSize < 2 || blockSize > 256) {
            setStatus('方块数需为 2~256 之间的整数');
            return true; // 保持弹窗打开
          }
          if (!Number.isFinite(jpegQuality) || jpegQuality < 1 || jpegQuality > 100) {
            setStatus('JPG 画质需为 1~100 之间的整数');
            return true;
          }
          const k = Number(defaultDoubleKey);
          if (!Number.isFinite(k) || k <= 0 || k >= 1) {
            setStatus('默认密钥需为 0 到 1 之间的小数');
            return true;
          }
          await settings.updateSettings({ blockSize, jpegQuality, defaultDoubleKey, outputDir, askSavePath });
          setStatus('设置已保存（下次处理与保存立即生效）');
          return false;
        }
      }
    ]
  });
}

function openHelp() {
  showModal({
    title: '使用帮助',
    bodyHTML: `
      <div class="help-section">
        <h4>这是什么</h4>
        <p>把图片的像素按规则重新排列，别人看不出原图内容；用<b>相同的模式和密钥</b>就能完整还原。全程离线，不联网。</p>
      </div>
      <div class="help-section">
        <h4>怎么用</h4>
        <ol>
          <li>点「添加图片（可选多张）」选图，或把图片/文件夹直接拖进窗口（也可 Ctrl+V 粘贴剪贴板图片）。</li>
          <li>选择模式、填好密钥。</li>
          <li>点「混淆」打乱当前图；需要还原时点「解混淆」。第二排「全部」按钮对列表里所有图一次性操作。</li>
          <li>点「保存」存到原图旁边（gilbert 存 JPG、其余模式存 PNG；重名自动加序号，不会覆盖）。</li>
        </ol>
      </div>
      <div class="help-section">
        <h4>六种模式</h4>
        <ul>
          <li><b>空间曲线混淆（番茄图）</b>：不需要密钥；保存为 JPG 体积小，但反复「混淆→解混淆」会有画质损失。</li>
          <li><b>方块混淆 (B) / 像素混淆 (C) / 行像素混淆 (C2)</b>：用字符串密钥（可用中文）；保存为 PNG，无损。</li>
          <li><b>兼容PE 行模式 (PE1) / 行+列 (PE2)</b>：用 0~1 之间的小数密钥；保存为 PNG，无损。</li>
        </ul>
      </div>
      <div class="help-section">
        <h4>注意事项</h4>
        <ul>
          <li>混淆图要还原，必须用<b>相同的模式 + 相同的密钥</b>。</li>
          <li>请保持图片尺寸不变（不要裁剪；左右/上下翻转不影响）。</li>
          <li>方块模式遇到尺寸不是 32 的倍数时会自动补边，输出尺寸会变大，这是正常现象。</li>
        </ul>
      </div>
    `,
    actions: [{ label: '知道了', className: 'btn-obfuscate' }]
  });
}

async function init() {
  await settings.loadSettings();

  els.btnSettings.addEventListener('click', openSettings);
  els.btnHelp.addEventListener('click', openHelp);

  const sorted = [...TOOLS].sort((a, b) => (a.order || 0) - (b.order || 0));
  if (sorted.length > 0) {
    switchTool(sorted[0].id);
  } else {
    setStatus('还没有任何工具');
  }
}

init();