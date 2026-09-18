// 渲染进程与主进程之间的安全桥
// 只暴露白名单方法，界面代码不直接接触 Node/Electron 能力。
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  // 系统信息（显示在帮助/关于中）
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },

  // 文件对话框
  openImages: () => ipcRenderer.invoke('dialog:open-images'),
  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  saveFile: (options) => ipcRenderer.invoke('dialog:save-file', options),

  // 文件读写（界面进程处于沙箱中，必须经由主进程）
  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, bytes) => ipcRenderer.invoke('fs:write-file', filePath, bytes),
  pathInfo: (filePath) => ipcRenderer.invoke('fs:path-info', filePath),
  listImages: (dirPath) => ipcRenderer.invoke('fs:list-images', dirPath),
  saveImageNextTo: (options) => ipcRenderer.invoke('fs:save-image', options),

  // 设置（绿色版：存在软件目录内）
  settingsRead: () => ipcRenderer.invoke('settings:read'),
  settingsWrite: (patch) => ipcRenderer.invoke('settings:write', patch),

  // 拖拽文件取真实路径（Electron 新版不再提供 file.path）
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  // 剪贴板
  readClipboardImage: () => ipcRenderer.invoke('clipboard:read-image'),
  writeClipboardImage: (bytes) => ipcRenderer.invoke('clipboard:write-image', bytes)
});