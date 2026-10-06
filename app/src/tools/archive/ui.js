// 工具：文件压缩与解压 —— 界面与交互
// 分层：本文件只做界面与流程编排；格式表/参数拼装/作业计划/引擎调用分别在 core/ 的四个模块。
// 规格：spec/modules/archive.md
import {
  BIDIRECTIONAL, EXTRACT_ONLY, LEVELS, VOLUME_SIZES, OVERWRITE_MODES, TREE_MODES,
  formatById, supportsVolume, isCompound, isNodeFormat, looksLikeVolumePart,
  looksLikeFirstVolume, firstVolumeName
} from './core/formats.mjs';
import {
  suggestArchiveBase, buildCreatePlan, buildExtractPlan, validateCreate,
  validateExtract, humanBytes, ratioText, stripArchiveExt, baseNameOf
} from './core/plan.mjs';

const MAX_LIST_PREVIEW = 500; // 预览最多渲染多少行（上千条时只渲染前面一部分，避免卡顿）

const MARKUP = `
  <div class="arc-tool">
    <div class="arc-modes">
      <button class="arc-mode-btn is-active" id="arcModePack" type="button" data-mode="pack">🗜️ 压缩</button>
      <button class="arc-mode-btn" id="arcModeUnpack" type="button" data-mode="unpack">📂 解压</button>
      <span class="arc-mode-spacer"></span>
      <span class="arc-engine" id="arcEngine"></span>
    </div>

    <div class="arc-warn" id="arcWarn" hidden></div>

    <!-- 压缩参数 -->
    <section class="card arc-controls" id="arcPackControls">
      <div class="arc-row">
        <span class="control-label">压缩格式</span>
        <select class="select arc-w-lg" id="arcFormat"></select>
        <select class="select arc-w-md" id="arcLevel"></select>
        <span class="control-hint" id="arcFormatHint"></span>
      </div>
      <div class="arc-row">
        <span class="control-label">分卷大小</span>
        <select class="select arc-w-md" id="arcVolume"></select>
        <span class="control-hint" id="arcVolumeHint">大文件切块（只有支持分卷的格式可用）</span>
      </div>
      <div class="arc-row">
        <span class="control-label">密码</span>
        <input class="input arc-w-md" id="arcPassword" type="password" placeholder="留空 = 不加密" />
        <select class="select arc-w-md" id="arcEncrypt">
          <option value="zip-aes256">ZIP：AES-256（更安全）</option>
          <option value="zipcrypto">ZIP：ZipCrypto（资源管理器可打开）</option>
        </select>
        <label class="arc-check"><input type="checkbox" id="arcShowPassword" /> 显示密码</label>
      </div>
      <div class="arc-row">
        <span class="control-label">输出位置</span>
        <input class="input arc-w-lg" id="arcOutputDir" type="text" readonly placeholder="与源文件相同目录" />
        <button class="btn btn-ghost" id="arcPickOutput" type="button">选择…</button>
        <button class="btn btn-ghost" id="arcClearOutput" type="button">用默认</button>
      </div>
      <div class="arc-row-note" id="arcPackNote"></div>
    </section>

    <!-- 解压参数 -->
    <section class="card arc-controls" id="arcUnpackControls" hidden>
      <div class="arc-row">
        <span class="control-label">解压到</span>
        <input class="input arc-w-lg" id="arcExtractDir" type="text" readonly placeholder="每个压缩包旁边新建同名文件夹" />
        <button class="btn btn-ghost" id="arcPickExtract" type="button">选择…</button>
        <button class="btn btn-ghost" id="arcClearExtract" type="button">用默认</button>
      </div>
      <div class="arc-row">
        <span class="control-label">已存在时</span>
        <select class="select arc-w-md" id="arcOverwrite"></select>
        <select class="select arc-w-md" id="arcTree"></select>
        <span class="control-label">密码</span>
        <input class="input arc-w-md" id="arcPasswordX" type="password" placeholder="加密包才需要" />
      </div>
      <div class="arc-row-note" id="arcUnpackNote"></div>
    </section>

    <main class="arc-main">
      <section class="card arc-files">
        <div class="arc-drop" id="arcDrop">
          <button class="btn btn-primary btn-lg" id="arcAddBtn" type="button" data-add="1">添加文件</button>
          <button class="btn btn-plain" id="arcAddDirBtn" type="button" data-adddir="1">添加文件夹</button>
          <div class="arc-drop-hint" id="arcDropHint">也可以把文件或文件夹直接拖进窗口</div>
        </div>
        <div class="arc-list-head" id="arcListHead" hidden>
          <span id="arcListTitle">文件</span>
          <span class="arc-spacer"></span>
          <span class="control-hint" id="arcCount"></span>
          <button class="btn btn-ghost" id="arcAddMore" type="button" data-add="1">＋ 继续添加</button>
        </div>
        <ul class="arc-list" id="arcList"></ul>
      </section>

      <section class="card arc-preview" id="arcPreview">
        <div class="arc-preview-head">
          <span class="arc-preview-title" id="arcPreviewTitle">内容预览</span>
          <span class="arc-spacer"></span>
          <input class="input arc-search" id="arcPreviewSearch" type="text" placeholder="搜索文件名…" />
        </div>
        <div class="arc-preview-summary" id="arcPreviewSummary"></div>
        <div class="arc-preview-empty" id="arcPreviewEmpty">选中左侧一个压缩包，这里会列出里面的内容（不用解压）</div>
        <ul class="arc-entries" id="arcEntries" hidden></ul>
      </section>
    </main>

    <footer class="arc-actions">
      <button class="btn btn-primary" id="arcRunBtn" type="button" data-run="1">开始压缩</button>
      <button class="btn btn-plain" id="arcCancelBtn" type="button" hidden>取消</button>
      <button class="btn btn-plain" id="arcClearBtn" type="button" data-clear="1">清空</button>
      <div class="arc-result" id="arcResult"></div>
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
    opt.value = String(o.value != null ? o.value : o.id);
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
}

// —— 格式下拉（分「常用 / 非主流 / 仅解压」三组） ——

function fillFormatSelect(sel) {
  sel.innerHTML = '';
  const groups = [
    { label: '常用格式', items: BIDIRECTIONAL.filter((f) => f.group === 'common') },
    { label: '其它格式（同样支持压缩 + 解压）', items: BIDIRECTIONAL.filter((f) => f.group === 'alt') },
    { label: '更多格式（仅解压，不能压缩）', items: EXTRACT_ONLY }
  ];
  for (const g of groups) {
    const og = document.createElement('optgroup');
    og.label = g.label;
    for (const f of g.items) {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.password === undefined
        ? `${f.name}（${f.ext}）— 仅解压`
        : `${f.name}（${f.ext}）`;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
}

// —— 压缩参数联动 ——

function isPackMode() {
  return state.mode === 'pack';
}

function selectedFormat() {
  return formatById(state.els.format.value);
}

function refreshPackControls() {
  const { els } = state;
  const fmt = selectedFormat();
  if (!fmt) return;
  const extractOnly = fmt.password === undefined;

  // 分卷：只有 zip / 7z / tar 支持；流式与复合格式禁用并说明
  const volOk = supportsVolume(fmt);
  els.volume.disabled = extractOnly || !volOk;
  if (!volOk && !extractOnly) els.volume.value = '0';
  els.volumeHint.textContent = extractOnly
    ? '该格式只能解压'
    : volOk
      ? '大文件切块（解压时只需选第一卷 .001）'
      : `${fmt.name} 不支持分卷（分卷仅 ZIP / 7Z / TAR 可用）`;

  // 级别：TAR 只打包不压缩
  els.level.disabled = extractOnly || fmt.id === 'tar';

  // 密码：只有 7z / zip 支持
  const pwOk = !!fmt.password;
  els.password.disabled = extractOnly || !pwOk;
  els.encrypt.disabled = !pwOk || fmt.password !== 'zip';
  els.showPassword.disabled = els.password.disabled;

  // 加密方式下拉只在 zip 时有意义
  els.encrypt.title = fmt.password === 'zip'
    ? 'AES-256 更安全；ZipCrypto 老式加密，Windows 资源管理器也能打开'
    : '';

  const hints = [];
  if (extractOnly) {
    hints.push(`⚠️ ${fmt.name} 是**仅解压**格式：${fmt.note || '免费工具无法创建它'}。想压缩请换成上方的 ZIP / 7Z / TAR 等格式。`);
  }
  if (fmt.password === '7z') hints.push('7Z 密码用 AES-256 加密，连文件名都会一起加密（不输密码看不到内容清单）。');
  if (fmt.password === 'zip') hints.push('ZIP 密码只能用英文、数字与常见符号（7-Zip 限制；中文密码请改用 7Z）。');
  if (fmt.id === 'tar') hints.push('TAR 只打包、不压缩（体积基本不变），常配合 GZIP/BZIP2/XZ 使用。');
  if (isCompound(fmt)) hints.push('这是「先打包再压缩」的两步格式，输出为单个压缩包。');
  if (isNodeFormat(fmt)) hints.push('ZSTANDARD / BROTLI 由软件内置引擎处理，不依赖 7-Zip 加装包。');
  els.packNote.textContent = hints.join(' ');
  els.packNote.className = `arc-row-note${extractOnly ? ' is-warn' : ''}`;

  // 格式被换掉后，原基名可能不再合适（例如 gzip 要保留原文件名）
  state.baseNameTouched = false;
  refreshDropHint();
  refreshRunState();
}

/** 拖放区与按钮文案随模式变化 */
function refreshDropHint() {
  const { els } = state;
  els.dropHint.textContent = isPackMode()
    ? '也可以把文件或文件夹直接拖进窗口；支持多选'
    : '也可以把压缩包直接拖进窗口（含 RAR / ISO 等仅解压格式）';
  els.listTitle.textContent = isPackMode() ? '待压缩' : '压缩包';
  els.preview.hidden = isPackMode();
  els.packControls.hidden = !isPackMode();
  els.unpackControls.hidden = isPackMode();
}

/** 当前模式下的「开始」按钮是否可点 + 提示文案 */
function refreshRunState() {
  const { els } = state;
  if (state.busy) return;
  if (isPackMode()) {
    const v = validateCreate({ formatId: els.format.value, inputs: state.files, password: readPassword(), encrypt: readEncrypt() });
    els.runBtn.disabled = !v.ok;
    els.runNote = v.ok ? '' : v.message;
  } else {
    const v = validateExtract({ archives: state.files, password: readPassword() });
    els.runBtn.disabled = !v.ok;
    els.runNote = v.ok ? '' : v.message;
  }
  if (!state.resultLocked) els.result.textContent = els.runNote || '';
  els.result.className = `arc-result${els.runNote ? ' is-error' : ''}`;
}

function readPassword() {
  const { els } = state;
  return (isPackMode() ? els.password.value : els.passwordX.value).trim();
}

/** 写结果行；写过的内容在下一次操作前不被表单刷新覆盖 */
function setResult(text, isError = false) {
  if (!state) return;
  state.resultLocked = true;
  state.els.result.textContent = text;
  state.els.result.className = `arc-result${isError ? ' is-error' : ''}`;
}

function readEncrypt() {
  return state.els.encrypt.value;
}

// —— 文件列表 ——

const EXT_ICONS = {
  zip: '🗜️', '7z': '🗜️', tar: '📦', gz: '📦', bz2: '📦', xz: '📦', zst: '📦', br: '📦',
  rar: '🗜️', cab: '📦', iso: '💿'
};

function iconFor(f) {
  if (isPackMode()) return f.isDirectory ? '📁' : '📄';
  return EXT_ICONS[f.ext] || '🗜️';
}

function renderList() {
  const { els } = state;
  const files = state.files;
  els.listHead.hidden = files.length === 0;
  els.drop.hidden = files.length > 0;
  els.count.textContent = files.length
    ? `共 ${files.length} ${isPackMode() ? '项' : '个'}`
    : '';
  els.list.innerHTML = '';

  files.forEach((f, index) => {
    const li = document.createElement('li');
    li.className = 'arc-item';
    if (!isPackMode() && state.selected === index) li.classList.add('is-selected');

    const icon = document.createElement('span');
    icon.className = 'arc-item-icon';
    icon.textContent = iconFor(f);
    li.appendChild(icon);

    const main = document.createElement('div');
    main.className = 'arc-item-main';
    const name = document.createElement('div');
    name.className = 'arc-item-name';
    name.textContent = f.name;
    name.title = f.path;
    const meta = document.createElement('div');
    meta.className = 'arc-item-meta' + (f.error ? ' is-error' : '');
    meta.textContent = f.meta || humanBytes(f.size || 0);
    main.appendChild(name);
    main.appendChild(meta);
    li.appendChild(main);

    // 压缩模式下：加装包缺失时，7-Zip 格式的项给个提示（zst/br 仍可用）
    if (f.tag) {
      const tag = document.createElement('span');
      tag.className = `arc-tag${f.tagClass ? ` ${f.tagClass}` : ''}`;
      tag.textContent = f.tag;
      tag.title = f.tagTitle || '';
      li.appendChild(tag);
    }

    const actions = document.createElement('div');
    actions.className = 'arc-item-actions';
    const del = document.createElement('button');
    del.className = 'arc-icon-btn';
    del.textContent = '×';
    del.title = '移除';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      state.files.splice(index, 1);
      if (state.selected === index) state.selected = -1;
      else if (state.selected > index) state.selected -= 1;
      renderList();
      if (!isPackMode()) refreshPreview();
      refreshRunState();
    });
    actions.appendChild(del);
    li.appendChild(actions);

    if (!isPackMode()) {
      li.addEventListener('click', () => selectArchive(index));
    }
    els.list.appendChild(li);
  });

  refreshRunState();
}

function selectArchive(index) {
  if (state.selected === index) return;
  state.selected = index;
  renderList();
  refreshPreview();
}

// —— 添加文件 ——

async function addFromPaths(paths) {
  const failures = [];
  let added = 0;

  const pushOne = async (p) => {
    const info = await state.ctx.pathInfo(p);
    if (info.isDirectory) {
      if (isPackMode()) {
        state.files.push({
          path: p, name: info.name, isDirectory: true, size: 0,
          meta: '文件夹（整包压缩）'
        });
        added += 1;
      } else {
        failures.push(`${info.name}：解压模式不能添加文件夹，请选择压缩包文件`);
      }
      return;
    }
    if (isPackMode()) {
      state.files.push({ path: p, name: info.name, isDirectory: false, size: info.size || 0 });
    } else {
      const ext = (info.ext || '').toLowerCase();
      // 解压按签名自动识别：这里只对「分卷的非首卷」做提示，不做格式拦截
      const volumeHint = looksLikeVolumePart(info.name) && !looksLikeFirstVolume(info.name);
      const fmt = findArchiveFormatLabel(info.name);
      state.files.push({
        path: p, name: info.name, ext, isDirectory: false, size: info.size || 0,
        meta: `${humanBytes(info.size || 0)}${fmt ? ` ｜ ${fmt}` : ''}${volumeHint ? ' ｜ 分卷（请选 .001 那卷）' : ''}`,
        tag: fmt,
        tagClass: fmt && fmt.includes('仅解压') ? 'is-extract-only' : ''
      });
    }
    added += 1;
  };

  const list = Array.isArray(paths) ? paths : [paths];
  for (const p of list) {
    try {
      const info = await state.ctx.pathInfo(p);
      if (info.isDirectory && isPackMode()) {
        // 只加「这一个文件夹」作为一项（7-Zip 会把整个目录树打进去），不递归展开成上千项
        await pushOne(p);
      } else if (info.isDirectory) {
        await pushOne(p);
      } else {
        await pushOne(p);
      }
    } catch (err) {
      failures.push(`${baseNameOf(p)}：${err.message}`);
    }
  }

  // 压缩模式：同一个压缩包只允许一份基名，重名时给出提示（主进程落盘时还会再加序号兜底）
  renderList();
  if (state.files.length > 0 && !isPackMode()) {
    if (state.selected < 0) selectArchive(0);
    else refreshPreview();
  }
  if (added > 0) {
    state.ctx.setStatus(`已添加 ${added} 项${failures.length ? `，${failures.length} 项失败` : ''}`);
  } else {
    state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的文件');
  }
  if (failures.length) setResult(failures.slice(0, 2).join('；'), true);
}

/** 按文件名猜格式标签（仅用于列表上显示「这是什么格式 / 只能解压」） */
function findArchiveFormatLabel(name) {
  const ext = (/\.[^.]+$/.exec(name) || [''])[0].toLowerCase();
  const ext2 = (/(\.tar\.[^.]+|\.[^.]+)$/.exec(name) || [''])[0].toLowerCase();
  const bi = BIDIRECTIONAL.find((f) => ext2 === f.ext || ext === f.ext);
  if (bi) return bi.name;
  const only = EXTRACT_ONLY.find((f) => ext === f.ext);
  if (only) return `${only.name}（仅解压）`;
  return '';
}

async function openDialog() {
  const paths = isPackMode()
    ? await state.ctx.openArchiveFiles()
    : await state.ctx.openArchives();
  if (paths && paths.length > 0) await addFromPaths(paths);
}

async function openFolderDialog() {
  const dir = await state.ctx.openFolder();
  if (dir) await addFromPaths([dir]);
}

async function onDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('is-over');
  const files = Array.from(event.dataTransfer ? event.dataTransfer.files : []);
  const paths = [];
  for (const file of files) {
    const p = state.ctx.getPathForFile(file);
    if (p) paths.push(p);
  }
  if (paths.length > 0) await addFromPaths(paths);
}

// —— 免解压预览 ——

async function refreshPreview() {
  const { els } = state;
  if (isPackMode()) return;
  const f = state.files[state.selected];
  if (!f) {
    els.previewTitle.textContent = '内容预览';
    els.previewSummary.textContent = '';
    els.previewEmpty.hidden = false;
    els.previewEmpty.textContent = '选中左侧一个压缩包，这里会列出里面的内容（不用解压）';
    els.entries.hidden = true;
    els.entries.innerHTML = '';
    state.entries = [];
    return;
  }

  els.previewTitle.textContent = f.name;
  els.previewSummary.textContent = '正在读取内容列表…';
  els.previewEmpty.hidden = false;
  els.previewEmpty.textContent = '正在读取内容列表…';
  els.entries.hidden = true;

  const res = await window.desktop.archiveList({ archivePath: f.path, password: readPassword() });
  if (!state) return;
  if (!els.previewTitle || state.files[state.selected] !== f) return; // 期间切换了选中项

  if (!res.ok) {
    f.meta = `${humanBytes(f.size || 0)} ｜ 无法预览`;
    els.previewSummary.textContent = '';
    els.previewEmpty.hidden = false;
    els.previewEmpty.textContent = res.message || '无法读取该压缩包';
    els.entries.hidden = true;
    renderList();
    return;
  }

  state.entries = res.entries || [];
  const s = res.summary || {};
  const encrypted = s.encrypted ? ' ｜ 🔒 已加密' : '';
  const stream = s.stream ? ' ｜ 单文件流式格式' : '';
  const suspicious = (res.suspicious || []).length;
  els.previewSummary.textContent =
    `${s.total} 个条目（文件 ${s.files} / 文件夹 ${s.folders}）｜ 原始 ${humanBytes(s.totalSize)}`
    + ` ｜ 压缩后 ${humanBytes(s.totalPacked)}${s.totalSize ? `（${ratioText(s.totalSize, s.totalPacked)}）` : ''}`
    + encrypted + stream
    + (suspicious ? ` ｜ ⚠️ ${suspicious} 个可疑路径（为安全将拒绝解压）` : '');
  if (suspicious) els.previewSummary.className = 'arc-preview-summary';
  els.previewEmpty.hidden = true;
  els.entries.hidden = false;
  renderEntries();
  void res.suspicious;
}

function renderEntries() {
  const { els } = state;
  const kw = els.previewSearch.value.trim().toLowerCase();
  const all = state.entries || [];
  const list = kw ? all.filter((e) => String(e.path).toLowerCase().includes(kw)) : all;
  els.entries.innerHTML = '';

  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'arc-entry';
    li.textContent = kw ? '没有匹配的文件' : '（空压缩包）';
    els.entries.appendChild(li);
    return;
  }

  const shown = list.slice(0, MAX_LIST_PREVIEW);
  for (const e of shown) {
    const li = document.createElement('li');
    li.className = 'arc-entry' + (String(e.path).split(/[\\/]/).includes('..') || /^[a-zA-Z]:/.test(e.path) || String(e.path).startsWith('/') ? ' is-suspicious' : '');

    const icon = document.createElement('span');
    icon.textContent = e.folder ? '📁' : '📄';
    li.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'arc-entry-name';
    name.textContent = e.path;
    name.title = e.path;
    li.appendChild(name);

    if (e.encrypted) {
      const t = document.createElement('span');
      t.className = 'arc-tag is-encrypted';
      t.textContent = '🔒';
      li.appendChild(t);
    }

    const size = document.createElement('span');
    size.className = 'arc-entry-size';
    size.textContent = e.folder ? '—' : humanBytes(e.size || 0);
    li.appendChild(size);

    const time = document.createElement('span');
    time.className = 'arc-entry-time';
    time.textContent = (e.modified || '').slice(0, 16) || '';
    li.appendChild(time);

    els.entries.appendChild(li);
  }

  if (list.length > shown.length) {
    const li = document.createElement('li');
    li.className = 'arc-entry';
    li.textContent = `… 另有 ${list.length - shown.length} 条未显示（导出/解压不受影响）`;
    els.entries.appendChild(li);
  }
}

// —— 运行 ——

function currentOutputDir() {
  const { els } = state;
  const typed = isPackMode() ? els.outputDir.value : els.extractDir.value;
  if (typed) return typed;
  const s = state.ctx.settings.getSettings();
  return s.outputDir || '';
}

async function ensureUniqueBase(inputs, fmt, dir) {
  // 只用于「界面提示」；真正的重名兜底在主进程（绝不覆盖已有文件）
  return suggestArchiveBase(inputs, fmt);
}

async function run() {
  if (state.busy) return;
  if (state.files.length === 0) {
    state.ctx.setStatus(isPackMode() ? '请先添加要压缩的文件' : '请先添加要解压的压缩包');
    return;
  }
  return isPackMode() ? runPack() : runUnpack();
}

async function runPack() {
  const { els } = state;
  const fmt = selectedFormat();
  const password = readPassword();
  const encrypt = readEncrypt();
  const level = els.level.value;
  const volumeBytes = parseInt(els.volume.disabled ? '0' : els.volume.value, 10) || 0;
  const outputDir = currentOutputDir() || undefined;
  const baseName = suggestArchiveBase(state.files, fmt);

  const plan = buildCreatePlan({
    inputs: state.files.map((f) => ({ path: f.path, isDirectory: !!f.isDirectory })),
    formatId: fmt.id, level, password, encrypt, volumeBytes, outputDir, baseName
  });
  if (!plan.ok) {
    state.ctx.setStatus(plan.message);
    setResult(plan.message, true);
    return;
  }

  enterBusy(`正在压缩（${fmt.name}）…`);
  state.resultLocked = false;
  state.ctx.setStatus(`正在压缩：${fmt.name}`);
  const jobId = `arc-pack-${Date.now()}`;
  state.jobId = jobId;

  let res;
  try {
    res = await window.desktop.archiveCreate({
      steps: plan.steps, archivePath: plan.archivePath, jobId
    });
  } catch (err) {
    res = { ok: false, message: err.message };
  }
  if (!state) return; // 页面被回收：任务照跑完，这里只跳过界面收尾
  leaveBusy();

  if (res.canceled) {
    state.ctx.setStatus('已取消压缩');
    setResult('已取消（未完成的产物已清理）');
    return;
  }
  if (!res.ok) {
    state.ctx.setStatus(`压缩失败：${res.message}`);
    setResult(`失败：${res.message}`, true);
    return;
  }

  const total = res.paths.length;
  const name = baseNameOf(res.paths[0]);
  const extra = total > 1 ? `（共 ${total} 个分卷）` : '';
  const ratio = ratioText(res.inputBytes || 0, res.size || 0);
  const outDirText = outputDir ? `输出目录：${outputDir}` : '输出在源文件旁边';
  state.ctx.setStatus(`压缩完成：${name}${extra} ｜ ${humanBytes(res.size)}${ratio ? `（${ratio}）` : ''}`);
  setResult(
    `${res.paths.map((p) => baseNameOf(p)).join('、')} ｜ ${humanBytes(res.size)}${ratio ? `（${ratio}）` : ''}`
    + ` ｜ 用时 ${(res.ms / 1000).toFixed(1)} 秒 ｜ ${outDirText}`
  );
  state.ctx.setInfo({ ms: res.ms });
}

async function runUnpack() {
  const { els } = state;
  const password = readPassword();
  const outputDir = currentOutputDir() || undefined;
  const overwrite = els.overwrite.value;
  const tree = els.tree.value;

  const plan = buildExtractPlan({
    archives: state.files.map((f) => ({ path: f.path, name: f.name, ext: f.ext })),
    outputDir, password, overwrite, tree
  });
  if (!plan.ok) {
    state.ctx.setStatus(plan.message);
    setResult(plan.message, true);
    return;
  }

  enterBusy('正在解压…');
  state.resultLocked = false;
  state.ctx.setStatus(`正在解压 ${state.files.length} 个压缩包`);
  const jobId = `arc-unpack-${Date.now()}`;
  state.jobId = jobId;

  let res;
  try {
    res = await window.desktop.archiveExtract({ steps: plan.steps, jobId });
  } catch (err) {
    res = { ok: false, message: err.message };
  }
  if (!state) return;
  leaveBusy();

  if (res.canceled) {
    state.ctx.setStatus('已取消解压');
    setResult('已取消（未完成的产物已清理）');
    return;
  }
  if (!res.ok) {
    state.ctx.setStatus(`解压失败：${res.message}`);
    setResult(`失败：${res.message}`, true);
    return;
  }

  const dirs = res.dirs || [];
  state.ctx.setStatus(`解压完成：共 ${res.files} 个文件，用时 ${(res.ms / 1000).toFixed(1)} 秒`);
  setResult(dirs.length === 1
    ? `解压到：${dirs[0]}（${res.files} 个文件，用时 ${(res.ms / 1000).toFixed(1)} 秒）`
    : `解压完成 ${dirs.length} 个压缩包，共 ${res.files} 个文件（用时 ${(res.ms / 1000).toFixed(1)} 秒）`);
  state.ctx.setInfo({ ms: res.ms });
}

function enterBusy(text) {
  const { els } = state;
  state.busy = true;
  els.runBtn.disabled = true;
  els.runBtn.textContent = isPackMode() ? '压缩中…' : '解压中…';
  els.cancelBtn.hidden = false;
  els.result.className = 'arc-result';
  els.result.textContent = text;
  state.ctx.showProgress(text, 0);
}

function leaveBusy() {
  const { els } = state;
  state.busy = false;
  state.jobId = null;
  els.cancelBtn.hidden = true;
  els.runBtn.textContent = isPackMode() ? '开始压缩' : '开始解压';
  state.ctx.hideProgress();
  refreshRunState();
}

async function cancel() {
  if (!state || !state.jobId) return;
  const jobId = state.jobId;
  state.ctx.setStatus('正在取消…');
  await window.desktop.archiveCancel(jobId);
}

// —— 模式切换 ——

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  state.selected = -1;
  state.entries = [];
  state.files = [];
  state.resultLocked = false;
  state.els.modePack.classList.toggle('is-active', mode === 'pack');
  state.els.modeUnpack.classList.toggle('is-active', mode === 'unpack');
  state.els.runBtn.textContent = mode === 'pack' ? '开始压缩' : '开始解压';
  state.els.result.textContent = '';
  state.els.result.className = 'arc-result';
  state.els.previewSearch.value = '';
  refreshDropHint();
  renderList();
  refreshPreview();
  state.ctx.setStatus(mode === 'pack' ? '压缩：添加文件或文件夹后点「开始压缩」' : '解压：添加压缩包后可先看内容，再点「开始解压」');
}

// —— 引擎状态 ——

async function loadEngineStatus() {
  const { els } = state;
  const st = await window.desktop.archiveStatus();
  if (!state) return;
  state.engine = st;
  const where = { addon: '随包内置', system: '系统安装', path: '系统安装' }[st.where] || '';
  if (st.found) {
    els.engine.textContent = `引擎：7-Zip ${st.version || ''}（${where}）`;
    els.engine.className = 'arc-engine';
    els.warn.hidden = true;
  } else {
    const nodeOk = st.node && st.node.zstd && st.node.brotli;
    els.engine.textContent = '引擎：未检测到 7-Zip';
    els.engine.className = 'arc-engine is-missing';
    els.warn.hidden = false;
    els.warn.textContent = `⚠️ 未检测到 7-Zip 加装包（软件目录的 addons/7zip），ZIP / 7Z / TAR / GZIP 等格式暂时不可用。`
      + (nodeOk ? 'ZSTANDARD 与 BROTLI 两个格式由软件内置引擎处理，仍可正常使用。' : '')
      + '修复方法：把 addons/7zip 文件夹（含 7z.exe 与 7z.dll）放回软件目录后重开本工具。';
  }
  refreshPackControls();
}

// —— 生命周期 ——

export function mount(container, ctx) {
  state = {
    container, ctx, els: null, listeners: [],
    mode: 'pack', files: [], selected: -1, entries: [],
    busy: false, jobId: null, engine: null,
    unsubscribe: null, resultLocked: false, baseNameTouched: false
  };
  container.innerHTML = MARKUP;

  const els = {
    modePack: container.querySelector('#arcModePack'),
    modeUnpack: container.querySelector('#arcModeUnpack'),
    engine: container.querySelector('#arcEngine'),
    warn: container.querySelector('#arcWarn'),
    packControls: container.querySelector('#arcPackControls'),
    unpackControls: container.querySelector('#arcUnpackControls'),
    format: container.querySelector('#arcFormat'),
    level: container.querySelector('#arcLevel'),
    volume: container.querySelector('#arcVolume'),
    volumeHint: container.querySelector('#arcVolumeHint'),
    password: container.querySelector('#arcPassword'),
    passwordX: container.querySelector('#arcPasswordX'),
    encrypt: container.querySelector('#arcEncrypt'),
    showPassword: container.querySelector('#arcShowPassword'),
    outputDir: container.querySelector('#arcOutputDir'),
    pickOutput: container.querySelector('#arcPickOutput'),
    clearOutput: container.querySelector('#arcClearOutput'),
    packNote: container.querySelector('#arcPackNote'),
    unpackNote: container.querySelector('#arcUnpackNote'),
    extractDir: container.querySelector('#arcExtractDir'),
    pickExtract: container.querySelector('#arcPickExtract'),
    clearExtract: container.querySelector('#arcClearExtract'),
    overwrite: container.querySelector('#arcOverwrite'),
    tree: container.querySelector('#arcTree'),
    drop: container.querySelector('#arcDrop'),
    dropHint: container.querySelector('#arcDropHint'),
    addBtn: container.querySelector('#arcAddBtn'),
    addDirBtn: container.querySelector('#arcAddDirBtn'),
    addMore: container.querySelector('#arcAddMore'),
    listHead: container.querySelector('#arcListHead'),
    listTitle: container.querySelector('#arcListTitle'),
    list: container.querySelector('#arcList'),
    count: container.querySelector('#arcCount'),
    preview: container.querySelector('#arcPreview'),
    previewTitle: container.querySelector('#arcPreviewTitle'),
    previewSearch: container.querySelector('#arcPreviewSearch'),
    previewSummary: container.querySelector('#arcPreviewSummary'),
    previewEmpty: container.querySelector('#arcPreviewEmpty'),
    entries: container.querySelector('#arcEntries'),
    runBtn: container.querySelector('#arcRunBtn'),
    cancelBtn: container.querySelector('#arcCancelBtn'),
    clearBtn: container.querySelector('#arcClearBtn'),
    result: container.querySelector('#arcResult'),
    root: container.querySelector('.arc-tool')
  };
  state.els = els;

  fillFormatSelect(els.format);
  fillSelect(els.level, LEVELS.map((l) => ({ value: l.id, label: l.label })));
  els.level.value = 'normal';
  fillSelect(els.volume, VOLUME_SIZES.map((v) => ({ value: v.id, label: v.label })));
  fillSelect(els.overwrite, OVERWRITE_MODES);
  fillSelect(els.tree, TREE_MODES);

  on(els.modePack, 'click', () => setMode('pack'));
  on(els.modeUnpack, 'click', () => setMode('unpack'));
  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.addDirBtn, 'click', openFolderDialog);
  on(els.runBtn, 'click', run);
  on(els.cancelBtn, 'click', cancel);
  on(els.clearBtn, 'click', () => {
    state.files = [];
    state.selected = -1;
    state.entries = [];
    state.resultLocked = false;
    els.result.textContent = '';
    els.result.className = 'arc-result';
    renderList();
    refreshPreview();
    state.ctx.setStatus('已清空列表');
  });

  on(els.format, 'change', refreshPackControls);
  on(els.level, 'change', refreshRunState);
  on(els.volume, 'change', refreshRunState);
  // 密码框：只刷「开始按钮是否可点」，不要顺手把结果行覆盖掉；
  // 解压模式下的密码可能影响能否列出内容，所以预览要重来一次
  on(els.password, 'input', () => { state.resultLocked = true; refreshRunState(); });
  on(els.passwordX, 'input', () => { state.resultLocked = true; refreshRunState(); refreshPreview(); });
  on(els.encrypt, 'change', refreshRunState);
  on(els.overwrite, 'change', refreshRunState);
  on(els.tree, 'change', refreshRunState);
  on(els.showPassword, 'change', () => {
    const type = els.showPassword.checked ? 'text' : 'password';
    els.password.type = type;
    els.passwordX.type = type;
  });
  on(els.previewSearch, 'input', renderEntries);

  const pickDir = (target) => async () => {
    const dir = await state.ctx.openFolder();
    if (dir) {
      target.value = dir;
      refreshRunState();
      if (target === els.extractDir) refreshPreview();
    }
  };
  on(els.pickOutput, 'click', pickDir(els.outputDir));
  on(els.pickExtract, 'click', pickDir(els.extractDir));
  on(els.clearOutput, 'click', () => { els.outputDir.value = ''; refreshRunState(); });
  on(els.clearExtract, 'click', () => { els.extractDir.value = ''; refreshRunState(); });

  for (const el of [els.drop, els.root]) {
    on(el, 'dragover', (e) => {
      e.preventDefault();
      if (el === els.drop) els.drop.classList.add('is-over');
    });
    on(el, 'dragleave', () => {
      if (el === els.drop) els.drop.classList.remove('is-over');
    });
    on(el, 'drop', onDrop);
  }

  // 进度订阅（deactivate 里会退订；页面被回收时 unmount 也会兜底清理）
  state.unsubscribe = window.desktop.archiveOnProgress((data) => {
    if (!state || !state.busy) return;
    if (data.jobId && state.jobId && data.jobId !== state.jobId) return;
    state.ctx.showProgress(data.text || '处理中…', data.percent || 0);
  });

  refreshDropHint();
  renderList();
  refreshPreview();
  els.unpackNote.textContent = '解压按文件签名自动识别格式，扩展名不对也能解；分卷包请选 .001 那一卷。';
  state.ctx.setStatus('压缩与解压：先选格式、添加文件，或切到「解压」把压缩包解开');
  loadEngineStatus();
}

export function activate() {
  if (!state) return;
  if (!state.unsubscribe) {
    state.unsubscribe = window.desktop.archiveOnProgress((data) => {
      if (!state || !state.busy) return;
      if (data.jobId && state.jobId && data.jobId !== state.jobId) return;
      state.ctx.showProgress(data.text || '处理中…', data.percent || 0);
    });
  }
}

export function deactivate() {
  if (!state) return;
  // 只退订 UI 订阅，绝不动正在跑的任务（任务归属队列，见 spec/modules/task-queue.md）
  if (state.unsubscribe) {
    state.unsubscribe();
    state.unsubscribe = null;
  }
  state.ctx.hideProgress();
}

export function unmount() {
  if (!state) return;
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  if (state.unsubscribe) {
    state.unsubscribe();
    state.unsubscribe = null;
  }
  state.ctx.hideProgress();
  state = null;
}