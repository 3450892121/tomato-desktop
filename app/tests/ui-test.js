// 界面自动测试（仅 `electron . --ui-test` 时运行）
// 作用：像真人一样点按钮，走完整流程（选图 → 混淆 → 保存 → 还原 → 批量 → 清空），
//      每一步截图留证，并对结果做像素级校验。
// 说明：测试模式下「添加图片」对话框直接返回测试目录里的图片，避免需要人手动选文件。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { app } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 渲染进程内：读取预览画布并做简易校验和 */
const CANVAS_CHECKSUM = `(() => {
  const c = document.getElementById('previewCanvas');
  if (!c || c.hidden) return { ok: false, reason: '预览画布不可见' };
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 7) { h ^= d[i]; h = Math.imul(h, 16777619) >>> 0; }
  return { ok: true, w: c.width, h: c.height, sum: h };
})()`;

async function runUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [] };

  await fs.mkdir(TEST_DIR, { recursive: true });

  // 本测试会改动 settings.json（画质 / 输出目录 / 折叠 / 排序 / 恢复默认）；
  // 产物 userdata 里可能放着用户自己的设置（打包时从上一版迁移过来的），先在内存里留一份原文，收尾原样写回。
  const settingsFile = path.join(
    app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..'),
    'userdata',
    'settings.json'
  );
  const settingsBefore = await fs.readFile(settingsFile, 'utf8').catch(() => null);

  // 清理上次运行留下的测试图片，保证重复运行结果干净
  // 注意：要清掉「所有」以 测试原图 开头的文件（不限扩展名）——媒体工具测试会留下 .webp 等，
  //       它们同样会被「添加图片」选中，导致张数校验失败（踩过一次）。
  const existing = await fs.readdir(TEST_DIR).catch(() => []);
  for (const f of existing) {
    if (f.startsWith('测试原图')) {
      await fs.rm(path.join(TEST_DIR, f), { recursive: true, force: true });
    }
  }

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-${name}.png`);
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        win.show();
        win.focus();
        if (wc.setBackgroundThrottling) wc.setBackgroundThrottling(false);
        await wait(200);
        const image = await wc.capturePage();
        if (image && !image.isEmpty()) {
          await fs.writeFile(file, image.toPNG());
          result.shots.push(file);
          return true;
        }
        lastErr = new Error('截图为空');
      } catch (err) {
        lastErr = err;
        await wait(400);
      }
    }
    result.shotErrors = result.shotErrors || [];
    result.shotErrors.push(`${name}: ${lastErr ? lastErr.message : '未知错误'}`);
    return false;
  };

  // 0) 初始界面
  await shot('01-初始');
  result.steps.initialStatus = await evalJs('document.getElementById("statusText").textContent');

  // 0b) 归位到「图片混淆」页（v2.7.1）：启动默认工具可能不是它——用户排过序时启动打开的是
  //     「排最前分组的第一个工具」（见 spec/modules/toolkit.md「启动默认工具」）。
  //     本测试的界面检查与主流程都以图片混淆为主工具，先切回来，避免受用户排序影响。
  result.steps.startupPage = await evalJs(`(() => {
    const active = document.querySelector('.tool-item.is-active');
    const id = active ? active.dataset.toolId : '';
    const btn = [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === 'obfuscate');
    if (id !== 'obfuscate' && btn) btn.click();
    return id;
  })()`);
  await wait(600);

  // 元素显隐自检：进度遮罩必须默认隐藏（曾因 CSS 覆盖 hidden 导致整屏发白）
  result.checks.initialVisibility = await evalJs(`(() => {
    const shown = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return 'missing';
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && !el.hidden;
    };
    return {
      progress: shown('#progressBar'),
      thumbs: shown('#thumbStrip'),
      addButton: shown('#btnAddFirst'),
      modeControl: shown('#modeSelect')
    };
  })()`);

  // 1) 生成两张测试原图并落盘（走真实保存通道）
  const seedDir = TEST_DIR;
  result.steps.seed = await evalJs(`(async () => {
    const { encodeImageToBytes } = await import('../shared/imageio.js');
    const mk = async (w, h, name, tint) => {
      const px = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = (x + y * w) * 4;
        px[p] = Math.round((x / (w - 1)) * 255);
        px[p + 1] = Math.round((y / (h - 1)) * 255);
        px[p + 2] = ((x >> 4) + (y >> 4)) % 2 ? 200 : 80;
        px[p + 3] = 255;
        if (tint) { px[p] = 255 - px[p]; }
      }
      const bytes = await encodeImageToBytes(px, w, h, { format: 'png' });
      return window.desktop.saveImageNextTo({
        sourcePath: ${JSON.stringify(path.join(seedDir, 'seed.png'))},
        baseName: name, ext: '.png', bytes
      });
    };
    return [await mk(120, 80, '测试原图A', false), await mk(100, 50, '测试原图B', true)];
  })()`);

  // 2) 点击「添加图片」（测试模式下直接载入测试目录的图片）
  await evalJs('document.getElementById("btnAddFirst").click()');
  await wait(900);
  await shot('02-已载入图片');
  result.steps.afterAdd = await evalJs(`JSON.stringify({
    status: document.getElementById('statusText').textContent,
    thumbs: document.querySelectorAll('#thumbList .thumb').length,
    stripVisible: !document.getElementById('thumbStrip').hidden,
    info: document.getElementById('infoText').textContent
  })`);
  result.checks.originalCanvas = await evalJs(CANVAS_CHECKSUM);
  // 载入图片后：「添加图片」大按钮与进度遮罩都应隐藏，缩略图条应出现
  result.checks.afterAddVisibility = await evalJs(`(() => {
    const shown = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return 'missing';
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && !el.hidden;
    };
    return { addButton: shown('#btnAddFirst'), progress: shown('#progressBar'), thumbs: shown('#thumbStrip') };
  })()`);

  // 2.5) 页面状态保持：切到别的工具再切回来，已选图片/当前图预览/顶栏提示都不应丢或被重置
  result.checks.stateKeep = JSON.parse(await evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const nav = (id) => [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === id);
    const canvas = document.getElementById('previewCanvas');
    const before = {
      thumbs: document.querySelectorAll('#thumbList .thumb').length,
      canvasW: canvas.width,
      canvasH: canvas.height,
      status: document.getElementById('statusText').textContent
    };
    nav('compress').click();
    await wait(700);
    const away = {
      activePage: (document.querySelector('.tool-page.is-active') || { dataset: {} }).dataset.toolId || '',
      obfuscateDetached: !document.querySelector('.tool-page[data-tool-id="obfuscate"]')
    };
    nav('obfuscate').click();
    await wait(700);
    const back = {
      thumbs: document.querySelectorAll('#thumbList .thumb').length,
      canvasW: canvas.width,
      canvasH: canvas.height,
      status: document.getElementById('statusText').textContent
    };
    // 状态不只是「看得见」还要「还能用」：点一次「还原」，工具内部状态应照常响应
    document.querySelector('[data-action="revert"]').click();
    await wait(400);
    const afterAction = document.getElementById('statusText').textContent;
    return JSON.stringify({
      ok: before.thumbs === 2 && back.thumbs === before.thumbs
        && back.canvasW === before.canvasW && back.canvasH === before.canvasH
        && back.status === before.status
        && away.activePage === 'compress'
        && afterAction.includes('还原'),
      before, away, back, afterAction
    });
  })()`));
  await shot('02b-切走再切回');

  // 2.6) 左侧导航在切换工具时「不重建、不闪」：用户反馈过「子项先折叠再打开 + 闪烁」
  //     断言：切换前后是同一批 DOM（没重建）、所在分组一次都没被收起、items 没被写内联 max-height
  result.checks.navStable = JSON.parse(await evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const nav = (id) => [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === id);
    const btn = nav('obfuscate');
    const group = btn.closest('.tool-group');
    const items = group.querySelector('.tool-group-items');
    const events = [];
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList' && r.removedNodes.length) events.push('removed:' + r.removedNodes.length);
        if (r.type === 'attributes' && r.target === group && group.classList.contains('is-collapsed')) events.push('collapsed');
        if (r.type === 'attributes' && r.target === items && r.target.style.maxHeight) events.push('maxHeight:' + r.target.style.maxHeight);
      }
    });
    obs.observe(group, { attributes: true, attributeFilter: ['class', 'style'], subtree: true, childList: true });
    nav('compress').click();
    await wait(500);
    const alive = btn.isConnected;                                  // 旧按钮还在文档里 => 导航没被重建
    const activeNow = (document.querySelector('.tool-item.is-active') || { dataset: {} }).dataset.toolId;
    nav('obfuscate').click();
    await wait(500);
    obs.disconnect();
    return JSON.stringify({ ok: alive && events.length === 0 && activeNow === 'compress', alive, activeNow, events });
  })()`));

  // 2.7) 侧栏不能把工具条目藏起来（用户反馈「有些地方被挡住了」）：
  //     四个分组全展开时列表必须能滚动，且底部「设置/帮助」不能压住最后一个工具
  // 先把四个分组全部展开，留一张截图（人工过目：条目没被底部按钮压住、滚得动）
  await evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const h of document.querySelectorAll('.tool-group-head')) {
      if (h.closest('.tool-group').classList.contains('is-collapsed')) { h.click(); await wait(340); }
    }
    return true;
  })()`);
  await shot('02c-侧栏全展开');
  result.checks.navScrollable = JSON.parse(await evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const nav = document.getElementById('toolNav');
    const footer = document.querySelector('.sidebar-footer');
    const navRect = nav.getBoundingClientRect();
    const footRect = footer.getBoundingClientRect();
    const overlap = Math.max(0, navRect.bottom - footRect.top); // 列表与底部按钮的重叠高度
    const items = [...document.querySelectorAll('#toolNav .tool-item')];
    const last = items[items.length - 1];
    last.scrollIntoView({ block: 'nearest' });
    await wait(150);
    const lastRect = last.getBoundingClientRect();
    const reachable = lastRect.top >= navRect.top - 1 && lastRect.bottom <= navRect.bottom + 1;
    const info = {
      overflowY: getComputedStyle(nav).overflowY,
      overlapPx: Math.round(overlap),
      items: items.length,
      scrollable: nav.scrollHeight > nav.clientHeight,
      reachable
    };
    // 收尾：把分组点回收起（回到「默认全收起」，不给后面的步骤留满屏列表）
    for (const h of document.querySelectorAll('.tool-group-head')) {
      if (!h.closest('.tool-group').classList.contains('is-collapsed')) { h.click(); await wait(340); }
    }
    return JSON.stringify({ ok: info.overflowY === 'auto' && overlap < 2 && items.length >= 17 && reachable, ...info });
  })()`));

  // 2.8) 导航手动排序（v2.11.0 起长按条目拖动，无排序模式）：
  //      点标题展开某组（快速点击照常）→ 长按拖工具（组内）→ 拖后 click 被拦 → 长按拖分组（整组）
  //      → 按压未满长按就移动＝放弃 → 「恢复默认顺序」按钮显隐与清空。
  //      断言只看静态 DOM 序、折叠类与内存 navOrder/collapsedGroups，不看过渡中间态（防时序 flaky）。
  //      拖拽用合成 PointerEvent：untrusted 事件自家监听器照收；setPointerCapture 在 navsort.js 里
  //      是 try/catch 增强（合成指针会抛 NotFoundError），正确性不依赖它。分多段执行，中间截图。
  const sortStage = (code) => evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const S = window.__navsortTest = window.__navsortTest || {};
    ${code}
  })()`);
  result.checks.navSort = JSON.parse(await sortStage(`
    const nav = document.getElementById('toolNav');
    const { getSettings } = await import('../shared/settings.js');
    const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 9, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y
    }));
    S.nav = nav; S.getSettings = getSettings; S.fire = fire;
    S.groupWraps = () => [...nav.querySelectorAll(':scope > .tool-group')];
    S.wrapOf = (gid) => nav.querySelector('.tool-group[data-group-id="' + gid + '"]');
    S.isCollapsed = (gid) => S.wrapOf(gid).classList.contains('is-collapsed');
    S.toolIds = (gid) => [...nav.querySelectorAll('.tool-group[data-group-id="' + gid + '"] .tool-item')].map((b) => b.dataset.toolId);
    S.activeId = () => (document.querySelector('.tool-item.is-active') || { dataset: {} }).dataset.toolId || '';
    const out = S.out = {};
    S.prefBefore = JSON.stringify(S.getSettings().collapsedGroups);
    S.activeBefore = S.activeId();
    out.resetHiddenInitially = document.getElementById('btnSortReset').hidden; // 没排过序 → 藏着

    // —— 快速点分组标题：照常展开这一组（并写偏好）——长按拖动不该影响原有点击
    const imgHead = S.wrapOf('image').querySelector('.tool-group-head');
    const hr = imgHead.getBoundingClientRect();
    S.fire(imgHead, 'pointerdown', hr.left + 10, hr.top + hr.height / 2);
    S.fire(imgHead, 'pointerup', hr.left + 10, hr.top + hr.height / 2);
    imgHead.click(); // 真实浏览器在 pointerup 后会派发 click；合成事件要手动补一发
    await wait(520);
    out.headTap = {
      imageExpanded: !S.isCollapsed('image'),
      persisted: JSON.stringify(S.getSettings().collapsedGroups) !== S.prefBefore
    };
    return JSON.stringify(out);
  `));
  await shot('02d-排序-展开一组');
  result.checks.navSort = Object.assign(result.checks.navSort, JSON.parse(await sortStage(`
    const out = S.out;
    // —— 长按组内工具拖动：把图片组第 1 个工具拖到第 3 位（k=2）——
    const imageBefore = S.toolIds('image');
    const dragEl = S.nav.querySelector('.tool-item[data-tool-id="' + imageBefore[0] + '"]');
    const r0 = dragEl.getBoundingClientRect();
    // 目标：被拖块中心越过第 2 个兄弟（items[2]）的中心、未越过第 3 个（items[3]）→ 取两者中点最稳
    const items = [...S.nav.querySelectorAll('.tool-group[data-group-id="image"] .tool-item')];
    const c2 = items[2].getBoundingClientRect();
    const c3 = items[3].getBoundingClientRect();
    const targetY = (c2.top + c2.height / 2 + c3.top + c3.height / 2) / 2;
    S.fire(dragEl, 'pointerdown', r0.left + 12, r0.top + r0.height / 2);
    await wait(500); // 越过长按阈值 400ms：到时即拿起
    out.liftOnLongPress = dragEl.classList.contains('is-dragging');
    out.dragActiveClass = S.nav.classList.contains('is-drag-active'); // 拖拽中放开组容器裁剪
    const steps = 7;
    for (let i = 1; i <= steps; i++) {
      S.fire(dragEl, 'pointermove', r0.left + 12, r0.top + r0.height / 2 + (targetY - r0.top - r0.height / 2) * i / steps);
      await wait(40);
    }
    S.fire(dragEl, 'pointerup', r0.left + 12, targetY);
    await wait(400); // 落位动画 + 落盘（updateSettings 的内存态在 drop 时同步更新）
    const expected = [imageBefore[1], imageBefore[2], imageBefore[0], ...imageBefore.slice(3)];
    const after = S.toolIds('image');
    out.toolDragOk = imageBefore.length >= 4 && JSON.stringify(after) === JSON.stringify(expected);
    out.toolOrderSaved = !!S.getSettings().navOrder
      && JSON.stringify(S.getSettings().navOrder.tools.image) === JSON.stringify(after);
    out.dragEnded = !dragEl.classList.contains('is-dragging');
    out.resetShownAfterDrag = !document.getElementById('btnSortReset').hidden; // 排过序 → 按钮出现
    // 拖完 500ms 内的 click 必须被拦下：不切走工具（真实指针拖完浏览器会派发 click，这里手动补一发）
    S.nav.querySelector('.tool-item[data-tool-id="' + imageBefore[1] + '"]').click();
    await wait(150);
    out.clickAfterDragSuppressed = S.activeId() === S.activeBefore;
    return JSON.stringify({ liftOnLongPress: out.liftOnLongPress, dragActiveClass: out.dragActiveClass,
      toolDragOk: out.toolDragOk, toolOrderSaved: out.toolOrderSaved, dragEnded: out.dragEnded,
      resetShownAfterDrag: out.resetShownAfterDrag, clickAfterDragSuppressed: out.clickAfterDragSuppressed });
  `)));
  await shot('02e-排序-长按拖工具后');
  result.checks.navSort = Object.assign(result.checks.navSort, JSON.parse(await sortStage(`
    const out = S.out;
    // —— 长按分组头拖动：把「视频」组整组拖到「图片」组前面（k=0）——
    // 图片组此刻是展开的（兄弟高度不齐）：顺带验证让位对高度不齐的兄弟也正确
    const groupsBefore = S.groupWraps().map((g) => g.dataset.groupId);
    const videoHead = S.wrapOf('video').querySelector('.tool-group-head');
    const rw = S.wrapOf('video').getBoundingClientRect();
    const rv = videoHead.getBoundingClientRect();
    const ri = S.wrapOf('image').getBoundingClientRect();
    S.fire(videoHead, 'pointerdown', rv.left + 10, rv.top + rv.height / 2);
    await wait(500); // 越过长按阈值
    out.groupLifted = S.wrapOf('video').classList.contains('is-dragging');
    // 整组块很高：拖到图片组上方足够远处，保证「视频块中心」越过「图片块中心」
    const gTargetY = ri.top - Math.round(rw.height / 2) - 30;
    const steps = 7;
    for (let i = 1; i <= steps; i++) {
      S.fire(videoHead, 'pointermove', rv.left + 10, rv.top + rv.height / 2 + (gTargetY - rv.top - rv.height / 2) * i / steps);
      await wait(40);
    }
    S.fire(videoHead, 'pointerup', rv.left + 10, gTargetY);
    await wait(400);
    const after = S.groupWraps().map((g) => g.dataset.groupId);
    const firstIdx = groupsBefore.indexOf('video');
    const expected = ['video', ...groupsBefore.slice(0, firstIdx), ...groupsBefore.slice(firstIdx + 1)];
    out.groupDragOk = JSON.stringify(after) === JSON.stringify(expected);
    out.groupOrderSaved = !!S.getSettings().navOrder
      && JSON.stringify(S.getSettings().navOrder.groups) === JSON.stringify(after.filter((id) => id !== 'other'));
    return JSON.stringify({ groupLifted: out.groupLifted, groupDragOk: out.groupDragOk, groupOrderSaved: out.groupOrderSaved });
  `)));
  await shot('02f-排序-拖分组后');
  result.checks.navSort = Object.assign(result.checks.navSort, JSON.parse(await sortStage(`
    const out = S.out;
    // —— 按压未满长按时间就移动（≥4px）：放弃按压，不进入拖拽，click 照常可用 ——
    const toolsBefore = S.toolIds('image');
    const groupsBefore = S.groupWraps().map((g) => g.dataset.groupId);
    const tapEl = S.nav.querySelector('.tool-item[data-tool-id="compress"]');
    const rt = tapEl.getBoundingClientRect();
    S.fire(tapEl, 'pointerdown', rt.left + 12, rt.top + rt.height / 2);
    await wait(80); // 远小于 400ms
    S.fire(tapEl, 'pointermove', rt.left + 12, rt.top + rt.height / 2 + 14);
    await wait(60);
    out.noDragOnEarlyMove = !tapEl.classList.contains('is-dragging');
    S.fire(tapEl, 'pointerup', rt.left + 12, rt.top + rt.height / 2 + 14);
    await wait(300);
    out.orderUntouched = JSON.stringify(S.toolIds('image')) === JSON.stringify(toolsBefore)
      && JSON.stringify(S.groupWraps().map((g) => g.dataset.groupId)) === JSON.stringify(groupsBefore);
    // 时间窗外（距拖拽结束已远）点击照常切换工具；随后切回原工具
    tapEl.click();
    await wait(500);
    out.clickWorksAgain = (document.querySelector('.tool-page.is-active') || { dataset: {} }).dataset.toolId === 'compress';
    const back = [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === S.activeBefore);
    back.click();
    await wait(500);

    // —— 「↺ 恢复默认顺序」：navOrder 清 null、DOM 回默认序、按钮重新藏起来 ——
    document.getElementById('btnSortReset').click();
    await wait(400);
    out.reset = {
      navOrderNull: S.getSettings().navOrder === null,
      firstGroupIsImage: S.groupWraps()[0].dataset.groupId === 'image',
      resetHiddenAgain: document.getElementById('btnSortReset').hidden
    };
    return JSON.stringify({ noDragOnEarlyMove: out.noDragOnEarlyMove, orderUntouched: out.orderUntouched,
      clickWorksAgain: out.clickWorksAgain, reset: out.reset });
  `)));
  await shot('02g-排序-恢复默认后');

  // 收尾：不留排序痕迹给后续步骤——把「图片」组点回收起、折叠偏好与 navOrder 复原
  await sortStage(`
    const imgHead = S.wrapOf('image').querySelector('.tool-group-head');
    const hr = imgHead.getBoundingClientRect();
    S.fire(imgHead, 'pointerdown', hr.left + 10, hr.top + hr.height / 2);
    S.fire(imgHead, 'pointerup', hr.left + 10, hr.top + hr.height / 2);
    imgHead.click(); // 真实浏览器在 pointerup 后会派发 click；合成事件要手动补一发
    await wait(520);
    const { updateSettings } = await import('../shared/settings.js');
    if (JSON.stringify(S.getSettings().collapsedGroups) !== S.prefBefore) {
      await updateSettings({ collapsedGroups: JSON.parse(S.prefBefore) });
    }
    if (S.getSettings().navOrder !== null) await updateSettings({ navOrder: null });
    delete window.__navsortTest;
    return JSON.stringify({ collapsedAgain: S.isCollapsed('image'), navOrderNull: S.getSettings().navOrder === null });
  `);

  await evalJs(`(() => {
    const sel = document.getElementById('modeSelect');
    sel.value = 'c';
    sel.dispatchEvent(new Event('change'));
    const key = document.getElementById('keyInput');
    key.value = '测试密钥abc';
    key.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await wait(200);

  // 4) 点击「混淆」（当前图）
  await evalJs(`document.querySelector('[data-action="obfuscate"]').click()`);
  await wait(700);
  await shot('03-混淆后');
  result.steps.afterObfuscate = await evalJs('document.getElementById("statusText").textContent');
  result.checks.obfuscatedCanvas = await evalJs(CANVAS_CHECKSUM);
  result.checks.obfuscatedDiffers = result.checks.originalCanvas.sum !== result.checks.obfuscatedCanvas.sum;

  // 5) 点击「保存」（当前图）
  await evalJs(`document.querySelector('[data-action="save"]').click()`);
  await wait(1200);
  await shot('04-保存后');
  result.steps.afterSave = await evalJs('document.getElementById("statusText").textContent');
  result.steps.filesAfterSave = (await fs.readdir(TEST_DIR)).filter((f) => f.startsWith('测试原图A')).sort();

  // 6) 点击「还原」→ 应回到原图
  await evalJs(`document.querySelector('[data-action="revert"]').click()`);
  await wait(400);
  await shot('05-还原后');
  result.checks.revertedCanvas = await evalJs(CANVAS_CHECKSUM);
  result.checks.revertEqualsOriginal = result.checks.revertedCanvas.sum === result.checks.originalCanvas.sum;

  // 7) 全部混淆 + 全部保存（批量）
  await evalJs(`document.querySelector('[data-action="batch-obfuscate"]').click()`);
  await wait(900);
  result.steps.afterBatchObfuscate = await evalJs('document.getElementById("statusText").textContent');
  await evalJs(`document.querySelector('[data-action="batch-save"]').click()`);
  await wait(1600);
  result.steps.afterBatchSave = await evalJs('document.getElementById("statusText").textContent');
  await shot('06-批量保存后');
  result.steps.allFiles = (await fs.readdir(TEST_DIR)).filter((f) => f.endsWith('.png') || f.endsWith('.jpg')).sort();

  // 8) 校验保存出来的文件能被解回原图（像素级）
  const savedA = result.steps.filesAfterSave.find((f) => f.includes('_混淆')) || '';
  result.checks.decodeSavedFile = await evalJs(`(async () => {
    const { decodeImageFromBytes } = await import('../shared/imageio.js');
    const { processPixels } = await import('../tools/obfuscate/core/engine.js');
    const bytes = await window.desktop.readFile(${JSON.stringify(path.join(TEST_DIR, savedA || ''))});
    const img = await decodeImageFromBytes(bytes);
    const back = processPixels({ mode: 'c', key: '测试密钥abc', direction: 'decrypt', width: img.width, height: img.height, pixels: img.pixels });
    let h = 2166136261;
    for (let i = 0; i < back.pixels.length; i += 7) { h ^= back.pixels[i]; h = Math.imul(h, 16777619) >>> 0; }
    return { file: ${JSON.stringify(savedA)}, w: back.width, h: back.height, sum: h };
  })()`);

  // 9) gilbert 模式：密钥行应隐藏；PE1：密钥行显示且提示小数
  result.checks.keyRowByMode = await evalJs(`(() => {
    const sel = document.getElementById('modeSelect');
    const row = document.getElementById('keyRow');
    const hint = document.getElementById('keyHint');
    const out = {};
    sel.value = 'gilbert'; sel.dispatchEvent(new Event('change'));
    out.gilbertHidden = row.hidden;
    sel.value = 'pe1'; sel.dispatchEvent(new Event('change'));
    out.pe1Hidden = row.hidden;
    out.pe1Hint = hint.textContent;
    out.pe1Value = document.getElementById('keyInput').value;
    return out;
  })()`);
  await shot('07-切到PE1模式');

  // 10) 设置面板：打开 → 改 JPG 画质 → 保存 → 校验落盘 → 恢复默认
  await evalJs('document.getElementById("btnSettings").click()');
  await wait(300);
  await shot('09-设置面板');
  result.checks.settingsModal = await evalJs(`(() => ({
    open: !!document.querySelector('.modal-backdrop'),
    title: document.querySelector('.modal-title') ? document.querySelector('.modal-title').textContent : '',
    missingFields: ['#setBlockSize','#setJpegQuality','#setDefaultKey','#setOutputDir','#setAskSavePath']
      .filter((s) => !document.querySelector(s))
  }))()`);

  // 输出目录：点「选择文件夹…」应弹出系统选择框并把路径填进输入框（测试模式下返回测试目录）
  result.steps.outputDirPick = await evalJs(`(async () => {
    document.querySelector('#setOutputDirPick').click();
    await new Promise((r) => setTimeout(r, 700));
    return document.querySelector('#setOutputDir').value + '｜' + document.getElementById('statusText').textContent;
  })()`);

  result.steps.settingsSave = await evalJs(`(async () => {
    document.querySelector('#setJpegQuality').value = '90';
    [...document.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === '保存').click();
    await new Promise((r) => setTimeout(r, 400));
    return document.getElementById('statusText').textContent;
  })()`);
  try {
    result.checks.settingsFileAfterSave = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  } catch (err) {
    result.checks.settingsFileAfterSave = { error: err.message };
  }

  // 恢复默认（保持开发环境干净）
  await evalJs('document.getElementById("btnSettings").click()');
  await wait(250);
  result.steps.settingsReset = await evalJs(`(async () => {
    [...document.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent.includes('恢复默认')).click();
    await new Promise((r) => setTimeout(r, 700));
    const status = document.getElementById('statusText').textContent;
    const closeBtn = [...document.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === '取消');
    if (closeBtn) closeBtn.click();
    // 关闭带一小段淡出动画（约 120ms）后移除，这里等足再数剩余弹窗
    await new Promise((r) => setTimeout(r, 500));
    return status + '｜剩余弹窗数=' + document.querySelectorAll('.modal-backdrop').length;
  })()`);
  try {
    result.checks.settingsFileAfterReset = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  } catch (err) {
    result.checks.settingsFileAfterReset = { error: err.message };
  }

  // 11) 帮助弹窗
  await evalJs('document.getElementById("btnHelp").click()');
  await wait(300);
  await shot('10-帮助');
  result.checks.helpModal = await evalJs(`(() => {
    const modals = document.querySelectorAll('.modal-backdrop');
    const backdrop = modals[modals.length - 1];   // 取最新打开的弹窗
    const title = backdrop ? backdrop.querySelector('.modal-title').textContent : '';
    const sections = backdrop ? backdrop.querySelectorAll('.help-section').length : 0;
    const closeBtn = backdrop ? [...backdrop.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === '知道了') : null;
    if (closeBtn) closeBtn.click();
    return { open: !!backdrop, title, sections, modalCount: modals.length };
  })()`);
  await wait(200);

  // 12) 批量与容错：20 张正常 + 1 张损坏文件
  // 先清掉此前产生的测试图片，保证目录里只有本轮样本
  for (const f of await fs.readdir(TEST_DIR)) {
    if (f.startsWith('测试原图')) await fs.rm(path.join(TEST_DIR, f), { force: true });
  }
  await evalJs(`(async () => {
    const { encodeImageToBytes } = await import('../shared/imageio.js');
    for (let i = 1; i <= 20; i++) {
      const w = 16 + (i % 5), h = 12 + (i % 4);
      const px = new Uint8ClampedArray(w * h * 4);
      for (let p = 0; p < w * h; p++) { px[p * 4] = (p * 13 + i) & 255; px[p * 4 + 1] = (p * 7) & 255; px[p * 4 + 2] = i * 5 & 255; px[p * 4 + 3] = 255; }
      const bytes = await encodeImageToBytes(px, w, h, { format: 'png' });
      await window.desktop.saveImageNextTo({ sourcePath: ${JSON.stringify(path.join(TEST_DIR, 'seed.png'))}, baseName: '测试原图批量' + String(i).padStart(2, '0'), ext: '.png', bytes });
    }
    // 1 张损坏文件（扩展名冒充 png）
    const bad = new TextEncoder().encode('这不是图片');
    await window.desktop.saveImageNextTo({ sourcePath: ${JSON.stringify(path.join(TEST_DIR, 'seed.png'))}, baseName: '测试原图批量21损坏', ext: '.png', bytes: bad });
    return true;
  })()`);

  await evalJs('(() => { window.confirm = () => true; return true; })()');
  await evalJs(`document.querySelector('[data-action="batch-clear"]').click()`);
  await wait(300);
  await evalJs('document.getElementById("btnAddFirst").click()');
  await wait(3000);
  result.steps.batchAdd = await evalJs(`JSON.stringify({
    status: document.getElementById('statusText').textContent,
    thumbs: document.querySelectorAll('#thumbList .thumb').length
  })`);

  await evalJs(`document.querySelector('[data-action="batch-obfuscate"]').click()`);
  await wait(2500);
  result.steps.batchObfuscate20 = await evalJs('document.getElementById("statusText").textContent');
  await shot('11-批量20张');
  await evalJs(`document.querySelector('[data-action="batch-save"]').click()`);
  // 等真正收工再数产物：20 张批量保存在慢一点的机器上会超过固定等待，
  // 固定 sleep 会偶发「文件还没落完」的假失败（断言不变，只是不再抢跑）。
  for (let i = 0; i < 40; i++) {
    const st = await evalJs('document.getElementById("statusText").textContent');
    if (st.includes('保存完成') || st.includes('保存失败')) break;
    await wait(400);
  }
  await wait(300);
  result.steps.batchSave20 = await evalJs('document.getElementById("statusText").textContent');
  result.steps.batchSavedFiles = (await fs.readdir(TEST_DIR)).filter((f) => f.includes('_混淆')).length;

  // 13) 清空（确认框自动确认）
  await evalJs('(() => { window.confirm = () => true; return true; })()');
  await evalJs(`document.querySelector('[data-action="batch-clear"]').click()`);
  await wait(400);
  await shot('08-清空后');
  result.steps.afterClear = await evalJs('document.getElementById("statusText").textContent');
  result.checks.clearedThumbs = await evalJs('document.querySelectorAll("#thumbList .thumb").length');

  // 14) 保活回收的两条规则（用户反馈：只是点开看看不能把别处用过的东西挤掉）
  //     14a) 纯浏览（一个字都没动）不占保活额度：来回切一圈工具后切回，图片列表必须原样还在、不提示「已释放」
  //     14b) 只有「动过」的页超过上限才回收：在这 5 个工具里各动一下 → 最久没用过的图片混淆被释放并提示
  await evalJs('document.getElementById("btnAddFirst").click()');
  await wait(3000);
  result.checks.browseKeepsState = JSON.parse(await evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const nav = (id) => [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === id);
    const before = { thumbs: document.querySelectorAll('#thumbList .thumb').length };
    for (const id of ['compress', 'enhance', 'img-convert', 'video-convert', 'audio-convert']) {
      nav(id).click();
      await wait(600);
    }
    nav('obfuscate').click();
    await wait(800);
    const after = {
      thumbs: document.querySelectorAll('#thumbList .thumb').length,
      status: document.getElementById('statusText').textContent
    };
    return JSON.stringify({
      ok: before.thumbs > 0 && after.thumbs === before.thumbs && !after.status.includes('自动释放'),
      before, after
    });
  })()`));
  await shot('12a-纯浏览后状态仍在');

  result.checks.lruRelease = JSON.parse(await evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const nav = (id) => [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === id);
    const before = { thumbs: document.querySelectorAll('#thumbList .thumb').length };
    // 逐个切过去并在页里点一下（= 用户动过这页）：5 个工具 + 图片混淆 = 6 个「动过」的页，超过保活上限
    for (const id of ['compress', 'enhance', 'img-convert', 'video-convert', 'audio-convert']) {
      nav(id).click();
      await wait(600);
      document.querySelector('.tool-page.is-active').click();
      await wait(200);
    }
    nav('obfuscate').click();
    await wait(800);
    const after = {
      thumbs: document.querySelectorAll('#thumbList .thumb').length,
      addButtonShown: !document.getElementById('btnAddFirst').hidden,
      stripHidden: document.getElementById('thumbStrip').hidden,
      status: document.getElementById('statusText').textContent
    };
    return JSON.stringify({
      ok: before.thumbs > 0 && after.thumbs === 0 && after.addButtonShown === true
        && after.stripHidden === true && after.status.includes('自动释放'),
      before, after
    });
  })()`));
  await shot('12-LRU回收后');

  // 收尾：把测试前读到的设置原文写回——产物 userdata 里可能是用户自己的设置（打包时从上一版迁移来的），
  // 不能被测试改动/「恢复默认」抹掉；开发环境首次跑时没有原文，维持现状即可。
  try {
    if (settingsBefore !== null) await fs.writeFile(settingsFile, settingsBefore, 'utf8');
  } catch (err) {
    result.checks.settingsRestore = { error: err.message };
  }

  // 汇总判定
  const c = result.checks;
  result.pass =
    result.steps.afterAdd.includes('已添加') &&
    c.initialVisibility.progress === false &&
    c.initialVisibility.thumbs === false &&
    c.initialVisibility.addButton === true &&
    c.afterAddVisibility.addButton === false &&
    c.afterAddVisibility.progress === false &&
    c.afterAddVisibility.thumbs === true &&
    c.stateKeep.ok === true &&
    c.navStable.ok === true &&
    c.navScrollable.ok === true &&
    c.navSort.resetHiddenInitially === true &&
    c.navSort.headTap.imageExpanded === true &&
    c.navSort.headTap.persisted === true &&
    c.navSort.liftOnLongPress === true &&
    c.navSort.dragActiveClass === true &&
    c.navSort.toolDragOk === true &&
    c.navSort.toolOrderSaved === true &&
    c.navSort.dragEnded === true &&
    c.navSort.resetShownAfterDrag === true &&
    c.navSort.clickAfterDragSuppressed === true &&
    c.navSort.groupLifted === true &&
    c.navSort.groupDragOk === true &&
    c.navSort.groupOrderSaved === true &&
    c.navSort.noDragOnEarlyMove === true &&
    c.navSort.orderUntouched === true &&
    c.navSort.clickWorksAgain === true &&
    c.navSort.reset.navOrderNull === true &&
    c.navSort.reset.firstGroupIsImage === true &&
    c.navSort.reset.resetHiddenAgain === true &&
    c.obfuscatedDiffers === true &&
    c.revertEqualsOriginal === true &&
    result.steps.filesAfterSave.length >= 1 &&
    result.steps.afterBatchObfuscate.includes('成功 2 张') &&
    c.decodeSavedFile.sum === c.originalCanvas.sum &&
    c.keyRowByMode.gilbertHidden === true &&
    c.keyRowByMode.pe1Hidden === false &&
    c.settingsModal.open === true &&
    c.settingsModal.missingFields.length === 0 &&
    c.settingsFileAfterSave.jpegQuality === 90 &&
    c.settingsFileAfterSave.outputDir === TEST_DIR &&
    result.steps.outputDirPick.startsWith(TEST_DIR) &&
    c.settingsFileAfterReset.jpegQuality === 95 &&
    result.steps.settingsReset.includes('剩余弹窗数=0') &&
    c.helpModal.open === true &&
    c.helpModal.title === '使用帮助' &&
    c.helpModal.sections >= 3 &&
    c.helpModal.modalCount === 1 &&
    JSON.parse(result.steps.batchAdd).status.includes('已添加 20 张图片') &&
    JSON.parse(result.steps.batchAdd).status.includes('1 张失败') &&
    JSON.parse(result.steps.batchAdd).thumbs === 20 &&
    result.steps.batchObfuscate20.includes('成功 20 张') &&
    result.steps.batchSave20.includes('成功 20 张') &&
    result.steps.batchSavedFiles >= 20 &&
    c.clearedThumbs === 0 &&
    c.browseKeepsState.ok === true &&
    c.lruRelease.ok === true;

  return result;
}

module.exports = { runUiTest, TEST_DIR };