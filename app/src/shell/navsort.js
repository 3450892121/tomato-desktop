// 导航手动排序（v2.6.0 引入；v2.11.0 起改为「长按拖动」，见 spec/modules/toolkit.md「导航手动排序」）
// 分两部分：
//  ① 纯逻辑（computeNavPlan / pickStartupTool / readNavOrderFromDOM 的数据净化）——不依赖 DOM，node 单测直接跑；
//  ② 拖拽交互（createNavSort）——Pointer Events 自绘拖拽：
//     长按条目约 400ms 即拿起（被拖条目升起玻璃卡跟随指针），同级兄弟用 transform 平滑让位，
//     松手按视觉序重排 DOM 后落盘。不需要任何「排序模式」，点击（切工具 / 展开收起分组）不受影响。
//
// 拖拽的关键约定（踩坑记录）：
//  - 正确性绝不依赖 setPointerCapture（合成事件没有真实指针，capture 会抛 NotFoundError）；
//    pointermove/up/cancel 挂 window，capture 只在 try/catch 里当增强。
//  - 坐标全部用「内容坐标」（clientY + nav.scrollTop）：拖拽中容器自动滚动、列表本身滚动都不影响计算。
//  - 拖拽开始时一次性量同级兄弟的静态位置，此后不再量（transform 不触发回流，量了也是错的）。
//  - 让位偏移规则：k 为目标插入位（拖拽块视觉中心越过的兄弟个数）——
//      k > 原位：兄弟下标 ∈ [原位, k) 上移（-shift）；
//      k < 原位：兄弟下标 ∈ [k, 原位) 下移（+shift）；
//      其余不动。k == 原位时无偏移，抓起来不会跳。
//    shift = 被拖块高度 + 间距，与兄弟自身高度无关——所以分组展开/收起导致兄弟高度不齐时依然正确。
//  - 长按与点击的区分：pointerdown 起 400ms 计时器，到时才 beginDrag；
//    计时未到就移动 ≥4px 或松手 → 放弃按压，click 照常派发给原有处理器（切工具 / 折叠分组）。
//  - pointerup 后浏览器仍会派发 click：拖拽结束（拿起过就算，含原地松手与取消）后 500ms 内的 click
//    在 nav 的 capture 阶段拦下，防止「拖完顺手切走工具 / 把分组收起来」。

/** 是不是「非数组的普通对象」 */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 净化并计算导航渲染顺序（纯函数）。
 * @param groups GROUPS（registry 定义，顺序即默认分组顺序）
 * @param tools TOOLS（全部工具声明，组内默认按 order 升序）
 * @param saved settings.navOrder（null，或被手改坏的任意形状）
 * @returns [{ id, name, icon, tools: [...] }, ...] —— 已排序的正式分组 + 固定在最后的「其它」组（可能无工具）
 *
 * 净化规则（任何非法形状回退默认，绝不丢工具）：
 *  - 整个 saved 不是普通对象 → 全默认；
 *  - saved.groups 只保留「已知分组 id」，去重，'other' 一律忽略（其它组永远置底）；缺的分组按注册序追加；
 *  - saved.tools[组id] 只保留「真正属于该组的工具 id」（手改配置也无法把工具走私到别的组），去重；
 *    组内没排过的新工具按 order 追加在尾部；该组没排过序 → 整组默认序。
 */
export function computeNavPlan(groups, tools, saved) {
  const knownGroups = new Set(groups.map((g) => g.id));
  // 工具按声明归组：声明了已知 group 用之，否则归「其它」
  const byGroup = new Map();
  for (const g of groups) byGroup.set(g.id, []);
  byGroup.set('other', []);
  for (const t of tools) byGroup.get(knownGroups.has(t.group) ? t.group : 'other').push(t);
  for (const list of byGroup.values()) list.sort((a, b) => (a.order || 0) - (b.order || 0));

  const savedOk = isPlainObject(saved);
  const savedGroups = savedOk && Array.isArray(saved.groups)
    ? saved.groups.filter((id) => typeof id === 'string' && knownGroups.has(id) && id !== 'other')
    : null;
  const savedTools = savedOk && isPlainObject(saved.tools) ? saved.tools : null;

  // 分组顺序：用户排过的在前（去重），没排过的分组按注册序追加
  let groupIds;
  if (savedGroups) {
    const seen = new Set();
    groupIds = [];
    for (const id of savedGroups) {
      if (!seen.has(id)) { seen.add(id); groupIds.push(id); }
    }
    for (const g of groups) if (!seen.has(g.id)) groupIds.push(g.id);
  } else {
    groupIds = groups.map((g) => g.id);
  }

  /** 组内顺序：用户排过的（合法且属于本组）在前，没排过的按 order 追加 */
  const orderTools = (groupId, list) => {
    const savedList = savedTools && Array.isArray(savedTools[groupId])
      ? savedTools[groupId].filter((id) => typeof id === 'string')
      : null;
    if (!savedList) return list;
    const allowed = new Set(list.map((t) => t.id));
    const ordered = [];
    const seen = new Set();
    for (const id of savedList) {
      if (allowed.has(id) && !seen.has(id)) {
        seen.add(id);
        ordered.push(list.find((t) => t.id === id));
      }
    }
    for (const t of list) if (!seen.has(t.id)) ordered.push(t);
    return ordered;
  };

  const plan = groupIds.map((id) => {
    const group = groups.find((g) => g.id === id);
    return { id, name: group.name, icon: group.icon, tools: orderTools(id, byGroup.get(id)) };
  });
  // 「其它」组固定最后：由未声明（或声明了未知）group 的工具自动聚合，不参与分组排序，但组内可排序
  plan.push({ id: 'other', name: '其它', icon: '📁', tools: orderTools('other', byGroup.get('other')) });
  return plan;
}

/**
 * 挑「启动默认打开的工具」：排在最前的非空分组的第一个工具（v2.7.1，用户要求）。
 * 语义：用户把某组拖到第一位＝最常用，启动就直接进它的第一个工具；
 * 届时只有它所在分组被「切工具自动展开」规则展开，其余分组按用户偏好显示。
 * 从没排过序（navOrder=null）时等于默认序的第一个分组（图片 → 图片混淆），与旧版一致。
 * @param plan computeNavPlan 的输出
 * @returns 工具声明对象；一个工具都没有时返回 null
 */
export function pickStartupTool(plan) {
  for (const group of plan) {
    if (group.tools.length > 0) return group.tools[0];
  }
  return null;
}

/**
 * 从当前导航 DOM 读取顺序快照（每次拖放成功后落盘用）。
 * @param navEl .tool-nav 元素（renderNav 渲染出来的结构）
 * @returns { groups: [...分组id], tools: { <组id>: [...工具id], other: [...] } }
 */
export function readNavOrderFromDOM(navEl) {
  const groups = [];
  const tools = {};
  for (const wrap of navEl.querySelectorAll(':scope > .tool-group')) {
    const id = wrap.dataset.groupId;
    const list = [...wrap.querySelectorAll(':scope > .tool-group-items > .tool-item')].map((b) => b.dataset.toolId);
    if (id === 'other') tools.other = list;
    else { groups.push(id); tools[id] = list; }
  }
  return { groups, tools };
}

/**
 * 导航拖拽排序控制器（shell.js 持有唯一实例）。长按条目拖动，不需要进入排序模式：
 *  - 拖分组标题（.tool-group-head）＝移动整个分组（主项目）；
 *  - 拖组内工具条目（.tool-item）＝在本组内移动（子项目）；
 *  - 快速点击不受影响（切工具 / 展开收起分组由 shell.js 原有 click 处理器接管）。
 * @param {Object} options
 *   - nav：.tool-nav 元素（拖拽发生在它内部，滚动跟随它）
 *   - persist(order)：拖放成功后落盘（shell 传 settings.updateSettings）
 *   - resetOrder()：「↺ 恢复默认顺序」按钮（清 navOrder + 重渲染；按钮显隐由 shell 按有无 navOrder 控制）
 *   - onStatus(text)：状态栏反馈（可选）
 * @returns { cancelDrag } —— cancelDrag 供 renderNav 重建 DOM 前防御性收尾
 */
export function createNavSort({ nav, persist, resetOrder, onStatus }) {
  const btnSortReset = document.getElementById('btnSortReset');

  /** 长按阈值（ms）：按住这么久才拿起拖动；未到就松手＝普通点击 */
  const LONG_PRESS_MS = 400;
  /** 放弃按压的移动阈值（px）：长按还没到手就想移动，当作没按住 */
  const CANCEL_MOVE_PX = 4;
  /** 拖拽结束后这段时间内的 click 一律拦下（浏览器拖完仍会派发 click，防止误切工具/误折叠） */
  const CLICK_GUARD_MS = 500;

  /** 进行中的拖拽状态（见文件头注释） */
  let drag = null;
  /** 待定按压（还没长按到位，可能只是点击）；由计时器升级成 drag，或被移动/松手取消 */
  let pending = null;
  let pressTimer = 0;
  let rafId = 0;
  /** 最近一次拖拽（拿起过就算，含原地松手/取消）结束的时间戳；0 = 从没拖过 */
  let dragEndedAt = 0;

  // 拖完的 click 一律拦：capture 阶段在 nav 上掐掉，工具切换/分组折叠的 click 处理器根本收不到。
  // 用时间窗而不是一次性标志：拖拽可能以 cancelDrag（重渲染防御）收尾，之后未必紧跟 click。
  nav.addEventListener('click', (event) => {
    if (dragEndedAt && Date.now() - dragEndedAt < CLICK_GUARD_MS) {
      event.stopPropagation();
      event.preventDefault();
    }
  }, true);

  // —— 长按 → 拖拽 ——

  nav.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag || pending) return;
    const item = event.target.closest('.tool-item');
    const head = event.target.closest('.tool-group-head');
    let el = null;
    let kind = null;
    if (item) { el = item; kind = 'tool'; }               // 子项目：组内拖
    else if (head) { el = head.closest('.tool-group'); kind = 'group'; } // 主项目：整组拖
    if (!el || !nav.contains(el)) return;
    event.preventDefault(); // 防文本选中；click 不受影响（拖后守卫在 capture 监听，点击行为在 shell.js）
    pending = { el, kind, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    window.addEventListener('pointermove', onWindowMove);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('pointercancel', onWindowCancel);
    // 长按计时：按住不动 LONG_PRESS_MS 才拿起；期间移动超阈值或松手都取消（见 onWindowMove/Up）
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      if (!pending) return;
      const p = pending;
      beginDrag({ clientX: p.x, clientY: p.y, pointerId: p.pointerId });
    }, LONG_PRESS_MS);
  });

  function detachWindowListeners() {
    window.removeEventListener('pointermove', onWindowMove);
    window.removeEventListener('pointerup', onWindowUp);
    window.removeEventListener('pointercancel', onWindowCancel);
  }

  /** 放弃一次待定按压（未进入拖拽）：不拦 click，点击行为照常 */
  function cancelPending() {
    clearTimeout(pressTimer);
    detachWindowListeners();
    pending = null;
  }

  function onWindowMove(event) {
    if (pending && !drag) {
      // 长按还没到手就开始移动：放弃这次按压（不升级成拖拽），当成一次没按住的点击
      if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) >= CANCEL_MOVE_PX) cancelPending();
      return;
    }
    if (drag) applyTransform(event);
  }

  function onWindowUp(event) {
    if (pending && !drag) {
      // 长按未满就松手＝普通点击：这里什么都不做，click 交给原有处理器
      // （点工具条目＝切换工具；点分组标题＝展开/收起这一组，见 shell.js）。
      cancelPending();
      return;
    }
    if (!drag) return;
    applyTransform(event); // 用最终指针位置定 k
    finishDrag(true);
  }

  function onWindowCancel() {
    if (pending) cancelPending();
    else cancelDrag();
  }

  function beginDrag(event) {
    const { el, kind } = pending;
    clearTimeout(pressTimer);
    const scrollTop = nav.scrollTop;
    const rect = el.getBoundingClientRect();
    const elTopC = rect.top + scrollTop; // 内容坐标：静态布局位置
    const elH = rect.height;

    let sibEls;
    if (kind === 'tool') {
      sibEls = [...el.parentElement.children].filter((c) => c !== el && c.classList.contains('tool-item'));
    } else {
      sibEls = [...nav.querySelectorAll(':scope > .tool-group')].filter((g) => g !== el);
    }
    const sibMeta = sibEls.map((s) => {
      const r = s.getBoundingClientRect();
      return { el: s, topC: r.top + scrollTop, h: r.height };
    });
    // 兄弟间距（让位偏移 = 被拖高度 + 间距）：从相邻两个兄弟量出来。
    // 兄弟高度不齐（分组展开/收起混着）也成立：偏移只取决于「被拖块腾出的空间」，与兄弟自身高度无关。
    const gap = sibMeta.length >= 2 ? Math.max(0, sibMeta[1].topC - sibMeta[0].topC - sibMeta[0].h) : 0;
    const shift = elH + gap;
    // 原位插入序：被拖块中心越过的兄弟个数（此刻都没越过偏移，等于静态序里的位置）
    const center0 = elTopC + elH / 2;
    const origIdx = sibMeta.reduce((acc, m) => acc + (m.topC + m.h / 2 < center0 ? 1 : 0), 0);

    drag = {
      el, kind, parent: kind === 'tool' ? el.parentElement : nav,
      sibMeta, shift, origIdx, k: origIdx,
      elTopC, elH,
      grabDy: (event.clientY + scrollTop) - elTopC, // 指针（内容坐标）到被拖块顶部的距离
      lastClientY: event.clientY,
      curTranslate: 0
    };
    pending = null;
    el.classList.add('is-dragging'); // 拿起即升起玻璃卡：长按到位的即时反馈
    // 拖拽期间放开组容器的 overflow：玻璃卡的外阴影与兄弟让位的位移不被裁（CSS 见 shell.css）
    nav.classList.add('is-drag-active');
    try { nav.setPointerCapture(event.pointerId); } catch { /* 合成事件/异常环境没有真指针：不依赖它 */ }
    nav.addEventListener('scroll', onNavScroll, { passive: true });
    applyTransform(event);
    startAutoScroll();
  }

  /** 用指针位置更新：被拖块 transform + 目标插入位 k（变了才重算兄弟让位） */
  function applyTransform(event) {
    if (!drag) return;
    if (event) drag.lastClientY = event.clientY;
    const pointerC = drag.lastClientY + nav.scrollTop;
    const desiredTopC = pointerC - drag.grabDy;
    drag.curTranslate = desiredTopC - drag.elTopC;
    drag.el.style.transform = `translateY(${Math.round(drag.curTranslate)}px) scale(1.02)`;

    const center = desiredTopC + drag.elH / 2;
    let k = 0;
    for (const m of drag.sibMeta) if (center > m.topC + m.h / 2) k++;
    if (k !== drag.k) {
      drag.k = k;
      for (let i = 0; i < drag.sibMeta.length; i++) {
        let off = 0;
        if (k > drag.origIdx && i >= drag.origIdx && i < k) off = -drag.shift;      // 往下拖：中间的让上来
        else if (k < drag.origIdx && i >= k && i < drag.origIdx) off = drag.shift;  // 往上拖：中间的让下去
        drag.sibMeta[i].el.style.transform = off ? `translateY(${off}px)` : '';
      }
    }
  }

  /** 拖拽中列表自己滚动（自动滚动/用户滚轮）：被拖块要继续「粘」在指针下 */
  function onNavScroll() { applyTransform(null); }

  /**
   * 结束任何进行中的拖拽/按压。
   * 用途：renderNav 重建 DOM 前的防御（导入设置等路径），避免带着拖拽状态重建。
   */
  function cancelDrag() {
    if (pending) { cancelPending(); return; }
    if (!drag) return;
    const d = drag;
    drag = null;
    dragEndedAt = Date.now(); // 拿起过就算拖过：紧跟的 click 一并拦下
    stopAutoScroll();
    nav.classList.remove('is-drag-active'); // 交还给 CSS：组容器恢复 overflow:hidden（折叠动画要用）
    nav.removeEventListener('scroll', onNavScroll);
    for (const m of d.sibMeta) m.el.style.transform = '';
    d.el.classList.remove('is-dragging');
    // 取消：从当前位置平滑落回原位（布局没动过，直接清 transform 就是动画）
    d.el.style.transform = '';
  }

  function finishDrag(commit) {
    const d = drag;
    drag = null;
    dragEndedAt = Date.now(); // 拿起过就算拖过：原地松手也不该触发点击（与长按手势的语义一致）
    stopAutoScroll();
    nav.classList.remove('is-drag-active'); // 拖完交还给 CSS：组容器恢复 overflow:hidden
    nav.removeEventListener('scroll', onNavScroll);
    detachWindowListeners();

    const moved = commit && d.k !== d.origIdx;
    if (!moved) {
      // 原地松手：布局没动过，从当前位置（含 scale）平滑落回原位
      d.el.classList.remove('is-dragging');
      d.el.style.transform = '';
      return;
    }

    // 按视觉序真实重排 DOM
    const target = d.k < d.sibMeta.length ? d.sibMeta[d.k].el : null;
    if (target) d.parent.insertBefore(d.el, target);
    else d.parent.appendChild(d.el);
    for (const m of d.sibMeta) m.el.style.transform = ''; // 兄弟的自然位置 == 视觉位置，清偏移无跳动

    // 被拖块 mini-FLIP：先摆回松手时的视觉位置，再动画归位
    d.el.style.transform = ''; // 先清才能量「重排后的自然布局位置」
    const newTopC = d.el.getBoundingClientRect().top + nav.scrollTop;
    const oldVisualTopC = d.elTopC + d.curTranslate;
    d.el.classList.remove('is-dragging'); // 恢复 transition 能力
    d.el.style.transition = 'none';
    d.el.style.transform = `translateY(${Math.round(oldVisualTopC - newTopC)}px) scale(1.02)`;
    void d.el.offsetHeight; // 强制回流：起点先落定
    d.el.style.transition = '';
    d.el.style.transform = ''; // 平滑滑进插槽

    // 落盘完整快照（失败不影响界面，下次启动退回默认）
    if (typeof persist === 'function') {
      try { persist(readNavOrderFromDOM(nav)); } catch { /* 落盘失败不阻塞 */ }
    }
  }

  // —— 边缘自动滚动 ——

  function startAutoScroll() {
    const step = () => {
      if (!drag) return;
      const r = nav.getBoundingClientRect();
      const edge = 40;
      let v = 0;
      if (drag.lastClientY < r.top + edge) v = -Math.min(14, Math.max(2, (r.top + edge - drag.lastClientY) / 2.5));
      else if (drag.lastClientY > r.bottom - edge) v = Math.min(14, Math.max(2, (drag.lastClientY - (r.bottom - edge)) / 2.5));
      if (v) nav.scrollTop += v;
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }
  function stopAutoScroll() { cancelAnimationFrame(rafId); }

  // —— footer 接线 ——

  if (btnSortReset) {
    btnSortReset.addEventListener('click', () => {
      if (typeof resetOrder === 'function') resetOrder();
    });
  }

  return { cancelDrag };
}
