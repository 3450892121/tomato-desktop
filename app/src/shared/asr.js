// 语音识别共用能力（跨工具复用，放 shared/）
// 使用方：「语音转文字」（src/tools/transcribe）。
// 说明：真正的进程调用与文件写盘在主进程（main.js 的 asr:* IPC）；本文件负责界面侧统一封装。
// 目标与规则见 spec/modules/transcribe.md。

/** 加装包状态：{found, ffmpeg}（ffmpeg 用于识别前的音频预处理） */
export function asrStatus() {
  return window.desktop.asrStatus();
}

/**
 * 识别单个文件（音频或视频；视频自动提取音轨）。
 * options: { inputPath, jobId? }
 * 返回：{ok, srtText} 或 {ok:false, message}
 */
export function transcribeFile(options) {
  return window.desktop.asrTranscribe(options);
}

/**
 * 保存识别产物到磁盘（重名自动加序号，绝不覆盖已有文件）。
 * options: { targetDir, baseName, files: [{ext, text}] }
 * 返回：{ok, paths:[...]} 或 {ok:false, message}
 */
export function saveTranscribeOutputs(options) {
  return window.desktop.asrSave(options);
}

/** 取消某个正在跑的任务（jobId 用 transcribeFile 里传入的同一个） */
export function cancelTranscribe(jobId) {
  return window.desktop.asrCancel(jobId);
}

/** 订阅进度（返回取消订阅函数，工具 unmount 时务必调用） */
export function onTranscribeProgress(callback) {
  return window.desktop.asrOnProgress(callback);
}