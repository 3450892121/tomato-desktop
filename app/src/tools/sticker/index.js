// 工具声明：动图与视频互转
// 目标与范围见 spec/modules/sticker-video.md
import { mount, unmount } from './ui.js';

export default {
  id: 'sticker',
  name: '动图与视频互转',
  icon: '🎞️',
  group: 'video', // 左侧分组：视频
  order: 65,
  styles: ['../tools/sticker/styles.css'],
  mount,
  unmount
};