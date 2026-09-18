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
  // 应用信息（版本号，界面用来确认打开的是哪个版本）
  appInfo: () => ipcRenderer.invoke('app:info'),

  // 文件对话框
  openImages: () => ipcRenderer.invoke('dialog:open-images'),
  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  saveFile: (options) => ipcRenderer.invoke('dialog:save-file', options),

  // 文件读写（界面进程处于沙箱中，必须经由主进程）
  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, bytes) => ipcRenderer.invoke('fs:write-file', filePath, bytes),
  removeFile: (filePath) => ipcRenderer.invoke('fs:remove-file', filePath),
  pathInfo: (filePath) => ipcRenderer.invoke('fs:path-info', filePath),
  listImages: (dirPath) => ipcRenderer.invoke('fs:list-images', dirPath),
  listFiles: (dirPath, exts) => ipcRenderer.invoke('fs:list-files', dirPath, exts),
  saveImageNextTo: (options) => ipcRenderer.invoke('fs:save-image', options),

  // 新工具（图片格式转换 / 视频格式转换 / 动图与视频互转）：专用对话框
  openImageAny: () => ipcRenderer.invoke('dialog:open-image-any'),
  openVideos: () => ipcRenderer.invoke('dialog:open-videos'),
  openMedia: () => ipcRenderer.invoke('dialog:open-media'),

  // ffmpeg 加装包（视频/动图工具；见 spec/modules/video-convert.md）
  ffmpegStatus: () => ipcRenderer.invoke('ffmpeg:status'),
  ffmpegProbe: (filePath) => ipcRenderer.invoke('ffmpeg:probe', filePath),
  ffmpegConvert: (options) => ipcRenderer.invoke('ffmpeg:convert', options),
  ffmpegTransform: (options) => ipcRenderer.invoke('ffmpeg:transform', options),
  ffmpegCancel: (jobId) => ipcRenderer.invoke('ffmpeg:cancel', jobId),
  // 进度订阅（返回取消订阅函数，工具 unmount 时必须调用）
  ffmpegOnProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('ffmpeg:progress', handler);
    return () => ipcRenderer.removeListener('ffmpeg:progress', handler);
  },

  // Real-ESRGAN 加装包（「图片变清晰」的 AI 放大；见 spec/modules/image-enhance.md）
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiUpscale: (options) => ipcRenderer.invoke('ai:upscale', options),
  aiOnProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('ai:progress', handler);
    return () => ipcRenderer.removeListener('ai:progress', handler);
  },

  // PDF 工具：专用文件对话框与 LibreOffice 加装包
  openPdfs: () => ipcRenderer.invoke('dialog:open-pdfs'),
  openDocuments: () => ipcRenderer.invoke('dialog:open-documents'),
  libreofficeStatus: () => ipcRenderer.invoke('libreoffice:status'),
  libreofficeConvert: (options) => ipcRenderer.invoke('libreoffice:convert', options),
  officeToPdf: (options) => ipcRenderer.invoke('office:to-pdf', options),

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