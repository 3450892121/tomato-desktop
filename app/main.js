// 番茄图片混淆 桌面版 — Electron 主进程（骨架）
// 职责：创建窗口、加载界面、提供文件对话框与本地设置读写等系统能力。
'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

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

// 测试模式下关闭硬件加速：保证截图（capturePage）在任何机器上都能稳定拿到画面
if (uiTest || pdfUiTest || mediaUiTest) {
  app.disableHardwareAcceleration();
}

/** 是否处于任一自动测试模式：此时系统对话框一律换成本地测试文件（避免测试卡在弹窗上） */
const testMode = () => uiTest || pdfUiTest || mediaTest || mediaUiTest;

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

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#f5f6f8', // 与 theme.css 的 --color-bg 保持一致
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

  if (smokeTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        // 工具列表是异步渲染的，这里等一下（最多 2 秒），避免刚打开时误判为空
        const toolCount = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            for (let i = 0; i < 20; i++) {
              const n = document.querySelectorAll('#toolNav .tool-item').length;
              if (n > 0) return n;
              await new Promise((r) => setTimeout(r, 100));
            }
            return document.querySelectorAll('#toolNav .tool-item').length;
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
        console.log(`SMOKE_TEST_OK tools=${toolCount} options=${optionCount} status="${statusText}"`);
        console.log(`SMOKE_UI ${uiCheck}`);
      } catch (err) {
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

  if (uiTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const { runUiTest } = require('./tests/ui-test.js');
        const result = await runUiTest(mainWindow);
        console.log(`UI_TEST ${JSON.stringify(result)}`);
      } catch (err) {
        console.log(`UI_TEST_FAIL ${err.message}\n${err.stack}`);
      }
      app.quit();
    });
  }

  if (pdfTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const { runPdfTest } = require('./tests/pdf-test.js');
        const result = await runPdfTest(mainWindow);
        console.log(`PDF_TEST ${JSON.stringify(result)}`);
      } catch (err) {
        console.log(`PDF_TEST_FAIL ${err.message}\n${err.stack}`);
      }
      app.quit();
    });
  }

  if (pdfUiTest) {
    const { runPdfUiTest, writeResult } = require('./tests/pdf-ui-test.js');
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const result = await runPdfUiTest(mainWindow);
        console.log(`PDF_UI_TEST ${JSON.stringify(result)}`);
        writeResult({ ok: !!result.pass, at: new Date().toISOString(), result });
      } catch (err) {
        console.log(`PDF_UI_TEST_FAIL ${err.message}\n${err.stack}`);
        writeResult({ ok: false, at: new Date().toISOString(), error: err.message, stack: err.stack });
      }
      app.quit();
    });
  }

  if (mediaTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const { runMediaTest } = require('./tests/media-test.js');
        const result = await runMediaTest(mainWindow);
        console.log(`MEDIA_TEST ${JSON.stringify(result)}`);
      } catch (err) {
        console.log(`MEDIA_TEST_FAIL ${err.message}\n${err.stack}`);
      }
      app.quit();
    });
  }

  if (mediaUiTest) {
    const { runMediaUiTest, writeResult } = require('./tests/media-ui-test.js');
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const result = await runMediaUiTest(mainWindow);
        console.log(`MEDIA_UI_TEST ${JSON.stringify(result)}`);
        writeResult({ ok: !!result.pass, at: new Date().toISOString(), result });
      } catch (err) {
        console.log(`MEDIA_UI_TEST_FAIL ${err.message}\n${err.stack}`);
        writeResult({ ok: false, at: new Date().toISOString(), error: err.message, stack: err.stack });
      }
      app.quit();
    });
  }

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

// 打开图片文件对话框（返回所选路径列表）
ipcMain.handle('dialog:open-images', async () => {
  // 界面自动测试模式：跳过系统对话框，直接返回测试目录内的图片
  if (testMode()) {
    const { TEST_DIR } = require('./tests/ui-test.js');
    const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
    const entries = await fs.readdir(TEST_DIR, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()) && e.name.startsWith('测试原图'))
      .map((e) => path.join(TEST_DIR, e.name))
      .sort();
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择图片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
  });
  return result.canceled ? [] : result.filePaths;
});

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

// 取路径信息（目录 / 文件名 / 去扩展名的基础名 / 是否目录）
ipcMain.handle('fs:path-info', async (_event, filePath) => {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  const ext = path.extname(name);
  let isDirectory = false;
  try {
    isDirectory = (await fs.stat(filePath)).isDirectory();
  } catch { /* 路径不存在时按文件处理 */ }
  return { dir, name, baseName: ext ? name.slice(0, -ext.length) : name, ext, isDirectory };
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

/** 在目标目录里挑一个不重名的文件名（原名 → 原名(1) → 原名(2)…），绝不覆盖已有文件 */
function uniqueTargetPath(dir, baseName, ext) {
  const suffix = ext.startsWith('.') ? ext : `.${ext}`;
  let target = path.join(dir, `${baseName}${suffix}`);
  let i = 1;
  while (fsSync.existsSync(target)) {
    target = path.join(dir, `${baseName}(${i})${suffix}`);
    i += 1;
  }
  return target;
}

// 保存图片（默认存到原图同目录；可指定输出目录；重名自动加序号，绝不覆盖已有文件）
ipcMain.handle('fs:save-image', async (_event, { sourcePath, targetDir, baseName, ext, bytes }) => {
  const dir = targetDir || (sourcePath ? path.dirname(sourcePath) : app.getPath('pictures'));
  const target = uniqueTargetPath(dir, baseName, ext);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(target, Buffer.from(bytes));
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

ipcMain.handle('settings:read', async () => readSettingsFile());

ipcMain.handle('settings:write', async (_event, patch) => {
  const next = { ...(await readSettingsFile()), ...patch };
  await fs.mkdir(USER_DATA_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
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

// 打开 PDF 文件对话框（可多选）
ipcMain.handle('dialog:open-pdfs', async () => {
  // 界面自动测试模式：跳过系统对话框，直接返回测试目录里的 PDF
  if (testMode()) {
    const { TEST_DIR } = require('./tests/ui-test.js');
    const entries = await fs.readdir(TEST_DIR, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf'))
      .map((e) => path.join(TEST_DIR, e.name))
      .sort();
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 PDF 文件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
  });
  return result.canceled ? [] : result.filePaths;
});

// 打开 Word/Excel 文件对话框（可多选）
ipcMain.handle('dialog:open-documents', async () => {
  if (testMode()) {
    const { TEST_DIR } = require('./tests/ui-test.js');
    const DOC_EXTS = new Set(['.doc', '.docx', '.xls', '.xlsx']);
    const entries = await fs.readdir(TEST_DIR, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isFile() && DOC_EXTS.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(TEST_DIR, e.name))
      .sort();
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Word / Excel 文件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Word / Excel', extensions: ['doc', 'docx', 'xls', 'xlsx'] }]
  });
  return result.canceled ? [] : result.filePaths;
});

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
  const target = options && options.target === 'docx' ? 'docx' : 'pdf';
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
  // 关键：PDF 转 Word 必须显式走 Writer 的 PDF 导入过滤器，否则 LibreOffice 会走 Draw 通道输出散架文本框
  if (target === 'docx') args.push('--infilter=writer_pdf_import');
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

  // 超时时即便临时目录里已有半成品文件也不能当成功——那是个被中断的残缺文档
  if (res.timedOut || !outPath) {
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
const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'm4v', 'ts', '3gp', 'mpg', 'mpeg', 'vob', 'rmvb', 'ogv'];
const ANIMATED_EXTS = ['gif', 'webp', 'apng'];

// 图片（含 ICO/AVIF/SVG 等扩展名）
ipcMain.handle('dialog:open-image-any', async () => {
  // 测试模式只返回固定夹具「测试原图C」：避免把历次测试产生的副本/产物一起选进来（曾导致一次载入上千张）
  if (testMode()) return testDirFiles(IMAGE_ANY_EXTS, { exact: '测试原图C' });
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择图片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片（含 ICO/AVIF/SVG）', extensions: IMAGE_ANY_EXTS }]
  });
  return result.canceled ? [] : result.filePaths;
});

// 视频
ipcMain.handle('dialog:open-videos', async () => {
  if (testMode()) return testDirFiles(VIDEO_EXTS, { startWith: '测试视频' });
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择视频',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '视频', extensions: VIDEO_EXTS }]
  });
  return result.canceled ? [] : result.filePaths;
});

// 动图与视频（动图与视频互转工具）
ipcMain.handle('dialog:open-media', async () => {
  if (testMode()) return testDirFiles([...VIDEO_EXTS, ...ANIMATED_EXTS], { startWith: '测试' });
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择动图或视频',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '动图（GIF/WebP/APNG）与视频', extensions: [...ANIMATED_EXTS, ...VIDEO_EXTS] }]
  });
  return result.canceled ? [] : result.filePaths;
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
  const info = { durationSec: 0, width: 0, height: 0, fps: 0, hasAudio: false, videoCodec: '', format: '' };
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
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; killConvertTree(child); }, timeoutMs) : null;
    const finish = (payload) => {
      if (timer) clearTimeout(timer);
      if (jobId) ffmpegJobs.delete(jobId);
      resolve(payload);
    };
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onStdout) onStdout(s);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-100000); // 只留尾部，避免异常时撑爆内存
    });
    child.on('error', (err) => finish({ code: -1, stdout, stderr: String((err && err.message) || err), timedOut }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
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