// 渲染进程与主进程之间的安全桥（骨架）
// 只暴露白名单方法，界面代码不直接接触 Node/Electron 能力。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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
  saveFile: (options) => ipcRenderer.invoke('dialog:save-file', options)
});