// 工具：Agent 接入 —— 界面与交互
// 设计要点：
//  - 面向小白：不改 JSON、不敲命令，点「接入」就等于双击软件目录里的一键脚本；
//  - 主进程只接受固定动作名（白名单），界面不能传任意脚本路径/参数；
//  - 脚本输出原样显示，失败时把 PowerShell 的报错也贴出来，方便复制给 AI 排查；
//  - 「移除」要二次确认，避免误点。

const CLIENTS = [
  { id: 'dsh', name: 'DeepSeek Harness（DSH）', tip: '装完要完全退出并重启 DSH（不是关窗口）' },
  { id: 'qoder', name: 'Qoder', tip: '装完要完全退出重开，并新开一个对话' },
  { id: 'trae', name: 'Trae（CN / 国际版）', tip: '装完要完全退出重开，再点「新任务」新开对话' },
  { id: 'workbuddy', name: 'WorkBuddy', tip: '装完要完全退出重开；第一次还要去「MCP 服务管理」点一次「信任」' },
  { id: 'zcode', name: '智谱 ZCode', tip: '装完要完全退出重开；按 Ctrl+K 搜「MCP 服务器」确认开关打开' }
];

const MARKUP = `
  <div class="agent-tool">
    <section class="card agent-hero">
      <div class="agent-hero-icon" aria-hidden="true">🤖</div>
      <div>
        <h2 class="agent-title">Agent 接入</h2>
        <p class="agent-desc">
          让 AI 助手（DSH / Qoder / Trae / WorkBuddy / ZCode）直接调用番茄工具箱的 41 个工具。
          <strong>不用改配置、不用敲命令、不用装 Node</strong>：点对应客户端的「接入」，然后按提示完全退出客户端再打开。
        </p>
      </div>
    </section>

    <section class="card agent-check">
      <div class="agent-check-text">
        <strong>装完不确定有没有生效？</strong>
        <span>点「一键体检」：它会真的启动一遍 MCP，列出工具数量（正常 41 个），并指出卡在哪一步。</span>
      </div>
      <button class="btn btn-primary" data-agent-action="verify">一键体检</button>
    </section>

    <section class="card agent-clients">
      <h3 class="agent-subtitle">选择要接入的 AI 助手</h3>
      ${CLIENTS.map((c) => `
        <div class="agent-row" data-client="${c.id}">
          <div class="agent-row-text">
            <strong class="agent-client-name">${c.name}</strong>
            <span class="agent-client-tip">${c.tip}</span>
          </div>
          <div class="agent-row-actions">
            <button class="btn btn-primary" data-agent-action="setup:${c.id}">接入</button>
            <button class="btn btn-ghost" data-agent-action="remove:${c.id}">移除</button>
          </div>
        </div>
      `).join('')}
    </section>

    <section class="card agent-tips">
      <h3 class="agent-subtitle">说明</h3>
      <ul class="agent-tip-list">
        <li>接入只改对应客户端自己的配置文件，并先做备份；不会动别的 MCP、providers，也不会覆盖已有文件。</li>
        <li>每个客户端独立：只接你实际在用的那个就行，接多个也没关系。</li>
        <li>「移除」会把配置和安装的技能一起撤回（备份留在客户端目录的 <code>skill-backups/</code>）。</li>
        <li>视频下载仍然每次都要你在「视频下载」页授权，接不接入 Agent 都一样。</li>
        <li>体检和接入用的是软件目录里同一批脚本，和双击 <code>一键接入…cmd</code> 完全等价。</li>
        <li><strong>升级到新版本后</strong>：软件文件夹名变了，旧配置会指向已删除的旧目录；在新版里重新点一次「接入」即可把路径更新过来，然后重启对应客户端。</li>
      </ul>
    </section>

    <section class="card agent-output-card">
      <div class="agent-output-head">
        <h3 class="agent-subtitle">执行结果</h3>
        <button class="btn btn-ghost agent-copy" data-role="copy">复制结果</button>
      </div>
      <pre class="agent-output" data-role="output">还没有执行操作。点上面的「一键体检」或某个客户端的「接入」开始。</pre>
    </section>
  </div>
`;

let state = null;

export function mount(container, ctx) {
  container.innerHTML = MARKUP;
  const els = {
    output: container.querySelector('[data-role="output"]'),
    copy: container.querySelector('[data-role="copy"]'),
    checkBtn: container.querySelector('[data-agent-action="verify"]')
  };
  state = { container, ctx, els, busy: false, listeners: [] };

  container.addEventListener('click', onContainerClick);
  state.listeners.push([container, 'click']);
  els.copy.addEventListener('click', onCopy);
  state.listeners.push([els.copy, 'click']);

  ctx.setInfo({});
  ctx.setStatus('Agent 接入：选一个客户端点「接入」，或先点「一键体检」');
}

export function activate() {
  if (!state) return;
}

export function deactivate() {
  if (!state) return;
}

export function unmount() {
  if (!state) return;
  for (const [el, type] of state.listeners) {
    if (el && el.removeEventListener) el.removeEventListener(type, onContainerClick);
  }
  state = null;
}

// —— 内部实现 ——

function onContainerClick(event) {
  const btn = event.target.closest('[data-agent-action]');
  if (!btn || !state) return;
  const action = btn.getAttribute('data-agent-action');
  if (action === 'verify') return runAction(action);
  if (action.startsWith('setup:')) return runAction(action);
  if (action.startsWith('remove:')) {
    const client = action.slice('remove:'.length);
    const name = (CLIENTS.find((c) => c.id === client) || {}).name || client;
    if (!window.confirm(`确定要从 ${name} 移除番茄工具箱吗？\n\n会删除它的 MCP 配置和技能（先备份），不影响其它 MCP。`)) return;
    return runAction(action);
  }
}

async function runAction(action) {
  if (!state || state.busy) return;
  const st = state;
  const info = action === 'verify' ? '正在体检（会真的启动 MCP，约 5～15 秒）…'
    : action.startsWith('setup:') ? '正在接入，请稍等…'
      : '正在移除，请稍等…';
  st.busy = true;
  setButtonsDisabled(true);
  st.els.output.textContent = info;
  st.ctx.setStatus(info);

  let res;
  try {
    res = await window.desktop.agentRun(action);
  } catch (err) {
    res = { ok: false, message: String((err && err.message) || err) };
  }
  if (state !== st) return; // 本页被 LRU 回收
  st.busy = false;
  setButtonsDisabled(false);

  const body = (res && res.output) ? res.output.trim() : '';
  const head = res && res.ok ? '✅ 成功' : '❌ 失败';
  const detail = (res && res.message) ? `（${res.message}）` : '';
  st.els.output.textContent = body ? `${head}${detail}\n\n${body}` : `${head}${detail}\n\n（脚本没有输出）`;

  if (!res || !res.ok) {
    st.ctx.setStatus(`操作失败：${(res && res.message) || '未知原因'}`);
    return;
  }
  if (action === 'verify') {
    st.ctx.setStatus('体检完成：结果见下方「执行结果」');
  } else if (action.startsWith('setup:')) {
    const client = action.slice('setup:'.length);
    const tip = (CLIENTS.find((c) => c.id === client) || {}).tip || '按提示重启客户端';
    st.ctx.setStatus(`已接入：${tip}`);
  } else {
    st.ctx.setStatus('已移除；完全退出重开该客户端后生效');
  }
}

function setButtonsDisabled(disabled) {
  if (!state) return;
  for (const btn of state.container.querySelectorAll('button[data-agent-action]')) {
    btn.disabled = disabled;
  }
}

async function onCopy() {
  if (!state) return;
  try {
    await navigator.clipboard.writeText(state.els.output.textContent || '');
    state.ctx.setStatus('执行结果已复制');
  } catch {
    state.ctx.setStatus('复制失败：可以手动选中文字复制');
  }
}
