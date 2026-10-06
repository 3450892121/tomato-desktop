// 工具：批量重命名 —— 界面与交互
// 分层：本文件只做界面与流程编排；规则计算 / 排序 / 冲突处理在 core/plan.js（纯逻辑）；
//       真正的落盘改名走 ctx.renameBatch（主进程 fs:rename-batch：两阶段改名；默认不覆盖，
//       界面选「替换已存在文件」时才带 overwrite 标记，走「备份 → 覆盖 → 删备份」）。
// 提醒：本工具直接改用户的原文件名（不像其它工具生成新文件），界面上必须把这点讲清楚。
import {
  RENAME_MODES, SORT_MODES, CONFLICT_MODES, buildRenamePlan, sortItems, formatDateTime, formatDate, formatSize
} from './core/plan.js';

const MARKUP = `
  <div class="bren-tool">
    <section class="card bren-controls">
      <div class="control-row">
        <span class="control-label">改名方式</span>
        <select class="select bren-w-mode" id="brenMode"></select>
        <span class="control-hint" id="brenModeHint"></span>
      </div>

      <div class="control-row">
        <span class="control-label">排序方式</span>
        <select class="select bren-w-mode" id="brenSort"></select>
        <span class="control-label">命名冲突</span>
        <select class="select bren-w-mode" id="brenConflict"></select>
        <span class="control-hint" id="brenConflictHint"></span>
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

      <div class="bren-warn" id="brenOverwriteWarn" hidden>⚠ 你选了「替换已存在文件」：目标名字已被占用时，会<b>直接删掉那个旧文件</b>再改名（同样不进回收站、不能撤销）。</div>
      <div class="bren-warn">⚠ 本工具会<b>直接改掉原文件名</b>（不产生副本、不进回收站、改完不能在本工具里撤销）。请先看清下面的「原名 ｜ 修改日期 → 新名」预览，点「开始重命名」后还会再确认一次。</div>
    </section>

    <main class="card bren-files">
      <div class="bren-drop" id="brenDrop">
        <button class="btn btn-primary btn-lg" data-add="1" id="brenAddBtn">添加文件</button>
        <div class="bren-drop-hint">也可以把文件或整个文件夹拖进窗口；支持多选</div>
      </div>
      <div class="bren-list-wrap" id="brenListWrap" hidden>
        <div class="bren-list-head">
          <span class="bren-old-name">原文件名</span>
          <span class="bren-time">修改日期</span>
          <span class="bren-arrow">→</span>
          <span class="bren-new-name">新文件名</span>
          <span class="bren-spacer"></span>
          <span class="control-hint" id="brenCount"></span>
          <button class="btn btn-ghost" data-add="1" id="brenAddMore" type="button">＋ 继续添加</button>
        </div>
        <ul class="bren-list" id="brenList"></ul>
      </div>
    </main>

    <footer class="bren-actions">
      <button class="btn btn-primary" id="brenRunBtn" data-run="1">开始重命名</button>
      <button class="btn btn-plain" id="brenExportBtn" data-export="1" disabled>导出日志</button>
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

  els.conflictHint.textContent = {
    skip: '目标名已存在就不动它（日志记为「跳过」）',
    overwrite: '目标名已存在就删掉旧文件再改名',
    auto: '目标名已存在就在后面加 (1)、(2)…'
  }[els.conflict.value] || '';
  els.overwriteWarn.hidden = els.conflict.value !== 'overwrite';
}

/** 当前排序方式 / 命名冲突策略（读界面控件） */
function readOptions() {
  const { els } = state;
  return {
    sortOrder: SORT_MODES.some((m) => m.value === els.sort.value) ? els.sort.value : 'none',
    conflictMode: CONFLICT_MODES.some((m) => m.value === els.conflict.value) ? els.conflict.value : 'skip'
  };
}

/**
 * 列表要显示、也要按这个顺序编号的文件数组（排序只影响显示与序号，不改 state.files 里用户的添加顺序）。
 * 注意：任何用到下标的逻辑（预览、删除、编号）都必须走这个函数，别直接用 state.files。
 */
function sortedFiles() {
  const { sortOrder } = readOptions();
  return sortItems(state.files, sortOrder);
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
  const files = sortedFiles(); // 排序决定显示顺序与编号顺序
  els.listWrap.hidden = files.length === 0;
  els.drop.hidden = files.length > 0;

  const { conflictMode } = readOptions();
  const plan = buildRenamePlan({
    items: files.map((f) => ({ path: f.path, name: f.name, baseName: f.baseName, ext: f.ext, mtimeMs: f.mtimeMs })),
    rule: readRule(),
    existingPaths: state.existingPaths,
    conflictMode
  });
  state.plan = plan;

  els.count.textContent = files.length
    ? `共 ${files.length} 个 ｜ 将改名 ${plan.okCount} 个${plan.conflictCount ? ` ｜ 不改 ${plan.conflictCount} 个` : ''}`
    : '';
  els.list.innerHTML = '';

  plan.previews.forEach((p, i) => {
    const file = files[i];
    const li = document.createElement('li');
    li.className = p.ok ? 'bren-item' : (p.status === 'error' ? 'bren-item is-bad' : 'bren-item is-skip');
    li.dataset.from = p.from;
    li.dataset.fromName = p.fromName;
    li.dataset.toName = p.toName;
    li.dataset.index = String(i);
    li.dataset.mtime = String((file && file.mtimeMs) || 0);
    li.dataset.status = p.ok ? (p.overwrite ? 'overwrite' : (p.autoRenamed ? 'auto' : 'ok')) : p.status;

    const oldName = document.createElement('span');
    oldName.className = 'bren-old-name';
    oldName.textContent = p.fromName;
    oldName.title = p.from;
    li.appendChild(oldName);

    const time = document.createElement('span');
    time.className = 'bren-time';
    const shown = formatDateTime(file && file.mtimeMs);
    time.textContent = shown || '—';
    if (!shown) time.title = '取不到修改时间（按日期编号时会用当前时间）';
    li.appendChild(time);

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
    meta.textContent = formatSize(file ? file.size : 0);
    li.appendChild(meta);

    if (p.overwrite || p.autoRenamed) {
      const tag = document.createElement('span');
      tag.className = 'bren-tag';
      tag.textContent = p.overwrite ? '覆盖' : '自动编号';
      tag.title = p.overwrite ? '目标文件已存在，将按「替换」处理' : '目标文件已存在，已自动加编号避开';
      li.appendChild(tag);
    }
    if (!p.ok) {
      const reason = document.createElement('span');
      reason.className = 'bren-reason';
      reason.textContent = p.status === 'error' ? p.reason : `不改：${p.reason}`;
      li.appendChild(reason);
    }
    if (file && file.lastError) {
      const last = document.createElement('span');
      last.className = 'bren-reason';
      last.textContent = `上次失败：${file.lastError}`;
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
      // 列表可能已被排序，不能拿下标删——按路径找
      const at = state.files.findIndex((f) => f.path === p.from);
      if (at >= 0) state.files.splice(at, 1);
      renderPreview();
    });
    actions.appendChild(del);
    li.appendChild(actions);

    els.list.appendChild(li);
  });

  // 没有可改名的文件就不让点（空列表 / 全被跳过 / 规则全非法）；只有部分跳过时让用户自己决定
  els.runBtn.disabled = state.busy || files.length === 0 || plan.okCount === 0;
  els.notice.hidden = files.length === 0 || plan.conflictCount === 0;
  if (!els.notice.hidden) {
    const modeText = conflictMode === 'skip' ? '按「跳过不改」处理，这些文件会保持原样' : '将按你选的冲突处理方式执行';
    els.notice.textContent = plan.okCount === 0
      ? `没有可改名的文件：${plan.conflictCount} 个文件都有问题（橙/红行已写明原因），请调整规则、换个冲突处理方式或移出这些文件。`
      : `有 ${plan.conflictCount} 个文件这次不会改名（${modeText}）：其余 ${plan.okCount} 个会正常改名。`;
  }
  return plan;
}

// —— 添加文件 ——

async function addFromPaths(paths) {
  // await 期间本页可能被 LRU 回收（unmount 把 state 置空）：全程用局部 st，界面收尾前再核对。
  // 加文件夹时逐个文件都要 await，这段窗口并不短。
  const st = state;
  const failures = [];
  let added = 0;

  const pushOne = async (p) => {
    const info = await st.ctx.pathInfo(p);
    if (info.isDirectory) return;
    if (st.files.some((f) => f.path === p)) return; // 重复添加同一个文件，忽略
    st.files.push({
      path: p,
      name: info.name,
      baseName: info.baseName,
      dir: info.dir,
      ext: info.ext,
      size: info.size,
      // 修改时间（fs:path-info 给的 mtimeMs）：排序与「按日期」规则都用它；取不到时为 0
      mtimeMs: Number(info.mtimeMs) || 0
    });
    added += 1;
  };

  for (const p of paths) {
    try {
      const info = await st.ctx.pathInfo(p);
      if (info.isDirectory) {
        const list = await st.ctx.listFiles(p, null); // null = 不按扩展名过滤，全部文件
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

  // 下面全是界面收尾：refreshExisting() 开头就会读 state.files，所以必须先确认本页还在
  if (state !== st) return;
  await refreshExisting();
  if (state !== st) return;
  renderPreview();
  if (added > 0) {
    st.ctx.setStatus(`已添加 ${added} 个文件${failures.length ? `，${failures.length} 项失败` : ''}`);
  } else {
    st.ctx.setStatus(failures.length ? `添加失败：${failures[0]}` : '没有可添加的文件');
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

/**
 * 执行前的确认弹窗（防止误点）：写清会改多少、跳过多少、覆盖多少，并列出前几条「原名 → 新名」。
 * @param {object} plan buildRenamePlan 的结果
 * @returns {Promise<boolean>} true = 用户确认执行
 */
function confirmRun(plan) {
  const files = sortedFiles();
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const card = document.createElement('div');
    card.className = 'modal-card bren-confirm';

    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = '确认重命名？';

    const body = document.createElement('div');
    body.className = 'modal-body';

    const summary = document.createElement('div');
    summary.className = 'bren-confirm-summary';
    summary.textContent = `共 ${files.length} 个文件：将改名 ${plan.okCount} 个`
      + (plan.conflictCount ? `，不改 ${plan.conflictCount} 个` : '')
      + (plan.overwriteCount ? `，其中覆盖已存在文件 ${plan.overwriteCount} 个` : '')
      + (plan.autoCount ? `，其中自动加编号 ${plan.autoCount} 个` : '');
    body.appendChild(summary);

    const box = document.createElement('div');
    box.className = 'bren-confirm-list';
    plan.previews.slice(0, 10).forEach((p) => {
      const row = document.createElement('div');
      row.className = 'bren-confirm-row';
      const from = document.createElement('span');
      from.className = 'bren-confirm-from';
      from.textContent = p.fromName;
      from.title = p.from;
      const arrow = document.createElement('span');
      arrow.className = 'bren-confirm-arrow';
      arrow.textContent = p.ok ? '→' : '×';
      const to = document.createElement('span');
      to.className = `bren-confirm-to${p.ok ? '' : ' is-skip'}`;
      to.textContent = p.ok ? p.toName : `不改（${p.reason}）`;
      row.append(from, arrow, to);
      box.appendChild(row);
    });
    if (plan.previews.length > 10) {
      const more = document.createElement('div');
      more.className = 'bren-confirm-more';
      more.textContent = `……还有 ${plan.previews.length - 10} 条，预览列表里可看全部`;
      box.appendChild(more);
    }
    body.appendChild(box);

    const warn = document.createElement('div');
    warn.className = 'bren-confirm-warn';
    warn.textContent = plan.overwriteCount
      ? `注意：有 ${plan.overwriteCount} 个目标文件已存在，会按「替换」处理——旧文件被删除，且本工具无法撤销。`
      : '改名会直接落到磁盘上（不进回收站），本工具里不能撤销。';
    body.appendChild(warn);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-plain';
    cancel.type = 'button';
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = 'btn btn-primary';
    ok.type = 'button';
    ok.dataset.confirm = '1';
    ok.textContent = `确认改名 ${plan.okCount} 个`;
    actions.append(cancel, ok);
    card.append(title, body, actions);
    backdrop.appendChild(card);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      if (state) { state.modal = null; state.modalClose = null; }
      backdrop.remove();
      resolve(value);
    };
    const onKey = (event) => { if (event.key === 'Escape') finish(false); };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) finish(false); });
    document.addEventListener('keydown', onKey);

    document.body.appendChild(backdrop);
    if (state) { state.modal = backdrop; state.modalClose = () => finish(false); }
  });
}

async function run() {
  if (state.busy) return;
  const plan = renderPreview(); // 执行前再算一次，保证和眼睛看到的一致
  const files = sortedFiles();
  if (files.length === 0) {
    state.ctx.setStatus('请先添加要改名的文件');
    return;
  }
  if (plan.okCount === 0) {
    state.ctx.setStatus(`有 ${plan.conflictCount} 个文件都没法改名，请先按行上的说明调整规则或换个冲突处理方式`);
    return;
  }

  const confirmed = await confirmRun(plan);
  if (!state) return; // 工具页在确认期间被回收：什么都不做
  if (!confirmed) {
    state.ctx.setStatus('已取消，没有改动任何文件');
    return;
  }

  state.busy = true;
  state.els.runBtn.disabled = true;
  state.els.runBtn.textContent = '正在重命名…';
  state.els.result.textContent = '';
  state.ctx.showProgress(`正在重命名 ${plan.renames.length} 个文件…`, 30);
  await nextFrame();

  // 逐条日志（执行后回填结果）：成功 / 跳过 / 失败 + 说明
  const logRows = plan.previews.map((p, i) => ({
    index: i + 1,
    from: p.from,
    fromName: p.fromName,
    mtimeMs: (files[i] && files[i].mtimeMs) || 0,
    toName: p.ok ? p.toName : p.fromName,
    status: p.ok ? '成功' : (p.status === 'error' ? '失败' : '跳过'),
    note: p.reason || (p.overwrite ? '目标已存在，按设置覆盖' : (p.autoRenamed ? '目标已存在，已自动加编号' : ''))
  }));
  const logByFrom = new Map(logRows.map((r) => [r.from, r]));

  // 任务归属队列：重命名在主进程里是一次原子操作（两阶段执行，链式改名/互换名不会互相踩），
  // 所以整批算一个任务；这样切走工具页（或被回收）时改名照常完成，任务中心也能看到。
  let res = { ok: false, done: 0, failed: [], overwritten: 0 };
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
        res = { ok: false, done: 0, failed: [{ from: '', to: '', message: err.message }], overwritten: 0 };
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

  // 回填日志：失败的那几条写清原因（成功的保持「成功」，跳过的保持「跳过」）
  const failedFrom = new Set(res.failed.map((f) => f.from));
  const failedReason = new Map(res.failed.map((f) => [f.from, f.message]));
  for (const f of res.failed) {
    const row = logByFrom.get(f.from);
    if (row) { row.status = '失败'; row.note = f.message; }
  }

  // 成功的从列表里拿掉（活已经干完）；失败的与被跳过的留下并写明原因
  const skippedFrom = new Set(plan.conflicts.map((p) => p.from));
  const remain = [];
  for (const f of state.files) {
    if (failedFrom.has(f.path)) {
      f.lastError = failedReason.get(f.path) || '改名失败';
      remain.push(f);
    } else if (skippedFrom.has(f.path)) {
      remain.push(f);
    }
  }
  const failedCount = res.failed.length;
  const skippedCount = plan.conflicts.length;
  state.files = remain;
  state.busy = false;
  state.els.runBtn.disabled = false;
  state.els.runBtn.textContent = '开始重命名';

  await refreshExisting();
  if (!state) return; // 上面这个 await 期间本页也可能被回收，后面整段界面收尾都得跳过
  renderPreview();

  // 统计 + 日志导出入口（导出按钮在第一次执行后才可用）
  state.lastLog = logRows;
  state.els.exportBtn.disabled = false;
  const parts = [`成功 ${res.done} 个`];
  if (skippedCount) parts.push(`跳过 ${skippedCount} 个`);
  if (failedCount) parts.push(`失败 ${failedCount} 个`);
  const extras = [];
  if (res.overwritten) extras.push(`覆盖 ${res.overwritten} 个`);
  if (plan.autoCount) extras.push(`自动编号 ${plan.autoCount} 个`);
  state.runStats = parts.join(' ｜ ') + (extras.length ? `（${extras.join('，')}）` : '');
  state.els.result.textContent = state.runStats + (failedCount ? '（失败的文件已留在列表里）' : '');

  const reasons = [...new Set(res.failed.map((f) => f.message))].slice(0, 3).join('；');
  state.ctx.setStatus('重命名完成：' + parts.join('，')
    + (failedCount ? `（${reasons}）` : ''));
  if (res.failed.length > 0) console.warn('[batch-rename] 失败明细', res.failed);
}

// —— 日志导出 ——

/** CSV 单元格转义：含逗号/引号/换行的字段加引号并把内部引号翻倍 */
function csvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 导出重命名日志（CSV，UTF-8 带 BOM，Excel 打开不乱码）。
 * 存到第一个源文件所在目录（重名自动加序号，绝不覆盖已有文件）。
 */
async function exportLog() {
  const rows = state.lastLog;
  if (!rows || rows.length === 0) {
    state.ctx.setStatus('还没有可导出的日志：先执行一次重命名');
    return;
  }
  const header = ['序号', '原文件名', '原路径', '修改时间', '新文件名', '结果', '说明'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.index,
      r.fromName,
      r.from,
      r.mtimeMs ? formatDate(new Date(r.mtimeMs), 'YYYY-MM-DD HH:mm:ss') : '',
      r.toName,
      r.status,
      r.note
    ].map(csvCell).join(','));
  }
  const bytes = new TextEncoder().encode(`\uFEFF${lines.join('\r\n')}\r\n`);
  const stamp = formatDate(new Date(), 'YYYYMMDD-HHmmss');
  try {
    const target = await state.ctx.saveNextTo({
      sourcePath: rows[0].from,
      baseName: `重命名日志-${stamp}`,
      ext: 'csv',
      bytes
    });
    if (!state) return;
    state.els.result.textContent = `${state.runStats || ''} ｜ 日志：${target}`;
    state.ctx.setStatus(`日志已导出：${target}`);
  } catch (err) {
    if (!state) return;
    state.ctx.setStatus(`日志导出失败：${err.message}`);
  }
}

// —— 生命周期 ——

export function mount(container, ctx) {
  state = {
    ctx,
    els: null,
    listeners: [],
    files: [],
    existingPaths: [],
    plan: null,
    busy: false,
    container,
    lastLog: null,     // 最近一次执行的逐条日志（导出用）
    runStats: '',      // 最近一次执行的统计文案
    modal: null,       // 确认弹窗的遮罩（卸载时要清掉）
    modalClose: null
  };
  container.innerHTML = MARKUP;

  const els = {
    root: container.querySelector('.bren-tool'),
    mode: container.querySelector('#brenMode'),
    modeHint: container.querySelector('#brenModeHint'),
    sort: container.querySelector('#brenSort'),
    conflict: container.querySelector('#brenConflict'),
    conflictHint: container.querySelector('#brenConflictHint'),
    overwriteWarn: container.querySelector('#brenOverwriteWarn'),
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
    exportBtn: container.querySelector('#brenExportBtn'),
    clearBtn: container.querySelector('#brenClearBtn'),
    result: container.querySelector('#brenResult'),
    notice: container.querySelector('#brenNotice')
  };
  state.els = els;

  fillSelect(els.mode, RENAME_MODES);
  fillSelect(els.sort, SORT_MODES);
  fillSelect(els.conflict, CONFLICT_MODES);

  on(els.addBtn, 'click', openDialog);
  on(els.addMore, 'click', openDialog);
  on(els.runBtn, 'click', run);
  on(els.exportBtn, 'click', exportLog);
  on(els.clearBtn, 'click', () => {
    state.files = [];
    state.plan = null;
    els.result.textContent = '';
    renderPreview();
    state.ctx.setStatus('已清空列表（磁盘上的文件没有任何改动）');
  });
  // 预览随参数变化实时刷新（排序 / 冲突处理一改，顺序与「跳过 / 覆盖 / 自动编号」立刻重算）
  for (const el of [els.mode, els.sort, els.conflict, els.seqStart, els.seqDigits, els.seqPrefix, els.seqKeep,
    els.find, els.replace, els.regex, els.affixPrefix, els.affixSuffix, els.datePattern]) {
    on(el, 'change', () => { refreshParamState(); renderPreview(); });
    on(el, 'input', () => { refreshParamState(); renderPreview(); });
  }
  on(els.root, 'dragover', (e) => e.preventDefault());
  on(els.root, 'drop', onDrop);

  refreshParamState();
  renderPreview();
  ctx.setStatus('批量重命名：添加文件 → 选排序与规则 → 看预览 → 开始重命名（直接改原文件名，不会产生副本）');
}

export function unmount() {
  if (!state) return;
  for (const [el, type, handler] of state.listeners) {
    el.removeEventListener(type, handler);
  }
  // 确认弹窗挂在 document.body 上（不属于工具容器），卸载时必须自己清掉
  if (state.modalClose) {
    try { state.modalClose(); } catch { /* 弹窗可能已关闭，忽略 */ }
  }
  if (state.modal && state.modal.parentNode) state.modal.remove();
  try {
    state.ctx.hideProgress();
  } catch { /* 外壳可能已销毁，忽略 */ }
  state = null;
}
