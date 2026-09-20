// 工具声明：视频播放器
// 目标与范围见 spec/modules/player.md
import { mount, unmount, activate, deactivate } from './ui.js';

export default {
  id: 'player',
  name: '视频播放器',
  icon: '▶️',
  group: 'video', // 左侧分组：视频（本工具排在最前，播完转完的视频不用换软件）
  order: 55,
  styles: ['../tools/player/styles.css'],
  mount,
  unmount,
  activate,
  deactivate
};