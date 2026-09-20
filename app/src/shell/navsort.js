// 导航手动排序（v2.6.0，见 spec/modules/toolkit.md「导航手动排序」）
// 分两部分：
//  ① 纯逻辑（computeNavPlan / pickStartupTool / readNavOrderFromDOM 的数据净化）——不依赖 DOM，node 单测直接跑；
//  ② 排序模式交互（createNavSort）——Pointer Events 自绘拖拽：
//     被拖条目升起玻璃卡跟随指针，同级兄弟用 transform 平滑让位，松手按视觉序重排 DOM 后落盘。
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
//  - pointerup 后浏览器仍会派发 click，切换工具/折叠分组的守卫在 shell.js 的 click 入口（不能只靠阈值）。
//
// 排序会话的展开/折叠（v2.7.0，用户反馈「排序时全部展开太乱」）：
//  - 进入排序默认**全部收起**（一屏标题，整洁）；点分组标题可随时展开某一组去排它的内部工具；
//  - 会话内的展开/收起状态由 shell 的 sortSessionCollapsed 持有（不写用户偏好）：
//    重渲染（如「恢复默认顺序」）后按会话状态复位，用户展开的组不会被收回去；
//  - 退出排序时丢掉会话状态，按 settings.collapsedGroups 原样恢复用户自己的偏好。

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
 * 排序模式交互控制器（shell.js 持有唯一实例）。
 * @param {Object} options
 *   - nav：.tool-nav 元素（拖拽发生在它内部，滚动跟随它）
 *   - persist(order)：拖放成功后落盘（shell 传 settings.updateSettings）
 *   - resetOrder()：恢复默认顺序（清 navOrder + 重渲染；排序模式保持开启）
 *   - enterView()：进入排序时的视图准备（shell 传「全部收起」——保持整洁；要排某组内部再点标题展开）
 *   - exitView()：退出时恢复用户自己的折叠偏好（并丢掉排序会话的折叠状态）
 *   - onGroupHeadTap(groupId)：排序中「轻点分组标题」（拖动＝整组移动，轻点＝展开/收起这一组）
 *   - onStatus(text)：状态栏反馈（可选）
 * @returns { isActive, toggle, exit, cancelDrag }
 */
export function createNavSort({ nav, persist, resetOrder, enterView, exitView, onGroupHeadTap, onStatus }) {
  const btnSort = document.getElementById('btnSort');
  const btnSortDone = document.getElementById('btnSortDone');
  const btnSortReset = document.getElementById('btnSortReset');
  const sortHint = document.getElementById('sortHint');
  const btnSettings = document.getElementById('btnSettings');
  const btnHelp = document.getElementById('btnHelp');

  let active = false;
  /** 待定按下（未超过移动阈值，可能只是点击）；一旦超阈值升级成 drag */
  let pending = null;
  /** 进行中的拖拽状态（见文件头注释） */
  let drag = null;
  let rafId = 0;

  const isActive = () => active;

  // —— 进入 / 退出 ——

  function enter() {
    if (active) return;
    active = true;
    nav.classList.add('is-sorting');
    btnSort.hidden = btnSettings.hidden = btnHelp.hidden = true;
    sortHint.hidden = btnSortDone.hidden = btnSortReset.hidden = false;
    // 进入排序的视图准备：默认把分组全部收起（用户要求：一屏标题、整洁有序），
    // 想排某一组内部工具时点它的标题展开即可（见 onGroupHeadTap）。
    if (typeof enterView === 'function') enterView();
    document.addEventListener('keydown', onKeydown);
    if (typeof onStatus === 'function') onStatus('排序模式：拖标题移动整个分组，点标题展开后可拖动组内工具（Esc 退出）');
  }

  function exit() {
    if (!active) return;
    cancelDrag();
    active = false;
    nav.classList.remove('is-sorting');
    btnSort.hidden = btnSettings.hidden = btnHelp.hidden = false;
    sortHint.hidden = btnSortDone.hidden = btnSortReset.hidden = true;
    document.removeEventListener('keydown', onKeydown);
    // 退出排序：丢掉本次会话的折叠状态，回到用户自己的展开/折叠偏好
    if (typeof exitView === 'function') exitView();
    if (typeof onStatus === 'function') onStatus('已完成排序');
  }

  function toggle() { if (active) exit(); else enter(); }

  function onKeydown(event) {
    if (event.key !== 'Escape') return;
    if (drag) cancelDrag(); // 正在拖：先取消这次拖拽，下一次 Esc 才退出排序模式
    else exit();
  }

  /**
   * 结束任何进行中的拖拽（不退出排序模式）。
   * 用途：renderNav 重建 DOM 前的防御（导入设置等路径），避免带着拖拽状态重建。
   */
  function cancelDrag() {
    if (pending) { detachWindowListeners(); pending = null; return; }
    if (!drag) return;
    const d = drag;
    drag = null;
    stopAutoScroll();
    nav.classList.remove('is-drag-active'); // 交还给 CSS：组容器恢复 overflow:hidden（折叠动画要用）
    nav.removeEventListener('scroll', onNavScroll);
    for (const m of d.sibMeta) m.el.style.transform = '';
    d.el.classList.remove('is-dragging');
    // 取消：从当前位置平滑落回原位（布局没动过，直接清 transform 就是动画）
    d.el.style.transform = '';
  }

  // —— 指针拖拽 ——

  nav.addEventListener('pointerdown', (event) => {
    if (!active || event.button !== 0 || drag || pending) return;
    const item = event.target.closest('.tool-item');
    const head = event.target.closest('.tool-group-head');
    let el = null;
    let kind = null;
    if (item) { el = item; kind = 'tool'; }               // 工具条目：组内拖
    else if (head) { el = head.closest('.tool-group'); kind = 'group'; } // 分组头：整组拖
    if (!el || !nav.contains(el)) return;
    event.preventDefault(); // 防文本选中；click 守卫在 shell.js 的 click 入口（这里拦不住 click）
    // isHead：轻点（未越过阈值就松手）时用来区分「点标题＝展开/收起这一组」与「点工具条目＝什么都不做」
    pending = { el, kind, isHead: !!head, groupId: el.dataset.groupId, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    window.addEventListener('pointermove', onWindowMove);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('pointercancel', onWindowCancel);
  });

  function detachWindowListeners() {
    window.removeEventListener('pointermove', onWindowMove);
    window.removeEventListener('pointerup', onWindowUp);
    window.removeEventListener('pointercancel', onWindowCancel);
  }

  function onWindowMove(event) {
    if (pending && !drag) {
      // 4px 阈值：区分「真拖拽」与「原地点击」
      if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 4) return;
      beginDrag(event);
    }
    if (drag) applyTransform(event);
  }

  function onWindowUp(event) {
    if (pending && !drag) {
      // 没拖起来的「轻点」：分组标题＝展开/收起这一组（排序中要排某组内部工具，就得先点开它）；
      // 工具条目＝什么都不做（切换工具的 click 由 shell.js 的守卫挡掉）。拖动才是排序，见 beginDrag。
      const p = pending;
      detachWindowListeners();
      pending = null;
      if (p.isHead && typeof onGroupHeadTap === 'function') onGroupHeadTap(p.groupId);
      return;
    }
    if (!drag) return;
    applyTransform(event); // 用最终指针位置定 k
    finishDrag(true);
  }

  function onWindowCancel() { cancelDrag(); }

  function beginDrag(event) {
    const { el, kind } = pending;
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
    // 兄弟间距（让位偏移 = 被拖高度 + 间距）：从相邻两个兄弟量出来
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
    el.classList.add('is-dragging');
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

  function finishDrag(commit) {
    const d = drag;
    drag = null;
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

  if (btnSort) btnSort.addEventListener('click', toggle);
  if (btnSortDone) btnSortDone.addEventListener('click', exit);
  if (btnSortReset) {
    btnSortReset.addEventListener('click', () => {
      if (typeof resetOrder === 'function') resetOrder();
    });
  }

  return { isActive, toggle, exit, cancelDrag };
}
