// 深色主题自检：`electron . --theme-test`
// 验证：顶栏外观按钮可用、三态循环正确、深浅两套色值真的生效、选择会落盘、
//       深色下所有工具页仍能正常渲染（没有写死浅色的地方漏出来）。
// 结果写入 %TEMP%/tomato-theme-test.json；截图落在 %TEMP%/tomato-uitest。
// 注意：测试会临时改主题，结束时必须恢复用户原来的选择（否则会改掉使用者的设置）。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-theme-test.json');

/** 期望色值（与 theme.css 一一对应；写死在这里是为了防止变量被改坏而测试跟着"一起错"）
    注：自 v2.1.0 起侧栏是磨砂玻璃（半透明），所以断言到具体 rgba。 */
const EXPECT = {
  light: { bg: 'rgb(245, 246, 248)', sidebar: 'rgba(255, 255, 255, 0.34)' },
  dark: { bg: 'rgb(22, 24, 29)', sidebar: 'rgba(24, 27, 33, 0.44)' }
};
/** 档位 → 按钮文字（与 shell.js 的 THEME_MODES 一致） */
const LABELS = { system: '跟随系统', light: '浅色', dark: '深色' };
const CYCLE = ['system', 'light', 'dark'];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 从 rgb()/rgba() 字符串里取 alpha（无 alpha 视为 1，解析不了返回 null） */
function alphaOfCss(color) {
  const m = /rgba?\(\d+,\s*\d+,\s*\d+(?:,\s*([\d.]+))?\)/.exec(color || '');
  if (!m) return null;
  return m[1] === undefined ? 1 : Number(m[1]);
}

function writeResult(payload) {
  try {
    require('fs').writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[theme-test] 结果文件写入失败：', err.message);
  }
  return RESULT_FILE;
}

/** 读取界面外壳的实际颜色（body / 侧栏），用于验证变量覆盖真的生效 */
const SHELL_COLORS = `(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).backgroundColor : null;
  };
  return { bg: pick('body'), sidebar: pick('.sidebar'), topbar: pick('.topbar') };
})()`;

/** 深色下扫描工具页里是否残留「浅色卡片」（写死色值的典型症状） */
const SCAN_LIGHT_CARDS = `(() => {
  const lum = (c) => {
    const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/.exec(c || '');
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) < 0.1) return null; // 全透明不算
    return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
  };
  const page = document.querySelector('.tool-page.is-active');
  if (!page) return { scanned: 0, light: [] };
  const nodes = [...page.querySelectorAll('.card, .toolbar, .panel')];
  const light = [];
  for (const el of nodes) {
    const l = lum(getComputedStyle(el).backgroundColor);
    if (l !== null && l > 0.7) light.push(el.className);
  }
  return { scanned: nodes.length, light };
})()`;

/** 玻璃与选中态探针（v2.1.0）：磨砂玻璃、背景光晕、选中反馈是否真的生效 */
const GLASS_PROBE = `(() => {
  const alphaOf = (c) => {
    const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/.exec(c || '');
    if (!m) return null;
    return m[4] === undefined ? 1 : Number(m[4]);
  };
  const sidebar = document.querySelector('.sidebar');
  const card = document.querySelector('.tool-page.is-active .card');
  const active = document.querySelector('.tool-item.is-active');
  const sidebarStyle = sidebar ? getComputedStyle(sidebar) : null;
  const cardBg = card ? getComputedStyle(card).backgroundColor : '';
  // 选中框是否被裁 / 列表能否横向晃动（用户反馈：选中框右边被切、还能左右挪一点）
  const nav = document.getElementById('toolNav');
  const activeRect = active ? active.getBoundingClientRect() : null;
  const navRect = nav ? nav.getBoundingClientRect() : null;
  const navStyle = nav ? getComputedStyle(nav) : null;
  const padRight = navStyle ? parseFloat(navStyle.paddingRight) || 0 : 0;
  return {
    sidebarBlur: sidebarStyle ? (sidebarStyle.backdropFilter || 'none') : 'none',
    sidebarAlpha: sidebarStyle ? alphaOf(sidebarStyle.backgroundColor) : null,
    aurora: getComputedStyle(document.body).backgroundImage !== 'none',
    cardBg,
    cardAlpha: alphaOf(cardBg),
    activeShadow: active ? getComputedStyle(active).boxShadow : '',
    activeBg: active ? getComputedStyle(active).backgroundColor : '',
    activeBlur: active ? (getComputedStyle(active).backdropFilter || 'none') : 'none',
    navOverflowX: nav ? nav.scrollWidth - nav.clientWidth : null, // >0 = 能左右晃
    // 选中框右边缘到列表内容区右边缘的距离（<0 = 越界被裁）
    activeRightGap: (activeRect && navRect) ? Math.round(navRect.right - padRight - activeRect.right) : null
  };
})()`;

async function runThemeTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, failures: [], shots: [] };

  await fs.mkdir(TEST_DIR, { recursive: true });

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-theme-${name}.png`);
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
      } catch { /* 截图失败重试 */ }
      await wait(400);
    }
    return false;
  };

  const themeNow = () => evalJs('document.documentElement.dataset.theme || ""');
  const labelNow = () => evalJs('document.getElementById("themeLabel").textContent');
  const storedMode = () => evalJs('window.desktop.settingsRead().then((s) => (s && s.theme) || "")');
  const clickTheme = () => evalJs('document.getElementById("btnTheme").click()');

  /** 反复点按钮直到按钮文字等于目标档位（最多 4 次，三态循环必然能到） */
  const clickUntil = async (mode) => {
    for (let i = 0; i < 4; i++) {
      if ((await labelNow()) === LABELS[mode]) return true;
      await clickTheme();
      await wait(240);
    }
    return (await labelNow()) === LABELS[mode];
  };

  // 记住用户原来的选择，结束时恢复
  const originalMode = (await storedMode()) || 'system';
  result.steps.originalMode = originalMode;

  // 1) 顶栏外观按钮存在且可见
  result.checks.buttonVisible = await evalJs(`(() => {
    const b = document.getElementById('btnTheme');
    if (!b) return false;
    const s = getComputedStyle(b);
    return s.display !== 'none' && s.visibility !== 'hidden' && b.offsetParent !== null;
  })()`);
  if (!result.checks.buttonVisible) result.failures.push('顶栏「外观」按钮不存在或不可见');

  // 2) 三态循环：跟随系统 → 浅色 → 深色 → 跟随系统
  await clickUntil(originalMode);
  const cycle = [];
  for (let i = 0; i < 3; i++) {
    await clickTheme();
    await wait(240);
    cycle.push({ label: await labelNow(), theme: await themeNow() });
  }
  result.steps.cycle = cycle;
  const startIdx = CYCLE.indexOf(originalMode);
  const expectSeq = [1, 2, 3].map((n) => CYCLE[(startIdx + n) % 3]);
  const cycleOk = cycle.every((c, i) => c.label === LABELS[expectSeq[i]]);
  result.checks.cycle = cycleOk;
  if (!cycleOk) result.failures.push(`三态循环不符合预期：${JSON.stringify(cycle)}`);

  // 3) 浅色档：外壳色值必须是浅色那套
  await clickUntil('light');
  await wait(220);
  const lightColors = await evalJs(SHELL_COLORS);
  result.steps.lightColors = lightColors;
  result.checks.lightApplied = (await themeNow()) === 'light' &&
    lightColors.bg === EXPECT.light.bg && lightColors.sidebar === EXPECT.light.sidebar;
  if (!result.checks.lightApplied) result.failures.push(`浅色档色值不符：${JSON.stringify(lightColors)}`);
  await shot('01-浅色');

  // 3b) 磨砂玻璃与选中反馈真的生效（v2.1.0：苹果风玻璃 + 一眼能看出选中的是哪个）
  const glass = await evalJs(GLASS_PROBE);
  result.steps.glass = glass;
  result.checks.glass = glass.sidebarBlur !== 'none' && glass.aurora === true &&
    glass.sidebarAlpha !== null && glass.sidebarAlpha < 1 &&
    glass.cardAlpha !== null && glass.cardAlpha < 1;
  if (!result.checks.glass) result.failures.push(`磨砂玻璃未生效：${JSON.stringify(glass)}`);
  result.checks.selectVisible = !!glass.activeShadow && glass.activeShadow !== 'none';
  if (!result.checks.selectVisible) result.failures.push(`当前工具的选中态没有高亮：${JSON.stringify(glass.activeShadow)}`);
  // 3c) 选中块必须是玻璃（半透明底 + 背景模糊），且不能被列表裁掉、列表也不能左右晃
  result.checks.selectGlass = glass.activeBlur !== 'none' &&
    glass.activeBg !== null && alphaOfCss(glass.activeBg) !== null && alphaOfCss(glass.activeBg) < 1;
  if (!result.checks.selectGlass) result.failures.push(`选中块不是玻璃：bg=${glass.activeBg} blur=${glass.activeBlur}`);
  result.checks.selectNotClipped = glass.activeRightGap !== null && glass.activeRightGap >= 0 &&
    glass.navOverflowX !== null && glass.navOverflowX <= 0;
  if (!result.checks.selectNotClipped) {
    result.failures.push(`选中框被裁或列表能横向晃动：右边缘余量=${glass.activeRightGap}px 横向溢出=${glass.navOverflowX}px`);
  }

  // 4) 深色档：外壳色值必须是深色那套
  await clickUntil('dark');
  await wait(220);
  const darkColors = await evalJs(SHELL_COLORS);
  result.steps.darkColors = darkColors;
  result.checks.darkApplied = (await themeNow()) === 'dark' &&
    darkColors.bg === EXPECT.dark.bg && darkColors.sidebar === EXPECT.dark.sidebar;
  if (!result.checks.darkApplied) result.failures.push(`深色档色值不符：${JSON.stringify(darkColors)}`);
  await shot('02-深色');

  // 5) 选择要落盘（换台机器/重开软件仍然记得）
  result.checks.persisted = (await storedMode()) === 'dark';
  if (!result.checks.persisted) result.failures.push('外观选择未写入设置文件');

  // 6) 深色下逐个工具页走一遍：页面能正常渲染，且没有写死浅色的卡片漏出来
  const toolIds = await evalJs('[...document.querySelectorAll(".tool-item")].map((b) => b.dataset.toolId)');
  result.steps.toolCount = toolIds.length;
  const perTool = [];
  for (const id of toolIds) {
    // 分组默认是收起的，先展开所在分组再点（点不到就跳过，不算失败）
    await evalJs(`(() => {
      const btn = document.querySelector('.tool-item[data-tool-id="${id}"]');
      if (!btn) return false;
      if (btn.offsetParent === null) {
        const group = btn.closest('.tool-group');
        const head = group && group.querySelector('.tool-group-head');
        if (head) head.click();
      }
      return true;
    })()`);
    await wait(240);
    const clicked = await evalJs(`(() => {
      const btn = document.querySelector('.tool-item[data-tool-id="${id}"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await wait(320);
    const scan = await evalJs(SCAN_LIGHT_CARDS);
    perTool.push({ id, clicked, ...scan });
    if (scan.light.length) result.failures.push(`${id}：深色下仍有浅色容器 ${JSON.stringify(scan.light)}`);
  }
  result.steps.perTool = perTool;
  result.checks.darkToolsClean = perTool.every((t) => t.light.length === 0);

  // 7) 恢复用户原来的选择（关键：绝不能把使用者的设置改成测试用的深色）
  const restored = await clickUntil(originalMode);
  result.checks.restored = restored && (await storedMode()) === originalMode;
  if (!result.checks.restored) {
    // 兜底：直接写回设置文件（内存态无所谓，进程马上退出）
    await evalJs(`window.desktop.settingsWrite({ theme: ${JSON.stringify(originalMode)} })`);
    result.steps.restoreFallback = true;
  }
  await wait(200);
  await shot('03-恢复');

  result.pass = result.failures.length === 0;
  writeResult({ ok: result.pass, at: new Date().toISOString(), result });
  return result;
}

module.exports = { runThemeTest, writeResult, RESULT_FILE };
