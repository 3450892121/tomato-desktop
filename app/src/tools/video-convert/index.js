// 工具声明：视频格式转换
// 目标与范围见 spec/modules/video-convert.md
import { mount, unmount } from './ui.js';

export default {
  id: 'video-convert',
  name: '视频格式转换',
  icon: '🎬',
  group: 'video', // 左侧分组：视频
  order: 60,
  styles: ['../tools/video-convert/styles.css'],
  mount,
  unmount
};