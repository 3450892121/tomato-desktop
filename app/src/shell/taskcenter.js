// 任务中心（右侧侧滑抽屉）：在一个地方看到所有工具的任务，并支持取消 / 重试 / 清空。
//
// 关键约定：任务中心由框架（shell.js）持有，面板开关**不影响任务执行**——
// 任务归属队列（shared/taskqueue.js），不归属工具页，也不归属这个面板。
// 这里只做展示与操作转发，不持有任何任务状态。

const STATUS_TEXT = {
  queued: '排队中',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消'
};

const ACTIVE_STATUS = new Set(['queued', 'running']);

/** 文件名（取路径最后一段；同时给出结果文案） */
function baseName(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 耗时文案：跑着的按「现在 - 开始」，结束的按「结束 - 开始」 */
function formatElapsed(task, now) {
  if (!task.startedAt) return '';
  const end = task.endedAt || now;
  const sec = (end - task.startedAt) / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m} 分 ${s} 秒`;
}

/** 结果文案：成功给产物名，失败给原因，取消给固定文案 */
function resultText(task) {
  if (task.status === 'failed') return task.error || '失败（原因未知）';
  if (task.status === 'canceled') return '已取消';
  if (task.status === 'done') {
    const paths = (task.output && task.output.paths) || [];
    if (paths.length === 0) return '已完成';
    const first = baseName(paths[0]);
    return paths.length > 1 ? `→ ${first} 等 ${paths.length} 个` : `→ ${first}`;
  }
  return task.stepText || '';
}

/**
 * 创建任务中心面板。
 * @param {{queue:object, onOpenChange?:(open:boolean)=>void}} options
 */
export function createTaskCenter({ queue, onOpenChange } = {}) {
  const root = document.createElement('aside');
  root.className = 'task-center';
  root.id = 'taskCenter';
  root.hidden = true;
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('aria-label', '任务中心');
  root.innerHTML = `
    <header class="tc-head">
      <span class="tc-title">任务中心</span>
      <button class="tc-close" id="tcClose" type="button" title="关闭（任务会继续在后台跑）">×</button>
    </header>
    <div class="tc-summary" id="tcSummary"></div>
    <div class="tc-overall">
      <div class="tc-overall-track"><div class="tc-overall-fill" id="tcProgressFill"></div></div>
      <div class="tc-overall-text" id="tcProgressText">0%</div>
    </div>
    <div class="tc-actions">
      <button class="btn btn-ghost" id="tcCancelAll" type="button">全部取消</button>
      <button class="btn btn-ghost" id="tcClearFinished" type="button">清空已完成</button>
    </div>
    <div class="tc-body" id="tcBody"></div>
  `;

  const mask = document.createElement('div');
  mask.className = 'task-center-mask';
  mask.id = 'taskCenterMask';
  mask.hidden = true;

  document.body.appendChild(mask);
  document.body.appendChild(root);

  const els = {
    summary: root.querySelector('#tcSummary'),
    progressFill: root.querySelector('#tcProgressFill'),
    progressText: root.querySelector('#tcProgressText'),
    cancelAll: root.querySelector('#tcCancelAll'),
    clearFinished: root.querySelector('#tcClearFinished'),
    body: root.querySelector('#tcBody'),
    close: root.querySelector('#tcClose')
  };

  let open = false;
  let dirty = true;

  function taskRow(task, now) {
    const row = document.createElement('div');
    row.className = `tc-task is-${task.status}`;
    row.dataset.taskId = task.id;
    row.dataset.status = task.status;

    const head = document.createElement('div');
    head.className = 'tc-task-head';
    const tool = document.createElement('span');
    tool.className = 'tc-task-tool';
    tool.textContent = task.toolName || task.toolId || '任务';
    const name = document.createElement('span');
    name.className = 'tc-task-name';
    name.textContent = task.label || '（未命名）';
    name.title = (task.input && task.input.paths && task.input.paths[0]) || task.label || '';
    const status = document.createElement('span');
    status.className = `tc-task-status is-${task.status}`;
    status.textContent = STATUS_TEXT[task.status] || task.status;
    head.append(tool, name, status);
    row.appendChild(head);

    const bar = document.createElement('div');
    bar.className = 'tc-bar';
    const fill = document.createElement('div');
    fill.className = 'tc-bar-fill';
    fill.style.width = `${task.status === 'done' ? 100 : task.progress || 0}%`;
    bar.appendChild(fill);
    row.appendChild(bar);

    const meta = document.createElement('div');
    meta.className = 'tc-task-meta';
    const left = document.createElement('span');
    left.className = 'tc-task-note';
    const parts = [];
    if (task.status === 'running') parts.push(`${task.progress || 0}%`);
    const elapsed = formatElapsed(task, now);
    if (elapsed) parts.push(`耗时 ${elapsed}`);
    if (task.retryCount > 0) parts.push(`第 ${task.retryCount + 1} 次尝试`);
    left.textContent = parts.join(' ｜ ');
    meta.appendChild(left);

    const result = document.createElement('span');
    result.className = `tc-task-result is-${task.status}`;
    result.textContent = resultText(task);
    result.title = result.textContent;
    meta.appendChild(result);

    if (ACTIVE_STATUS.has(task.status)) {
      const btn = document.createElement('button');
      btn.className = 'tc-task-btn';
      btn.type = 'button';
      btn.textContent = '取消';
      btn.dataset.act = 'cancel';
      btn.addEventListener('click', () => queue.cancel(task.id));
      meta.appendChild(btn);
    } else if (task.status === 'failed' || task.status === 'canceled') {
      const btn = document.createElement('button');
      btn.className = 'tc-task-btn';
      btn.type = 'button';
      btn.textContent = '重试';
      btn.dataset.act = 'retry';
      btn.addEventListener('click', () => queue.retry(task.id));
      meta.appendChild(btn);
    }

    row.appendChild(meta);
    return row;
  }

  function section(title, tasks, now, emptyText) {
    const wrap = document.createElement('section');
    wrap.className = 'tc-section';
    const h = document.createElement('div');
    h.className = 'tc-section-title';
    h.textContent = `${title}（${tasks.length}）`;
    wrap.appendChild(h);
    if (tasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tc-empty-line';
      empty.textContent = emptyText;
      wrap.appendChild(empty);
    } else {
      for (const t of tasks) wrap.appendChild(taskRow(t, now));
    }
    return wrap;
  }

  function render() {
    if (!open) {
      dirty = true;
      return;
    }
    dirty = false;
    const now = Date.now();
    const s = queue.summary();
    const all = queue.list();
    const active = all.filter((t) => ACTIVE_STATUS.has(t.status));
    const recent = queue.recentFinished(10);

    els.summary.textContent = `${s.running} 个进行中 ｜ ${s.queued} 个排队 ｜ 完成 ${s.done} ｜ 失败 ${s.failed}`;
    const percent = s.total ? s.percent : all.length ? s.percent : 0;
    els.progressFill.style.width = `${percent}%`;
    els.progressText.textContent = all.length ? `${percent}%` : '暂无任务';
    els.cancelAll.disabled = active.length === 0;
    els.clearFinished.disabled = recent.length === 0;

    els.body.innerHTML = '';
    if (all.length === 0 && recent.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tc-empty';
      empty.innerHTML = '<div class="tc-empty-icon">🗒️</div>'
        + '<div class="tc-empty-title">还没有任务</div>'
        + '<div class="tc-empty-hint">在任意工具里点「开始」后，处理进度会出现在这里；切走工具页也不会中断。</div>';
      els.body.appendChild(empty);
      return;
    }
    els.body.appendChild(section('进行中 / 排队', active, now, '当前没有进行中的任务'));
    els.body.appendChild(section('最近完成', recent, now, '还没有已结束的任务'));
  }

  function setOpen(next) {
    if (open === next) return;
    open = next;
    root.hidden = !open;
    mask.hidden = !open;
    root.setAttribute('aria-hidden', open ? 'false' : 'true');
    root.classList.toggle('is-open', open);
    mask.classList.toggle('is-open', open);
    if (open) render();
    if (onOpenChange) onOpenChange(open);
  }

  els.close.addEventListener('click', () => setOpen(false));
  mask.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) setOpen(false);
  });

  els.cancelAll.addEventListener('click', () => {
    queue.cancelAll();
    render();
  });
  els.clearFinished.addEventListener('click', () => {
    queue.clearFinished();
    render();
  });

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    isOpen: () => open,
    /** 队列变化时由 shell 调用；面板关闭时只标记为脏，打开时再渲染一次（省开销） */
    refresh: () => {
      if (open) render();
      else dirty = true;
    },
    isDirty: () => dirty
  };
}