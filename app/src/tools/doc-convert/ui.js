// 工具：文档格式转换 —— 界面与交互
// 分层：本文件只做界面与流程编排；「哪些文件能转、转成什么」在 core/plan.mjs，
//       转换复用主进程 libreoffice:convert（随包 LibreOffice，与「PDF 转格式」同一套机制）。
// 队列走 cpu 通道（串行）：LibreOffice 转换共用同一 profile，并发会撞 profile 锁。
import {
  DOC_EXTS, TARGETS, targetOf, planOne, formatMeta, formatSize, baseNameOf
} from './core/plan.mjs';

const MARKUP = `
  <div class="dc-tool">
    <section class="card dc-controls">
      <div class="dc-params">
        <div class="dc-param">
          <label class="control-label" for="dcTarget">转换目标:</label>
          <select class="select" id="dcTarget"></select>
        </div>
      </div>
      <div class="dc-note" id="dcLoNote">正在检测 LibreOffice…</div>
    </section>

    <main class="card dc-files" id="dcFiles">
      <div class="dc-drop" id="dcDrop">
        <button class="btn btn-primary btn-lg" data-add="1" id="dcAddBtn">添加文档</button>
        <div class="dc-drop-hint">也可以把文档直接拖进窗口；支持多选</div>
        <div class="dc-drop-hint">老格式的 Word / Excel / PPT（doc / xls / ppt / pps / rtf）都行——包括教务系统导出的「假 .xls」（Excel 2003 XML），转完手机就能打开</div>
      </div>
      <div class="dc-list-wrap" id="dcListWrap" hidden>
        <div class="dc-list-head">
          <span id="dcListTitle">文档</span>
          <span class="dc-spacer"></span>
          <span id="dcListCount"></span>
          <button class="btn btn-ghost" data-add="1" id="dcAddMore" type="button">＋ 继续添加</button>
        </div>
        <ul class="dc-list" id="dcList"></ul>
      </div>
    </main>

    <footer class="dc-actions">
      <button class="btn btn-primary dc-run" data-run="1" id="dcRunBtn">开始转换</button>
      <button class="btn btn-plain" data-clear="1" id="dcClearBtn">清空</button>
      <div class="dc-result" id="dcResult"></div>
    </footer>
  </div>
`;

let state = null;

function on(el, type, handler) {
  el.addEventListener(type, handler);
  state.listeners.push([el, type, handler]);
}

// —— LibreOffice 加装包状态 ——

function renderLoNote() {
  const note = state.els.loNote;
  if (!state.lo) {
    note.className = 'dc-note';
    note.textContent = '正在检测 LibreOffice…';
    return;
  }
  if (state.lo.found) {
    const where = state.lo.where === 'addon' ? '加装包' : '系统安装';
    note.className = 'dc-note is-ok';
    note.textContent = `✓ 已检测到 LibreOffice（${where}）——老文档转新格式可用`;
  } else {
    note.className = 'dc-note is-warn';
    note.textContent = '未检测到 LibreOffice：把加装包解压到软件目录的 addons/libreoffice 后重开本工具即可。';
  }
}

async function refreshLo() {
  try {
    state.lo = await state.ctx.libreofficeStatus();
  } catch {
    state.lo = { found: false };
  }
  if (!state) return;
  renderLoNote();
  updateRunButton();
}

// —— 文件列表 ——

function renderList() {
  const { els } = state;
  const files = state.files;
  els.listWrap.hidden = files.length === 0;
  els.drop.hidden = files.length > 0;
  els.listCount.textContent = files.length ? `共 ${files.length} 个` : '';
  els.list.innerHTML = '';

  files.forEach((f, index) => {
    const li = document.createElement('li');
    li.className = 'dc-item';

    const main = document.createElement('div');
    main.className = 'dc-item-main';

    const name = document.createElement('div');
    name.className = 'dc-item-name';
    name.textContent = f.name;
    name.title = f.path;
    main.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'dc-item-meta';
    meta.textContent = f.result ? f.result.text : f.meta;
    if (f.result && !f.result.ok) meta.classList.add('is-error');
    main.appendChild(meta);

    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'dc-item-actions';
    const del = document.createElement('button');
    del.className = 'dc-icon-btn';
    del.type = 'button';
    del.textContent = '×';
    del.title = '移除';
    del.disabled = state.busy;
    del.addEventListener('click', () => {
      if (state.busy) return;
      files.splice(index, 1);
      renderList();
    });
    actions.appendChild(del);
    li.appendChild(actions);

    els.list.appendChild(li);
  });
  updateRunButton();
}

// —— 添加文件 ——

/** 加入列表；返回失败原因（成功返回空串） */
async function addOne(filePath) {
  if (state.files.some((f) => f.path === filePath)) return '已在列表中';
  const info = await state.ctx.pathInfo(filePath);
  const ext = (info.ext || '').toLowerCase();
  if (!DOC_EXTS.includes(ext)) return '不是支持的文档格式';
  state.files.push({
    path: filePath,
    name: info.name,
    baseName: info.baseName,
    ext,
    meta: formatMeta(ext),
    result: null
  });
  return '';
}

async function addFromPaths(paths) {
  const failures = [];
  let added = 0;
  for (const p of paths) {
    try {
      const info = await state.ctx.pathInfo(p);
      if (info.isDirectory) {
        const list = await state.ctx.listFiles(p, DOC_EXTS);
        if (list.length === 0) { failures.push(`${info.name}：文件夹里没有支持的文档`); continue; }
        for (const sub of list) {
          const reason = await addOne(sub);
          if (reason) failures.push(`${baseNameOf(sub)}：${reason}`);
          else added += 1;
        }
      } else {
        const reason = await addOne(p);
        if (reason) failures.push(`${info.name}：${reason}`);
        else added += 1;
      }
    } catch (err) {
      failures.push(`${baseNameOf(p)}：${err.message}`);
    }
  }

  renderList();
  if (added > 0) {
    state.ctx.setStatus(`已添加 ${added} 个文件${failures.length ? `，${failures.length} 项跳过` : ''}`);
  } else {
    state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的文档');
  }
  if (failures.length > 1) console.warn('[doc-convert] 部分文件未添加：\n' + failures.join('\n'));
}

async function openDialog() {
  const paths = await state.ctx.openDocConvert();
  if (paths && paths.length > 0) await addFromPaths(paths);
}

async function onDrop(event) {
  event.preventDefault();
  if (state.busy) return;
  const dropped = Array.from(event.dataTransfer ? event.dataTransfer.files : []);
  const paths = [];
  for (const file of dropped) {
    const p = state.ctx.getPathForFile(file);
    if (p) paths.push(p);
  }
  if (paths.length > 0) await addFromPaths(paths);
}

// —— 运行 ——

function updateRunButton() {
  const { els } = state;
  els.runBtn.textContent = state.busy ? '取消' : '开始转换';
  const loOk = !!(state.lo && state.lo.found);
  els.runBtn.disabled = !state.busy && !loOk;
}

async function run() {
  const { els } = state;
  const files = state.files;
  const total = files.length;
  const ctx = state.ctx;
  const target = els.targetSel.value;
  const outputDir = ctx.settings.getSettings().outputDir || undefined;

  els.result.textContent = '';
  for (const f of files) f.result = null;
  renderList();

  const jobs = files.map((f, index) => ({
    label: f.name,
    inputPaths: [f.path],
    outputDir,
    run: async ({ report, isCancelled }) => {
      const step = `转换 ${index + 1}/${total}：${f.name}`;
      report({ percent: (index / total) * 100, text: step });
      if (state && state.ctx.isActive()) state.ctx.showProgress(step, (index / total) * 100);

      const plan = planOne(f.ext, { target });
      if (!plan.ok) {
        f.result = { ok: false, text: `✗ ${plan.reason}` };
        if (state) renderList();
        return { ok: false, error: plan.reason };
      }

      // LibreOffice 转换没有取消通道：点「取消」也等当前文件转完，只是不再保存产物
      // （这样 profile 锁一定会随进程退出释放，不会卡住队列里后面的任务）
      let res;
      try {
        res = await ctx.libreofficeConvert({ inputPath: f.path, target: plan.target });
      } catch (err) {
        res = { ok: false, message: err.message };
      }

      if (isCancelled()) {
        f.result = { ok: false, text: '已取消' };
        if (state) renderList();
        return { canceled: true };
      }
      if (!res || !res.ok) {
        const message = (res && res.message) || '转换失败';
        f.result = { ok: false, text: `✗ ${message}` };
        if (state) renderList();
        return { ok: false, error: message };
      }

      const outPath = await ctx.saveNextTo({
        sourcePath: f.path,
        targetDir: outputDir,
        baseName: f.baseName,
        ext: plan.ext,
        bytes: res.bytes
      });
      f.result = {
        ok: true,
        text: `→ ${baseNameOf(outPath)}（${formatSize(res.bytes.byteLength)}，${(res.ms / 1000).toFixed(1)} 秒）`
      };
      if (state) renderList();
      report({ percent: ((index + 1) / total) * 100, text: f.result.text });
      return { ok: true, outputPaths: [outPath], outputDir };
    }
  }));

  const ids = jobs.map((job) => ctx.tasks.enqueue({
    toolId: 'doc-convert',
    toolName: '文档格式转换',
    lane: 'cpu', // 串行：共用 LibreOffice profile，并发会撞锁
    ...job
  }));
  state.taskIds = ids;
  const settled = await Promise.all(ids.map((id) => ctx.tasks.waitFor(id)));

  if (!state) return; // 工具页已被回收：任务照跑完了，这里只跳过界面收尾
  state.taskIds = [];
  ctx.hideProgress();
  const done = settled.filter((t) => t && t.status === 'done').length;
  const failed = settled.filter((t) => t && t.status === 'failed').length;
  const canceledCount = settled.filter((t) => t && t.status === 'canceled').length;
  const failedTask = settled.find((t) => t && t.status === 'failed');
  const lastError = (failedTask && failedTask.error) || '';
  const doneTask = [...settled].reverse().find((t) => t && t.status === 'done' && t.output.paths.length);
  const lastPath = doneTask ? doneTask.output.paths[0] : '';

  if (canceledCount > 0) {
    ctx.setStatus(`已取消：成功 ${done} 个，失败 ${failed} 个`);
  } else {
    ctx.setStatus(`转换完成：成功 ${done} 个${failed ? `，失败 ${failed} 个（${lastError}）` : ''}`);
  }
  if (lastPath) els.result.textContent = `输出：${lastPath}`;
  else if (failed) els.result.textContent = `失败原因：${lastError}`;
}

async function onRunClick() {
  // await 期间本页可能被 LRU 回收（unmount 把 state 置空）：全程用局部 st，界面收尾前再核对
  const st = state;
  if (st.busy) {
    st.cancelRequested = true;
    for (const id of st.taskIds) st.ctx.tasks.cancel(id);
    st.ctx.setStatus('正在取消…');
    return;
  }
  if (!st.lo || !st.lo.found) {
    st.ctx.setStatus('未检测到 LibreOffice：把加装包解压到软件目录的 addons/libreoffice 后重开本工具');
    return;
  }
  if (st.files.length === 0) {
    st.ctx.setStatus('请先添加文档');
    return;
  }

  st.busy = true;
  st.cancelRequested = false;
  st.taskIds = [];
  updateRunButton();
  try {
    await run();
  } catch (err) {
    st.ctx.hideProgress();
    st.ctx.setStatus(`处理失败：${err.message}`);
    console.error('[doc-convert] 处理失败', err);
  } finally {
    if (state === st) {
      st.busy = false;
      st.cancelRequested = false;
      st.taskIds = [];
      updateRunButton();
    }
  }
}

function clearAll() {
  if (state.busy) return;
  state.files = [];
  state.els.result.textContent = '';
  renderList();
  state.ctx.setStatus('已清空列表');
}

// —— 生命周期 ——

export function mount(container, ctx) {
  state = {
    container,
    ctx,
    els: null,
    listeners: [],
    files: [],
    busy: false,
    cancelRequested: false,
    taskIds: [],
    lo: null
  };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.dc-tool'),
    targetSel: container.querySelector('#dcTarget'),
    loNote: container.querySelector('#dcLoNote'),
    drop: container.querySelector('#dcDrop'),
    addBtn: container.querySelector('#dcAddBtn'),
    listWrap: container.querySelector('#dcListWrap'),
    list: container.querySelector('#dcList'),
    listCount: container.querySelector('#dcListCount'),
    addMore: container.querySelector('#dcAddMore'),
    runBtn: container.querySelector('#dcRunBtn'),
    clearBtn: container.querySelector('#dcClearBtn'),
    result: container.querySelector('#dcResult')
  };
  state.els = els;

  els.targetSel.innerHTML = '';
  for (const t of TARGETS) {
    const opt = document.createElement('option');
    opt.value = t.value;
    opt.textContent = t.label;
    els.targetSel.appendChild(opt);
  }
  els.targetSel.value = 'auto';

  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', onRunClick);
  on(els.clearBtn, 'click', clearAll);
  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);

  renderLoNote();
  renderList();
  updateRunButton();
  ctx.setStatus('文档格式转换：添加老文档 → 点「开始转换」，产物与原文件同目录（重名自动加序号）');
  ctx.setInfo({});

  refreshLo();
}

export function unmount() {
  if (!state) return;
  // 硬契约：任务归属队列，不归属工具页 —— 切走（含 LRU 回收）**不取消**在跑的任务。
  // 这里只解绑事件监听，队列里的任务与产物不受影响。
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  state = null;
}
