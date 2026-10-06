// 工具：软件卸载 —— 界面与交互（极简启动页；见 spec/modules/uninstall.md）
// 设计要点：
//  - 本页只做一件事：把随包内置的 HiBit Uninstaller（便携版）以管理员权限拉起来；
//    卸载什么、删哪些残留，全部由用户在 HiBit 自己的界面里决定——本软件不代点、不传参、不静默执行。
//  - 引擎缺失时不隐藏按钮了事，而是给出「放哪儿」的可操作说明（与 ffmpeg / 7zip 等加装包同一约定）。
//  - 自动化测试模式下主进程的 hibit:launch 只走空跑（dryRun），页面照实显示，不会真的弹 UAC。

const SOURCE_URL = 'https://www.hibitsoft.ir/Uninstaller.html';

const MARKUP = `
  <div class="uns-tool">
    <section class="card uns-hero">
      <div class="uns-hero-icon" aria-hidden="true">🧹</div>
      <div class="uns-hero-text">
        <h2 class="uns-title">软件卸载</h2>
        <p class="uns-desc">
          把不想要的软件连同残留一起清掉。点下面的按钮打开卸载工具（需要管理员权限，系统会弹一次确认框），
          在它的列表里选中程序 → 点「卸载」，卸载完成后按提示扫描并清理残留。
        </p>
      </div>
    </section>

    <section class="card uns-action-card">
      <div class="uns-actions">
        <button class="btn btn-primary btn-lg" data-action="launch">打开卸载工具（管理员）</button>
        <button class="btn btn-ghost" data-action="recheck">重新检测</button>
      </div>
      <p class="uns-hint" data-role="hint">尚未启动。</p>
    </section>

    <section class="card uns-engine" data-role="engine">
      <div class="uns-engine-line" data-role="engine-line">正在检测卸载工具…</div>
    </section>

    <section class="card uns-tips">
      <h3 class="uns-subtitle">用法要点</h3>
      <ul class="uns-tip-list">
        <li>卸载前先关掉目标程序本身，避免文件被占用导致卸不干净。</li>
        <li>卸载跑完后会弹「残留扫描」：逐项看一眼再删，拿不准的共享目录（如公共运行库）不要删。</li>
        <li>卸载程序损坏或缺失时，用界面里的「强制卸载」；正常能卸的优先走普通卸载。</li>
        <li>卸载工具是随本软件带的一份官方原版便携版，它的设置由它自己保存，不影响本软件。</li>
      </ul>
    </section>
  </div>
`;

let state = null;

export function mount(container, ctx) {
  container.innerHTML = MARKUP;
  const els = {
    launch: container.querySelector('[data-action="launch"]'),
    recheck: container.querySelector('[data-action="recheck"]'),
    hint: container.querySelector('[data-role="hint"]'),
    engine: container.querySelector('[data-role="engine"]'),
    engineLine: container.querySelector('[data-role="engine-line"]')
  };
  state = { container, ctx, els, status: null, busy: false };

  els.launch.addEventListener('click', () => doLaunch());
  els.recheck.addEventListener('click', () => refreshStatus({ silent: false, explicit: true }));

  ctx.setInfo({}); // 本工具没有分辨率/耗时概念，顶栏信息留空
  refreshStatus({ silent: false });
}

// 每次切回本工具时静默复核一次引擎状态（期间可能有人往 addons 里放了文件）
export function activate() {
  if (!state) return;
  refreshStatus({ silent: true, statusLine: true });
}

export function deactivate() {
  if (!state) return;
}

export function unmount() {
  if (!state) return;
  state = null;
}

// —— 内部实现 ——

/** 拉一次引擎状态：更新引擎卡、按钮可用性与顶栏提示
 *  silent=true 时不动顶栏提示（切回页面时的复核用，别抢框架的切换提示）；
 *  statusLine=true 时只把页面自己的状态记下来（ctx.setStatus 内部保证：非当前页只记不显）。 */
async function refreshStatus({ silent, explicit, statusLine } = {}) {
  if (!state) return;
  const st = await window.desktop.hibitStatus().catch((err) => ({ ok: false, message: err.message }));
  if (!state) return;
  state.status = st;
  renderEngine(st);
  state.els.launch.disabled = !st.found;
  if (!silent || statusLine) {
    state.ctx.setStatus(st.found
      ? `卸载工具已就绪${st.version ? `（v${st.version}）` : ''}`
      : '未检测到软件卸载加装包');
  }
  if (explicit) {
    state.els.hint.textContent = st.found
      ? '重新检测：卸载工具已就绪，可以启动。'
      : '重新检测：仍未找到加装包，按钮已禁用——放好后点「重新检测」即可。';
  }
}

function renderEngine(st) {
  const { engineLine } = state.els;
  if (st.found) {
    const name = `HiBit Uninstaller 便携版${st.version ? ` v${st.version}` : ''}`;
    engineLine.innerHTML = ''
      + `<div class="uns-engine-name">引擎：${name}（管理员权限启动）</div>`
      + `<div class="uns-engine-path" title="${escapeHtml(st.path)}">位置：${escapeHtml(st.path)}</div>`
      // 来源写成纯文本、不做成可点链接：本项目没有任何「打开外部浏览器」的能力，
      // 做成链接会把这个窗口导航到外站、切不回来（软件是离线工具箱，也不主张点出去）。
      + `<div class="uns-engine-src">来源：${SOURCE_URL}（官方原版文件，未做修改）</div>`;
    state.els.engine.classList.remove('is-missing');
  } else {
    engineLine.textContent = '未检测到软件卸载加装包：请把 HiBit Uninstaller 便携版放到软件目录的 addons/hibit'
      + '（文件名 HiBitUninstaller-Portable.exe），重开本工具后再试。';
    state.els.engine.classList.add('is-missing');
  }
}

/** 点「打开卸载工具」：拉起（提权在系统 UAC 完成），如实反馈三种结果 */
async function doLaunch() {
  if (!state || state.busy) return;
  if (!state.status || !state.status.found) return;
  // await 期间本页可能被 LRU 回收（unmount 把 state 置空）：全程用局部 st，界面收尾前再核对
  const st = state;
  st.busy = true;
  st.els.launch.disabled = true;
  st.els.hint.textContent = '正在启动……如果系统弹出权限确认框，请点「是」。';
  st.ctx.setStatus('正在启动卸载工具…');
  try {
    const res = await window.desktop.hibitLaunch();
    if (state !== st) return; // 本页已被回收：跳过界面收尾
    if (res && res.ok) {
      st.els.hint.textContent = res.dryRun
        ? '（自动化测试模式：未真正启动卸载工具）'
        : '卸载工具已启动。若没看到窗口，请检查任务栏；它可能在系统权限确认框后面。';
      st.ctx.setStatus(res.dryRun ? '（测试模式）卸载工具未真正启动' : '卸载工具已启动（请在 UAC 里点「是」）');
    } else if (res && res.canceled) {
      st.els.hint.textContent = '已取消管理员授权，卸载工具没有启动。需要时再点一次即可。';
      st.ctx.setStatus('已取消管理员授权');
    } else {
      st.els.hint.textContent = `启动失败：${(res && res.message) || '未知原因'}`;
      st.ctx.setStatus(`启动卸载工具失败：${(res && res.message) || '未知原因'}`);
    }
  } finally {
    if (state === st) {
      st.busy = false;
      st.els.launch.disabled = !(st.status && st.status.found);
    }
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}