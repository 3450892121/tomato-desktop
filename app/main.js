// 番茄图片混淆 桌面版 — Electron 主进程（骨架）
// 职责：创建窗口、加载界面、提供文件对话框与本地设置读写等系统能力。
'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

/** @type {BrowserWindow | null} */
let mainWindow = null;

// 冒烟自检：`electron . --smoke-test` 时窗口加载完成后自动退出，
// 并打印模式下拉框的选项数量，用于确认界面框架能正常跑起来。
const smokeTest = process.argv.includes('--smoke-test');

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

  mainWindow.loadFile(path.join(__dirname, 'src', 'ui', 'index.html'));

  if (smokeTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const optionCount = await mainWindow.webContents.executeJavaScript(
          'document.querySelectorAll("#modeSelect option").length'
        );
        const statusText = await mainWindow.webContents.executeJavaScript(
          'document.getElementById("statusText").textContent'
        );
        console.log(`SMOKE_TEST_OK options=${optionCount} status="${statusText}"`);
      } catch (err) {
        console.log(`SMOKE_TEST_FAIL ${err.message}`);
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