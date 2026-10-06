// 设置导入导出自检：`electron . --settingsio-test`
// 覆盖：导出写出的文件结构合法、导入能把设置真的改回来、未知键被忽略、
//       野文件（非本软件导出）被拒绝且**不会改动现有设置**、界面上的两个按钮真的接线。
// 结果写 %TEMP%/tomato-settingsio-test.json，pass:true 为通过。
// 注意：本测试会临时修改用户设置，结束时必须把原设置恢复回去（否则会改掉使用者的偏好）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-settingsio-test.json');
/** 导出产物（主进程在测试模式下固定写到这里） */
const EXPORT_FILE = path.join(TEST_DIR, '设置导出.json');
/** 导入用的临时文件（主进程在测试模式下固定读这里） */
const IMPORT_FILE = path.join(TEST_DIR, '设置导入.json');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeResult(payload) {
  try {
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[settingsio-test] 结果文件写入失败：', err.message);
  }
  return RESULT_FILE;
}

async function runSettingsIoTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, failures: [], shots: [] };

  // 注意：这里用的是 fs.promises（同步 API 只有 writeFileSync；别把 fs.mkdir 当 Promise 用）
  await fs.promises.mkdir(TEST_DIR, { recursive: true });

  const readSettings = () => evalJs('window.desktop.settingsRead()');
  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-sio-${name}.png`);
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
      } catch { /* 重试 */ }
      await wait(400);
    }
    return false;
  };

  // 0) 记下用户原有设置，结束时恢复。
  // 同时记下配置文件的「原始样子」：出厂态（刚打包/首次运行）压根没有 settings.json，
  // 这种情况下恢复＝把文件删掉——只写回 {} 是没用的（主进程写设置是「补丁合并进现有文件」，
  // 文件不存在时合并结果仍是文件里的旧值），会把测试值留在用户配置里。
  const settingsFile = path.join(
    app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..'),
    'userdata',
    'settings.json'
  );
  let originalRaw = null;
  try {
    originalRaw = await fs.promises.readFile(settingsFile, 'utf8');
  } catch {
    originalRaw = null;
  }
  const original = await readSettings();
  result.steps.original = original;
  result.steps.originalFileExists = originalRaw !== null;

  // —— 1) 打开设置弹窗，确认两个按钮在 ——
  result.checks.buttonsExist = await evalJs(`(() => {
    document.getElementById('btnSettings').click();
    return true;
  })()`);
  await wait(400);
  result.checks.buttonsVisible = await evalJs(`(() => {
    const e = document.getElementById('setExport');
    const i = document.getElementById('setImport');
    const shown = (el) => !!el && el.offsetParent !== null;
    return shown(e) && shown(i);
  })()`);
  if (!result.checks.buttonsVisible) result.failures.push('设置弹窗里没有「导出设置…」/「导入设置…」按钮');
  await shot('01-设置弹窗');

  // —— 2) 导出：文件必须真的写出，且结构合法 ——
  // 先改一个可识别的值，导出后校验它进了文件
  await evalJs(`window.desktop.settingsWrite({ blockSize: 48, jpegQuality: 91 })`);
  await evalJs(`document.getElementById('setExport').click()`);
  await wait(600);
  let exported = null;
  try {
    exported = JSON.parse(await fs.promises.readFile(EXPORT_FILE, 'utf8'));
  } catch (err) {
    result.failures.push(`导出文件读不到或不是合法 JSON：${err.message}`);
  }
  result.steps.exported = exported;
  result.checks.exportShape = !!exported && typeof exported.settings === 'object' &&
    exported._app === '番茄图片混淆 桌面版' && exported._format === 1;
  if (!result.checks.exportShape) result.failures.push('导出内容结构不符合预期（缺 _app/_format/settings）');
  result.checks.exportHasValues = !!exported && exported.settings.blockSize === 48 && exported.settings.jpegQuality === 91;
  if (!result.checks.exportHasValues) result.failures.push('导出内容没有包含当前设置值');

  // —— 3) 导入：改掉设置 → 导入刚才导出的文件 → 值应恢复 ——
  // 测试模式下主进程的「导入」固定读 设置导入.json、导出固定写 设置导出.json，
  // 所以这里先把导出结果搬成导入输入（真实使用中是用户自己选文件）。
  await fs.promises.copyFile(EXPORT_FILE, IMPORT_FILE);
  await evalJs(`window.desktop.settingsWrite({ blockSize: 12, jpegQuality: 30 })`);
  const changed = await readSettings();
  result.steps.afterChange = changed;
  if (changed.blockSize !== 12) result.failures.push('前置步骤失败：设置没有被改掉');
  await evalJs(`document.getElementById('setImport').click()`);
  await wait(900);
  const afterImport = await readSettings();
  result.steps.afterImport = afterImport;
  result.checks.importRestored = afterImport.blockSize === 48 && afterImport.jpegQuality === 91;
  if (!result.checks.importRestored) {
    result.failures.push(`导入后设置没有恢复：blockSize=${afterImport.blockSize} jpegQuality=${afterImport.jpegQuality}`);
  }

  // —— 4) 未知键必须被忽略（只合并本软件认识的项）——
  await fs.promises.writeFile(IMPORT_FILE, JSON.stringify({
    _app: '番茄图片混淆 桌面版', _format: 1,
    settings: { blockSize: 64, 恶意键: '不该被写进去', __proto__x: 1 }
  }), 'utf8');
  await evalJs(`document.getElementById('setImport').click()`);
  await wait(900);
  const afterUnknown = await readSettings();
  result.steps.afterUnknown = afterUnknown;
  result.checks.unknownIgnored = afterUnknown.blockSize === 64 && !('恶意键' in afterUnknown);
  if (!result.checks.unknownIgnored) result.failures.push('未知键没有被忽略（或已知键没生效）');

  // —— 5) 野文件必须被拒绝，且不破坏现有设置 ——
  const beforeBad = await readSettings();
  await fs.promises.writeFile(IMPORT_FILE, '{"foo":1,"bar":2}', 'utf8');
  const badRes = await evalJs('window.desktop.settingsImport()');
  await wait(300);
  const afterBad = await readSettings();
  result.steps.badImport = badRes;
  result.checks.badRejected = !!badRes && badRes.ok === false;
  if (!result.checks.badRejected) result.failures.push('非本软件导出的文件没有被拒绝');
  result.checks.badKeptSettings = JSON.stringify(beforeBad) === JSON.stringify(afterBad);
  if (!result.checks.badKeptSettings) result.failures.push('被拒绝的导入却改动了现有设置');

  // —— 6) 界面接线：导入成功后状态栏要有反馈 ——
  const statusText = await evalJs('document.getElementById("statusText").textContent');
  result.steps.statusText = statusText;
  result.checks.uiFeedback = /导入|失败/.test(statusText);
  if (!result.checks.uiFeedback) result.failures.push('导入后状态栏没有给出反馈');
  await shot('02-导入后');

  // —— 7) 恢复用户原设置（关键：绝不能把使用者的偏好改成测试值）——
  if (originalRaw === null) {
    await fs.promises.rm(settingsFile, { force: true }); // 出厂态本来没有配置文件：恢复＝删掉
  } else {
    await fs.promises.writeFile(settingsFile, originalRaw, 'utf8'); // 有就逐字节写回
  }
  const restored = await readSettings();
  result.checks.restored = JSON.stringify(restored) === JSON.stringify(original);
  if (!result.checks.restored) {
    result.steps.restoredSnapshot = restored;
    result.failures.push('没有把用户原设置完整恢复');
  }

  // 清理本测试产生的临时文件（导出文件与导入文件都是测试垃圾）
  for (const f of [EXPORT_FILE, IMPORT_FILE]) {
    try { await fs.promises.rm(f, { force: true }); } catch { /* 删不掉不影响结论 */ }
  }

  result.pass = result.failures.length === 0;
  writeResult({ ok: result.pass, at: new Date().toISOString(), result });
  return result;
}

module.exports = { runSettingsIoTest, writeResult, RESULT_FILE };