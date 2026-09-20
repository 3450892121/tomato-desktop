// 「文件藏图」工具 —— 界面自动测试
// 用法：cd app && .\node_modules\electron\dist\electron.exe . --imghide-ui-test
// 像真人一样操作：切到工具 → 选表图 → 加要藏的文件 → 打包 → 校验产物
//                → 切到解包页 → 选图夹图 → 解包 → 内容比对 → 密码往返（含错误密码）→ 清空
// 逐步截图 shot-imghide-*.png 落在 %TEMP%\tomato-uitest；结果写 %TEMP%/tomato-imghide-ui-test.json，pass:true 为通过。
//
// 夹具纪律（见 AGENTS.md / 项目教训）：开跑前、收尾后各清一次 %TEMP%\tomato-uitest 里的「测试藏图*」，
// 绝不残留——否则会污染其它工具的界面测试。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-imghide-ui-test.json');
/** 表图夹具（主进程 dialog:open-hide-cover 的桩按此前缀筛选） */
const COVER_NAME = '测试藏图表图封面A.png';
/** 要藏的文件夹具（dialog:open-hide-files 的桩按此前缀筛选） */
const ITEM_A = '测试藏图文件说明.txt';
const ITEM_B = '测试藏图文件数据.bin';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeResult(payload) {
  try {
    fsSync.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[imghide-ui-test] 结果文件写入失败：', err.message);
  }
  return RESULT_FILE;
}

async function pollUntil(fn, timeoutMs, intervalMs = 400) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await wait(intervalMs);
  }
}

/** 删掉测试目录里本工具的产物（只删「_图夹」命名的，不碰夹具与别的工具） */
async function cleanProducts(exceptPath = '') {
  const removed = [];
  for (const name of await fs.readdir(TEST_DIR).catch(() => [])) {
    if (!/_图夹(\(\d+\))?\.(png|gif)$/i.test(name)) continue;
    const full = path.join(TEST_DIR, name);
    if (exceptPath && path.normalize(full) === path.normalize(exceptPath)) continue;
    await fs.rm(full, { force: true }).catch(() => {});
    removed.push(name);
  }
  return removed;
}

/**
 * 跑「文件藏图」界面自动测试
 * @param {import('electron').BrowserWindow} win
 * @param {{portableDir?: string}} [options]
 */
async function runImgHideUiTest(win, options = {}) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [], failures: [] };
  const fail = (msg) => {
    result.failures.push(msg);
    console.error(`[imghide-ui-test] ${msg}`);
  };

  const consoleErrors = [];
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) consoleErrors.push(`${message} (${path.basename(sourceId || '')}:${line})`);
  });
  result.checks.consoleErrors = consoleErrors;

  await fs.mkdir(TEST_DIR, { recursive: true });

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-imghide-${name}.png`);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        win.show();
        const image = await wc.capturePage();
        if (image && !image.isEmpty()) {
          await fs.writeFile(file, image.toPNG());
          result.shots.push(file);
          return true;
        }
      } catch { /* 重试 */ }
      await wait(400);
    }
    fail(`截图失败：${name}`);
    return false;
  };

  // —— 夹具：先清、再造 ——
  const { ensureFixtures, cleanFixtures } = require('./imghide-test.js');
  await cleanFixtures(TEST_DIR);
  await ensureFixtures(TEST_DIR, options.portableDir);
  result.steps.fixtures = [COVER_NAME, '测试藏图表图封面B.gif', ITEM_A, ITEM_B];
  const coverPath = path.join(TEST_DIR, COVER_NAME);
  const itemABytes = await fs.readFile(path.join(TEST_DIR, ITEM_A));
  const itemBBytes = await fs.readFile(path.join(TEST_DIR, ITEM_B));

  const ensureToolMounted = async () => pollUntil(async () => evalJs('!!document.getElementById("ihRunPack")'), 8000, 300);

  /**
   * 等结果文案变成「新的」一句。
   * 必须与上一次的文案比对：结果元素会保留上一轮的文案，直接等 /已生成|解出/ 会立刻拿到旧值，
   * 后续断言就全在看上一轮的结果（踩过：密码轮次全部误判）。
   */
  const waitForResult = async (elId, previous, re = /已生成|解出|失败/) => pollUntil(async () => {
    const t = await evalJs(`document.getElementById("${elId}").textContent`);
    return t && t !== previous && re.test(t) ? t : '';
  }, 60000);

  // —— 1) 切到工具 ——
  await evalJs(`(() => {
    const nav = (id) => [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === id);
    nav('imghide').click();
    return true;
  })()`);
  if (!await ensureToolMounted()) {
    result.pass = false;
    const status = await evalJs('document.getElementById("statusText").textContent').catch(() => '');
    fail(`切到「文件藏图」后界面没有渲染出 #ihRunPack；状态栏="${status}"`);
    if (consoleErrors.length) fail(`渲染进程报错：${consoleErrors.slice(0, 3).join(' ｜ ')}`);
    writeResult({ ok: false, at: new Date().toISOString(), result });
    return result;
  }
  await wait(600);

  result.checks.mount = JSON.parse(await evalJs(`(() => {
    const ids = ['ihModePack','ihModeUnpack','ihPickCover','ihClearCover','ihCoverBox','ihAddFiles','ihItems',
                 'ihPassword','ihRunPack','ihClearPack','ihPackResult','ihPickImage','ihRunUnpack','ihClearUnpack',
                 'ihUnpackList','ihUnpackDir','ihOpenFolder'];
    return JSON.stringify({
      missing: ids.filter((id) => !document.getElementById(id)),
      packActive: document.getElementById('ihModePack').classList.contains('is-active'),
      unpackHidden: document.getElementById('ihUnpackPane').hidden,
      runDisabled: document.getElementById('ihRunPack').disabled,
      hint: document.getElementById('ihModesHint').textContent,
      note: document.getElementById('ihPackNote').textContent
    });
  })()`));
  if (result.checks.mount.missing.length) fail(`界面缺少元素：${result.checks.mount.missing.join('、')}`);
  if (!result.checks.mount.packActive || !result.checks.mount.unpackHidden) fail('默认应停在「打包」页');
  if (!result.checks.mount.runDisabled) fail('没选表图/文件时「开始打包」应不可点');
  if (!/互通/.test(result.checks.mount.hint)) fail('顶部应提示与「图夹」网站互通');
  if (!/文件.*方式发送|以「文件」方式/.test(result.checks.mount.note)) fail('应提示微信/QQ 要以「文件」方式发送');
  await shot('01-工具初始界面');

  // —— 2) 选表图 + 加文件 ——
  await evalJs('document.getElementById("ihPickCover").click(); true');
  const coverSet = await pollUntil(async () => evalJs(`!document.getElementById("ihCoverThumb").hidden
    && document.getElementById("ihCoverMeta").textContent.includes('封面A')`), 8000);
  if (!coverSet) fail('选了表图后预览没出来（缩略图或文件名没更新）');
  await shot('02-选好表图');

  await evalJs('document.getElementById("ihAddFiles").click(); true');
  const itemsAdded = await pollUntil(async () => evalJs('document.querySelectorAll("#ihItems .ih-item").length'), 8000);
  result.checks.itemsAdded = itemsAdded;
  if (itemsAdded !== 2) fail(`应加入 2 个要藏的文件，实际 ${itemsAdded}`);
  result.checks.runEnabled = !(await evalJs('document.getElementById("ihRunPack").disabled'));
  if (!result.checks.runEnabled) fail('选好表图与文件后「开始打包」应可点');
  await shot('03-加好要藏的文件');

  // —— 3) 打包 ——
  await evalJs('document.getElementById("ihRunPack").click(); true');
  const packText = await waitForResult('ihPackResult', '');
  result.steps.packResult = packText;
  if (!packText || /失败/.test(packText)) fail(`打包失败：${packText}`);
  const productPath = (packText.match(/已生成：(.+?)（/) || [])[1] || '';
  result.steps.product = productPath;
  if (!productPath || !fsSync.existsSync(productPath)) fail(`产物文件不存在：${productPath}`);
  if (!/_图夹\.png$/.test(productPath)) fail(`PNG 表图应产出 *_图夹.png，实际：${productPath}`);
  if (fsSync.existsSync(coverPath) && fsSync.statSync(productPath).size <= fsSync.statSync(coverPath).size) {
    fail('产物应比表图大（里面藏着两个文件）');
  }
  // 产物仍是一张能解码的图，且尺寸与表图一致
  result.checks.productDecoded = JSON.parse(await evalJs(`(async () => {
    const bytes = await window.desktop.readFile(${JSON.stringify(productPath)});
    const bmp = await createImageBitmap(new Blob([bytes]));
    return JSON.stringify({ width: bmp.width, height: bmp.height });
  })()`));
  if (result.checks.productDecoded.width !== 64 || result.checks.productDecoded.height !== 48) {
    fail(`产物解码尺寸应为 64×48，实际 ${JSON.stringify(result.checks.productDecoded)}`);
  }
  await shot('04-打包完成');

  // —— 4) 解包（把刚打包的那张图解开，逐字节比对） ——
  await evalJs('document.getElementById("ihModeUnpack").click(); true');
  await wait(300);
  await cleanProducts(productPath); // 只留这一张，保证对话框桩返回的就是它
  await evalJs('document.getElementById("ihPickImage").click(); true');
  const imageSet = await pollUntil(async () => evalJs(`!document.getElementById("ihImageThumb").hidden`), 8000);
  if (!imageSet) fail('选了图夹图后预览没出来');
  await evalJs('document.getElementById("ihRunUnpack").click(); true');
  const unpackText = await waitForResult('ihUnpackResult', '');
  result.steps.unpackResult = unpackText;
  if (!unpackText || /失败/.test(unpackText)) fail(`解包失败：${unpackText}`);
  const unpackDir = (unpackText.match(/→ (.+)$/) || [])[1] || '';
  result.steps.unpackDir = unpackDir;
  const sameFile = (a, b) => {
    try {
      const ba = fsSync.readFileSync(a);
      const bb = fsSync.readFileSync(b);
      return ba.length === bb.length && ba.equals(bb);
    } catch {
      return false;
    }
  };
  const outA = path.join(unpackDir, ITEM_A);
  const outB = path.join(unpackDir, ITEM_B);
  result.checks.unpacked = {
    dir: unpackDir,
    fileA: sameFile(outA, path.join(TEST_DIR, ITEM_A)),
    fileB: sameFile(outB, path.join(TEST_DIR, ITEM_B)),
    listCount: await evalJs('document.querySelectorAll("#ihUnpackList .ih-item").length'),
    folderButton: await evalJs('!document.getElementById("ihOpenFolder").hidden')
  };
  if (!result.checks.unpacked.fileA || !result.checks.unpacked.fileB) fail('解出来的文件与原始夹具不一致');
  if (result.checks.unpacked.listCount !== 2) fail(`结果列表应显示 2 个文件，实际 ${result.checks.unpacked.listCount}`);
  if (!result.checks.unpacked.folderButton) fail('解包后应出现「打开文件夹」按钮');
  await shot('05-解包完成');

  // —— 5) 密码往返（含错误密码必须被拒） ——
  await evalJs('document.getElementById("ihModePack").click(); true');
  await wait(300);
  await cleanProducts();
  await evalJs(`(() => {
    document.getElementById("ihPassword").value = '界面密码abc';
    return true;
  })()`);
  await evalJs('document.getElementById("ihRunPack").click(); true');
  const packText2 = await waitForResult('ihPackResult', packText);
  result.steps.packWithPassword = packText2;
  if (!packText2 || /失败/.test(packText2)) fail(`带密码打包失败：${packText2}`);
  const product2 = (packText2.match(/已生成：(.+?)（/) || [])[1] || '';
  await shot('06-带密码打包完成');

  await evalJs('document.getElementById("ihModeUnpack").click(); true');
  await wait(300);
  await cleanProducts(product2);
  await evalJs('document.getElementById("ihPickImage").click(); true');
  await pollUntil(async () => evalJs('!document.getElementById("ihImageThumb").hidden'), 8000);
  // 先故意用错密码
  await evalJs(`(() => { document.getElementById("ihPasswordX").value = '错的密码'; return true; })()`);
  await evalJs('document.getElementById("ihRunUnpack").click(); true');
  const wrongText = await waitForResult('ihUnpackResult', unpackText);
  result.steps.wrongPassword = wrongText;
  if (!/密码错误/.test(wrongText || '')) fail(`错误密码应提示「密码错误」，实际：${wrongText}`);
  await shot('07-错误密码被拒');
  // 再用对密码
  await evalJs(`(() => { document.getElementById("ihPasswordX").value = '界面密码abc'; return true; })()`);
  await evalJs('document.getElementById("ihRunUnpack").click(); true');
  const rightText = await waitForResult('ihUnpackResult', wrongText);
  result.steps.rightPassword = rightText;
  if (!/解出/.test(rightText || '')) fail(`正确密码应能解开，实际：${rightText}`);
  const dir2 = (rightText.match(/→ (.+)$/) || [])[1] || '';
  if (!sameFile(path.join(dir2, ITEM_A), path.join(TEST_DIR, ITEM_A))) fail('带密码解出来的文件内容不一致');
  await shot('08-正确密码解开');

  // —— 6) 清空 ——
  await evalJs('document.getElementById("ihClearUnpack").click(); true');
  await evalJs('document.getElementById("ihModePack").click(); true');
  await evalJs('document.getElementById("ihClearPack").click(); true');
  await wait(500);
  result.checks.cleared = JSON.parse(await evalJs(`JSON.stringify({
    items: document.querySelectorAll('#ihItems .ih-item').length,
    coverHidden: document.getElementById('ihCoverThumb').hidden,
    password: document.getElementById('ihPassword').value,
    runDisabled: document.getElementById('ihRunPack').disabled,
    unpackList: document.querySelectorAll('#ihUnpackList .ih-item').length
  })`));
  if (result.checks.cleared.items !== 0 || !result.checks.cleared.coverHidden || !result.checks.cleared.runDisabled) {
    fail(`清空后应回到初始状态，实际：${JSON.stringify(result.checks.cleared)}`);
  }
  await shot('09-清空后');

  // 渲染进程不该有报错（曾经因为内联 style 触发 CSP 拒绝，样式静默失效还刷一屏错误）
  if (consoleErrors.length) fail(`渲染进程有报错：${consoleErrors.slice(0, 3).join(' ｜ ')}`);

  // —— 收尾：清掉夹具与产物，并把设置恢复交给 main.js 的既有机制 ——
  await cleanProducts();
  await cleanFixtures(TEST_DIR);

  result.pass = result.failures.length === 0;
  return result;
}

module.exports = { runImgHideUiTest, writeResult, RESULT_FILE, TEST_DIR };

// 直接 `node tests/imghide-ui-test.js` 时报错提示（必须由 Electron 启动）
if (require.main === module) {
  console.error('这个测试要在 Electron 里跑：electron . --imghide-ui-test');
  process.exit(1);
}