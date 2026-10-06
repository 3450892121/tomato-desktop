// 工具：PDF 转格式 —— 界面与交互
// 方向：PDF→图片 / 图片→PDF / 合并·拆分·提取页 / Word·Excel→PDF / PDF→Word
// 分层：本文件只做界面与流程编排；PDF 读写与渲染在 core/（pdfjs.js / build.js / pages.js），
//       图片编解码复用 shared/imageio.js，重型转换（LibreOffice）经主进程 IPC 调用。
import { parsePageRange } from './core/pages.js';
import { openPdf, renderPageToPixels } from './core/pdfjs.js';
import { imagesToPdf, mergePdfs, splitPdf, extractPages, getPageCount, sniffImageType } from './core/build.js';
import { decodeImageFromBytes, encodeImageToBytes, makeThumbnailFromBytes } from '../../shared/imageio.js';

const DIRECTIONS = [
  { id: 'pdf-to-image', label: 'PDF → 图片', hint: '逐页导出图片，输出到「原文件名_图片」文件夹；扫描件同样适用', run: '开始导出' },
  { id: 'image-to-pdf', label: '图片 → PDF', hint: '多张图片合成一份 PDF（列表顺序即页序，JPG 直嵌不重编码）', run: '合成 PDF' },
  { id: 'page-ops', label: '合并 / 拆分 / 提取页', hint: '多份合并、按页拆分成多个文件、抽取指定页', run: '开始处理' },
  { id: 'office-to-pdf', label: 'Word/Excel → PDF', hint: '需要 LibreOffice 加装包（详见下方状态说明）', run: '开始转换' },
  { id: 'pdf-to-word', label: 'PDF → Word', hint: '需要 LibreOffice 加装包；默认「可编辑文本」模式（Word 秒开），可选「保留版式」', run: '开始转换' }
];

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
const OFFICE_EXTS = new Set(['.doc', '.docx', '.xls', '.xlsx']);

const MARKUP = `
  <div class="pdf-tool">
    <section class="card pdf-controls">
      <div class="control-row">
        <label class="control-label" for="pdfDirection">方向:</label>
        <select id="pdfDirection" class="select"></select>
        <span class="control-hint" id="pdfDirectionHint"></span>
      </div>
      <div class="pdf-params" id="pdfParams"></div>
    </section>

    <main class="card pdf-files" id="pdfFiles">
      <div class="pdf-drop" id="pdfDrop">
        <button class="btn btn-primary btn-lg" id="pdfAddBtn">添加文件</button>
        <div class="drop-hint">也可以把文件直接拖进窗口；支持多选</div>
      </div>
      <div class="pdf-list-wrap" id="pdfListWrap" hidden>
        <div class="pdf-list-head">
          <span id="pdfListTitle">文件</span>
          <span class="pdf-spacer"></span>
          <span id="pdfListCount"></span>
          <button class="btn btn-ghost" id="pdfAddMore" type="button">＋ 继续添加</button>
        </div>
        <ul class="pdf-list" id="pdfList"></ul>
      </div>
    </main>

    <footer class="pdf-actions">
      <button class="btn btn-primary btn-run" id="pdfRunBtn">开始</button>
      <button class="btn btn-plain" id="pdfClearBtn">清空</button>
      <div class="pdf-result" id="pdfResult"></div>
    </footer>
  </div>
`;

let state = null;

function on(el, type, handler) {
  el.addEventListener(type, handler);
  state.listeners.push([el, type, handler]);
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const pad3 = (n) => String(n).padStart(3, '0');
const allPages = (n) => Array.from({ length: n }, (_, i) => i + 1);
const dirOf = (id) => DIRECTIONS.find((d) => d.id === id);

function currentFiles() {
  return state.lists[state.direction];
}

// —— 参数区（随方向切换） ——

function renderParams() {
  const { els } = state;
  const d = state.direction;
  els.directionHint.textContent = dirOf(d).hint;

  const host = els.params;
  if (d === 'pdf-to-image') {
    host.innerHTML = `
      <div class="pdf-param">
        <span class="control-label">页码范围</span>
        <input class="input pdf-w-sm" id="pdfRange" type="text" placeholder="留空 = 全部，如 1-3,5" />
      </div>
      <div class="pdf-param">
        <span class="control-label">清晰度</span>
        <select class="select" id="pdfScale">
          <option value="2">高清（2×，约 144 DPI）</option>
          <option value="1">标准（1×，约 72 DPI）</option>
          <option value="3">超清（3×，约 216 DPI）</option>
        </select>
      </div>
      <div class="pdf-param">
        <span class="control-label">格式</span>
        <select class="select" id="pdfFormat">
          <option value="png">PNG（无损）</option>
          <option value="jpg">JPG（体积小）</option>
        </select>
      </div>
      <div class="pdf-param" id="pdfQualityWrap" hidden>
        <span class="control-label">JPG 画质</span>
        <input class="input pdf-w-num" id="pdfQuality" type="number" min="1" max="100" value="90" />
      </div>
    `;
    const fmt = host.querySelector('#pdfFormat');
    const wrap = host.querySelector('#pdfQualityWrap');
    fmt.addEventListener('change', () => { wrap.hidden = fmt.value !== 'jpg'; });
  } else if (d === 'image-to-pdf') {
    host.innerHTML = `
      <div class="pdf-param">
        <span class="control-label">页面</span>
        <select class="select" id="pdfPageMode">
          <option value="original">按原图尺寸（不缩放）</option>
          <option value="a4">适应 A4（居中）</option>
        </select>
      </div>
      <div class="pdf-param" id="pdfMarginWrap" hidden>
        <span class="control-label">页边距</span>
        <select class="select" id="pdfMargin">
          <option value="36">小（1.27cm）</option>
          <option value="18">极小（0.63cm）</option>
          <option value="72">中（2.54cm）</option>
          <option value="0">无</option>
        </select>
      </div>
    `;
    const mode = host.querySelector('#pdfPageMode');
    const wrap = host.querySelector('#pdfMarginWrap');
    mode.addEventListener('change', () => { wrap.hidden = mode.value !== 'a4'; });
  } else if (d === 'page-ops') {
    host.innerHTML = `
      <div class="pdf-param">
        <span class="control-label">操作</span>
        <select class="select" id="pdfSubOp">
          <option value="merge">合并（2 份以上按顺序合成）</option>
          <option value="split">拆分（每页/每 N 页一个文件）</option>
          <option value="extract">提取页（抽取指定页组成新 PDF）</option>
        </select>
      </div>
      <div class="pdf-param" id="pdfSplitWrap" hidden>
        <span class="control-label">拆分方式</span>
        <select class="select" id="pdfSplitMode">
          <option value="1">每页一个文件</option>
          <option value="n">每 N 页一个文件</option>
        </select>
        <input class="input pdf-w-num" id="pdfSplitN" type="number" min="1" value="5" hidden />
      </div>
      <div class="pdf-param" id="pdfExtractWrap" hidden>
        <span class="control-label">页码范围</span>
        <input class="input pdf-w-sm" id="pdfExtractRange" type="text" placeholder="如 1-3,5" />
      </div>
    `;
    const sub = host.querySelector('#pdfSubOp');
    const splitWrap = host.querySelector('#pdfSplitWrap');
    const extractWrap = host.querySelector('#pdfExtractWrap');
    const splitMode = host.querySelector('#pdfSplitMode');
    const splitN = host.querySelector('#pdfSplitN');
    const applySub = () => {
      splitWrap.hidden = sub.value !== 'split';
      extractWrap.hidden = sub.value !== 'extract';
      splitN.hidden = splitMode.value !== 'n';
      updateRunButton();
    };
    sub.addEventListener('change', applySub);
    splitMode.addEventListener('change', applySub);
    applySub();
  } else {
    // office-to-pdf / pdf-to-word：加装包状态；PDF→Word 额外提供「输出方式」
    // 背景：LibreOffice 的 PDF 导入会把每段文字做成绝对定位的浮动文本框，复杂大文档
    //       能产出上万个浮动对象，Word 打开即卡死；「可编辑文本」模式会压平成普通段落。
    const modeRow = d === 'pdf-to-word'
      ? `
      <div class="pdf-param">
        <span class="control-label">输出方式</span>
        <select class="select" id="pdfWordMode">
          <option value="text">可编辑文本（推荐：Word 秒开，版式简化）</option>
          <option value="layout">保留版式（仅适合简单/短文档）</option>
        </select>
      </div>`
      : '';
    host.innerHTML = `${modeRow}<div class="pdf-note" id="pdfLoNote">正在检测 LibreOffice…</div>`;
    refreshLibreOfficeNote();
  }
  updateRunButton();
}

function readParams() {
  const { els } = state;
  const q = (id) => els.params.querySelector(id);
  const d = state.direction;
  if (d === 'pdf-to-image') {
    return {
      rangeText: q('#pdfRange').value.trim(),
      scale: parseInt(q('#pdfScale').value, 10) || 2,
      format: q('#pdfFormat').value,
      quality: Math.max(1, Math.min(100, parseInt(q('#pdfQuality').value, 10) || 90))
    };
  }
  if (d === 'image-to-pdf') {
    const pageMode = q('#pdfPageMode').value;
    return { pageMode, margin: pageMode === 'a4' ? parseInt(q('#pdfMargin').value, 10) || 0 : 0 };
  }
  if (d === 'page-ops') {
    return {
      sub: q('#pdfSubOp').value,
      everyN: q('#pdfSplitMode').value === 'n' ? Math.max(1, parseInt(q('#pdfSplitN').value, 10) || 1) : 1,
      rangeText: q('#pdfExtractRange').value.trim()
    };
  }
  if (d === 'pdf-to-word') {
    const sel = q('#pdfWordMode');
    return { wordMode: sel ? sel.value : 'text' };
  }
  return {};
}

function updateRunButton() {
  const label = dirOf(state.direction).run;
  state.els.runBtn.textContent = state.busy ? '处理中…' : label;
  state.els.runBtn.disabled = state.busy;
}

// —— LibreOffice 加装包状态 ——

async function refreshLibreOfficeNote() {
  try {
    state.lo = await state.ctx.libreofficeStatus();
  } catch {
    state.lo = { found: false };
  }
  const note = state.els.params.querySelector('#pdfLoNote');
  if (!note) return;
  if (state.lo && state.lo.found) {
    const where = state.lo.where === 'addon' ? '加装包' : '系统安装';
    note.className = 'pdf-note is-ok';
    note.textContent = `✓ 已检测到 LibreOffice（${where}）`;
  } else {
    note.className = 'pdf-note is-warn';
    note.textContent = '未检测到 LibreOffice：把加装包解压到软件目录的 addons/libreoffice 后重开本工具即可；无加装包时，.docx/.xlsx → PDF 自动用内置方式（版式较简单），PDF → Word 必须加装包。';
  }
}

// —— 文件列表 ——

function renderList() {
  const { els } = state;
  const files = currentFiles();
  els.listWrap.hidden = files.length === 0;
  els.drop.hidden = files.length > 0;
  els.list.innerHTML = '';
  els.listCount.textContent = files.length ? `共 ${files.length} 项` : '';

  files.forEach((f, index) => {
    const li = document.createElement('li');
    li.className = 'pdf-item';

    if (f.thumbUrl) {
      const img = document.createElement('img');
      img.className = 'pdf-item-thumb';
      img.src = f.thumbUrl;
      img.alt = '';
      li.appendChild(img);
    }

    const main = document.createElement('div');
    main.className = 'pdf-item-main';
    const name = document.createElement('div');
    name.className = 'pdf-item-name';
    name.textContent = f.name;
    name.title = f.path;
    const meta = document.createElement('div');
    meta.className = 'pdf-item-meta';
    meta.textContent = f.meta || '';
    main.appendChild(name);
    main.appendChild(meta);
    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'pdf-item-actions';
    if (state.direction === 'image-to-pdf' || state.direction === 'page-ops') {
      const up = document.createElement('button');
      up.className = 'pdf-icon-btn';
      up.textContent = '↑';
      up.title = '上移';
      up.disabled = index === 0;
      up.addEventListener('click', () => moveFile(index, -1));
      const down = document.createElement('button');
      down.className = 'pdf-icon-btn';
      down.textContent = '↓';
      down.title = '下移';
      down.disabled = index === files.length - 1;
      down.addEventListener('click', () => moveFile(index, 1));
      actions.appendChild(up);
      actions.appendChild(down);
    }
    const del = document.createElement('button');
    del.className = 'pdf-icon-btn';
    del.textContent = '×';
    del.title = '移除';
    del.addEventListener('click', () => {
      files.splice(index, 1);
      renderList();
    });
    actions.appendChild(del);
    li.appendChild(actions);

    els.list.appendChild(li);
  });
  updateRunButton();
}

function moveFile(index, delta) {
  const files = currentFiles();
  const target = index + delta;
  if (target < 0 || target >= files.length) return;
  const [item] = files.splice(index, 1);
  files.splice(target, 0, item);
  renderList();
}

// —— 添加文件 ——

async function addFromPaths(paths) {
  const d = state.direction;
  const files = currentFiles();
  const failures = [];
  let added = 0;

  for (const p of paths) {
    try {
      const info = await state.ctx.pathInfo(p);
      const ext = (info.ext || '').toLowerCase();
      if (d === 'image-to-pdf') {
        if (!IMAGE_EXTS.has(ext)) { failures.push(`${info.name}：不是支持的图片`); continue; }
        const bytes = await state.ctx.readFile(p);
        // 添加阶段只要尺寸与缩略图，不摊开整图像素（真正转 PDF 时会重新解码）
        const { thumb, width, height } = await makeThumbnailFromBytes(bytes, 40);
        files.push({
          path: p, name: info.name, baseName: info.baseName, dir: info.dir,
          width, height,
          meta: `${width} × ${height}`,
          thumbUrl: thumb.toDataURL('image/png')
        });
      } else if (d === 'office-to-pdf') {
        if (!OFFICE_EXTS.has(ext)) { failures.push(`${info.name}：不是 Word/Excel 文件`); continue; }
        files.push({ path: p, name: info.name, baseName: info.baseName, dir: info.dir, ext, meta: ext.slice(1).toUpperCase() });
      } else {
        if (ext !== '.pdf') { failures.push(`${info.name}：不是 PDF 文件`); continue; }
        const bytes = await state.ctx.readFile(p);
        const pages = await getPageCount(bytes);
        files.push({ path: p, name: info.name, baseName: info.baseName, dir: info.dir, pages, meta: `共 ${pages} 页` });
      }
      added += 1;
    } catch (err) {
      failures.push(`${p.split(/[\\/]/).pop()}：${err.message}`);
    }
  }

  renderList();
  if (added > 0) {
    state.ctx.setStatus(`已添加 ${added} 项${failures.length ? `，${failures.length} 项失败` : ''}`);
  } else {
    state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的文件');
  }
  if (failures.length > 1) console.warn('[pdf-convert] 部分文件添加失败：\n' + failures.join('\n'));
}

async function openDialog() {
  const d = state.direction;
  let paths = [];
  if (d === 'image-to-pdf') paths = await state.ctx.openImages();
  else if (d === 'office-to-pdf') paths = await state.ctx.openDocuments();
  else paths = await state.ctx.openPdfs();
  if (paths && paths.length > 0) await addFromPaths(paths);
}

async function onDrop(event) {
  event.preventDefault();
  const files = Array.from(event.dataTransfer ? event.dataTransfer.files : []);
  const paths = [];
  for (const file of files) {
    const p = state.ctx.getPathForFile(file);
    if (p) paths.push(p);
  }
  if (paths.length > 0) await addFromPaths(paths);
}

// —— 运行：各方向的流程 ——

function outDirSetting() {
  return state.ctx.settings.getSettings().outputDir || undefined;
}

async function runPdfToImage() {
  const files = currentFiles();
  const { rangeText, scale, format, quality } = readParams();
  const ext = format === 'jpg' ? '.jpg' : '.png';

  // 先校验页码范围并统计总量（进度用）
  let total = 0;
  for (const f of files) {
    const pages = parsePageRange(rangeText, f.pages);
    total += (pages || allPages(f.pages)).length;
  }
  if (total === 0) { state.ctx.setStatus('没有要导出的页'); return; }

  let done = 0;
  let failed = 0;
  let lastDir = '';
  let lastError = '';
  for (const f of files) {
    try {
      const bytes = await state.ctx.readFile(f.path);
      const pdf = await openPdf(bytes);
      try {
        const pages = parsePageRange(rangeText, pdf.numPages) || allPages(pdf.numPages);
        const subDir = `${f.dir}\\${f.baseName}_图片`;
        for (const p of pages) {
          state.ctx.showProgress(`${f.name}：第 ${p} 页（${done + 1}/${total}）`, (done / total) * 100);
          await nextFrame();
          const img = await renderPageToPixels(pdf, p, { scale });
          const out = await encodeImageToBytes(img.pixels, img.width, img.height, { format, quality });
          await state.ctx.saveNextTo({
            sourcePath: f.path, targetDir: subDir, baseName: `页${pad3(p)}`, ext, bytes: out
          });
          lastDir = subDir;
          done += 1;
        }
      } finally {
        // 释放解析线程：destroy 可能同步抛错（如内部 transport 已释放），单独兜底，
        // 避免"页面全部导出成功却被记为失败"
        try {
          await pdf.destroy();
        } catch {
          /* 清理异常忽略 */
        }
      }
    } catch (err) {
      failed += 1;
      lastError = err.message;
      console.error('[pdf-convert] 导出失败', f.name, err);
    }
  }
  state.ctx.hideProgress();
  state.ctx.setStatus(`导出完成：成功 ${done} 页${failed ? `，${failed} 个文件失败（${lastError}）` : ''}`);
  if (lastDir) state.els.result.textContent = `输出：${lastDir}`;
}

async function runImageToPdf() {
  const files = currentFiles();
  const { pageMode, margin } = readParams();
  const images = [];
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    state.ctx.showProgress(`读取图片 ${i + 1}/${files.length}…`, (i / files.length) * 100);
    await nextFrame();
    try {
      let bytes = await state.ctx.readFile(files[i].path);
      let type = sniffImageType(bytes);
      if (!type) {
        // webp 等格式：先解码再以 PNG 形式嵌入
        const img = await decodeImageFromBytes(bytes);
        bytes = await encodeImageToBytes(img.pixels, img.width, img.height, { format: 'png' });
        type = 'png';
      }
      images.push({ bytes, type });
    } catch (err) {
      failed += 1;
      console.error('[pdf-convert] 图片读取失败', files[i].name, err);
    }
  }
  if (images.length === 0) {
    state.ctx.hideProgress();
    state.ctx.setStatus('没有可用的图片');
    return;
  }

  state.ctx.showProgress('正在合成 PDF…', 90);
  await nextFrame();
  const pdfBytes = await imagesToPdf(images, { pageMode, margin });
  const first = files[0];
  const target = await state.ctx.saveNextTo({
    sourcePath: first.path, targetDir: outDirSetting(), baseName: `${first.baseName}_合并`, ext: '.pdf', bytes: pdfBytes
  });
  state.ctx.hideProgress();
  state.ctx.setStatus(`已生成 PDF（${images.length} 页）${failed ? `，跳过 ${failed} 张读取失败的图片` : ''}`);
  state.els.result.textContent = `输出：${target}`;
}

async function runPageOps() {
  const files = currentFiles();
  const params = readParams();
  const outputDir = outDirSetting();

  if (params.sub === 'merge') {
    if (files.length < 2) { state.ctx.setStatus('合并至少需要 2 份 PDF'); return; }
    const list = [];
    for (let i = 0; i < files.length; i++) {
      state.ctx.showProgress(`读取 ${i + 1}/${files.length}：${files[i].name}`, (i / files.length) * 100);
      await nextFrame();
      list.push(await state.ctx.readFile(files[i].path));
    }
    state.ctx.showProgress('正在合并…', 90);
    const bytes = await mergePdfs(list);
    const first = files[0];
    const target = await state.ctx.saveNextTo({
      sourcePath: first.path, targetDir: outputDir, baseName: `${first.baseName}_合并`, ext: '.pdf', bytes
    });
    state.ctx.hideProgress();
    state.ctx.setStatus(`合并完成：${files.length} 份 → ${first.baseName}_合并.pdf`);
    state.els.result.textContent = `输出：${target}`;
    return;
  }

  if (files.length !== 1) { state.ctx.setStatus(`${params.sub === 'split' ? '拆分' : '提取页'}需要且只需要 1 份 PDF`); return; }
  const f = files[0];
  const bytes = await state.ctx.readFile(f.path);

  if (params.sub === 'split') {
    state.ctx.showProgress('正在拆分…', 30);
    const parts = await splitPdf(bytes, { everyN: params.everyN });
    let lastPath = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      state.ctx.showProgress(`保存 ${i + 1}/${parts.length}…`, 30 + (i / parts.length) * 70);
      await nextFrame();
      const suffix = part.start === part.end ? `页${pad3(part.start)}` : `页${pad3(part.start)}-${pad3(part.end)}`;
      lastPath = await state.ctx.saveNextTo({
        sourcePath: f.path, targetDir: outputDir, baseName: `${f.baseName}_${suffix}`, ext: '.pdf', bytes: part.bytes
      });
    }
    state.ctx.hideProgress();
    state.ctx.setStatus(`拆分完成：共 ${parts.length} 个文件`);
    state.els.result.textContent = `输出：${lastPath}`;
    return;
  }

  // 提取页
  const pages = parsePageRange(params.rangeText, f.pages);
  if (!pages || pages.length === 0) { state.ctx.setStatus('请先填写页码范围（如 1-3,5）'); return; }
  state.ctx.showProgress('正在提取…', 50);
  const outBytes = await extractPages(bytes, pages);
  const target = await state.ctx.saveNextTo({
    sourcePath: f.path, targetDir: outputDir, baseName: `${f.baseName}_提取`, ext: '.pdf', bytes: outBytes
  });
  state.ctx.hideProgress();
  state.ctx.setStatus(`提取完成：${pages.length} 页`);
  state.els.result.textContent = `输出：${target}`;
}

async function runConvert(targetFormat) {
  const files = currentFiles();
  const loFound = !!(state.lo && state.lo.found);
  // PDF → Word 必须依赖加装包；Word/Excel → PDF 在没加装包时走内置降级（仅 .docx/.xlsx）
  if (targetFormat === 'docx' && !loFound) {
    state.ctx.setStatus('PDF → Word 需要 LibreOffice 加装包（解压到软件目录的 addons/libreoffice 后重开本工具）');
    return;
  }

  const ext = targetFormat === 'docx' ? '.docx' : '.pdf';
  const outputDir = outDirSetting();
  // PDF → Word 的输出方式：text=压平成普通段落（Word 可正常打开）/ layout=保留 LibreOffice 原始版式
  const wordMode = targetFormat === 'docx' ? (readParams().wordMode || 'text') : '';
  let done = 0;
  let failed = 0;
  let builtin = 0;
  let lastPath = '';
  let lastError = '';
  let flattenWarn = '';

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // LibreOffice 转换大文件耗时较长（实测 12MB 教材约 4 分钟），提示避免被误当成卡死
    const slowHint = loFound ? '（大文件可能需数分钟，请勿关闭）' : '';
    state.ctx.showProgress(`转换 ${i + 1}/${files.length}：${f.name}${slowHint}`, (i / files.length) * 100);
    await nextFrame();
    try {
      let res;
      if (loFound) {
        res = await state.ctx.libreofficeConvert({ inputPath: f.path, target: targetFormat, mode: wordMode });
      } else {
        const fileExt = (f.ext || '').toLowerCase();
        if (fileExt !== '.docx' && fileExt !== '.xlsx') {
          throw new Error('旧版 .doc/.xls 需要 LibreOffice 加装包');
        }
        res = await state.ctx.officeToPdf({ inputPath: f.path, kind: fileExt === '.xlsx' ? 'xlsx' : 'docx' });
        builtin += 1;
      }
      if (!res || !res.ok) throw new Error((res && res.message) || '转换失败');
      if (res.flatten && res.flatten.applied === false && res.flatten.error) {
        flattenWarn = `压平失败，已输出原文件（${res.flatten.error}）`;
      }
      lastPath = await state.ctx.saveNextTo({
        sourcePath: f.path, targetDir: outputDir, baseName: f.baseName, ext, bytes: res.bytes
      });
      done += 1;
    } catch (err) {
      failed += 1;
      lastError = err.message;
      console.error('[pdf-convert] 转换失败', f.name, err);
    }
  }
  state.ctx.hideProgress();
  const how = builtin > 0 ? '（内置转换，版式可能有偏差；装加装包可高保真）' : '';
  const modeNote = targetFormat === 'docx' && done > 0
    ? (wordMode === 'text' ? '（可编辑文本模式）' : '（保留版式模式）')
    : '';
  const warn = flattenWarn ? `｜${flattenWarn}` : '';
  state.ctx.setStatus(`转换完成：成功 ${done} 个${failed ? `，失败 ${failed} 个（${lastError}）` : ''}${modeNote}${how}${warn}`);
  if (lastPath) state.els.result.textContent = `输出：${lastPath}`;
}

async function run() {
  if (state.busy) return;
  // await 期间本页可能被 LRU 回收（unmount 把 state 置空）：全程用局部 st，界面收尾前再核对
  const st = state;
  const files = currentFiles();
  if (files.length === 0) {
    st.ctx.setStatus('请先添加文件');
    return;
  }
  st.busy = true;
  updateRunButton();
  try {
    switch (st.direction) {
      case 'pdf-to-image': await runPdfToImage(); break;
      case 'image-to-pdf': await runImageToPdf(); break;
      case 'page-ops': await runPageOps(); break;
      case 'office-to-pdf': await runConvert('pdf'); break;
      case 'pdf-to-word': await runConvert('docx'); break;
      default: break;
    }
  } catch (err) {
    st.ctx.hideProgress();
    st.ctx.setStatus(`处理失败：${err.message}`);
    console.error('[pdf-convert] 处理失败', err);
  } finally {
    if (state === st) {
      st.busy = false;
      updateRunButton();
    }
  }
}

// —— 方向切换 ——

function switchDirection(id) {
  state.direction = id;
  state.els.directionSel.value = id;
  state.els.result.textContent = '';
  renderParams();
  renderList();
  state.ctx.setStatus(`${dirOf(id).label}：${dirOf(id).hint}`);
  state.ctx.setInfo({});
}

// —— 生命周期 ——

export function mount(container, ctx) {
  state = {
    ctx,
    els: null,
    listeners: [],
    direction: DIRECTIONS[0].id,
    lists: { 'pdf-to-image': [], 'image-to-pdf': [], 'page-ops': [], 'office-to-pdf': [], 'pdf-to-word': [] },
    lo: null,
    busy: false,
    container
  };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.pdf-tool'),
    directionSel: container.querySelector('#pdfDirection'),
    directionHint: container.querySelector('#pdfDirectionHint'),
    params: container.querySelector('#pdfParams'),
    drop: container.querySelector('#pdfDrop'),
    addBtn: container.querySelector('#pdfAddBtn'),
    listWrap: container.querySelector('#pdfListWrap'),
    list: container.querySelector('#pdfList'),
    listCount: container.querySelector('#pdfListCount'),
    addMore: container.querySelector('#pdfAddMore'),
    runBtn: container.querySelector('#pdfRunBtn'),
    clearBtn: container.querySelector('#pdfClearBtn'),
    result: container.querySelector('#pdfResult')
  };
  state.els = els;

  els.directionSel.innerHTML = '';
  for (const d of DIRECTIONS) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.label;
    els.directionSel.appendChild(opt);
  }

  on(els.directionSel, 'change', () => switchDirection(els.directionSel.value));
  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', run);
  on(els.clearBtn, 'click', () => {
    state.lists[state.direction] = [];
    renderList();
    state.ctx.setStatus('已清空文件列表');
  });
  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);

  switchDirection(DIRECTIONS[0].id);
  // 预取一次加装包状态（切到转换方向时直接显示）
  state.ctx.libreofficeStatus().then((s) => { state.lo = s; }).catch(() => {});
}

export function unmount() {
  if (!state) return;
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  state = null;
}