// B站辅助（移植自 leetools/video-downloader scripts/bilibili-download.js，
// MIT 许可，见同目录 UPSTREAM-LICENSE.txt；改动：插件目录改为入参，不假设上游目录结构）。
import path from 'node:path';

export function isBilibiliUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv';
  } catch { return false; }
}

export function attemptArgs(pluginDir, proxy, attempt) {
  return [
    '--add-header', 'Referer:https://www.bilibili.com/',
    '--no-plugin-dirs', '--plugin-dirs', pluginDir,
    '--check-formats', '--socket-timeout', '12', '--retries', '1', '--extractor-retries', '1',
    // 显式空代理同时覆盖继承来的 HTTP(S)_PROXY（重试时切换直连）。
    '--proxy', attempt > 1 ? '' : proxy,
  ];
}

export function isConnectionFailure(message) {
  return /timed out|timeout|handshake|TLS|SSL|EOF|ConnectionReset|10054|reset by peer|Unable to download (?:webpage|JSON|video data)|HTTP Error (?:403|412|429|5\d\d)/i.test(message);
}

export function describeFailure(message) {
  if (!isConnectionFailure(message)) return '';
  if (/bilivideo\.(?:com|cn|net)|Unable to download video data/i.test(message)) {
    return 'B站视频下载节点连接失败，已尝试备用地址。请稍后重试，或检查当前网络及代理规则。';
  }
  return '连接B站接口失败，已重试连接。请确认当前网络能正常打开该视频后再试。';
}

/** 工具自带的 B站插件目录（进 git，随包分发；yt-dlp 以 --plugin-dirs 挂载） */
export function pluginDirFor(toolRoot) {
  return path.join(toolRoot, 'plugins');
}
