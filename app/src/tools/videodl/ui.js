// 工具：视频下载 —— 界面与交互（见 spec/modules/videodl.md）
// 设计要点：
//  - 下载任务跑在主进程（引擎见 core/），切走工具页/被 LRU 回收都不影响；本页只是它的一个视图
//  - 列表数据由主进程推送（videodl:changed），「任务中心」里也能看到同一条任务（通道 io）
//  - 引擎自更新是「点一下」的事：检查 → 下载 → 校验 → 生效，全程有文字反馈，失败不静默
import { escapeHtml } from '../../shared/htmlescape.js';

const MARKS = { running: '下载中', done: '已完成', error: '失败', cancelled: '已取消' };

const MARKUP = `
  <div class="vdl-tool">
    <section class="card vdl-input-card">
      <h3 class="vdl-subtitle">粘贴视频链接</h3>
      <div class="vdl-link-row">
        <input class="vdl-input" data-role="url" type="text" spellcheck="false"
               placeholder="支持抖音 / 小红书 / B站 / YouTube / 央视频，或 MP4·M3U8 直链" />
        <button class="btn btn-primary" data-action="start">开始下载</button>
      </div>
      <div class="vdl-dir-row">
        <span class="vdl-dir-label">保存到：</span>
        <span class="vdl-dir" data-role="dir" title="">正在读取…</span>
        <button class="btn btn-ghost btn-sm" data-action="change-dir">更改</button>
      </div>
      <p class="vdl-hint" data-role="hint">粘贴链接后按回车或点「开始下载」。请只下载自己有权使用的内容。</p>
    </section>

    <section class="card vdl-list-card">
      <div class="vdl-list-head">
        <h3 class="vdl-subtitle">下载记录</h3>
        <button class="btn btn-ghost btn-sm" data-action="clear">清空记录</button>
      </div>
      <div class="vdl-list" data-role="list">
        <p class="vdl-empty" data-role="empty">还没有下载记录。粘贴链接开始第一条吧。</p>
      </div>
    </section>

    <section class="card vdl-engine-card">
      <div class="vdl-engine-head">
        <h3 class="vdl-subtitle">下载引擎</h3>
        <span class="vdl-engine-badge" data-role="engine-badge">检测中…</span>
      </div>
      <div class="vdl-engine-line" data-role="engine-line">正在检测…</div>
      <div class="vdl-engine-actions">
        <button class="btn btn-ghost btn-sm" data-action="check-engine">检查更新</button>
        <button class="btn btn-primary btn-sm" data-action="update-engine" hidden>更新引擎</button>
        <label class="vdl-auto">
          <input type="checkbox" data-role="autocheck" /> 每周自动检查更新
        </label>
      </div>
      <div class="vdl-engine-hint" data-role="engine-hint"></div>
    </section>
  </div>
`;

let state = null;

export function mount(container, ctx) {
  container.innerHTML = MARKUP;
  const els = {
    url: container.querySelector('[data-role="url"]'),
    hint: container.querySelector('[data-role="hint"]'),
    dir: container.querySelector('[data-role="dir"]'),
    start: container.querySelector('[data-action="start"]'),
    changeDir: container.querySelector('[data-action="change-dir"]'),
    clear: container.querySelector('[data-action="clear"]'),
    list: container.querySelector('[data-role="list"]'),
    engineBadge: container.querySelector('[data-role="engine-badge"]'),
    engineLine: container.querySelector('[data-role="engine-line"]'),
    engineHint: container.querySelector('[data-role="engine-hint"]'),
    checkEngine: container.querySelector('[data-action="check-engine"]'),
    updateEngine: container.querySelector('[data-action="update-engine"]'),
    autocheck: container.querySelector('[data-role="autocheck"]')
  };
  state = { ctx, els, dir: '', jobs: [], status: null, unsub: [], engineBusy: false };

  els.start.addEventListener('click', () => startDownload());
  els.url.addEventListener('keydown', (event) => { if (event.key === 'Enter') startDownload(); });
  els.changeDir.addEventListener('click', () => changeDir());
  els.clear.addEventListener('click', () => clearHistory());
  els.checkEngine.addEventListener('click', () => checkEngine());
  els.updateEngine.addEventListener('click', () => updateEngine());
  els.autocheck.addEventListener('change', () => {
    if (!state) return;
    state.ctx.settings.updateSettings({ videodlAutoCheck: els.autocheck.checked });
  });

  // 订阅主进程推送：任务列表变化 + 引擎更新下载进度（unmount 时退订）
  state.unsub.push(window.desktop.videodlOnChanged((list) => {
    if (!state) return;
    state.jobs = Array.isArray(list) ? list : [];
    renderList();
  }));
  state.unsub.push(window.desktop.videodlOnEngineProgress(({ received }) => {
    if (!state) return;
    state.els.engineHint.textContent = `正在下载引擎… 已收到 ${(received / 1024 / 1024).toFixed(1)} MB（校验通过后才会启用）`;
  }));

  ctx.setInfo({});
  refreshStatus();
  refreshList();
}

export function activate() {
  if (!state) return;
  refreshStatus({ silent: true });
  refreshList();
}

export function deactivate() {
  // 下载不随页面切换暂停：这里没有要停的东西
}

export function unmount() {
  if (!state) return;
  for (const off of state.unsub) { try { off(); } catch { /* 已退订 */ } }
  state = null;
}

// —— 内部实现 ——

async function refreshList() {
  try {
    const list = await window.desktop.videodlList();
    if (!state) return;
    state.jobs = Array.isArray(list) ? list : [];
    renderList();
  } catch { /* 主进程不可用时保持现状 */ }
}

async function refreshStatus({ silent } = {}) {
  const st = await window.desktop.videodlStatus().catch(() => null);
  if (!state || !st) return;
  state.status = st;
  const settings = state.ctx.settings.getSettings();
  state.dir = settings.videodlDir || st.defaultDir || '';
  state.els.dir.textContent = state.dir;
  state.els.dir.title = state.dir;
  state.els.autocheck.checked = st.autoCheck !== false;
  renderEngine(st);
  if (!silent) {
    state.ctx.setStatus(st.engine
      ? `下载引擎已就绪${st.engine.version ? `（v${st.engine.version}）` : ''}${st.engine.source === 'updated' ? ' · 已更新版' : ''}`
      : '未检测到下载引擎：请把 yt-dlp 加装包放到 addons/ytdlp，或点「检查更新」重试');
  }
}

function renderEngine(st) {
  const { els } = state;
  if (!st.engine) {
    els.engineBadge.textContent = '未就绪';
    els.engineBadge.className = 'vdl-engine-badge is-bad';
    els.engineLine.textContent = '未检测到下载引擎（addons/ytdlp/yt-dlp.exe）。'
      + '可以把加装包放回软件目录后点「检查更新」，或点「更新引擎」重新下载一份。';
  } else {
    const source = st.engine.source === 'updated' ? '已更新版' : '随包版';
    els.engineBadge.textContent = st.available ? `有新版 v${st.available.version}` : '已就绪';
    els.engineBadge.className = `vdl-engine-badge${st.available ? ' is-new' : ' is-ok'}`;
    const lines = [`引擎：yt-dlp ${st.engine.version}（${source}）`];
    if (!st.ffmpeg.found) lines.push('未检测到 ffmpeg 加装包：合并音视频与成品校验需要它，请把 addons/ffmpeg 放回。');
    const proxyText = st.proxy ? `已检测到代理 ${st.proxy}` : '未检测到代理（国内下载 YouTube 通常需要先启动 Clash 等代理）';
    lines.push(proxyText);
    if (st.lastCheckAt) lines.push(`上次检查：${new Date(st.lastCheckAt).toLocaleString()}`);
    if (st.lastError) lines.push(`上次检查失败：${st.lastError}`);
    if (st.engine.warning) lines.push(st.engine.warning);
    els.engineLine.innerHTML = lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('');
  }
  els.updateEngine.hidden = !(st.available || !st.engine);
  els.updateEngine.textContent = st.engine ? '更新引擎' : '下载引擎';
}

function jobTitle(job) {
  if (job.name && job.name !== job.url) return job.name;
  try { return new URL(job.url).hostname + new URL(job.url).pathname; } catch { return job.url; }
}

function renderList() {
  const { els } = state;
  const jobs = state.jobs || [];
  if (!jobs.length) {
    els.list.innerHTML = '<p class="vdl-empty">还没有下载记录。粘贴链接开始第一条吧。</p>';
    return;
  }
  els.list.innerHTML = jobs.map((job) => {
    const pct = job.status === 'running' ? Math.max(0, Math.min(100, Math.round(job.pct || 0))) : (job.status === 'done' ? 100 : Math.round(job.pct || 0));
    const meta = [];
    if (job.status === 'running') {
      meta.push(`${pct}%`);
      if (job.speed) meta.push(job.speed);
      if (job.eta) meta.push(`剩余 ${job.eta}`);
    }
    if (job.note) meta.push(job.note);
    if (job.status === 'error' && job.err) meta.push(job.err);
    const actions = [];
    if (job.status === 'running') {
      actions.push(`<button class="btn btn-ghost btn-sm" data-action="cancel" data-id="${job.id}">取消</button>`);
    } else {
      actions.push(`<button class="btn btn-ghost btn-sm" data-action="retry" data-id="${job.id}">重试</button>`);
      if (job.status === 'done' && job.file) {
        actions.push(`<button class="btn btn-ghost btn-sm" data-action="reveal" data-id="${job.id}" data-file="${escapeHtml(job.file)}">在文件夹中显示</button>`);
      }
    }
    return `
      <div class="vdl-item is-${escapeHtml(job.status)}" data-job="${job.id}">
        <div class="vdl-item-main">
          <div class="vdl-item-title" title="${escapeHtml(job.url)}">${escapeHtml(jobTitle(job))}</div>
          <div class="vdl-item-meta">
            <span class="vdl-state vdl-state-${escapeHtml(job.status)}">${MARKS[job.status] || escapeHtml(job.status)}</span>
            <span class="vdl-phase">${escapeHtml(job.phase || '')}</span>
            ${meta.length ? `<span class="vdl-meta-extra">${escapeHtml(meta.join(' ｜ '))}</span>` : ''}
          </div>
          <div class="vdl-bar"><div class="vdl-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="vdl-item-actions">${actions.join('')}</div>
      </div>`;
  }).join('');

  for (const btn of els.list.querySelectorAll('[data-action]')) {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      if (btn.dataset.action === 'cancel') cancelJob(id);
      else if (btn.dataset.action === 'retry') retryJob(id);
      else if (btn.dataset.action === 'reveal') window.desktop.videodlReveal(btn.getAttribute('data-file'));
    });
  }
}

/** 等一条任务到终态（页面被回收也照跑：只依赖 window.desktop，不依赖 state） */
function waitForTerminal(jobId, report) {
  return new Promise((resolve) => {
    let off = null;
    let settled = false;
    const finish = (job) => {
      if (settled) return;
      settled = true;
      if (off) { try { off(); } catch { /* 已退订 */ } }
      resolve(job);
    };
    off = window.desktop.videodlOnChanged((list) => {
      const job = list.find((item) => item.id === jobId);
      if (!job) return;
      if (job.status === 'running') {
        report({ percent: Math.max(0, Math.min(100, job.pct || 0)), text: job.phase || '下载中' });
      } else {
        finish(job);
      }
    });
    window.desktop.videodlList().then((list) => {
      const job = (list || []).find((item) => item.id === jobId);
      if (job && job.status !== 'running') finish(job);
      else if (job) report({ percent: Math.max(0, Math.min(100, job.pct || 0)), text: job.phase || '下载中' });
    }).catch(() => {});
  });
}

async function startDownload() {
  if (!state) return;
  const url = state.els.url.value.trim();
  if (!url) {
    state.els.hint.textContent = '请先粘贴视频链接。';
    state.ctx.setStatus('请先粘贴视频链接');
    return;
  }
  const dir = state.dir;
  if (!dir) {
    state.els.hint.textContent = '还没有可用的保存位置，请点「更改」选一个文件夹。';
    return;
  }
  let jobId = null;
  state.ctx.tasks.enqueue({
    toolId: 'videodl',
    toolName: '视频下载',
    lane: 'io',
    label: url,
    run: async ({ report, isCancelled }) => {
      const started = await window.desktop.videodlStart({ url, dir });
      if (!started || !started.ok) return { ok: false, error: (started && started.message) || '开始下载失败' };
      jobId = started.job.id;
      if (isCancelled()) window.desktop.videodlCancel(jobId);
      const job = await waitForTerminal(jobId, report);
      if (job.status === 'done') return { ok: true, outputPaths: job.file ? [job.file] : [], outputDir: job.dir };
      if (job.status === 'cancelled') return { canceled: true };
      return { ok: false, error: job.err || '下载失败' };
    },
    onCancel: () => { if (jobId) window.desktop.videodlCancel(jobId); }
  });
  if (state) {
    state.els.hint.textContent = '已开始下载，进度见下方记录（可以继续粘贴下一条）。';
    state.els.url.value = '';
    state.ctx.setStatus('已开始下载');
  }
}

async function changeDir() {
  if (!state) return;
  const picked = await window.desktop.openFolder();
  if (!state || !picked) return;
  await state.ctx.settings.updateSettings({ videodlDir: picked });
  if (!state) return;
  state.dir = picked;
  state.els.dir.textContent = picked;
  state.els.dir.title = picked;
}

async function cancelJob(id) {
  await window.desktop.videodlCancel(id);
}

async function retryJob(id) {
  const res = await window.desktop.videodlRetry(id).catch(() => ({ ok: false, message: '重试失败' }));
  if (state && res && !res.ok) state.ctx.setStatus(res.message || '重试失败');
  if (state && res && res.ok) state.ctx.setStatus('已重新开始下载');
}

async function clearHistory() {
  await window.desktop.videodlClearHistory();
  if (state) state.ctx.setStatus('已清空记录（已下载的文件还留在磁盘上）');
}

async function checkEngine() {
  if (!state || state.engineBusy) return;
  state.engineBusy = true;
  state.els.engineHint.textContent = '正在检查更新…';
  const res = await window.desktop.videodlEngineCheck().catch((err) => ({ ok: false, error: err.message }));
  if (!state) return;
  state.engineBusy = false;
  if (res && res.ok) {
    const latest = res.latest || {};
    state.els.engineHint.textContent = latest.version && res.status && res.status.available
      ? `发现新版本 v${latest.version}，点「更新引擎」即可换用（随包版仍保留兜底）。`
      : '已是最新版本。';
  } else {
    state.els.engineHint.textContent = `检查失败：${(res && res.error) || '未知原因'}（不影响已下载过的站点继续使用）`;
  }
  refreshStatus({ silent: true });
}

async function updateEngine() {
  if (!state || state.engineBusy) return;
  state.engineBusy = true;
  state.els.updateEngine.disabled = true;
  state.els.engineHint.textContent = '正在下载引擎（约 18MB）…';
  const res = await window.desktop.videodlEngineUpdate().catch((err) => ({ ok: false, error: err.message }));
  if (!state) return;
  state.engineBusy = false;
  state.els.updateEngine.disabled = false;
  state.els.engineHint.textContent = res && res.ok
    ? `已更新到 v${res.version}（校验通过，仅对之后的新任务生效）。`
    : `更新失败：${(res && res.error) || '未知原因'}（现有引擎不受影响）`;
  refreshStatus({ silent: true });
}
