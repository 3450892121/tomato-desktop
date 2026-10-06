// 工具：PDF 编辑整理 —— 界面与流程
// 分层：本文件只做界面与流程编排；PDF 操作在 core/ops.js（纯逻辑），页码范围解析在 core/pages.js，
//       压缩与 pdfjs 渲染复用 shared/pdfops.js。
//
// 交互模型：顶部选「操作类型」→ 参数区随类型切换 → 中间添加文件（支持拖放）→ 底部「开始处理」。
//           所有操作都支持多文件串行批量；进度按「文件数 × 页数」折算；可随时取消。
import {
  PDF_COMPRESS_PRESETS,
  presetOf,
  openPdfDoc,
  renderPdfPage
} from '../../shared/pdfops.js';
import {
  POSITIONS,
  compressPdfOp,
  addTextWatermark,
  addPageNumbers,
  rotatePages,
  reorderPages,
  encryptPdf,
  decryptPdf,
  loadCjkFontBytes,
  cjkFontPath,
  closePdfDoc
} from './core/ops.js';
import { parsePageRange, formatPageRange } from './core/pages.js';

const OPS = [
  { id: 'compress', label: '压缩瘦身', run: '开始压缩', suffix: '压缩', hint: '每页转图片重新压：扫描件效果最好；原生文字版会让文字变成图片' },
  { id: 'watermark', label: '加文字水印', run: '加水印', suffix: '水印', hint: '九宫格定位或全页平铺，可调字号/透明度/角度' },
  { id: 'pagenumbers', label: '加页码', run: '加页码', suffix: '页码', hint: '支持 {n}（当前页）与 {total}（总页数）占位' },
  { id: 'rotate', label: '页面旋转', run: '开始旋转', suffix: '旋转', hint: '按页旋转 90° / 180° / 270°（叠加在当前角度上）' },
  { id: 'reorder', label: '页面重排', run: '开始重排', suffix: '重排', hint: '写出的页序就是输出页序（可重复、可漏写）' },
  { id: 'encrypt', label: '加密（加密码）', run: '开始加密', suffix: '加密', hint: '给 PDF 加打开密码，可限制打印/复制/修改' },
  { id: 'decrypt', label: '解密（去密码）', run: '开始解密', suffix: '解密', hint: '输入打开密码，输出不带密码的 PDF' }
];

/** 预览一次最多显示几页 */
const PREVIEW_PAGE_WINDOW = 6;

const MARKUP = `
  <div class="ped-tool">
    <section class="card ped-controls">
      <div class="control-row">
        <label class="control-label" for="pedOp">操作:</label>
        <select id="pedOp" class="select"></select>
        <span class="control-hint" id="pedOpHint"></span>
      </div>
      <div class="ped-params" id="pedParams"></div>
      <div class="ped-note" id="pedFontNote"></div>
    </section>

    <main class="card ped-files" id="pedFiles">
      <div class="ped-drop" id="pedDrop">
        <button class="btn btn-primary btn-lg" id="pedAddBtn">添加 PDF</button>
        <div class="drop-hint">也可以把 PDF 直接拖进窗口；支持多选</div>
      </div>
      <div class="ped-list-wrap" id="pedListWrap" hidden>
        <div class="ped-list-head">
          <span id="pedListTitle">文件</span>
          <span class="ped-spacer"></span>
          <span id="pedListCount"></span>
          <button class="btn btn-ghost" id="pedAddMore" type="button">＋ 继续添加</button>
        </div>
        <ul class="ped-list" id="pedList"></ul>
        <div class="ped-preview" id="pedPreview" hidden>
          <div class="ped-preview-head">
            <span id="pedPreviewTitle"></span>
            <span class="ped-spacer"></span>
            <button class="btn btn-ghost ped-mini" id="pedPrevGroup" type="button">上一组</button>
            <span id="pedPreviewRange"></span>
            <button class="btn btn-ghost ped-mini" id="pedNextGroup" type="button">下一组</button>
            <button class="btn btn-ghost ped-mini" id="pedPreviewClose" type="button">关闭预览</button>
          </div>
          <div class="ped-thumbs" id="pedThumbs"></div>
        </div>
      </div>
    </main>

    <footer class="ped-actions">
      <button class="btn btn-primary btn-run" id="pedRunBtn">开始处理</button>
      <button class="btn btn-plain" id="pedClearBtn">清空</button>
      <div class="ped-result" id="pedResult"></div>
    </footer>
  </div>
`;

let state = null;

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const opOf = (id) => OPS.find((o) => o.id === id) || OPS[0];

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

function pct(before, after) {
  if (!before) return '0%';
  return `${Math.round((1 - after / before) * 100)}%`;
}

// —— 参数区：随操作类型重建 ——

function optionsHtml(list, selected) {
  return list
    .map((p) => `<option value="${p.value}"${p.value === selected ? ' selected' : ''}>${p.label}</option>`)
    .join('');
}

function renderParams() {
  const { els } = state;
  const op = opOf(state.op);
  els.opHint.textContent = op.hint;
  const host = els.params;

  if (state.op === 'compress') {
    host.innerHTML = `
      <div class="ped-param">
        <span class="control-label">压缩档位</span>
        <select class="select" id="pedPreset">${optionsHtml(PDF_COMPRESS_PRESETS, 'standard')}</select>
      </div>
      <div class="ped-param">
        <label class="field-check"><input type="checkbox" id="pedGrayscale" /> 转黑白（扫描件更省体积）</label>
      </div>
      <div class="ped-param">
        <span class="control-label">目标体积</span>
        <input class="input ped-w-num" id="pedMaxMB" type="number" min="0" step="1" value="0" />
        <span class="field-hint">MB（0 = 不限；设目标后不达标会自动降档重试）</span>
      </div>
      <div class="ped-note is-warn">注意：压缩会把每一页转成图片重新编码——扫描件效果最好；原生文字版 PDF 的文字会变成图片，之后不能再选中复制。</div>
    `;
    return;
  }

  if (state.op === 'watermark') {
    host.innerHTML = `
      <div class="ped-param ped-param-wide">
        <span class="control-label">水印文字</span>
        <input class="input ped-w-md" id="pedText" type="text" value="内部资料" />
      </div>
      <div class="ped-param">
        <span class="control-label">字号</span>
        <input class="input ped-w-num" id="pedFontSize" type="number" min="1" max="300" value="40" />
      </div>
      <div class="ped-param">
        <span class="control-label">透明度</span>
        <input class="input ped-w-num" id="pedOpacity" type="number" min="0.05" max="1" step="0.05" value="0.2" />
      </div>
      <div class="ped-param">
        <span class="control-label">倾斜角度</span>
        <input class="input ped-w-num" id="pedRotation" type="number" min="-90" max="90" value="45" />
      </div>
      <div class="ped-param">
        <span class="control-label">颜色</span>
        <input class="input ped-color" id="pedColor" type="color" value="#808080" />
      </div>
      <div class="ped-param">
        <span class="control-label">位置</span>
        <select class="select" id="pedPosition">${optionsHtml(POSITIONS, 'center')}</select>
      </div>
      <div class="ped-param">
        <label class="field-check"><input type="checkbox" id="pedTile" /> 全页平铺</label>
      </div>
      <div class="ped-param">
        <span class="control-label">页边距</span>
        <input class="input ped-w-num" id="pedMargin" type="number" min="0" max="200" value="24" />
      </div>
    `;
    return;
  }

  if (state.op === 'pagenumbers') {
    host.innerHTML = `
      <div class="ped-param ped-param-wide">
        <span class="control-label">页码格式</span>
        <input class="input ped-w-lg" id="pedNumFormat" type="text" value="第 {n} 页 / 共 {total} 页" />
      </div>
      <div class="ped-param">
        <span class="control-label">起始页码</span>
        <input class="input ped-w-num" id="pedStartAt" type="number" min="1" value="1" />
      </div>
      <div class="ped-param">
        <span class="control-label">位置</span>
        <select class="select" id="pedNumPosition">${optionsHtml(POSITIONS, 'bottom-center')}</select>
      </div>
      <div class="ped-param">
        <span class="control-label">字号</span>
        <input class="input ped-w-num" id="pedNumSize" type="number" min="6" max="72" value="12" />
      </div>
      <div class="ped-param">
        <span class="control-label">页边距</span>
        <input class="input ped-w-num" id="pedNumMargin" type="number" min="0" max="200" value="24" />
      </div>
      <div class="ped-param">
        <label class="field-check"><input type="checkbox" id="pedSkipFirst" /> 首页不显示</label>
      </div>
    `;
    return;
  }

  if (state.op === 'rotate') {
    host.innerHTML = `
      <div class="ped-param">
        <span class="control-label">旋转角度</span>
        <select class="select" id="pedAngle">
          <option value="90">顺时针 90°</option>
          <option value="180">180°</option>
          <option value="270">270°（逆时针 90°）</option>
        </select>
      </div>
      <div class="ped-param">
        <span class="control-label">页码范围</span>
        <input class="input ped-w-sm" id="pedRotatePages" type="text" placeholder="留空 = 全部，如 1-3,5" />
      </div>
    `;
    return;
  }

  if (state.op === 'reorder') {
    host.innerHTML = `
      <div class="ped-param ped-param-wide">
        <span class="control-label">新页序</span>
        <input class="input ped-w-lg" id="pedOrder" type="text" placeholder="如 3,1,2 或 2-3,1" />
      </div>
      <div class="ped-note">提示：输出的 PDF 只包含你写出的页，顺序即输出顺序；想丢弃某页就不写它，想重复某页就多写一次。</div>
    `;
    return;
  }

  if (state.op === 'encrypt') {
    host.innerHTML = `
      <div class="ped-param">
        <span class="control-label">打开密码</span>
        <input class="input ped-w-md" id="pedUserPwd" type="password" placeholder="打开文件时要输入的密码" />
      </div>
      <div class="ped-param">
        <span class="control-label">所有者密码</span>
        <input class="input ped-w-md" id="pedOwnerPwd" type="password" placeholder="留空 = 与打开密码相同" />
      </div>
      <div class="ped-param ped-perms">
        <span class="control-label">允许</span>
        <label class="field-check"><input type="checkbox" id="pedPermPrint" checked /> 打印</label>
        <label class="field-check"><input type="checkbox" id="pedPermCopy" checked /> 复制文字</label>
        <label class="field-check"><input type="checkbox" id="pedPermModify" /> 修改内容</label>
      </div>
      <div class="ped-note is-warn">请务必记住密码：PDF 密码无法找回，忘记后文件将无法打开（本地离线处理，密码不会被上传）。</div>
    `;
    return;
  }

  // decrypt
  host.innerHTML = `
    <div class="ped-param">
      <span class="control-label">打开密码</span>
      <input class="input ped-w-md" id="pedDecryptPwd" type="password" placeholder="该 PDF 当前的打开密码" />
    </div>
    <div class="ped-note">解密后输出一份不带密码的 PDF；已按权限限制的操作也会一并解除。</div>
  `;
}

function readParams() {
  const { els } = state;
  const q = (id) => els.params.querySelector(id);
  const num = (id, name, { min = -Infinity, max = Infinity } = {}) => {
    const v = Number(q(id) ? q(id).value : NaN);
    if (!Number.isFinite(v)) throw new Error(`请填写有效的${name}。`);
    if (v < min || v > max) throw new Error(`${name}需在 ${min} ~ ${max} 之间。`);
    return v;
  };

  switch (state.op) {
    case 'compress': {
      const maxMB = Number(q('#pedMaxMB').value) || 0;
      if (maxMB < 0) throw new Error('目标体积不能为负数。');
      return {
        preset: presetOf(q('#pedPreset').value).value,
        grayscale: q('#pedGrayscale').checked,
        maxMB
      };
    }
    case 'watermark': {
      const text = q('#pedText').value;
      if (!text.trim()) throw new Error('水印文字不能为空。');
      return {
        text,
        fontSize: num('#pedFontSize', '字号', { min: 1, max: 300 }),
        opacity: num('#pedOpacity', '透明度', { min: 0.05, max: 1 }),
        rotation: num('#pedRotation', '倾斜角度', { min: -90, max: 90 }),
        color: q('#pedColor').value,
        position: q('#pedPosition').value,
        tile: q('#pedTile').checked,
        margin: num('#pedMargin', '页边距', { min: 0, max: 200 })
      };
    }
    case 'pagenumbers': {
      const format = q('#pedNumFormat').value;
      if (!format.trim()) throw new Error('页码格式不能为空。');
      return {
        format,
        startAt: Math.floor(num('#pedStartAt', '起始页码', { min: 1 })),
        position: q('#pedNumPosition').value,
        fontSize: num('#pedNumSize', '字号', { min: 6, max: 72 }),
        margin: num('#pedNumMargin', '页边距', { min: 0, max: 200 }),
        skipFirst: q('#pedSkipFirst').checked
      };
    }
    case 'rotate': {
      const rangeText = q('#pedRotatePages').value.trim();
      return { rangeText, pages: null, angle: Number(q('#pedAngle').value) };
    }
    case 'reorder':
      return { order: q('#pedOrder').value.trim() };
    case 'encrypt': {
      const userPassword = q('#pedUserPwd').value;
      const ownerPassword = q('#pedOwnerPwd').value;
      if (!userPassword && !ownerPassword) throw new Error('请至少设置一个密码（打开密码或所有者密码）。');
      return {
        userPassword,
        ownerPassword,
        permissions: {
          printing: q('#pedPermPrint').checked,
          copying: q('#pedPermCopy').checked,
          modifying: q('#pedPermModify').checked
        }
      };
    }
    case 'decrypt': {
      const password = q('#pedDecryptPwd').value;
      if (!password) throw new Error('请填写该 PDF 的打开密码。');
      return { password };
    }
    default:
      return {};
  }
}

// —— 中文字体（缺失时降级并明确提示） ——

async function ensureFont() {
  if (state.fontBytes !== undefined) return state.fontBytes;
  if (!state.fontPromise) {
    // 第二个参数走主进程 ocr:font 通道：字体路径由主进程按 PORTABLE_DIR 解析，
    // 开发态与打包产物都正确（只用 readFile + 相对路径的话，产物上会读不到字体）
    state.fontPromise = loadCjkFontBytes(state.ctx.readFile, state.ctx.ocrFont)
      .then((b) => {
        state.fontBytes = b || null;
        refreshFontNote();
        return state.fontBytes;
      })
      .catch(() => {
        state.fontBytes = null;
        refreshFontNote();
        return null;
      });
  }
  return state.fontPromise;
}

function refreshFontNote() {
  if (!state || !state.els) return;
  const note = state.els.fontNote;
  if (!note) return;
  if (state.fontBytes) {
    note.className = 'ped-note is-ok';
    note.textContent = '✓ 已加载中文字体，水印与页码支持中文。';
  } else {
    note.className = 'ped-note is-warn';
    const name = cjkFontPath().split(/[\\/]/).pop();
    note.textContent = `中文字体缺失（${name}）：水印/页码只能用英文与数字，中文可能显示为空白。`;
  }
}

// —— 文件列表 ——

function currentFiles() {
  return state.files;
}

function renderList() {
  const { els } = state;
  const files = currentFiles();
  els.listWrap.hidden = files.length === 0;
  els.drop.hidden = files.length > 0;
  els.list.innerHTML = '';
  els.listCount.textContent = files.length ? `共 ${files.length} 项` : '';

  files.forEach((f, index) => {
    const li = document.createElement('li');
    li.className = `ped-item${state.selected === index ? ' is-active' : ''}`;
    li.title = '点击可预览前几页';

    const main = document.createElement('div');
    main.className = 'ped-item-main';
    const name = document.createElement('div');
    name.className = 'ped-item-name';
    name.textContent = f.name;
    name.title = f.path;
    const meta = document.createElement('div');
    meta.className = 'ped-item-meta';
    meta.textContent = f.meta;
    main.appendChild(name);
    main.appendChild(meta);
    if (f.result) {
      const res = document.createElement('div');
      res.className = `ped-item-result ${f.result.ok ? 'is-ok' : 'is-bad'}`;
      res.textContent = f.result.text;
      main.appendChild(res);
    }
    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'ped-item-actions';
    const del = document.createElement('button');
    del.className = 'ped-icon-btn';
    del.textContent = '×';
    del.title = '移除';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      files.splice(index, 1);
      if (state.selected === index) closePreview();
      else if (state.selected > index) state.selected -= 1;
      renderList();
    });
    actions.appendChild(del);
    li.appendChild(actions);

    li.addEventListener('click', () => selectFile(index));
    els.list.appendChild(li);
  });
  updateRunButton();
}

async function addFromPaths(paths) {
  // 读盘 + 数页数可能较慢，期间用户可能切走导致本页被回收：全程用局部 st，收尾前再核对
  const st = state;
  const files = st.files;
  const failures = [];
  let added = 0;

  for (const p of paths) {
    if (st.disposed) break;
    try {
      const info = await st.ctx.pathInfo(p);
      if ((info.ext || '').toLowerCase() !== '.pdf') {
        failures.push(`${info.name}：不是 PDF 文件`);
        continue;
      }
      const bytes = await st.ctx.readFile(p);
      let pages = 0;
      let pageNote = '';
      let doc = null;
      try {
        doc = await openPdfDoc(bytes);
        pages = doc.numPages;
      } catch (err) {
        // 加密的 PDF 读不出页数：仍允许添加（解密操作正需要这类文件）
        pageNote = /密码/.test(err.message) ? '（有密码，需用解密）' : '（读取页数失败）';
      } finally {
        await closePdfDoc(doc);
      }
      files.push({
        path: p,
        name: info.name,
        baseName: info.baseName,
        dir: info.dir,
        pages,
        bytes: info.size || bytes.length,
        meta: `${pages ? `共 ${pages} 页 · ` : ''}${fmtBytes(info.size || bytes.length)}${pageNote}`,
        result: null
      });
      added += 1;
    } catch (err) {
      failures.push(`${String(p).split(/[\\/]/).pop()}：${err.message}`);
    }
  }

  if (st.disposed || state !== st) return; // 已被回收：结果留在旧数据里，不再动界面/顶栏
  renderList();
  if (added > 0) {
    st.ctx.setStatus(`已添加 ${added} 个 PDF${failures.length ? `，${failures.length} 个失败` : ''}`);
  } else {
    st.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的文件');
  }
  if (failures.length > 1) console.warn('[pdf-edit] 部分文件添加失败：\n' + failures.join('\n'));
}

async function openDialog() {
  const st = state;
  // 测试模式与正式接线都走 ctx.openPdfEdit（主进程专用对话框）；未接线时退回通用 PDF 对话框
  const pick = st.ctx.openPdfEdit || st.ctx.openPdfs;
  try {
    await ensureFont();
  } catch {
    /* 字体加载失败不影响添加文件 */
  }
  if (state !== st) return;
  const paths = await pick.call(st.ctx);
  if (paths && paths.length > 0 && state === st) await addFromPaths(paths);
}

async function onDrop(event) {
  event.preventDefault();
  const st = state;
  const files = Array.from(event.dataTransfer ? event.dataTransfer.files : []);
  const paths = [];
  for (const file of files) {
    const p = st.ctx.getPathForFile(file);
    if (p) paths.push(p);
  }
  if (paths.length > 0) await addFromPaths(paths);
}

// —— 预览（前几页缩略图，页数多时分组翻页） ——

async function selectFile(index) {
  const st = state;
  if (st.selected === index && st.preview.pdf) {
    closePreview();
    return;
  }
  st.selected = index;
  renderList();
  await openPreview(index);
}

function closePreview() {
  state.selected = -1;
  state.preview.start = 0;
  closePdfDoc(state.preview.pdf);
  state.preview.pdf = null;
  if (state.els) {
    state.els.preview.hidden = true;
    state.els.thumbs.innerHTML = '';
  }
  renderList();
}

async function openPreview(index) {
  const st = state;
  const f = st.files[index];
  if (!f) return;
  const { els } = st;
  await closePdfDoc(st.preview.pdf);
  st.preview.pdf = null;
  st.preview.start = 0;
  els.preview.hidden = false;
  els.previewTitle.textContent = `预览：${f.name}`;
  els.thumbs.innerHTML = '<div class="ped-thumb-msg">正在生成缩略图…</div>';
  updatePreviewNav();
  try {
    const bytes = await st.ctx.readFile(f.path);
    const pdf = await openPdfDoc(bytes);
    if (state !== st) {
      // 页面已被回收：别把 doc 挂到旧状态上，直接释放
      await closePdfDoc(pdf);
      return;
    }
    st.preview.pdf = pdf;
  } catch (err) {
    // 错误消息含完整文件路径（文件名用户可控），必须走 textContent，不能拼进 innerHTML
    if (state === st) {
      const msg = document.createElement('div');
      msg.className = 'ped-thumb-msg';
      msg.textContent = `预览失败：${err.message}`;
      els.thumbs.replaceChildren(msg);
    }
    return;
  }
  await renderThumbs(st);
}

async function renderThumbs(st) {
  const els = st.els;
  const pdf = st.preview.pdf;
  if (!pdf) return;
  const total = pdf.numPages;
  const start = Math.max(0, Math.min(st.preview.start, Math.max(0, total - 1)));
  st.preview.start = Math.floor(start / PREVIEW_PAGE_WINDOW) * PREVIEW_PAGE_WINDOW;
  const from = st.preview.start + 1;
  const to = Math.min(total, st.preview.start + PREVIEW_PAGE_WINDOW);

  els.thumbs.innerHTML = '';
  for (let p = from; p <= to; p++) {
    const wrap = document.createElement('div');
    wrap.className = 'ped-thumb';
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    const label = document.createElement('div');
    label.className = 'ped-thumb-label';
    label.textContent = `第 ${p} 页`;
    wrap.appendChild(label);
    els.thumbs.appendChild(wrap);
    try {
      const img = await renderPdfPage(pdf, p, { scale: 0.45 });
      if (state !== st) return; // 已被回收：停止渲染，避免往脱离文档的节点里画
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx2d = canvas.getContext('2d');
      ctx2d.putImageData(new ImageData(img.pixels, img.width, img.height), 0, 0);
    } catch (err) {
      wrap.classList.add('is-bad');
      label.textContent = `第 ${p} 页（渲染失败）`;
    }
  }
  if (state === st) updatePreviewNav();
}

function updatePreviewNav() {
  const { els } = state;
  const pdf = state.preview.pdf;
  const total = pdf ? pdf.numPages : 0;
  const from = total ? state.preview.start + 1 : 0;
  const to = total ? Math.min(total, state.preview.start + PREVIEW_PAGE_WINDOW) : 0;
  els.previewRange.textContent = total ? `${from}-${to} / 共 ${total} 页` : '';
  els.prevGroup.disabled = state.preview.start <= 0;
  els.nextGroup.disabled = !total || to >= total;
}

function pageWindow(delta) {
  if (!state.preview.pdf) return;
  const total = state.preview.pdf.numPages;
  const next = state.preview.start + delta * PREVIEW_PAGE_WINDOW;
  state.preview.start = Math.max(0, Math.min(next, Math.max(0, total - 1)));
  state.preview.start = Math.floor(state.preview.start / PREVIEW_PAGE_WINDOW) * PREVIEW_PAGE_WINDOW;
  renderThumbs(state);
}

// —— 运行 ——

function updateRunButton() {
  const op = opOf(state.op);
  const btn = state.els.runBtn;
  if (state.busy) {
    btn.textContent = state.cancelRequested ? '取消中…' : '取消';
    btn.disabled = state.cancelRequested;
  } else {
    btn.textContent = op.run;
    btn.disabled = false;
  }
}

/** 单文件处理：返回 {bytes, detail}（detail 为界面展示用的补充说明） */
async function runOne(op, bytes, params, f, st, hooks, fontBytes) {
  switch (op) {
    case 'compress': {
      const res = await compressPdfOp(bytes, {
        preset: params.preset,
        grayscale: params.grayscale,
        maxMB: params.maxMB,
        onProgress: (done, total) => {
          const ratio = total ? done / total : 1;
          st.ctx.showProgress(`压缩（${hooks.fileIndex + 1}/${hooks.fileCount}）：第 ${done}/${total} 页`, ((hooks.fileIndex + ratio) / hooks.fileCount) * 100);
        },
        shouldCancel: hooks.shouldCancel
      });
      if (!res || res.cancelled || !res.bytes) return { cancelled: true };
      return { bytes: res.bytes, detail: `${fmtBytes(res.originalBytes)} → ${fmtBytes(res.bytes.length)}（降幅 ${pct(res.originalBytes, res.bytes.length)}，档位「${presetOf(res.preset).label}」${res.attempts > 1 ? `，降档重试 ${res.attempts - 1} 次` : ''}）` };
    }
    case 'watermark':
      return { bytes: await addTextWatermark(bytes, { ...params, fontBytes, ...hooks }) };
    case 'pagenumbers':
      return { bytes: await addPageNumbers(bytes, { ...params, fontBytes, ...hooks }) };
    case 'rotate': {
      // 页码范围在这里解析（拿得到实际页数时校验越界）
      const list = params.rangeText ? parsePageRange(params.rangeText, f.pages || undefined) : null;
      const total = list ? list.length : (f.pages || 0);
      return { bytes: await rotatePages(bytes, { pages: list, angle: params.angle, ...hooks }), detail: list ? `旋转 ${formatPageRange(list)} 页` : `旋转全部 ${total || ''} 页`.trim() };
    }
    case 'reorder':
      return { bytes: await reorderPages(bytes, { order: params.order, ...hooks }) };
    case 'encrypt': {
      const bytesOut = await encryptPdf(bytes, { userPassword: params.userPassword, ownerPassword: params.ownerPassword, permissions: params.permissions });
      return { bytes: bytesOut, detail: `已加密码（打开密码${params.userPassword ? '已设置' : '未设置'}）` };
    }
    case 'decrypt': {
      const bytesOut = await decryptPdf(bytes, { password: params.password });
      return { bytes: bytesOut, detail: '已去除密码' };
    }
    default:
      throw new Error('未知操作类型');
  }
}

async function run() {
  if (state.busy) return;
  // 关键：整个流程用局部 st 引用本页状态。工具页可能被 LRU 回收（unmount 把 state 置空，
  // 之后还可能重新 mount 成新对象），若流程里继续读模块级 state，就会「跑到新页面上」或空指针。
  const st = state;
  const ctx = st.ctx;
  // 只有「本页仍是当前挂载的页」时才重绘，避免把旧页结果画进新页
  const paint = () => {
    if (state === st) renderList();
  };
  const files = st.files;
  if (files.length === 0) {
    ctx.setStatus('请先添加 PDF 文件');
    return;
  }

  let params;
  try {
    params = readParams();
  } catch (err) {
    ctx.setStatus(err.message);
    return;
  }

  const op = opOf(st.op);
  const needsFont = st.op === 'watermark' || st.op === 'pagenumbers';
  const fontBytes = needsFont ? await ensureFont() : null;

  st.busy = true;
  st.cancelRequested = false;
  st.taskIds = [];
  if (state === st) updateRunButton();
  files.forEach((f) => {
    f.result = null;
  });
  paint();

  const outputDir = ctx.settings.getSettings().outputDir || undefined;
  const fileCount = files.length;

  // 任务归属队列：PDF 操作吃满 CPU，走 cpu 通道串行；每个 PDF 算一个任务。
  // 切走工具页（含 LRU 回收）不再取消任务 —— 这里只退订 UI，队列照跑完。
  const jobs = files.map((f, i) => ({
    label: f.name,
    inputPaths: [f.path],
    outputDir,
    run: async ({ report, isCancelled }) => {
      const hooks = {
        // 取消只看队列标志（页面是否被回收不再等于取消）
        shouldCancel: () => isCancelled(),
        onProgress: async (done, total) => {
          const ratio = total ? done / total : 1;
          const overall = ((i + ratio) / fileCount) * 100;
          const text = `${op.label}（${i + 1}/${fileCount}）：第 ${done}/${total} 页`;
          report({ percent: overall, text });
          if (state === st && !st.disposed) st.ctx.showProgress(text, overall);
          await nextFrame(); // 换帧，避免界面卡死
        },
        fileIndex: i,
        fileCount
      };
      try {
        const bytes = await ctx.readFile(f.path);
        const res = await runOne(st.op, bytes, params, f, st, hooks, fontBytes);
        if (res.cancelled || isCancelled()) return { canceled: true };
        const target = await ctx.saveNextTo({
          sourcePath: f.path,
          targetDir: outputDir,
          // 带上操作后缀（_压缩 / _水印 / _加密 …），避免产出与原文件同名
          // （同名时 saveNextTo 只能加 (1)(2) 序号，用户分不清哪个文件做了什么处理）
          baseName: `${f.baseName}_${op.suffix}`,
          ext: '.pdf',
          bytes: res.bytes
        });
        f.result = { ok: true, text: `${fmtBytes(res.bytes.length)}${res.detail ? `｜${res.detail}` : ''}｜${target}` };
        paint();
        return { ok: true, outputPaths: [target], outputDir };
      } catch (err) {
        if (err && err.name === 'CancelledError') return { canceled: true };
        f.result = { ok: false, text: `失败：${err.message}` };
        paint();
        return { ok: false, error: err.message };
      }
    }
  }));

  const ids = jobs.map((job) => ctx.tasks.enqueue({ toolId: 'pdf-edit', toolName: 'PDF 编辑整理', lane: 'cpu', ...job }));
  st.taskIds = ids;
  const settled = await Promise.all(ids.map((id) => ctx.tasks.waitFor(id)));

  const ok = settled.filter((t) => t && t.status === 'done').length;
  const failed = settled.filter((t) => t && t.status === 'failed').length;
  const cancelled = settled.filter((t) => t && t.status === 'canceled').length;
  const failedTask = settled.find((t) => t && t.status === 'failed');
  const lastError = (failedTask && failedTask.error) || '';
  const doneTask = [...settled].reverse().find((t) => t && t.status === 'done' && t.output.paths.length);
  const lastPath = doneTask ? doneTask.output.paths[0] : '';

  if (state === st) {
    st.taskIds = [];
    st.busy = false;
    st.cancelRequested = false;
    updateRunButton();
  }
  ctx.hideProgress();

  if (!failed && !cancelled) {
    const label = st.op === 'decrypt' ? '解密完成' : `${op.label}完成`;
    ctx.setStatus(`${label}：成功 ${ok} 个`);
  } else {
    const parts = [`${op.label}完成：成功 ${ok} 个`];
    if (failed) parts.push(`失败 ${failed} 个（${lastError}）`);
    if (cancelled) parts.push(`已取消 ${cancelled} 个`);
    ctx.setStatus(parts.join('，'));
  }
  if (state === st) st.els.result.textContent = lastPath ? `输出：${lastPath}` : '';
}

// —— 操作类型切换 ——

function switchOp(id) {
  state.op = id;
  state.els.opSel.value = id;
  state.els.result.textContent = '';
  renderParams();
  updateRunButton();
  const op = opOf(id);
  state.ctx.setStatus(`${op.label}：${op.hint}`);
  state.ctx.setInfo({});
}

// —— 生命周期 ——

export function mount(container, ctx) {
  state = {
    ctx,
    els: null,
    listeners: [],
    op: OPS[0].id,
    files: [],
    selected: -1,
    preview: { pdf: null, start: 0 },
    fontBytes: undefined,
    fontPromise: null,
    busy: false,
    cancelRequested: false,
    taskIds: [],
    disposed: false,
    container
  };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.ped-tool'),
    opSel: container.querySelector('#pedOp'),
    opHint: container.querySelector('#pedOpHint'),
    params: container.querySelector('#pedParams'),
    fontNote: container.querySelector('#pedFontNote'),
    drop: container.querySelector('#pedDrop'),
    addBtn: container.querySelector('#pedAddBtn'),
    listWrap: container.querySelector('#pedListWrap'),
    list: container.querySelector('#pedList'),
    listCount: container.querySelector('#pedListCount'),
    addMore: container.querySelector('#pedAddMore'),
    preview: container.querySelector('#pedPreview'),
    previewTitle: container.querySelector('#pedPreviewTitle'),
    previewRange: container.querySelector('#pedPreviewRange'),
    prevGroup: container.querySelector('#pedPrevGroup'),
    nextGroup: container.querySelector('#pedNextGroup'),
    previewClose: container.querySelector('#pedPreviewClose'),
    thumbs: container.querySelector('#pedThumbs'),
    runBtn: container.querySelector('#pedRunBtn'),
    clearBtn: container.querySelector('#pedClearBtn'),
    result: container.querySelector('#pedResult')
  };
  state.els = els;

  els.opSel.innerHTML = '';
  for (const o of OPS) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.label;
    els.opSel.appendChild(opt);
  }

  on(els.opSel, 'change', () => switchOp(els.opSel.value));
  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', () => {
    if (state.busy) {
      // 取消本工具入队的任务（队列会在当前这个 PDF 处理完后停下后续任务）
      state.cancelRequested = true;
      for (const id of state.taskIds) state.ctx.tasks.cancel(id);
      updateRunButton();
      state.ctx.setStatus('正在取消，请稍候…');
      return;
    }
    run();
  });
  on(els.clearBtn, 'click', () => {
    if (state.busy) {
      state.ctx.setStatus('正在处理中，请先取消再清空');
      return;
    }
    closePreview();
    state.files = [];
    state.selected = -1;
    renderList();
    state.els.result.textContent = '';
    state.ctx.setStatus('已清空文件列表');
  });
  on(els.previewClose, 'click', closePreview);
  on(els.prevGroup, 'click', () => pageWindow(-1));
  on(els.nextGroup, 'click', () => pageWindow(1));
  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);

  switchOp(OPS[0].id);
  renderList();
  // 后台探测中文字体（结果只影响提示与水印/页码是否支持中文）
  ensureFont();
}

export function unmount() {
  if (!state) return;
  // disposed 只用于「不要再往这一页画界面」；硬契约：切走（含 LRU 回收）**不取消**队列里的任务
  state.disposed = true;
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  if (state.preview && state.preview.pdf) {
    closePdfDoc(state.preview.pdf);
  }
  state = null;
}