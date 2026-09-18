// 【新工具模板】界面与交互
// 约定：
//  - mount(container, ctx)：把界面渲染进 container，并绑定事件
//  - unmount()：切走时清理（事件、计时器、blob URL 等），必须与 mount 成对
//  - 通用能力一律通过 ctx 取（ctx.setStatus / ctx.openImages / ctx.settings …）
//  - 样式写在本工具的 styles.css，颜色/字号/间距必须用 shell/theme.css 的变量

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

export function unmount() {
  if (!state) return;
  for (const [el, type] of state.listeners) {
    // 元素随 innerHTML 一起销毁，这里主要是保持「成对清理」的习惯；
    // 若在工具里用了定时器 / 全局事件 / blob URL，务必在这里清掉。
    void el; void type;
  }
  state = null;
}