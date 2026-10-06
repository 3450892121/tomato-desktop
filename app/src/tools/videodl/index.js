// 工具声明：视频下载（粘贴链接下载网络视频；见 spec/modules/videodl.md）
// 这是本软件唯一需要联网的工具：其余工具保持离线可用，不受影响。
import { mount, unmount, activate, deactivate } from './ui.js';

export default {
  id: 'videodl',
  name: '视频下载',
  icon: '⬇️',
  group: 'video', // 左侧分组：视频（下载是本组流程入口，排最前）
  order: 54,
  styles: ['../tools/videodl/styles.css'],
  mount,
  unmount,
  activate,
  deactivate
};
