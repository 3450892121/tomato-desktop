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
  // 批量重命名（「批量重命名」工具用；两阶段改名，绝不覆盖已存在文件）
  renameBatch: (renames) => ipcRenderer.invoke('fs:rename-batch', renames),

  // 新工具（图片格式转换 / 视频格式转换 / 动图与视频互转）：专用对话框
  openImageAny: () => ipcRenderer.invoke('dialog:open-image-any'),
  openVideos: () => ipcRenderer.invoke('dialog:open-videos'),
  openMedia: () => ipcRenderer.invoke('dialog:open-media'),
  openAudios: () => ipcRenderer.invoke('dialog:open-audios'),
  // 新工具专用对话框（避免测试夹具互相污染，与 openAudios/openSpeech 同理）
  openVideosCompress: () => ipcRenderer.invoke('dialog:open-videos-compress'),
  openAudiosEdit: () => ipcRenderer.invoke('dialog:open-audios-edit'),
  openSpeech: () => ipcRenderer.invoke('dialog:open-speech'),
  // B 批图片工具专用对话框（各工具独立夹具前缀，避免测试互相污染）
  openBatchRename: () => ipcRenderer.invoke('dialog:open-batch-rename'),
  openWatermark: () => ipcRenderer.invoke('dialog:open-watermark'),
  openWatermarkStamp: () => ipcRenderer.invoke('dialog:open-watermark-stamp'),
  openStitch: () => ipcRenderer.invoke('dialog:open-stitch'),
  openGridSlice: () => ipcRenderer.invoke('dialog:open-grid-slice'),
  // C 批：PDF 编辑整理 / 文字识别 专用对话框
  openPdfEdit: () => ipcRenderer.invoke('dialog:open-pdf-edit'),
  openOcr: () => ipcRenderer.invoke('dialog:open-ocr'),

  // OCR 加装包（「文字识别」工具）：引擎在主进程跑（无 CSP 限制、原生模块直载）
  ocrStatus: () => ipcRenderer.invoke('ocr:status'),
  ocrRecognize: (options) => ipcRenderer.invoke('ocr:recognize', options),
  ocrCancel: (jobId) => ipcRenderer.invoke('ocr:cancel', jobId),
  ocrFont: () => ipcRenderer.invoke('ocr:font'),

  // ffmpeg 加装包（视频/动图工具；见 spec/modules/video-convert.md）
  ffmpegStatus: () => ipcRenderer.invoke('ffmpeg:status'),
  ffmpegProbe: (filePath) => ipcRenderer.invoke('ffmpeg:probe', filePath),
  ffmpegConvert: (options) => ipcRenderer.invoke('ffmpeg:convert', options),
  // 两遍编码（「视频压缩」的目标体积模式：第一遍分析、第二遍落盘）
  ffmpegConvertTwoPass: (options) => ipcRenderer.invoke('ffmpeg:convert-two-pass', options),
  // 多输入转码（「音频剪辑」的拼接：多个 -i + concat 滤镜）
  ffmpegConvertMulti: (options) => ipcRenderer.invoke('ffmpeg:convert-multi', options),
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

  // FunASR 语音识别加装包（「语音转文字」；见 spec/modules/transcribe.md）
  asrStatus: () => ipcRenderer.invoke('asr:status'),
  asrTranscribe: (options) => ipcRenderer.invoke('asr:transcribe', options),
  asrSave: (options) => ipcRenderer.invoke('asr:save', options),
  asrCancel: (jobId) => ipcRenderer.invoke('asr:cancel', jobId),
  asrOnProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('asr:progress', handler);
    return () => ipcRenderer.removeListener('asr:progress', handler);
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
  // 设置的导出 / 导入（换机器一键带走；见 spec/modules/settings-io.md）
  settingsExport: () => ipcRenderer.invoke('settings:export'),
  settingsImport: () => ipcRenderer.invoke('settings:import'),

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