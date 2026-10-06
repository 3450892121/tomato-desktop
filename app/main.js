// 番茄图片混淆 桌面版 — Electron 主进程（骨架）
// 职责：创建窗口、加载界面、提供文件对话框与本地设置读写等系统能力。
'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, nativeTheme, protocol, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');
const { StringDecoder } = require('string_decoder');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { Worker } = require('worker_threads');

// 本地媒体协议（工具：视频播放器；见 spec/modules/player.md）
// 为什么不用 file://：界面进程处于沙箱 + CSP（default-src 'self'），file:// 会被拦；
// 且自定义协议能把「Range 分块 + Content-Type」握在自己手里，大视频才能边读边播、拖动进度。
// 必须在 app ready 之前注册为特权协议：stream 让 <video> 走流式读取，supportFetchAPI 便于自检脚本 fetch 探针。
protocol.registerSchemesAsPrivileged([
  { scheme: 'tomato-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

/** @type {BrowserWindow | null} */
let mainWindow = null;

// 冒烟自检：`electron . --smoke-test` 时窗口加载完成后自动退出，
// 并打印模式下拉框的选项数量，用于确认界面框架能正常跑起来。
const smokeTest = process.argv.includes('--smoke-test');

// 端到端自检：`electron . --self-test` 在界面进程里跑「图片编解码 + 算法 + 保存格式」全链路
const selfTest = process.argv.includes('--self-test');

// 界面自动测试：`electron . --ui-test` 像真人一样点按钮走完整流程，逐步截图并做像素级校验
const uiTest = process.argv.includes('--ui-test');

// PDF 工具界面自动测试：`electron . --pdf-ui-test` 完整走一遍 PDF 工具五个方向并截图
const pdfUiTest = process.argv.includes('--pdf-ui-test');

// PDF 工具自检：`electron . --pdf-test` 验证 pdfjs/pdf-lib 加载、页面渲染与图片↔PDF 往返
const pdfTest = process.argv.includes('--pdf-test');

// 媒体工具自检：`electron . --media-test` 在界面进程里跑 图片压缩/变清晰/格式转换 + 视频/动图链路
const mediaTest = process.argv.includes('--media-test');

// 媒体工具界面自动测试：`electron . --media-ui-test` 逐个打开新工具、点按钮走流程并截图
const mediaUiTest = process.argv.includes('--media-ui-test');

// 音频工具自检：`electron . --audio-test` 真实转码全部输出格式并逐个回读校验
const audioTest = process.argv.includes('--audio-test');

// 音频工具界面自动测试：`electron . --audio-ui-test` 像真人一样切工具、选格式、点按钮走完整流程并截图
const audioUiTest = process.argv.includes('--audio-ui-test');

// 语音转文字自检：`electron . --asr-test` 离线合成中文语音夹具 → 真实识别 → 校验文本与字幕产物
const asrTest = process.argv.includes('--asr-test');

// 语音转文字界面自动测试：`electron . --asr-ui-test` 切工具 → 添加 → 识别 → 校验产物并截图
const asrUiTest = process.argv.includes('--asr-ui-test');

// OCR 引擎可用性闸门：`electron . --ocr-poc` 验证 OCR 引擎能在本软件里纯离线跑通中文扫描件
// （正式工具开发前必须先跑通这道闸门）
const ocrPoc = process.argv.includes('--ocr-poc');

// 深色主题自检：`electron . --theme-test` 验证外观三态切换、色值生效、落盘与深色下各工具页渲染
const themeTest = process.argv.includes('--theme-test');

// A 批媒体工具自检：`electron . --av-test` 覆盖「视频压缩」与「音频剪辑」（逻辑 + 真实转码 + 界面走查）
const avTest = process.argv.includes('--av-test');

// B 批图片工具自检：`electron . --imgbatch-test` 覆盖「批量重命名/加水印/长图拼接/九宫格切图」
const imgbatchTest = process.argv.includes('--imgbatch-test');

// 设置导入导出自检：`electron . --settingsio-test`
const settingsIoTest = process.argv.includes('--settingsio-test');

// C 批工具自检：`electron . --pdf-ocr-test` 覆盖「PDF 编辑整理」与「文字识别」（含 OCR 引擎真实识别）
const pdfOcrTest = process.argv.includes('--pdf-ocr-test');

// 任务中心界面自检：`electron . --queue-ui-test`（含「切走工具页后任务继续跑完」这条核心断言）
const queueUiTest = process.argv.includes('--queue-ui-test');

// 文件压缩与解压：引擎自检 / 界面自动测试
const archiveTest = process.argv.includes('--archive-test');
const archiveUiTest = process.argv.includes('--archive-ui-test');

// 视频播放器：自检 / 界面自动测试（见 spec/modules/player.md）
const playerTest = process.argv.includes('--player-test');
const playerUiTest = process.argv.includes('--player-ui-test');

// 文件藏图：引擎自检 / 界面自动测试（见 spec/modules/imghide.md）
const imgHideTest = process.argv.includes('--imghide-test');
const imgHideUiTest = process.argv.includes('--imghide-ui-test');

// 软件卸载自检：`electron . --uninstall-test`（加装包与版本、提权命令构造、界面走查与截图；见 spec/modules/uninstall.md）
const uninstallTest = process.argv.includes('--uninstall-test');

// 视频下载：自检 / 界面自动测试（见 spec/modules/videodl.md）
const videodlTest = process.argv.includes('--videodl-test');
const videodlUiTest = process.argv.includes('--videodl-ui-test');

// 文档格式转换：自检 / 界面自动测试（见 spec/modules/doc-convert.md）
const docTest = process.argv.includes('--doc-test');
const docUiTest = process.argv.includes('--doc-ui-test');

// 测试模式下关闭硬件加速：保证截图（capturePage）在任何机器上都能稳定拿到画面
if (uiTest || pdfUiTest || mediaUiTest || audioUiTest || asrUiTest || themeTest || avTest || imgbatchTest || settingsIoTest || pdfOcrTest || queueUiTest || archiveUiTest || playerUiTest || imgHideUiTest || uninstallTest || videodlUiTest || docUiTest) {
  app.disableHardwareAcceleration();
}

/** 是否处于任一自动测试模式：此时系统对话框一律换成本地测试文件（避免测试卡在弹窗上），
 *  卸载工具的提权启动也会空跑（免得弹 UAC 卡住测试） */
const testMode = () => uiTest || pdfUiTest || mediaTest || mediaUiTest || audioTest || audioUiTest || asrTest || asrUiTest || ocrPoc || themeTest || avTest || imgbatchTest || settingsIoTest || pdfOcrTest || queueUiTest || archiveTest || archiveUiTest || playerTest || playerUiTest || imgHideTest || imgHideUiTest || uninstallTest || videodlTest || videodlUiTest || docTest || docUiTest;

/** 自动测试模式下：从测试目录取指定扩展名的文件（对话框桩用；扩展名带不带点都能匹配） */
async function testDirFiles(exts, { startWith, exact } = {}) {
  const { TEST_DIR } = require('./tests/ui-test.js');
  const norm = (e) => String(e).toLowerCase().replace(/^\./, '');
  const set = new Set(exts.map(norm));
  const entries = await fs.readdir(TEST_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && set.has(norm(path.extname(e.name))))
    .filter((e) => (startWith ? e.name.startsWith(startWith) : true))
    // exact：去掉扩展名后完全相等（避免把历次测试留下的 (1)(2) 副本也一起选进来）
    .filter((e) => (exact ? e.name.replace(/\.[^.]+$/, '') === exact : true))
    .map((e) => path.join(TEST_DIR, e.name))
    .sort();
}

// 绿色版约定：所有运行期数据（设置等）都放在软件目录内，不写系统 AppData
const PORTABLE_DIR = app.isPackaged ? path.dirname(process.execPath) : __dirname;
const USER_DATA_DIR = path.join(PORTABLE_DIR, 'userdata');
const SETTINGS_FILE = path.join(USER_DATA_DIR, 'settings.json');
app.setPath('userData', USER_DATA_DIR);

// —— 自动测试模式：用户的设置只读（启动留档 → 退出原样写回） ——
// 为什么：界面自动测试会点分组标题、开设置弹窗，这些操作按设计会把状态落盘到 settings.json。
// 若测试结束不还原，用户下次打开软件看到的就是「测试最后点出来的状态」——
// 曾出现：测试把左侧分组全部点成展开并落盘，用户打开软件发现子项全展开，以为「默认折叠」没生效。
// 原本没有这个文件（首次打包后的干净状态）时，还原＝把文件删掉，保证交付目录保持出厂态。
const settingsSnapshot = (() => {
  if (!testMode()) return null;
  try {
    return { existed: true, content: fsSync.readFileSync(SETTINGS_FILE, 'utf8') };
  } catch {
    return { existed: false, content: '' };
  }
})();

app.on('will-quit', () => {
  if (!settingsSnapshot) return;
  try {
    if (settingsSnapshot.existed) fsSync.writeFileSync(SETTINGS_FILE, settingsSnapshot.content, 'utf8');
    else fsSync.rmSync(SETTINGS_FILE, { force: true });
  } catch (err) {
    console.error('[main] 测试模式还原设置失败', err);
  }
});

// —— 全局兜底与文件日志 ——
// 此前主进程只有 console.error：绿色版通常没有控制台，未捕获异常与未处理的 Promise 拒绝等于静默丢失、
// 崩溃后不留痕。这里各落一条到用户数据目录的 logs/main.log（自带时间戳，不引入新依赖）。
// 写日志自身再出错也绝不再抛（磁盘满/目录不可写等），且不改变原有退出行为——只记不退。
function appendMainLog(tag, detail) {
  try {
    const line = `[${new Date().toISOString()}] [${tag}] ${detail}\n`;
    const logDir = path.join(app.getPath('userData'), 'logs');
    fsSync.mkdirSync(logDir, { recursive: true });
    fsSync.appendFileSync(path.join(logDir, 'main.log'), line);
  } catch { /* 落盘失败不得外抛 */ }
}
process.on('uncaughtException', (err) => {
  appendMainLog('uncaughtException', String((err && (err.stack || err.message)) || err || ''));
  try { console.error('[main] uncaughtException', err); } catch { /* 无控制台时忽略 */ }
});
process.on('unhandledRejection', (reason) => {
  appendMainLog('unhandledRejection', String((reason && (reason.stack || reason.message)) || reason || ''));
  try { console.error('[main] unhandledRejection', reason); } catch { /* 同上 */ }
});

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};
// 生成测试样本 / 校验手机版样本（兼容性锁定用）
const makeSamplesDir = argValue('--make-samples');
const verifySamplesDir = argValue('--verify-samples');
const samplesMode = argValue('--mode');
const samplesKey = argValue('--key');

async function readSettingsFile() {
  try {
    return JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const SELF_TEST_SCRIPT = `
  (async () => {
    const { processPixels } = await import('../tools/obfuscate/core/engine.js');
    const { decodeImageFromBytes, encodeImageToBytes } = await import('../shared/imageio.js');
    const result = {};

    // 测试图：37x19（非 32 倍数）全不透明彩色噪声
    const w = 37, h = 19;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      src[p * 4] = (p * 37 + 11) & 255;
      src[p * 4 + 1] = (p * 91 + 7) & 255;
      src[p * 4 + 2] = (p * 53 + 29) & 255;
      src[p * 4 + 3] = 255;
    }

    // 1) PNG 编解码往返（必须逐像素一致）
    const png = await encodeImageToBytes(src, w, h, { format: 'png' });
    const back = await decodeImageFromBytes(png);
    let ok1 = back.width === w && back.height === h && back.pixels.length === src.length;
    if (ok1) for (let i = 0; i < src.length; i++) if (src[i] !== back.pixels[i]) { ok1 = false; break; }
    result.pngRoundTrip = ok1 ? 'OK' : 'FAIL';
    result.pngSize = png.length;

    // 2) 算法 + 编解码端到端（像素混淆 C，含中文密钥）
    const enc = processPixels({ mode: 'c', key: '测试密钥abc', direction: 'encrypt', width: w, height: h, pixels: src });
    const encPng = await encodeImageToBytes(enc.pixels, enc.width, enc.height, { format: 'png' });
    const decImg = await decodeImageFromBytes(encPng);
    const dec = processPixels({ mode: 'c', key: '测试密钥abc', direction: 'decrypt', width: decImg.width, height: decImg.height, pixels: decImg.pixels });
    let ok2 = dec.pixels.length === src.length;
    if (ok2) for (let i = 0; i < src.length; i++) if (src[i] !== dec.pixels[i]) { ok2 = false; break; }
    result.pipelineRoundTrip = ok2 ? 'OK' : 'FAIL';

    // 3) gilbert 模式 + JPEG 保存（有损；用平滑渐变图评估真实画质损失）
    const grad = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (x + y * w) * 4;
      grad[p] = Math.round((x / (w - 1)) * 255);
      grad[p + 1] = Math.round((y / (h - 1)) * 255);
      grad[p + 2] = 128;
      grad[p + 3] = 255;
    }
    const encG = processPixels({ mode: 'gilbert', direction: 'encrypt', width: w, height: h, pixels: grad });
    const jpg = await encodeImageToBytes(encG.pixels, encG.width, encG.height, { format: 'jpg', quality: 95 });
    const jpgImg = await decodeImageFromBytes(jpg);
    const decG = processPixels({ mode: 'gilbert', direction: 'decrypt', width: jpgImg.width, height: jpgImg.height, pixels: jpgImg.pixels });
    let maxDiff = 0;
    for (let i = 0; i < grad.length; i++) { const d = Math.abs(grad[i] - decG.pixels[i]); if (d > maxDiff) maxDiff = d; }
    result.jpegMaxDiffSmooth = maxDiff;
    result.jpegSize = jpg.length;

    // 3b) 同一张渐变图的噪声版（逐像素随机，JPEG 最坏情况，仅作参考）
    const encGn = processPixels({ mode: 'gilbert', direction: 'encrypt', width: w, height: h, pixels: src });
    const jpgn = await encodeImageToBytes(encGn.pixels, encGn.width, encGn.height, { format: 'jpg', quality: 95 });
    const jpgnImg = await decodeImageFromBytes(jpgn);
    const decGn = processPixels({ mode: 'gilbert', direction: 'decrypt', width: jpgnImg.width, height: jpgnImg.height, pixels: jpgnImg.pixels });
    let maxDiffNoise = 0;
    for (let i = 0; i < src.length; i++) { const d = Math.abs(src[i] - decGn.pixels[i]); if (d > maxDiffNoise) maxDiffNoise = d; }
    result.jpegMaxDiffNoise = maxDiffNoise;

    // 4) 方块模式填充（100x50 → 128x64）
    const big = new Uint8ClampedArray(100 * 50 * 4).fill(255);
    const encB = processPixels({ mode: 'b', key: 'k', direction: 'encrypt', width: 100, height: 50, pixels: big });
    result.blockSize = encB.width + 'x' + encB.height;

    // 5) 性能参考：4000×3000（1200 万像素）各模式耗时（毫秒）
    const pw = 4000, ph = 3000;
    const bigBuf = new Uint8ClampedArray(pw * ph * 4);
    for (let i = 0; i < bigBuf.length; i += 997) bigBuf[i] = (i * 31) & 255;
    const perf = {};
    for (const [m, k] of [['gilbert', undefined], ['b', 'k'], ['c', 'k'], ['c2', 'k'], ['pe1', 0.666], ['pe2', 0.666]]) {
      const t0 = performance.now();
      processPixels({ mode: m, key: k, direction: 'encrypt', width: pw, height: ph, pixels: bigBuf });
      perf[m] = Math.round(performance.now() - t0);
    }
    result.perf12MP_ms = perf;

    return JSON.stringify(result);
  })()
`;

/**
 * 窗口底色：与 theme.css 的 --color-bg 保持一致。
 * 必须在这里定，因为窗口先于页面显示——若固定用浅色，深色主题下开窗瞬间会闪一下白底。
 * 设置文件是同步小文件，直接同步读；读不到就按系统深浅色偏好。
 */
function windowBackgroundColor() {
  const LIGHT = '#f5f6f8';
  const DARK = '#16181d';
  try {
    const saved = JSON.parse(fsSync.readFileSync(SETTINGS_FILE, 'utf8'));
    if (saved && saved.theme === 'dark') return DARK;
    if (saved && saved.theme === 'light') return LIGHT;
  } catch {
    /* 没设置过或读取失败：按系统偏好 */
  }
  return nativeTheme.shouldUseDarkColors ? DARK : LIGHT;
}

// —— 自动测试入口表（v2.8.1 起） ——
// 之前每个测试各写一个 if 块（20+ 个、仅细微差别）；统一后「加一个自动测试 = 表里加一行 +
// 文件头声明 flag」。冒烟（--smoke-test）、端到端（--self-test）、造/验样本（--make/verify-samples）
// 的形态特殊，仍在 createMainWindow 里各自保留。
// 硬约定（都是踩过的坑，别省）：
//   · app.quit() 必须在 finally——曾因 catch 里二次抛错跳过退出，留下常驻进程干扰后续测试；
//   · writeResult（结果落盘到 %TEMP%，交付验收依据）在成功/失败两分支都要做，
//     失败分支的落盘自己兜 try/catch（写不进去也要退出）。
// 字段：flag=文件头的开关变量；tag=控制台输出前缀（验收脚本按它 grep，保持原样）；
//       file/runner=测试模块与入口函数；args=实参（多数只传窗口，带加装包的补 portableDir）；
//       log=控制台输出的 JSON 摘要（保持各测试原有格式）；write=需要结果落盘。
const AUTO_TESTS = [
  { flag: uiTest, tag: 'UI_TEST', file: './tests/ui-test.js', runner: 'runUiTest', args: (win) => [win], log: (r) => JSON.stringify(r) },
  { flag: pdfTest, tag: 'PDF_TEST', file: './tests/pdf-test.js', runner: 'runPdfTest', args: (win) => [win], log: (r) => JSON.stringify(r) },
  { flag: pdfUiTest, tag: 'PDF_UI_TEST', file: './tests/pdf-ui-test.js', runner: 'runPdfUiTest', args: (win) => [win], log: (r) => JSON.stringify(r), write: true },
  { flag: mediaTest, tag: 'MEDIA_TEST', file: './tests/media-test.js', runner: 'runMediaTest', args: (win) => [win], log: (r) => JSON.stringify(r) },
  { flag: mediaUiTest, tag: 'MEDIA_UI_TEST', file: './tests/media-ui-test.js', runner: 'runMediaUiTest', args: (win) => [win], log: (r) => JSON.stringify(r), write: true },
  { flag: audioTest, tag: 'AUDIO_TEST', file: './tests/audio-test.js', runner: 'runAudioTest', args: (win) => [win], log: (r) => JSON.stringify(r) },
  { flag: audioUiTest, tag: 'AUDIO_UI_TEST', file: './tests/audio-ui-test.js', runner: 'runAudioUiTest', args: (win) => [win], log: (r) => JSON.stringify(r), write: true },
  { flag: asrTest, tag: 'ASR_TEST', file: './tests/asr-test.js', runner: 'runAsrTest', args: (win) => [win], log: (r) => JSON.stringify(r) },
  { flag: asrUiTest, tag: 'ASR_UI_TEST', file: './tests/asr-ui-test.js', runner: 'runAsrUiTest', args: (win) => [win], log: (r) => JSON.stringify(r), write: true },
  { flag: ocrPoc, tag: 'OCR_POC', file: './tests/ocr-poc.js', runner: 'runOcrPoc', args: (win) => [win], log: (r) => JSON.stringify(r) },
  { flag: themeTest, tag: 'THEME_TEST', file: './tests/theme-test.js', runner: 'runThemeTest', args: (win) => [win], log: (r) => JSON.stringify({ pass: r.pass, failures: r.failures }), write: true },
  { flag: avTest, tag: 'AV_TEST', file: './tests/av-test.js', runner: 'runAvTest', args: (win) => [win], log: (r) => JSON.stringify({ ok: r.ok, failures: r.failures }) },
  { flag: imgbatchTest, tag: 'IMGBATCH_TEST', file: './tests/imgbatch-test.js', runner: 'runImgbatchTest', args: (win) => [win], log: (r) => JSON.stringify({ ok: r.ok, failures: r.failures }) },
  { flag: settingsIoTest, tag: 'SETTINGSIO_TEST', file: './tests/settingsio-test.js', runner: 'runSettingsIoTest', args: (win) => [win], log: (r) => JSON.stringify({ pass: r.pass, failures: r.failures }) },
  { flag: pdfOcrTest, tag: 'PDF_OCR_TEST', file: './tests/pdf-ocr-test.js', runner: 'runPdfOcrTest', args: (win) => [win], log: (r) => JSON.stringify({ ok: r.ok, failures: r.failures }) },
  { flag: queueUiTest, tag: 'QUEUE_UI_TEST', file: './tests/queue-ui-test.js', runner: 'runQueueUiTest', args: (win) => [win], log: (r) => JSON.stringify({ pass: r.pass, failures: r.failures }), write: true },
  { flag: archiveTest, tag: 'ARCHIVE_TEST', file: './tests/archive-test.js', runner: 'runArchiveTest', args: () => [{ portableDir: PORTABLE_DIR }], log: (r) => JSON.stringify({ ok: r.ok, failedFormats: r.failedFormats, formatsTested: r.formatsTested, ms: r.ms }) },
  { flag: archiveUiTest, tag: 'ARCHIVE_UI_TEST', file: './tests/archive-ui-test.js', runner: 'runArchiveUiTest', args: (win) => [win], log: (r) => JSON.stringify({ pass: r.pass, failures: r.failures }), write: true },
  { flag: imgHideTest, tag: 'IMGHIDE_TEST', file: './tests/imghide-test.js', runner: 'runImgHideTest', args: (win) => [{ portableDir: PORTABLE_DIR, mainWindow: win }], log: (r) => JSON.stringify({ ok: r.ok, verified: r.verified, skipped: r.skipped }) },
  { flag: uninstallTest, tag: 'UNINSTALL_TEST', file: './tests/uninstall-test.js', runner: 'runUninstallTest', args: (win) => [win, { portableDir: PORTABLE_DIR }], log: (r) => JSON.stringify({ pass: r.pass, failures: r.failures }), write: true },
  { flag: imgHideUiTest, tag: 'IMGHIDE_UI_TEST', file: './tests/imghide-ui-test.js', runner: 'runImgHideUiTest', args: (win) => [win, { portableDir: PORTABLE_DIR }], log: (r) => JSON.stringify({ pass: r.pass, failures: r.failures }), write: true },
  { flag: playerTest, tag: 'PLAYER_TEST', file: './tests/player-test.js', runner: 'runPlayerTest', args: (win) => [win], log: (r) => JSON.stringify({ ok: r.ok, failures: r.failures }) },
  { flag: playerUiTest, tag: 'PLAYER_UI_TEST', file: './tests/player-ui-test.js', runner: 'runPlayerUiTest', args: (win) => [win], log: (r) => JSON.stringify({ pass: r.pass, failures: r.failures }), write: true },
  { flag: videodlTest, tag: 'VIDEODL_TEST', file: './tests/videodl-test.js', runner: 'runVideodlTest', args: (win) => [win, { portableDir: PORTABLE_DIR }], log: (r) => JSON.stringify({ ok: r.ok, verified: r.verified, skipped: r.skipped }) },
  { flag: videodlUiTest, tag: 'VIDEODL_UI_TEST', file: './tests/videodl-ui-test.js', runner: 'runVideodlUiTest', args: (win) => [win, { portableDir: PORTABLE_DIR }], log: (r) => JSON.stringify({ pass: r.pass, failures: r.failures }) },
  { flag: docTest, tag: 'DOC_TEST', file: './tests/doc-test.js', runner: 'runDocTest', args: (win) => [win, { portableDir: PORTABLE_DIR }], log: (r) => JSON.stringify({ ok: r.ok, failures: r.failures }) },
  { flag: docUiTest, tag: 'DOC_UI_TEST', file: './tests/doc-ui-test.js', runner: 'runDocUiTest', args: (win) => [win], log: (r) => JSON.stringify({ pass: r.pass, failures: r.failures }), write: true }
];

/** 按表注册自动测试入口（createMainWindow 里调用；一次运行只会命中一个 flag） */
function registerAutoTests() {
  for (const entry of AUTO_TESTS) {
    if (!entry.flag) continue;
    mainWindow.webContents.once('did-finish-load', async () => {
      let mod = null;
      try {
        mod = require(entry.file);
        const result = await mod[entry.runner](...entry.args(mainWindow));
        console.log(`${entry.tag} ${entry.log(result)}`);
        if (entry.write && mod.writeResult) {
          mod.writeResult({ ok: !!result.pass, at: new Date().toISOString(), result });
        }
      } catch (err) {
        console.log(`${entry.tag}_FAIL ${err.message}\n${err.stack}`);
        if (entry.write && mod && mod.writeResult) {
          try {
            mod.writeResult({ ok: false, at: new Date().toISOString(), error: err.message, stack: err.stack });
          } catch { /* 结果写不进去也要退出 */ }
        }
      } finally {
        // app.quit() 必须在 finally：曾因 catch 里二次抛错跳过退出，留下常驻进程（测试窗口不关、干扰后续测试）
        app.quit();
      }
    });
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: windowBackgroundColor(),
    title: `番茄图片混淆 桌面版 v${app.getVersion()}`,
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
    autoHideMenuBar: true, // 默认隐藏菜单栏（按 Alt 显示），保持界面清爽
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'shell', 'index.html'));

  // 纵深防御（v2.8.1）：本应用只加载本地界面，任何导航/弹窗一律拒绝。
  // 正常使用永远走不到这两个回调；万一界面被注入了跳转代码（外链、重定向），在这里兜底。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (smokeTest) {
    // 退出码：app.quit() 不带 process.exitCode，而 app.exit() 会跳过 will-quit
    // （那里有「测试模式还原用户设置」与「终止 HEIC 线程」，跳不得）。
    // 所以挂在 will-quit 末尾——它注册得最晚，前面两个清理都已经跑完。
    let smokeFailed = false;
    app.on('will-quit', () => { if (smokeFailed) process.exit(1); });
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        // 工具列表是异步渲染的，这里等一下（最多 2 秒），避免刚打开时误判为空
        const navInfo = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            for (let i = 0; i < 20; i++) {
              if (document.querySelectorAll('#toolNav .tool-item').length > 0) break;
              await new Promise((r) => setTimeout(r, 100));
            }
            // 期望值取自 registry.js 本身（与 shell 共用同一个模块实例），不写死数字：
            // 新增工具后冒烟自检自动跟上，只有「漏渲染 / 漏注册」才会被抓出来。
            const reg = await import('./registry.js');
            const ids = reg.TOOLS.map((t) => t.id);
            const rendered = [...document.querySelectorAll('#toolNav .tool-item')].map((b) => b.dataset.toolId);
            return JSON.stringify({
              expected: ids.length,
              rendered: rendered.length,
              notRendered: ids.filter((id) => !rendered.includes(id)),
              unknown: rendered.filter((id) => !ids.includes(id))
            });
          })()
        `);
        // 启动默认工具随用户排序变化（v2.7.1，见 spec/modules/toolkit.md「启动默认工具」）：
        // 下面的界面检查以「图片混淆」页为对象，先切到它，冒烟自检不受用户设置影响。
        await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const btn = [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === 'obfuscate');
            if (btn) btn.click();
            await new Promise((r) => setTimeout(r, 300));
            return true;
          })()
        `);
        const optionCount = await mainWindow.webContents.executeJavaScript(
          'document.querySelectorAll("#modeSelect option").length'
        );
        const statusText = await mainWindow.webContents.executeJavaScript(
          'document.getElementById("statusText").textContent'
        );
        // 界面元素完整性 + 逐个点按钮（空列表状态下的自检，不应报错）
        const uiCheck = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const required = ['#previewCanvas','#btnAddFirst','#btnAddMore','#thumbStrip','#thumbList','#modeSelect','#keyInput','#keyRow'];
            const missing = required.filter((sel) => !document.querySelector(sel));
            const buttons = [...document.querySelectorAll('[data-action]')];
            const clicks = [];
            for (const b of buttons) {
              try { b.click(); } catch (e) { clicks.push(b.dataset.action + ':' + e.message); }
            }
            await new Promise((r) => setTimeout(r, 150));
            return JSON.stringify({ missing, buttons: buttons.length, clickErrors: clicks });
          })()
        `);

        // 硬断言：过去这里只把 missing / clickErrors / 工具数打印出来就报 OK，
        // 哪怕只渲染出 3 个工具、按钮全点击报错也照样「全绿」，等于没有自检。
        const nav = JSON.parse(navInfo);
        const ui = JSON.parse(uiCheck);
        const failures = [];
        if (!(nav.expected > 0)) failures.push('registry.js 里一个工具都没有');
        if (nav.rendered !== nav.expected) failures.push(`导航只渲染出 ${nav.rendered}/${nav.expected} 个工具`);
        if (nav.notRendered.length) failures.push(`未渲染的工具：${nav.notRendered.join(', ')}`);
        if (nav.unknown.length) failures.push(`导航里出现 registry 未登记的工具：${nav.unknown.join(', ')}`);
        if (ui.missing.length) failures.push(`图片混淆页缺少界面元素：${ui.missing.join(', ')}`);
        if (!(ui.buttons > 0)) failures.push('图片混淆页一个可点按钮都没有');
        if (ui.clickErrors.length) failures.push(`点击按钮报错：${ui.clickErrors.join(' ｜ ')}`);
        if (!(optionCount > 0)) failures.push(`模式下拉框是空的（options=${optionCount}）`);
        if (!String(statusText || '').trim()) failures.push('顶栏状态文字为空');

        console.log(`SMOKE_NAV ${navInfo}`);
        console.log(`SMOKE_UI ${uiCheck}`);
        if (failures.length) {
          smokeFailed = true; // 让调用方（脚本 / CI）能靠退出码判定，不必去读输出文本
          console.log(`SMOKE_TEST_FAIL ${failures.length} 项：${failures.join(' ｜ ')}`);
        } else {
          console.log(`SMOKE_TEST_OK tools=${nav.rendered} options=${optionCount} status="${statusText}"`);
        }
      } catch (err) {
        smokeFailed = true;
        console.log(`SMOKE_TEST_FAIL ${err.message}`);
      }
      app.quit();
    });
  }

  if (selfTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const out = await mainWindow.webContents.executeJavaScript(SELF_TEST_SCRIPT);
        console.log(`SELF_TEST ${out}`);
      } catch (err) {
        console.log(`SELF_TEST_FAIL ${err.message}`);
      }
      app.quit();
    });
  }

  // 其余自动测试入口统一走 AUTO_TESTS 表（见函数定义处的约定）
  registerAutoTests();

  if (makeSamplesDir) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const { runMakeSamples } = require('./tests/make-samples.js');
        const result = await runMakeSamples(mainWindow, { dir: makeSamplesDir, mode: samplesMode || 'gilbert', key: samplesKey });
        console.log(`MAKE_SAMPLES ${JSON.stringify(result)}`);
      } catch (err) {
        console.log(`MAKE_SAMPLES_FAIL ${err.message}`);
      }
      app.quit();
    });
  }

  if (verifySamplesDir) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const { runVerifySamples } = require('./tests/verify-samples.js');
        const result = await runVerifySamples(mainWindow, verifySamplesDir, samplesKey);
        console.log(`VERIFY_SAMPLES ${JSON.stringify(result)}`);
      } catch (err) {
        console.log(`VERIFY_SAMPLES_FAIL ${err.message}\n${err.stack}`);
      }
      app.quit();
    });
  }
}

app.whenReady().then(() => {
  registerMediaProtocol(); // 视频播放器的本地媒体协议（tomato-media://，须在 ready 之后注册）
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// —— IPC 骨架：先只放通道占位，具体实现随功能补全（见 spec/modules/*.md） ——
// （「打开文件」类对话框统一走下面的 OPEN_FILE_DIALOGS 规格表，不再逐个注册）

// 打开文件夹对话框（用于批量导入 / 选择输出目录）
ipcMain.handle('dialog:open-folder', async () => {
  // 界面自动测试模式：直接返回测试目录
  if (testMode()) {
    const { TEST_DIR } = require('./tests/ui-test.js');
    return TEST_DIR;
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择文件夹',
    properties: ['openDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

// 保存文件对话框（用于「保存/另存」）
ipcMain.handle('dialog:save-file', async (_event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存图片',
    defaultPath: options && options.defaultPath ? options.defaultPath : undefined,
    filters: (options && options.filters) || [{ name: '图片', extensions: ['png', 'jpg'] }]
  });
  return result.canceled ? null : result.filePath;
});

// —— 文件读写（界面进程在沙箱中，统一由主进程代劳） ——

// 读取文件字节
ipcMain.handle('fs:read-file', async (_event, filePath) => {
  return fs.readFile(filePath);
});

// 取路径信息（目录 / 文件名 / 去扩展名的基础名 / 是否目录 / 体积 / 修改时间）
ipcMain.handle('fs:path-info', async (_event, filePath) => {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  const ext = path.extname(name);
  let isDirectory = false;
  let size = 0;
  let mtimeMs = 0;
  try {
    const st = await fs.stat(filePath);
    isDirectory = st.isDirectory();
    size = isDirectory ? 0 : st.size;
    mtimeMs = st.mtimeMs || 0; // 批量重命名的「按日期」规则要用
  } catch { /* 路径不存在时按文件处理 */ }
  return { dir, name, baseName: ext ? name.slice(0, -ext.length) : name, ext, isDirectory, size, mtimeMs };
});

/**
 * 批量重命名（「批量重命名」工具用）
 * 入参：renames = [{from, to, overwrite?}]
 * 返回：{ok, done, failed:[{from, to, message}], overwritten}
 *
 * 安全性：**默认绝不覆盖已存在的文件**——目标已存在（且不是本批次里要被改名的源文件）就跳过该条并报原因。
 *         只有该条显式带 overwrite:true（界面选「替换已存在文件」）时才覆盖：
 *         阶段 2 先把旧目标挪成同目录备份（.tomato-rename-bak-<ts>-<i>），改名成功后再删备份，
 *         改名失败则把备份还原回原位——覆盖不会两头空。
 * 正确性：分两阶段执行（先把所有源改成同目录下的临时名，再改成最终名），
 *        这样「链式改名」（001→002、002→003）与「互换名」都不会互相踩。
 * 跨目录：fs.rename 在跨盘时会失败，自动回退为复制 + 删除源文件。
 */
ipcMain.handle('fs:rename-batch', async (_event, renames) => {
  const list = (Array.isArray(renames) ? renames : []).filter((r) => r && r.from && r.to);
  if (list.length === 0) return { ok: false, message: '没有需要重命名的文件', done: 0, failed: [] };

  const sources = new Set(list.map((r) => path.resolve(r.from)));
  const failed = [];
  const stage1 = [];
  const stamp = Date.now();

  // 阶段 1：源文件 → 同目录临时名（源不存在或临时名创建失败的直接记为失败）
  for (let i = 0; i < list.length; i++) {
    const { from, to, overwrite } = list[i];
    const src = path.resolve(from);
    const dst = path.resolve(to);
    try {
      const st = await fs.stat(src);
      if (st.isDirectory()) throw new Error('是文件夹，已跳过');
      // 目标已存在，且它不在本批次的源文件里 → 改名会覆盖别人的文件；
      // 没勾「替换」就拒绝，勾了则交给阶段 2 走「备份 → 覆盖 → 删备份」
      if (dst !== src && sources.has(dst) === false && fsSync.existsSync(dst) && !overwrite) {
        throw new Error('目标文件已存在');
      }
      const tmp = path.join(path.dirname(src), `.tomato-rename-${stamp}-${i}`);
      await fs.rename(src, tmp);
      stage1.push({ tmp, dst, from, to, i, overwrite: !!overwrite });
    } catch (err) {
      failed.push({ from, to, message: String((err && err.message) || err) });
    }
  }

  // 阶段 2：临时名 → 最终名
  let done = 0;
  let overwritten = 0;
  for (const item of stage1) {
    let bak = null;
    try {
      // 覆盖模式：先把旧目标挪走（同目录，改名是瞬间操作），成功后再删
      if (item.overwrite && fsSync.existsSync(item.dst)) {
        bak = path.join(path.dirname(item.dst), `.tomato-rename-bak-${stamp}-${item.i}`);
        await fs.rename(item.dst, bak);
      }
      await fs.rename(item.tmp, item.dst);
      if (bak) {
        await fs.rm(bak, { force: true });
        bak = null;
        overwritten += 1;
      }
      done += 1;
    } catch (err) {
      // 跨盘（EXDEV）等情况：回退为复制 + 删源
      try {
        await fs.copyFile(item.tmp, item.dst);
        await fs.rm(item.tmp, { force: true });
        if (bak) {
          await fs.rm(bak, { force: true });
          bak = null;
          overwritten += 1;
        }
        done += 1;
      } catch (err2) {
        failed.push({ from: item.from, to: item.to, message: String((err2 && err2.message) || err2) });
        // 尽力把临时名还原回原名、把备份还原回目标位，避免文件"消失"
        try { await fs.rename(item.tmp, item.from); } catch { /* 还原失败只能如实报告 */ }
        if (bak) { try { await fs.rename(bak, item.dst); } catch { /* 同上 */ } }
      }
    }
  }

  return { ok: failed.length === 0, done, failed, overwritten };
});

// 列出文件夹内的图片（用于文件夹拖入 / 批量导入）
ipcMain.handle('fs:list-images', async (_event, dirPath) => {
  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dirPath, e.name))
    .sort();
});

// 列出文件夹内指定扩展名的文件（图片/视频类工具拖入整个文件夹时用；exts 留空 = 返回全部文件）
ipcMain.handle('fs:list-files', async (_event, dirPath, exts) => {
  const set = new Set((exts || []).map((e) => String(e).toLowerCase()));
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && (set.size === 0 || set.has(path.extname(e.name).toLowerCase())))
    .map((e) => path.join(dirPath, e.name))
    .sort();
});

// 输出文件名分配（原名 → 原名(1) → 原名(2)…，绝不覆盖已有文件）。
// 抽成独立模块是因为「挑名字」必须与「占住名字」原子完成，否则任务队列 io 通道并发 2 时
// 两个任务会拿到同一个名字、后写的静默覆盖先写的；这段逻辑不依赖 Electron，
// 抽出来才能用 `node tests/uniquepath.test.mjs` 直接钉住（细节见该文件注释）。
const { uniqueTargetPath } = require('./src/shared/unique-target-path.cjs');

// 保存图片（默认存到原图同目录；可指定输出目录；重名自动加序号，绝不覆盖已有文件）
ipcMain.handle('fs:save-image', async (_event, { sourcePath, targetDir, baseName, ext, bytes }) => {
  const dir = targetDir || (sourcePath ? path.dirname(sourcePath) : app.getPath('pictures'));
  const target = uniqueTargetPath(dir, baseName, ext);
  try {
    await fs.writeFile(target, Buffer.from(bytes));
  } catch (err) {
    // 写失败就别把占位用的 0 字节文件留在用户目录里
    await fs.rm(target, { force: true }).catch(() => {});
    throw err;
  }
  return target;
});

// 写文件（用于「保存前询问路径」的情况）
ipcMain.handle('fs:write-file', async (_event, filePath, bytes) => {
  await fs.writeFile(filePath, Buffer.from(bytes));
  return filePath;
});

// 删除文件（仅用于工具内部清理中间产物：如「目标大小」自动降档重试时的上一轮输出）
ipcMain.handle('fs:remove-file', async (_event, filePath) => {
  try {
    await fs.rm(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
});

// —— 设置读写（绿色版：存在软件目录的 userdata/settings.json） ——

/**
 * 原子写设置文件：先写同目录的临时文件，再 rename 覆盖过去。
 * 直接 writeFile 的话，写到一半被杀（或磁盘满）会留下一个截断的 JSON，
 * 而 readSettingsFile 解析失败后返回 {} —— 用户的排序/主题/输出目录等设置就静默全丢了，
 * 且看不出原因。rename 在同一卷上是原子的，任何时刻读到的都是完整的旧值或完整的新值。
 */
async function writeSettingsFile(data) {
  await fs.mkdir(USER_DATA_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, SETTINGS_FILE);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

ipcMain.handle('settings:read', async () => readSettingsFile());

ipcMain.handle('settings:write', async (_event, patch) => {
  const next = { ...(await readSettingsFile()), ...patch };
  await writeSettingsFile(next);
  return next;
});

/**
 * 导出设置：把当前设置写到用户选的位置（换机器/重装时一键带走，见 spec/modules/settings-io.md）
 * 返回 {ok, path} 或 {ok:false, canceled:true} / {ok:false, message}
 */
ipcMain.handle('settings:export', async () => {
  const current = await readSettingsFile();
  const payload = {
    _app: '番茄图片混淆 桌面版',
    _format: 1,                 // 格式版本号：将来若结构变了，导入端据此提示
    _exportedAt: new Date().toISOString(),
    _appVersion: app.getVersion(),
    settings: current
  };
  const bytes = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');

  let target = null;
  if (testMode()) {
    const { TEST_DIR } = require('./tests/ui-test.js');
    target = path.join(TEST_DIR, '设置导出.json');
  } else {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出设置',
      defaultPath: '番茄工具箱-设置.json',
      filters: [{ name: '设置文件', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    target = res.filePath;
  }
  try {
    await fs.writeFile(target, bytes);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, message: String((err && err.message) || err) };
  }
});

/**
 * 导入设置：让用户挑一个设置文件，校验后**合并**进当前设置并落盘。
 * 安全性：只接受本软件导出的结构（`settings` 字段为对象），且**只合并已知键、值必须合法**——
 * 野文件里的未知键一律忽略；已知键的值不合法（类型/范围不对）也跳过并如实上报，
 * 避免把任意值写进配置文件、再被界面拼进设置弹窗的 HTML（v2.8.1 加固）。
 * 键清单与校验规则统一在 src/shared/settings-schema.mjs（与界面共享，不再双头维护）。
 * 返回 {ok, applied, skipped, settings} 或 {ok:false, canceled|message}
 */
let settingsSchemaPromise = null;
function loadSettingsSchema() {
  if (!settingsSchemaPromise) settingsSchemaPromise = import('./src/shared/settings-schema.mjs');
  return settingsSchemaPromise;
}

ipcMain.handle('settings:import', async () => {
  let source = null;
  if (testMode()) {
    const { TEST_DIR } = require('./tests/ui-test.js');
    source = path.join(TEST_DIR, '设置导入.json');
  } else {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '导入设置',
      properties: ['openFile'],
      filters: [{ name: '设置文件', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) return { ok: false, canceled: true };
    source = res.filePaths[0];
  }

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(source, 'utf8'));
  } catch (err) {
    return { ok: false, message: `这个文件不是有效的设置文件（${String((err && err.message) || err)}）` };
  }
  const incoming = parsed && typeof parsed === 'object' ? parsed.settings : null;
  if (!incoming || typeof incoming !== 'object') {
    return { ok: false, message: '这个文件不是本软件导出的设置文件（缺少 settings 内容）' };
  }

  const schema = await loadSettingsSchema();
  const { patch, applied, skipped } = schema.pickImportableSettings(incoming);
  if (applied.length === 0) {
    return { ok: false, message: '设置文件里没有可用的设置项（已知项的值都不合法或缺失）' };
  }

  const merged = { ...(await readSettingsFile()), ...patch };
  await writeSettingsFile(merged);
  return { ok: true, applied, skipped, settings: merged, source };
});

// —— OCR 加装包（「文字识别」工具；见 spec/modules/ocr.md） ——
// 为什么放在主进程：主进程没有渲染进程的 CSP 限制，onnxruntime 的原生模块（N-API）可直接加载，
// 不必为 WASM 放宽 script-src / worker-src，也不用把 20MB 模型搬成 blob URL。链路更短、风险更低。
// 加装包位置：软件目录/addons/ocr/（随包分发，见 pack.js 步骤 5f）；缺失时工具显示放置说明。
const OCR_ADDON_DIR = path.join(PORTABLE_DIR, 'addons', 'ocr');
const OCR_MODEL_FILES = {
  detection: 'det.onnx',
  recognition: 'rec.onnx',
  charactersDictionary: 'dict.txt'
};
const OCR_FONT_PATH = path.join(OCR_ADDON_DIR, 'fonts', 'NotoSansSC-VF.ttf');

/** OCR 引擎实例：初始化要读约 20MB 模型（实测 275ms），建好后复用，不每次重建 */
let ocrService = null;
/** 正在初始化中的 Promise（避免并发重复初始化） */
let ocrInitializing = null;
/** 已请求取消的任务（按 jobId 记；引擎推理本身不可中断，在每次识别前检查即可） */
const ocrCancelled = new Set();

/** 加装包状态：文件是否齐全 + 各文件大小 */
function ocrAddonStatus() {
  const models = {};
  let found = true;
  for (const [key, file] of Object.entries(OCR_MODEL_FILES)) {
    const p = path.join(OCR_ADDON_DIR, file);
    const exists = fsSync.existsSync(p);
    models[key] = { file, exists, size: exists ? fsSync.statSync(p).size : 0 };
    if (!exists) found = false;
  }
  const fontExists = fsSync.existsSync(OCR_FONT_PATH);
  return {
    found,
    dir: OCR_ADDON_DIR,
    models,
    font: { path: OCR_FONT_PATH, exists: fontExists, size: fontExists ? fsSync.statSync(OCR_FONT_PATH).size : 0 }
  };
}

/** 懒加载并复用引擎；缺加装包时抛出可读错误 */
async function getOcrService() {
  if (ocrService) return ocrService;
  if (ocrInitializing) return ocrInitializing;
  const status = ocrAddonStatus();
  if (!status.found) {
    throw new Error('未检测到文字识别加装包：请把模型放到软件目录的 addons/ocr（需要 det.onnx / rec.onnx / dict.txt）');
  }
  ocrInitializing = (async () => {
    // ppu-paddle-ocr 是 ESM 包，主进程是 CommonJS —— 用动态 import 加载
    const { PaddleOcrService } = await import('ppu-paddle-ocr');
    const svc = new PaddleOcrService({
      model: {
        detection: path.join(OCR_ADDON_DIR, OCR_MODEL_FILES.detection),
        recognition: path.join(OCR_ADDON_DIR, OCR_MODEL_FILES.recognition),
        charactersDictionary: path.join(OCR_ADDON_DIR, OCR_MODEL_FILES.charactersDictionary)
      }
    });
    await svc.initialize();
    ocrService = svc;
    return svc;
  })();
  try {
    return await ocrInitializing;
  } finally {
    ocrInitializing = null;
  }
}

ipcMain.handle('ocr:status', async () => {
  const status = ocrAddonStatus();
  return { ...status, ready: !!ocrService };
});

/** 读中文字体字节（渲染进程做「可搜索 PDF」的隐形文字层要用；字体缺失时返回 null 由界面降级提示） */
ipcMain.handle('ocr:font', async () => {
  try {
    return { ok: true, bytes: await fs.readFile(OCR_FONT_PATH), path: OCR_FONT_PATH };
  } catch (err) {
    return { ok: false, message: `没有找到中文字体（${OCR_FONT_PATH}）：${(err && err.message) || err}` };
  }
});

/**
 * 识别一张图片的字节（PNG/JPG）
 * options: { bytes, jobId }
 * 返回：{ok, text, lines, ms, confidence}；lines 为二维数组（每行是若干识别项，含 box 坐标）
 */
ipcMain.handle('ocr:recognize', async (_event, options) => {
  const opt = options || {};
  if (!opt.bytes) return { ok: false, message: '缺少图片数据' };
  if (opt.jobId) ocrCancelled.delete(opt.jobId);
  try {
    const svc = await getOcrService();
    if (opt.jobId && ocrCancelled.has(opt.jobId)) return { ok: false, cancelled: true, message: '已取消' };
    const bytes = Buffer.isBuffer(opt.bytes) ? opt.bytes : Buffer.from(opt.bytes);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const t0 = Date.now();
    const r = await svc.recognize(ab);
    return {
      ok: true,
      text: r.text || '',
      lines: r.lines || [],
      confidence: r.confidence || 0,
      ms: Date.now() - t0
    };
  } catch (err) {
    return { ok: false, message: String((err && err.message) || err) };
  } finally {
    if (opt.jobId) ocrCancelled.delete(opt.jobId);
  }
});

/** 取消某次识别（引擎推理不可中断，在下一张/下一页开始前生效） */
ipcMain.handle('ocr:cancel', async (_event, jobId) => {
  if (!jobId) return { ok: false };
  ocrCancelled.add(jobId);
  return { ok: true };
});

// —— 剪贴板 ——

ipcMain.handle('clipboard:read-image', async () => {
  const img = clipboard.readImage();
  if (!img || img.isEmpty()) return null;
  return img.toPNG();
});

ipcMain.handle('clipboard:write-image', async (_event, bytes) => {
  const img = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (img.isEmpty()) return false;
  clipboard.writeImage(img);
  return true;
});

// —— 应用信息（界面显示版本号，便于确认打开的是哪个版本） ——
ipcMain.handle('app:info', async () => ({
  version: app.getVersion(),
  name: app.getName(),
  packaged: app.isPackaged
}));

// —— PDF 转格式 工具：文件对话框与 LibreOffice 加装包（见 spec/modules/pdf-convert.md） ——
// （open-pdfs / open-documents 对话框已并入 OPEN_FILE_DIALOGS 规格表）

// LibreOffice 加装包：位置约定 = 软件目录/addons/libreoffice/program/soffice.(com|exe)
const LIBREOFFICE_ADDON_DIR = path.join(PORTABLE_DIR, 'addons', 'libreoffice');

function findLibreOffice() {
  const candidates = [
    { p: path.join(LIBREOFFICE_ADDON_DIR, 'program', 'soffice.com'), where: 'addon' },
    { p: path.join(LIBREOFFICE_ADDON_DIR, 'program', 'soffice.exe'), where: 'addon' },
    { p: 'C:\\Program Files\\LibreOffice\\program\\soffice.com', where: 'system' },
    { p: 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com', where: 'system' }
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(c.p)) return { found: true, path: c.p, where: c.where };
  }
  return { found: false, path: null, where: null };
}

ipcMain.handle('libreoffice:status', async () => {
  const lo = findLibreOffice();
  return { found: lo.found, where: lo.where };
});

/**
 * 为加装包在短路径下建立（或复用）目录联接（junction，无需管理员权限），返回用于启动的 soffice 路径。
 * 背景：实测发现 LibreOffice 放在较长、含中文的目录（如 release\番茄图片混淆-桌面版-v1.x.x-win64\addons\…）时，
 *       PDF 导入过滤器会加载失败（报 “source file could not be loaded”），而同一份文件放在短路径下则正常。
 *       这里统一通过短路径联接启动，用户无需关心软件装在哪儿。
 */
function ensureShortAddonLink(addonRoot, sofficePath) {
  const exeName = path.basename(sofficePath);
  // 链接根目录：优先系统临时目录；若其路径含非 ASCII 字符（如中文用户名），退回 Public 目录
  const candidates = [os.tmpdir()];
  if (process.env.PUBLIC) candidates.push(process.env.PUBLIC);
  const root = candidates.find((r) => /^[\x20-\x7E]+$/.test(r)) || candidates[0];
  const linkDir = path.join(root, 'tomato-lo', 'libreoffice');
  try {
    const linkSoffice = path.join(linkDir, 'program', exeName);
    let valid = false;
    try {
      const st = fsSync.lstatSync(linkDir);
      if (st.isSymbolicLink() || st.isDirectory()) {
        const target = fsSync.readlinkSync(linkDir);
        valid = path.resolve(target) === path.resolve(addonRoot) && fsSync.existsSync(linkSoffice);
      }
    } catch { /* 链接不存在，下面创建 */ }
    if (!valid) {
      // 重要：Windows 下不能用 rmSync(recursive) 直接删联接——它会跟随联接把「目标目录的内容」删掉！
      // 目录联接用非递归 rmdir 删除，只会移除链接本身。
      try {
        const st = fsSync.lstatSync(linkDir);
        if (st.isSymbolicLink()) {
          fsSync.rmdirSync(linkDir);
        } else if (st.isDirectory()) {
          fsSync.rmSync(linkDir, { recursive: true, force: true });
        } else {
          fsSync.unlinkSync(linkDir);
        }
      } catch { /* 链接不存在等情况忽略 */ }
      fsSync.mkdirSync(path.dirname(linkDir), { recursive: true });
      fsSync.symlinkSync(addonRoot, linkDir, 'junction');
    }
    if (fsSync.existsSync(linkSoffice)) return { soffice: linkSoffice, viaLink: true };
  } catch (err) {
    console.warn('[libreoffice] 短路径联接创建失败，改用原始路径：', err.message);
  }
  return { soffice: sofficePath, viaLink: false };
}

/**
 * 超时终止转换进程。
 * Windows 下 soffice.com 只是启动器，真正干活的是它派生的 soffice.bin；
 * 只杀启动器会留下 soffice.bin 继续占住 userdata/libreoffice-profile，导致后续转换全部失败。
 * 因此用 taskkill /T 连同子进程一起杀。
 */
function killConvertTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch { /* 失败则退回普通 kill */ }
  }
  try { child.kill(); } catch { /* 已退出则忽略 */ }
}

// 转换单个文件（Office→PDF 或 PDF→DOCX）：在临时目录里转换，读完字节即清理，绝不覆盖已有文件
// mode='text'：对 PDF→DOCX 产物做压平后处理（见 core/flatten-docx.cjs），产出 Word 能正常打开的文档
ipcMain.handle('libreoffice:convert', async (_event, options) => {
  const inputPath = options && options.inputPath;
  // target 白名单：pdf（Office→PDF）/ docx（PDF→Word）/ xlsx·pptx（v2.13.0 起，文档格式转换工具的 .doc/.xls/.ppt→新格式）
  const target = ['pdf', 'docx', 'xlsx', 'pptx'].includes(options && options.target) ? options.target : 'pdf';
  if (!inputPath) return { ok: false, message: '缺少输入文件' };

  const lo = findLibreOffice();
  if (!lo.found) {
    return { ok: false, message: '未检测到 LibreOffice（可把加装包解压到软件目录的 addons/libreoffice）' };
  }

  const workDir = path.join(os.tmpdir(), `tomato-lo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(workDir, { recursive: true });
  const profileDir = path.join(USER_DATA_DIR, 'libreoffice-profile');
  await fs.mkdir(profileDir, { recursive: true });

  // 经短路径联接启动（规避长/中文路径下 PDF 导入失败的问题，见 ensureShortAddonLink 注释）
  const addonRoot = path.dirname(path.dirname(lo.path));
  const run = ensureShortAddonLink(addonRoot, lo.path);

  // 超时上限按输入体积动态计算：LibreOffice 导入 PDF 的耗时与体积近似成正比
  // （实测 12MB 中文教材约 250 秒），原先固定 3 分钟会把大文件误判为失败。
  // 规则：60 秒/MB，下限 5 分钟，上限 30 分钟。
  const sizeMb = await fs.stat(inputPath).then((s) => s.size / (1024 * 1024)).catch(() => 0);
  const timeoutMs = Math.min(30 * 60 * 1000, Math.max(5 * 60 * 1000, Math.round(sizeMb * 60 * 1000)));

  const args = ['--headless', '--norestore', '--invisible', `-env:UserInstallation=${pathToFileURL(profileDir).href}`];
  // 关键：PDF 转 Word 必须显式走 Writer 的 PDF 导入过滤器，否则 LibreOffice 会走 Draw 通道输出散架文本框。
  // 只对「输入是 PDF」加：v2.13.0 起 docx 目标也用于 .doc→.docx（文档格式转换工具），
  // 普通 .doc 走默认过滤器，套上 PDF 导入过滤器反而转换失败。
  if (target === 'docx' && /\.pdf$/i.test(inputPath)) args.push('--infilter=writer_pdf_import');
  args.push('--convert-to', target, '--outdir', workDir, inputPath);

  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    const child = spawn(run.soffice, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killConvertTree(child);
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String((err && err.message) || err), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

  // 找输出文件（LibreOffice 以输入文件的基础名为输出名）
  let outPath = null;
  try {
    const entries = await fs.readdir(workDir);
    const wanted = entries.find((n) => n.toLowerCase().endsWith(`.${target}`));
    if (wanted) outPath = path.join(workDir, wanted);
  } catch { /* 读不到就按“无输出”处理 */ }

  // 超时或退出码非零时，即便临时目录里已有半成品文件也不能当成功——那是个被中断/损坏的文档，
  // 交出去用户打开才发现是坏的（ffmpeg 那三条通道一直都查 code，这里以前漏了）。
  if (res.timedOut || res.code !== 0 || !outPath) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    const minutes = Math.max(1, Math.round(timeoutMs / 60000));
    const detail = res.timedOut
      ? `超时（超过 ${minutes} 分钟）`
      : res.code === 0
        ? '未生成输出文件（源文件可能已加密或格式不受支持）'
        : `LibreOffice 退出码 ${res.code}`;
    const extra = (res.stderr || '').trim().slice(0, 300);
    return { ok: false, message: `转换失败：${detail}${extra ? `｜${extra}` : ''}` };
  }

  const bytes = await fs.readFile(outPath);
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});

  // PDF→Word 的「可编辑文本」模式：把 LibreOffice 产出的大量浮动文本框压平成普通段落
  let finalBytes = bytes;
  let flatten = null;
  if (target === 'docx' && options && options.mode === 'text') {
    try {
      // 延迟 require：jszip 只在用到「可编辑文本」模式时才加载
      const { flattenDocx } = require('./src/tools/pdf-convert/core/flatten-docx.cjs');
      const r = await flattenDocx(bytes);
      finalBytes = r.bytes;
      flatten = r.stats;
    } catch (err) {
      // 压平失败不该丢掉已经完成的转换：原样返回，并让界面如实提示
      flatten = { applied: false, error: String((err && err.message) || err) };
    }
  }

  return { ok: true, bytes: finalBytes, ms: Date.now() - t0, flatten };
});

// —— 图片/视频/动图 专用文件对话框（图片格式转换、视频格式转换、动图与视频互转 工具用） ——

const IMAGE_ANY_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'avif', 'svg'];
// 图片格式转换额外收手机拍照格式（HEIC/HEIF/HIF，解码走主进程 libheif 引擎）；
// 其它图片工具（加水印/拼接/切图等）还不能解 HEIC，继续用 IMAGE_ANY_EXTS
const IMAGE_ANY_EXTS_WITH_HEIC = [...IMAGE_ANY_EXTS, 'heic', 'heif', 'hif'];
// 图片格式转换（仅此一个工具用）再额外收「老图片格式」：输入经随包 ffmpeg 解码成 PNG（v2.13.0，
// 解码器已逐一验证在位：tiff/pcx/targa/psd/dds/jpeg2000）；加水印等其它图片工具仍用 IMAGE_ANY_EXTS
const IMG_CONVERT_EXTRA_EXTS = ['tif', 'tiff', 'pcx', 'tga', 'psd', 'dds', 'jp2', 'j2k'];
const IMG_CONVERT_DIALOG_EXTS = [...IMAGE_ANY_EXTS_WITH_HEIC, ...IMG_CONVERT_EXTRA_EXTS];
const VIDEO_EXTS = [
  'mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'm4v', 'ts', '3gp',
  'mpg', 'mpeg', 'vob', 'rmvb', 'ogv',
  // v2.13.0 起补充的老格式/常见封装（demuxer 均已用随包 ffmpeg 验证在位）：
  // asf（wmv 同容器）、3g2/f4v（mp4 同容器）、mts/m2ts（AVCHD/蓝光 MPEG-TS）
  'asf', '3g2', 'f4v', 'mts', 'm2ts'
];
const ANIMATED_EXTS = ['gif', 'webp', 'apng'];
// 音频格式转换工具：音频扩展名 + 视频（视频会自动提取声音）
const AUDIO_EXTS = [
  'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'amr',
  'aiff', 'aif', 'ape', 'dsf', 'mpc', 'tak', 'wv', 'tta', 'ac3', 'eac3',
  'mp2', 'spx', 'caf', 'au', 'w64', 'ra', 'rm', 'oma',
  // v2.13.0 起补充的老格式（demuxer/decoder 均已用随包 ffmpeg 验证在位）：
  // shn（Shorten）、voc（创新声卡老格式）、mka（Matroska 纯音频）
  'shn', 'voc', 'mka'
];

// 文件压缩与解压工具：压缩包扩展名（仅用于「打开」对话框的过滤器；
// 真正的解压按文件签名自动识别，扩展名不对也能解）。与 src/tools/archive/core/formats.mjs 保持一致。
const ARCHIVE_EXTS_FOR_DIALOG = [
  'zip', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'br', 'rar', 'cab', 'iso', 'arj', 'lzh',
  'cpio', 'z', 'wim', 'msi', 'deb', 'rpm', 'chm', 'dmg', 'xar', 'udf', 'vhd', 'vmdk', 'squashfs'
];

// —— 打开文件的对话框：统一规格表（v2.8.1 起） ——
// 每个工具一个专用通道 + 独立夹具前缀：测试模式下只返回自己的夹具，避免历次测试的产物互相污染
// （踩过坑：共用前缀会一次加进几十个历史文件）。
// 新增工具的「选文件」对话框在这里加一行即可（preload/ctx 的接线照旧，见 preload.js）。
// 注意：印章（watermark-stamp）的夹具前缀故意**不以「测试水印」开头**，否则会被主对话框
// （startWith '测试水印'）一起选进来，导致界面测试里图片张数多出一张（踩过）。
//
// 规格：{ title, name（过滤器显示名）, exts（过滤器与夹具共用）, fixture（夹具匹配：
//   startWith=前缀 / exact=去扩展名全等；缺省=按扩展名全收）, allFiles（追加「全部文件」过滤器）,
//   multi=false（单选，如视频播放器） }
const OPEN_FILE_DIALOGS = {
  'dialog:open-images': { title: '选择图片', name: '图片', exts: ['png', 'jpg', 'jpeg', 'webp', 'bmp'], fixture: { startWith: '测试原图' } },
  'dialog:open-pdfs': { title: '选择 PDF 文件', name: 'PDF 文件', exts: ['pdf'] },
  'dialog:open-documents': { title: '选择 Word / Excel 文件', name: 'Word / Excel', exts: ['doc', 'docx', 'xls', 'xlsx'] },
  'dialog:open-image-any': {
    title: '选择图片', name: '图片（含 HEIC/ICO/AVIF/TIFF/PSD 等老格式）', exts: IMG_CONVERT_DIALOG_EXTS,
    // 测试模式只返回固定夹具「测试原图C」：避免把历次测试产生的副本/产物一起选进来（曾导致一次载入上千张）
    fixture: { exact: '测试原图C' }
  },
  'dialog:open-doc-convert': {
    title: '选择要转换的文档', name: '文档（Word / Excel / PPT / RTF）',
    exts: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pps', 'rtf'],
    fixture: { startWith: '测试老文档' }
  },
  'dialog:open-videos': { title: '选择视频', name: '视频', exts: VIDEO_EXTS, fixture: { startWith: '测试视频' } },
  'dialog:open-player-videos': {
    title: '打开视频', name: '视频', exts: VIDEO_EXTS, fixture: { startWith: '测试播放' },
    allFiles: true, multi: false // 播放器一次只开一个；测试夹具前缀与其它视频工具互不污染
  },
  'dialog:open-media': { title: '选择动图或视频', name: '动图（GIF/WebP/APNG）与视频', exts: [...ANIMATED_EXTS, ...VIDEO_EXTS], fixture: { startWith: '测试' } },
  'dialog:open-audios': { title: '选择音频或视频', name: '音频与视频（视频自动提取声音）', exts: [...AUDIO_EXTS, ...VIDEO_EXTS], fixture: { startWith: '测试音频' } },
  'dialog:open-speech': { title: '选择音频或视频', name: '音频与视频（视频自动提取声音）', exts: [...AUDIO_EXTS, ...VIDEO_EXTS], fixture: { startWith: '测试语音' } },
  'dialog:open-videos-compress': { title: '选择要压缩的视频', name: '视频', exts: VIDEO_EXTS, fixture: { startWith: '测试压缩视频' } },
  'dialog:open-audios-edit': { title: '选择音频或视频', name: '音频与视频（视频自动提取声音）', exts: [...AUDIO_EXTS, ...VIDEO_EXTS], fixture: { startWith: '测试剪辑音频' } },
  'dialog:open-watermark': { title: '选择要加水印的图片', name: '图片', exts: IMAGE_ANY_EXTS, fixture: { startWith: '测试水印' } },
  'dialog:open-watermark-stamp': { title: '选择水印图片（印章）', name: '图片', exts: IMAGE_ANY_EXTS, fixture: { startWith: '测试印章' } },
  'dialog:open-stitch': { title: '选择要拼接的图片（按列表顺序拼接）', name: '图片', exts: IMAGE_ANY_EXTS, fixture: { startWith: '测试拼接' } },
  'dialog:open-grid-slice': { title: '选择要切图的图片', name: '图片', exts: IMAGE_ANY_EXTS, fixture: { startWith: '测试切图' } },
  'dialog:open-pdf-edit': { title: '选择要整理的 PDF', name: 'PDF 文档', exts: ['pdf'], fixture: { startWith: '测试PDF编辑' } },
  'dialog:open-ocr': {
    title: '选择图片或扫描版 PDF', name: '图片与 PDF', exts: [...IMAGE_ANY_EXTS, 'pdf'],
    fixture: { startWith: '测试识别' }, allFiles: true
  }
};

for (const [channel, cfg] of Object.entries(OPEN_FILE_DIALOGS)) {
  ipcMain.handle(channel, async () => {
    if (testMode()) return testDirFiles(cfg.exts, cfg.fixture || {});
    const filters = [{ name: cfg.name, extensions: cfg.exts }];
    if (cfg.allFiles) filters.push({ name: '全部文件', extensions: ['*'] });
    const properties = cfg.multi === false ? ['openFile'] : ['openFile', 'multiSelections'];
    const result = await dialog.showOpenDialog(mainWindow, { title: cfg.title, properties, filters });
    return result.canceled ? [] : result.filePaths;
  });
}

// 批量重命名要能处理任意文件：夹具按「本工具前缀」取（不按扩展名过滤），真对话框也给「全部文件」
ipcMain.handle('dialog:open-batch-rename', async () => {
  if (testMode()) {
    const { TEST_DIR } = require('./tests/ui-test.js');
    const entries = await fs.readdir(TEST_DIR, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isFile() && e.name.startsWith('测试重命名'))
      .map((e) => path.join(TEST_DIR, e.name))
      .sort();
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要重命名的文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '图片与常用文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'txt', 'pdf', 'mp4'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  });
  return result.canceled ? [] : result.filePaths;
});

// —— 文件压缩与解压（工具：archive；见 spec/modules/archive.md） ——
// 引擎 = 随包内置的 7-Zip（软件目录/addons/7zip/，见 pack.js 步骤 5g）；
// 查找顺序「加装包 → 系统 PATH 的 7z/7za → 常见安装目录」实现了「引擎可替换」的跨平台约定。
// 具体逻辑全在 src/tools/archive/core/engine.mjs（ESM，主进程用动态 import 加载）。
let archiveEnginePromise = null;
function loadArchiveEngine() {
  if (!archiveEnginePromise) archiveEnginePromise = import('./src/tools/archive/core/engine.mjs');
  return archiveEnginePromise;
}
let archiveStatusCache = null;

ipcMain.handle('archive:status', async () => {
  if (archiveStatusCache) return archiveStatusCache;
  const engine = await loadArchiveEngine();
  archiveStatusCache = await engine.sevenZipStatus(PORTABLE_DIR);
  return archiveStatusCache;
});

// 列出压缩包内容（免解压预览）。tar.* 复合格式会自动解开外层到临时目录再列内层，绝不碰用户目录。
ipcMain.handle('archive:list', async (_event, options) => {
  const opt = options || {};
  if (!opt.archivePath) return { ok: false, message: '缺少压缩包路径' };
  const engine = await loadArchiveEngine();
  const status = await engine.sevenZipStatus(PORTABLE_DIR);
  if (!status.found) return { ok: false, message: '未检测到 7-Zip 加装包（把 addons/7zip 放回软件目录后重开本工具）' };
  return engine.listArchive({ archivePath: opt.archivePath, password: opt.password || '', binPath: status.path });
});

// 压缩：按计划逐步执行（复合格式是「先 tar 再压外层」两步）
ipcMain.handle('archive:create', async (event, options) => {
  const opt = options || {};
  const engine = await loadArchiveEngine();
  const status = await engine.sevenZipStatus(PORTABLE_DIR);
  if (!status.found) return { ok: false, message: '未检测到 7-Zip 加装包（把 addons/7zip 放回软件目录后重开本工具）' };

  const steps = Array.isArray(opt.steps) ? opt.steps : [];
  if (steps.length === 0) return { ok: false, message: '没有要执行的压缩步骤' };

  // 绝不覆盖已有文件（项目硬约定）：重名自动加序号。
  // 放在主进程做「最终裁决」——界面算出来的名字可能与磁盘实况不符（并发、外部新建）。
  const finalPath = engine.uniqueArchivePath(opt.archivePath);
  const renamed = finalPath !== opt.archivePath;
  if (renamed) {
    const oldName = path.basename(opt.archivePath);
    const newName = path.basename(finalPath);
    for (const step of steps) {
      if (step.target === opt.archivePath) step.target = finalPath;
      else if (typeof step.target === 'string' && step.target.endsWith(path.basename(opt.archivePath))) {
        // 复合格式的中间 tar（在临时目录里）不参与改名，只改最终产物
        if (step.action === 'compress') step.target = finalPath;
      }
      if (step.name === oldName) step.name = newName;
    }
  }

  // 中间产物（复合格式的 .tar）放系统临时目录，跑完自动清理，不污染用户目录
  const tempDir = opt.tempDir || await engine.makeTempDir('pack');
  const send = (payload) => {
    if (event.sender && !event.sender.isDestroyed()) event.sender.send('archive:progress', { jobId: opt.jobId, ...payload });
  };
  try {
    // 注意：必须把**改名后**的 finalPath 交给引擎汇总产物——否则重名加序号时
    // 「按 opt.archivePath 找产物」会找不到（曾导致「压缩完成但没有找到产物文件」）
    const res = await engine.createArchive({
      steps, archivePath: finalPath, binPath: status.path, jobId: opt.jobId,
      onProgress: (p) => send(p),
      isCancelled: () => opt.jobId ? archiveCancelFlags.has(opt.jobId) : false
    });
    if (res.ok) send({ percent: 100, text: '完成' });
    return res;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

// 解压：按计划逐个压缩包执行（分卷自动指向第一卷；复合格式两趟）
ipcMain.handle('archive:extract', async (event, options) => {
  const opt = options || {};
  const engine = await loadArchiveEngine();
  const status = await engine.sevenZipStatus(PORTABLE_DIR);
  if (!status.found) return { ok: false, message: '未检测到 7-Zip 加装包（把 addons/7zip 放回软件目录后重开本工具）' };

  const steps = Array.isArray(opt.steps) ? opt.steps : [];
  if (steps.length === 0) return { ok: false, message: '没有要执行的解压步骤' };
  const send = (payload) => {
    if (event.sender && !event.sender.isDestroyed()) event.sender.send('archive:progress', { jobId: opt.jobId, ...payload });
  };
  const res = await engine.extractArchive({
    steps, binPath: status.path, jobId: opt.jobId,
    onProgress: (p) => send(p),
    isCancelled: () => opt.jobId ? archiveCancelFlags.has(opt.jobId) : false
  });
  if (res.ok) send({ percent: 100, text: '完成' });
  return res;
});

/** 已请求取消的 jobId（取消是「置标志 + 杀进程」，两边都要） */
const archiveCancelFlags = new Set();

ipcMain.handle('archive:cancel', async (_event, jobId) => {
  const engine = await loadArchiveEngine();
  archiveCancelFlags.add(jobId);
  const killed = engine.cancelJob(jobId);
  return { ok: killed };
});

// 压缩包 / 待压缩文件的专用对话框（测试模式用「测试压缩」前缀夹具，避免与其它工具互相污染）
ipcMain.handle('dialog:open-archive-files', async () => {
  if (testMode()) {
    const { TEST_DIR } = require('./tests/ui-test.js');
    const dir = path.join(TEST_DIR, '测试压缩源');
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isFile())
      .map((e) => path.join(dir, e.name))
      .sort();
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要压缩的文件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '全部文件', extensions: ['*'] }]
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('dialog:open-archives', async () => {
  if (testMode()) {
    // 只要「压缩包类扩展名」的文件：压缩包只有本工具会产出，不会与其它工具的夹具撞车。
    // （不用前缀过滤：产物是「按第一个被压文件」命名的，比如 说明.7z，前缀对不上）
    const { TEST_DIR } = require('./tests/ui-test.js');
    const entries = await fs.readdir(TEST_DIR, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isFile() && /\.(zip|7z|tar|gz|bz2|xz|zst|br|rar|cab|iso)$/i.test(e.name))
      .map((e) => path.join(TEST_DIR, e.name))
      .sort();
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择压缩包',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '压缩包', extensions: ARCHIVE_EXTS_FOR_DIALOG },
      { name: '全部文件', extensions: ['*'] }
    ]
  });
  return result.canceled ? [] : result.filePaths;
});

// —— 文件藏图（工具：imghide；见 spec/modules/imghide.md） ——
// 逻辑全在 src/tools/imghide/core/engine.mjs（Node 侧：载荷拼装 / PNG·GIF 嵌入 / 密码 / 落盘）；
// 这里只做接线与进度转发。格式与官方「图夹」V6 逐字节一致，双向互通（自检里用官方实现当裁判验证）。
let imgHideEnginePromise = null;
function loadImgHideEngine() {
  if (!imgHideEnginePromise) imgHideEnginePromise = import('./src/tools/imghide/core/engine.mjs');
  return imgHideEnginePromise;
}

/** 可作表图的扩展名（与 UI 的 COVER_EXTS 一致） */
const HIDE_COVER_EXTS = ['png', 'gif', 'jpg', 'jpeg', 'webp', 'bmp', 'avif'];

// 表图对话框（打包用）：测试模式只取「测试藏图表图封面」夹具，且排除产物（名字里带 _图夹 的）
ipcMain.handle('dialog:open-hide-cover', async () => {
  if (testMode()) {
    return (await testDirFiles(HIDE_COVER_EXTS, { startWith: '测试藏图表图封面' }))
      .filter((p) => !p.includes('_图夹'));
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择表图（作为封面的图片）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: HIDE_COVER_EXTS }]
  });
  return result.canceled ? [] : result.filePaths;
});

// 图夹图片对话框（解包用，与表图分开，免得把刚做的产物再当选表图）
ipcMain.handle('dialog:open-hide-image', async () => {
  if (testMode()) {
    // 与其它界面对话框同一取舍：只认本工具的夹具/产物，避免误选到别的工具的图
    const { TEST_DIR } = require('./tests/ui-test.js');
    const entries = await fs.readdir(TEST_DIR, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isFile() && /_图夹(\(\d+\))?\.(png|gif|jpe?g|webp|bmp|avif)$/i.test(e.name))
      .map((e) => path.join(TEST_DIR, e.name))
      .sort();
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择图夹图片（要取出文件的那张图）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: HIDE_COVER_EXTS }]
  });
  return result.canceled ? [] : result.filePaths;
});

// 要藏进去的文件：任意类型；测试模式按夹具前缀取（不按扩展名过滤，与批量重命名同一做法）
ipcMain.handle('dialog:open-hide-files', async () => {
  if (testMode()) {
    const { TEST_DIR } = require('./tests/ui-test.js');
    const entries = await fs.readdir(TEST_DIR, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isFile() && e.name.startsWith('测试藏图文件'))
      .map((e) => path.join(TEST_DIR, e.name))
      .sort();
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要藏进图片的文件（任意类型，可多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '全部文件', extensions: ['*'] }]
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('imghide:pack', async (event, options) => {
  const opt = options || {};
  if (!opt.coverPath && !opt.coverBytes) return { ok: false, message: '还没有选表图' };
  if (!Array.isArray(opt.items) || opt.items.length === 0) return { ok: false, message: '还没有要藏进去的文件' };
  const engine = await loadImgHideEngine();
  try {
    return await engine.packImage({
      mode: opt.mode === 'pro' ? 'pro' : 'fast',
      coverPath: opt.coverPath || undefined,
      coverBytes: opt.coverBytes ? Buffer.from(opt.coverBytes) : undefined,
      coverKind: opt.coverKind,
      items: opt.items,
      password: opt.password || '',
      // 自定义表图：默认落在表图旁边；随机表图（没有源文件）落在系统「图片」文件夹
      // （自动测试模式下一律落测试目录，别往使用者的「图片」文件夹里写东西）
      outputDir: opt.outputDir || (opt.coverPath ? undefined : (testMode() ? require('./tests/ui-test.js').TEST_DIR : app.getPath('pictures'))),
      outputPath: opt.outputPath || undefined,
      baseName: opt.baseName || undefined,
      onProgress: (payload) => {
        if (event.sender && !event.sender.isDestroyed()) event.sender.send('imghide:progress', payload);
      }
    });
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('imghide:unpack', async (event, options) => {
  const opt = options || {};
  if (!opt.imagePath) return { ok: false, message: '还没有选图片' };
  const engine = await loadImgHideEngine();
  try {
    return await engine.unpackImage({
      imagePath: opt.imagePath,
      password: opt.password || '',
      outputDir: opt.outputDir || undefined,
      onProgress: (payload) => {
        if (event.sender && !event.sender.isDestroyed()) event.sender.send('imghide:progress', payload);
      }
    });
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

// 在资源管理器里打开产物（目录直接打开；文件则定位到它）
ipcMain.handle('imghide:reveal', async (_event, targetPath) => {
  if (!targetPath) return { ok: false, message: '缺少路径' };
  try {
    const st = await fs.stat(targetPath).catch(() => null);
    if (st && st.isDirectory()) {
      await shell.openPath(targetPath);
    } else {
      shell.showItemInFolder(targetPath);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

// —— ffmpeg 加装包（视频格式转换 / 动图与视频互转 工具；见 spec/modules/video-convert.md） ——
// 位置约定 = 软件目录/addons/ffmpeg/ffmpeg.exe（随包分发，见 pack.js 步骤 5c）；缺失时视频类工具显示放置说明。
const FFMPEG_ADDON_PATH = path.join(PORTABLE_DIR, 'addons', 'ffmpeg', 'ffmpeg.exe');

function findFfmpeg() {
  if (fsSync.existsSync(FFMPEG_ADDON_PATH)) return { found: true, path: FFMPEG_ADDON_PATH, where: 'addon' };
  // 兜底：本机 PATH 里装了 ffmpeg 也能用（开发机常见）
  try {
    const r = spawnSync('where', ['ffmpeg'], { windowsHide: true, encoding: 'utf8' });
    if (r.status === 0) {
      const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fsSync.existsSync(first)) return { found: true, path: first, where: 'system' };
    }
  } catch { /* 找不到按未安装处理 */ }
  return { found: false, path: null, where: null };
}

let ffmpegStatusCache = null;
ipcMain.handle('ffmpeg:status', async () => {
  if (ffmpegStatusCache) return ffmpegStatusCache;
  const bin = findFfmpeg();
  if (!bin.found) {
    ffmpegStatusCache = { found: false, where: null, version: null };
    return ffmpegStatusCache;
  }
  const version = await new Promise((resolve) => {
    const child = spawn(bin.path, ['-hide_banner', '-version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const m = /ffmpeg version (\S+)/.exec(out);
      resolve(m ? m[1] : null);
    });
  });
  ffmpegStatusCache = { found: true, where: bin.where, version };
  return ffmpegStatusCache;
});

/** 从 `ffmpeg -i` 的 stderr 里提取时长/分辨率/帧率/音轨等信息（静态包只带 ffmpeg，没有 ffprobe） */
function parseMediaInfo(stderr) {
  const info = {
    durationSec: 0, width: 0, height: 0, fps: 0, hasAudio: false, videoCodec: '', format: '',
    audioCodec: '', sampleRate: 0, channelLayout: ''
  };
  const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (dur) info.durationSec = (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]);
  const fmt = /Input #0, ([^,]+),/.exec(stderr);
  if (fmt) info.format = fmt[1].trim();
  for (const line of stderr.split(/\r?\n/)) {
    const v = /Stream #\d+:\d+.*?: Video: (\S+).*?, (\d{2,5})x(\d{2,5})/.exec(line);
    if (v && !info.width) {
      info.videoCodec = v[1];
      info.width = Number(v[2]);
      info.height = Number(v[3]);
    }
    const f = /(\d+(?:\.\d+)?) fps/.exec(line);
    if (f && !info.fps) info.fps = parseFloat(f[1]);
    if (/Stream #\d+:\d+.*?: Audio:/.test(line)) info.hasAudio = true;
    // 音频流细节（音频格式转换工具用：列表显示采样率/声道；缺失时保持默认值）
    const a = /Stream #\d+:\d+.*?: Audio: ([^,]+), (\d+) Hz, ([^,]+)/.exec(line);
    if (a && !info.sampleRate) {
      info.audioCodec = a[1].trim().split(' ')[0];
      info.sampleRate = Number(a[2]);
      info.channelLayout = a[3].trim();
    }
  }
  return info;
}

ipcMain.handle('ffmpeg:probe', async (_event, filePath) => {
  const bin = findFfmpeg();
  if (!bin.found) return { ok: false, message: '未检测到 ffmpeg' };
  const res = await new Promise((resolve) => {
    const child = spawn(bin.path, ['-hide_banner', '-i', filePath], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: -1, stderr: String((err && err.message) || err) }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
  const info = parseMediaInfo(res.stderr);
  // 说明：ffmpeg -i 不带输出文件时退出码为 1，属正常；能解析出信息即视为成功
  if (info.durationSec > 0 || info.width > 0) return { ok: true, ...info };
  return { ok: false, message: '无法识别该文件（可能不是媒体文件或格式不受支持）' };
});

/** 正在运行的 ffmpeg 任务（jobId → child），供「取消」使用 */
const ffmpegJobs = new Map();

function runFfmpeg(args, { jobId, onStdout, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const bin = findFfmpeg();
    if (!bin.found) {
      resolve({ code: -1, stdout: '', stderr: '未检测到 ffmpeg', notFound: true });
      return;
    }
    const child = spawn(bin.path, args, { windowsHide: true });
    if (jobId) ffmpegJobs.set(jobId, child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // 逐块 d.toString() 会把跨管道块边界的多字节字符解成 U+FFFD：ffmpeg 的 stderr 里
    // 带的是用户文件名（中文很常见），那段文本会原样显示给用户当失败原因，不能是乱码。
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; killConvertTree(child); }, timeoutMs) : null;
    const finish = (payload) => {
      if (timer) clearTimeout(timer);
      if (jobId) ffmpegJobs.delete(jobId);
      resolve(payload);
    };
    child.stdout.on('data', (d) => {
      const s = outDec.write(d);
      stdout += s;
      if (s && onStdout) onStdout(s);
    });
    child.stderr.on('data', (d) => {
      stderr += errDec.write(d);
      if (stderr.length > 200000) stderr = stderr.slice(-100000); // 只留尾部，避免异常时撑爆内存
    });
    child.on('error', (err) => finish({ code: -1, stdout: stdout + outDec.end(), stderr: String((err && err.message) || err), timedOut }));
    child.on('close', (code) => finish({ code, stdout: stdout + outDec.end(), stderr: stderr + errDec.end(), timedOut }));
  });
}

// 取消正在处理的 ffmpeg 任务（结束整棵进程树）
ipcMain.handle('ffmpeg:cancel', async (_event, jobId) => {
  const child = ffmpegJobs.get(jobId);
  if (!child) return { ok: false, message: '任务已结束或不存在' };
  killConvertTree(child);
  return { ok: true };
});

/**
 * 视频转码（文件 → 文件）：ffmpeg 直接写最终文件（避免把 GB 级数据搬进内存/走 IPC）。
 * options: { inputPath, outputDir?, baseName?, ext, args[], durationMs?, timeoutMs?, jobId }
 */
ipcMain.handle('ffmpeg:convert', async (event, options) => {
  const opt = options || {};
  const inputPath = opt.inputPath;
  if (!inputPath) return { ok: false, message: '缺少输入文件' };
  const bin = findFfmpeg();
  if (!bin.found) return { ok: false, message: '未检测到 ffmpeg（把加装包解压到软件目录的 addons/ffmpeg 后重开本工具）' };

  const dir = opt.outputDir || path.dirname(inputPath);
  const ext = String(opt.ext || '.mp4');
  const base = opt.baseName || path.basename(inputPath, path.extname(inputPath));
  const target = uniqueTargetPath(dir, base, ext);
  await fs.mkdir(dir, { recursive: true });

  const durationMs = Number(opt.durationMs) || 0;
  const limit = opt.timeoutMs || Math.min(6 * 3600 * 1000, Math.max(20 * 60 * 1000, durationMs * 10));
  const args = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...(opt.inputArgs || []), '-i', inputPath, ...(opt.args || []), target];
  const t0 = Date.now();
  const res = await runFfmpeg(args, {
    jobId: opt.jobId,
    timeoutMs: limit,
    onStdout: (chunk) => {
      if (!event.sender || event.sender.isDestroyed()) return;
      for (const line of chunk.split(/\r?\n/)) {
        const t = /^out_time_us=(\d+)/.exec(line);
        if (t && durationMs > 0) {
          const percent = Math.max(0, Math.min(99, (Number(t[1]) / 1000 / durationMs) * 100));
          event.sender.send('ffmpeg:progress', { jobId: opt.jobId, percent, timeMs: Number(t[1]) / 1000 });
        }
        const s = /^speed=(.+)$/.exec(line);
        if (s) event.sender.send('ffmpeg:progress', { jobId: opt.jobId, speed: s[1].trim() });
      }
    }
  });

  const produced = fsSync.existsSync(target) && fsSync.statSync(target).size > 0;
  if (res.timedOut || res.code !== 0 || !produced) {
    try { if (fsSync.existsSync(target)) fsSync.rmSync(target, { force: true }); } catch { /* 清理失败不影响结论 */ }
    const detail = res.notFound ? '未检测到 ffmpeg' : res.timedOut ? '处理超时' : `ffmpeg 退出码 ${res.code}`;
    const tail = (res.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ｜ ').slice(0, 300);
    return { ok: false, message: `转换失败：${detail}${tail ? `｜${tail}` : ''}` };
  }
  return { ok: true, path: target, size: fsSync.statSync(target).size, ms: Date.now() - t0 };
});

/**
 * 两遍编码转码（「视频压缩」的目标体积模式用）：
 * 第一遍只分析并写 passlog、第二遍按统计结果落盘，体积控制比单遍编码准得多。
 * passlog 放系统临时目录、两遍共用一个前缀，跑完（含失败）一定清理，不留垃圾。
 * options: { inputPath, outputDir?, baseName?, ext, inputArgs?, pass1Args[], pass2Args[], durationMs?, timeoutMs?, jobId }
 */
ipcMain.handle('ffmpeg:convert-two-pass', async (event, options) => {
  const opt = options || {};
  const inputPath = opt.inputPath;
  if (!inputPath) return { ok: false, message: '缺少输入文件' };
  const bin = findFfmpeg();
  if (!bin.found) return { ok: false, message: '未检测到 ffmpeg（把加装包解压到软件目录的 addons/ffmpeg 后重开本工具）' };

  const dir = opt.outputDir || path.dirname(inputPath);
  const ext = String(opt.ext || '.mp4');
  const base = opt.baseName || path.basename(inputPath, path.extname(inputPath));
  const target = uniqueTargetPath(dir, base, ext);
  await fs.mkdir(dir, { recursive: true });

  const durationMs = Number(opt.durationMs) || 0;
  const limit = opt.timeoutMs || Math.min(6 * 3600 * 1000, Math.max(20 * 60 * 1000, durationMs * 10));
  const workDir = path.join(os.tmpdir(), `tomato-2pass-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(workDir, { recursive: true });
  const passLog = path.join(workDir, 'pass');
  const t0 = Date.now();

  const send = (payload) => {
    if (!event.sender || event.sender.isDestroyed()) return;
    event.sender.send('ffmpeg:progress', { jobId: opt.jobId, ...payload });
  };
  // 两遍各占进度的一半：第一遍 0~50%，第二遍 50~100%
  const progressFrom = (chunk, from, span) => {
    for (const line of chunk.split(/\r?\n/)) {
      const t = /^out_time_us=(\d+)/.exec(line);
      if (t && durationMs > 0) {
        const pct = from + (Number(t[1]) / 1000 / durationMs) * span;
        send({ percent: Math.max(0, Math.min(99, pct)) });
      }
      const s = /^speed=(.+)$/.exec(line);
      if (s) send({ speed: s[1].trim() });
    }
  };

  const common = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats'];
  const inputArgs = opt.inputArgs || [];
  let failure = '';

  try {
    // 第一遍：输出丢弃（Windows 的空设备 NUL），只产出 passlog
    const pass1 = [...common, ...inputArgs, '-i', inputPath, ...(opt.pass1Args || []),
      '-pass', '1', '-passlogfile', passLog, '-f', 'null', 'NUL'];
    const r1 = await runFfmpeg(pass1, { jobId: opt.jobId, timeoutMs: limit, onStdout: (c) => progressFrom(c, 0, 50) });
    if (r1.timedOut || r1.code !== 0) {
      failure = `转换失败：${r1.timedOut ? '处理超时' : `第一遍分析失败（退出码 ${r1.code}）`}`;
    } else {
      send({ percent: 50 });
      const pass2 = [...common, ...inputArgs, '-i', inputPath, ...(opt.pass2Args || []),
        '-pass', '2', '-passlogfile', passLog, target];
      const r2 = await runFfmpeg(pass2, { jobId: opt.jobId, timeoutMs: limit, onStdout: (c) => progressFrom(c, 50, 50) });
      const produced = fsSync.existsSync(target) && fsSync.statSync(target).size > 0;
      if (r2.timedOut || r2.code !== 0 || !produced) {
        const detail = r2.timedOut ? '处理超时' : `ffmpeg 退出码 ${r2.code}`;
        const tail = (r2.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ｜ ').slice(0, 300);
        failure = `转换失败：${detail}${tail ? `｜${tail}` : ''}`;
      }
    }
  } finally {
    try { await fs.rm(workDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
  }

  if (failure) {
    try { if (fsSync.existsSync(target)) fsSync.rmSync(target, { force: true }); } catch { /* 忽略 */ }
    return { ok: false, message: failure };
  }
  return { ok: true, path: target, size: fsSync.statSync(target).size, ms: Date.now() - t0 };
});

/**
 * 多输入转码（「音频剪辑」的拼接用）：把多个文件按顺序合成一个输出。
 * 说明：ffmpeg 的 concat 滤镜需要多个 -i 与 filter_complex，与单输入的 ffmpeg:convert 不同，故单开一个通道。
 * options: { inputPaths[], outputDir?, baseName?, ext, args[], durationMs?, timeoutMs?, jobId }
 *   args 里应含 -filter_complex 与 -map（由 shared/ffmpeg.js 的 concatAudioArgs 产出）。
 */
ipcMain.handle('ffmpeg:convert-multi', async (event, options) => {
  const opt = options || {};
  const inputs = Array.isArray(opt.inputPaths) ? opt.inputPaths.filter(Boolean) : [];
  if (inputs.length < 2) return { ok: false, message: '拼接至少需要 2 个文件' };
  const bin = findFfmpeg();
  if (!bin.found) return { ok: false, message: '未检测到 ffmpeg（把加装包解压到软件目录的 addons/ffmpeg 后重开本工具）' };

  const dir = opt.outputDir || path.dirname(inputs[0]);
  const ext = String(opt.ext || '.mp3');
  const base = opt.baseName || '拼接结果';
  const target = uniqueTargetPath(dir, base, ext);
  await fs.mkdir(dir, { recursive: true });

  const durationMs = Number(opt.durationMs) || 0;
  const limit = opt.timeoutMs || Math.min(6 * 3600 * 1000, Math.max(20 * 60 * 1000, durationMs * 10));
  const inputArgs = [];
  for (const p of inputs) inputArgs.push('-i', p);
  const args = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats',
    ...inputArgs, ...(opt.args || []), target];
  const t0 = Date.now();
  const res = await runFfmpeg(args, {
    jobId: opt.jobId,
    timeoutMs: limit,
    onStdout: (chunk) => {
      if (!event.sender || event.sender.isDestroyed()) return;
      for (const line of chunk.split(/\r?\n/)) {
        const t = /^out_time_us=(\d+)/.exec(line);
        if (t && durationMs > 0) {
          const percent = Math.max(0, Math.min(99, (Number(t[1]) / 1000 / durationMs) * 100));
          event.sender.send('ffmpeg:progress', { jobId: opt.jobId, percent, timeMs: Number(t[1]) / 1000 });
        }
        const s = /^speed=(.+)$/.exec(line);
        if (s) event.sender.send('ffmpeg:progress', { jobId: opt.jobId, speed: s[1].trim() });
      }
    }
  });

  const produced = fsSync.existsSync(target) && fsSync.statSync(target).size > 0;
  if (res.timedOut || res.code !== 0 || !produced) {
    try { if (fsSync.existsSync(target)) fsSync.rmSync(target, { force: true }); } catch { /* 忽略 */ }
    const detail = res.notFound ? '未检测到 ffmpeg' : res.timedOut ? '处理超时' : `ffmpeg 退出码 ${res.code}`;
    const tail = (res.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ｜ ').slice(0, 300);
    return { ok: false, message: `拼接失败：${detail}${tail ? `｜${tail}` : ''}` };
  }
  return { ok: true, path: target, size: fsSync.statSync(target).size, ms: Date.now() - t0 };
});

/**
 * 图片字节 → 字节（图片格式转换工具的 TIFF/GIF/AVIF 走这里；临时文件在系统临时目录，用完即删）
 * options: { bytes, ext, args[] }
 */
ipcMain.handle('ffmpeg:transform', async (_event, options) => {
  const opt = options || {};
  if (!opt.bytes) return { ok: false, message: '缺少图片数据' };
  const bin = findFfmpeg();
  if (!bin.found) return { ok: false, message: '未检测到 ffmpeg（把加装包解压到软件目录的 addons/ffmpeg 后重开本工具）' };

  const workDir = path.join(os.tmpdir(), `tomato-ffmpeg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(workDir, { recursive: true });
  const ext = String(opt.ext || '.bin');
  const inPath = path.join(workDir, 'in.bin');
  const outPath = path.join(workDir, `out${ext.startsWith('.') ? ext : `.${ext}`}`);
  try {
    await fs.writeFile(inPath, Buffer.from(opt.bytes));
    const res = await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', inPath, ...(opt.args || []), outPath], {
      timeoutMs: 3 * 60 * 1000
    });
    if (res.code !== 0 || !fsSync.existsSync(outPath)) {
      const tail = (res.stderr || '').trim().split(/\r?\n/).slice(-2).join(' ｜ ').slice(0, 240);
      return { ok: false, message: `转换失败：${tail || 'ffmpeg 未生成输出文件'}` };
    }
    return { ok: true, bytes: await fs.readFile(outPath) };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * 本地文件「按路径」→ 字节（音频剪辑的波形降采样走这里）。
 * 与 ffmpeg:transform 的区别：源文件不经过界面进程、也不读进主进程内存，直接让 ffmpeg 按路径读。
 * 波形只需要几 MB 的降采样结果，而源可能是 GB 级视频——走 ffmpeg:transform 会把整份源文件
 * 在「主进程 Buffer + IPC 克隆 + 回程 IPC + 临时文件」上翻好几倍，必崩。
 * options: { inputPath, ext, args[] }
 */
ipcMain.handle('ffmpeg:transform-file', async (_event, options) => {
  const opt = options || {};
  if (!opt.inputPath) return { ok: false, message: '缺少输入文件路径' };
  if (!fsSync.existsSync(opt.inputPath)) return { ok: false, message: '找不到输入文件' };
  const bin = findFfmpeg();
  if (!bin.found) return { ok: false, message: '未检测到 ffmpeg（把加装包解压到软件目录的 addons/ffmpeg 后重开本工具）' };

  const workDir = path.join(os.tmpdir(), `tomato-ffmpeg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(workDir, { recursive: true });
  const ext = String(opt.ext || '.bin');
  const outPath = path.join(workDir, `out${ext.startsWith('.') ? ext : `.${ext}`}`);
  try {
    const res = await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', opt.inputPath, ...(opt.args || []), outPath], {
      timeoutMs: 3 * 60 * 1000
    });
    if (res.code !== 0 || !fsSync.existsSync(outPath)) {
      const tail = (res.stderr || '').trim().split(/\r?\n/).slice(-2).join(' ｜ ').slice(0, 240);
      return { ok: false, message: `转换失败：${tail || 'ffmpeg 未生成输出文件'}` };
    }
    return { ok: true, bytes: await fs.readFile(outPath) };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

// —— HEIC/HEIF 解码（工具：图片格式转换 的「手机拍照格式」输入；见 spec/modules/image-convert.md） ——
// 引擎 = heic-decode + libheif-js（官方 libheif 1.23 的 WASM 构建），跑在 worker 线程（heic-worker.js）：
// WASM 解码是同步计算，放主进程事件循环会卡住整窗 IPC（Chromium 内核与 ffmpeg 6.1 都解不了 HEIC，
// 实测依据见 spec 的「技术选型与依据」）。不依赖系统 HEIF 编解码器扩展，纯离线开箱即用。
const HEIC_DECODE_TIMEOUT_MS = 60 * 1000;

let heicWorker = null;
let heicWorkerStarting = null;
let heicSeq = 0;
const heicPending = new Map(); // id → { resolve, reject, timer }

/** worker 崩溃/超时：结束等待中的请求并置空引用，下次请求时自动重建 */
function heicWorkerCrash(reason) {
  const worker = heicWorker;
  heicWorker = null;
  if (worker) {
    try { worker.terminate(); } catch { /* 已退出 */ }
  }
  for (const [, p] of heicPending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  heicPending.clear();
}

async function getHeicWorker() {
  if (heicWorker) return heicWorker;
  if (heicWorkerStarting) return heicWorkerStarting;
  heicWorkerStarting = (async () => {
    const worker = new Worker(path.join(__dirname, 'heic-worker.js'));
    worker.on('message', (m) => {
      const p = heicPending.get(m.id);
      if (!p) return;
      heicPending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve({ width: m.width, height: m.height, pixels: m.pixels });
      else p.reject(new Error(m.message || '解码失败'));
    });
    worker.on('error', (err) => heicWorkerCrash(`HEIC 解码线程异常：${err.message}`));
    worker.on('exit', (code) => {
      if (heicWorker === worker) heicWorkerCrash(`HEIC 解码线程已退出（码 ${code}）`);
    });
    heicWorker = worker;
    return worker;
  })();
  try {
    return await heicWorkerStarting;
  } finally {
    heicWorkerStarting = null;
  }
}

/** 解码引擎状态：{found, version}（npm 依赖随包分发，正常恒为 found） */
let heicStatusCache = null;
ipcMain.handle('heic:status', async () => {
  if (heicStatusCache) return heicStatusCache;
  let found = false;
  let version = null;
  try {
    require.resolve('heic-decode');
    found = true;
    try {
      version = require('heic-decode/package.json').version;
    } catch { /* exports 字段可能拦住子路径，版本号拿不到不影响功能 */ }
  } catch {
    found = false;
  }
  heicStatusCache = { found, version };
  return heicStatusCache;
});

/**
 * HEIC/HEIF/HIF 字节 → RGBA 像素
 * 返回：{ok, width, height, pixels} 或 {ok:false, message}
 * 像素总量上限与 shared/imageio.js 保持一致（4000 万像素），超出明确报错而不是吃光内存。
 */
ipcMain.handle('heic:decode', async (_event, bytes) => {
  if (!bytes || !bytes.byteLength) return { ok: false, message: '缺少图片数据' };
  try {
    const worker = await getHeicWorker();
    const id = ++heicSeq;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        heicPending.delete(id);
        heicWorkerCrash('HEIC 解码超时（60 秒），已重建解码线程');
        reject(new Error('HEIC 解码超时（60 秒）'));
      }, HEIC_DECODE_TIMEOUT_MS);
      heicPending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, bytes });
    });
    if (result.width * result.height > 40_000_000) {
      return {
        ok: false,
        message: `图片过大（${result.width}×${result.height}，超过 4000 万像素上限），已停止处理以免内存不足。`
      };
    }
    return { ok: true, width: result.width, height: result.height, pixels: result.pixels };
  } catch (err) {
    const msg = String((err && err.message) || err);
    return {
      ok: false,
      message: /not a HEIC/i.test(msg) ? '不是有效的 HEIC/HEIF 文件（或文件已损坏）' : `HEIC 解码失败：${msg}`
    };
  }
});

app.on('will-quit', () => {
  if (heicWorker) {
    try { heicWorker.terminate(); } catch { /* 已退出 */ }
    heicWorker = null;
  }
});

// —— 视频播放器（工具：player；见 spec/modules/player.md） ——
// 播放的前提是「Chromium 能解码这个容器/编码」：本软件转出的 MP4/WebM 可直接播；
// MKV/FLV 等容器或老编码（MPEG-4 ASP / WMV）先由 ffmpeg 准备一份可播放副本再播。
// 副本落在软件目录的 userdata/player-cache（绿色版约定：不写系统 AppData），切走工具页即清理。

/** 播放缓存目录：放「可播放副本」，用完即删，可随软件目录一起搬走 */
const PLAYER_CACHE_DIR = path.join(USER_DATA_DIR, 'player-cache');

/** 扩展名 → MIME：<video> 靠它决定走哪个解码器，缺失会让浏览器按下载/无法播放处理 */
const PLAYER_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv', '.ts': 'video/mp2t',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.vob': 'video/mpeg',
  '.3gp': 'video/3gpp', '.ogv': 'video/ogg', '.rmvb': 'application/vnd.rn-realmedia-vbr'
};

/**
 * 本地媒体协议处理器：把本地文件按 HTTP 语义回给界面（支持 Range）。
 * 不直接给 file:// 的原因见文件头的协议注册注释；这里额外做到：
 *  - 只有真实存在的普通文件才回 200/206，其余 404（不暴露目录、不泄目录列表）；
 *  - 带 Accept-Ranges + 206 + Content-Range：大视频才能边读边播、进度条可拖动；
 *  - 边读边发（Node 读取流 → Web 流），不把整个文件读进内存（GB 级视频也不会爆内存）。
 */
async function handleMediaRequest(request) {
  try {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!filePath) return new Response('Bad request', { status: 400 });
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return new Response('Not found', { status: 404 });

    const mime = PLAYER_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      let start = m && m[1] ? Number(m[1]) : 0;
      let end = m && m[2] ? Number(m[2]) : stat.size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end > stat.size - 1) end = stat.size - 1;
      if (start > end) {
        return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
      }
      return new Response(Readable.toWeb(fsSync.createReadStream(filePath, { start, end })), {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        }
      });
    }
    return new Response(Readable.toWeb(fsSync.createReadStream(filePath)), {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(stat.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      }
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/** 注册媒体协议（必须在 app ready 之后调用；见 app.whenReady） */
function registerMediaProtocol() {
  protocol.handle('tomato-media', handleMediaRequest);
}

/** 缓存目录路径（界面进程不能拼路径，一律问主进程要） */
ipcMain.handle('player:cache-dir', async () => {
  await fs.mkdir(PLAYER_CACHE_DIR, { recursive: true });
  return PLAYER_CACHE_DIR;
});

/**
 * 清空播放缓存（切走工具页 / 打开新文件 / 进入工具页时调用）。
 * 逐文件删并吞掉错误：正在播放的副本可能被系统占用（EBUSY），删不掉就留给下次清理，
 * 绝不因为清理失败打断用户。
 */
ipcMain.handle('player:clean-cache', async () => {
  let removed = 0;
  let kept = 0;
  const entries = await fs.readdir(PLAYER_CACHE_DIR).catch(() => []);
  for (const name of entries) {
    try {
      await fs.rm(path.join(PLAYER_CACHE_DIR, name), { force: true, recursive: true });
      removed += 1;
    } catch {
      kept += 1;
    }
  }
  return { ok: true, removed, kept };
});

/**
 * 准备「可播放副本」：把 Chromium 播不了的容器/编码转成 MP4 放缓存目录。
 * options: { inputPath, mode:'remux'|'remux-audio'|'transcode', args[], durationMs?, jobId? }
 * 返回：{ ok, path, size, ms, cached } —— cached=true 表示命中了上次的副本（秒开）
 */
ipcMain.handle('player:prepare', async (event, options) => {
  const opt = options || {};
  const inputPath = opt.inputPath;
  if (!inputPath) return { ok: false, message: '缺少输入文件' };
  const bin = findFfmpeg();
  if (!bin.found) return { ok: false, message: '未检测到 ffmpeg（把加装包解压到软件目录的 addons/ffmpeg 后重开本工具）' };
  const stat = await fs.stat(inputPath).catch(() => null);
  if (!stat || !stat.isFile()) return { ok: false, message: '源文件不存在或不可读' };

  await fs.mkdir(PLAYER_CACHE_DIR, { recursive: true });
  // 副本名带「源路径 + 播放档位 + 大小 + 修改时间」的哈希：
  // 同一文件重开直接命中缓存（秒开）；源文件被改过则自动换新副本（不会播到旧内容）。
  const key = `${inputPath}|${opt.mode || 'transcode'}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
  const base = path.basename(inputPath, path.extname(inputPath))
    .replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'video';
  const target = path.join(PLAYER_CACHE_DIR, `${base}-${hash}.mp4`);
  const hit = fsSync.existsSync(target) && fsSync.statSync(target).size > 0;
  if (hit) return { ok: true, path: target, size: fsSync.statSync(target).size, ms: 0, cached: true };

  const durationMs = Number(opt.durationMs) || 0;
  const limit = opt.timeoutMs || Math.min(6 * 3600 * 1000, Math.max(20 * 60 * 1000, durationMs * 20));
  const args = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats',
    '-i', inputPath, ...(opt.args || []), target];
  const t0 = Date.now();
  // 进度复用 ffmpeg:progress 通道（界面侧用 shared/ffmpeg.js 的 onMediaProgress 订阅）
  const res = await runFfmpeg(args, {
    jobId: opt.jobId,
    timeoutMs: limit,
    onStdout: (chunk) => {
      if (!event.sender || event.sender.isDestroyed()) return;
      for (const line of chunk.split(/\r?\n/)) {
        const t = /^out_time_us=(\d+)/.exec(line);
        if (t && durationMs > 0) {
          const percent = Math.max(0, Math.min(99, (Number(t[1]) / 1000 / durationMs) * 100));
          event.sender.send('ffmpeg:progress', { jobId: opt.jobId, percent, timeMs: Number(t[1]) / 1000 });
        }
        const s = /^speed=(.+)$/.exec(line);
        if (s) event.sender.send('ffmpeg:progress', { jobId: opt.jobId, speed: s[1].trim() });
      }
    }
  });

  const produced = fsSync.existsSync(target) && fsSync.statSync(target).size > 0;
  if (res.timedOut || res.code !== 0 || !produced) {
    try { if (fsSync.existsSync(target)) fsSync.rmSync(target, { force: true }); } catch { /* 清理失败不影响结论 */ }
    const detail = res.notFound ? '未检测到 ffmpeg' : res.timedOut ? '处理超时' : `ffmpeg 退出码 ${res.code}`;
    const tail = (res.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ｜ ').slice(0, 300);
    return { ok: false, message: `无法准备可播放版本：${detail}${tail ? `｜${tail}` : ''}` };
  }
  return { ok: true, path: target, size: fsSync.statSync(target).size, ms: Date.now() - t0, cached: false };
});

// —— Real-ESRGAN 加装包（「图片变清晰」的 AI 放大 / 超分；见 spec/modules/image-enhance.md） ——
// 位置约定 = 软件目录/addons/realesrgan/realesrgan-ncnn-vulkan.exe（随包分发，见 pack.js 步骤 5d）。
// 说明：它是 ncnn+Vulkan 的便携版，需要支持 Vulkan 的显卡（纯 CPU 不可用），失败时界面要给出明确原因。
const AI_ADDON_DIR = path.join(PORTABLE_DIR, 'addons', 'realesrgan');

function findRealesrgan() {
  const exe = path.join(AI_ADDON_DIR, 'realesrgan-ncnn-vulkan.exe');
  if (fsSync.existsSync(exe)) return { found: true, path: exe, modelsDir: path.join(AI_ADDON_DIR, 'models') };
  return { found: false, path: null, modelsDir: null };
}

ipcMain.handle('ai:status', async () => {
  const bin = findRealesrgan();
  if (!bin.found) return { found: false, models: [] };
  let models = [];
  try {
    models = (await fs.readdir(bin.modelsDir)).filter((n) => n.endsWith('.param')).map((n) => n.replace(/\.param$/, ''));
  } catch { /* 读不到模型目录时给空列表，界面会显示 0 个 */ }
  return { found: true, models };
});

/** 从 PNG 字节里读宽高（IHDR 固定在第 16~23 字节，大端） */
function parsePngSize(buf) {
  if (buf && buf.length >= 24 && buf.toString('latin1', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}

/**
 * AI 放大（Real-ESRGAN）：PNG 字节 → 放大后的 PNG 字节。
 * options: { bytes, scale: 2|3|4, model, tile? }
 */
ipcMain.handle('ai:upscale', async (event, options) => {
  const opt = options || {};
  if (!opt.bytes) return { ok: false, message: '缺少图片数据' };
  const bin = findRealesrgan();
  if (!bin.found) {
    return { ok: false, message: '未检测到 AI 放大加装包（把 addons/realesrgan 放回软件目录后重开本工具）' };
  }

  const scale = [2, 3, 4].includes(Number(opt.scale)) ? Number(opt.scale) : 4;
  const model = typeof opt.model === 'string' && opt.model ? opt.model : 'realesrgan-x4plus';
  const workDir = path.join(os.tmpdir(), `tomato-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(workDir, { recursive: true });
  const inPath = path.join(workDir, 'in.png');
  const outPath = path.join(workDir, 'out.png');

  try {
    await fs.writeFile(inPath, Buffer.from(opt.bytes));
    const args = ['-i', inPath, '-o', outPath, '-s', String(scale), '-n', model, '-f', 'png'];
    if (opt.tile) args.push('-t', String(opt.tile));

    const t0 = Date.now();
    const res = await new Promise((resolve) => {
      const child = spawn(bin.path, args, { windowsHide: true, cwd: AI_ADDON_DIR });
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; killConvertTree(child); }, 30 * 60 * 1000);
      child.stderr.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        if (stderr.length > 200000) stderr = stderr.slice(-100000);
        // 程序按 "12.34%" 输出进度，转成统一进度事件（界面显示用）
        const m = /([\d.]+)%/.exec(s);
        if (m && event.sender && !event.sender.isDestroyed()) {
          event.sender.send('ai:progress', { percent: Number(m[1]) });
        }
      });
      child.stdout.on('data', () => { /* 忽略标准输出 */ });
      child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stderr: String((err && err.message) || err), timedOut }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr, timedOut }); });
    });

    const produced = fsSync.existsSync(outPath) && fsSync.statSync(outPath).size > 0;
    if (!produced) {
      const vkFail = /vkCreateInstance|Vulkan|no device|create instance|failed to create/i.test(res.stderr || '');
      const detail = res.timedOut
        ? '处理超时（超过 30 分钟）'
        : vkFail
          ? '本机显卡不支持 Vulkan（或驱动过旧），AI 放大用不了'
          : `AI 放大失败（退出码 ${res.code}）`;
      const tail = (res.stderr || '').trim().split(/\r?\n/).slice(-2).join(' ｜ ').slice(0, 200);
      return { ok: false, message: `${detail}${tail ? `｜${tail}` : ''}` };
    }

    const bytes = await fs.readFile(outPath);
    const size = parsePngSize(bytes);
    return { ok: true, bytes, ms: Date.now() - t0, scale, model, width: size.width, height: size.height };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

// —— FunASR 语音识别加装包（「语音转文字」；见 spec/modules/transcribe.md） ——
// 位置约定 = 软件目录/addons/asr/（随包分发，见 pack.js 步骤 5e）；缺失时工具显示放置说明。
// 说明：识别前统一把输入转成 16kHz 单声道 wav（视频自动提取音轨）——实测 exe 直读 m4a/ogg 会静默空输出，
//       统一转码是唯一稳妥路径；识别结果以 SRT 形式返回，纯文本由界面层去时间戳推导（不重复跑模型）。
const ASR_ADDON_DIR = path.join(PORTABLE_DIR, 'addons', 'asr');
const ASR_EXE = path.join(ASR_ADDON_DIR, 'llama-funasr-sensevoice.exe');
const ASR_MODEL = path.join(ASR_ADDON_DIR, 'models', 'sensevoice-small-q8.gguf');
const ASR_VAD = path.join(ASR_ADDON_DIR, 'models', 'fsmn-vad.gguf');

function findAsr() {
  if (fsSync.existsSync(ASR_EXE) && fsSync.existsSync(ASR_MODEL) && fsSync.existsSync(ASR_VAD)) {
    return { found: true };
  }
  return { found: false };
}

ipcMain.handle('asr:status', async () => {
  const asr = findAsr();
  const ff = findFfmpeg();
  return { found: asr.found, ffmpeg: !!ff.found };
});

/** 正在运行的语音识别任务（jobId → child），供「取消」使用 */
const asrJobs = new Map();

/**
 * 语音识别（文件 → 文本）：先转 16kHz 单声道 wav，再跑 SenseVoice（输出 SRT）。
 * options: { inputPath, jobId? }
 * 返回：{ok, srtText} 或 {ok:false, message}（本接口不落盘；保存由 asr:save 完成）
 */
ipcMain.handle('asr:transcribe', async (event, options) => {
  const opt = options || {};
  const inputPath = opt.inputPath;
  if (!inputPath) return { ok: false, message: '缺少输入文件' };
  if (!findAsr().found) return { ok: false, message: '未检测到语音识别加装包（把 addons/asr 放回软件目录后重开本工具）' };
  if (!findFfmpeg().found) return { ok: false, message: '未检测到 ffmpeg（识别前需要它处理音频；把加装包解压到软件目录的 addons/ffmpeg）' };

  const jobId = opt.jobId;
  const send = (payload) => {
    if (event.sender && !event.sender.isDestroyed()) event.sender.send('asr:progress', { jobId, ...payload });
  };
  const workRoot = path.join(PORTABLE_DIR, 'userdata', 'tmp');
  const workDir = path.join(workRoot, `asr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(workDir, { recursive: true });
  // 顺手清理 24 小时前的遗留任务目录（异常退出时可能残留）
  try {
    const now = Date.now();
    for (const name of await fs.readdir(workRoot)) {
      if (!name.startsWith('asr-')) continue;
      const full = path.join(workRoot, name);
      const st = await fs.stat(full).catch(() => null);
      if (st && now - st.mtimeMs > 24 * 3600 * 1000) await fs.rm(full, { recursive: true, force: true }).catch(() => {});
    }
  } catch { /* 清理失败不影响识别 */ }
  const wavPath = path.join(workDir, 'in16k.wav');

  try {
    send({ percent: 3, phase: '准备音频' });
    // 统一转 16kHz 单声道；视频（-vn）顺带提取音轨
    const conv = await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', wavPath], {
      timeoutMs: 30 * 60 * 1000
    });
    if (conv.code !== 0 || !fsSync.existsSync(wavPath)) {
      const tail = (conv.stderr || '').trim().split(/\r?\n/).slice(-2).join(' ｜ ').slice(0, 200);
      return { ok: false, message: `音频处理失败：${tail || '无法读取该文件'}` };
    }
    if (event.sender && event.sender.isDestroyed()) return { ok: false, message: '已取消' };

    // 识别（--srt：直接拿到带时间戳的字幕；阶段进度从 stderr 解析）
    const phaseMap = [
      [/loading model metadata/, 15], [/model ready/, 25], [/loading audio/, 30],
      [/audio ready/, 35], [/running VAD/, 42], [/VAD ready/, 55],
      [/building graph/, 62], [/compute starting/, 70], [/compute complete/, 95]
    ];
    const res = await new Promise((resolve) => {
      // 关键：模型/音频都传「相对 ASCII 路径」+ cwd=软件目录——含中文也安全（cwd 由系统按 Unicode 解析）
      const relArgs = [
        '-m', path.relative(PORTABLE_DIR, ASR_MODEL),
        '--vad', path.relative(PORTABLE_DIR, ASR_VAD),
        '-a', path.relative(PORTABLE_DIR, wavPath),
        '--srt'
      ];
      const child = spawn(ASR_EXE, relArgs, { windowsHide: true, cwd: PORTABLE_DIR });
      if (jobId) asrJobs.set(jobId, child);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => killConvertTree(child), 2 * 3600 * 1000);
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        if (stderr.length > 200000) stderr = stderr.slice(-100000);
        for (const [re, percent] of phaseMap) {
          if (re.test(s)) send({ percent, phase: '识别中' });
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        if (jobId) asrJobs.delete(jobId);
        resolve({ code: -1, stdout, stderr: String((err && err.message) || err) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (jobId) asrJobs.delete(jobId);
        resolve({ code, stdout, stderr });
      });
    });

    const srtText = String(res.stdout || '').replace(/^\uFEFF/, '').trim();
    if (res.code !== 0) {
      const tail = (res.stderr || '').trim().split(/\r?\n/).slice(-2).join(' ｜ ').slice(0, 200);
      return { ok: false, message: `识别失败（退出码 ${res.code}）${tail ? `｜${tail}` : ''}` };
    }
    if (!srtText) {
      return { ok: false, message: '未识别到语音内容（可能是纯音乐或没有人声）' };
    }
    send({ percent: 100, phase: '完成' });
    return { ok: true, srtText };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

// 取消正在处理的语音识别任务（结束整棵进程树）
ipcMain.handle('asr:cancel', async (_event, jobId) => {
  const child = asrJobs.get(jobId);
  if (!child) return { ok: false, message: '任务已结束或不存在' };
  killConvertTree(child);
  return { ok: true };
});

/**
 * 保存识别产物（.txt / .srt；重名自动加序号，绝不覆盖已有文件）
 * options: { targetDir, baseName, files: [{ext, text}] }
 */
ipcMain.handle('asr:save', async (_event, options) => {
  const opt = options || {};
  const dir = opt.targetDir;
  const base = opt.baseName || '识别结果';
  const files = Array.isArray(opt.files) ? opt.files : [];
  if (!dir || files.length === 0) return { ok: false, message: '缺少保存参数' };
  try {
    await fs.mkdir(dir, { recursive: true });
    const paths = [];
    for (const f of files) {
      const ext = String(f.ext || '.txt');
      const target = uniqueTargetPath(dir, base, ext);
      try {
        // UTF-8 带 BOM：Windows 记事本/字幕工具双击即正常显示中文
        await fs.writeFile(target, `\uFEFF${String(f.text == null ? '' : f.text)}`, 'utf8');
      } catch (err) {
        await fs.rm(target, { force: true }).catch(() => {}); // 别把占位文件留给用户
        throw err;
      }
      paths.push(target);
    }
    return { ok: true, paths };
  } catch (err) {
    return { ok: false, message: `保存失败：${err.message}` };
  }
});

// —— 内置降级：docx / xlsx → PDF（隐藏窗口渲染 + Chromium printToPDF，不依赖加装包） ——

/** 轮询隐藏窗口里的渲染状态（页内脚本写 window.__officeRenderState） */
async function waitForRenderState(win, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const state = await win.webContents
      .executeJavaScript('window.__officeRenderState || ""')
      .catch(() => '');
    if (state === 'done' || (typeof state === 'string' && state.startsWith('error:'))) return state;
    if (Date.now() - t0 > timeoutMs) return 'error: 渲染超时';
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

ipcMain.handle('office:to-pdf', async (_event, options) => {
  const inputPath = options && options.inputPath;
  const kind = options && options.kind === 'xlsx' ? 'xlsx' : 'docx';
  if (!inputPath) return { ok: false, message: '缺少输入文件' };

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  try {
    await win.loadFile(path.join(__dirname, 'src', 'tools', 'pdf-convert', 'preview', 'office-print.html'), {
      query: { file: inputPath, kind }
    });
    const state = await waitForRenderState(win, 60000);
    if (state !== 'done') {
      return { ok: false, message: `内置转换失败：${state.replace(/^error:\s*/, '')}` };
    }
    const t0 = Date.now();
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.55, bottom: 0.55, left: 0.55, right: 0.55 } // 单位：英寸（约 14mm）
    });
    return { ok: true, bytes: pdf, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, message: `内置转换失败：${(err && err.message) || err}` };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});

// —— 软件卸载（工具：uninstall；见 spec/modules/uninstall.md） ——
// 引擎 = 随包内置的 HiBit Uninstaller 便携版（软件目录/addons/hibit/，见 pack.js 步骤 5h）。
// 它的 exe 清单声明了 requireAdministrator（不提权起不来），所以启动一律走提权路径；
// 提权命令的拼装与结果解读在 src/tools/uninstall/core/launch.mjs（纯函数，自检共用）。
const HIBIT_ADDON_DIR = path.join(PORTABLE_DIR, 'addons', 'hibit');
let hibitLaunchPromise = null;
function loadHibitLaunch() {
  if (!hibitLaunchPromise) hibitLaunchPromise = import('./src/tools/uninstall/core/launch.mjs');
  return hibitLaunchPromise;
}

async function findHibit() {
  const lib = await loadHibitLaunch();
  const exePath = path.join(HIBIT_ADDON_DIR, lib.EXE_NAME);
  if (!fsSync.existsSync(exePath)) {
    return lib.describeAddonStatus({ found: false, dir: HIBIT_ADDON_DIR });
  }
  let version = '';
  try {
    version = fsSync.readFileSync(path.join(HIBIT_ADDON_DIR, lib.VERSION_FILE), 'utf8');
  } catch { /* 版本文件缺失不影响启动，界面照常显示「已就绪」 */ }
  return lib.describeAddonStatus({ found: true, exePath, dir: HIBIT_ADDON_DIR, version });
}

ipcMain.handle('hibit:status', async () => findHibit());

// 以管理员身份启动卸载工具：
//  - 自动化测试模式（testMode）下一律空跑——否则会弹 UAC 卡住测试，甚至真的执行卸载动作；
//  - 不传任何参数给对方，不给「无人值守自动卸载」留口子。
ipcMain.handle('hibit:launch', async () => {
  const lib = await loadHibitLaunch();
  const st = await findHibit();
  if (!st.found) return { ok: false, message: '未检测到软件卸载加装包（把 addons/hibit 放回软件目录后重开本工具）' };
  if (testMode()) return { ok: true, dryRun: true, path: st.path };

  const psExe = lib.powershellPath();
  if (!fsSync.existsSync(psExe)) {
    return { ok: false, message: `未找到 PowerShell（${psExe}），无法以管理员身份启动` };
  }
  const script = lib.buildRunAsScript({ exePath: st.path, workingDir: st.dir });
  const r = spawnSync(psExe, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' });
  return lib.interpretLaunchResult({ status: r.status, stdout: r.stdout, stderr: r.stderr });
});

// ═══ 视频下载（「视频下载」工具；见 spec/modules/videodl.md） ═══
// 引擎在主进程跑（任务不随工具页回收而中断）；三条通道与加固见 src/tools/videodl/core/。
// 上游来源 leetools/video-downloader（MIT），许可文本随代码在 src/tools/videodl/UPSTREAM-LICENSE.txt。
let videodlManagerPromise = null;
function getVideodlManager() {
  if (!videodlManagerPromise) {
    videodlManagerPromise = import('./src/tools/videodl/core/manager.mjs').then(({ createVideoDownloader }) => {
      const ffmpeg = findFfmpeg();
      // 自动测试：历史/引擎状态写临时目录（每进程一个，保证「初始为空」），不碰用户的 userdata
      const userdataDir = testMode() ? path.join(os.tmpdir(), `tomato-videodl-testdata-${process.pid}`) : USER_DATA_DIR;
      return createVideoDownloader({
        addonsRoot: path.join(PORTABLE_DIR, 'addons'),
        toolRoot: path.join(__dirname, 'src', 'tools', 'videodl'),
        userdataDir,
        ffmpegPath: ffmpeg.found ? ffmpeg.path : '',
        onChanged: (list) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('videodl:changed', list);
        }
      });
    });
  }
  return videodlManagerPromise;
}

ipcMain.handle('videodl:start', async (_event, options = {}) => {
  try {
    const manager = await getVideodlManager();
    const job = await manager.start(String(options.url || ''), String(options.dir || ''));
    return { ok: true, job };
  } catch (error) {
    return { ok: false, message: error.message || '开始下载失败' };
  }
});
ipcMain.handle('videodl:cancel', async (_event, id) => (await getVideodlManager()).cancel(String(id || '')));
ipcMain.handle('videodl:retry', async (_event, id) => {
  try {
    const job = await (await getVideodlManager()).retry(String(id || ''));
    return job ? { ok: true, job } : { ok: false, message: '这条记录已经不能重试了' };
  } catch (error) {
    return { ok: false, message: error.message || '重试失败' };
  }
});
ipcMain.handle('videodl:list', async () => (await getVideodlManager()).list());
ipcMain.handle('videodl:clear-history', async () => (await getVideodlManager()).clearHistory());
ipcMain.handle('videodl:reveal', async (_event, filePath) => {
  // 自动测试模式空跑：避免测试期间真的弹出资源管理器窗口
  if (typeof filePath === 'string' && filePath && fsSync.existsSync(filePath) && !testMode()) shell.showItemInFolder(filePath);
  return true;
});

// 引擎状态：顺带做「每周自动检查一次」（可关；自动测试模式不联网检查）；检查结果通过 videodl:changed 推给界面
ipcMain.handle('videodl:status', async () => {
  const manager = await getVideodlManager();
  const saved = await readSettingsFile();
  const autoCheck = saved.videodlAutoCheck !== false;
  if (!testMode()) manager.ensureAutoCheck(autoCheck).catch(() => {});
  return {
    ok: true,
    defaultDir: path.join(os.homedir(), 'Downloads', '视频素材'),
    autoCheck,
    ...manager.engineStatus()
  };
});
ipcMain.handle('videodl:engine-check', async () => {
  const manager = await getVideodlManager();
  return manager.checkEngine({ force: true });
});
ipcMain.handle('videodl:engine-update', async () => {
  const manager = await getVideodlManager();
  return manager.updateEngine({
    onProgress: ({ received, total }) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('videodl:engine-progress', { received, total });
    }
  });
});