// 【新工具模板】界面与交互
// 约定：
//  - mount(container, ctx)：首次进入本工具时把界面渲染进 container，并绑定事件（只会调用一次）
//  - activate() / deactivate()（可选）：每次切入 / 切出本工具时调用；用来收敛全局交互
//      （窗口快捷键、定时器、进度订阅等），不做也不会报错
//  - unmount()：页面被销毁时清理（当前框架页面常驻，切换工具不会调用它）；
//      临时资源（定时器、blob URL、进度订阅）仍建议在 deactivate 里停掉，在 activate 里恢复
//  - 通用能力一律通过 ctx 取（ctx.setStatus / ctx.openImages / ctx.settings …）
//  - ctx.isActive()：当前是否正显示在右侧；挂到 window / document 上的交互必须先判断它
//  - 样式写在本工具的 styles.css；通用组件（btn / card / input / select …）复用 shell/components.css，
//    颜色/字号/间距必须用 shell/theme.css 的变量

const MARKUP = `
  <div class="example-tool">
    <section class="card" style="padding: var(--space-4);">
      <p>这里是「示例工具」的界面。</p>
    </section>
  </div>
`;

let state = null;

export function mount(container, ctx) {
  container.innerHTML = MARKUP;
  state = { container, ctx, listeners: [] };

  // 示例：点一下按钮，在顶部状态栏显示提示
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary';
  btn.textContent = '点我试试';
  btn.addEventListener('click', () => ctx.setStatus('示例工具运行正常'));
  state.listeners.push([btn, 'click']);
  container.querySelector('.example-tool').appendChild(btn);

  ctx.setStatus('示例工具已打开');
  ctx.setInfo({});
}

// 每次切回本工具时调用（可选）：如恢复轮询、刷新状态提示
export function activate() {
  if (!state) return;
}

// 每次切走本工具时调用（可选）：如停掉定时器、取消进度订阅（窗口级快捷键也要在这里让位）
export function deactivate() {
  if (!state) return;
}

export function unmount() {
  if (!state) return;
  for (const [el, type] of state.listeners) {
    // 元素随 innerHTML 一起销毁，这里主要是保持「成对清理」的习惯；
    // 若在工具里用了定时器 / 全局事件 / blob URL，务必在这里清掉。
    void el; void type;
  }
  state = null;
}