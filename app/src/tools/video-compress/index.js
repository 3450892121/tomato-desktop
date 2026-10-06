// 工具声明：视频压缩
// 目标与范围见 spec/modules/video-compress.md
import { mount, unmount } from './ui.js';

export default {
  id: 'video-compress',
  name: '视频压缩',
  icon: '🗜️',
  group: 'video', // 左侧分组：视频
  order: 62,
  styles: ['../tools/video-compress/styles.css'],
  mount,
  unmount
};
