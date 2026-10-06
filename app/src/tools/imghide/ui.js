// 工具：文件藏图 —— 界面与交互
// 分层：本文件只做界面与流程编排；容器格式/载荷在 core/format.mjs，密码在 core/crypto.mjs，
//       Node 侧引擎（打包/解包/落盘）在 core/engine.mjs，由主进程经 IPC 调用。
// 规格：spec/modules/imghide.md
import { detectCoverKind, pngInfo, pngCompatError, humanBytes, sizeWarning } from './core/format.mjs';
import { decodeImageFromBytes, encodeImageToBytes } from '../../shared/imageio.js';

/** 可以作为「表图」的扩展名（都是内核能解码的位图；SVG/ICO 不做表图，避免解码差异） */
const COVER_EXTS = ['png', 'gif', 'jpg', 'jpeg', 'webp', 'bmp', 'avif'];
/** 一次最多收多少个里图（防御误拖整个文件夹） */
const MAX_ITEMS = 500;
/** 随机表图的尺寸（够大又不至于让产物太肥） */
const RANDOM_COVER_SIZE = 1024;

const MARKUP = `
  <div class="ih-tool" id="ihRoot">
    <div class="ih-modes">
      <button class="ih-mode-btn is-active" id="ihModePack" type="button" data-mode="pack">📎 打包（把文件藏进图片）</button>
      <button class="ih-mode-btn" id="ihModeUnpack" type="button" data-mode="unpack">📂 解包（把文件取出来）</button>
      <span class="ih-modes-spacer"></span>
      <span class="ih-modes-hint" id="ihModesHint">与「图夹」网站/APP 互通</span>
    </div>

    <!-- 打包 -->
    <section class="ih-pane" id="ihPackPane">
      <section class="card ih-card">
        <div class="ih-row">
          <span class="control-label">表图</span>
          <button class="btn btn-primary" id="ihRandomCover" type="button" data-pick="random">随机表图</button>
          <button class="btn btn-plain" id="ihPickCover" type="button" data-pick="cover">选择图片</button>
          <button class="btn btn-ghost" id="ihClearCover" type="button" data-clear="cover">清空</button>
          <span class="ih-drop-hint">PNG / GIF 原样写入；JPG、WebP 等会自动转成 PNG</span>
        </div>
        <div class="ih-cover" id="ihCoverBox">
          <img class="ih-cover-thumb" id="ihCoverThumb" alt="表图预览" hidden />
          <div class="ih-cover-meta" id="ihCoverMeta">
            <span>还没选表图</span>
            <span class="ih-sub">表图 = 最终发给别人的那张图（文件就藏在它里面）；也可以点「随机表图」让软件生成一张</span>
          </div>
        </div>
      </section>

      <section class="card ih-card">
        <div class="ih-row">
          <span class="control-label">要藏的文件</span>
          <button class="btn btn-primary" id="ihAddFiles" type="button" data-pick="files">添加文件</button>
          <span class="ih-drop-hint">任意类型（图片/视频/文档/压缩包都行）；也可以直接把文件拖进窗口</span>
        </div>
        <ul class="ih-list" id="ihItems"></ul>
        <div class="ih-note" id="ihItemsEmpty">还没有要藏的文件</div>
        <div class="ih-note" id="ihSizeNote"></div>
      </section>

      <section class="card ih-card">
        <div class="ih-row">
          <span class="control-label">算法选择</span>
          <label class="ih-radio"><input type="radio" name="ihAlgo" id="ihAlgoFast" value="fast" checked /> 动态混淆（极速）</label>
          <label class="ih-radio"><input type="radio" name="ihAlgo" id="ihAlgoPro" value="pro" /> 图夹 PRO（防查）</label>
        </div>
        <div class="ih-note" id="ihAlgoNote"></div>
        <div class="ih-row">
          <span class="control-label">密码</span>
          <input class="input ih-w-md" id="ihPassword" type="text" placeholder="不加密（对方打开就能解）" disabled />
          <span class="ih-drop-hint" id="ihPasswordHint">选「防查」才能设密码</span>
        </div>
        <div class="ih-row">
          <span class="control-label">水印文字</span>
          <input class="input ih-w-md" id="ihWatermark" type="text" placeholder="可选，例如：图夹" />
          <span class="ih-drop-hint">填了水印会把表图重编码成 PNG 输出（GIF 表图不重编码，加不上字）</span>
        </div>
        <div class="ih-note" id="ihPackNote">提示：微信 / QQ 里请以「文件」方式发送这张图；直接发图会被平台压缩，藏在里面的数据会丢。</div>
      </section>

      <div class="ih-actions">
        <button class="btn btn-primary" id="ihRunPack" type="button" data-run="pack">开始打包</button>
        <button class="btn btn-plain" id="ihClearPack" type="button" data-clear="pack">清空</button>
        <button class="btn btn-ghost" id="ihOpenProduct" type="button" data-open="product" hidden>打开文件夹</button>
        <div class="ih-result" id="ihPackResult"></div>
      </div>
    </section>

    <!-- 解包 -->
    <section class="ih-pane" id="ihUnpackPane" hidden>
      <section class="card ih-card">
        <div class="ih-row">
          <span class="control-label">图夹图片</span>
          <button class="btn btn-primary" id="ihPickImage" type="button" data-pick="image">选择图片</button>
          <button class="btn btn-ghost" id="ihClearImage" type="button" data-clear="image">清空</button>
          <span class="ih-drop-hint">PNG / GIF 的图夹图；也可以直接把图拖进窗口</span>
        </div>
        <div class="ih-cover" id="ihImageBox">
          <img class="ih-cover-thumb" id="ihImageThumb" alt="图夹图预览" hidden />
          <div class="ih-cover-meta" id="ihImageMeta">
            <span>还没选图片</span>
            <span class="ih-sub">别人发来的图夹图，或者你自己刚打包的那张</span>
          </div>
        </div>
      </section>

      <section class="card ih-card">
        <div class="ih-row">
          <span class="control-label">密码</span>
          <input class="input ih-w-md" id="ihPasswordX" type="text" placeholder="图夹图设了密码才需要填" />
          <span class="ih-drop-hint">解出来的文件会放在图片旁边的「xxx_解出」文件夹里</span>
        </div>
      </section>

      <section class="card ih-card ih-result-card" id="ihUnpackCard">
        <div class="ih-result-head">
          <span id="ihUnpackTitle">解包结果</span>
          <span class="ih-result-dir" id="ihUnpackDir"></span>
          <button class="btn btn-ghost" id="ihOpenFolder" type="button" data-open="folder" hidden>打开文件夹</button>
        </div>
        <ul class="ih-list" id="ihUnpackList"></ul>
        <div class="ih-note" id="ihUnpackEmpty">选一张图夹图，点「开始解包」就能把里面的文件取出来</div>
      </section>

      <div class="ih-actions">
        <button class="btn btn-primary" id="ihRunUnpack" type="button" data-run="unpack">开始解包</button>
        <button class="btn btn-plain" id="ihClearUnpack" type="button" data-clear="unpack">清空</button>
        <div class="ih-result" id="ihUnpackResult"></div>
      </div>
    </section>
  </div>
`;

/** 挂到 DOM 上的监听集中登记，unmount 时统一摘掉 */
const listeners = [];
function on(el, type, handler) {
  if (!el) return;
  el.addEventListener(type, handler);
  listeners.push([el, type, handler]);
}
function offAll() {
  while (listeners.length) {
    const [el, type, handler] = listeners.pop();
    el.removeEventListener(type, handler);
  }
}

let state = null;

function isImagePath(filePath) {
  const ext = String(filePath).toLowerCase().split('.').pop();
  return COVER_EXTS.includes(ext);
}

function extLabel(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  return ext && ext !== name.toLowerCase() ? ext.toUpperCase() : '文件';
}

/** 时间戳（随机表图产物的默认名字） */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// —— 随机表图与加水印（都在界面进程用画布做，不引入任何素材/依赖） ——

/** 生成一张装饰性封面（渐变 + 光斑 + 细噪点），返回 PNG 字节 */
async function makeRandomCover() {
  const size = RANDOM_COVER_SIZE;
  // 必须用 OffscreenCanvas：普通 <canvas> 没有 convertToBlob（踩过：报错被状态栏吞掉，看起来像「点了没反应」）
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');

  const hue = Math.floor(Math.random() * 360);
  const bg = ctx.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, `hsl(${hue} 78% 62%)`);
  bg.addColorStop(0.55, `hsl(${(hue + 40) % 360} 72% 48%)`);
  bg.addColorStop(1, `hsl(${(hue + 300) % 360} 68% 28%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  // 光斑：径向渐变圆
  for (let i = 0; i < 9; i += 1) {
    const cx = Math.random() * size;
    const cy = Math.random() * size;
    const r = size * (0.08 + Math.random() * 0.28);
    const spot = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const h = (hue + Math.floor(Math.random() * 360)) % 360;
    spot.addColorStop(0, `hsla(${h} 90% 78% / ${0.25 + Math.random() * 0.35})`);
    spot.addColorStop(1, 'hsla(0 0% 100% / 0)');
    ctx.fillStyle = spot;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 细噪点：让画面不那么"塑料"，也更耐压缩
  const dots = Math.floor(size * size * 0.02);
  for (let i = 0; i < dots; i += 1) {
    ctx.fillStyle = `hsla(0 0% ${Math.random() > 0.5 ? 100 : 0}% / 0.05)`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1.6, 1.6);
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

/** 在图片左上角叠加文字水印（重编码为 PNG） */
async function applyWatermark(bytes, text) {
  const { pixels, width, height } = await decodeImageFromBytes(bytes);
  // 同上：OffscreenCanvas 才有 convertToBlob
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);

  const fontSize = Math.max(14, Math.round(Math.min(width, height) * 0.055));
  const pad = Math.round(fontSize * 0.7);
  ctx.font = `bold ${fontSize}px "Microsoft YaHei", "Segoe UI", sans-serif`;
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.14));
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.86)';
  ctx.strokeText(text, pad, pad);
  ctx.fillText(text, pad, pad);

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

// —— 表图 / 待解包图 ——

function revokeThumb(which) {
  const holder = which === 'cover' ? state.cover : state.unpackImage;
  if (holder && holder.thumbUrl) {
    URL.revokeObjectURL(holder.thumbUrl);
    holder.thumbUrl = '';
  }
}

function renderCoverMeta(title, sub) {
  const { els } = state;
  els.coverMeta.innerHTML = '<span class="ih-cover-name"></span><span class="ih-sub"></span>';
  els.coverMeta.querySelector('.ih-cover-name').textContent = title;
  els.coverMeta.querySelector('.ih-sub').textContent = sub;
}

/** 设为随机生成的封面（没有磁盘来源） */
async function setRandomCover() {
  const { ctx, els } = state;
  ctx.setStatus('正在生成随机表图…');
  const bytes = await makeRandomCover();
  revokeThumb('cover');
  state.cover = {
    source: 'random',
    path: '',
    name: `随机表图-${stamp()}.png`,
    size: bytes.length,
    kind: 'png',
    needsReencode: false,
    bytes,
    thumbUrl: URL.createObjectURL(new Blob([bytes]))
  };
  els.coverThumb.src = state.cover.thumbUrl;
  els.coverThumb.hidden = false;
  els.coverBox.classList.add('is-set');
  renderCoverMeta(`随机表图（${humanBytes(bytes.length)}）`, '软件生成的封面；不满意可以再点一次「随机表图」换一张，或改成「选择图片」');
  refreshRunState();
  ctx.setStatus('已生成随机表图；再点一次可以换一张');
}

async function setCover(filePath) {
  const { ctx, els } = state;
  const info = await ctx.pathInfo(filePath);
  if (info.isDirectory) {
    ctx.setStatus('表图要选一张图片，不能选文件夹');
    return;
  }
  const bytes = await ctx.readFile(filePath);
  if (!bytes || bytes.length === 0) {
    ctx.setStatus('读不到这张表图（文件可能已被移动或删除）');
    return;
  }
  const kind = detectCoverKind(bytes);
  let needsReencode = false;
  let reason = '';
  if (kind === 'png') {
    const problem = pngCompatError(pngInfo(bytes));
    if (problem) {
      needsReencode = true;
      reason = problem;
    }
  } else if (kind !== 'gif') {
    needsReencode = true;
    reason = '会转成 PNG';
  }

  revokeThumb('cover');
  state.cover = {
    source: 'file',
    path: filePath,
    name: info.name,
    size: info.size || bytes.length,
    kind: needsReencode ? 'png' : kind,
    needsReencode,
    reason,
    bytes,
    thumbUrl: URL.createObjectURL(new Blob([bytes]))
  };
  els.coverThumb.src = state.cover.thumbUrl;
  els.coverThumb.hidden = false;
  els.coverBox.classList.add('is-set');
  const kindText = needsReencode
    ? `不是 PNG/GIF（${reason}）`
    : (kind === 'gif' ? 'GIF（原样写入，动图也能藏）' : 'PNG（原图直接写入，画质不变）');
  renderCoverMeta(`${state.cover.name}（${humanBytes(state.cover.size)}）`, kindText);
  refreshRunState();
}

function clearCover() {
  revokeThumb('cover');
  state.cover = null;
  const { els } = state;
  els.coverThumb.hidden = true;
  els.coverThumb.removeAttribute('src');
  els.coverBox.classList.remove('is-set');
  els.coverMeta.innerHTML = '<span>还没选表图</span><span class="ih-sub">表图 = 最终发给别人的那张图（文件就藏在它里面）；也可以点「随机表图」让软件生成一张</span>';
  refreshRunState();
}

async function setUnpackImage(filePath) {
  const { ctx, els } = state;
  const info = await ctx.pathInfo(filePath);
  if (info.isDirectory) {
    ctx.setStatus('请选一张图夹图片，不能选文件夹');
    return;
  }
  const bytes = await ctx.readFile(filePath);
  if (!bytes || bytes.length === 0) {
    ctx.setStatus('读不到这张图片（文件可能已被移动或删除）');
    return;
  }
  revokeThumb('unpack');
  state.unpackImage = {
    path: filePath,
    name: info.name,
    size: info.size || bytes.length,
    thumbUrl: URL.createObjectURL(new Blob([bytes]))
  };
  els.imageThumb.src = state.unpackImage.thumbUrl;
  els.imageThumb.hidden = false;
  els.imageBox.classList.add('is-set');
  els.imageMeta.innerHTML = '<span class="ih-cover-name"></span><span class="ih-sub"></span>';
  els.imageMeta.querySelector('.ih-cover-name').textContent = `${state.unpackImage.name}（${humanBytes(state.unpackImage.size)}）`;
  els.imageMeta.querySelector('.ih-sub').textContent = '点「开始解包」取出里面的文件';
  refreshRunState();
}

function clearUnpackImage() {
  revokeThumb('unpack');
  state.unpackImage = null;
  const { els } = state;
  els.imageThumb.hidden = true;
  els.imageThumb.removeAttribute('src');
  els.imageBox.classList.remove('is-set');
  els.imageMeta.innerHTML = '<span>还没选图片</span><span class="ih-sub">别人发来的图夹图，或者你自己刚打包的那张</span>';
  refreshRunState();
}

// —— 里图列表 ——

async function addItems(paths) {
  const { ctx, els } = state;
  const exists = new Set(state.items.map((it) => it.path));
  let added = 0;
  for (const p of paths) {
    if (state.items.length >= MAX_ITEMS) {
      ctx.setStatus(`一次最多藏 ${MAX_ITEMS} 个文件，其余已忽略`);
      break;
    }
    if (exists.has(p)) continue;
    const info = await ctx.pathInfo(p);
    if (info.isDirectory) continue; // 目录不进里图（原版语义也是文件）
    exists.add(p);
    state.items.push({ path: p, name: info.name, size: info.size });
    added += 1;
  }
  if (added > 0) {
    els.itemsEmpty.hidden = true;
    renderItems();
    refreshRunState();
    ctx.setStatus(`已加入 ${added} 个文件`);
  }
}

function removeItem(path) {
  state.items = state.items.filter((it) => it.path !== path);
  renderItems();
  refreshRunState();
}

function renderItems() {
  const { els } = state;
  els.items.innerHTML = '';
  for (const item of state.items) {
    const li = document.createElement('li');
    li.className = 'ih-item';
    li.dataset.path = item.path;

    const name = document.createElement('span');
    name.className = 'ih-item-name';
    name.textContent = item.name;

    const size = document.createElement('span');
    size.className = 'ih-item-size';
    size.textContent = `${extLabel(item.name)} · ${humanBytes(item.size)}`;

    const remove = document.createElement('button');
    remove.className = 'ih-item-remove';
    remove.type = 'button';
    remove.textContent = '✕';
    remove.title = '移除';
    remove.dataset.remove = item.path;
    remove.addEventListener('click', () => removeItem(item.path));

    li.append(name, size, remove);
    els.items.appendChild(li);
  }
  els.itemsEmpty.hidden = state.items.length > 0;
}

// —— 运行状态与结果 ——

function refreshSizeNote() {
  const { els } = state;
  const total = state.items.reduce((sum, it) => sum + (Number(it.size) || 0), 0);
  const coverSize = state.cover ? Number(state.cover.size) || 0 : 0;
  const warn = sizeWarning(total, coverSize, isProMode() ? 'pro' : 'fast');
  if (!state.items.length) {
    els.sizeNote.textContent = '';
    els.sizeNote.className = 'ih-note';
    return;
  }
  els.sizeNote.textContent = warn.text || `合计 ${humanBytes(total)}（预计产物约 ${humanBytes(total + coverSize)}）。`;
  els.sizeNote.className = `ih-note${warn.level === 'warn' ? ' is-error' : warn.level === 'hint' ? ' is-warn' : ''}`;
}

function isProMode() {
  return !!state.els.algoPro.checked;
}

function refreshRunState() {
  const { els } = state;
  const pro = isProMode();
  els.password.disabled = !pro;
  els.passwordHint.textContent = pro
    ? '填了密码，对方要用同一密码才能取出文件（留空 = 只换结构不加密）'
    : '选「图夹 PRO」才能设密码';
  els.algoNote.textContent = pro
    ? '图夹 PRO（防查）：整张图重新压一遍、带原版指纹，网页版打开时会提示「识别到图夹PRO文件」并要你点一次确认（设了密码就输密码）。'
    : '动态混淆（极速）：文件直接接在图片尾部，网页版/手机 APP 打开即解、不弹密码框；表图什么格式都行，图片画质一点不变。';
  els.runPack.disabled = state.busy || !state.cover || state.items.length === 0;
  els.runUnpack.disabled = state.busy || !state.unpackImage;
  els.clearPack.disabled = state.busy;
  els.clearUnpack.disabled = state.busy;
  els.openProduct.hidden = !state.productPath;
  els.packResult.textContent = state.packedText || '';
  els.packResult.className = `ih-result${state.packedClass ? ` ${state.packedClass}` : ''}`;
  els.unpackResult.textContent = state.unpackText || '';
  els.unpackResult.className = `ih-result${state.unpackClass ? ` ${state.unpackClass}` : ''}`;
  refreshSizeNote();
}

function showPackResult(text, cls, productPath) {
  state.packedText = text;
  state.packedClass = cls || '';
  state.productPath = productPath || '';
  refreshRunState();
}

function showUnpackResult(text, cls) {
  state.unpackText = text;
  state.unpackClass = cls || '';
  refreshRunState();
}

function renderUnpackFiles(result) {
  const { els } = state;
  els.unpackList.innerHTML = '';
  els.unpackDir.textContent = result.dir;
  els.openFolder.hidden = false;
  els.unpackEmpty.hidden = true;
  els.unpackTitle.textContent = `解出 ${result.files.length} 个文件${result.encrypted ? '（已用密码解密）' : ''}`;
  for (const file of result.files) {
    const li = document.createElement('li');
    li.className = 'ih-item';
    const name = document.createElement('span');
    name.className = 'ih-item-name';
    name.textContent = file.name;
    const size = document.createElement('span');
    size.className = 'ih-item-size';
    size.textContent = humanBytes(file.size);
    li.append(name, size);
    els.unpackList.appendChild(li);
  }
}

function clearUnpackResult() {
  const { els } = state;
  state.unpackResult = null;
  els.unpackList.innerHTML = '';
  els.unpackDir.textContent = '';
  els.openFolder.hidden = true;
  els.unpackEmpty.hidden = false;
  els.unpackTitle.textContent = '解包结果';
}

// —— 打包 / 解包 ——

async function runPack() {
  // await 期间本页可能被 LRU 回收（unmount 把 state 置空）：全程用局部 st，界面刷新前再核对
  const st = state;
  const { ctx, els } = st;
  if (!st.cover || st.items.length === 0) return;
  st.busy = true;
  refreshRunState();
  ctx.showProgress('正在打包…', 0);
  try {
    const watermark = els.watermark.value.trim();
    const mode = isProMode() ? 'pro' : 'fast';
    const password = mode === 'pro' ? els.password.value.trim() : '';
    let coverBytes = null;
    let coverKind = st.cover.kind;
    let outputDir;
    let baseName;

    const raw = st.cover.bytes || (st.cover.path ? await ctx.readFile(st.cover.path) : null);
    // 「防查」要把数据塞进 IDAT 流，所以表图必须是 8 位 PNG（或 GIF）；「极速」直接追加在尾部，什么格式都行
    const needConvert = watermark !== '' || (mode === 'pro' && st.cover.source !== 'random' && st.cover.needsReencode);
    if (needConvert) {
      ctx.showProgress(watermark ? '正在给表图加水印…' : '正在把表图转成 PNG…', 5);
      let png = raw;
      if (watermark || st.cover.needsReencode) {
        const { pixels, width, height } = await decodeImageFromBytes(raw);
        png = await encodeImageToBytes(pixels, width, height, { format: 'png' });
      }
      if (watermark) png = await applyWatermark(png, watermark);
      coverBytes = png;
      coverKind = 'png';
    }

    if (st.cover.source === 'random') {
      // 随机表图没有磁盘文件：字节得交给主进程；产物落系统「图片」文件夹（由主进程决定），名字带时间戳
      if (!coverBytes) coverBytes = raw;
      baseName = `随机表图-${stamp()}`;
      outputDir = undefined;
    }

    const res = await ctx.hidePack({
      mode,
      coverPath: st.cover.path || undefined,
      coverBytes,
      coverKind,
      items: st.items.map((item) => ({ path: item.path, name: item.name })),
      password,
      outputDir,
      baseName
    });
    if (!res || !res.ok) throw new Error((res && res.message) || '打包失败');
    st.packed = res;
    if (state === st) {
      showPackResult(
        `已生成：${res.path}（${humanBytes(res.size)}，${res.files} 个文件）—— 直接发给别人即可`,
        'is-ok',
        res.path
      );
    }
    ctx.setStatus(`打包完成：${res.path}`);
  } catch (err) {
    if (state === st) showPackResult(`打包失败：${err.message}`, 'is-error', '');
    ctx.setStatus(`打包失败：${err.message}`);
  } finally {
    if (state === st) st.busy = false;
    ctx.hideProgress();
    if (state === st) refreshRunState();
  }
}

async function runUnpack() {
  const st = state;
  const { ctx, els } = st;
  if (!st.unpackImage) return;
  st.busy = true;
  refreshRunState();
  ctx.showProgress('正在解包…', 0);
  try {
    const res = await ctx.hideUnpack({
      imagePath: st.unpackImage.path,
      password: els.passwordX.value.trim()
    });
    if (!res || !res.ok) throw new Error((res && res.message) || '解包失败');
    st.unpackResult = res;
    if (state === st) {
      renderUnpackFiles(res);
      showUnpackResult(`解出 ${res.files.length} 个文件 → ${res.dir}`, 'is-ok');
    }
    ctx.setStatus(`解包完成：${res.files.length} 个文件 → ${res.dir}`);
  } catch (err) {
    if (state === st) {
      clearUnpackResult();
      showUnpackResult(`解包失败：${err.message}`, 'is-error');
    }
    ctx.setStatus(`解包失败：${err.message}`);
  } finally {
    if (state === st) st.busy = false;
    ctx.hideProgress();
    if (state === st) refreshRunState();
  }
}

// —— 模式切换 ——

function setMode(mode) {
  state.mode = mode;
  const { els } = state;
  els.modePack.classList.toggle('is-active', mode === 'pack');
  els.modeUnpack.classList.toggle('is-active', mode === 'unpack');
  els.packPane.hidden = mode !== 'pack';
  els.unpackPane.hidden = mode !== 'unpack';
  state.ctx.setStatus(mode === 'pack'
    ? '文件藏图：选一张表图 + 要藏的文件，点「开始打包」'
    : '文件藏图：选一张图夹图，点「开始解包」把文件取出来');
}

// —— 拖拽：图片当表图 / 其它当里图；解包页拖图即待解包 ——

async function onDrop(event) {
  event.preventDefault();
  const { ctx, els } = state;
  els.root.classList.remove('is-over');
  const files = Array.from(event.dataTransfer ? event.dataTransfer.files : []);
  const paths = [];
  for (const file of files) {
    const p = ctx.getPathForFile(file);
    if (p) paths.push(p);
  }
  if (paths.length === 0) return;

  if (state.mode === 'unpack') {
    await setUnpackImage(paths[0]);
    ctx.setStatus('已放入图夹图片，点「开始解包」即可');
    return;
  }

  const images = paths.filter(isImagePath);
  const rest = paths.filter((p) => !isImagePath(p));
  if (!state.cover && images.length > 0) {
    await setCover(images[0]);
    await addItems([...images.slice(1), ...rest]);
  } else {
    await addItems(paths);
  }
}

// —— 生命周期 ——

export function mount(container, ctx) {
  state = {
    ctx,
    container,
    els: {},
    mode: 'pack',
    cover: null,
    items: [],
    unpackImage: null,
    unpackResult: null,
    packed: null,
    productPath: '',
    busy: false,
    packedText: '',
    packedClass: '',
    unpackText: '',
    unpackClass: ''
  };

  container.innerHTML = MARKUP;
  const $ = (id) => container.querySelector(`#${id}`);
  state.els = {
    root: $('ihRoot'),
    modePack: $('ihModePack'),
    modeUnpack: $('ihModeUnpack'),
    packPane: $('ihPackPane'),
    unpackPane: $('ihUnpackPane'),
    randomCover: $('ihRandomCover'),
    pickCover: $('ihPickCover'),
    clearCover: $('ihClearCover'),
    coverBox: $('ihCoverBox'),
    coverThumb: $('ihCoverThumb'),
    coverMeta: $('ihCoverMeta'),
    addFiles: $('ihAddFiles'),
    items: $('ihItems'),
    itemsEmpty: $('ihItemsEmpty'),
    sizeNote: $('ihSizeNote'),
    algoFast: $('ihAlgoFast'),
    algoPro: $('ihAlgoPro'),
    algoNote: $('ihAlgoNote'),
    password: $('ihPassword'),
    passwordHint: $('ihPasswordHint'),
    watermark: $('ihWatermark'),
    runPack: $('ihRunPack'),
    clearPack: $('ihClearPack'),
    packResult: $('ihPackResult'),
    openProduct: $('ihOpenProduct'),
    pickImage: $('ihPickImage'),
    clearImage: $('ihClearImage'),
    imageBox: $('ihImageBox'),
    imageThumb: $('ihImageThumb'),
    imageMeta: $('ihImageMeta'),
    passwordX: $('ihPasswordX'),
    runUnpack: $('ihRunUnpack'),
    clearUnpack: $('ihClearUnpack'),
    unpackResult: $('ihUnpackResult'),
    unpackCard: $('ihUnpackCard'),
    unpackTitle: $('ihUnpackTitle'),
    unpackDir: $('ihUnpackDir'),
    unpackList: $('ihUnpackList'),
    unpackEmpty: $('ihUnpackEmpty'),
    openFolder: $('ihOpenFolder')
  };

  const els = state.els;
  on(els.modePack, 'click', () => setMode('pack'));
  on(els.modeUnpack, 'click', () => setMode('unpack'));

  on(els.randomCover, 'click', async () => {
    try {
      await setRandomCover();
    } catch (err) {
      ctx.setStatus(`生成随机表图失败：${err.message}`);
    }
  });
  on(els.pickCover, 'click', async () => {
    const paths = await ctx.openHideCover();
    if (paths && paths.length) await setCover(paths[0]);
  });
  on(els.clearCover, 'click', () => { clearCover(); ctx.setStatus('已清空表图'); });
  on(els.addFiles, 'click', async () => {
    const paths = await ctx.openHideFiles();
    if (paths && paths.length) await addItems(paths);
  });
  on(els.algoFast, 'change', refreshRunState);
  on(els.algoPro, 'change', refreshRunState);
  on(els.watermark, 'input', refreshRunState);
  on(els.runPack, 'click', runPack);
  on(els.openProduct, 'click', async () => {
    if (state.productPath) await ctx.hideReveal(state.productPath);
  });
  on(els.clearPack, 'click', () => {
    clearCover();
    state.items = [];
    renderItems();
    els.password.value = '';
    els.watermark.value = '';
    els.algoFast.checked = true;
    showPackResult('', '', '');
    refreshRunState();
    ctx.setStatus('已清空打包区');
  });

  on(els.pickImage, 'click', async () => {
    const paths = await ctx.openHideImage();
    if (paths && paths.length) await setUnpackImage(paths[0]);
  });
  on(els.clearImage, 'click', () => { clearUnpackImage(); ctx.setStatus('已清空图夹图片'); });
  on(els.runUnpack, 'click', runUnpack);
  on(els.openFolder, 'click', async () => {
    if (state.unpackResult) await ctx.hideReveal(state.unpackResult.dir);
  });
  on(els.clearUnpack, 'click', () => {
    clearUnpackImage();
    clearUnpackResult();
    els.passwordX.value = '';
    showUnpackResult('', '');
    refreshRunState();
    ctx.setStatus('已清空解包区');
  });

  for (const el of [els.root]) {
    on(el, 'dragover', (e) => {
      e.preventDefault();
      els.root.classList.add('is-over');
    });
    on(el, 'dragleave', (e) => {
      if (e.target === els.root) els.root.classList.remove('is-over');
    });
    on(el, 'drop', onDrop);
  }

  state.unsubscribe = window.desktop.imghideOnProgress((data) => {
    if (!state || !state.busy) return;
    state.ctx.showProgress(data.text || '处理中…', data.percent || 0);
  });

  renderItems();
  setMode('pack');
  refreshRunState();
}

export function unmount() {
  if (!state) return;
  if (state.unsubscribe) state.unsubscribe();
  revokeThumb('cover');
  revokeThumb('unpack');
  offAll();
  state = null;
}

export function activate() {
  if (!state) return;
  state.ctx.setStatus(state.mode === 'pack'
    ? '文件藏图：选一张表图 + 要藏的文件，点「开始打包」'
    : '文件藏图：选一张图夹图，点「开始解包」把文件取出来');
}

export function deactivate() {
  // 本工具没有挂在 window/document 上的全局交互，离开时无需让位
}