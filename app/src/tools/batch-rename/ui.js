// 工具：批量重命名 —— 界面与交互
// 分层：本文件只做界面与流程编排；规则计算 / 冲突检出在 core/plan.js（纯逻辑）；
//       真正的落盘改名走 ctx.renameBatch（主进程 fs:rename-batch：两阶段改名、绝不覆盖已存在文件）。
// 提醒：本工具直接改用户的原文件名（不像其它工具生成新文件），界面上必须把这点讲清楚。
import { RENAME_MODES, buildRenamePlan, formatSize } from './core/plan.js';

const MARKUP = `
  <div class="bren-tool">
    <section class="card bren-controls">
      <div class="control-row">
        <span class="control-label">改名方式</span>
        <select class="select bren-w-mode" id="brenMode"></select>
        <span class="control-hint" id="brenModeHint"></span>
      </div>

      <div class="bren-params">
        <div class="bren-param" data-mode="seq">
          <div class="control-row">
            <span class="control-label">起始序号</span>
            <input class="input bren-w-num" id="brenSeqStart" type="number" value="1" />
            <span class="control-label">位数</span>
            <input class="input bren-w-num" id="brenSeqDigits" type="number" min="1" max="10" value="3" />
            <span class="control-label">前缀</span>
            <input class="input" id="brenSeqPrefix" type="text" placeholder="可留空" />
          </div>
          <label class="field-check bren-check">
            <input type="checkbox" id="brenSeqKeep" /> 保留原文件名（在原名后面接序号）
          </label>
          <div class="field-hint" id="brenSeqHint"></div>
        </div>

        <div class="bren-param" data-mode="replace" hidden>
          <div class="control-row">
            <span class="control-label">查找</span>
            <input class="input" id="brenFind" type="text" placeholder="要被替换掉的文字" />
            <span class="control-label">替换为</span>
            <input class="input" id="brenReplace" type="text" placeholder="可留空（等于删掉）" />
          </div>
          <label class="field-check bren-check">
            <input type="checkbox" id="brenRegex" /> 把「查找」当成正则表达式（进阶，仅认基础写法）
          </label>
        </div>

        <div class="bren-param" data-mode="affix" hidden>
          <div class="control-row">
            <span class="control-label">加前缀</span>
            <input class="input" id="brenAffixPrefix" type="text" placeholder="可留空" />
            <span class="control-label">加后缀</span>
            <input class="input" id="brenAffixSuffix" type="text" placeholder="加在扩展名前面" />
          </div>
        </div>

        <div class="bren-param" data-mode="date" hidden>
          <div class="control-row">
            <span class="control-label">日期模板</span>
            <input class="input" id="brenDatePattern" type="text" value="YYYY-MM-DD" />
          </div>
          <div class="field-hint">可用：YYYY 年、MM 月、DD 日、HH 时、mm 分、ss 秒。按文件修改时间取名；系统取不到修改时间时用当前时间。</div>
        </div>
      </div>

      <div class="bren-warn">⚠ 本工具会<b>直接改掉原文件名</b>（不产生副本、不进回收站、改完不能在本工具里撤销）。请先看清下面的「原名 → 新名」预览，确认没问题再点「开始重命名」。</div>
    </section>

    <main class="card bren-files">
      <div class="bren-drop" id="brenDrop">
        <button class="btn btn-primary btn-lg" data-add="1" id="brenAddBtn">添加文件</button>
        <div class="bren-drop-hint">也可以把文件或整个文件夹拖进窗口；支持多选</div>
      </div>
      <div class="bren-list-wrap" id="brenListWrap" hidden>
        <div class="bren-list-head">
          <span>原名 → 新名</span>
          <span class="bren-spacer"></span>
          <span class="control-hint" id="brenCount"></span>
          <button class="btn btn-ghost" data-add="1" id="brenAddMore" type="button">＋ 继续添加</button>
        </div>
        <ul class="bren-list" id="brenList"></ul>
      </div>
    </main>

    <footer class="bren-actions">
      <button class="btn btn-primary" id="brenRunBtn" data-run="1">开始重命名</button>
      <button class="btn btn-plain" id="brenClearBtn" data-clear="1">清空</button>
      <div class="bren-result" id="brenResult"></div>
    </footer>
    <div class="bren-notice" id="brenNotice" hidden></div>
  </div>
`;

let state = null;

function on(el, type, handler) {
  el.addEventListener(type, handler);
  state.listeners.push([el, type, handler]);
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function fillSelect(sel, options) {
  sel.innerHTML = '';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
}

// —— 规则参数 ——

/** 当前界面上的规则（交给 core/plan.js 计算） */
function readRule() {
  const { els } = state;
  const mode = els.mode.value;
  if (mode === 'replace') {
    return { mode, find: els.find.value, replace: els.replace.value, useRegex: els.regex.checked };
  }
  if (mode === 'affix') {
    return { mode, prefix: els.affixPrefix.value, suffix: els.affixSuffix.value };
  }
  if (mode === 'date') {
    return { mode, pattern: els.datePattern.value };
  }
  const start = parseInt(els.seqStart.value, 10);
  const digits = parseInt(els.seqDigits.value, 10);
  return {
    mode: 'seq',
    prefix: els.seqPrefix.value,
    start: Number.isFinite(start) ? start : 1,
    digits: Number.isFinite(digits) ? digits : 3,
    keepName: els.seqKeep.checked
  };
}

/** 切换方式后：只显示当前方式的参数区，并给一句人话解释 */
function refreshParamState() {
  const { els } = state;
  const mode = els.mode.value;
  for (const box of els.params) box.hidden = box.dataset.mode !== mode;
  els.modeHint.textContent = {
    seq: '把整批文件编成 001、002、003…',
    replace: '把文件名里的一段文字换成另一段',
    affix: '在每个名字前后加固定文字',
    date: '用文件的日期当名字'
  }[mode] || '';

  const r = readRule();
  if (mode === 'seq') {
    const sample = r.keepName ? `假期${r.prefix}${String(r.start).padStart(Math.max(1, Math.min(10, r.digits)), '0')}` : `${r.prefix}${String(r.start).padStart(Math.max(1, Math.min(10, r.digits)), '0')}`;
    els.seqHint.textContent = `例：${sample}.png`;
  }
}

// —— 文件与预览 ——

/**
 * 目标目录里「已经存在」的文件清单（用来检出「目标文件已存在」）。
 * 走 ctx.listFiles(dir, [])：扩展名留空 = 列出该目录全部文件。
 */
async function refreshExisting() {
  const dirs = [...new Set(state.files.map((f) => f.dir).filter(Boolean))];
  const all = [];
  for (const dir of dirs) {
    try {
      const list = await state.ctx.listFiles(dir, []);
      for (const p of list) all.push(p);
    } catch { /* 读不到该目录就先按「没有已存在文件」处理，落盘时主进程仍会兜底拒绝 */ }
  }
  if (!state) return;
  state.existingPaths = all;
}

function renderPreview() {
  const { els } = state;
  const files = state.files;
  els.listWrap.hidden = files.length === 0;
  els.drop.hidden = files.length > 0;

  const plan = buildRenamePlan({
    items: files.map((f) => ({ path: f.path, name: f.name, baseName: f.baseName, ext: f.ext, mtimeMs: f.mtimeMs })),
    rule: readRule(),
    existingPaths: state.existingPaths
  });
  state.plan = plan;

  els.count.textContent = files.length ? `共 ${files.length} 个，可改 ${plan.okCount} 个` : '';
  els.list.innerHTML = '';

  plan.previews.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = p.ok ? 'bren-item' : 'bren-item is-bad';
    li.dataset.from = p.from;
    li.dataset.fromName = p.fromName;
    li.dataset.toName = p.toName;
    li.dataset.index = String(i);

    const oldName = document.createElement('span');
    oldName.className = 'bren-old-name';
    oldName.textContent = p.fromName;
    oldName.title = p.from;
    li.appendChild(oldName);

    const arrow = document.createElement('span');
    arrow.className = 'bren-arrow';
    arrow.textContent = '→';
    li.appendChild(arrow);

    const newName = document.createElement('span');
    newName.className = 'bren-new-name';
    newName.textContent = p.toName;
    li.appendChild(newName);

    const meta = document.createElement('span');
    meta.className = 'bren-item-meta';
    meta.textContent = formatSize(files[i] ? files[i].size : 0);
    li.appendChild(meta);

    if (!p.ok) {
      const reason = document.createElement('span');
      reason.className = 'bren-reason';
      reason.textContent = p.reason;
      li.appendChild(reason);
    }
    if (files[i] && files[i].lastError) {
      const last = document.createElement('span');
      last.className = 'bren-reason';
      last.textContent = `上次失败：${files[i].lastError}`;
      li.appendChild(last);
    }

    const actions = document.createElement('span');
    actions.className = 'bren-item-actions';
    const del = document.createElement('button');
    del.className = 'bren-icon-btn';
    del.type = 'button';
    del.textContent = '×';
    del.title = '从列表里移除（不会动磁盘上的文件）';
    del.addEventListener('click', () => {
      state.files.splice(i, 1);
      renderPreview();
    });
    actions.appendChild(del);
    li.appendChild(actions);

    els.list.appendChild(li);
  });

  // 有冲突就不让执行：改名是直接动原文件的操作，宁可让用户先把问题解决掉
  const hasConflict = plan.conflictCount > 0;
  els.runBtn.disabled = hasConflict || files.length === 0 || state.busy;
  els.notice.hidden = !hasConflict;
  if (hasConflict) {
    els.notice.textContent = `有 ${plan.conflictCount} 个文件改不了（红色行已写明原因）：请调整规则或把有问题的文件移出列表，再执行。`;
  }
  return plan;
}

// —— 添加文件 ——

async function addFromPaths(paths) {
  const failures = [];
  let added = 0;

  const pushOne = async (p) => {
    const info = await state.ctx.pathInfo(p);
    if (info.isDirectory) return;
    if (state.files.some((f) => f.path === p)) return; // 重复添加同一个文件，忽略
    state.files.push({
      path: p,
      name: info.name,
      baseName: info.baseName,
      dir: info.dir,
      ext: info.ext,
      size: info.size,
      // ctx.pathInfo 不返回修改时间；拿不到就留空，core 里会退回当前时间
      mtimeMs: Number(info.mtimeMs) || 0
    });
    added += 1;
  };

  for (const p of paths) {
    try {
      const info = await state.ctx.pathInfo(p);
      if (info.isDirectory) {
        const list = await state.ctx.listFiles(p, null); // null = 不按扩展名过滤，全部文件
        if (list.length === 0) failures.push(`${info.name}：文件夹是空的`);
        for (const one of list) {
          try {
            await pushOne(one);
          } catch (err) {
            failures.push(`${String(one).split(/[\\/]/).pop()}：${err.message}`);
          }
        }
      } else {
        await pushOne(p);
      }
    } catch (err) {
      failures.push(`${String(p).split(/[\\/]/).pop()}：${err.message}`);
    }
  }

  await refreshExisting();
  renderPreview();
  if (added > 0) {
    state.ctx.setStatus(`已添加 ${added} 个文件${failures.length ? `，${failures.length} 项失败` : ''}`);
  } else {
    state.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的文件');
  }
}

async function openDialog() {
  const paths = await state.ctx.openBatchRename();
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

// —— 执行 ——

async function run() {
  if (state.busy) return;
  const plan = renderPreview(); // 执行前再算一次，保证和眼睛看到的一致
  if (state.files.length === 0) {
    state.ctx.setStatus('请先添加要改名的文件');
    return;
  }
  if (plan.conflictCount > 0) {
    state.ctx.setStatus(`有 ${plan.conflictCount} 个文件改不了，请先按红色提示调整规则或移出这些文件`);
    return;
  }

  state.busy = true;
  state.els.runBtn.disabled = true;
  state.els.runBtn.textContent = '正在重命名…';
  state.els.result.textContent = '';
  state.ctx.showProgress(`正在重命名 ${plan.renames.length} 个文件…`, 30);
  await nextFrame();

  // 任务归属队列：重命名在主进程里是一次原子操作（两阶段执行，链式改名/互换名不会互相踩），
  // 所以整批算一个任务；这样切走工具页（或被回收）时改名照常完成，任务中心也能看到。
  let res = { ok: false, done: 0, failed: [] };
  const ctx = state.ctx;
  const taskId = ctx.tasks.enqueue({
    toolId: 'batch-rename',
    toolName: '批量重命名',
    label: `批量重命名 ${plan.renames.length} 个文件`,
    lane: 'cpu',
    inputPaths: plan.renames.map((r) => r.from),
    run: async ({ report }) => {
      report({ percent: 30, text: `正在重命名 ${plan.renames.length} 个文件…` });
      try {
        res = await ctx.renameBatch(plan.renames);
      } catch (err) {
        res = { ok: false, done: 0, failed: [{ from: '', to: '', message: err.message }] };
      }
      report({ percent: 100 });
      const reasons = [...new Set(res.failed.map((f) => f.message))].slice(0, 3).join('；');
      return res.failed.length === 0
        ? { ok: true, outputPaths: plan.renames.map((r) => r.to) }
        : { ok: false, error: `${res.failed.length} 个失败：${reasons}` };
    }
  });
  await ctx.tasks.waitFor(taskId);

  if (!state) return; // 工具页已被回收：改名已经完成，这里只跳过界面收尾
  state.ctx.hideProgress();

  // 成功的从列表里拿掉（活已经干完），失败的留下并写明原因
  const failedFrom = new Set(res.failed.map((f) => f.from));
  const failedReason = new Map(res.failed.map((f) => [f.from, f.message]));
  const remain = [];
  for (const f of state.files) {
    if (failedFrom.has(f.path)) {
      f.lastError = failedReason.get(f.path) || '改名失败';
      remain.push(f);
    }
  }
  const failedCount = res.failed.length;
  state.files = remain;
  state.busy = false;
  state.els.runBtn.disabled = false;
  state.els.runBtn.textContent = '开始重命名';

  await refreshExisting();
  renderPreview();

  const reasons = [...new Set(res.failed.map((f) => f.message))].slice(0, 3).join('；');
  state.els.result.textContent = `成功 ${res.done} 个`
    + (failedCount ? ` ｜ 失败 ${failedCount} 个：${reasons}` : '')
    + (failedCount ? '（失败的文件已留在列表里）' : '');
  state.ctx.setStatus(failedCount
    ? `重命名完成：成功 ${res.done} 个，失败 ${failedCount} 个（${reasons}）`
    : `重命名完成：成功 ${res.done} 个`);
  if (res.failed.length > 0) console.warn('[batch-rename] 失败明细', res.failed);
}

// —— 生命周期 ——

export function mount(container, ctx) {
  state = { ctx, els: null, listeners: [], files: [], existingPaths: [], plan: null, busy: false, container };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.bren-tool'),
    mode: container.querySelector('#brenMode'),
    modeHint: container.querySelector('#brenModeHint'),
    params: [...container.querySelectorAll('.bren-param')],
    seqStart: container.querySelector('#brenSeqStart'),
    seqDigits: container.querySelector('#brenSeqDigits'),
    seqPrefix: container.querySelector('#brenSeqPrefix'),
    seqKeep: container.querySelector('#brenSeqKeep'),
    seqHint: container.querySelector('#brenSeqHint'),
    find: container.querySelector('#brenFind'),
    replace: container.querySelector('#brenReplace'),
    regex: container.querySelector('#brenRegex'),
    affixPrefix: container.querySelector('#brenAffixPrefix'),
    affixSuffix: container.querySelector('#brenAffixSuffix'),
    datePattern: container.querySelector('#brenDatePattern'),
    drop: container.querySelector('#brenDrop'),
    addBtn: container.querySelector('#brenAddBtn'),
    addMore: container.querySelector('#brenAddMore'),
    listWrap: container.querySelector('#brenListWrap'),
    list: container.querySelector('#brenList'),
    count: container.querySelector('#brenCount'),
    runBtn: container.querySelector('#brenRunBtn'),
    clearBtn: container.querySelector('#brenClearBtn'),
    result: container.querySelector('#brenResult'),
    notice: container.querySelector('#brenNotice')
  };
  state.els = els;

  fillSelect(els.mode, RENAME_MODES);

  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', run);
  on(els.clearBtn, 'click', () => {
    state.files = [];
    state.plan = null;
    els.result.textContent = '';
    renderPreview();
    state.ctx.setStatus('已清空列表（磁盘上的文件没有任何改动）');
  });
  // 预览随参数变化实时刷新
  for (const el of [els.mode, els.seqStart, els.seqDigits, els.seqPrefix, els.seqKeep,
    els.find, els.replace, els.regex, els.affixPrefix, els.affixSuffix, els.datePattern]) {
    on(el, 'change', () => { refreshParamState(); renderPreview(); });
    on(el, 'input', () => { refreshParamState(); renderPreview(); });
  }
  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);

  refreshParamState();
  renderPreview();
  ctx.setStatus('批量重命名：添加文件 → 选规则 → 看预览 → 开始重命名（直接改原文件名，不会产生副本）');
}

export function unmount() {
  if (!state) return;
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  try {
    state.ctx.hideProgress();
  } catch { /* 外壳可能已销毁，忽略 */ }
  state = null;
}
