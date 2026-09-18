// 番茄图片混淆 桌面版 — Electron 主进程（骨架）
// 职责：创建窗口、加载界面、提供文件对话框与本地设置读写等系统能力。
'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');

/** @type {BrowserWindow | null} */
let mainWindow = null;

// 冒烟自检：`electron . --smoke-test` 时窗口加载完成后自动退出，
// 并打印模式下拉框的选项数量，用于确认界面框架能正常跑起来。
const smokeTest = process.argv.includes('--smoke-test');

// 端到端自检：`electron . --self-test` 在界面进程里跑「图片编解码 + 算法 + 保存格式」全链路
const selfTest = process.argv.includes('--self-test');

// 界面自动测试：`electron . --ui-test` 像真人一样点按钮走完整流程，逐步截图并做像素级校验
const uiTest = process.argv.includes('--ui-test');

// 测试模式下关闭硬件加速：保证截图（capturePage）在任何机器上都能稳定拿到画面
if (uiTest) {
  app.disableHardwareAcceleration();
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
    title: '番茄图片混淆 桌面版',
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
        const toolCount = await mainWindow.webContents.executeJavaScript(
          'document.querySelectorAll("#toolNav .tool-item").length'
        );
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
  if (uiTest) {
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

// 打开文件夹对话框（用于批量导入）
ipcMain.handle('dialog:open-folder', async () => {
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

// 取路径信息（目录 / 文件名 / 去扩展名的基础名）
ipcMain.handle('fs:path-info', async (_event, filePath) => {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  const ext = path.extname(name);
  return { dir, name, baseName: ext ? name.slice(0, -ext.length) : name, ext };
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

// 保存图片到「原图所在目录」（与原图同目录，重名自动加序号，绝不覆盖已有文件）
ipcMain.handle('fs:save-image', async (_event, { sourcePath, baseName, ext, bytes }) => {
  const dir = sourcePath ? path.dirname(sourcePath) : app.getPath('pictures');
  const suffix = ext.startsWith('.') ? ext : `.${ext}`;
  let target = path.join(dir, `${baseName}${suffix}`);
  let i = 1;
  while (fsSync.existsSync(target)) {
    target = path.join(dir, `${baseName}(${i})${suffix}`);
    i += 1;
  }
  await fs.writeFile(target, Buffer.from(bytes));
  return target;
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