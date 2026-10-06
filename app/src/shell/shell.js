// 工具箱框架：左侧工具列表渲染、工具挂载/卸载、通用能力上下文（ctx）、设置与帮助弹窗
import { TOOLS, GROUPS } from './registry.js';
import { computeNavPlan, pickStartupTool, createNavSort } from './navsort.js';
import * as settings from '../shared/settings.js';
import { createQueue } from '../shared/taskqueue.js';
import { createTaskCenter } from './taskcenter.js';
import { escapeHtml } from '../shared/htmlescape.js';

const els = {
  nav: document.getElementById('toolNav'),
  host: document.getElementById('toolHost'),
  status: document.getElementById('statusText'),
  info: document.getElementById('infoText'),
  btnSettings: document.getElementById('btnSettings'),
  btnHelp: document.getElementById('btnHelp'),
  btnTasks: document.getElementById('btnTasks'),
  taskBadge: document.getElementById('taskBadge'),
  progressBar: document.getElementById('progressBar'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
  btnTheme: document.getElementById('btnTheme'),
  themeIcon: document.getElementById('themeIcon'),
  themeLabel: document.getElementById('themeLabel'),
  navReset: document.getElementById('btnSortReset')
};

/** 当前活动的工具 */
let activeTool = null;
/** 应用信息（版本号等，启动时读取一次） */
let appInfo = null;
/** 已加载过的工具样式（同一份只加载一次） */
const loadedStyles = new Set();

// —— 外观主题（浅色 / 深色 / 跟随系统） ——
// 实现要点：只在 <html> 上切 data-theme，颜色全部由 theme.css 的变量覆盖决定，
// 所以任何工具都不需要为深色改一行代码（前提是它按约定引用 theme 变量）。
// 目标与规则见 spec/modules/theme.md。

/** 外观档位 → 按钮上显示的图标与文字 */
const THEME_MODES = [
  { value: 'system', icon: '🌗', label: '跟随系统' },
  { value: 'light', icon: '☀️', label: '浅色' },
  { value: 'dark', icon: '🌙', label: '深色' }
];
/** 系统深浅色偏好（'system' 档据此决定实际用哪套） */
const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
/** 用户选择的档位（不是实际生效的主题；'system' 时实际主题随系统变化） */
let themeMode = 'system';

/** 把档位解析成实际主题：'system' 看系统偏好，其余原样返回 */
function resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return darkMedia.matches ? 'dark' : 'light';
}

/** 应用档位：切换 <html data-theme> 并刷新按钮上的提示 */
function applyTheme(mode) {
  themeMode = THEME_MODES.some((m) => m.value === mode) ? mode : 'system';
  document.documentElement.dataset.theme = resolveTheme(themeMode);
  const cur = THEME_MODES.find((m) => m.value === themeMode) || THEME_MODES[0];
  if (els.themeIcon) els.themeIcon.textContent = cur.icon;
  if (els.themeLabel) els.themeLabel.textContent = cur.label;
  if (els.btnTheme) els.btnTheme.title = `当前外观：${cur.label}（点击切换）`;
}

/** 保存档位并立即生效 */
async function setTheme(mode) {
  applyTheme(mode);
  await settings.updateSettings({ theme: themeMode });
  setStatus(`外观已切换为「${(THEME_MODES.find((m) => m.value === themeMode) || {}).label}」`);
}

/** 系统深浅色变化时，只有「跟随系统」档需要跟着变 */
function onSystemThemeChange() {
  if (themeMode === 'system') applyTheme('system');
}

// 启动瞬间先按系统偏好上色：设置是异步从主进程读的，等它回来才上色的话，
// 深色系统下会先闪一下白底（很扎眼）。这里同步按系统偏好先铺上，读回设置后再纠正。
document.documentElement.dataset.theme = resolveTheme('system');

// —— 跨工具任务队列（框架唯一实例） ——
// 硬契约：**入队后的任务归属队列，不归属工具页。**
// 工具 unmount()（LRU 回收）只退订自己的 UI 订阅，不得取消队列里的任务 —— 切走工具任务照跑，
// 切回来还能看到进度与结果。任务中心的开关同样不影响执行。
// 队列实例在这里创建、经 ctx.tasks 暴露给所有工具；纯逻辑与单测见 shared/taskqueue.js。
const taskQueue = createQueue({
  onChange: () => {
    refreshTaskBadge();
    if (taskCenter) taskCenter.refresh();
  }
});

/** 任务中心面板（延迟到 init 时创建；面板开关不影响任务执行） */
let taskCenter = null;

/** 顶栏任务徽标：进行中 + 排队数量（0 个时隐藏） */
function refreshTaskBadge() {
  if (!els.btnTasks || !els.taskBadge) return;
  const s = taskQueue.summary();
  const active = s.running + s.queued;
  els.taskBadge.hidden = active === 0;
  els.taskBadge.textContent = active > 99 ? '99+' : String(active);
  els.btnTasks.classList.toggle('has-active', active > 0);
}

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
  removeFile: (filePath) => window.desktop.removeFile(filePath),
  pathInfo: (filePath) => window.desktop.pathInfo(filePath),
  listImages: (dirPath) => window.desktop.listImages(dirPath),
  listFiles: (dirPath, exts) => window.desktop.listFiles(dirPath, exts),
  saveImageNextTo: (options) => window.desktop.saveImageNextTo(options),
  renameBatch: (renames) => window.desktop.renameBatch(renames),
  // 新工具（图片格式转换 / 视频格式转换 / 动图与视频互转）专用对话框
  openImageAny: () => window.desktop.openImageAny(),
  openVideos: () => window.desktop.openVideos(),
  openMedia: () => window.desktop.openMedia(),
  openAudios: () => window.desktop.openAudios(),
  openVideosCompress: () => window.desktop.openVideosCompress(),
  openAudiosEdit: () => window.desktop.openAudiosEdit(),
  openSpeech: () => window.desktop.openSpeech(),
  openBatchRename: () => window.desktop.openBatchRename(),
  openWatermark: () => window.desktop.openWatermark(),
  openWatermarkStamp: () => window.desktop.openWatermarkStamp(),
  openStitch: () => window.desktop.openStitch(),
  openGridSlice: () => window.desktop.openGridSlice(),
  openPdfEdit: () => window.desktop.openPdfEdit(),
  openOcr: () => window.desktop.openOcr(),
  // 文件压缩与解压工具：专用对话框（待压缩的文件 / 压缩包）
  openArchiveFiles: () => window.desktop.openArchiveFiles(),
  openArchives: () => window.desktop.openArchives(),
  // 文件藏图工具（工具：imghide；见 spec/modules/imghide.md）
  openHideCover: () => window.desktop.openHideCover(),
  openHideImage: () => window.desktop.openHideImage(),
  openHideFiles: () => window.desktop.openHideFiles(),
  hidePack: (options) => window.desktop.hidePack(options),
  hideUnpack: (options) => window.desktop.hideUnpack(options),
  hideReveal: (targetPath) => window.desktop.hideReveal(targetPath),
  imghideOnProgress: (callback) => window.desktop.imghideOnProgress(callback),
  // 视频播放器工具：专用对话框 + 播放缓存管理（播放本身走 tomato-media:// 协议，见 main.js）
  openPlayerVideos: () => window.desktop.openPlayerVideos(),
  playerCacheDir: () => window.desktop.playerCacheDir(),
  playerCleanCache: () => window.desktop.playerCleanCache(),
  playerPrepare: (options) => window.desktop.playerPrepare(options),
  // OCR 加装包（文字识别工具）
  ocrStatus: () => window.desktop.ocrStatus(),
  ocrRecognize: (options) => window.desktop.ocrRecognize(options),
  ocrCancel: (jobId) => window.desktop.ocrCancel(jobId),
  ocrFont: () => window.desktop.ocrFont(),
  // ffmpeg 加装包（视频/动图工具）
  ffmpegStatus: () => window.desktop.ffmpegStatus(),
  ffmpegProbe: (filePath) => window.desktop.ffmpegProbe(filePath),
  ffmpegConvert: (options) => window.desktop.ffmpegConvert(options),
  ffmpegConvertTwoPass: (options) => window.desktop.ffmpegConvertTwoPass(options),
  ffmpegConvertMulti: (options) => window.desktop.ffmpegConvertMulti(options),
  ffmpegTransform: (options) => window.desktop.ffmpegTransform(options),
  ffmpegCancel: (jobId) => window.desktop.ffmpegCancel(jobId),
  ffmpegOnProgress: (callback) => window.desktop.ffmpegOnProgress(callback),
  // Real-ESRGAN AI 放大加装包（图片变清晰工具用）
  aiStatus: () => window.desktop.aiStatus(),
  aiUpscale: (options) => window.desktop.aiUpscale(options),
  aiOnProgress: (callback) => window.desktop.aiOnProgress(callback),
  // 通用保存（与 saveImageNextTo 同一实现，PDF/文档等输出同样适用）
  saveNextTo: (options) => window.desktop.saveImageNextTo(options),
  // PDF 工具用：专用文件对话框与 LibreOffice 加装包
  openPdfs: () => window.desktop.openPdfs(),
  openDocuments: () => window.desktop.openDocuments(),
  // 文档格式转换用：专用对话框（老格式文档）
  openDocConvert: () => window.desktop.openDocConvert(),
  libreofficeStatus: () => window.desktop.libreofficeStatus(),
  libreofficeConvert: (options) => window.desktop.libreofficeConvert(options),
  officeToPdf: (options) => window.desktop.officeToPdf(options),
  getPathForFile: (file) => window.desktop.getPathForFile(file),
  // 剪贴板
  readClipboardImage: () => window.desktop.readClipboardImage(),
  writeClipboardImage: (bytes) => window.desktop.writeClipboardImage(bytes),
  // 跨工具任务队列：工具把批量任务交给它执行（**任务归属队列，不归属工具页**）
  // 工具 unmount() 只退订 UI 订阅，绝不取消这里的任务。
  tasks: {
    enqueue: (job) => taskQueue.enqueue(job),
    runBatch: (batch) => taskQueue.runBatch(batch),
    cancel: (id) => taskQueue.cancel(id),
    cancelAll: () => taskQueue.cancelAll(),
    list: () => taskQueue.list(),
    get: (id) => taskQueue.get(id),
    summary: () => taskQueue.summary(),
    clearFinished: () => taskQueue.clearFinished(),
    retry: (id) => taskQueue.retry(id),
    recentFinished: (limit) => taskQueue.recentFinished(limit),
    waitFor: (id) => taskQueue.waitFor(id)
  },
  // 通用设置与版本信息
  settings,
  versions: window.desktop.versions,
  appInfo: () => window.desktop.appInfo()
};

// —— 工具页保活（切走不销毁，切回来原样；只保「动过」的页） ——

/**
 * 已挂载的工具页：toolId → { el, status, info, mounted, scrollTop, lastUsed, touched }。
 * 每个工具一个 .tool-page 容器：首次进入时挂载；切走时整页从文档里取下（DOM 与工具内部状态都留在内存里，
 * 不销毁、不重挂）；切回来原样放回，所以列表、当前图、输入内容、滚动位置、顶栏提示都不会重置。
 * 取下而不只是隐藏的原因：同一时刻文档里只有当前工具的页面，工具与自动化测试用
 * document.querySelector 找元素时不会误抓到别的页面。
 *
 * 只有「动过」的页才值得保活（用户反馈）：只是点开看一眼、什么都没做的页没有内容可保，
 * 切走时就静默释放（不提示、下次进去重新挂载），也不算保活额度 —— 免得「随便看看有什么功能」
 * 就把别处正在用的页面挤掉、上次的内容被清空。
 *
 * 保活不等于永远留着：动过的页（尤其是已选图片的像素数据）会随着用过的工具越来越多而堆高，
 * 所以给了上限，超过就按 LRU 回收最久没用过的那页（见 evictPages）。
 */
const pages = new Map();

/**
 * 「动过」的判定：用户在这一页里点按 / 打字 / 拖入过文件，才算在这页做过事。
 * 只是切过来看一眼（含滚动查看）不算 —— 没动过的页不占保活额度，也就不会挤掉别处做过的事。
 */
const TOUCH_EVENTS = ['pointerdown', 'click', 'keydown', 'input', 'change', 'drop', 'paste'];

/**
 * 同时保活的「动过」页上限：超过就淘汰最久没用过的（LRU）。当前页永不淘汰。
 * 取值考虑：日常最多同时在几个工具之间来回（图片混淆 + 一两个转换工具），5 页足够顺手；
 * 被回收的工具再进去时会重新挂载，并在状态栏说明「上次的内容已自动释放」，不会让人以为文件丢了。
 */
const MAX_ALIVE_PAGES = 5;
/** 页面访问序号：每次切入 / 每次动过都自增记到 lastUsed，回收时挑最小的那个（最久未用） */
let pageTick = 0;
/** 被 LRU 回收过的工具：下次进入时提示一句「内容已自动释放」 */
const releasedTools = new Set();
/** 回收进行中：回收时工具 unmount 引发的连锁事件不再递归触发回收 */
let evicting = false;

function pageFor(tool) {
  let page = pages.get(tool.id);
  if (!page) {
    const el = document.createElement('div');
    el.className = 'tool-page';
    el.dataset.toolId = tool.id;
    page = { el, status: `${tool.name} 已打开`, info: {}, progress: null, mounted: false, scrollTop: 0, lastUsed: 0, touched: false };
    // 捕获阶段监听：工具里 stopPropagation 也拦不住这次「动过」判定
    const markTouched = () => {
      if (page.touched) return;
      page.touched = true;
      page.lastUsed = ++pageTick;
      evictPages(); // 刚变成「动过」就校验一次额度，保证动过的页始终不超上限
    };
    for (const type of TOUCH_EVENTS) el.addEventListener(type, markTouched, true);
    pages.set(tool.id, page);
  }
  page.lastUsed = ++pageTick; // 记一次访问，供 LRU 判断谁最久没用过
  return page;
}

/** 释放一个工具页：先让工具自己清理（事件、进度订阅、后台任务），再丢掉 DOM 与记录 */
function disposePage(toolId, page, { silent = false } = {}) {
  const tool = TOOLS.find((t) => t.id === toolId);
  if (tool && typeof tool.unmount === 'function') {
    try {
      tool.unmount();
    } catch (err) {
      console.error('[shell] 释放工具页失败', err);
    }
  }
  page.el.remove();
  page.el.innerHTML = '';
  pages.delete(toolId);
  if (!silent) releasedTools.add(toolId); // 下次进来时说明一下，免得用户以为文件丢了
}

/**
 * LRU 回收：额度只按「动过」的页算 —— 点开看一眼就走的不占额度，也不会挤掉别处做过的事（用户反馈）。
 * - 「动过」的页超过 MAX_ALIVE_PAGES：淘汰最久没用过的那页，下次进入时提示「已自动释放」；
 * - 「没动过」的页没有内容可丢：正常在切走时就已静默释放，这里只兜底清理（绝不因此淘汰动过的页）。
 * 当前页永不淘汰。
 */
function evictPages() {
  if (evicting) return; // 回收期间工具 unmount 引发的连锁事件不再递归进来
  evicting = true;
  try {
    for (;;) {
      let touchedCount = 0;
      for (const page of pages.values()) if (page.touched) touchedCount++;
      // 兜底：没动过的页正常不驻留（切走即释放），总页数也不该无限涨
      if (touchedCount <= MAX_ALIVE_PAGES && pages.size <= MAX_ALIVE_PAGES + 1) return;
      const others = [...pages].filter(([id]) => !(activeTool && activeTool.id === id));
      if (!others.length) return; // 只剩当前页：当前页永不淘汰
      const idle = others.filter(([, page]) => !page.touched);
      const pool = idle.length ? idle : others;
      let victim = pool[0];
      for (const entry of pool) {
        if (entry[1].lastUsed < victim[1].lastUsed) victim = entry;
      }
      disposePage(victim[0], victim[1], { silent: !victim[1].touched });
    }
  } finally {
    evicting = false;
  }
}

/**
 * 每个工具一份 ctx：在通用能力之上加「当前页」感知。
 * - ctx.isActive()：工具是否正显示在右侧（隐藏时不要抢全局交互，如窗口快捷键）；
 * - setStatus / setInfo：始终记到本页（切回来能恢复），但只有当前页才改顶栏；
 * - showProgress / hideProgress：同样「始终记到本页、只有当前页才动遮罩」，避免隐藏的
 *   工具误开/误关。**记录这一步是关键**：进度遮罩是全局唯一一个，如果切走时不记下
 *   「这一页正开着进度」，切回来就恢复不了；反过来，切走时也必须把它关掉——否则
 *   上一工具的进度条会僵在新工具页面上（该页被 LRU 回收后就再也没人来关了）。
 */
function makeToolCtx(tool) {
  const active = () => !!(activeTool && activeTool.id === tool.id);
  return {
    ...ctx,
    isActive: active,
    setStatus: (text) => {
      const page = pages.get(tool.id);
      if (page) page.status = text;
      if (active()) setStatus(text);
    },
    setInfo: (info = {}) => {
      const page = pages.get(tool.id);
      if (page) page.info = info || {};
      if (active()) setInfo(info);
    },
    showProgress: (text, percent) => {
      const page = pages.get(tool.id);
      if (page) page.progress = { text, percent };
      if (active()) showProgress(text, percent);
    },
    hideProgress: () => {
      const page = pages.get(tool.id);
      if (page) page.progress = null;
      if (active()) hideProgress();
    }
  };
}

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

/** 生成一个工具按钮（左侧列表项） */
function createToolButton(tool) {
  const btn = document.createElement('button');
  btn.className = 'tool-item' + (activeTool && tool.id === activeTool.id ? ' is-active' : '');
  btn.dataset.toolId = tool.id;
  btn.innerHTML = `<span class="tool-item-icon">${tool.icon || '🔧'}</span><span>${tool.name}</span>`;
  btn.addEventListener('click', () => {
    // 长按拖动排序（navsort.js）拖完的 click 已在 capture 阶段拦下，这里只管正常切换
    switchTool(tool.id);
  });
  return btn;
}

// —— 左侧分组折叠（点标题收起/展开，收起状态记到设置里） ——

/**
 * 被收起的分组 id 集合。
 * 默认 = 全部收起（用户要求）：分类只显示标题与数量，点标题才展开子项，
 * 避免工具变多后侧栏被全部展开的条目撑长、找东西费劲。
 * settings.collapsedGroups 里只有「用户明确点过」的结果；没设置过（null）就用默认值。
 */
let collapsedGroups = new Set(GROUPS.map((g) => g.id));
/** groupId → { wrap, head, items }，供折叠与自动展开使用 */
const navGroups = new Map();

function persistCollapsed() {
  // 记忆折叠状态；写入失败不影响使用（下次启动退回默认：全部收起）
  settings.updateSettings({ collapsedGroups: [...collapsedGroups] }).catch(() => {});
}

/**
 * 收起/展开的平滑过渡：先把「当前高度」写成内联 max-height 作为起点，
 * 下一帧再改成目标高度（收起 0 / 展开内容高度），过渡结束清掉内联值回到自适应。
 * 这样任何行数都能自然过渡，不会像 display:none 那样硬闪。
 */
function animateCollapse(items, collapsed) {
  items.style.maxHeight = `${items.getBoundingClientRect().height}px`;
  void items.offsetHeight; // 强制回流：让起点高度先落定，否则浏览器把它合并成一次变化、看不到动效
  items.style.maxHeight = collapsed ? '0px' : `${items.scrollHeight}px`;

  const finish = () => {
    items.removeEventListener('transitionend', onEnd);
    clearTimeout(timer);
    items.style.maxHeight = ''; // 交还给样式表（展开=自适应，收起=0）
  };
  const onEnd = (event) => {
    if (event.propertyName === 'max-height') finish();
  };
  items.addEventListener('transitionend', onEnd);
  // 兜底：系统「减少动态效果」或过渡被打断时也能收尾
  const timer = setTimeout(finish, 420);
}

/** 用户点标题：切成收起/展开，并记住这个选择（写进设置） */
function setGroupCollapsed(groupId, collapsed) {
  if (collapsed) collapsedGroups.add(groupId);
  else collapsedGroups.delete(groupId);

  applyGroupVisual(groupId, collapsed);
  persistCollapsed();
}

/** 更新分组标题的展开/收起提示（瞬时与带动画两条路径共用） */
function syncGroupHead(head, collapsed) {
  head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  head.title = collapsed ? `展开「${head.dataset.groupName}」` : `收起「${head.dataset.groupName}」`;
}

/**
 * 只改外观，不动偏好设置——自动展开与用户点击共用。
 * instant=true：不播收起/展开动画（用于「切工具时自动展开所在分组」，
 * 否则每次切工具都会看到分组先折叠再打开、整列闪一下）。
 */
function applyGroupVisual(groupId, collapsed, instant = false) {
  const entry = navGroups.get(groupId);
  if (!entry) return;
  const { wrap, head, items } = entry;

  if (instant) {
    items.style.transition = 'none'; // 这一次的 max-height / opacity / visibility 全部瞬时生效
    items.style.maxHeight = '';      // 清掉上次动画残留的内联高度，交还给样式表
    wrap.classList.toggle('is-collapsed', collapsed);
    syncGroupHead(head, collapsed);
    void items.offsetHeight;         // 让瞬时状态先落定
    items.style.transition = '';     // 恢复过渡能力，之后用户手动点标题仍有平滑动画
    return;
  }

  animateCollapse(items, collapsed);
  wrap.classList.toggle('is-collapsed', collapsed);
  syncGroupHead(head, collapsed);
}

/**
 * 保证指定分组是展开的：切到该组内的工具时调用，避免「当前工具藏在收起的分组里」。
 * 瞬时展开（不播动画）；只改当前这次显示（不写设置、也不改用户偏好）——
 * 列表下次重渲染时仍按用户的偏好来，所以「用户明明收起了这一类」不会被悄悄改成永久展开。
 */
function ensureGroupExpanded(groupId) {
  const entry = groupId ? navGroups.get(groupId) : null;
  if (!entry || !entry.wrap.classList.contains('is-collapsed')) return;
  applyGroupVisual(groupId, false, true);
}

/**
 * 只更新「当前工具」的高亮，不重建导航。
 * 用户反馈：以前每切一次工具都整列重建，重建瞬间按偏好渲染成收起、紧接着又展开，
 * 看起来就是「先折叠再打开 + 闪一下」。改成复用同一批 DOM，只挪 is-active。
 */
function updateActiveNav(toolId) {
  for (const btn of els.nav.querySelectorAll('.tool-item')) {
    btn.classList.toggle('is-active', btn.dataset.toolId === toolId);
  }
}

/**
 * 渲染左侧工具列表：按分组显示，分组与组内顺序取 settings.navOrder（手动排序，见 navsort.js），
 * 没排过序（null）时按 GROUPS 定义 × 组内 order 升序；非法数据由 computeNavPlan 净化（回退默认，不丢工具）。
 * 每个分组标题可点击：点一下收起（只留标题）、再点一下展开；收起状态会记住（settings.collapsedGroups）。
 * 容错：未声明 group（或声明了未知分组）的工具归入末尾「其它」组。
 */
function renderNav() {
  navSort.cancelDrag(); // 防御：重建 DOM 前结束任何拖拽，绝不带着拖拽状态重建 DOM
  els.nav.innerHTML = '';
  navGroups.clear();
  const plan = computeNavPlan(GROUPS, TOOLS, settings.getSettings().navOrder);

  const renderGroup = (group, tools) => {
    if (tools.length === 0) return; // 空分组不显示
    const collapsed = collapsedGroups.has(group.id); // 一律按用户偏好渲染，当前工具所在组随后再展开

    const wrap = document.createElement('div');
    wrap.className = 'tool-group' + (collapsed ? ' is-collapsed' : '');
    wrap.dataset.groupId = group.id;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'tool-group-head';
    head.dataset.groupId = group.id;
    head.dataset.groupName = group.name;
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    head.title = collapsed ? `展开「${group.name}」` : `收起「${group.name}」`;
    head.innerHTML = '<span class="tool-group-chevron" aria-hidden="true"></span>'
      + `<span class="tool-group-icon">${group.icon || '📁'}</span>`
      + `<span class="tool-group-name">${group.name}</span>`
      + `<span class="tool-group-count">${tools.length}</span>`;
    // 以「眼睛看到的当前状态」为准取反：自动展开过的分组，点一下就是收起
    head.addEventListener('click', () => {
      // 长按拖动排序（navsort.js）拖完的 click 已在 capture 阶段拦下，这里只管展开/收起
      setGroupCollapsed(group.id, !wrap.classList.contains('is-collapsed'));
    });
    wrap.appendChild(head);

    const items = document.createElement('div');
    items.className = 'tool-group-items';
    for (const tool of tools) items.appendChild(createToolButton(tool));
    wrap.appendChild(items);

    els.nav.appendChild(wrap);
    navGroups.set(group.id, { wrap, head, items });
  };

  for (const group of plan) {
    renderGroup(group, group.tools);
  }

  // 重建后当前工具所在的分组必须仍是展开的（瞬时展开，不播动画）
  ensureGroupExpanded(activeTool && activeTool.group);
  // 「↺ 恢复默认顺序」只在用户排过序（navOrder 非空）时显示（拖放落盘后由 persist 回调再刷一次）
  syncNavReset();
}

// —— 导航手动排序（v2.6.0；v2.11.0 起长按条目即可拖动，不再有排序模式）——
// 分组（主项目）与组内工具（子项目）各自独立排序；顺序存 settings.navOrder（null = 默认序）。
// 快速点击不受影响：点工具切换、点分组标题展开/收起（拖完的 click 由 navsort 在 capture 阶段拦下）。

/** 「↺ 恢复默认顺序」按钮：只在用户排过序（settings.navOrder 非空）时显示，没排过序不占地方 */
function syncNavReset() {
  if (els.navReset) els.navReset.hidden = !settings.getSettings().navOrder;
}

const navSort = createNavSort({
  nav: els.nav,
  persist: (order) => settings.updateSettings({ navOrder: order }).then(() => {
    syncNavReset();
    setStatus('工具顺序已保存');
  }),
  resetOrder: async () => {
    await settings.updateSettings({ navOrder: null });
    renderNav(); // 顺带把恢复按钮藏回去（navOrder 已为 null）
    setStatus('已恢复默认顺序');
  },
  onStatus: setStatus
});

/**
 * 切换到指定工具：只切换「显示哪个页面」，不销毁其它页面。
 * 首次进入某工具时才 mount；之后每次切回只是显示出来，页面内容与数据原样保留（用户要求）。
 * 生命周期：mount（首次进入一次）→ 反复 activate / deactivate（每次切入/切出）；
 *          unmount（切走时它「没动过」、或动过的页被 LRU 回收、或将来别的销毁时机）——下次进入会重新 mount。
 * 保活只保「动过」的页：动过的超出 MAX_ALIVE_PAGES 时淘汰最久没用过的那页（见 evictPages）。
 */
function switchTool(id) {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool || (activeTool && activeTool.id === tool.id)) return;

  const prev = activeTool;
  if (prev) {
    const prevPage = pages.get(prev.id);
    if (prevPage && prevPage.touched) {
      prevPage.scrollTop = prevPage.el.scrollTop; // 先记滚动位置：脱离文档后它会归零
      prevPage.el.classList.remove('is-active');
      prevPage.el.remove();
    }
    if (typeof prev.deactivate === 'function') {
      try {
        prev.deactivate();
      } catch (err) {
        console.error('[shell] 工具 deactivate 失败', err);
      }
    }
    if (prevPage && !prevPage.touched) {
      // 没动过的页：只是被点开看了一眼，没有内容可保 —— 就静默释放（不占额度、不提示），
      // 下次进来重新 mount（与首次进入一模一样，用户察觉不到）；也就不会挤掉别处做过的事
      disposePage(prev.id, prevPage, { silent: true });
    }
  }

  const page = pageFor(tool);
  loadToolStyles(tool.styles);
  activeTool = tool;
  // 只挪高亮 + 瞬时展开所在分组：绝不重建导航（重建会让分组先折叠再打开、整列闪一下）
  ensureGroupExpanded(tool.group);
  updateActiveNav(tool.id);

  try {
    if (!page.mounted) {
      page.mounted = true;
      tool.mount(page.el, makeToolCtx(tool));
    } else if (typeof tool.activate === 'function') {
      tool.activate();
    }
    page.el.classList.add('is-active'); // 先加类再入文档：入文档时正好播一次切换动画
    els.host.appendChild(page.el);
    void page.el.offsetHeight; // 强制一次布局，下面恢复滚动位置才生效
    page.el.scrollTop = page.scrollTop;
    // 恢复这一页上次的提示与参数信息（不是清空）；若是被 LRU 回收后重新挂载的，说明一句原因
    const wasReleased = releasedTools.delete(tool.id);
    setStatus(wasReleased ? `${page.status}（用过的工具较多，上次的内容已自动释放）` : page.status);
    setInfo(page.info);
    // 进度遮罩全局只有一个：按这一页记下的状态恢复，没记就确保关掉。
    // 于是「切走时一定关掉、切回仍在跑的工具时又能接上」两头都成立。
    if (page.progress) showProgress(page.progress.text, page.progress.percent);
    else hideProgress();
    evictPages(); // 新页进来后再回收，保证「当前页永不淘汰」
  } catch (err) {
    page.mounted = false;
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

  // 关闭：先播一小段淡出动画再移除（动效见 components.css 的 is-closing）
  let closing = false;
  function close() {
    if (closing) return;
    closing = true;
    document.removeEventListener('keydown', onEsc);
    const remove = () => backdrop.remove();
    backdrop.classList.add('is-closing');
    backdrop.addEventListener('animationend', (event) => {
      if (event.target === backdrop) remove(); // 只认遮罩自己的动画，避免卡片动画提前触发移除
    });
    setTimeout(remove, 300); // 兜底：动效被禁用或动画事件缺失时也能正常关闭
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
  const modal = showModal({
    title: '设置',
    bodyHTML: `
      <div class="field">
        <label class="field-label">外观</label>
        <select class="select" id="setTheme">
          ${THEME_MODES.map((m) => `<option value="${m.value}"${s.theme === m.value ? ' selected' : ''}>${m.icon} ${m.label}</option>`).join('')}
        </select>
        <div class="field-hint">默认「跟随系统」：系统是深色就用深色。也可在顶栏右上角一键切换。</div>
      </div>
      <div class="field">
        <label class="field-label">方块数（方块混淆 B 模式）</label>
        <input class="input" id="setBlockSize" type="number" min="2" max="256" step="1" value="${escapeHtml(s.blockSize)}" />
        <div class="field-hint">默认 32（与手机版一致）。改大更碎、改小更快。</div>
      </div>
      <div class="field">
        <label class="field-label">JPG 画质（空间曲线混淆保存用）</label>
        <input class="input" id="setJpegQuality" type="number" min="1" max="100" step="1" value="${escapeHtml(s.jpegQuality)}" />
        <div class="field-hint">默认 95（与手机版一致）。越低体积越小、画质越差。</div>
      </div>
      <div class="field">
        <label class="field-label">默认密钥（PE1 / PE2）</label>
        <input class="input" id="setDefaultKey" type="text" value="${escapeHtml(s.defaultDoubleKey)}" />
        <div class="field-hint">默认 0.666（与手机版一致），必须是 0 到 1 之间的小数。</div>
      </div>
      <div class="field">
        <label class="field-label">输出目录</label>
        <div class="control-row">
          <input class="input" id="setOutputDir" type="text" value="${escapeHtml(s.outputDir)}" placeholder="留空 = 保存在原图旁边" />
          <button class="btn btn-ghost" id="setOutputDirPick" type="button">选择文件夹…</button>
          <button class="btn btn-ghost" id="setOutputDirClear" type="button">用原图旁边</button>
        </div>
        <div class="field-hint">点「选择文件夹…」直接挑选；留空或点「用原图旁边」＝与手机版一致：保存到原图所在目录。</div>
      </div>
      <label class="field-check">
        <input type="checkbox" id="setAskSavePath" ${s.askSavePath ? 'checked' : ''} />
        <span>每次保存前询问保存位置</span>
      </label>
      <div class="field">
        <label class="field-label">设置备份（换电脑 / 重装时用）</label>
        <div class="control-row">
          <button class="btn btn-ghost" id="setExport" type="button">导出设置…</button>
          <button class="btn btn-ghost" id="setImport" type="button">导入设置…</button>
        </div>
        <div class="field-hint">导出成一个小 json 文件；在别的电脑上点「导入设置…」选中它即可恢复。导入只合并本软件认识的设置项。</div>
      </div>
    `,
    actions: [
      {
        label: '恢复默认（手机版行为）',
        className: 'btn-ghost',
        onClick: async (backdrop) => {
          const d = await settings.resetSettings();
          // 只刷新当前弹窗里的值，不重开弹窗（避免闪烁与误操作）
          backdrop.querySelector('#setTheme').value = d.theme;
          backdrop.querySelector('#setBlockSize').value = d.blockSize;
          backdrop.querySelector('#setJpegQuality').value = d.jpegQuality;
          backdrop.querySelector('#setDefaultKey').value = d.defaultDoubleKey;
          backdrop.querySelector('#setOutputDir').value = d.outputDir;
          backdrop.querySelector('#setAskSavePath').checked = d.askSavePath;
          applyTheme(d.theme); // 外观恢复默认后要立即生效
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
          const theme = backdrop.querySelector('#setTheme').value;
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
          await settings.updateSettings({ theme, blockSize, jpegQuality, defaultDoubleKey, outputDir, askSavePath });
          applyTheme(theme); // 保存后立即生效（不必重启）
          setStatus('设置已保存（下次处理与保存立即生效）');
          return false;
        }
      }
    ]
  });

  // 「选择文件夹…」「用原图旁边」——与添加图片一样用系统选择框，省得手打路径
  const dirInput = modal.backdrop.querySelector('#setOutputDir');
  modal.backdrop.querySelector('#setOutputDirPick').addEventListener('click', async () => {
    const dir = await ctx.openFolder();
    if (dir) {
      dirInput.value = dir;
      setStatus(`输出目录已选择：${dir}`);
    }
  });
  modal.backdrop.querySelector('#setOutputDirClear').addEventListener('click', () => {
    dirInput.value = '';
    setStatus('输出目录已设为「保存在原图旁边」');
  });

  // 导出 / 导入设置（见 spec/modules/settings-io.md）
  modal.backdrop.querySelector('#setExport').addEventListener('click', async () => {
    const res = await window.desktop.settingsExport();
    if (!res || res.canceled) return;
    setStatus(res.ok ? `设置已导出到：${res.path}` : `导出失败：${res.message || '未知原因'}`);
  });

  modal.backdrop.querySelector('#setImport').addEventListener('click', async () => {
    const res = await window.desktop.settingsImport();
    if (!res || res.canceled) return;
    if (!res.ok) {
      setStatus(`导入失败：${res.message || '未知原因'}`);
      return;
    }
    // 导入成功后要让界面立刻反映新设置：重载共享层内存态、刷新各控件、应用主题、重渲染导航
    const fresh = await settings.reloadSettings();
    refreshSettingsModalFrom(modal.backdrop, fresh);
    applyTheme(fresh.theme);
    collapsedGroups = new Set(
      Array.isArray(fresh.collapsedGroups) ? fresh.collapsedGroups : GROUPS.map((g) => g.id)
    );
    renderNav();
    // 已知键但值不合法的会被主进程跳过（防恶意设置文件），这里如实说明，不静默丢弃
    const skipNote = (res.skipped && res.skipped.length)
      ? `；另有 ${res.skipped.length} 项值不合法已跳过（${res.skipped.map((x) => x.key).join('、')}）`
      : '';
    setStatus(`设置已导入（${res.applied.length} 项）：${res.applied.join('、')}${skipNote}`);
  });
}

/** 把设置值回填到设置弹窗的各个控件（导入设置、恢复默认后共用） */
function refreshSettingsModalFrom(backdrop, s) {
  const set = (sel, value) => {
    const el = backdrop.querySelector(sel);
    if (el) el.value = value;
  };
  set('#setTheme', s.theme);
  set('#setBlockSize', s.blockSize);
  set('#setJpegQuality', s.jpegQuality);
  set('#setDefaultKey', s.defaultDoubleKey);
  set('#setOutputDir', s.outputDir);
  const check = backdrop.querySelector('#setAskSavePath');
  if (check) check.checked = !!s.askSavePath;
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
      <div class="help-section">
        <h4>关于</h4>
        <p>当前版本：<b>v${appInfo && appInfo.version ? appInfo.version : '未知'}</b>${appInfo && appInfo.packaged ? '（免安装版）' : '（开发调试版）'} ｜ 内核：Electron ${ctx.versions.electron} · Chrome ${ctx.versions.chrome}</p>
      </div>
    `,
    actions: [{ label: '知道了', className: 'btn-obfuscate' }]
  });
}

async function init() {
  const loadedSettings = await settings.loadSettings();
  // 应用上次记住的分组收起状态（设置读取是异步的，这里拿到后重渲染一次列表）。
  // 没设置过（null/缺省）＝用默认值：全部分组收起，只显示分类标题（避免侧栏一长串）。
  collapsedGroups = new Set(
    Array.isArray(loadedSettings.collapsedGroups)
      ? loadedSettings.collapsedGroups
      : GROUPS.map((g) => g.id)
  );
  renderNav();

  // 外观：按用户档位上色（启动瞬间已按系统偏好铺过一次，这里纠正为用户的明确选择）
  applyTheme(loadedSettings.theme);
  darkMedia.addEventListener('change', onSystemThemeChange);
  if (els.btnTheme) {
    els.btnTheme.addEventListener('click', () => {
      // 三态循环：跟随系统 → 浅色 → 深色 → 跟随系统
      const i = THEME_MODES.findIndex((m) => m.value === themeMode);
      setTheme(THEME_MODES[(i + 1) % THEME_MODES.length].value);
    });
  }

  // 版本号：异步补上即可，绝不能阻塞工具列表渲染（否则窗口刚打开时列表会短暂为空）
  window.desktop.appInfo()
    .then((info) => {
      appInfo = info;
      const versionEl = document.getElementById('appVersion');
      if (versionEl && info && info.version) versionEl.textContent = `v${info.version}`;
    })
    .catch(() => {
      /* 读不到版本时保持占位符，不影响使用 */
    });

  els.btnSettings.addEventListener('click', openSettings);
  els.btnHelp.addEventListener('click', openHelp);

  // 任务中心：由 shell 持有；打开/关闭只影响面板，不影响队列里的任务继续跑
  taskCenter = createTaskCenter({ queue: taskQueue });
  if (els.btnTasks) els.btnTasks.addEventListener('click', () => taskCenter.toggle());
  refreshTaskBadge();

  // 启动默认打开「排序里最前面的分组」的第一个工具（v2.7.1，用户要求）：
  // 排第一 = 最常用——启动直接进它的第一个工具，只展开这一个分组，其余分组按用户偏好显示。
  // 从没排过序（navOrder=null）时 = 默认序的第一个分组（图片 → 图片混淆），与旧版行为一致。
  // 背景（用户反馈）：旧版固定打开「图片混淆」，它所在分组会被「切工具自动展开所在分组」
  // 规则重新打开——用户把它收起来过也没用，看起来像设置失效。
  const startupTool = pickStartupTool(computeNavPlan(GROUPS, TOOLS, loadedSettings.navOrder));
  if (startupTool) {
    switchTool(startupTool.id);
  } else {
    setStatus('还没有任何工具');
  }
}

// 先把左侧工具列表渲染出来，再等设置加载后切到启动默认工具（排最前分组的第一个，见 init 末尾）。
// 背景：设置读取是异步的，原先要等它回来才渲染列表，窗口刚打开时会有一瞬空白侧栏
//      （自动化测试也可能在这一瞬点不到工具）。列表渲染不依赖设置，提前渲染即可。
renderNav();
init();