// 工具声明：视频播放器
// 目标与范围见 spec/modules/player.md
import { mount, unmount, activate, deactivate } from './ui.js';

export default {
  id: 'player',
  name: '视频播放器',
  icon: '▶️',
  group: 'video', // 左侧分组：视频（紧接「视频下载」——下载完直接在下一个工具里看）
  order: 55,
  styles: ['../tools/player/styles.css'],
  mount,
  unmount,
  activate,
  deactivate
};