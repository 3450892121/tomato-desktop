// 「文件藏图」工具 —— 界面自动测试
// 用法：cd app && .\node_modules\electron\dist\electron.exe . --imghide-ui-test
// 像真人一样操作：切到工具 → 随机表图 → 加文件 → 打包 → 校验产物 → 解包 → 内容比对
//                → 换自定义表图 + 水印 → 打包 → 防查模式设密码（错误密码被拒）→ 体积提示 → 清空
// 逐步截图 shot-imghide-*.png 落在 %TEMP%\tomato-uitest；结果写 %TEMP%/tomato-imghide-ui-test.json，pass:true 为通过。
//
// 夹具纪律：开跑前、收尾后各清一次 %TEMP%\tomato-uitest 里的「测试藏图*」，
// 绝不残留——否则会污染其它工具的界面测试。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-imghide-ui-test.json');
/** 自定义表图夹具（主进程 dialog:open-hide-cover 的桩按此前缀筛选） */
const COVER_NAME = '测试藏图表图封面A.png';
/** 要藏的文件夹具（dialog:open-hide-files 的桩按此前缀筛选） */
const ITEM_A = '测试藏图文件说明.txt';
const ITEM_B = '测试藏图文件数据.bin';
/** 体积提示用的临时夹具（用完就删，避免影响别的步骤的张数断言） */
const ITEM_BIG = '测试藏图文件z较大.bin';      // 4MB → 触发「平台建议 3MB 以内」提示
const ITEM_HUGE = '测试藏图文件z超大.bin';     // 51MB → 触发「网站/手机端多半打不开」警告

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

function sameFile(a, b) {
  try {
    const ba = fsSync.readFileSync(a);
    const bb = fsSync.readFileSync(b);
    return ba.length === bb.length && ba.equals(bb);
  } catch {
    return false;
  }
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

  const ensureToolMounted = async () => pollUntil(async () => evalJs('!!document.getElementById("ihRunPack")'), 8000, 300);

  /** 等结果文案变成「新的」一句（旧文案会留在元素里，必须比对，否则会立刻拿到上一轮结果） */
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
    const ids = ['ihModePack','ihModeUnpack','ihRandomCover','ihPickCover','ihClearCover','ihCoverBox','ihAddFiles','ihItems',
                 'ihSizeNote','ihAlgoFast','ihAlgoPro','ihPassword','ihWatermark','ihRunPack','ihClearPack','ihPackResult',
                 'ihOpenProduct','ihPickImage','ihRunUnpack','ihClearUnpack','ihUnpackList','ihUnpackDir','ihOpenFolder'];
    return JSON.stringify({
      missing: ids.filter((id) => !document.getElementById(id)),
      packActive: document.getElementById('ihModePack').classList.contains('is-active'),
      unpackHidden: document.getElementById('ihUnpackPane').hidden,
      runDisabled: document.getElementById('ihRunPack').disabled,
      fastChecked: document.getElementById('ihAlgoFast').checked,
      passwordDisabled: document.getElementById('ihPassword').disabled,
      hint: document.getElementById('ihModesHint').textContent,
      note: document.getElementById('ihPackNote').textContent
    });
  })()`));
  if (result.checks.mount.missing.length) fail(`界面缺少元素：${result.checks.mount.missing.join('、')}`);
  if (!result.checks.mount.packActive || !result.checks.mount.unpackHidden) fail('默认应停在「打包」页');
  if (!result.checks.mount.runDisabled) fail('没选表图/文件时「开始打包」应不可点');
  if (!result.checks.mount.fastChecked || !result.checks.mount.passwordDisabled) fail('默认应是「极速（不加密）」，密码框不可填');
  if (!/互通/.test(result.checks.mount.hint)) fail('顶部应提示与「图夹」网站互通');
  if (!/文件.*方式发送|以「文件」方式/.test(result.checks.mount.note)) fail('应提示微信/QQ 要以「文件」方式发送');
  await shot('01-工具初始界面');

  // —— 2) 随机表图 ——
  await evalJs('document.getElementById("ihRandomCover").click(); true');
  const randomCover = await pollUntil(async () => evalJs(`!document.getElementById("ihCoverThumb").hidden
    && document.getElementById("ihCoverMeta").textContent.includes('随机表图')`), 15000);
  result.checks.randomCover = { generated: !!randomCover, meta: await evalJs('document.getElementById("ihCoverMeta").textContent') };
  if (!randomCover) fail('点「随机表图」后预览与说明没出现');
  await shot('02-随机表图');

  // —— 3) 加文件 → 用随机表图打包（封面在内存里，没有源文件） ——
  await evalJs('document.getElementById("ihAddFiles").click(); true');
  const itemsAdded = await pollUntil(async () => evalJs('document.querySelectorAll("#ihItems .ih-item").length'), 8000);
  result.checks.itemsAdded = itemsAdded;
  if (itemsAdded !== 2) fail(`应加入 2 个要藏的文件，实际 ${itemsAdded}`);

  result.checks.beforeRandomPack = JSON.parse(await evalJs(`JSON.stringify({
    runDisabled: document.getElementById('ihRunPack').disabled,
    items: document.querySelectorAll('#ihItems .ih-item').length,
    coverSet: !document.getElementById('ihCoverThumb').hidden,
    status: document.getElementById('statusText') ? document.getElementById('statusText').textContent : ''
  })`));
  await evalJs('document.getElementById("ihRunPack").click(); true');
  const packText = await waitForResult('ihPackResult', '');
  result.steps.packRandomCover = packText;
  if (!packText) {
    result.checks.randomPackTimeout = JSON.parse(await evalJs(`JSON.stringify({
      result: document.getElementById('ihPackResult').textContent,
      runDisabled: document.getElementById('ihRunPack').disabled,
      status: document.getElementById('statusText') ? document.getElementById('statusText').textContent : ''
    })`));
    fail(`随机表图打包 60 秒没出结果：${JSON.stringify(result.checks.randomPackTimeout)}`);
  }
  if (packText && /失败/.test(packText)) fail(`随机表图打包失败：${packText}`);
  const productRandom = ((packText || '').match(/已生成：(.+?)（/) || [])[1] || '';
  if (!productRandom) {
    // 打包没给出产物就别继续了：后面的断言只会连环失败，先把现场写进结果
    result.pass = false;
    result.checks.consoleErrors = consoleErrors;
    return result;
  }
  if (!/_图夹\.png$/.test(productRandom)) fail(`随机表图产物名应为 *_图夹.png，实际：${productRandom}`);
  if (path.dirname(productRandom) !== TEST_DIR) fail(`测试模式下随机表图的产物应落在测试目录，实际：${productRandom}`);
  result.checks.randomProductSize = fsSync.existsSync(productRandom) ? fsSync.statSync(productRandom).size : 0;
  result.checks.randomProductDecoded = JSON.parse(await evalJs(`(async () => {
    const bytes = await window.desktop.readFile(${JSON.stringify(productRandom)});
    const bmp = await createImageBitmap(new Blob([bytes]));
    return JSON.stringify({ width: bmp.width, height: bmp.height });
  })()`));
  if (result.checks.randomProductDecoded.width !== 1024) fail(`随机表图产物应是 1024 宽，实际 ${JSON.stringify(result.checks.randomProductDecoded)}`);
  await shot('03-随机表图打包完成');

  // —— 4) 解包它 ——
  await evalJs('document.getElementById("ihModeUnpack").click(); true');
  await wait(300);
  await cleanProducts(productRandom);
  await evalJs('document.getElementById("ihPickImage").click(); true');
  const imageSet = await pollUntil(async () => evalJs('!document.getElementById("ihImageThumb").hidden'), 8000);
  if (!imageSet) fail('选了图夹图后预览没出来');
  await evalJs('document.getElementById("ihRunUnpack").click(); true');
  const unpackText = await waitForResult('ihUnpackResult', '');
  result.steps.unpackRandom = unpackText;
  if (!unpackText || /失败/.test(unpackText)) fail(`解包失败：${unpackText}`);
  const unpackDir = ((unpackText || '').match(/→ (.+)$/) || [])[1] || '';
  result.checks.unpacked = {
    dir: unpackDir,
    fileA: sameFile(path.join(unpackDir, ITEM_A), path.join(TEST_DIR, ITEM_A)),
    fileB: sameFile(path.join(unpackDir, ITEM_B), path.join(TEST_DIR, ITEM_B)),
    listCount: await evalJs('document.querySelectorAll("#ihUnpackList .ih-item").length'),
    folderButton: await evalJs('!document.getElementById("ihOpenFolder").hidden')
  };
  if (!result.checks.unpacked.fileA || !result.checks.unpacked.fileB) fail('解出来的文件与原始夹具不一致');
  if (result.checks.unpacked.listCount !== 2) fail(`结果列表应显示 2 个文件，实际 ${result.checks.unpacked.listCount}`);
  if (!result.checks.unpacked.folderButton) fail('解包后应出现「打开文件夹」按钮');
  await shot('04-解包完成');

  // —— 5) 换自定义表图 + 水印 ——
  await evalJs('document.getElementById("ihModePack").click(); true');
  await wait(300);
  await cleanProducts();
  await evalJs('document.getElementById("ihPickCover").click(); true');
  const coverSet = await pollUntil(async () => evalJs(`!document.getElementById("ihCoverThumb").hidden
    && document.getElementById("ihCoverMeta").textContent.includes('封面A')`), 8000);
  if (!coverSet) fail('选了自定义表图后预览没出来');
  await evalJs(`(() => { document.getElementById("ihWatermark").value = '图夹测试水印'; return true; })()`);
  await evalJs('document.getElementById("ihRunPack").click(); true');
  const packWatermark = await waitForResult('ihPackResult', packText);
  result.steps.packWatermark = packWatermark;
  if (!packWatermark || /失败/.test(packWatermark)) fail(`带水印打包失败：${packWatermark}`);
  const productWatermark = ((packWatermark || '').match(/已生成：(.+?)（/) || [])[1] || '';
  if (!productWatermark) fail(`带水印打包没给出产物：${packWatermark}`);
  result.checks.watermarkDecoded = JSON.parse(await evalJs(`(async () => {
    const bytes = await window.desktop.readFile(${JSON.stringify(productWatermark)});
    const bmp = await createImageBitmap(new Blob([bytes]));
    return JSON.stringify({ width: bmp.width, height: bmp.height });
  })()`));
  if (result.checks.watermarkDecoded.width !== 64) fail(`带水印产物尺寸应与表图一致（64×48），实际 ${JSON.stringify(result.checks.watermarkDecoded)}`);
  // 水印只是画在表图上，藏在里面的文件必须一模一样
  const outWatermark = await evalJs(`window.desktop.hideUnpack({ imagePath: ${JSON.stringify(productWatermark)}, outputDir: ${JSON.stringify(path.join(TEST_DIR, '水印解出'))} })`);
  result.checks.watermarkUnpack = {
    ok: !!outWatermark.ok,
    files: (outWatermark.files || []).length,
    fileA: sameFile(path.join(TEST_DIR, '水印解出', ITEM_A), path.join(TEST_DIR, ITEM_A))
  };
  if (!result.checks.watermarkUnpack.ok || !result.checks.watermarkUnpack.fileA) fail('带水印的图应能正常解出原文件（水印不影响数据）');
  await shot('05-加水印打包并解出');

  // —— 6) 防查模式 + 密码（错误密码必须被拒） ——
  await evalJs(`(() => { document.getElementById("ihAlgoPro").click(); return true; })()`);
  await wait(200);
  result.checks.proMode = JSON.parse(await evalJs(`JSON.stringify({
    passwordEnabled: !document.getElementById("ihPassword").disabled,
    hint: document.getElementById("ihPasswordHint").textContent
  })`));
  if (!result.checks.proMode.passwordEnabled) fail('切到「防查」后密码框应可填');
  await evalJs(`(() => { document.getElementById("ihPassword").value = '界面密码abc'; return true; })()`);
  await evalJs('document.getElementById("ihRunPack").click(); true');
  const packPw = await waitForResult('ihPackResult', packWatermark);
  result.steps.packWithPassword = packPw;
  if (!packPw || /失败/.test(packPw)) fail(`带密码打包失败：${packPw}`);
  const productPw = ((packPw || '').match(/已生成：(.+?)（/) || [])[1] || '';
  if (!productPw) fail(`带密码打包没给出产物：${packPw}`);
  await shot('06-带密码打包完成');

  await evalJs('document.getElementById("ihModeUnpack").click(); true');
  await wait(300);
  await cleanProducts(productPw);
  await evalJs('document.getElementById("ihPickImage").click(); true');
  const pwPicked = await pollUntil(async () => {
    const meta = await evalJs('document.getElementById("ihImageMeta").textContent');
    return meta.includes(path.basename(productPw)) ? meta : '';
  }, 8000);
  result.checks.pwPicked = pwPicked || (await evalJs('document.getElementById("ihImageMeta").textContent'));
  if (!pwPicked) fail(`「选择图片」没有选中刚打的带密码图：期望 ${path.basename(productPw)}，实际「${result.checks.pwPicked}」`);
  await evalJs(`(() => { document.getElementById("ihPasswordX").value = '错的密码'; return true; })()`);
  await evalJs('document.getElementById("ihRunUnpack").click(); true');
  const wrongText = await waitForResult('ihUnpackResult', unpackText);
  result.steps.wrongPassword = wrongText;
  if (!/密码错误/.test(wrongText || '')) fail(`错误密码应提示「密码错误」，实际：${wrongText}`);
  await shot('07-错误密码被拒');
  await evalJs(`(() => { document.getElementById("ihPasswordX").value = '界面密码abc'; return true; })()`);
  await evalJs('document.getElementById("ihRunUnpack").click(); true');
  const rightText = await waitForResult('ihUnpackResult', wrongText);
  result.steps.rightPassword = rightText;
  if (!/解出/.test(rightText || '')) fail(`正确密码应能解开，实际：${rightText}`);
  const dir2 = ((rightText || '').match(/→ (.+)$/) || [])[1] || '';
  if (!sameFile(path.join(dir2, ITEM_A), path.join(TEST_DIR, ITEM_A))) fail('带密码解出来的文件内容不一致');
  await shot('08-正确密码解开');

  // —— 7) 体积提示（用户实测教训：太大的图网站/手机端打不开） ——
  await fs.writeFile(path.join(TEST_DIR, ITEM_BIG), Buffer.alloc(4 * 1024 * 1024, 7));
  await fs.writeFile(path.join(TEST_DIR, ITEM_HUGE), Buffer.alloc(51 * 1024 * 1024, 9));
  result.checks.bigFixtures = [ITEM_BIG, ITEM_HUGE].map((name) => {
    const full = path.join(TEST_DIR, name);
    return `${name}:${fsSync.existsSync(full) ? fsSync.statSync(full).size : 'missing'}`;
  });
  await evalJs('document.getElementById("ihModePack").click(); true');
  await wait(200);
  // 上一步切到了「防查」，这里先切回默认的「极速」再验提示（两种模式的文案不同）
  await evalJs(`(() => { document.getElementById("ihAlgoFast").click(); return true; })()`);
  await wait(200);
  await evalJs('document.getElementById("ihAddFiles").click(); true');
  // 注意：必须等「比原来多」才返回（只等非 0 会在旧值 2 上立刻返回——踩过）
  const bigAdded = await pollUntil(async () => {
    const n = await evalJs('document.querySelectorAll("#ihItems .ih-item").length');
    return n >= 4 ? n : 0;
  }, 15000);
  result.steps.sizeHintItems = bigAdded;
  if (bigAdded !== 4) fail(`应能加入两个大夹具文件（总数 4），实际 ${bigAdded}`);
  const hintFast = JSON.parse(await evalJs(`JSON.stringify({
    items: document.querySelectorAll('#ihItems .ih-item').length,
    text: document.getElementById('ihSizeNote').textContent,
    cls: document.getElementById('ihSizeNote').className
  })`));
  result.checks.sizeHintFast = hintFast;
  if (!/传不动|网盘/.test(hintFast.text)) fail(`极速模式下 51MB 文件应提示传输不便，实际：${JSON.stringify(hintFast)}`);
  // 切到「防查」：同体积下应变成「网页版多半打不开」的警告（要整张图解压）
  await evalJs(`(() => { document.getElementById("ihAlgoPro").click(); return true; })()`);
  await wait(300);
  result.checks.sizeHint = JSON.parse(await evalJs(`JSON.stringify({
    text: document.getElementById('ihSizeNote').textContent,
    cls: document.getElementById('ihSizeNote').className
  })`));
  if (!/打不开/.test(result.checks.sizeHint.text) || !/is-error/.test(result.checks.sizeHint.cls)) {
    fail(`「防查」模式下 51MB 文件应给「多半打不开」的警告，实际：${JSON.stringify(result.checks.sizeHint)}`);
  }
  await shot('09-体积警告（两种模式）');
  // 回到极速，后面的清空断言按默认档位走
  await evalJs(`(() => { document.getElementById("ihAlgoFast").click(); return true; })()`);
  await wait(200);

  // 把两个大文件移除，提示应变回普通提醒/消失
  await evalJs(`(() => {
    for (const name of ['${ITEM_BIG}', '${ITEM_HUGE}']) {
      const li = [...document.querySelectorAll('#ihItems .ih-item')].find((el) => el.textContent.includes(name));
      if (li) li.querySelector('.ih-item-remove').click();
    }
    return true;
  })()`);
  await wait(400);
  result.checks.sizeHintAfterRemove = JSON.parse(await evalJs(`JSON.stringify({
    items: document.querySelectorAll('#ihItems .ih-item').length,
    text: document.getElementById('ihSizeNote').textContent,
    cls: document.getElementById('ihSizeNote').className
  })`));
  if (/打不开/.test(result.checks.sizeHintAfterRemove.text)) fail('移除大文件后不该还留着「打不开」的警告');
  await fs.rm(path.join(TEST_DIR, ITEM_BIG), { force: true });
  await fs.rm(path.join(TEST_DIR, ITEM_HUGE), { force: true });

  // —— 8) 清空 ——
  await evalJs('document.getElementById("ihClearUnpack").click(); true');
  await evalJs('document.getElementById("ihClearPack").click(); true');
  await wait(500);
  result.checks.cleared = JSON.parse(await evalJs(`JSON.stringify({
    items: document.querySelectorAll('#ihItems .ih-item').length,
    coverHidden: document.getElementById('ihCoverThumb').hidden,
    password: document.getElementById('ihPassword').value,
    fastChecked: document.getElementById('ihAlgoFast').checked,
    watermark: document.getElementById('ihWatermark').value,
    runDisabled: document.getElementById('ihRunPack').disabled,
    unpackList: document.querySelectorAll('#ihUnpackList .ih-item').length
  })`));
  if (result.checks.cleared.items !== 0 || !result.checks.cleared.coverHidden || !result.checks.cleared.runDisabled
    || !result.checks.cleared.fastChecked || result.checks.cleared.watermark !== '') {
    fail(`清空后应回到初始状态，实际：${JSON.stringify(result.checks.cleared)}`);
  }
  await shot('10-清空后');

  // 渲染进程不该有报错（曾经因为内联 style 触发 CSP 拒绝，样式静默失效还刷一屏错误）
  if (consoleErrors.length) fail(`渲染进程有报错：${consoleErrors.slice(0, 3).join(' ｜ ')}`);

  // —— 收尾：清掉夹具与产物（设置恢复交给 main.js 的既有机制） ——
  await cleanProducts();
  await cleanFixtures(TEST_DIR);
  await fs.rm(path.join(TEST_DIR, '水印解出'), { recursive: true, force: true }).catch(() => {});

  result.pass = result.failures.length === 0;
  return result;
}

module.exports = { runImgHideUiTest, writeResult, RESULT_FILE, TEST_DIR };

// 直接 `node tests/imghide-ui-test.js` 时报错提示（必须由 Electron 启动）
if (require.main === module) {
  console.error('这个测试要在 Electron 里跑：electron . --imghide-ui-test');
  process.exit(1);
}